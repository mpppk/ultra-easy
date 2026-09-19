import { Result } from "@praha/byethrow";

import type { Action, FlowDefinition, OrganizationId } from "@app/approval-core";

import {
  ActionRequestApplicationError,
  type ActionRequestApplicationService,
  type TrustedActionRequestContext,
} from "./action-request-service.ts";
import {
  actionRequestApplicationErrorResponse,
  actionRequestJson,
  actionRequestProblem,
  type HttpTrustedContextProvider,
  parseActionRequestCreateBody,
} from "./http.ts";

export type AuthorizationSimulation = {
  outcome: "allow" | "deny" | "error";
  code?: string;
  reason?: string;
};

export type ApplicablePolicySimulation = {
  bindingId: string;
  policyKey: string;
  policyVersion: number;
  matchedRuleKey?: string | null;
  outcome: "none" | "flow";
};

export type ApprovalPlanSimulation = {
  required: boolean;
  stepCount: number;
  approvalPlanChecksum: string;
  flow: FlowDefinition;
};

export type ActionSimulationResult = {
  authorization: AuthorizationSimulation;
  applicablePolicies: ApplicablePolicySimulation[];
  approvalPlan: ApprovalPlanSimulation | null;
};

function countApprovalSteps(flow: FlowDefinition): number {
  if (flow.type === "none") return 0;
  if (flow.type === "approval") return 1;
  return flow.children.reduce((total, child) => total + countApprovalSteps(child), 0);
}

export class ActionRequestSimulationService {
  constructor(private readonly service: ActionRequestApplicationService) {}

  async simulate(input: {
    action: Action;
    trustedContext: TrustedActionRequestContext;
  }): Result.ResultAsync<ActionSimulationResult, ActionRequestApplicationError> {
    const evaluated = await this.service.evaluate(input);
    if (Result.isFailure(evaluated)) {
      if (evaluated.error.code === "authorization_provider_failed") {
        return Result.succeed({
          authorization: {
            outcome: "error",
            code: evaluated.error.code,
            reason: evaluated.error.message,
          },
          applicablePolicies: [],
          approvalPlan: null,
        });
      }
      return Result.fail(evaluated.error);
    }

    if (evaluated.value.type === "authorization_denied") {
      return Result.succeed({
        authorization: {
          outcome: "deny",
          code: evaluated.value.code,
          reason: evaluated.value.reason,
        },
        applicablePolicies: [],
        approvalPlan: null,
      });
    }

    const versions = new Map(
      evaluated.value.bindings.map((source) => [String(source.binding.id), source.policyVersion]),
    );
    const applicablePolicies = evaluated.value.policyEvaluation.policyEvaluations.map(
      ({ binding, evaluation }): ApplicablePolicySimulation => ({
        bindingId: String(binding.id),
        policyKey: String(binding.policyKey),
        policyVersion: versions.get(String(binding.id)) ?? 1,
        ...(evaluation.type === "matched"
          ? { matchedRuleKey: String(evaluation.ruleKey) }
          : { matchedRuleKey: null }),
        outcome: evaluation.type === "matched" && evaluation.flow.type !== "none" ? "flow" : "none",
      }),
    );

    const flow = evaluated.value.policyEvaluation.flow;
    return Result.succeed({
      authorization: { outcome: "allow" },
      applicablePolicies,
      approvalPlan: {
        required: flow.type !== "none",
        stepCount: countApprovalSteps(flow),
        approvalPlanChecksum: String(evaluated.value.plan.approvalPlanChecksum),
        flow,
      },
    });
  }
}

export function createActionRequestSimulationHttpApi(input: {
  simulator: ActionRequestSimulationService;
  trustedContextProvider: HttpTrustedContextProvider;
}): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const match = /^\/v1\/organizations\/([^/]+)\/action-requests\/simulate$/.exec(url.pathname);
      if (request.method !== "POST" || !match?.[1]) {
        return new Response("Not Found", { status: 404 });
      }

      const parsedJson = await request.json().catch(() => null);
      const body = parseActionRequestCreateBody(parsedJson);
      if (!body) {
        return actionRequestProblem({
          status: 400,
          code: "invalid_action_request",
          title: "ActionRequest bodyが不正です",
        });
      }

      const organizationId = decodeURIComponent(match[1]) as OrganizationId;
      const trusted = await input.trustedContextProvider.resolve({
        request,
        organizationId,
        ...(body.delegationGrantId ? { delegationGrantId: body.delegationGrantId } : {}),
        ...(body.clientReference ? { clientReference: body.clientReference } : {}),
      });
      if (Result.isFailure(trusted)) {
        return actionRequestProblem({
          status: trusted.error.status,
          code: trusted.error.code,
          title: trusted.error.status === 401 ? "Authentication required" : "Forbidden",
          detail: trusted.error.message,
        });
      }

      const simulated = await input.simulator.simulate({
        action: body.action,
        trustedContext: trusted.value,
      });
      if (Result.isFailure(simulated)) {
        return actionRequestApplicationErrorResponse(simulated.error);
      }
      return actionRequestJson(simulated.value, { status: 200 });
    },
  };
}
