# **19\. テスト戦略**

| 対象 | テスト種別 | 代表ケース |
| :---- | :---- | :---- |
| Condition evaluator | unit | 境界値、and/or/not/in/contains、field-to-field、missing/type mismatchのfail-closed、minor-unit金額/currency |
| Policy semantic validator | unit | duplicate local key、invalid quorum、always位置、Binding selector、expiry、candidate上限、onUnresolved制約 |
| Policy evaluator | unit | Rule selection、none、PolicyBindingResolver、composition order、defaultFlowConstraints |
| Flow materializer | unit | expression解決、MaterializedStepId安定性、EvaluationSnapshot、serial/parallel、candidate cohort完全性 |
| Flow Interpreter | unit | none/serial/parallel/all/any/quorum、固定reject semantics、PrincipalExpression、candidateCompletion、expiry、onUnresolved、distinctApprovers、decision event loop、reject/cancel |
| Builder | unit/type test | AST一致、JSON.stringify可能、型推論 |
| Standard Schema integration | contract | async validate、input/output変換 |
| FGA model | integration | Check/ListUsers、hierarchy、delegation condition、MINIMIZE\_LATENCY/HIGHER\_CONSISTENCY、ListUsers incomplete/failure |
| Repository | integration | RFC 8785/SHA-256 golden test、action/evaluation/plan checksum分離、MaterializedStepId、task candidates、action\_events/action\_results、idempotency、outbox、append-only |
| API | E2E | 6つのhuman/AI基本ケース \+ チケット管理13集約ケース、承認不要Actionの即時実行、単一/多段/条件/parallel/quorum、SoD、delegation、dynamic/snapshot、変更時再承認、Partial/Bulkの複数ActionRequest分解、user/agent/service、direct/delegated authority、Policy合成、Re-Authorization→ActionExecutor、MCP task projection、TOCTOU/race/retry |

## **19.1 FGA Model Tests**

FGA authorization modelはモデルテストをコード管理し、代表的な組織階層・代理・否定ケースをCIで検証する。Application integration testではAuth0 FGAまたは互換OpenFGA test environmentを使う。

## **19.2 Cloudflare Workflows Integration Tests** **Generic ActionWorkflowについて、instance再開、step.do retry時のidempotency、waitForEventの先行event buffering、MaterializedStepIdによるdeterministic step naming、明示timeout/expiry、365日境界、Plan参照load/checksum検証、payload/step-result size超過拒否、interpreterSemanticsVersionごとの旧semantics維持、serial/parallel/all/any/quorumと固定reject semantics、invalid decisionを無視して再待機する挙動をintegration testする。さらにPrincipalExpression（caller/authority\_principal/delegator）とprincipal\_relation解決、authority principalを基準とした自己承認禁止、candidateCompletion、unresolved approverのfail-closed、distinct approver制約、approvalBindingFingerprint mismatch時の承認再利用禁止、Decision時刻固定、dynamic candidate projection \+ final HIGHER\_CONSISTENCY Check、承認待ち中のauthority失効をRe-Authorizationで拒否する挙動、Authorization provider errorとdenyの分離、ActionExecutor retry/idempotency、Agent delegation chainのattenuationを検証する。Cloudflare固有APIを使わないInterpreter semanticsはInMemoryRuntimeでunit testする。MCP Adapterはtools/call→ActionRequest→MCP Task projection、input\_required/tasks/update、Tasks非対応clientのfallbackをprotocol integration testする。** **20\. v1スコープ・非スコープ**

| 機能 | v1 |
| :---- | :---- |
| Sequential approval | ○ |
| Parallel all | ○ |
| Parallel any | ○ |
| Quorum | ○ |
| 金額/任意field条件 | ○ |
| FGA relation approver | ○ |
| Direct user approver | ○ |
| Dynamic approver | ○ |
| Snapshot approver | ○ |
| 自己承認禁止 | ○ |
| Delegation | ○ |
| Reject | ○ |
| Cancel | ○ |
| Policy versioning | ○ |
| Simulator | ○ |
| Audit/outbox | ○ |
| Standard Schema input validation | ○ |
| Standard JSON Schema field discovery | 任意Capability |
| Send back | v1.1 |
| Escalation/reminder/SLA | v1.1 |
| Conditional step skip | v1.1 |
| Proxy request | v1.1 |
| GUI Policy Editor | v2 |
