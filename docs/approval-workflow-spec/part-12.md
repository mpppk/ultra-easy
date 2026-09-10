# **12. Authorization / ApproverResolver / Auth0 FGA連携 — Part 2**

## **12.2 FGA Adapter**

v1の標準AdapterはAuth0 FGAとする。Cloudflare WorkersからはWeb標準のfetchを使ってAuth0 FGA REST APIへ接続し、OpenFGA SDKを必須依存にしない。FGAは①authority principal/actorがresourceに対してaction可能かのresource authorization、②relation-based approverの候補解決と最終Checkの双方に利用できる。候補一覧・inbox用ListUsersは通常\`MINIMIZE\_LATENCY\`相当を許容するが、実際のDecision受理直前のApprover CheckとActionExecutor直前のRe-Authorizationは\`HIGHER\_CONSISTENCY\`相当を既定とする。direct user targetはMaterialized ActionRequestに固定されたuserIdとの一致をcoreで検証する。ListUsersには実装ごとのdeadline/max-results制約があるため、ApproverResolver.listは候補集合の完全性を\`complete\`で返し、snapshot/all/quorum等で完全集合が必要なのに完全性を保証できない場合はfail closedとする。

**重要**  ListUsersの結果を承認可否の最終判定として信用しない。操作時点のactorに対してCheckを行い、その結果とWorkflow制約（active step、自己承認禁止等）をANDする。

## **12.3 dynamic / snapshot**

| resolution | 保存内容 | 組織変更の影響 | 用途 |
| :---- | :---- | :---- | :---- |
| dynamic | object \+ relation | 承認時点の関係に追従 | 標準。異動・役職変更に追従 |
| snapshot | object \+ relation \+ resolved userIds | 提出後は原則固定 | 法的/業務上、申請時点担当者を固定したい場合 |

v1のrelation-based approverのデフォルトはdynamicとする。Step単位でsnapshotを明示可能にする。principal(caller/authority/delegator)はActionRequest identityへbindされるため実質snapshotである。candidateCompletion=all/quorumでは候補cohort確定が必要なためsnapshotを必須とする。dynamic Stepでもinbox検索用projectionを作るためactivation時にListUsersを実行して\`approval\_task\_candidates\`へ候補を投影してよいが、このprojectionはauthorizationの正本ではない。Decision受理時は必ずFGA Checkを再実行する。候補projectionはlazy refreshまたは組織/FGA同期イベントを契機に再計算可能とする。

# **13\. 組織マスタ・FGA同期・代理承認**

## **13.1 Source of Truth**

HRIS / Cloudflare D1 Organization DB  
        |  source of truth  
        v  
Transactional Outbox  
        |  
        v  
FGA Sync Worker  
        |  
        v  
Auth0 FGA (authorization projection)

FGAは組織CRUD、検索、帳票、履歴の正本にしない。組織変更はD1の原子的なbatch()内でOutboxを書き、Outbox DispatcherがCloudflare Queuesへ配送し、consumer WorkerがTupleへ反映する。

## **13.2 代表relation**

| Object | Relation | 意味 |
| :---- | :---- | :---- |
| org\_unit | member | 所属メンバー |
| org\_unit | manager | 当該組織のmanager |
| org\_unit | parent | 上位組織 |
| org\_unit | parent\_manager | 上位組織のmanager |
| organization | finance\_approver | 全社経理承認者 |
| organization | executive\_approver | 役員承認者 |
| org\_unit | delegated\_manager | 期間付き代理manager |

## **13.3 代理承認**

代理承認期間は業務DBにも保持し、FGAではconditional relationshipとして投影する。Check/ListUsers時にはcurrent\_time等のcontextを渡す。effective\_manager \= manager OR delegated\_managerのようなrelationを利用できる。
