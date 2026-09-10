# **8\. Flow / Approval Step仕様**

type FlowDefinition \=  
  | NoApprovalFlowDefinition  
  | ApprovalStepDefinition  
  | SerialFlowDefinition  
  | ParallelFlowDefinition;

type NoApprovalFlowDefinition \= {  
  type: "none";  
};

type FlowConstraints \= {  
  distinctApprovers?: boolean;  
};

type SerialFlowDefinition \= {  
  type: "serial";  
  children: FlowDefinition\[\];  
  constraints?: FlowConstraints;  
};

type ParallelFlowDefinition \= {  
  type: "parallel";  
  strategy: "all" | "any" | "quorum";  
  quorum?: number;  
  children: FlowDefinition\[\];  
  constraints?: FlowConstraints;  
};

| Strategy | 完了条件 | 例 |
| :---- | :---- | :---- |
| serial | 前Stepが完了すると次をactive化 | 部長→本部長→経理 |
| parallel/all | 全child approveで完了。1 child rejectで即reject | 法務 AND 経理 |
| parallel/any | 1 child approveで完了。全child rejectでreject | A OR B |
| parallel/quorum | approve数がquorum以上で完了。到達不能時はreject | 3名中2名 |

## **8.1 Approval Step**

type ApprovalStepDefinition \= {  
  type: "approval";  
  key: string;  
  name?: string;  
  purpose?: "execution\_consent" | "business\_approval" | "security\_approval" | "compliance\_approval";  
  approver: ApproverExpression;  
  resolution?: "dynamic" | "snapshot";  
  candidateCompletion?: "any" | "all" | { type: "quorum"; count: number };  
  onUnresolved?: { type: "deny" } | { type: "fallback"; approver: ApproverExpression };  
  expiresAfter?: { seconds: number };  
  requireCommentOn?: ("approve" | "reject")\[\];  
  selfApproval?: {  
    mode: "allow" | "deny";  
    subject?: PrincipalExpression;  
  };  
};

## **8.2 ApproverExpression**

type PrincipalExpression \=  
  | { type: "actor" }  
  | { type: "caller" }  
  | { type: "authority\_principal" }  
  | { type: "delegator"; depth?: number | "root" };

type ApproverExpression \=  
  | { type: "principal"; principal: PrincipalExpression }  
  | {  
      type: "relation";  
      object: ObjectExpression;  
      relation: string;  
    }  
  | {  
      type: "principal\_relation";  
      principal: PrincipalExpression;  
      relation: string;  
    }  
  | {  
      type: "user";  
      userId: ValueExpression;  
    };

type ObjectExpression \=  
  | { type: "reference"; objectType: string; id: ValueExpression }  
  | { type: "literal"; object: string };

relation方式を組織承認の標準とし、principal方式はactor/caller/authority principal/delegator本人を承認者にする場合、principal\_relation方式はmanagerOf(caller())のように特定principalを起点としてrelationを辿る場合に利用する。user方式はaction input自体が承認者を指す例外用途に利用する。PrincipalExpressionはActionRequest受付時のidentityへbindされる。必要identityやrelation候補が解決できない場合、onUnresolved省略時はfail closedとしてdenyする。candidateCompletion省略時はanyとし、relationが複数候補を返した場合は候補集合の1名の承認でStep完了とする。anyはresolution=dynamicを許可し、各Decision受理時に現在のrelationを再Checkする。all/quorumは候補集合が途中で変化すると完了条件が不定になるため、v1ではresolution=snapshotを必須とし、Step activation時に候補cohortを固定してその集合に対して完了条件を適用する。v1のApproval Decisionを行えるprincipalは原則userに限定する。principal(caller/authority/delegator)がagent/serviceへ解決された場合は承認者未解決としてonUnresolvedを適用し、relation/principal\_relationの候補もuser集合として解決する。自動承認主体を許可する場合は将来の明示的extensionとする。purposeは実行semanticsを変えず、UI表示・監査・分析のmetadataとして利用する。自己承認禁止はAgent経由で回避されないよう、selfApproval.subject省略時はauthority\_principalを意味するPrincipalExpressionとして扱う。execution\_consentでprincipal(caller())を使うStepではselfApprovalをallowとしてよいが、業務承認では原則denyとする。ObjectExpression.literalの\`object\`はOpenFGA互換の\`\<objectType\>:\<id\>\`形式を正規表現とする。v1のonUnresolvedはdenyまたは明示fallbackのみとし、skipはv1.1以降とする。候補集合を列挙するStepにはtenant-levelの\`maxApproverCandidates\`を適用し、snapshot/all/quorumでは上限超過または完全列挙不能をmaterialization errorとする。\`expiresAfter\`省略時はEvaluationSnapshotに固定したtenant既定値を用い、Cloudflare adapterで365日以下の明示timeoutへ変換する。\`requireCommentOn\`に含まれるDecisionはcommentが空の場合受理しない。
