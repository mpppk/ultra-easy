# Application Catalog — 外部アプリのAction / Composite Action登録（#198）

Status: Accepted（2026-09-30）/ Parent: #191（Workflow Engine Phase 2）/ Consumer: #183

## Context

外部アプリ（最初の利用者は `apps/knowledge`）は、自分のprimitive Action（Knowledge `/mcp` のtool）と
Workflow-backed Composite Action（`knowledge.publish_document` / `knowledge.maintain_space`）を
ultra-easyのAction Catalogへ登録する必要がある。エンジンには `CompositeActionPublisher` と
MCP Gateway（#129〜#134）があるが、外部から登録する経路が無かった。

- Studio（#192）のpublishはeditorがruntimeでAction Catalogへ書き込む。任意のaction typeで
  publishでき、Action Definitionはaction typeごとの **最新version** で解決されるため、別のWorkflowを
  同じaction typeの新しいversionとして公開すればアプリのActionを差し替えられてしまう。
- `docs/governance-bootstrap.md` は、runtimeのserviceがcatalogへ直接書き込むことを禁じ、初期登録を
  「deployment principalのIaC」か「review済みのversion-controlled migration」に限っている。
- MCP Gatewayの `McpActionExecutor` は `tools/call` のadmission時に保存するroute snapshotでだけ実行する。
  公開APIからsubmitしたActionRequestや、WorkflowのchildのActionRequestはsnapshotを持たない。

## Decision

### 1. 登録は宣言的なmanifest → review済みcatalog migration

- アプリのcatalogは `apps/approval-api/src/catalog/<app>.ts`（`ApplicationCatalog`）で宣言する。
  中身は次のとおり。
  - primitive Action: action type / version / resource type / Authorization relation /
    MCP tool（server・tool名・resource ID argument）/ input schema（JsonSchemaLite）
  - 手書きのProgram（sandboxで実行する。LLM生成ではない）
  - Composite Action（Workflow DefinitionのJSON、action typeとversion）
  - MCP server（Service Binding名・path・endpoint var・token secret名・guarantee level）
- `vp -C apps/approval-api run generate:catalog` がcatalogを検証し、
  `packages/approval-d1/migrations/NNNN_<app>_catalog.sql` を生成する。PRでreviewしてcommitし、
  deploy時の `wrangler d1 migrations apply`（deployment principal）で適用する。
- migrationは **plain INSERT** で出力する。同じkey / versionの行が既にあれば、migrationごと失敗する
  （fail-closed）。登録済みの行を書き換えることはない。
- 各entry（`action:<type>@<v>` / `program:<id>@<v>` / `composite:<type>@<v>`）は、
  `-- catalog-entry: <id> <sha256>` のmarkerとしてmigrationに記録する。generatorは、既存migrationに
  同じidが別digestで記録されていると `catalog_entry_immutable` で失敗する。登録済みversionを
  変更するには、新しいversionを追加する（新しいmigrationになる）。
- テスト（`catalog.test.ts`）は、catalogのすべてのentryが、commit済みのmigrationに同じdigestで
  含まれていることを確認する。生成し忘れはCIで検出される。
- runtimeにはcatalogへの書き込み経路を持たせない。runtimeがcatalogの宣言から読むのは、
  server registry、input schema、Authorization relation、予約済みaction type、Programの
  capabilityだけである。

公開の管理API（runtimeでの登録）は採らない。catalogの変更はコードレビューを要する変更であり、
#193のclient registryと同じ「repositoryで管理する宣言的な設定」に揃える。

### 2. MCP-backed primitive Actionの実行（`mcp:<serverId>` executor）

- primitive ActionのAction Definitionは `executorKey = mcp:<serverId>` とし、
  `mcp_action_routes`（migration `0030`、insert-only、UPDATE / DELETEはtriggerで禁止）に
  ActionDefinition (key, version) → downstream tool / argument mappingを登録する。
- `McpCatalogActionExecutor`（`@app/approval-mcp`）は、Materialized Planがsnapshotした
  ActionDefinition (key, version) のrouteだけを使う。routeの行はfingerprintと照合してから使い、
  改変されていれば `mcp_action_route_corrupted` で実行しない。executorは1つのserverに固定され、
  routeのserver / action type / resource typeが一致しなければ `mcp_action_route_mismatch` になる。
- Action inputにresource IDを上書きさせない。resource ID argument（Knowledgeでは `spaceId`）は
  常に `action.resource.id` から渡す。
- downstreamの `isError: true` は **Actionの失敗** として扱う。MCP Gatewayの `tools/call` は
  tool-level errorを完了として返すが、Workflowのchildが失敗を成功として先へ進まないよう、
  catalog経由では失敗にする。codeは `structuredContent.code` を引き継ぐ（形式が不正なら
  `mcp_tool_error`）。retriableになるのは、downstreamが `retriable: true` を返し、かつserverが
  `idempotent` の場合だけである。
- credentialはWorker secret（`tokenSecret`）から都度読み、`Authorization: Bearer` で送る。
  route / binding / logには保存しない。同じCloudflare accountのWorkerへは、Service Binding
  （`serviceBinding`）で接続する（workers.dev間のfetchは使えない）。bindingもendpoint varも無い
  deploymentでは、`mcp_server_not_configured` で失敗する。

