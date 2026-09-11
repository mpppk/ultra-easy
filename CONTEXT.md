# 承認ワークフロー基盤

アプリケーション上で意図された操作をAction Requestとして表現し、認可し、人間による承認が必要かを判定したうえで、最終的に実行するための基盤。このコンテキストでは、人間・Service・AI Agentから開始される操作に共通するドメイン言語を定義する。

## 用語

**Action Request（アクション要求）**:
1つのActionを実行するための要求。誰が直接要求したか、誰の権限を根拠とするか、どこから要求されたかを保持する。
_避ける表現_: Approval Request、Workflow Request

**Principal（主体）**:
User、Agent、Serviceのいずれかとしてドメインに参加できるidentity。
_避ける表現_: identity一般を指す場合のActor

**Actor（実行要求主体）**:
基盤の境界でAction Requestを直接開始したPrincipal。Actorと、そのActionで使用する権限のPrincipalは同一とは限らない。
_避ける表現_: 権限主体を意味するRequester

**Authority Principal（権限主体）**:
Action Requestの実行権限の根拠となるPrincipal。Approvalによって、Authority Principalが元々持たない権限を付与してはならない。
_避ける表現_: Actor、Requester

**Delegation（委任）**:
あるPrincipalが持つ権限の一部を、別のPrincipalが代理で利用できるようにする明示的な委任。委任chainを延長しても、利用可能な権限範囲が拡大してはならない。
_避ける表現_: Impersonation

**Action（操作）**:
操作種別、対象Resource、操作に必要なinputから構成される型付きの操作。
_避ける表現_: Approval、Workflow

**Resource（対象リソース）**:
Actionの対象となるドメインobject。resource typeとresource IDで識別する。
_避ける表現_: Actionの対象を指す場合のObject

**Origin（起点）**:
Action Requestが基盤へ入ってきた信頼済みのchannelまたは実行context。UI、API、MCP、system automationなどを表す。
_避ける表現_: Actor、Caller

**Caller（呼び出し主体）**:
AgentまたはServiceを介したAction Requestを発生させた、直近の信頼済みPrincipal。必要な場合にのみ保持し、Callerだからといって自動的にAuthority Principalにはならない。
_避ける表現_: Creator、Owner

**Authorization（認可）**:
現在のAuthority PrincipalとDelegationの範囲で、そのAction Requestを先へ進めてよいかを判定すること。AuthorizationはApprovalとは独立して評価する。
_避ける表現_: Approval

**Approval（承認）**:
すでにAuthorizationを通過したAction Requestを先へ進めるために必要となる人間の判断。Approvalによって権限を新規作成したり、昇格させたりしてはならない。
_避ける表現_: Authorization、Permission

**Approval Policy（承認ポリシー）**:
認可済みAction RequestとEvaluation Contextから、必要なApproval Flowを決定するversion付きのrule set。
_避ける表現_: Workflow Definition

**Policy Binding（ポリシー適用設定）**:
Approval PolicyをどのAction Requestへ適用するかを決定するルール。action/resource selectorやcomposition orderを含む。
_避ける表現_: Policy Scope

**Rule（ルール）**:
Approval Policy内のConditionと、その条件に一致した場合のFlowの組。Ruleには順序があり、Policyは最初に一致したRuleを採用する。
_避ける表現_: Policy

**Condition（条件）**:
許可されたfield namespaceを参照し、RuleまたはPolicy Bindingを適用するかを判定するためのシリアライズ可能なpredicate。
_避ける表現_: Callback、Script

**Flow（承認フロー）**:
必要なApproval Stepと、それらのserial/parallelな組み合わせを表すシリアライズ可能な構造。
_避ける表現_: Policyで定義された承認構造を指す場合のWorkflow

**No Approval（承認不要）**:
そのPolicyでは追加の人間承認を要求しないことを明示するFlow結果。適用Policyが存在しないこと、評価error、Authorization denyとは区別する。
_避ける表現_: Missing Flow

