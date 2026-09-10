# Approval Workflow Platform — Implementation Plan & Acceptance Specification

**Status:** Draft  
**Purpose:** v1をTDD/Acceptance-firstで実装するためのマイルストーン、期待挙動、テスト戦略、完了基準を定義する。  
**Design Doc:** [`design-doc.md`](design-doc.md)  
**Detailed Specification:** [`approval-workflow-spec.md`](approval-workflow-spec.md)  
**OpenAPI:** [`openapi/openapi.yaml`](openapi/openapi.yaml)

## 1. この文書の役割

詳細仕様は最終的なdomain semanticsを定義する。一方、本書は「どの順番で実装し、各段階で何が動けば完了と判断するか」を定義する。

マイルストーンはpackageやインフラ製品単位ではなく、**外部から観測可能な能力**で区切る。各Acceptance Scenarioには安定したIDを付け、実装・テスト・GitHub Issueを同じIDで追跡できるようにする。

```text
Design Doc
  WHY / WHAT
      ↓
Detailed Specification
  DOMAIN SEMANTICS
      ↓
Implementation Plan
  ORDER / ACCEPTANCE CRITERIA
      ↓
Tests
  EXECUTABLE PROOF
      ↓
Implementation
```

## 2. 開発原則

### 2.1 Acceptance-first / TDD

各機能は原則として次の順で進める。

1. Acceptance ScenarioをGiven / When / Thenで定義する。
2. Core semanticsなら失敗するunit testを先に書く。
3. Port境界ならcontract testを追加する。
4. Adapterが必要になった時点でintegration testを追加する。
5. 最小実装でgreenにする。
6. Refactor後も同じAcceptance Scenarioがgreenであることを確認する。
7. Milestone最後にcritical-path E2Eをgreenにする。

「内部でどの関数を呼んだか」ではなく、**同じ入力・同じ固定contextに対して何が観測できるか**をテストする。

### 2.2 Test pyramid

| Level       | 主な対象                                                                               | 方針                                             |
| ----------- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Unit        | Condition / Policy / Compiler / Materializer / Interpreter semantics                   | 最多。外部サービスなし、決定的、高速             |
| Type test   | AST Builder / public TS API                                                            | compile-time contractを検証                      |
| Contract    | SchemaResolver / DurableRuntime / ActionAuthorizer / ApproverResolver / ActionExecutor | Adapter実装が満たすPort contractを固定           |
| Integration | D1 / OpenFGA / Cloudflare Workflows                                                    | 実サービスまたは互換test environmentで検証       |
| E2E         | HTTP/MCP → Approval → Re-Authorization → Execute                                       | critical pathのみ。v1 acceptance suiteとして維持 |

### 2.3 Test naming

Acceptance IDとテストを対応させる。

```text
tests/
  acceptance/
    m1-policy-core.test.ts
    m2-materialization.test.ts
    m3-authorization.test.ts
    m4-durable-runtime.test.ts
    m5-action-execution.test.ts
    m6-api-mcp.test.ts
    m7-production-readiness.test.ts

packages/*/src/**/*.test.ts
  unit / contract tests
```

テスト名には可能な限りAcceptance IDを含める。

```ts
it("AC-M1-004 fails closed when a field is missing", ...)
```

## 3. Milestone overview

| Milestone                              | Capability / 完了するとできること                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| M0 Foundation                          | domain model、test harness、canonical fixturesが揃い、以降をTDDで進められる           |
| M1 Policy Core                         | Action + Evaluation Context + Policy群から、承認Flowをpureかつ決定的に算出できる      |
| M2 Materialization                     | 実行時に必要なcontextを固定し、監査・再現可能なMaterialized Approval Planを生成できる |
| M3 Authorization & Approver Resolution | Action実行資格と承認候補をOpenFGA等のPort経由で安全に判定できる                       |
| M4 Durable Approval Runtime            | Human approval待ちを跨いでserial/parallel/quorum Flowをdurableに完走できる            |
| M5 Safe Action Execution               | 承認後に再認可し、冪等性を保って最終Actionを実行できる                                |
| M6 Public API & MCP                    | Application/AIがActionRequestだけを入口として一連の処理を利用できる                   |
| M7 Production Readiness                | multi-tenant、audit、notification、force cancel、observabilityを含め本番運用できる    |

