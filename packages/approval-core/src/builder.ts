import type {
  ApprovalPolicyKey,
  ApprovalRuleKey,
  ApprovalStepKey,
  AuthorizationObjectType,
  RelationName,
} from "./domain/brand.ts";
import type {
  AlwaysCondition,
  ComparisonOperator,
  Condition,
  ValueExpression,
} from "./domain/condition.ts";
import type {
  ApprovalStepDefinition,
  ApproverExpression,
  CandidateCompletion,
  FlowConstraints,
  FlowDefinition,
  ObjectExpression,
  PrincipalExpression,
  SelfApproval,
  UnresolvedApproverBehavior,
} from "./domain/flow.ts";
import type { JsonValue } from "./domain/json.ts";
import type { ApprovalPolicyDefinition, ApprovalRuleDefinition } from "./domain/policy.ts";

function asBrand<T extends string>(value: string): T {
  return value as T;
}

export function literal(value: JsonValue): ValueExpression {
  return { type: "literal", value };
}

export function field(path: string): ValueExpression {
  return { type: "field", path };
}

function comparison(
  operator: ComparisonOperator,
  left: ValueExpression,
  right: ValueExpression,
): Condition {
  return { type: "comparison", left, operator, right };
}

export const eq = (left: ValueExpression, right: ValueExpression): Condition =>
  comparison("eq", left, right);
export const ne = (left: ValueExpression, right: ValueExpression): Condition =>
  comparison("ne", left, right);
export const gt = (left: ValueExpression, right: ValueExpression): Condition =>
  comparison("gt", left, right);
export const gte = (left: ValueExpression, right: ValueExpression): Condition =>
  comparison("gte", left, right);
export const lt = (left: ValueExpression, right: ValueExpression): Condition =>
  comparison("lt", left, right);
export const lte = (left: ValueExpression, right: ValueExpression): Condition =>
  comparison("lte", left, right);

export function and(...conditions: Condition[]): Condition {
  return { type: "and", conditions };
}

export function or(...conditions: Condition[]): Condition {
  return { type: "or", conditions };
}

export function not(condition: Condition): Condition {
  return { type: "not", condition };
}

export function isIn(value: ValueExpression, ...candidates: ValueExpression[]): Condition {
  return { type: "in", value, candidates };
}

export function contains(collection: ValueExpression, value: ValueExpression): Condition {
  return { type: "contains", collection, value };
}

export function always(): AlwaysCondition {
  return { type: "always" };
}

export function actor(): PrincipalExpression {
  return { type: "actor" };
}

export function caller(): PrincipalExpression {
  return { type: "caller" };
}

export function authorityPrincipal(): PrincipalExpression {
  return { type: "authority_principal" };
}

export function delegator(depth?: number | "root"): PrincipalExpression {
  return depth === undefined ? { type: "delegator" } : { type: "delegator", depth };
}

export function principal(principalExpression: PrincipalExpression): ApproverExpression {
  return { type: "principal", principal: principalExpression };
}

export function object(objectType: string, id: ValueExpression): ObjectExpression {
  return {
    type: "reference",
    objectType: asBrand<AuthorizationObjectType>(objectType),
    id,
  };
}

export function relation(input: {
  object: ObjectExpression;
  relation: string;
}): ApproverExpression {
  return {
    type: "relation",
    object: input.object,
    relation: asBrand<RelationName>(input.relation),
  };
}

export function principalRelation(
  principalExpression: PrincipalExpression,
  relationName: string,
): ApproverExpression {
  return {
    type: "principal_relation",
    principal: principalExpression,
    relation: asBrand<RelationName>(relationName),
  };
}

export function managerOf(principalExpression: PrincipalExpression): ApproverExpression {
  return principalRelation(principalExpression, "manager");
}

export function user(userId: ValueExpression): ApproverExpression {
  return { type: "user", userId };
}

export function none(): FlowDefinition {
  return { type: "none" };
}

export function approve(input: {
  key: string;
  approver: ApproverExpression;
  name?: string;
  purpose?: ApprovalStepDefinition["purpose"];
  resolution?: ApprovalStepDefinition["resolution"];
  candidateCompletion?: CandidateCompletion;
  onUnresolved?: UnresolvedApproverBehavior;
  expiresAfter?: { seconds: number };
  requireCommentOn?: ("approve" | "reject")[];
  selfApproval?: SelfApproval;
}): ApprovalStepDefinition {
  return {
    type: "approval",
    key: asBrand<ApprovalStepKey>(input.key),
    approver: input.approver,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
    ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
    ...(input.candidateCompletion !== undefined
      ? { candidateCompletion: input.candidateCompletion }
      : {}),
    ...(input.onUnresolved !== undefined ? { onUnresolved: input.onUnresolved } : {}),
    ...(input.expiresAfter !== undefined ? { expiresAfter: input.expiresAfter } : {}),
    ...(input.requireCommentOn !== undefined ? { requireCommentOn: input.requireCommentOn } : {}),
    ...(input.selfApproval !== undefined ? { selfApproval: input.selfApproval } : {}),
  };
}

export function serial(first: FlowDefinition, ...rest: FlowDefinition[]): FlowDefinition {
  return { type: "serial", children: [first, ...rest] };
}

export function serialWithConstraints(
  constraints: FlowConstraints,
  first: FlowDefinition,
  ...rest: FlowDefinition[]
): FlowDefinition {
  return { type: "serial", children: [first, ...rest], constraints };
}

export function parallelAll(first: FlowDefinition, ...rest: FlowDefinition[]): FlowDefinition {
  return { type: "parallel", strategy: "all", children: [first, ...rest] };
}

export function parallelAny(first: FlowDefinition, ...rest: FlowDefinition[]): FlowDefinition {
  return { type: "parallel", strategy: "any", children: [first, ...rest] };
}

export function parallelQuorum(
  quorum: number,
  first: FlowDefinition,
  ...rest: FlowDefinition[]
): FlowDefinition {
  return { type: "parallel", strategy: "quorum", quorum, children: [first, ...rest] };
}

export function rule(
  key: string,
  input: Omit<ApprovalRuleDefinition, "key">,
): ApprovalRuleDefinition {
  return { key: asBrand<ApprovalRuleKey>(key), ...input };
}

export function definePolicy(input: {
  key: string;
  name: string;
  description?: string;
  rules: ApprovalRuleDefinition[];
}): ApprovalPolicyDefinition {
  return {
    schemaVersion: 1,
    key: asBrand<ApprovalPolicyKey>(input.key),
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    rules: [...input.rules],
  };
}