**Approval Step（承認ステップ）**:
Flow内の1つの承認要件。誰が承認可能か、候補者の完了条件、自己承認制約などを持つ。
_避ける表現_: Policy定義を指す場合のTask

**Approver Expression（承認者式）**:
Approval Stepを誰が承認可能かを表すシリアライズ可能な記述。事前解決済みの具体的な候補者一覧ではなく、Principal、relation、または明示的なUser参照として表現する。
_避ける表現_: Approver List

**Evaluation Snapshot（評価スナップショット）**:
Approval Policyを評価した時点の、Actionそのもの以外の固定context。Actor、Authority、Delegation、Origin、Organization settings、derived attributes、評価時刻などを保持し、後から組織情報等が変化しても当時の評価環境を再現できるようにする。
_避ける表現_: Current Context、Live Context

**Materialized Approval Plan（具体化済み承認計画）**:
Policy Bindingと固定済みPolicy Versionを評価した結果を、実行時にそのまま解釈できる形へ固定したimmutableな承認計画。Materialized Flow、各MaterializedStepId、Policy Binding snapshot、interpreter semantics versionを含む。
_避ける表現_: Policy Definition、Mutable Workflow State

**Materialized Approval Step（具体化済み承認ステップ）**:
Approval StepのApprover Expressionや参照値をEvaluation Snapshotに対して解決し、実行時の承認targetと出所を固定したstep。
_避ける表現_: Approval Task

**MaterializedStepId（具体化済みステップID）**:
Materialized Approval Stepを一意に識別するID。Policy-localなStep keyとは別物であり、Policy Binding ID、Policy Version、Flow pathから決定的に生成する。
_避ける表現_: Step Key、Task ID

**Snapshot Approver Cohort（固定承認候補集合）**:
`resolution=snapshot`のApproval Stepで、activation時点に完全性を確認したうえで固定する承認候補User集合。固定後のOrganization変更では内容を変えない。
_避ける表現_: Dynamic Approver List

**Action Fingerprint（Actionフィンガープリント）**:
正規化済みAction type、Resource、input、Action Definition Versionから生成するchecksum。Organization settingsやPolicy情報は含めない。
_避ける表現_: Approval Plan Checksum

**Evaluation Snapshot Checksum（評価スナップショットチェックサム）**:
Evaluation Snapshotのcanonical JSONから生成するchecksum。Action Fingerprintとは独立して、Policy評価に利用した非Action contextのidentityを表す。
_避ける表現_: Action Fingerprint

**Approval Plan Checksum（承認計画チェックサム）**:
固定済みPolicy Binding/Policy Version、Materialized Flow、MaterializedStepId、interpreter semantics version等から生成するchecksum。
_避ける表現_: Action Fingerprint

**Approval Binding Fingerprint（承認バインディングフィンガープリント）**:
Action Fingerprint、Evaluation Snapshot Checksum、Approval Plan Checksumの3値を組み合わせて生成するfingerprint。既存のDecisionを新しいAction Requestへ再利用できるかを判断する境界となる。
_避ける表現_: 単一のApproval Plan Checksum

**Decision（承認判断）**:
Approval Stepに対して提出されるimmutableな判断結果。approveまたはrejectなどを表す。
_避ける表現_: Permission

## 識別子の型安全性

ドメイン上で意味が異なる識別子は、実行時には同じ文字列であってもTypeScript上では別のbranded typeとして扱う。たとえば`UserId`、`AgentId`、`ResourceId`、`OrganizationId`、`DelegationGrantId`、`ApprovalPolicyKey`、`ApprovalPolicyBindingId`は相互に代入できない。

これにより、`UserId`を誤って`ResourceId`へ渡す、`ApprovalPolicyKey`を`ApprovalPolicyBindingId`として保存するといった取り違えをcompile-time errorとして検出する。

brandはTypeScript上だけの情報であり、JSONやDB上の表現には追加fieldを持たせない。API、DB、JSON等の外部境界から読み込んだ値は単なる`string`として信頼せず、validationを通過した時点で対応するbranded typeへ変換する。
