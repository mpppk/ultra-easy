import { Result } from "@praha/byethrow";

import type { DelegationScope, OrganizationId } from "@app/approval-core";
import type { Condition } from "@app/expression-core";
import { allNodes } from "@app/workflow-core";
import type {
  ActionEffectRequest,
  CapabilityGrant,
  ProgramCapabilityManifest,
  WorkflowDefinition,
  WorkflowNode,
} from "@app/workflow-core";

import type { ActionEffectScopePolicy } from "../composite/child-actions.ts";
import { capabilityGrantScopePolicy } from "../composite/child-actions.ts";
import { EffectHandlerError } from "../ports.ts";
import type { EffectContext } from "../ports.ts";
import type { ProgramRepository } from "../program.ts";

/**
 * 組織（user / admin）がProgram / LLM Nodeへgrantしてよいcapabilityの上限（#161）。
 * 実効grant = Programのrequested manifest ∩ Node grant ∩ この policy。
 */
export type CapabilityPolicy = {
  actions: { actionType: string; resourceType?: string; restriction?: Condition }[];
  llm?: {
    models: string[];
    maxCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxCostMicroUsd: number;
  };
  maxEffects: number;
};

export const DENY_ALL_CAPABILITIES: CapabilityPolicy = { actions: [], maxEffects: 0 };

export interface CapabilityPolicyProvider {
  policy(organizationId: OrganizationId): Result.ResultAsync<CapabilityPolicy, EffectHandlerError>;
}

export type CapabilityReviewIssue = { nodeId: string; code: string; message: string };

export type CapabilityReview = {
  nodeId: string;
  nodeType: "program" | "llm";
  /** 生成コード / Node宣言が要求したcapability（grantではない）。 */
  requested: ProgramCapabilityManifest;
  /** Workflow作者がNodeへ付与したgrant。 */
  granted: CapabilityGrant;
  issues: CapabilityReviewIssue[];
};

function permitsAction(
  policy: CapabilityPolicy,
  action: { actionType: string; resourceType?: string },
): boolean {
  return policy.actions.some(
    (allowed) =>
      allowed.actionType === action.actionType &&
      (allowed.resourceType === undefined || allowed.resourceType === action.resourceType),
  );
}

function requestsAction(
  manifest: ProgramCapabilityManifest,
  action: { actionType: string; resourceType?: string },
): boolean {
  return (manifest.actions ?? []).some(
    (requested) =>
      requested.actionType === action.actionType &&
      (requested.resourceType === undefined || requested.resourceType === action.resourceType),
  );
}

/**
 * Capability Broker。
 *
 * - publish時: Program / LLM Nodeのgrantが「要求されたcapability」と「組織policy」の両方に収まるかを検証する。
 *   生成コードは要求（manifest）できるだけで、grantはWorkflow作者 / 管理者が行い、policyを超えられない
 * - runtime: 作用ごとにNode grantと **現在の** 組織policyを照合する（policy縮小後の実行も拒否, fail-closed）
 */
export class CapabilityBroker {
  constructor(
    private readonly deps: {
      policies: CapabilityPolicyProvider;
      programs?: ProgramRepository;
    },
  ) {}

  private async requestedFor(
    organizationId: OrganizationId,
    node: WorkflowNode,
  ): Result.ResultAsync<ProgramCapabilityManifest | null, EffectHandlerError> {
    if (node.type === "llm") {
      // LLM Nodeは自身の宣言（grant）そのものを要求とみなす（生成コードを含まない）。
      const grant = node.capabilities ?? {};
      return Result.succeed({
        actions: (grant.actions ?? []).map((action) => ({
          actionType: String(action.actionType),
          ...(action.resourceType !== undefined ? { resourceType: action.resourceType } : {}),
        })),
        ...(grant.llm ? { llm: grant.llm } : {}),
        ...(grant.maxEffects !== undefined ? { maxEffects: grant.maxEffects } : {}),
      });
    }
    if (node.type !== "program" || !this.deps.programs) return Result.succeed(null);
    const version = await this.deps.programs.load({
      organizationId,
      programId: String(node.program.programId),
      version: node.program.version,
    });
    if (Result.isFailure(version)) {
      return Result.fail(
        new EffectHandlerError(version.error.code, version.error.retriable, version.error.message),
      );
    }
    return Result.succeed(version.value?.requestedCapabilities ?? null);
  }