各Milestoneは前段のAcceptance Suiteを壊さないことを完了条件に含む。

---

# M0 — Foundation & Executable Contracts

## Goal

実装を始める前に、用語・型・fixture・test harnessを固定し、以降のPRで「仕様を読んだ人によってテスト解釈が変わる」状態をなくす。

## Scope

- `ActionRequest`, `PrincipalRef`, `DelegationHop`, `ResourceRef` のcore types
- ID、key、type等の意味が異なる識別子をbranded typeで区別する
- Action / Policy / Flow / Condition AST types
- Standard Schema依存境界のinterfaceのみ
- package dependency rules
- Vitest設定、type test、fixture factory
- deterministic clock / ID / canonical JSON test utility
- representative fixture: human / AI / delegated action / ticket action / purchase action
- acceptance test directoryとID naming convention

## Expected behavior

### AC-M0-001 — ActionRequestはactorとauthorityを分離できる

**Given** AI Agentがuserの限定委任で操作する  
**When** ActionRequest fixtureを生成する  
**Then** `actor=agent`、`authority.principal=user`、delegation chainを独立して表現できる。また、`UserId`、`AgentId`、`ResourceId`等の意味が異なる識別子は相互に代入できず、取り違えをcompile-time errorとして検出できる。

### AC-M0-002 — Core ASTはJSONとしてround-tripできる

**Given** serial + parallel + approvalを含むPolicy AST  
**When** `JSON.stringify` → `JSON.parse`する  
**Then** domain上同一のASTとして扱える。function/class instance/runtime handleを含まない。branded typeはTypeScript上だけの情報とし、JSON表現へ余計なbrand fieldを追加しない。

### AC-M0-003 — Core packageはAdapterへ依存しない

`approval-core`からCloudflare、D1、OpenFGA SDK、HTTP framework、Zod等をimportしないことをdependency testで保証する。

## Suggested tests

```text
packages/approval-core/src/action-request.test.ts
packages/approval-core/src/ast-roundtrip.test.ts
tests/architecture/dependency-rules.test.ts
tests/fixtures/fixture-contract.test.ts
```

## Deliverables

- package skeleton
- Vitest / type-test configuration
- fixture factories
- deterministic test utilities
- CIでunit/type testsが実行可能

## Definition of Done

- AC-M0-001〜003がgreen
- empty implementationでもない最小domain typesが公開される
- 意味が異なる主要な識別子がbranded typeとして公開され、代表的な取り違えがtype testで拒否される
- `pnpm test`等の単一commandでunit testが実行できる
- CIでCoreの禁止dependencyを検知できる
- 次のMilestoneが外部serviceなしで開始できる

---

# M1 — Policy Core

## Goal

外部サービスを使わず、ActionRequestと固定Evaluation Contextに対して「どのApproval Flowが必要か」をpureかつ決定的に計算できる。

## Scope

- Action Definition resolution contract
- Standard Schema validation integration
- field namespace / derived attributes
- minor-unit金額規約
- Condition evaluator
- semantic validator
- ApprovalPolicyBinding selector
- PolicyBindingResolver
- first-match-per-policy evaluator
- ApprovalPlanCompiler
- TypeScript Builder
- explicit `none`
- root `defaultFlowConstraints`

## Expected behavior / Acceptance Scenarios

### AC-M1-001 — first matching ruleのみ採用する

**Given** 同一Policyに複数Ruleがあり2件がmatchする  
**When** Policyを評価する  
**Then** 配列順で最初のRuleだけが採用される。

### AC-M1-002 — 複数Policyを決定的に合成する

