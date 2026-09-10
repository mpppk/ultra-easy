# **14\. 永続化モデル**

## **14.1 主要テーブル（補助テーブルは14.2.1）**

| Table | 目的 | 更新特性 |
| :---- | :---- | :---- |
| approval\_policies | Policy identityとcurrentVersion | 更新可 |
| approval\_policy\_drafts | 編集中Draft | 更新可 |
| approval\_policy\_versions | Published definition | INSERT only |
| action\_requests | ActionRequest本体 | 受付後core fieldsは原則immutable |
| action\_results | 完了済みWorkflowの最終結果snapshot | projection更新/確定 |
| approval\_tasks | pending approvalの検索用projection | projection更新/確定 |
| action\_events | append-onlyのdomain/audit event | INSERT only相当 |
| approval\_decisions | 承認/却下履歴 | append-only |
| outbox\_events | 通知/FGA同期等 | append \+ delivery status |

## **14.2 主要カラム**

| Entity | 必須カラム（抜粋） |
| :---- | :---- |
| approval\_policy\_versions | id, policy\_id, version, schema\_version, definition TEXT(JSON), checksum, created\_by, created\_at |
| action\_requests | id, organization\_id, actor\_type, actor\_id, authority\_principal\_type, authority\_principal\_id, delegation\_chain TEXT(JSON), action\_type, input\_schema\_key, input\_schema\_version, resource\_type, resource\_id, input TEXT(JSON), origin\_type, caller\_type, caller\_id, client\_id, agent\_run\_id, action\_fingerprint, evaluation\_snapshot TEXT(JSON), evaluation\_snapshot\_checksum, policy\_binding\_snapshots TEXT(JSON), materialized\_plan TEXT(JSON), approval\_plan\_checksum, interpreter\_semantics\_version, workflow\_instance\_id, status, submitted\_at, created\_at |
| action\_results | organization\_id, action\_request\_id, workflow\_instance\_id, status, result TEXT(JSON), completed\_at |
| approval\_tasks | id, organization\_id, action\_request\_id, workflow\_instance\_id, materialized\_step\_id, policy\_binding\_id, policy\_key, policy\_version, step\_key, purpose, approver\_kind, target\_object, target\_relation, target\_user\_id, candidate\_cohort\_id, resolution, expires\_at, activated\_at, closed\_at |
| approval\_decisions | id, organization\_id, action\_request\_id, workflow\_instance\_id, materialized\_step\_id, step\_key, actor\_id, decision, client\_command\_id, approval\_binding\_fingerprint, comment, created\_at |

### **14.2.1 Policy Binding / Action Event / Approval Task Projection** **action\_definitionsはAction identity/currentVersionを管理し、action\_definition\_versionsはPublished Action Definition（action\_type, version, input\_schema\_key/version, executor\_key, normalization\_version, derived\_attribute\_catalog, checksum, created\_by, created\_at）をINSERT-onlyで保持する。approval\_policy\_bindingsはtenant内でPolicyの適用selector・compositionOrder・enabled状態を管理する。Binding自体は更新可能だが、ActionRequest受付時には適用Binding内容と参照Policy Versionをpolicy\_binding\_snapshotsへ不変snapshotとして固定する。Policy/Bindingのpublish・更新は18章のmeta-approval対象とする。** **action\_eventsにはorganization\_id、workflow\_instance\_id、event\_key、action\_request\_id、materialized\_step\_id、step\_key、type、payload TEXT(JSON)、created\_atを持たせ、(organization\_id, workflow\_instance\_id, event\_key)を一意にする。outbox\_eventsはid, organization\_id, aggregate\_id, type, payload TEXT(JSON), status, attempts, available\_at, created\_atを基本カラムとする。approval\_tasksは一覧検索用projectionであり、Cloudflare Workflowsの実行状態を復元する用途には使用しない。approval\_task\_candidates(task\_id, organization\_id, user\_id, resolved\_at, source\_revision)をinbox検索用projectionとして持つ。snapshot approverでは完全なcandidate cohortを固定し、dynamic approverでは候補projectionを検索インデックスとしてのみ使い、Decision時のFGA Checkを正本とする。ListUsersの完全性を保証できない場合、snapshot/all/quorumはmaterialization errorとする。dynamic inboxでは候補projectionが不完全になり得るため、task直接参照時のcanApprove Check経路を必ず提供する。** **14.3 D1の責務と非責務**

D1はWorkflowのcanonical execution stateを保持しない。実行位置、待機event、retry、checkpointはCloudflare WorkflowsがSource of Truthである。action\_resultsは完了後の最終snapshotであり、実行中の排他制御や状態遷移には利用しない。D1側で必要な競合対策はprojection/event書き込みのidempotencyと一意制約で行う。
