# Workflow Engine — Governed Business Workflow / Composite Action

Parent: [#154](https://github.com/mpppk/ultra-easy/issues/154) / 実装計画: [#164](https://github.com/mpppk/ultra-easy/issues/164)

ultra-easyの **Action Catalog / Authorization / Delegation / Approval / ActionExecutor** を業務フローの
実行基盤として再利用し、Workflow自体をAction Catalog上の **Composite Action** として扱う。
本書は実装済みの契約（contract）と不変条件（invariant）を記録する。

## Package layout

```text
packages/
  expression-core/   # #155 Approval / Workflow / Delegationで共有する属性式（pure）
  workflow-core/     # #156 Definition / graph validation / control-flow kernel（pure）
  workflow-application/        # #157 Durable runtime driver / ports / built-in effect handlers
  workflow-runtime-memory/     # #157 in-memory repositories（tests / local）
  workflow-d1/                 # #157 D1 persistence（workflow_* tables, migration 0021）
  workflow-runtime-cloudflare/ # #157 Cloudflare Workflows runner + cron sweeper
  workflow-platform/           # #158 composition root（ActionRequest pipeline + Workflow Runtime on D1）
  workflow-sandbox/            # #160 QuickJS（WASM）sandbox + program source validator
```

依存方向:

```text
workflow -> ultra-easy Action boundary   OK
approval -> workflow                     NG
approval -> expression-core              OK（共有言語）
```

## Expression Engine (#155)

`@app/expression-core` は `Condition` / `ValueExpression` / `ValueTemplate` と、その評価器を持つ。

- comparison（eq / ne / gt / gte / lt / lte）、and / or / not / in / contains
- 評価器はpure / deterministic。値は注入された `FieldResolver` が外部I/O解決済みの固定contextから返す。
  lint（`no-restricted-imports`）で `@praha/*` 以外への依存を禁止し、I/Oを持ち込めないようにしている。
- field欠落・型不一致・許可外path・unsafe path（`__proto__` / `prototype` / `constructor`）・
  JSON-safeでない値はすべて **error**（fail-closed）。「条件不成立」とは区別する。
- `FieldNamespacePolicy` でbounded contextごとに参照可能範囲を制限する。評価器はnamespaceを知らない。

| Context    | 参照可能namespace                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| approval   | `action.input.*` `actor.*` `authority.*` `origin.*` `organization.settings.*` `attributes.*` `now`                                               |
| workflow   | `workflow.input.*` `variables.*` `nodes.<nodeId>.output.*` `loop.item(.*)` `loop.index` `actor.*` `organization.settings.*` `attributes.*` `now` |
| delegation | `action.type` `action.resource.type` `action.resource.id` `action.input.*` `actor.*` `origin.*` `now`                                            |

Approvalは `approvalFieldResolver`（approval-core）を通じて共有評価器を使い、既存の
`Policy*Error` contractへ写像する（既存Approval semanticsは不変）。

UI（Condition Builder / field picker）は `describeFieldCatalog(policy, fields)` が返す
`FieldCatalogView`（namespace一覧 + 型付きfield）でcontextごとの参照可能fieldを列挙する。

## workflow-core (#156)

### Definition / Version

- Node: `trigger` `action` `branch` `for_each` `while` `transform` `program` `llm` `join` `output`
- Action Nodeは `actionType`（Action Catalog）だけを参照し、executor / protocol（MCP・gRPC等）を持たない。
  Composite Action（別Workflow）も同じAction Nodeで呼ぶ（Subworkflow専用Node・専用security pathは無い）。
- `publishWorkflowVersion` はvalidation後、canonical JSONのchecksumを付けたdeep-frozen snapshotを
  次のversion番号で返す。既存versionは変更しない。`verifyWorkflowVersion` で改変を検出する。

### Graph validation（実行前にfail-fast）

- root graph: Triggerちょうど1つ・Outputちょうど1つ。入口（入力edge無し）はTriggerだけ
- 任意のcycleは禁止（DAG）。繰り返しは `for_each` / `while` のbody graphで表す
- 入力edgeが2本以上の通常Nodeは禁止し、明示的な `join` を要求する（Joinは2本以上）
- dangling edge / unreachable node / branch edgeのcase key不一致 / Output後続edgeを拒否
- `while.maxIterations` 必須（1〜1000）、`for_each.concurrency`（1〜32）・`maxItems`（1〜1000）、loop nest 4段まで
- 式はworkflow namespaceで検証し、`nodes.<id>.output` は **上流で必ず実行済みのNode**
  （同一graphの祖先、または外側scopeの祖先）だけを参照できる。`loop.*` はloop bodyの中だけ

### Kernel（scheduler semantics）

`startWorkflowRun` / `advanceWorkflowRun` / `applyWorkflowRunEvent` はpureで、JSON-serializableな
`WorkflowRunState` を返す。process memoryを持たず、永続化したstateからいつでも再開できる。

- **EdgeActivation** `active | not_taken` をscope単位（`${scopeId}|${edgeId}`）で記録する。schedulerの正本。
  全入力edgeが`not_taken`のNodeは`skipped`になり、出力edgeも`not_taken`として伝播する。
- **Join (`all_active`)**: 同じscopeの全入力edgeが確定し、1本以上activeならready。
  Branch後は選択pathだけ、並列fan-out後はactiveな全pathを待つ。
- **NodeDecision**: branch選択・ForEachの解決済みitems・Whileのcontinue/exitを一度だけ記録し、resume時に再評価しない。
- **ForEach**: iterationごとに独立したscope（`root/each[0]`）。Joinはscope内のedgeだけを見るため
  別iterationのNodeRunを混ぜない。`concurrency`で同時iteration数を制限。空collectionはbody NodeRunを作らず
  `output=[]`で成功し、downstreamを1回だけactivateする。
- **While**: iteration前にconditionを評価（`loop.index` = 次のiteration番号）。`maxIterations`到達後も
  conditionが真なら`while_max_iterations_exceeded`で失敗（fail-closed）。
- **v1 fail-fast**: active path / iterationの未処理失敗はenclosing scope → loop Node → … → runを失敗させ、
  in-flightの作用をcancel（配送済みはruntimeがchildへ伝播）する。continue-on-errorは将来拡張。
- **Effect**: action / program / llm（Programのyieldによるtimer / human_input）は `EffectRecord` として予約する。
  IDは `${nodeRunId}#${attempt}` から決定的に導出し、runtimeはこのIDでchild ActionRequest等を冪等に作る。
- runaway guard: `limits.maxNodeRuns`、`limits.maxParallelEffects`（ready Nodeのthrottle）。

## Durable runtime (#157)

```text
WorkflowRuntime.advance(run)
  1. D1からrun recordを読む（revision r）          ← process memoryに依存しない
  2. cancelされたin-flight作用をchildへ伝播
  3. in-flight作用をpoll（child ActionRequestの状態等）
  4. 予約済み（requested）作用を配送（effect IDで冪等）
  5. 結果eventをkernelへ適用し、監査イベントと一緒にrevision rでCAS保存
  6. 新しく予約された作用があれば1へ
```

- **crash safety**: 作用の予約（`EffectRecord`）は配送前に保存される。保存前にcrashしても、再起動した
  runtimeは同じeffect IDで再配送し、adapterはそのIDでchild ActionRequest等を冪等に作るため重複しない。
- **CAS**: `workflow_runs.revision` によるcompare-and-set。D1では監査イベントを同じbatchで
  「このwriterの更新が確定した場合だけ」insertする（`last_writer` token）。
- **waiting**: `waiting_action | waiting_approval | waiting_input | waiting_external | waiting_timer` を
  NodeRunに記録する。timerは予約内容から満了時刻が決まり、human inputはtrusted API（`deliver`）だけが届ける。
- **wakeAt**: timer満了・retry backoff・poll間隔から次に進める時刻を保存する。
- **completion**: 終端したrunの結果は `WorkflowCompletionListener` へ一度だけ届け
  （listenerは冪等、配送済みフラグはCASで記録）、失敗時はwakeAtで再試行する。
- **bounded concurrency**: `limits.maxParallelEffects`、ForEach `concurrency`、`MAX_WORKFLOW_DEPTH`（nest）。

### Cloudflare adapter

- `createWorkflowRunner(runtime)` はrunごとのCloudflare Workflow（instance ID = `wr_<sha256(org, runId)>`）。
  各iterationは `runtime.advance` を1 stepとして実行し、`waitForEvent("workflow-resume")` か
  timeout（wakeAt / 無変化時は指数backoff, 最大1時間）で次へ進む。step上限前に `handoff` する。
- `CloudflareWorkflowRunnerControl.start / resume` はbest effort。取りこぼしは
  `sweepDueWorkflowRuns`（cron）が `workflow_runs.wake_at` から拾って直接進める（CASで競合しない）。

### D1 schema（migration `0021_workflow_runtime.sql`）

| table                  | 性質                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `workflow_definitions` | Studioのdraft（revisionで楽観ロック）                              |
| `workflow_versions`    | publish済みversion。UPDATE / DELETEをtriggerで禁止（immutable）    |
| `workflow_runs`        | run state（JSON）+ revision + wake_at。親ActionRequestごとに一意   |
| `workflow_events`      | 監査イベント（append-only trigger）。payloadはID / code / 参照だけ |

## Async Action Execution contract (#165)

Workflow専用ではない、ultra-easy本体のprotocol-agnosticな実行契約。

```ts
type ActionExecutionDispatch =
  | { type: "completed"; result: ActionExecutionResult } // 同期executor（従来のexecute）
  | { type: "accepted"; executionRef: string }; // 開始受付のみ。最終結果は未確定
```

- `ActionExecutor.dispatch?` を実装したexecutorだけがacceptedを返せる。未実装のexecutorは
  `dispatchActionExecution` が `execute` の結果を `completed` に写像する（既存semanticsは不変）。
- Service Binding: `POST /execute/:key` は同期完了を200 `{status:"succeeded"}`、受付を
  202 `{status:"accepted", executionRef}` で返す。`ServiceBindingActionExecutor.execute` はacceptedを
  成功扱いにしない（`async_execution_requires_dispatch`）。

### Lifecycle

```text
approved -> executing -> dispatch() -> accepted(executionRef)
  action.execution_started + action.execution_accepted を記録（action.completedは記録しない）
  ActionRequestは executing に留まる（ActionWorkflow instanceは executing を出力して終わり、processを保持しない）

...待機...

ActionExecutionCompletionService.complete(org, actionRequestId, actionFingerprint, executionRef, idempotencyKey, completion)
  -> action_async_executions: accepted|cancel_requested -> completed をCASで一度だけ確定
  -> action_results + action.completed（executed / execution_failed / execution_unknown）
```

- completionは受付記録の `organizationId / actionRequestId / actionFingerprint / executionRef / idempotencyKey`
  と一致する場合だけ受理する。不一致（別Action・spoof）は `completion_binding_mismatch`、
  受付の無い実行は `execution_not_accepted`。
- 同じcompletionの再送は `replayed`（action_results / eventはupsert / eventKeyで冪等）。
  確定済みと矛盾するcompletionは `completion_conflict` で拒否し、`action.execution_completion_rejected` を監査に残す。
- cancel要求（`requestCancel`）は `cancel_requested` を記録するだけで、終端はexecutorのcompletionで確定する。
  cancelとcompletionの競合は同じCASで解決し、最初の終端completionが勝つ。
- 受付を記録するrepositoryが無い構成でacceptedが返った場合は、外部で開始済みの可能性があるため
  `execution_unknown` で終端する（fail-closed）。
- 滞留検知（#109）は、trusted completion待ちのasync実行を滞留として扱わない。
- D1: migration `0022_async_action_executions.sql`。

## Composite Action (#158)

```text
employee.onboard  (ActionDefinition, executorKey = workflow)
  └─ WorkflowActionBinding (key, version) -> (workflowDefinitionId, workflowVersion, checksum)  [immutable]
       └─ WorkflowRun  --Action Node-->  child ActionRequest (primitive / composite)  --> ...
```

### Publish

`WorkflowPublishingService.publish({ definition, actionType })`:

1. `publishWorkflowVersion` → `workflow_versions`（insert-only）
2. `CompositeActionPublisher`: 新しいActionDefinition version
   （`key = workflow:<definitionId>`, `inputSchema = workflow-input:<definitionId>@<workflowVersion>`,
   `executorKey = workflow`）を採番し、**bindingをinsert-onlyで保存してから** Action Catalog
   （`published_action_definitions`）へ公開する。primitive / compositeは同じcatalog・resolverから解決される。
3. `WorkflowInputSchemaResolver` がWorkflowの `inputFields` からinput schemaを作る。

### Version pinning

- ActionRequestのMaterialized Planは `action.definition (key, version)` をsnapshotし、fingerprintにも含む。
- `WorkflowActionExecutor` は **snapshotの (key, version) にbindされたWorkflowVersion / checksumだけ** を実行し、
  checksumを再検証する。latest versionは再解決しない。
- 新しいWorkflowVersionのpublishは新しいActionDefinition versionを作る。承認待ちのActionRequestは旧version、
  新規requestは新versionを実行する。bindingはrepositoryでinsert-only、D1ではtriggerでUPDATE / DELETEを禁止する。

### Execution

- `WorkflowActionExecutor.dispatch` はActionRequest IDから決定的なrun IDでWorkflowRunを一意に作成し、
  `accepted(executionRef = runId)` を返す（#165）。runの開始は親Actionの完了ではない。
- 親の終端は `CompositeActionCompletionListener` がtrusted completion portへ届ける
  （Output Node → `ActionExecutionResult.output`、失敗 → `execution_failed` + run error code、
  cancel → `execution_failed` / `workflow_cancelled`）。acceptedの記録より先にrunが終わった場合は
  retriableとして再試行する。
- Action Nodeは `ActionRequestEffectHandler` で **必ずActionRequest boundary** を通る。
  child ActionRequest IDはrun / effectから決定的（sha256）に導出し、評価時刻は作用の予約時刻へ固定する
  （再配送でも同じPlanへ収束）。Authorization / Policy / Approval / Re-Authorizationは通常pipelineが行う。
- child ActionRequestの状態（`pending_approval → waiting_approval`, `executing → waiting_action`,
  終端失敗 → Node失敗）をpollで取り込み、v1 fail-fastで親run / 親Actionへ伝播する。
- cancel: 親runのcancelはcomposite childのasync実行へcancelを要求し、そのrunをcancelする。

### Principals / delegation

| 役割           | principal                                               |
| -------------- | ------------------------------------------------------- |
| Workflow Agent | `agent:workflow:<definitionId>`（stable）               |
| Node Agent     | `agent:workflow:<definitionId>/node:<nodeId>`（stable） |

child ActionRequest: `actor = Node Agent`、`authority.principal = run のauthority principal`、
`delegation = [..., principal -> Workflow Agent (scope: 定義内のAction types + 時間境界), Workflow Agent -> Node Agent (scope: Nodeのaction type / resource type)]`、
`origin = { type: system, caller: Workflow Agent, agentRunId: runId }`。

Composite Actionの境界では委任を **再root** する: Composite Actionへの委任（とその認可・承認）は、
publish済みWorkflowの内部Actionの実行を含む。内部のchildは改めてauthority principalに対して
認可・承認されるため、内部で権限が拡張されることはない。親chainの時間境界（notBefore / expiresAt）は
Workflow Agentへのhopへ引き継ぐ。

### Nesting / audit

- nest深さ（`MAX_WORKFLOW_DEPTH = 5`、設定可）と、祖先runと同じWorkflowの再帰呼び出し
  （`workflow_recursion_detected`）を拒否する。
- `workflow_child_actions` がchild ActionRequest ↔ run / NodeRun / effect / 親ActionRequestを相関し、
  `traceAction` が `Composite ActionRequest -> WorkflowRun -> NodeRun -> child ActionRequest -> ...` を返す。
- D1: migration `0023_workflow_composite_actions.sql`。

## Approval semantics (#159)

| 区別                       | 正本                                            | 実装                                                                          |
| -------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| workflow-level approval    | Composite Action自身のApproval Policy           | 通常のActionRequestと同じMaterialized Approval Plan                           |
| child approval enforcement | child ActionRequestのMaterialized Approval Plan | 通常のActionRequest pipeline（v1ではskipしない）                              |
| child approval projection  | 説明・計画用途（enforcementに使わない）         | `WorkflowApprovalProjector`                                                   |
| approval coverage          | v1対象外（#166）                                | `ApprovalCoverageEvaluator`（v1は常に`not_covered`、enforcementは参照しない） |

- 親Workflow（Composite Action）が承認済みでも、child ActionRequestは独自のPlanで承認を待つ。
  Re-Authorizationも常にchildごとに行う。
- `WorkflowApprovalProjector.project` はWorkflow Version + 既知のinputから、各Action Node
  （およびProgram / LLM Nodeのcapability grant）について **実行時と同じPolicy評価器**
  （`PolicyApprovalRequirementProbe` = `VersionedPolicyBindingResolver` + `evaluateApprovalPlan`）で承認要件を評価する。
  child ActionRequestと同じactor（Node Agent）/ authority / originで評価する。
  - `statically_resolved`: 常に実行され（Branch選択の全組み合わせで実行）、承認要件が確定
  - `conditional`: Branch / loop次第で実行されない・複数回実行されうるが、承認要件は確定
  - `potential`: Program / LLMがcapability grantの範囲で実行時に要求しうるAction
  - `unresolved`: `nodes.*` / `loop.*` / 実行時に変わるvariables等に依存し、静的に確定できない
    （policyが未知fieldを参照するとfail-closedなerror → unresolved。`runtimeInputFields`に理由を残す）
- Composite Actionのchildは `nested` projectionとして再帰的に投影する（深さ4まで）。
- 実際の承認（enforcement）は `traceAction` の `approval: { required, source: "materialized_plan" }` で、
  projection（`kind: "projection"`）とは型でも区別する。

## Sandboxed Program Node (#160)

### Authoring

```text
Natural language -> ProgramCodeGenerator（Coding LLM）-> generated source
  -> static validation（validateProgramSource）-> test sandbox（samples / schema / expected output）
  -> ProgramNodeVersion（immutable, sha256 source digest）
```

- `ProgramAuthoringService.draft` は生成・検証・testまでで、publishはしない（review用のdraft）。
  `publish` は再検証・再testしてから次のversionとしてinsert-onlyで保存する（`workflow_programs`、
  UPDATE / DELETEはtriggerで禁止）。runtimeでコードを再生成しない。
- `ProgramNodeVersion`: source / sourceDigest / input・output schema（`JsonSchemaLite`）/
  requested capability manifest / runtime profile（memory・timeout・output・log・stack上限）/
  generator metadata（model・指示のdigest。promptそのものは保存しない）/ version。
- Program Nodeは `(programId, version, sourceDigest)` を参照し、実行時にdigestを照合する。

### Sandbox（`@app/workflow-sandbox`）

- QuickJS（WASM）。invocationごとにruntime / contextを生成・破棄する（ephemeral）。
- network / fetch / module / process / timer / filesystem / credential / host bindingは無い
  （hostが渡すのは容量上限付きの `console.log` だけ）。静的検証でも `fetch` / `require` / `import` 等を拒否する。
- memory / stack / 実行時間（interrupt）/ output / logの上限を強制し、超過はterminateする
  （`sandbox_timeout` / `sandbox_memory_exceeded` / `sandbox_output_too_large`）。
- 実行時間はwall clockとinterrupt回数の両方で打ち切る。Workers（workerd）は実行中 `Date.now()` が進まないため、
  `timeoutMs × interruptsPerMs`（既定0.5）回のinterruptを予算とし、無限loopもCPU上限前に `sandbox_timeout` にする。
- Cloudflare Workersでは `@app/workflow-sandbox/workerd`（bundle済みwasm moduleを注入）、
  Node / testでは `@app/workflow-sandbox/node` で読み込む。

### Effect-based runtime

```ts
function main(input, context) {
  // context.resume = { state, effectResult } | null
  if (!context.resume)
    return ue.action({ step: 1 }, "payment.execute", { type: "invoice", id }, { amount });
  return ue.complete({ paid: context.resume.effectResult.output });
}
```

- Programは作用を直接実行できず、`ue.action / ue.llm / ue.sleep / ue.askHuman` で **yield** するだけ。
  Host Runtimeが作用を実行し（Actionは必ずActionRequest、LLMはLLM Gateway）、結果をdurableに保存してから
  新しいsandboxで `state + effectResult` から再開する。待機中（承認待ち等）にsandboxを保持しない。
- yieldした作用は、Programのrequested manifestと、Program Nodeの実効capability grantの **両方** に
  含まれる必要がある（`capability_denied`、fail-closed）。生成コードは能力を自己grantできない。
- input / output schemaをboundaryで検証する（`program_input_invalid` / `program_output_invalid`）。

## Agent delegation / capability / LLM / resource governance (#161)

### Attribute-based delegation scope

`DelegationScope.condition`（共有Condition）を **delegation namespace**
（`action.type` / `action.resource.*` / `action.input.*` / `actor.*` / `origin.*` / `now`）で評価する。
不一致は `delegation_scope_denied`、field欠落・型不一致・namespace外参照は `delegation_scope_invalid`（fail-closed）。
全hopのscopeはANDされるため、hopを増やしても権限は広がらない。

- Action Nodeの `restriction` はNode Agentへのhopの `condition` になる（例: `action.input.amount <= 10000`）。
- capability grant / 組織policyの `restriction` もProgram / LLMが要求したActionのhopへ付く。
- Workflow Agent / Node Agentはstableな `agent` principal（run間で同じID）として監査イベントへ残る。
- Composite ActionRequestの委任の時間境界はWorkflow Agentへのhopへ引き継ぐ（親の委任失効後はchildも拒否）。

### Capability Broker

```text
実効capability = Programのrequested manifest ∩ Node grant ∩ 組織CapabilityPolicy
```

- publish時: `CapabilityBroker.review` がProgram / LLM Nodeのgrantを検証し、要求されていない
  （`grant_not_requested`）・policyが許可しない（`grant_not_permitted` / `llm_*`）grantはpublishを拒否する
  （`capability_review_failed`）。生成コードは要求できるだけで、自己grantできない。
- runtime: 作用ごとにNode grantと **現在の** policyを照合する（policy縮小後の実行も `capability_denied`）。

### LLM Gateway

- `LlmGatewayHandler` がLLM作用を実行する。provider（Workers AI binding / API key）はhost側だけが持ち、
  sandbox・workflow stateへは渡らない。
- data minimization: secretらしい値（API key / bearer token / private key等）を `[REDACTED]` にしてから送る。
- NodeRunごとのbudget（calls / input・output tokens / cost）を `workflow_llm_usage` ledgerで強制し、
  超過は `budget_exhausted` としてdurableに記録する（promptは保存しない）。ledgerは
  `(organization, run, effect)` で冪等で、再配送時はproviderを呼び直さず記録済みの結果を返す。
- toolの要求はdata（`toolRequests`）として返すだけで、Gatewayはexecutorを持たない。
  実行は必ずAction / Program作用 → ActionRequestで行う。

### Resource Governor / Admission Controller

| 対象                  | scope           | 超過時                                                            |
| --------------------- | --------------- | ----------------------------------------------------------------- |
| 非終端WorkflowRun数   | tenant / system | Run開始を拒否（親Actionは `execution_failed` / `quota_exceeded`） |
| 同時sandbox数         | tenant / system | 枠が空くまで作用を未確定のまま待つ                                |
| run内のchild Action数 | run             | Nodeの失敗（`quota_exceeded`、durable / 監査に残る）              |

tenant上限 < system上限なので、noisy tenantがsystem capacityを占有しきれない。leaseは有効期限付き
（異常終了時のleak回収）、counterはeffect IDで冪等。D1: migration `0025_workflow_governance.sql`。

## Workflow Studio (#162)

`apps/web` の `/preview/workflows`（一覧）・`/preview/workflows/$id`（editor）・`/preview/workflow-runs/$runId`（run view）。
API はpreview runtime（`apps/approval-runtime` の `/preview/workflow/*`）をweb workerがproxyする
（`/api/preview/workflow/*`、preview harness token必須）。

- **Editor**: React Flow canvas（dagreで自動layout）。Action / Branch / Join / ForEach / While / Transform /
  Program / LLM / Output Nodeを追加し、drag接続（Branchは未使用のcase keyが割り当たる）・削除できる。
  loop bodyは入れ子のgraphとして開いて編集する。Branch / While / Action restrictionは共有Condition Builderで、
  参照できるfieldはnamespace（`workflow.input.*` / `nodes.<id>.output` / delegation namespace）から候補表示する。
- **検証 / publish**: 保存はdraft revision（CAS）。`parseWorkflowDefinition` で構造を検証した上で
  workflow-coreのvalidationを表示し、publishはimmutable versionを作る。Composite Actionとして
  `(key, version)` にbindingし、input schemaを設定できる。
- **Approval Projection**: Node上とpanelに「見込み」として表示する（確定 / 条件付き / 可能性あり / 未確定）。
  実際の承認はchild ActionRequestのMaterialized Planが決め、run viewではNodeごとの実際の承認状態を別badgeで出す。
- **Capability review**: Program / LLM Nodeの要求・grant・policyの差分とreview issueを表示する。
- **Program authoring**: 自然言語 → Coding LLM（preview: Workers AI `@cf/qwen/qwen2.5-coder-32b-instruct`）→
  静的検証 → sample test → reviewしてpublish。生成結果は自動でpublishされない。
- **Run view**: NodeRun状態（waiting理由を含む）・作用・child ActionRequestを表示し、approve / reject・
  askHuman入力・cancelをUIから行う。child ActionRequestからは承認trace（parent chain）へ辿れる。

Previewの運用上の注意:

- Workers AIの `5xxx` errorは入力 / model起因として再試行しない（`workers_ai_<code>`、fail-closed）。
  それ以外のprovider errorは再試行し、再試行は `workflow.retry` telemetryとして記録する（`onEffectRetry`）。
- runの進行はCloudflare Workflows（`WORKFLOW_RUNNER`）と cron sweeper（`sweep_workflow_runs`）の両方が駆動する。

## Security / multi-tenant / durable E2E hardening (#163)

`tests/acceptance/wf-15x〜16x` がD1（SQLite）上のplatform全体（ActionRequest pipeline + Workflow Runtime）で
#154のAcceptance Criteriaを固定する。crashは `FaultInjectingD1`（`tests/workflow/harness.ts`）で
「SQLが一致する書き込みをcommit前に失敗させる」ことで再現する。

| #154 Acceptance Criteria / #163 scenario                                                | 検証                                                                 |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| versioned Composite Action publish / invoke、binding immutable                          | `wf-158`（publish / binding）、`wf-163`（D1 triggerで改ざん不可）    |
| prepare時にversion / checksum固定、承認待ち中の新版publishで旧版実行                    | `wf-158` pins the WorkflowVersion                                    |
| async accepted と terminal completionの区別、spoof / stale / duplicate / conflict       | `wf-163` async lifecycle                                             |
| WorkflowActionExecutorからrun開始、nested workflow、runaway nesting guard               | `wf-158`                                                             |
| child Actionは必ずActionRequest、executor直接呼び出し（bypass）は拒否                   | `wf-158`、`wf-163` executor bypass                                   |
| MCP固有概念をworkflow-core / approval-core Action modelへ入れない                       | `wf-163` architecture boundary                                       |
| shared Expression Engine / namespace制限                                                | `expression-core` / `workflow-core` unit、`wf-159`（policy probe）   |
| Branch / Loop decisionのdurable保存、非選択pathのnot_taken、active pathだけ待つJoin     | `wf-163` Branch -> A \| B -> Join（承認待ちをまたいで再評価しない）  |
| empty ForEach / iteration-scoped Join / bounded ForEach・While / fail-fast              | `wf-163` ForEach / While、`workflow-core` scheduler unit             |
| crash after effect reservation / after child creation、retry / concurrent replay        | `wf-163` durability                                                  |
| Program Node immutable publish、sandbox（network / credential無し）、effect経由の能力   | `wf-160`、`wf-163` sandbox globals                                   |
| 待機中にsandboxを保持しない、生成コードの自己grant禁止、capability deny                 | `wf-160`、`wf-161`                                                   |
| agent principal + attribute-based delegation、delegation expiry / revoke                | `wf-161`（expiry）、`wf-163`（承認待ち中のrevoke）                   |
| tenant / run quota、noisy-neighbor                                                      | `wf-161`                                                             |
| Workflow-level Approval と child approvalの独立評価、parent承認でchildを省略しない      | `wf-159`                                                             |
| child approval projectionのUI表示、definition / projection / runtime stateの可視化      | `apps/web`（Workflow Studio, #162）+ preview環境で確認               |
| parent / child ActionRequest / WorkflowRun / NodeRun / Effect / Approval / Executor相関 | `wf-163` audit correlation（`platform.trace`）                       |
| cross-tenant isolation（run / program / version / composite / async completion）        | `wf-161`、`wf-163`（他tenantのcompletionは`execution_not_accepted`） |
| secret / prompt leakage（audit stream / LLM ledger）                                    | `wf-161`（ledgerはpromptを保存しない）、`wf-163`（workflow_events）  |
| M0〜M10 + MCP Gateway regression                                                        | `tests/acceptance/m*.test.ts`（`vp run -r test`）                    |