**Given** 2つのBindingが同じActionへ適用され、`compositionOrder=100/200`  
**When** 各Policyがmanager / security Flowを返す  
**Then** compiled Flowは `manager -> security` のserialとなる。  
同じ入力では常に同じ順序になる。

### AC-M1-003 — `none`は他Policyの承認を打ち消さない

**Given** Policy A=`none`、Policy B=`manager approval`  
**Then** 最終Flowはmanager approvalとなる。  
全Policyが`none`なら最終Flowは`none`になる。

### AC-M1-004 — Condition evaluation errorはfail closed

**Given** Policyが`action.input.amountMinor >= 500000`を参照する  
**When** field missing、型不一致、unsafe integer等で正常評価できない  
**Then** `not_matched`へ黙って変換せずPolicy evaluation errorとなり、実行可能な`none` Flowを返さない。

### AC-M1-005 — 金額境界を整数で正確に評価する

499,999 / 500,000 / 500,001を境界testし、currencyを無視した異通貨比較を行わない。

### AC-M1-006 — Binding selectorで適用Policyを限定する

`actionType`, `resourceType`, optional conditionに一致するBindingだけを選ぶ。disabled bindingは選ばない。

### AC-M1-007 — semantic validationで危険なPolicyを拒否する

少なくとも以下をpublish前にrejectする。

- duplicate local step key
- invalid quorum
- `always` ruleが末尾でない
- unknown field root
- unsupported type comparison
- unresolved strategyの不正形
- candidate completion / resolutionの禁止組合せ
- expiryの不正値

### AC-M1-008 — BuilderとJSON ASTが同値

Builderで生成したASTと直接JSONで記述した同じPolicyが、同じcanonical ASTになる。

## Suggested unit tests

```ts
describe("PolicyEvaluator", () => {
  it("AC-M1-001 selects only the first matching rule", ...);
  it("AC-M1-003 does not let none cancel another approval", ...);
});

describe("ConditionEvaluator", () => {
  it("AC-M1-004 fails closed for a missing field", ...);
  it("AC-M1-005 handles exact minor-unit boundaries", ...);
});

describe("ApprovalPlanCompiler", () => {
  it("AC-M1-002 composes flows by binding order", ...);
});
```

## Definition of Done

- AC-M1-001〜008がunit/type testsとしてgreen
- evaluator/compilerはDB・HTTP・clockの暗黙参照を持たない
- property/golden testで同一入力のdeterminismを確認
- invalid Policyをruntimeまで持ち込まずpublish validationで拒否できる
- ticket `priority=critical -> manager` のdemoをpure testだけで表現できる

---

# M2 — Materialization, Snapshots & Persistence Primitives

## Goal

Policy評価結果を、数日後・数か月後でも同じ意味で再現可能なimmutable Materialized Approval Planへ固定できる。

## Scope

- EvaluationSnapshot
- ActionDefinition/Schema version snapshot
- PolicyBinding / Policy Version snapshot
- Materialized Flow
- MaterializedStepId
- canonical JSON: RFC 8785 + SHA-256
- `actionFingerprint`
- `evaluationSnapshotChecksum`
- `approvalPlanChecksum`
- `approvalBindingFingerprint`
- snapshot approver cohort representation
- D1 schema/migrationsの最小実装
- immutable plan repository / checksum verification

## Acceptance Scenarios

### AC-M2-001 — MaterializedStepIdはPolicy-local key衝突を回避する

Policy AとBが両方`stepKey="manager"`を持っても、異なるMaterializedStepIdを生成する。再materialize時に同じbinding/version/pathなら同じIDになる。

### AC-M2-002 — Action identityとevaluation environmentを分離する

organization thresholdだけが変わった場合、Action自体のidentityを表す`actionFingerprint`と、評価環境を表す`evaluationSnapshotChecksum`を別々に追跡できる。

### AC-M2-003 — 承認対象Action変更でbindingが変わる

resource、approval-sensitive input、authority/delegation等が変化した新Actionは、以前の`approvalBindingFingerprint`を再利用できない。

