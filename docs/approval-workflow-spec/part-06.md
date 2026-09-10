# **7\. Condition / Expression仕様**

## **7.1 ValueExpression**

type ValueExpression \=  
  | { type: "literal"; value: JsonValue }  
  | { type: "field"; path: string };

将来 \`action.input.amount \>= organization.settings.largeExpenseThreshold\` のようなfield-to-field比較を可能にするため、comparisonの左右はValueExpressionとする。

## **7.2 Condition**

type Condition \=  
  | { type: "comparison"; left: ValueExpression; operator: ComparisonOperator; right: ValueExpression }  
  | { type: "and"; conditions: Condition\[\] }  
  | { type: "or"; conditions: Condition\[\] }  
  | { type: "not"; condition: Condition }  
  | { type: "in"; value: ValueExpression; candidates: ValueExpression\[\] }  
  | { type: "contains"; collection: ValueExpression; value: ValueExpression };

type ComparisonOperator \=  
  | "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

type ConditionEvaluationResult \=  
  | { type: "matched" }  
  | { type: "not\_matched" }  
  | { type: "error"; code: string; path?: string; message: string };

Condition評価はfail closedとする。missing field、順序比較の型不一致、未許可field path、invalid number/date等は\`not\_matched\`へ潰さず\`error\`とし、そのActionRequestのPolicy評価を停止して実行しない。\`eq/ne\`のみnull比較を許可し、\`gt/gte/lt/lte\`は同一の比較可能型に限定する。Policyから参照できるfield rootは\`action.input\`、\`actor\`、\`authority\`、\`origin\`、\`organization.settings\`、\`attributes\`、\`now\`のallowlistとし、それ以外はpublish時のsemantic validation errorとする。配列集約・合計等はv1のCondition ASTへ入れず、Action Definition側でderived attributeとして\`attributes\`へ供給する。金額はv1では最小通貨単位の\`Number.isSafeInteger\`で表現し、currencyを別fieldとして保持する。異なるcurrencyを金額だけで比較するPolicyを禁止する。

## **7.3 Evaluation Context**

type PrincipalRef \= {  
  type: "user" | "agent" | "service";  
  id: string;  
};

type DelegationHop \= {  
  delegator: PrincipalRef;  
  delegatee: PrincipalRef;  
  grantId: string;  
};

type ActionRequest \= {  
  actor: PrincipalRef;  
  authority: {  
    principal: PrincipalRef;  
    delegation?: {  
      chain: DelegationHop\[\];  
    };  
  };  
  action: {  
    type: string;  
    resource: { type: string; id: string };  
    input: Record\<string, unknown\>;  
  };  
  origin: {  
    type: "ui" | "api" | "mcp" | "system";  
    clientId?: string;  
    caller?: PrincipalRef;  
    agentRunId?: string;  
  };  
};

type PolicyEvaluationContext \= ActionRequest & {  
  organization: { id: string; settings?: Record\<string, JsonValue\> };  
  attributes?: Record\<string, JsonValue\>;  
  now: string;  
};

type EvaluationSnapshot \= {  
  actor: PrincipalRef;  
  authority: ActionRequest\["authority"\];  
  origin: ActionRequest\["origin"\];  
  organization: PolicyEvaluationContext\["organization"\];  
  attributes?: Record\<string, JsonValue\>;  
  evaluatedAt: string;  
};

Policy評価はpure functionを維持する。DSL内からDB問い合わせ、HTTP呼び出し、任意JavaScript callbackを実行してはならない。必要なデータは評価前にContextへ解決して渡す。\`organization.settings\`、derived attributes、actor/authority/delegation/origin等、Policy評価に使う非Action情報はMaterialization開始時にEvaluationSnapshotとして固定し、以後のPolicy評価・監査再現ではsnapshotを参照する。