MCP Gatewayの `tools/call` 経路（route snapshot、`McpActionExecutor`）は変更しない。

### 3. Authorizationはcatalogが宣言するrelation

- `stagingActionRelation` は、catalogに登録されたaction type × resource typeの組について、
  宣言されたrelationをOpenFGAでcheckする。登録されていないresource typeでは、同じaction typeでも
  拒否する（fail-closed）。
- Knowledgeのactionはすべて **space単位** で認可する（resource = `knowledge_space`）。
  modelは `knowledge_space#can_view`（viewer / editor / owner）、`#can_edit`（editor / owner）、
  `#can_manage`（owner）で、#195のrole tupleだけで判定できる。
- page / snapshotがそのspaceに属するかは、正本を持つKnowledgeが照合する。MCP routeは
  resourceのspaceを `spaceId` として必ず渡し、Knowledgeのtoolは別spaceのpage / snapshotを
  `resource_outside_space` で拒否する。page→spaceのtupleをultra-easyへ同期する必要はない。
- Approval Policyが参照するinput（`knowledge.revision.publish` の `visibility` / `sensitivity`、
  `knowledge.page.archive` の `pageOwnerId`）もKnowledgeが実際の値と照合する
  （`publication_snapshot_mismatch` / `page_owner_mismatch`）。入力を偽って承認を回避できない。

### 4. アプリが所有する名前空間

- catalogの `actionTypePrefix`（例: `knowledge.`）以下のaction typeと、catalogのWorkflow Definition /
  Programは、そのアプリだけが所有する。本番Workflow Studioは、それらへのdraft保存・publish
  （`actionType` が名前空間内のもの、またはcatalogのWorkflow ID）と、catalogのProgram IDの
  publishを `409 catalog_owned` で拒否する。
- catalogの検証は、primitive / Composite / Program capabilityのaction typeが名前空間の中にあること、
  Workflowが参照するActionとProgramがcatalogに存在することを要求する。

## Knowledge catalog（v1）

| Action                         | 種別      | resource          | relation     | 実行                                  |
| ------------------------------ | --------- | ----------------- | ------------ | ------------------------------------- |
| `knowledge.publication.get`    | primitive | `knowledge_space` | `can_edit`   | `/mcp` `knowledge.publication.get`    |
| `knowledge.revision.publish`   | primitive | `knowledge_space` | `can_edit`   | `/mcp` `knowledge.revision.publish`   |
| `knowledge.search.reindex`     | primitive | `knowledge_space` | `can_edit`   | `/mcp` `knowledge.search.reindex`     |
| `knowledge.watchers.notify`    | primitive | `knowledge_space` | `can_edit`   | `/mcp` `knowledge.watchers.notify`    |
| `knowledge.pages.list_stale`   | primitive | `knowledge_space` | `can_view`   | `/mcp` `knowledge.pages.list_stale`   |
| `knowledge.page.get_published` | primitive | `knowledge_space` | `can_view`   | `/mcp` `knowledge.page.get_published` |
| `knowledge.page.mark_reviewed` | primitive | `knowledge_space` | `can_manage` | `/mcp` `knowledge.page.mark_reviewed` |
| `knowledge.page.archive`       | primitive | `knowledge_space` | `can_manage` | `/mcp` `knowledge.page.archive`       |
| `knowledge.publish_document`   | composite | `knowledge_space` | `can_edit`   | `wf:knowledge-publish-document` v1    |
| `knowledge.maintain_space`     | composite | `knowledge_space` | `can_manage` | `wf:knowledge-maintain-space` v1      |

- `knowledge.publish_document`（input `spaceId`, `publicationSnapshotId`）: snapshotを読み、
  policyが参照するvisibility / sensitivityをsnapshotから子Actionへ渡す → publish（通常の
  Approval Policy）→ reindex / notify（独立した子Action）。LLMのmetadata分析は#201で追加する。
- `knowledge.maintain_space`（input `spaceId`）: stale pageを列挙し、pageごとに
  `prog:knowledge-review-page` を実行する。Programは、published revisionを読んでfreshnessを判定し、
  要確認ならpage ownerへHuman Inputを出す（担当者・選択肢・対象・分析付き。#197）。その後
  `mark_reviewed` / `archive`（archiveは通常の承認を通る）を子Actionとして要求する。判定は、#201で
  LLM Gatewayへ置き換えるまでの決定的なheuristic（`mock/llm.ts` と同じ）である。
- Knowledge側（#183）が `RemoteUltraEasy` で使う入力形は、このcatalogのinput schemaが正である。

## Governed approval rules（#199）

アプリは、自分のresource（Knowledgeではspace）ごとに、自分のActionの承認ruleを変えられる。

- 語彙: catalogの `approvalPolicy.scheme`（`ApplicationApprovalScheme`）が、ruleを書けるAction、
  条件に使えるinput field（`{field, equals}`）、approver（`{relation}` = scope上のrelation、
  `{inputUser}` = Action inputのuser ID）、`requesterIsNot`、既定ruleを宣言する。条件やapproverが
  参照するfieldは、そのActionの最新versionで **必須input** でなければならない（catalogの検証）。
  Conditionはfail-closedなので、存在しないfieldを参照するruleはerrorになるためである。