### AC-M2-004 — Policy変更後も既存Planは変化しない

ActionRequest開始後にPolicy v2をpublishしても、既存ActionRequestは固定済みPolicy v1 / Flowを使用する。

### AC-M2-005 — canonical checksumが実装差で変わらない

key order違い等に対してRFC 8785 + SHA-256のgolden fixtureが一致する。

### AC-M2-006 — Plan load時にchecksum mismatchを検出する

Workflowへ渡された`approvalPlanChecksum`とD1からloadしたimmutable planが一致しなければ実行を開始しない。

### AC-M2-007 — snapshot cohortを固定できる

`resolution=snapshot`かつ`all/quorum`のStepでは、activation時candidate集合をcohortとして固定し、その後のorganization変更で集合が変化しない。

## Suggested tests

```text
packages/approval-core/src/materializer.test.ts
packages/approval-core/src/materialized-step-id.test.ts
packages/approval-core/src/fingerprint.test.ts
packages/approval-d1/src/plan-repository.integration.test.ts
tests/golden/canonical-json.test.ts
```

## Definition of Done

- AC-M2-001〜007がgreen
- 同じfixtureから生成したchecksumのgolden fileをCIで固定
- Materialized Planを保存・再読込してsemantic identityが変わらない
- mutable runtime stateとimmutable plan inputがRepository上で分離される
- Workflowをまだ導入しなくてもplan生成/保存をdemoできる

---

# M3 — Authorization & Approver Resolution

## Goal

「このActionを要求できるか」と「このStepを誰が承認できるか」をApproval Flow semanticsから分離し、OpenFGA等のAdapterを通して安全に判定できる。

## Scope

- `ActionAuthorizer` Port / evidence / allow-deny-error
- direct authority
- delegated authority / attenuation
- `ApproverResolver` Port
- principal / principal_relation / relation / direct user resolution
- OpenFGA ActionAuthorizer Adapter
- OpenFGA ApproverResolver Adapter
- `Check` / `ListUsers`
- candidate completeness
- dynamic candidate projection
- consistency policy
- organization/FGA projectionの最小経路

## Acceptance Scenarios

### AC-M3-001 — Authorization denyはApprovalへ進まない

**Given** actor/authorityがActionを実行する権限を持たない  
**When** ActionRequestをauthorizeする  
**Then** denyとなり、Approval Policy評価・Task生成・Executeを行わない。

### AC-M3-002 — caller approvalは権限昇格にならない

AI Agentにauthorityがない場合、callerがapproveしてもActionは実行可能にならない。

### AC-M3-003 — callerのmanagerをresolveできる

`principal_relation(caller, "manager")`がOpenFGA上のmanager relationからuserを解決する。

### AC-M3-004 — zero candidateはfail closed

manager/resource owner等が0人の場合、Stepをskipせずunresolvedとしてdenyする（明示fallbackがある場合を除く）。

### AC-M3-005 — candidate completenessを要求できる

`all/quorum`でListUsersがincompleteな場合、欠落候補を無視してFlowを開始しない。

### AC-M3-006 — dynamic approverはdecision時に再Checkする

activation時にcandidateだったAliceがdecision前にrelationから外れた場合、Inbox projectionに残っていてもAliceのDecisionを受理しない。

### AC-M3-007 — consistency policyを用途で分ける

- Inbox candidate projection: minimize latency / eventual consistency可
- Decision acceptance: higher consistency
- Action execution reauthorization: higher consistency

### AC-M3-008 — Delegationはattenuationのみ

Agent Bへ再委譲しても、元principalまたは上流grantにないpermission/resource scopeを獲得できない。

### AC-M3-009 — creator / caller / authority / delegatorを混同しない

異なるPrincipalとしてfixtureを構成し、それぞれをPolicy/Authorizationで独立して参照できる。

## Suggested tests