  /** Workflow Definitionの全Program / LLM Nodeのgrantをreviewする（Studioの"requested capability review"）。 */
  async review(input: {
    organizationId: OrganizationId;
    definition: WorkflowDefinition;
  }): Result.ResultAsync<CapabilityReview[], EffectHandlerError> {
    const policy = await this.deps.policies.policy(input.organizationId);
    if (Result.isFailure(policy)) return policy;
    const reviews: CapabilityReview[] = [];
    for (const { node } of allNodes(input.definition.graph)) {
      if (node.type !== "program" && node.type !== "llm") continue;
      const requested = await this.requestedFor(input.organizationId, node);
      if (Result.isFailure(requested)) return requested;
      const granted = node.capabilities ?? {};
      const issues: CapabilityReviewIssue[] = [];
      const add = (code: string, message: string) =>
        issues.push({ nodeId: String(node.id), code, message });
      if (!requested.value) add("program_not_found", "Program versionが見つかりません");
      const manifest = requested.value ?? {};
      for (const action of granted.actions ?? []) {
        const key = {
          actionType: String(action.actionType),
          ...(action.resourceType !== undefined ? { resourceType: action.resourceType } : {}),
        };
        if (!requestsAction(manifest, key)) {
          add("grant_not_requested", `${key.actionType}はProgramが要求していないcapabilityです`);
        }
        if (!permitsAction(policy.value, key)) {
          add(
            "grant_not_permitted",
            `${key.actionType}は組織のcapability policyで許可されていません`,
          );
        }
      }
      if (granted.llm) {
        const allowedModels = new Set(policy.value.llm?.models ?? []);
        const requestedModels = new Set(manifest.llm?.models ?? []);
        for (const model of granted.llm.models) {
          if (!allowedModels.has(model))
            add("llm_model_not_permitted", `model ${model}は許可されていません`);
          if (!requestedModels.has(model))
            add("grant_not_requested", `model ${model}は要求されていません`);
        }
        const limits = [
          "maxCalls",
          "maxInputTokens",
          "maxOutputTokens",
          "maxCostMicroUsd",
        ] as const;
        for (const limit of limits) {
          if (!policy.value.llm || granted.llm[limit] > policy.value.llm[limit]) {
            add("llm_budget_exceeds_policy", `${limit}が組織policyの上限を超えています`);
          }
          if (!manifest.llm || granted.llm[limit] > manifest.llm[limit]) {
            add("llm_budget_exceeds_request", `${limit}が要求を超えています`);
          }
        }
      }
      if ((granted.maxEffects ?? 0) > policy.value.maxEffects) {
        add("max_effects_exceeds_policy", "maxEffectsが組織policyの上限を超えています");
      }
      reviews.push({
        nodeId: String(node.id),
        nodeType: node.type,
        requested: manifest,
        granted,
        issues,
      });
    }
    return Result.succeed(reviews);
  }

  /** runtimeで、Action作用がNode grantと現在の組織policyの範囲かを判定する。 */
  async authorizeAction(input: {
    organizationId: OrganizationId;
    node: WorkflowNode;
    request: ActionEffectRequest;
  }): Result.ResultAsync<void, EffectHandlerError> {
    if (input.node.type === "action") return Result.succeed(undefined);
    const policy = await this.deps.policies.policy(input.organizationId);
    if (Result.isFailure(policy)) return policy;
    const key = {
      actionType: String(input.request.actionType),
      resourceType: input.request.resource.type,
    };
    if (!permitsAction(policy.value, key)) {
      return Result.fail(
        new EffectHandlerError(
          "capability_denied",
          false,
          `${key.actionType}は組織のcapability policyで許可されていません`,
        ),
      );
    }
    return Result.succeed(undefined);
  }

  /** runtimeで、LLM作用のmodelがNode grantと現在の組織policyの範囲かを判定する。 */
  async authorizeLlm(input: {
    organizationId: OrganizationId;
    grant: CapabilityGrant | undefined;
    model: string;
  }): Result.ResultAsync<NonNullable<CapabilityGrant["llm"]>, EffectHandlerError> {
    const policy = await this.deps.policies.policy(input.organizationId);
    if (Result.isFailure(policy)) return policy;
    const grant = input.grant?.llm;
    if (
      !grant ||
      !grant.models.includes(input.model) ||
      !(policy.value.llm?.models ?? []).includes(input.model)
    ) {
      return Result.fail(
        new EffectHandlerError(
          "capability_denied",
          false,
          `LLM model ${input.model}はgrantされていません`,
        ),
      );
    }
    const limits = policy.value.llm;
    return Result.succeed({
      models: [input.model],
      maxCalls: Math.min(grant.maxCalls, limits?.maxCalls ?? 0),
      maxInputTokens: Math.min(grant.maxInputTokens, limits?.maxInputTokens ?? 0),
      maxOutputTokens: Math.min(grant.maxOutputTokens, limits?.maxOutputTokens ?? 0),
      maxCostMicroUsd: Math.min(grant.maxCostMicroUsd, limits?.maxCostMicroUsd ?? 0),
    });
  }

  /** Node grant（scope policy）に加えて、組織policyも照合するscope policy。 */
  scopePolicy(base: ActionEffectScopePolicy = capabilityGrantScopePolicy): ActionEffectScopePolicy {
    return {
      scopeFor: async (context: EffectContext, request: ActionEffectRequest) => {
        const scope = await base.scopeFor(context, request);
        if (Result.isFailure(scope)) return scope;
        const allowed = await this.authorizeAction({
          organizationId: context.run.state.organizationId,
          node: context.node,
          request,
        });
        if (Result.isFailure(allowed)) return allowed;
        const policyRestriction = await this.policyRestriction(context, request);
        if (Result.isFailure(policyRestriction)) return policyRestriction;
        return Result.succeed(mergeCondition(scope.value, policyRestriction.value));
      },
    };
  }

  private async policyRestriction(
    context: EffectContext,
    request: ActionEffectRequest,
  ): Result.ResultAsync<Condition | undefined, EffectHandlerError> {
    if (context.node.type === "action") return Result.succeed(undefined);
    const policy = await this.deps.policies.policy(context.run.state.organizationId);
    if (Result.isFailure(policy)) return policy;
    return Result.succeed(
      policy.value.actions.find(
        (allowed) =>
          allowed.actionType === String(request.actionType) &&
          (allowed.resourceType === undefined || allowed.resourceType === request.resource.type),
      )?.restriction,
    );
  }
}

function mergeCondition(scope: DelegationScope, extra: Condition | undefined): DelegationScope {
  if (!extra) return scope;
  return {
    ...scope,
    condition: scope.condition ? { type: "and", conditions: [scope.condition, extra] } : extra,
  };
}

/** 固定のcapability policy（設定値から供給する）。 */
export function staticCapabilityPolicy(policy: CapabilityPolicy): CapabilityPolicyProvider {
  return { policy: async () => Result.succeed(policy) };
}
