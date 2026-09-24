# MCP Gateway — ActionType連携のtool visibility / approval / downstream execution

ultra-easyを **MCP tool firewall + approval gateway** として使うための設計とwire contract。
Epic: #129（#130 Binding / #131 Tool Exposure / #132 tools/call pipeline / #133 downstream executor / #134 Tasks hardening、#98を含む）。

AI Agentから見えるMCP toolをActionType単位のポリシーで制御し、`tools/call` を既存の `ActionRequest` pipelineへ正規化する。
Authorization / Approval / Re-Authorization完了後に、実際のdownstream MCP serverへtool callをproxyする。

**Gatewayは独自のApproval state machineを持たない。** Authorization / Approval / execution lifecycle / auditの正本はActionRequestで、
Gateway固有の状態はprotocol projection / routing snapshot / logical invocation metadataに限定する。

実装: `@app/approval-mcp`（`McpGateway` / `McpActionExecutor` / `StreamableHttpMcpDownstreamClient`）、
`@app/approval-application`（`ActionRequestApplicationService.prepare` / `commit`）、
`@app/approval-d1`（`D1McpInvocationRepository` / `D1McpRouteSnapshotRepository`、migration `0013_mcp_gateway.sql`）、
`@app/approval-fga`（model `mcp_tool#can_use`）。

## 1. 全体フロー

```text
tools/list:
  trusted context -> active bindings(organization) -> Tool Exposure -> visible tools

tools/call:
  trusted context (origin.type=mcp, organization一致)
    -> binding resolve (tool name, active only; 未解決はfail-closed)
    -> Tool Exposure (deny / provider errorはActionRequest作成前に拒否)
    -> logical invocation reserve (tenant / principal / client scope)
    -> arguments -> Action(resource + input)
    -> ActionRequestApplicationService.prepare
         Action Definition / input validation / initial Authorization /
         Policy評価 / immutable Materialized Plan / ActionRequest ID（副作用なし）
    -> MCP admission
         approval requiredならTasks capability確認 + durable Task予約
         route snapshot保存
    -> ActionRequestApplicationService.commit(prepared)
         prepared Planをそのまま保存（Policy再評価なし）/ audit / Workflow start or immediate execution
    -> deny (tool-level error) | immediate result | CreateTaskResult

approval完了後 (既存ActionWorkflow):
  Re-Authorization (higher_consistency) -> McpActionExecutor
    -> route snapshot -> downstream MCP tools/call -> ActionExecutionResult
```

## 2. Protocol contract（version pin）

| 項目                  | 値                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------- |
| MCP protocol revision | `2026-07-28`（`MCP_PROTOCOL_REVISION`）                                                   |
| Tasks extension       | `io.modelcontextprotocol/tasks`（SEP-2663）                                               |
| Specification         | https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks                |
| SDK                   | 使用しない。method / payload / error codeは `protocol.ts` で定義しcontract testで固定する |

- client capabilityはper-requestの `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` で宣言する。
  transport sessionはidentity boundaryにしない。
- HTTP handler（`handleMcpGatewayHttpRequest`）は `MCP-Protocol-Version` が `2026-07-28` 以外なら400を返す。
- `server/discover` は `capabilities.extensions["io.modelcontextprotocol/tasks"]` と `tools.listChanged=false` を宣言する。

### Methods

| method            | 結果                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `server/discover` | `{ resultType: "complete", supportedVersions, capabilities, serverInfo }`                     |
| `tools/list`      | `{ resultType: "complete", tools, nextCursor? }`（cursorはopaque）                            |
| `tools/call`      | `CallToolResult`（`resultType: "complete"`）または `CreateTaskResult`（`resultType: "task"`） |
| `tasks/get`       | `{ resultType: "complete", ...Task, result? , error? }`                                       |
| `tasks/update`    | `{ resultType: "complete" }`                                                                  |
| `tasks/cancel`    | `{ resultType: "complete" }`                                                                  |

`notifications/tasks` / `subscriptions/listen` はv1では提供しない（`tasks/get` polling。`pollIntervalMs` を返す）。
`input_required` はv1では発行しないため、`tasks/update` の `inputResponses` はoutstandingでないkeyとして仕様どおり無視しackする。

### `_meta` keys

