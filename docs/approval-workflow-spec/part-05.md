# **6\. PolicyモデルとJSON AST**

## **6.1 正本**

Policyの正本はJSONとして完全にシリアライズ可能なASTである。TypeScript BuilderもGUI EditorもこのASTを生成するだけであり、実行エンジンは生成元を区別しない。

type ApprovalPolicyDefinition \= {  
  schemaVersion: 1;  
  key: string;  
  name: string;  
  description?: string;  
  rules: ApprovalRuleDefinition\[\];  
};

type ApprovalRuleDefinition \= {  
  key: string;  
  when: Condition | AlwaysCondition;  
  flow: FlowDefinition;  
};

type ApprovalPolicyBinding \= {  
  id: string;  
  organizationId: string;  
  policyKey: string;  
  selector: {  
    actionTypes: string\[\];  
    resourceTypes?: string\[\];  
    when?: Condition;  
  };  
  compositionOrder?: number;  
  enabled: boolean;  
};

## **6.2 Versioning**

* Published Policy Versionはimmutableとする。  
* 編集はDraftに対して行い、publish時に新VersionをINSERTする。  
* ActionRequestは実行開始時に適用された全Policy Versionをpolicy\_bindingsとして固定し、Materialized Flow checksumとともに保持する。  
* 既存ActionWorkflowは後続Policy変更の影響を受けない。

## **6.3 Rule matching**

単一Policy内ではRuleを配列順で評価し、最初に一致した1件のみを採用する。\`always\` Ruleを使う場合、semantic validationで最後のRuleに限定する。一方、1つのActionRequestには複数の独立Policyを適用可能とする。Policy本体は再利用可能な承認ルールのみを保持し、「どのActionRequestへ適用するか」はApprovalPolicyBindingが所有する。PolicyBindingResolverはtenant内のenabledなBindingについてselector.actionTypes（完全一致または明示的prefix pattern）、resourceTypes、selector.whenをpureに評価して適用Binding群を決定する。各Bindingはpublish済みPolicy Versionへ解決され、各Policyはfirst-matchでFlowDefinition（\`none\`を含む）を1件返す。v1のApprovalPlanCompilerは\`none\`を除外し、BindingのcompositionOrder昇順（省略時1000）、同値ならbinding id辞書順で決定的に並べ、non-none Flowをserialに合成する。0件なら\`none\`、1件ならそのFlowをそのまま採用する。cross-policyのparallel化や暗黙deduplicationはv1では行わず、必要なparallel/quorumは個々のPolicy Flow内に定義する。ApprovalPlanCompilerはEvaluationSnapshotに固定されたtenantの\`defaultFlowConstraints\`を合成rootへ適用する。cross-policyで同一人物が複数Stepを完了できるかはこのroot constraintsで決定し、個々のPolicyだけでは暗黙に緩和しない。これにより同じ「AIならcaller承認」Policyを複数ActionへBindingし、production操作用Policy等と独立に合成できる。\`none\`はそのPolicyが追加承認を要求しないことを表し、Binding未適用・Policy評価不能・Authorization denyとは区別する。
