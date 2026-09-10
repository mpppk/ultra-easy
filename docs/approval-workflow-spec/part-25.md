# **21. 実装ロードマップ**

## **21.1 推奨マイルストーン**

| Milestone | 成果物 |
| :---- | :---- |
| M1 Core AST | Action Definition、Policy/Binding AST、Builder、fail-closed Validator/Evaluator、checksum canonicalization |
| M2 Workflow | EvaluationSnapshot/Materializer、MaterializedStepId、Flow Interpreter、expiry/semantics version、Cloudflare Workflows runtime/tests |
| M3 Persistence | D1/Drizzle schema、PolicyBinding snapshots、candidate inbox/read projections、audit/checksums、idempotency、outbox |
| M4 Authorization / Delegation | ActionAuthorizer/Evidence、delegation attenuation、FGA consistency/completeness、ApproverResolver、organization projection |
| M5 API / MCP Adapters | ActionRequest normalization、HTTP/OpenAPI boundary、MCP tools/call/Tasks、approve/reject/cancel/simulator |
| M6 Hardening | multi-tenant tests、meta-approval/force-cancel、notification semantics、attachment integrity/retention、audit、idempotency、observability |

# **22\. 未確定事項**

以下は実装前またはv1の早期段階で明示的に決定する。未確定であること自体を仕様として記録する。

Cloudflare固有の初期方針として、D1 topologyはshared database \+ organization\_id scopeを採用し、データ量・write throughput・隔離要件に応じてdatabase-per-tenant等へのshardingを評価する。1 D1 databaseは10 GB上限かつqueryをsingle-threadで処理するため、負荷試験で早期に実測する。

Dynamic Workflowsはv1では採用しない。ユーザーが定義するのは任意JavaScriptコードではなくPolicy/Flow ASTというデータであり、単一のGeneric ActionWorkflowがASTを解釈する。将来、tenantごとの任意コード実行や承認DSLを超えたautomationを許可する場合のみDynamic Workflowsを再評価する。  
Durable Objectsもv1では採用しない。Cloudflare Workflowsで表現できないstrict serializationや独自coordination要件が実測上必要になった場合のみ追加評価する。

| 論点 | 候補 / 推奨初期値 |
| :---- | :---- |
| Auth0 FGA Store topology | shared store \+ explicit tenant boundaryを第一候補。高い隔離要件ではstore per tenantも評価。 |
| Dynamic Checkと組織変更の厳密整合性 | 候補/inbox取得は結果整合を許容し、Decision受理直前と実行直前Re-AuthorizationはHIGHER\_CONSISTENCY相当を既定とする。固定候補が必要なStepはsnapshot。 |
| Send-back semantics | v1.1で「直前Stepへ」「任意Stepへ」「申請者へ」を設計。 |
| Policy Field Catalog metadata | label/format/enum等をJSON Schema annotationと別registryのどちらで管理するか。 |
| Relation Catalogの配布 | 静的config / FGA modelから生成 / 管理APIのいずれか。 |
| Policy AST structural validatorの実装 | 公開仕様はvendor-neutral。内部実装をStandard Schema compatible validatorとして提供するか決定。 |
| Outbox delivery semantics / Agent delegation / MCP integration | Outboxはat-least-once \+ consumer idempotencyを推奨。Agent delegationではgrant schema、再委譲可否、最大chain長、失効・TTL、creatorとcurrent callerが異なる場合のauthority解決をv1実装前に確定する。MCPでは信頼できるagent identityのbinding方式、Tasks非対応clientへのfallback、MCP Tasksと内部ActionRequest/WorkflowのID対応を確定する。 |

## **22.1 チケット統合に関する将来拡張**

# **Partial/Line-item/Bulk操作について、複数ActionRequestを束ねるBatchRequestを導入するか、batch全体の承認と各Actionの承認をどう合成するかはv1.xで決定する。v1では実行可能性・承認結果をresource/itemごとに独立させるため、原則として個別ActionRequestへ分解する。**

# 

# **Break Glass/Post Approvalは通常Flowと実行順序が逆転するため、\`execute\_before\_approval\`のようなflagを既存Approval Stepへ追加せず、専用のExecution Policy/Flow nodeまたは別のAction execution modeとして設計する。緊急実行可能なauthority、理由、期限、事後review必須条件、実行後にrejectされた場合の扱いを追加設計する。**

# 

# **Reminder/Escalation/SLAはApproval expiryとは分離する。v1.1では時間経過を契機に通知のみ行うケース、承認者を追加/reassignするケース、Flow自体を切り替えるケースを区別し、Policy version固定・監査再現性を壊さないdurable semanticsを定義する。**

#
