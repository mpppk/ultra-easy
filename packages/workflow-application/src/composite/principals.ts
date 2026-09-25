import { Result } from "@praha/byethrow";

import { parseBrand } from "@app/approval-core";
import type {
  ActionAuthority,
  ActionType,
  AgentPrincipalRef,
  DelegationGrantId,
  DelegationHop,
  DelegationScope,
  PrincipalRef,
} from "@app/approval-core";
import { allNodes } from "@app/workflow-core";
import type {
  CapabilityGrant,
  NodeId,
  WorkflowDefinition,
  WorkflowDefinitionId,
  WorkflowRunId,
} from "@app/workflow-core";

import { EffectHandlerError } from "../ports.ts";

function agent(id: string): Result.Result<AgentPrincipalRef, EffectHandlerError> {
  const parsed = parseBrand("AgentId", id);
  return Result.isFailure(parsed)
    ? Result.fail(new EffectHandlerError("agent_principal_invalid", false, parsed.error.message))
    : Result.succeed({ type: "agent", id: parsed.value });
}

function grant(id: string): Result.Result<DelegationGrantId, EffectHandlerError> {
  const parsed = parseBrand("DelegationGrantId", id);
  return Result.isFailure(parsed)
    ? Result.fail(new EffectHandlerError("delegation_grant_invalid", false, parsed.error.message))
    : parsed;
}

/** 委任chainの時間境界のうち最も厳しいもの（notBeforeは最遅、expiresAtは最早）。 */
export function delegationTimeBounds(chain: readonly DelegationHop[]): {
  notBefore?: string;
  expiresAt?: string;
} {
  const notBefore = chain
    .map((hop) => hop.scope?.notBefore)
    .filter((value): value is string => value !== undefined)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const expiresAt = chain
    .map((hop) => hop.scope?.expiresAt)
    .filter((value): value is string => value !== undefined)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  return {
    ...(notBefore !== undefined ? { notBefore } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/** Workflow Definitionごとのstableな`agent` principal（runを跨いで同じIDで監査できる）。 */
export function workflowAgent(definitionId: WorkflowDefinitionId) {
  return agent(`workflow:${String(definitionId)}`);
}

/** Workflow内のNodeごとのstableな`agent` principal。 */
export function nodeAgent(definitionId: WorkflowDefinitionId, nodeId: NodeId) {
  return agent(`workflow:${String(definitionId)}/node:${String(nodeId)}`);
}

/** Workflow Agentへ委任できるAction type（定義内のAction Nodeとcapability grantの和集合）。 */
export function workflowActionTypes(definition: WorkflowDefinition): ActionType[] {
  const types = new Set<string>();
  const add = (grantValue: CapabilityGrant | undefined) => {
    for (const action of grantValue?.actions ?? []) types.add(String(action.actionType));
  };
  for (const { node } of allNodes(definition.graph)) {
    if (node.type === "action") types.add(String(node.actionType));
    if (node.type === "program" || node.type === "llm") add(node.capabilities);
  }
  const parsed: ActionType[] = [];
  for (const type of [...types].sort()) {
    const value = parseBrand("ActionType", type);
    if (Result.isSuccess(value)) parsed.push(value.value);
  }
  return parsed;
}

/**
 * child ActionRequestのauthority。親のauthority principalと委任chainを起点に、
 * `親actor -> Workflow Agent -> Node Agent` の2 hopを追加する（attenuation-only）。
 *
 * 各hopのscopeは全hopでANDされるため（validateEffectiveAuthority）、chainを延長しても
 * 親が持たない権限は得られない。
 */
export function childAuthority(input: {
  parentActor: PrincipalRef;
  parentAuthority: ActionAuthority;
  definition: WorkflowDefinition;
  runId: WorkflowRunId;
  nodeId: NodeId;
  nodeScope: DelegationScope;
  timeBounds?: { notBefore?: string; expiresAt?: string };
}): Result.Result<
  { actor: AgentPrincipalRef; authority: ActionAuthority; workflowAgent: AgentPrincipalRef },
  EffectHandlerError
> {
  const workflow = workflowAgent(input.definition.id);
  if (Result.isFailure(workflow)) return workflow;
  const node = nodeAgent(input.definition.id, input.nodeId);
  if (Result.isFailure(node)) return node;
  const workflowGrant = grant(`wfgrant:${String(input.runId)}`);
  if (Result.isFailure(workflowGrant)) return workflowGrant;
  const nodeGrant = grant(`wfgrant:${String(input.runId)}/${String(input.nodeId)}`);
  if (Result.isFailure(nodeGrant)) return nodeGrant;

  const hops: DelegationHop[] = [
    ...(input.parentAuthority.delegation?.chain ?? []),
    {
      delegator: input.parentActor,
      delegatee: workflow.value,
      grantId: workflowGrant.value,
      scope: {
        actionTypes: workflowActionTypes(input.definition),
        ...(input.timeBounds?.notBefore ? { notBefore: input.timeBounds.notBefore } : {}),
        ...(input.timeBounds?.expiresAt ? { expiresAt: input.timeBounds.expiresAt } : {}),
      },
    },
    {
      delegator: workflow.value,
      delegatee: node.value,
      grantId: nodeGrant.value,
      scope: input.nodeScope,
    },
  ];
  return Result.succeed({
    actor: node.value,
    workflowAgent: workflow.value,
    authority: { principal: input.parentAuthority.principal, delegation: { chain: hops } },
  });
}