| key                                          | 方向                 | 用途                                                                |
| -------------------------------------------- | -------------------- | ------------------------------------------------------------------- |
| `io.modelcontextprotocol/clientCapabilities` | client → Gateway     | Tasks capability宣言                                                |
| `dev.ultra-easy/invocationKey`               | client → Gateway     | logical invocation key（1〜255文字）。JSON-RPC request idは使わない |
| `dev.ultra-easy/idempotencyKey`              | Gateway → downstream | execution idempotency key（ActionRequest retryで常に同じ値）        |
| `dev.ultra-easy/actionRequestId`             | Gateway → downstream | telemetry相関                                                       |

### Error codes

| code                           | 意味                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `-32600` / `-32601` / `-32700` | Invalid Request / Method not found / Parse error                                                                               |
| `-32602`                       | Invalid params。unknown tool・**hidden tool**・task not found・**他ownerのtask** は同じshapeで区別しない                       |
| `-32603`                       | Internal error（trusted context失敗 / provider障害はfail-closed。`data.code` / `data.retriable` / 回収可能なら `data.taskId`） |
| `-32021`                       | Missing required client capability（`data.requiredCapabilities.extensions["io.modelcontextprotocol/tasks"]`）                  |
| `-32029`                       | Rate limited（`data.retryAfterSeconds` 等）                                                                                    |
| `-32030`                       | 同じinvocation keyが異なるrequestへ再利用された                                                                                |
| `-32031`                       | 同じlogical invocationを処理中（`data.retryAfterMs`）                                                                          |
| `-32032`                       | Task operationが許可されない（read権限のみでupdate / cancel、cancellation拒否 / 未対応）                                       |

## 3. ActionType ↔ MCP Tool Binding（#130）

`McpToolBinding` はadapter側だけが持ち、coreの `ActionDefinition` にMCP概念を入れない。

```ts
type McpToolBinding = {
  id: string;
  version: number; // routing / contract変更時は上げる
  organizationId: OrganizationId;
  status: "active" | "inactive";
  actionType: ActionType;
  exposedTool: { name; title?; description?; inputSchema; outputSchema?; annotations? };
  target: { mcpServerId: string; toolName: string };
  argumentMapping: { resourceType: ResourceType; resourceIdArgument: string };
};
```

- organization内のactive bindingでtool名・ActionTypeとも1:1。重複 / 不正tool名 / 不正schemaは `StaticMcpToolBindingRegistry.create` でfail-fast。
- inactive bindingは解決・公開しない。未解決のtool callはunknown toolとしてfail-closed。
- input schema整合性方針: 公開 `inputSchema` はclient向けwire contract。実行可否の正本はAction Definitionのinput schema（prepareで必ずvalidation）。
  binding側は「type=object」「resource ID argumentを必須stringとして宣言」だけを保証する。
- `validateMcpToolBindingsAgainstActionDefinitions` でActionTypeがpublish済みAction Definitionを持ち、executorKeyがMCP executorであることを確認できる。
- argumentsからactor / authority / organizationを読むことはない（trusted contextだけが正本）。

### Routing変更とapprovalの関係

admission時に `McpRouteSnapshot`（binding id / version / fingerprint / target / argumentMapping / actionFingerprint）をActionRequestへINSERT-onlyでbindする。
`McpActionExecutor` はsnapshotだけを使い、bindingの現在値を見ない。承認待ち中にbindingを別targetへ変更しても、承認済みActionは承認時のtargetで実行され、
新しいtools/callだけが新targetを使う。snapshot欠落 / actionFingerprint不一致はnon-retriableで実行しない。

## 4. Tool Exposure（#131）

- `McpToolExposureAuthorizer.check({ organizationId, actor, authority, origin, actionType, toolName })`
- 実装: `StaticMcpToolExposurePolicy`（organization / ActionType / authority / actor / clientId rule、default deny）、
  `OpenFgaMcpToolExposureAuthorizer`（`mcp_tool:<org>/<actionType>#can_use` をauthority principalでcheck）、`AllOfMcpToolExposureAuthorizer`。
- 委任scopeの `actionTypes` がActionTypeを含まない場合はproviderへ問い合わせずhideする。
- **Exposure allowは実行許可ではない。** `tools/call` はExposure再確認の後、必ずFull Action Authorization（`ActionAuthorizer`）を行う。
- **Exposure denyのtoolを直接callしてもActionRequest / Workflow / Executorを開始しない。** 応答はunknown toolと同じ。
- provider errorはfail-closed。`tools/list` は部分的な一覧を返さずerrorにする。

