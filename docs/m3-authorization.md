# M3 Authorization / Approver Resolution 実装ノート

M3では、Actionを実行する権限の判定と、人間によるApprovalの判定を明確に分離する。

## Authorization Decision

`ActionAuthorizer`はAuthority PrincipalがActionを要求可能かを判定するPortである。`allow` / `deny`は正常なドメイン結果として扱い、OpenFGA等のprovider障害だけをByethrowのFailureとして返す。

ApprovalによってAuthorization denyをallowへ変換してはならない。Action実行直前には`higher_consistency`で再認可する。

## Effective Authority / Delegation Attenuation

Delegation chainはAuthority PrincipalからActorまで連続している必要がある。各Delegation Hopは任意のscopeを持ち、Action type、Resource type、Resource ID、有効期間を制限できる。

実効scopeは全Hopの積集合として評価する。したがってchainを延長しても権限は拡大しない。scope違反や不連続なchainはOpenFGAを呼ぶ前にdenyする。

## Approver Resolver

`ApproverResolver`はMaterialized Approval Stepのtargetについて、Userが現在承認可能かを`check`し、候補User集合を`list`するPortである。

- direct user targetはcoreで比較する。
- relation / principal_relation targetはOpenFGA Adapterへ委譲する。
- 0 candidateは明示fallbackがなければfail closedとする。
- snapshot / all / quorumで完全な候補集合が必要な場合、`complete=false`を受理しない。

## Dynamic Candidate Projection

Dynamic StepでもInbox検索のためactivation/refresh時に候補Userをprojectionしてよい。ただしprojectionはAuthorizationの正本ではない。

Decision受理直前にはprojectionの内容に関係なく、対象Userを`higher_consistency`で再Checkする。

D1の`approval_task_candidate_projections`はこの検索用projectionだけを保持し、候補集合をatomicに置換できる。

## Consistency Policy

| 用途                             | Consistency          |
| -------------------------------- | -------------------- |
| Inbox candidate projection       | `minimize_latency`   |
| Approval Decision受理直前        | `higher_consistency` |
| Action実行直前のRe-Authorization | `higher_consistency` |

## OpenFGA Adapter

`@app/approval-fga`はWeb標準の`fetch`でOpenFGA/Auth0 FGA REST APIへ接続する。`@openfga/sdk`には依存しない。

- Action authorization: `Check`
- Relation approver候補: `ListUsers`
- Decision時の候補再確認: `Check`
- Organization projectionの最小経路: tuple `Write`

ListUsersはserver-side deadline/max-resultsで打ち切られる可能性があり、HTTP responseだけから完全性を証明できない。そのためadapterの既定値は`complete=false`とし、bounded model等で外部から完全性を保証できる場合のみ明示的に`complete=true`を許可する。
