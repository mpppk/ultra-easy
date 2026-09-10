# **20. v1スコープ・非スコープ**

## **20.1 Durable Runtime / Agent・MCP方針** **v1からCloudflare Workflowsを標準durable runtimeとして採用する。Dynamic WorkflowsおよびDurable Objectsはv1の必須構成に含めない。Flow ASTはCloudflare非依存に維持し、runtime差し替えが必要になってもPolicy/Flow ASTを変更しない。** **v1のcore scopeにはActionRequest、PrincipalRef/DelegationHop、ActionAuthorizer、Action Definition、ApprovalPolicyBinding、明示的none Flow、PrincipalExpression、principal/principal\_relation ApproverExpression、candidateCompletion、fail-closedなCondition/onUnresolved、EvaluationSnapshot、MaterializedStepId、action/evaluation/plan checksum分離を含める。単一Policy内はfirst-match、Bindingごとの複数PolicyはApprovalPlanCompilerで決定的に合成する。Approval Step expiry、固定parallel rejection semantics、dynamic candidate inbox projection、Decision時FGA Check、実行直前Re-Authorization、冪等性契約付きActionExecutorをv1に含める。Flow-level distinctApproversはv1で基本制約を提供し、より複雑なSoDはv1.1以降で拡張する。外部mutation統合は\`POST /action-requests\`を統一入口とし、Authorization ALLOW \+ Flow=noneは即時ActionExecutor、Flowありはpending approvalとしてWorkflow開始する。チケット管理13集約ケースのうち1〜9と通常expiryをv1の受入対象とする。** **MCP integrationはv1ではtools/callをActionRequestへ正規化するAdapterとし、承認待ちが必要でclientがio.modelcontextprotocol/tasksをadvertiseする場合はMCP Taskとしてprojectionする。MCP Taskはprotocol projectionであり、Cloudflare Workflowと同様にPolicy ASTの正本ではない。Policy/Binding変更のmeta-approval、admin.force\_cancel、通知event発火点、添付content hash、最低限のデータ保持・observabilityをv1運用要件に含める。チケットのfield-level read/write、list/search authorization filtering、notification visibility等はApproval Flowのscope外でありTicket Application \+ ActionAuthorizer/OpenFGAで扱う。Partial/line-item/bulkはv1では複数ActionRequestへ分解する。ApprovalGrant、BatchRequest/plan approval、Reminder/Escalation/SLA、一般化したbreak-glass/post-approval実行、複雑なretention/crypto-shreddingはv1.x以降の拡張候補とする。** **21\. 実装ロードマップ**

01\. approval-core: ActionRequest / Principal / Delegation / ApprovalPolicyBinding / checksum identities \+ JSON AST types

02\. approval-core: ActionDefinitionResolver \+ Standard Schema integration / SchemaResolver

03\. approval-core: fail-closed Condition evaluator / field namespace / derived attributes / money rules

04\. approval-core: Semantic policy validator

05\. approval-core: TypeScript AST builder

06\. approval-core: PolicyBindingResolver / evaluator / first-match-per-policy / ApprovalPlanCompiler

07\. approval-core: Flow materializer / EvaluationSnapshot / MaterializedStepId / PrincipalExpression / candidate semantics

08\. approval-core: Flow interpreter semantics / DurableRuntime port

09\. approval-runtime-cloudflare: Generic ActionWorkflow \+ explicit waitForEvent expiry \+ interpreterSemanticsVersion

10\. approval-core: ActionAuthorizer result/evidence \+ ApproverResolver consistency/completeness \+ idempotent ActionExecutor contract

11\. approval-fga: Auth0 FGA ActionAuthorizer / ApproverResolver adapter (Check/ListUsers)

12\. approval-d1: Cloudflare D1 schema/migrations

13\. approval-d1: audit/read projections \+ approval\_task\_candidates \+ PolicyBinding snapshots \+ idempotent repositories

14\. approval-api: POST /action-requests統一入口 / trusted context補完 / authorize / Policy評価 / immediate execute or Workflow start \+ Re-Authorization

15\. approval-api: task decision / cancel \+ separate OpenAPI contract

16\. approval: snapshot approver

17\. organization: FGA projection \+ outbox worker

18\. organization/authorization: approval proxy \+ agent delegation grant

19\. approval: audit events \+ notification semantics \+ meta-approval \+ admin.force\_cancel

20\. approval-mcp: tools/call ActionRequest adapter \+ MCP Tasks projection; approval: simulator \+ human/AI 6ケース \+ ticket 13集約ケースE2E matrix

21\. policy-ui support: Standard JSON Schema Field Catalog (optional v1.x)