```text
packages/approval-core/src/action-authorizer.contract.test.ts
packages/approval-core/src/approver-resolver.contract.test.ts
packages/approval-fga/src/action-authorizer.integration.test.ts
packages/approval-fga/src/approver-resolver.integration.test.ts
packages/approval-fga/src/delegation.integration.test.ts
```

## Definition of Done

- AC-M3-001〜009がgreen
- OpenFGA test store/model testsをCIで実行
- `Check`と`ListUsers`のfailure/incompleteを明示的に扱う
- Authorization provider errorをdenyと区別できる
- dynamic/snapshot双方のcandidate semanticsをintegration testで証明

---

# M4 — Durable Approval Runtime

## Goal

Human decisionを待つ時間を跨いでも、Materialized Flowを正しいsemanticsでdurableに実行・再開できる。

## Scope

- `DurableRuntime` Port
- InMemoryRuntime
- Flow Interpreter
- Generic ActionWorkflow
- `none`, `serial`, `parallel(all|any|quorum)`, approval node
- Decision event handling
- candidateCompletion
- self approval / distinctApprovers
- expiry
- interpreterSemanticsVersion
- D1 task/read projection
- workflow params `{ actionRequestId, approvalPlanChecksum }`

## Acceptance Scenarios

### AC-M4-001 — serialは前Step完了前に次Stepをactivateしない

Managerがpending中はFinance taskが存在しない。Manager approve後に初めてFinanceをactivateする。

### AC-M4-002 — serial rejectで後続を生成しない

Manager reject時にAction全体をrejectし、Finance taskを生成しない。

### AC-M4-003 — parallel/allは1 rejectで即reject

他childがpendingでも全体をterminal rejectできる。

### AC-M4-004 — parallel/anyは1 approveで即approve

全child reject時のみrejectする。

### AC-M4-005 — quorumは到達不能を早期判定する

3候補中2承認必要で2人rejectした時点で、残り1人のDecisionを待たずrejectする。

### AC-M4-006 — distinctApproversをFlow全体で守る

前Stepを完了したuserを、後続Stepのcandidateとして再利用できない設定を保証する。

### AC-M4-007 — self approval policyを守る

business approvalではauthority principal自身のapprovalを拒否でき、execution consentでは明示的に許可できる。

### AC-M4-008 — expiryでterminal stateへ遷移する

期限までDecisionがなければStep/Actionを`expired`にする。auto approveはしない。

### AC-M4-009 — retry/replayでsemanticsが変わらない

同じdecision event、fixed timestamps、MaterializedStepIdを使用し、Workflow再開で二重taskや異なる結果を生成しない。

### AC-M4-010 — interpreter versionを固定する

新versionのruntimeをdeployしても、旧`interpreterSemanticsVersion`のPlanは対応する旧semanticsで完走できる。

### AC-M4-011 — invalid/duplicate decisionを安全に扱う

対象外user、既にclosedなtask、同じidempotency keyの再送でFlowを二重進行させない。

## Suggested tests

```text
packages/approval-core/src/interpreter/*.test.ts
packages/approval-runtime-memory/src/runtime.test.ts
packages/approval-runtime-cloudflare/src/workflow.integration.test.ts
tests/acceptance/m4-durable-runtime.test.ts
```

Cloudflare integrationでは少なくとも、instance resume、`step.do` retry、event buffering、explicit timeout、plan checksum load、payload limit付近を検証する。

## Definition of Done

- AC-M4-001〜011がInMemoryRuntimeでgreen
- critical scenariosがCloudflare Workflows integrationでもgreen
- runtime retryで二重Decision/Taskを作らない
- Workflow stateをD1だけで再実装していない
- serial/parallel/quorumを実際のhuman waitを模したintegration testでdemoできる

---

# M5 — Safe Action Execution

## Goal

Approval完了後またはApproval不要時に、最新authorityを再確認し、外部side effectを可能な限り重複なく安全に実行できる。

## Scope

