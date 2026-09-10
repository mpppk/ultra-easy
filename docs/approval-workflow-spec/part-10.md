# **11. Flow MaterializationとCloudflare Workflows実行モデル — Part 2**

## **11.4 DurableRuntime境界**

type Duration \= { seconds: number };  
type WaitOptions \= {  
  eventType: string;  
  timeout: Duration;  
};

interface DurableRuntime {  
  run\<T\>(key: string, fn: () \=\> Promise\<T\>): Promise\<T\>;  
  waitForEvent\<T\>(key: string, options: WaitOptions): Promise\<T\>;  
  sleep(key: string, duration: Duration): Promise\<void\>;  
}

type ActionExecutionRequest \= {  
  actionRequestId: string;  
  actionFingerprint: string;  
  idempotencyKey: string;  
  action: ResolvedAction;  
  authorizationEvidence: AuthorizationEvidence;  
};

type ActionExecutionResult \=  
  | { status: "succeeded"; output?: JsonValue }  
  | { status: "failed"; retriable: boolean; code: string; message: string; details?: JsonValue };

interface ActionExecutor {  
  execute(request: ActionExecutionRequest): Promise\<ActionExecutionResult\>;  
}

executeFlow(flow, runtime)はFlow意味論を実装し、Cloudflare adapterがstep.do / step.waitForEvent / step.sleepへ変換する。Flow完了後はActionAuthorizerをHIGHER\_CONSISTENCY相当で再実行し、現在時点のauthority/delegation/resource authorizationを再検証したうえでActionExecutor.execute()を呼び出す。Authorizationのみで承認不要なActionRequestも同じ経路を使う。Re-AuthorizationがdenyならActionExecutorは呼ばず、terminal status=\`authorization\_revoked\`としてreason/evidenceを監査記録する。ActionExecutorはMCP tool handler、HTTP application command、外部API等の実処理をAdapterとして隠蔽する。Executorは\`idempotencyKey \= actionRequestId \+ ":" \+ actionFingerprint\`を尊重する契約とし、外部実行先がidempotencyを保証できない場合はAdapterが保証レベルを\`best\_effort\_at\_most\_once\`として明示する。基盤は外部side effectのexactly-onceを主張しない。\`retriable=false\`は即terminal failure、\`retriable=true\`はruntime retry対象とし、retry枯渇後は\`execution\_failed\`で終了する。補償トランザクションはv1非スコープとする。

Flow ASTの意味論はCloudflare非依存に保つ。approval-coreはCloudflare Workflows APIをimportせず、approval-runtime-cloudflareのみがWorkflowEntrypointやWorkflowStepを利用する。InMemoryRuntimeを用意し、InterpreterをCloudflareなしでunit test可能にする。

## **11.5 Dynamic Workflowsを採用しない理由** **ユーザーが定義するのは実行コードではなく、許可されたnodeからなるPolicy/Flow ASTである。v1ではDynamic Workflowsを使用せず、固定されたGeneric ActionWorkflowがASTをinterpretする。durable step名はMaterializedStepIdと反復index等からdeterministicに生成し、時刻・乱数等をstep名や制御分岐へ直接使用しない。tenantごとの任意JavaScript実行が要件化した場合のみDynamic Workflowsを再評価する。** **11.6 Cloudflare Runtime制約・Approval expiry・semantics versioning** **Cloudflare WorkflowsのwaitForEventはtimeout省略時24時間で、明示timeoutは1秒〜365日であるため、v1では必ず明示timeoutを指定する。Approval Stepの業務上の有効期限はCloudflareの既定値と分離して扱い、\`expiresAfter\`またはtenant既定のApproval expiryをEvaluationSnapshotへ固定する。有効期限到達時はWorkflowを無期限再waitせずterminal status=\`expired\`とする。SLA通知・escalationはv1.1でもよいが、expiry semantics自体はv1に含める。Materialized Approval Planには\`interpreterSemanticsVersion\`を必須で保持し、Flow AST schemaVersionやCloudflare deployment versionとは独立に監査する。semantics変更時は旧versionの解釈を維持し、既存instanceを別semanticsへ暗黙移行しない。Cloudflareのevent payloadとnon-stream step resultは1MiB上限があるため、Workflow paramsにはActionRequest IDとPlan checksumだけを渡し、Materialized PlanはD1からloadする。候補cohort等の大きい集合はPlan外のimmutable storageへ分離する。アプリケーション側でもMaterialized Planに十分低いsize limitを設け、超過時はmaterialization errorとする。** **12\. Authorization / ApproverResolver / Auth0 FGA連携**