OpenFGA model（`packages/approval-fga/openfga/model.fga`）:

```text
type mcp_tool
  relations
    define can_use: [user]
```

model変更はadditive。publishは `docs/runbooks/authorization-console.md` の手順で行い、`mcp_tool:<org>/<actionType>` へのtupleはIaC / governed relationship mutationで管理する。

## 5. Logical invocation idempotency（#132）

Invocation idempotency（clientの同じ論理 `tools/call` の再送）とExecution idempotency（ActionExecutor retry）は別物として扱う。

- scope: organization + actor + authority principal + caller + clientId + `dev.ultra-easy/invocationKey` → `invocationId`（sha256）
- request hash: tool名 + canonical arguments。policy / routingの現在値は含めない
- same key + same request → 同じActionRequest / Task / final result（replayはrate limitを消費しない）
- same key + different request → `-32030`
- 同時再送 → 1件だけがreserve（INSERT OR IGNORE）。他は `-32031`
- keyを省略したcallはserver生成keyになり、replayできない

`McpInvocationRecord.status`:

| status      | 意味                                                                                    | crash / 失敗時                                            |
| ----------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `reserved`  | key予約済み、prepare前（副作用なし）                                                    | lease期限後に引き継ぎ、最初からやり直す                   |
| `prepared`  | prepare + admission済み（preparation / Task ID / route snapshotを永続化）、commit未完了 | lease期限後に同じpreparationで `commit({ resume: true })` |
| `committed` | ActionRequest commit済み、MCP Taskとして追跡中                                          | —                                                         |
| `completed` | 最終responseを保存済み                                                                  | replayは同じresponse                                      |

leaseは `leaseToken` でfenceしたcompare-and-set。`leaseMs`（default 120秒）はcommit + downstream timeoutより長くする。
回収はtools/callの再送と `tasks/get` polling（Exposure再確認後）の両方で行う。

## 6. prepare → admission → commit（#132 / #134 / #98）

`evaluate → submit` の二重評価（Policy変更によるTOCTOU）は行わない。

- `prepare(action, trustedContext)` → `{ type: "prepared", prepared: PreparedActionRequest } | { type: "authorization_denied", ... }`。
  Plan保存 / audit / Workflow / Executorの副作用なし。`approvalRequired` はprepared planから決まり、callerに委ねない。
- admission（Gateway）: approval requiredでclientがTasks非対応なら **commitせず** `-32021`（#98）。Task予約 / route snapshot保存に失敗してもcommitしない。
- `commit({ preparation, now?, resume? })` はprepared Planの整合性（ID / organization / snapshot / checksum）を検証し、同じPlanだけを保存する。
  `resume: true` は同じPlanが保存済みでもaudit（eventKeyで重複排除）とWorkflow開始（決定的instance ID、`ActionWorkflowStarter.start` は冪等）を再開する。
- `submit = prepare + commit` なのでHTTP / MCPでAuthorization / Approval semanticsは分岐しない。
- Plan保存後のaudit / Workflow開始失敗はnon-retriableでも `prepared` のまま回収対象にし、ActionRequestを孤立させない。
  Plan保存前の検証失敗 / Plan conflictだけがterminal（`completed` + error）。

## 7. MCP Tasks（#134）

### Ownership / access control

Task IDは高entropy（`task_<uuid>`）だが **bearer credentialにしない**。Task作成時のowner（organization / actor / authority principal / caller / clientId）をsnapshotし、
各operationでper-requestのtrusted contextから組み立てたidentityと完全一致を要求する。

| operation      | 必要条件                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `tasks/get`    | Tasks capability + owner、または `McpTaskAccessAuthorizer.canRead` の明示的read permission            |
| `tasks/update` | Tasks capability + owner（read permissionでは不可）                                                   |
| `tasks/cancel` | Tasks capability + owner + `McpActionRequestCanceller` によるActionRequest cancellation authorization |

owner以外（別actor / authority / caller / client / organization）はtask not foundと区別できない `-32602`。reconnect後も同じstable identityなら同じTaskを取得できる。

