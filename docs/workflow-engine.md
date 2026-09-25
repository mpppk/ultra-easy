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