- `ActionExecutor` contract
- idempotency key
- executor registry/resolution
- pre-execution Re-Authorization
- Authorization deny/errorのterminal semantics
- retriable / non-retriable execution failure
- `ActionResult`
- execution/audit projection
- approval binding validation

## Acceptance Scenarios

### AC-M5-001 — approval不要でも実行直前にAuthorizationする

Flow=`none`だからといって初回Authorization結果を無期限に信頼しない。実行直前のcheckがdenyならexecuteしない。

### AC-M5-002 — 承認待ち中の権限失効を拒否する

Approvalはすべて完了していても、authorityがrevokedされていれば`authorization_revoked`となりActionExecutorを呼ばない。

### AC-M5-003 — Authorization outageとdenyを区別する

provider errorはretry可能な`authorization_check_failed`として扱い、明示denyをblind retryしない。

### AC-M5-004 — Executorへ安定したidempotency keyを渡す

同一ActionRequestのretryでは同じkeyを渡す。外部targetがkeyを尊重する場合、side effectは1回だけ観測される。

### AC-M5-005 — retriable execution failureをretryする

一時的timeout等はruntime retry対象とし、成功後の再実行で同じidempotency contractを使う。

### AC-M5-006 — non-retriable failureをterminal化する

business validation failure等は`execution_failed`として終了し、無限retryしない。

### AC-M5-007 — Approval対象変更を検出する

Decisionにbindされたfingerprint/checksumと実行対象が一致しなければ、以前のApprovalを利用してexecuteしない。

### AC-M5-008 — exactly-onceを偽装しない

外部systemがidempotencyを提供しないExecutorについて、保証レベルをcontract上明示し、local recordだけでexactly-onceを主張しない。

## Suggested tests

```text
packages/approval-core/src/action-executor.contract.test.ts
packages/approval-runtime-cloudflare/src/execution.integration.test.ts
tests/acceptance/m5-action-execution.test.ts
```

## Definition of Done

- AC-M5-001〜008がgreen
- side-effect mock/test serverでretry/idempotencyを検証
- `authorization_revoked`, `authorization_check_failed`, `execution_failed`, `executed`を区別して観測可能
- Approvalあり/なし双方が同じActionExecutor contractへ収束

---

# M6 — Public API & MCP Integration

## Goal

利用ApplicationとAI Agentが、Approval実装詳細を知らずにActionRequestを送るだけで、deny / immediate execute / pending approval / final resultまで利用できる。

## Scope

- OpenAPI contract実装
- `POST /action-requests`統一入口
- trusted actor/caller/authority context enrichment
- GET ActionRequest
- approval task inbox
- Decision command / command status
- cancel
- simulator
- idempotency headers
- RFC 9457-style Problem Details contract（OpenAPI定義に従う）
- MCP `tools/call` Adapter
- MCP Tasks projection/fallback

## Acceptance Scenarios

### AC-M6-001 — callerはApproval必要性を事前判断しない

同じ`POST /action-requests`で、Policy結果に応じてimmediate executeまたは`pending_approval`になる。

### AC-M6-002 — actor/authorityをrequest bodyから偽装できない

認証contextやtrusted delegation referenceと矛盾するprincipalを任意指定するbody fieldを受け付けない。

### AC-M6-003 — authorization denyは403として返す

Approval Taskは生成されない。監査用ActionRequest IDを割り当てる場合はProblem Detailsから追跡可能にする。

### AC-M6-004 — Decision APIはcommand acceptanceとapplicationを分離する

Decision POSTは202 + command IDを返し、`GET /approval-commands/:id`で`pending/applied/rejected/failed`を確認できる。

### AC-M6-005 — read-after-writeの結果整合を契約化する

Decision POST直後にtask projectionが古くてもAPI contract違反としない。clientはcommand statusをsourceとして収束を確認できる。

### AC-M6-006 — Idempotency-Key再送は同一論理操作になる

同じoperation + payload + keyの再送でActionRequest/Decisionを二重生成しない。異なるpayloadで同じkeyを使った場合は409。

### AC-M6-007 — MCP tool callをActionRequestへ正規化する

