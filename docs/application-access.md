# 外部アプリケーションからのアクセスと代理実行（#193）

Status: Accepted（2026-09-28）/ Parent: #191（Workflow Engine Phase 2）

## Context

外部アプリケーション（最初の利用者は `apps/knowledge`）は、ultra-easy の公開APIを次の3種類の文脈で呼ぶ。

| 文脈                   | 例（`UltraEasyClient`）                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ユーザー操作の書き込み | `startAction` / `cancelAction` / `submitHumanInput` / `decideApproval` / `grantSpaceRole` / `proposePolicyBinding` |
| ユーザー文脈の読み取り | `getRun` / `listRuns` / `spaceRoles` / `getApprovalTask`                                                           |
| ユーザー不在の処理     | 週次メンテナンス（`knowledge.maintain_space`）、seed                                                               |

現状:

- Knowledge と approval-api は同じ Auth0 tenant を使い、user の principal 写像（`user:<sub>`）も同じ。Knowledge は ID token（`openid profile email`）だけを取得し、AES-GCM で暗号化した session cookie（8時間）に principal を保存している。
- approval-api の `Auth0IdentityProvider` は user login token を `user`、client credentials token を `agent:<client_id>` に写像する。Approval decision は `authenticateUser` で user token に限定済み。
- `StagingTrustedContextProvider` は `delegationGrantId` 付きのリクエストを `delegation_not_supported` で拒否する。approval-core は Delegation chain の検証と scope attenuation を持つが、Delegation grant を発行・保存・失効する仕組み（同意UI、revoke）は無い。
- `ActionOrigin.clientId` は定義済みだが、公開APIでは設定していない。

## Decision

### 1. ユーザー操作は user access token で呼ぶ（direct）

外部アプリはログイン時に approval-api audience の access token を取得し、**ユーザー本人として**公開APIを呼ぶ。Delegation は使わない。

- Knowledge の authorize request に `audience=https://ultra-easy/approval-api` と、利用する API scope を追加する。token endpoint が返す access token を、既存の暗号化 session cookie に principal と一緒に保存する。
- session の有効期限は `min(session TTL, access token の exp)` とする。refresh token（`offline_access`）は要求せず、期限切れは再ログインで扱う（長期の secret を外部アプリに保存させない）。
- access token はサーバー側でだけ使い、ブラウザの JavaScript には渡さない。
- ultra-easy 側では actor = authority = user（`direct`）とし、`origin` に `{ type: "api", clientId: <token の azp> }` を記録する。audit から「誰が・どのアプリ経由で」を相関できる。
- Knowledge の Auth0 application（Regular Web App）を approval-api API への user access が可能なように設定する。

### 2. ユーザー不在の処理はアプリ自身の agent principal で実行する

- 外部アプリの M2M client（client credentials）を `agent:<client_id>` とし、**アプリ自身の権限**で実行する（actor = authority = agent、`direct`）。
- agent の権限は、対象 resource への relationship（例: `knowledge_space` の maintainer 相当）として付与する（#195）。ユーザーの権限を借りない。
- #200（Schedule trigger）が完成したら、スケジュール起動は ultra-easy 側の trigger へ移す。

### 3. Approval decision と Human Input の回答は user token に限る

- 外部アプリ経由の Approval decision は、**本人の user token によるものだけ**を許可する（現行の `authenticateUser` を維持）。agent token・委任による decision は拒否する。
- Human Input の回答も同じ規則で、担当者の user token のみ受け付ける（#197）。
- decision / 回答の audit には経由したアプリの `clientId` を残す。

### 4. アプリ単位の allowlist（client registry）を導入する

user access token はユーザーの全権限を持つため、アプリ単位の制限を ultra-easy 側で掛ける。

- token の `azp`（client ID）をキーに、アプリが使える **operation / action type / resource type** を登録する client registry を持つ。
- token 検証の後、Authorization の前に評価する。user token・agent token の両方に適用し、principal の権限との **積（狭める方向のみ）** になる。
- 未登録の client は 403 `client_not_registered`（fail-closed）。既存の first-party client（`ultra-easy-web`、`ultra-easy-agent`）は無制限として明示的に登録する。
- 登録内容は repository で管理する宣言的な設定から始める（#198 の登録経路と同じ方針）。変更は review を経る。

例（Knowledge）:

```text
client: <knowledge client id>
  operations:     action_request.* / approval_decision.submit / workflow_run.read / human_input.submit / ...
  actionTypes:    knowledge.*
  resourceTypes:  knowledge_page, knowledge_space
```

### API scope

新しい公開API（#194〜#199）は、operation ごとに Auth0 の API scope を割り当てる（既存: `read:action-requests` / `write:action-requests`）。scope 名は各 issue で決め、`PUBLIC_API_OPERATION_SCOPES` と `docs/runbooks/production-api.md` に追記する。外部アプリは必要な scope だけを要求する。

## Consequences

- ultra-easy 側に新しい domain 概念は増えない（direct 実行のまま）。self-approval 制約・distinct approver は本人の token なのでそのまま効く。
- `delegationGrantId` 付きリクエストは引き続き `delegation_not_supported` で拒否する。
- 外部アプリは access token を暗号化して保存する責務を持つ。token は取り消せないため、有効期限を session と揃えて短く保つ。
- ユーザー不在の処理はアプリの権限でしか動かないため、「ユーザーの権限で夜間に実行する」ことはできない（必要になったら下記 B を再検討する）。

## Alternatives considered

- **B. Service principal + Delegation grant**: Knowledge を service principal とし、ユーザーからの委任 grant で代理実行する。scope attenuation は細かいが、grant の永続化・同意UI・revoke を新設する必要がある。また承認は本人の直接行為にしたいため、委任で扱える範囲が限られる。**本人不在で本人の権限を使う具体的な要件（AI agent の長時間代理実行など）が出た時点で再検討する。** domain 側の Delegation chain はそのまま使える。
- **C. Token exchange（RFC 8693）**: ultra-easy に token endpoint を作り、`act` claim 付きの短命 token を発行する。A と B の中間だが、独自の token 発行基盤を持つ負担に見合う要件が今は無い。

## Implementation（#193）

- approval-api: 公開APIの trusted context で `origin.clientId` に `azp` を記録する
- approval-api: client registry と評価（`client_not_registered`、operation / action type / resource type の制限）
- Knowledge: ログイン時の access token 取得と session への保存、`RemoteUltraEasy` での利用
- Knowledge: M2M client の agent principal でのメンテナンス起動
- security regression: 未登録 client、allowlist 外の action type / resource type、agent token による decision、他 tenant、期限切れ token