### Cancellation semantics

- commit前（`reserved` / `prepared`）: ownerはadmissionを取り下げられる。invocationは `completed(cancelled)` になり、以後commitされない。
- commit後: `McpActionRequestCanceller.cancel` に委ねる（未設定なら `-32032 cancellation_not_supported`、deniedなら `-32032`）。
  acceptedはcooperative cancellationで、ActionRequestが `cancelled` になった時点でTaskも `cancelled` を返す。
- terminal済みのtaskへのcancelはackのみ。

### Lifecycle projection

Task statusはActionRequest statusの文字列だけでなく、result / error provenanceから決める。

| ultra-easy / downstream outcome                               | MCP Task                                          |
| ------------------------------------------------------------- | ------------------------------------------------- |
| approval待ち / approved / execution中 / commit前              | `working`                                         |
| downstream `CallToolResult` success                           | `completed` + `result`                            |
| downstream `CallToolResult { isError: true }`                 | `completed` + `result.isError=true`               |
| approval rejected / expired                                   | `completed` + tool-level error result             |
| Re-Authorization deny（`authorization_revoked`）              | `completed` + tool-level error result             |
| downstream JSON-RPC error                                     | `failed` + `error`（元のJSON-RPC code）           |
| Re-Authorization provider failure / executor・adapter failure | `failed` + `error`（`-32603`、`data.provenance`） |
| cooperative cancellation accepted and observed                | `cancelled`                                       |

downstreamのJSON-RPC errorはActionExecutorError.code `mcp_jsonrpc_error:<code>` として永続化し、projectionで復元する。
`failed` はJSON-RPC errorだけに使い、tool-level / business errorには使わない。

## 8. Downstream MCP ActionExecutor（#133）

- `McpActionExecutor`（executorKeyは運用で決める。例: `mcp-gateway`）は既存ActionWorkflowのRe-Authorization通過後にだけ呼ばれる。
- `McpDownstreamServerRegistry` がserver ID → endpoint / credentialRef / timeoutを解決し、credentialは `McpDownstreamCredentialProvider` が都度解決する（binding / snapshotへ保存しない）。
- `StreamableHttpMcpDownstreamClient` は2026-07-28 Streamable HTTPで `tools/call` を1回POSTする（JSON / SSE response対応、Tasks capabilityは宣言しない）。
- retry分類（exactly-onceは主張しない）:

| 失敗                                     | effect    | retriable                              |
| ---------------------------------------- | --------- | -------------------------------------- |
| credential解決失敗                       | not_sent  | yes                                    |
| HTTP 429 / 503                           | rejected  | yes                                    |
| HTTP 401 / 403 / その他4xx               | rejected  | no                                     |
| network断 / timeout / 5xx / 不正response | ambiguous | `guaranteeLevel=idempotent` の場合のみ |
| downstream JSON-RPC error                | —         | no                                     |

`guaranteeLevel` のdefaultは `best_effort_at_most_once`。downstreamが `dev.ultra-easy/idempotencyKey` でdedupeする場合だけ `idempotent` を設定する。

## 9. Telemetry / audit

- Gateway: `request.accepted` / `request.replayed` / `request.denied` を `mcpInvocationId` + `actionRequestId` で相関し、`toolName` / `mcpServerId` / `bindingVersion` を付ける。
  pre-ActionRequestのdeny（Exposure / conflict）は `mcpInvocationId` をcorrelation rootにする。tool argumentsはlogへ出さない。
- Executor: `executor.completed` / `executor.failed` を `actionRequestId` + `toolName` / `mcpServerId` で相関する。
- Audit: 既存の `action.received`（actor / authority / caller / delegationChain）以降のActionEventが正本。originは `mcp` + clientId。

## 10. 永続化（D1）

- `mcp_invocations`: logical invocation + durable Task（`task_id` はpartial unique index）。record本体はJSON、CAS / indexに使う列だけを昇格する。
- `mcp_route_snapshots`: ActionRequestごとのrouting snapshot（INSERT-only）。

## 11. Non-goals

- MCP独自のapproval model / state machine
- core `ActionDefinition` へのMCP protocol概念の導入
- `tools/list` 結果だけによる実行許可
- Task IDだけを認証情報として扱うbearer-only設計
- downstream MCP serverの業務ロジックの移植
