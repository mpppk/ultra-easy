import type {
  ApprovalStepKey,
  AuthorizationObjectRef,
  AuthorizationObjectType,
  RelationName,
} from "./brand.ts";
import type { ValueExpression } from "./condition.ts";

export type FlowConstraints = {
  distinctApprovers?: boolean;
};

export type PrincipalExpression =
  | { type: "actor" }
  | { type: "caller" }
  | { type: "authority_principal" }
  | { type: "delegator"; depth?: number | "root" };

export type ObjectExpression =
  | {
      type: "reference";
      objectType: AuthorizationObjectType;
      id: ValueExpression;
    }
  | { type: "literal"; object: AuthorizationObjectRef };

export type ApproverExpression =
  | { type: "principal"; principal: PrincipalExpression }
  | {
      type: "relation";
      object: ObjectExpression;
      relation: RelationName;
    }
  | {
      type: "principal_relation";
      principal: PrincipalExpression;
      relation: RelationName;
    }
  | { type: "user"; userId: ValueExpression };

export type ApprovalPurpose =
  | "execution_consent"
  | "business_approval"
  | "security_approval"
  | "compliance_approval";

export type CandidateCompletion = "any" | "all" | { type: "quorum"; count: number };

export type UnresolvedApproverBehavior =
  | { type: "deny" }
  | { type: "fallback"; approver: ApproverExpression };

export type SelfApproval = {
  mode: "allow" | "deny";
  subject?: PrincipalExpression;
};

export type ApprovalStepDefinition = {
  type: "approval";
  key: ApprovalStepKey;
  name?: string;
  purpose?: ApprovalPurpose;
  approver: ApproverExpression;
  resolution?: "dynamic" | "snapshot";
  candidateCompletion?: CandidateCompletion;
  onUnresolved?: UnresolvedApproverBehavior;
  expiresAfter?: { seconds: number };
  requireCommentOn?: ("approve" | "reject")[];
  selfApproval?: SelfApproval;
};

export type NoApprovalFlowDefinition = {
  type: "none";
};

export type SerialFlowDefinition = {
  type: "serial";
  children: FlowDefinition[];
  constraints?: FlowConstraints;
};

type ParallelAllOrAnyFlowDefinition = {
  type: "parallel";
  strategy: "all" | "any";
  children: FlowDefinition[];
  constraints?: FlowConstraints;
  quorum?: never;
};

type ParallelQuorumFlowDefinition = {
  type: "parallel";
  strategy: "quorum";
  quorum: number;
  children: FlowDefinition[];
  constraints?: FlowConstraints;
};

export type ParallelFlowDefinition = ParallelAllOrAnyFlowDefinition | ParallelQuorumFlowDefinition;

export type FlowDefinition =
  | NoApprovalFlowDefinition
  | ApprovalStepDefinition
  | SerialFlowDefinition
  | ParallelFlowDefinition;