MCPからのtool executionもHTTPと同じAuthorization/Approval/Executor pipelineへ入る。

### AC-M6-008 — MCP Tasks対応clientではpending approvalをTaskとして投影する

MCP Task自体をdomain truthにせず、内部ActionRequest/Workflow状態からprojectionする。

### AC-M6-009 — MCP Tasks非対応clientに定義済みfallbackを返す

silent hangや無承認executionを行わない。

### AC-M6-010 — Simulatorは副作用を起こさない

Authorization/適用Policy/Approval Planを説明できるがTask/Workflow/ActionExecutorを作成しない。

## Critical-path E2E suite

v1では最低限以下を固定suiteとして維持する。

1. Human + direct authority + no approval → executed
2. Human + manager approval → approve → executed
3. AI + direct/delegated authority + no approval → executed
4. AI + caller execution consent → approve → executed
5. AI + caller consent + caller manager → serial approvals → executed
6. AI + caller manager only → manager approval → executed
7. Ticket priority normal → immediate execute
8. Ticket priority critical → manager approval
9. production access → manager + security
10. quorum 2/3 → 2 approvalsでexecute
11. delegated request → delegation scope内のみexecute
12. approval待機中authority revoke → authorization_revoked
13. approval-sensitive input変更 → old approval再利用不可
14. Policy複数合成 → deterministic serial plan
15. unauthorized AI + human approval attempt → denyのまま

## Definition of Done

- AC-M6-001〜010がHTTP/MCP integrationでgreen
- critical-path E2E 15ケースがgreen
- OpenAPI implementationと実response schemaのcontract testがgreen
- Application側にapproval state machineを実装せずticket demoを完走できる

---

# M7 — Production Readiness & Governance

## Goal

「機能が動く」状態から、本番で運用・監査・障害対応できる状態へ移行する。

## Scope

- strict organization scope / multi-tenant tests
- meta-approval for Policy / Binding / Action Definition publish
- `admin.force_cancel`
- domain events / append-only audit
- outbox + queue delivery
- notification trigger semantics
- attachment integrity reference/hash
- retentionの最低限
- traces / logs / metrics
- SLI dashboard / alerts
- rate limit / approval spam mitigation
- operator runbook
- backup/migration validation

## Acceptance Scenarios

### AC-M7-001 — tenant boundaryを越えない

IDを推測して別organizationのActionRequest/Task/Policyを取得・更新できない。

### AC-M7-002 — Policy publish自体を承認対象にできる

`approval_policy.publish`を通常のActionRequestとしてauthorize/approve/executeできる。bootstrap pathは別途明示される。

### AC-M7-003 — force approveは提供せずforce cancelのみ提供する

`admin.force_cancel`は高権限Actionとして理由・actor・対象・時刻をauditし、post-review flagを残す。

### AC-M7-004 — Outboxはat-least-onceでも重複通知を抑制できる

consumer retryで同じdomain eventを複数回処理しても同じnotification keyを二重生成しない。

### AC-M7-005 — notificationはdomain eventから発火する

Step activation / Decision / reject / cancel / expire / execution completionの発火点が固定され、Workflow実装の偶発的なcallbackに依存しない。

### AC-M7-006 — 添付差替えでApprovalを再利用できない

attachment referenceのcontent hashがAction identityに含まれ、承認後の本文差替えを検出する。

### AC-M7-007 — observabilityで1 Actionをend-to-end追跡できる

`actionRequestId`をcorrelation rootとしてAPI/MCP → Workflow → D1 → FGA → Executor → Notificationを追跡できる。

### AC-M7-008 — 必須SLIを観測できる

最低限以下を取得できる。

- approval lead time / step dwell time
- reject / expire rate
- FGA Check/ListUsers latency/error
- Workflow retry/failure
- ActionExecutor failure
- outbox backlog/failure

### AC-M7-009 — 機微情報をログへ無制限に出さない