- 変更: 組み込みのgoverned action `application.approval_policy.update`
  （resource = scope、input = `{ baseVersion, policy }`、Authorization = `updateRelation`、
  Knowledgeでは `knowledge_space#can_manage`）。inputはsubmit時にschemeの語彙で検証する。
- meta-approval: `application.approval_policy.update` のApproval Policyは常に、申請者以外の
  scope owner の承認を要求する（self-approval deny）。申請者以外にownerが居ない場合は、
  `onUnresolved: fallback` で組織管理者（`authorization_admin#editor`）へ回す。どちらにも申請者以外が
  居なければ承認できず、fail closed（`no_eligible_approver_candidates`）でruleは変わらない。
  bootstrapのv1（owner / 管理者のparallel any）は、どちらかの候補が申請者だけの場合にstepの有効化が
  失敗したため、catalog migrationのv2（`approval-policy-meta:<app>@2`）で置き換えた。
- 適用: `ApplicationApprovalPolicyExecutor` が、承認とRe-Authorizationの後にだけ適用する。
  `baseVersion` が現在のscope versionと一致しなければ `application_policy_conflict` になる
  （古い提案が後から承認されても、新しいruleを上書きしない）。適用は
  `application_approval_policies`（insert-only）へscope ruleの次のversionを、
  `published_approval_policy_versions` へcompile済みPolicyの次のversionを、1 transactionで保存する。
- compile: 統治するActionごとに1つのApproval Policy（`<policyKey>:<actionType>`）を持つ。
  固有ruleを持つscopeのrule（条件に `action.resource.id == scope` を含む）、その後に
  「このscopeは承認不要」、最後に既定ruleを並べる。最初に一致したruleが勝つ。これにより、
  固有ruleのscopeに既定ruleがfall throughしない。
  Approvalの参照範囲には `action.type` / `action.resource.type` / `action.resource.id` を追加した
  （`docs/approval-workflow-spec/part-06.md`）。
- 不変条件: 承認待ちのActionRequestは、Materialized Planに固定されたPolicy versionのまま変わらない。
  新しいversionが適用されるのは、以後にprepareされるActionRequestだけである。
- bootstrap: 既定ruleのPolicy v1、Actionごとのbinding、meta-approval policyとbindingは
  catalog migration（`approval-policy:<app>@1`）で入れる。`application.approval_policy.update` の
  Action Definitionは `0032_application_approval_policies.sql` で入れる。
- 読み取り: `GET /v1/organizations/{org}/application-policies/{scopeType}/{scopeId}`
  （scopeのmember、または登録済みapplication agent）→ `{ version, policy, pendingChange }`。
  `version` 0は既定ruleを表す。`pendingChange` は、現在のversionを基にした、まだ終端していない
  `application.approval_policy.update` である（`docs/openapi`）。

Knowledgeの対応:

| `UltraEasyClient`       | ultra-easy                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `getPolicyBinding`      | `GET .../application-policies/knowledge_space/{spaceId}`                                          |
| `proposePolicyBinding`  | `POST .../action-requests`（`application.approval_policy.update`、`baseVersion` = 読んだversion） |
| `space_owners` approver | `knowledge_space#owner`                                                                           |
| `page_owner` approver   | Action inputの `pageOwnerId`（Knowledgeが実際のownerと照合する）                                  |

`page_owner` をpublishのruleでも使えるよう、`knowledge.revision.publish` v2と
`knowledge.publish_document` v2（snapshotのpage ownerを渡す）を追加した。v1は登録済みのまま残る。

## Consequences

- アプリのAction追加・変更は、PR（catalog + 生成migration）→ deployで反映される。runtimeで即時に
  変えることはできない。
- routeはActionDefinition versionに固定されるため、承認待ちのActionRequestは、承認時と同じ
  tool / argument mappingで実行される。
- `action_definition.publish`（governed）で `knowledge.*` の新しいversionを公開することはできるが、
  そのversionにはMCP routeが無いため、実行は `mcp_action_route_missing` で失敗する。
- Scheduled maintenance（agent principal、#184 / #200）は、agentに `knowledge_space` のrelationを
  与える方法が決まるまで対象外である。

## 運用

- 生成: `vp -C apps/approval-api run generate:catalog` → 差分をreviewしてcommitする。
- 適用: `deploy:<env>`（migrate → deploy）。
- staging: `KNOWLEDGE` Service Binding（`ultra-easy-knowledge`）と、`KNOWLEDGE_MCP_TOKEN` secret
  （Knowledge Workerと同じ値）を設定する。production: Knowledge Workerをprovisionするまで
  bindingを置かない（`mcp_server_not_configured`）。
- FGA model: `knowledge_space#can_view` / `#can_edit` を追加した（additive）。publishと
  `OPENFGA_AUTHORIZATION_MODEL_ID` のpinは `docs/runbooks/authorization-console.md` の手順で行う。