Action input、Decision comment、attachment content等がdefault application logへそのまま出力されない。

### AC-M7-010 — stuck requestから運用復旧できる

runbookに従い、原因確認 → force cancel → audit確認まで実施できる。

## Definition of Done

- AC-M7-001〜010がgreenまたはrunbook drillで実証済み
- security / tenant isolation integration suiteがgreen
- operator dashboardと最低限のalertを用意
- production migration / rollback procedureが文書化される
- force cancel drillをstagingで完了
- critical-path E2E suiteがproduction-equivalent environmentでgreen

---

# 4. Cross-milestone acceptance rules

## 4.1 Security invariantsは常にregression testする

以下は一度実装した後、すべてのMilestoneでgreenを維持する。

- Authorization denyはApprovalで覆せない
- Approvalはauthorityを増やさない
- Delegationはattenuationのみ
- 実行前Re-Authorization
- approval-sensitive Action変更でDecision再利用不可
- unresolved approverはfail closed
- self approval / SoD制約
- tenant boundary

## 4.2 Determinism fixtures

以下はgolden testを持つ。

- canonical JSON
- actionFingerprint
- evaluationSnapshotChecksum
- approvalPlanChecksum
- approvalBindingFingerprint
- MaterializedStepId
- Policy composition order

意図したbreaking semantics変更時のみfixtureを更新し、PRで差分理由を説明する。

## 4.3 Failure-pathをhappy pathと同じ優先度で実装する

各Milestoneで少なくとも以下を検討する。

```text
allow / success
deny / business rejection
invalid input
provider unavailable
retry
idempotent replay
concurrent/duplicate request
stale projection
revoked relationship/authority
```

# 5. PR / Issue分割ルール

GitHub Issueは可能ならAcceptance Scenarioまたはまとまったscenario群を完了単位にする。

良い例:

```text
[M1] Fail-closed Condition evaluation (AC-M1-004, AC-M1-005)
[M3] Dynamic approver final Check (AC-M3-006, AC-M3-007)
[M4] Parallel quorum runtime semantics (AC-M4-003..005)
```

避ける例:

```text
Implement evaluator
Implement FGA
Implement workflow
```

後者は「何をもって完成か」が分からないため、必ずAcceptance IDと期待するobservable behaviorをIssue本文へ含める。

# 6. Milestone completion review

各Milestone終了時にはコード完成ではなく、次のchecklistでreviewする。

- [ ] MilestoneのAcceptance Scenarioがすべてgreen
- [ ] 前Milestoneのsuiteもすべてgreen
- [ ] failure / retry / replay pathが含まれている
- [ ] domain invariantに新しい例外を導入していない
- [ ] public contract変更がOpenAPI / detailed specへ反映されている
- [ ] 新しいarchitecture decisionがDesign Docまたは詳細仕様へ反映されている
- [ ] demo scenarioを第三者が再現できる
- [ ] 次Milestoneが未完成実装へ暗黙依存していない

# 7. v1 Release Definition of Done

v1はM7まで単に実装済みであることではなく、次を満たした時点でrelease可能とする。

1. M0〜M7の必須Acceptance Scenarioがgreen。
2. Critical-path E2E 15ケースがgreen。
3. Authorization / Approval / Delegation / Re-Authorizationのsecurity invariantsにregression testがある。
4. OpenAPI contract testがgreen。
5. OpenFGA integration、D1 integration、Cloudflare Workflow integrationがCIまたはrelease pipelineで実行可能。
6. Policy/Flow/checksumのgolden testが固定されている。
7. stagingでhuman approvalを含むend-to-end demoが実行できる。
8. force cancel、dependency outage、retryを含む最低限のoperational drillを実施済み。
9. Design Doc、詳細仕様、Implementation Plan、OpenAPIが実装と矛盾していない。
10. Application側にapproval専用state machineを持たず、少なくとも1つの実Application use caseを統合できている。

このDefinition of Doneを満たさない機能は、コードが存在していてもv1として「完成」とは扱わない。
