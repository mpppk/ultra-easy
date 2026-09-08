---
allowed-agents: claude-code
description: 複数のエージェントセッションが単一/複数のGitHubリポジトリのIssueを並行処理する際のclaimプロトコル。同じIssueへの殺到による重複実装・相互巻き戻しや、リポジトリをまたぐ共有リソース(DBマイグレーション・lockfile・共有スキーマ・CI設定)の衝突を防ぐため、Issueのピック手順・早期Draft PRによるclaim確立・heartbeat付きclaimメタデータ・resource lock・staleなclaimの回収・完了/撤退時の後始末を定める。GitHub Projectを可視化に使う場合の前提もここで定義する。「重要度の高いIssueを順次解決して」のような複数セッションでの並行処理指示時に使う。
metadata:
  github-path: issue-claim-protocol
  github-ref: refs/heads/main
  github-repo: https://github.com/mpppk/skills
  github-tree-sha: c26ab6ecd92e36953dfcc3a59145334f3fc92759
name: issue-claim-protocol
---

# issue-claim-protocol

複数のエージェントセッション（環境）が、1つまたは複数のリポジトリのIssueを並行処理する際の占有（claim）プロトコル。並行セッションが同じIssueに殺到して重複実装・相互巻き戻しを起こすのを防ぐ。

## 3つの層

| 層       | 実体                                      | 誰が書くか     | 扱い                                                        |
| -------- | ----------------------------------------- | -------------- | ----------------------------------------------------------- |
| **権威** | `Closes #N` でIssueにリンクされた open PR | エージェント   | claimの一次情報。先着判定はここだけで行う                   |
| **索引** | ラベル + PR descriptionのclaimメタデータ  | エージェント   | 高速な事前フィルタ。best-effortで、失敗しても致命的ではない |
| **投影** | GitHub Project                            | automationのみ | 人間が見る表示専用。エージェントは読み書きしない            |

### なぜclaimをGitHub Projectに置かないか

- Projects v2 の custom field には unique 制約も条件付き更新（CAS）もなく、item追加とfield更新も別呼び出しになるため、**原子的なclaimができない**
- Projects v2 の書き込みは GraphQL のみ（REST はproject自体のGETだけでitemに触れない）で、`project` scope を持つtokenが要る。Claude Code on the web のようにGraphQLへ到達できないセッションでは、Projectを**読むことすらできない**
- 対して PR の作成時刻は GitHub がサーバ側で採番するので**全順序が付く**。後述の claim-then-verify はこの性質に依存している

したがって**エージェントは Project API を呼ばない**。Projectは Issue/PR の状態から automation で自動投入され、人間が全リポジトリの状況を1画面で見るためだけに存在する。反映は遅延するので、**Projectの表示を見て「このIssueは空いている」と判断してはいけない**。構築手順は [project-setup.md](project-setup.md)。

Projectに載るのは `CLAIM_LABEL` が付いたIssueとPRで、**Statusは `Todo` / `Done` しか自動では動かない**。GitHubのbuilt-in workflowにはPRがopenされた時にStatusを変えるものが無く、PRに紐づくIssueへ作用するものも無いため、エージェントが書かない構成では中間状態を機械的に付けられない。進行中の詳細な状態は、Project上のStatusではなく**PR descriptionのclaimメタデータを読む**。

## When to use

- 「重要度の高いIssueを順次解決して」のように、複数セッションでIssueを並行処理するとき
- 自分がIssue対応を開始する前に、他セッションが着手していないかを確認したいとき
- 着手したIssueのclaim（Draft PR）を確立・更新・回収するとき

## リポジトリ固有の設定

リポジトリの `CLAUDE.md`（または `AGENTS.md`）に下記キーを定義できる。定義が無ければデフォルト値で動く。

| キー                  | デフォルト                       | 意味                                                                                                                    |
| --------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `CLAIM_SCOPE`         | （なし＝作業中のリポジトリのみ） | 横断チェックの範囲。`org:foo` / `user:mpppk`。定義するとclaim検査がowner配下の全リポジトリ横断になる                    |
| `CLAIM_LABEL`         | `in-progress`                    | claim状態を示すラベル名。ラベルが存在しない場合は該当チェックをスキップ可。横断モードでは対象リポ全部に同名ラベルが要る |
| `CLAIM_BRANCH_PREFIX` | `claude/issue-<N>-<slug>`        | ブランチ命名規則                                                                                                        |
| `CLAIM_RESOURCES`     | （なし）                         | 排他したい粗いリソース名 → 判定パターン（後述）。定義時のみresource lockのチェックが有効になる                          |
| `CLAIM_STALE_HOURS`   | `6`                              | staleと判定する `last-heartbeat`（またはPR最終更新）からの経過時間                                                      |
| `CLAIM_LEASE_MINUTES` | `360`                            | `lease-until` に書く有効期限。表示用で、回収判定には使わない                                                            |

リポジトリ側の記載例:

```markdown
## 複数セッションでのIssue並行処理

`issue-claim-protocol` skill に従う。リポジトリ固有設定:

- CLAIM_SCOPE: `user:mpppk`
- CLAIM_LABEL: `in-progress`
- CLAIM_RESOURCES:
  - `db-migration`: `drizzle/**`, `src/db/schema.ts`
  - `lockfile`: `bun.lockb`
  - `ci-config`: `.github/workflows/**`
  - `shared:api-contract`: `packages/api-schema/**`
```

## resource lock

変更ファイルパスの重なりで衝突を判定すると、リポジトリをまたいだ時に意味を持たず、粒度が細かすぎて並列度も落ちる。**粗いリソース名**で排他する。

- リソース名は `<owner>/<repo>:<name>` に修飾する。同名でも別リポなら別ロック
- `shared:` で始まる名前だけはリポ修飾しない。複数リポが同じ契約（共有スキーマ、API contract）を触る場合に、リポをまたいで排他される
- 排他する価値があるのは、DBマイグレーション / lockfile / 共有スキーマ / CI設定 のような**同時変更が確実に衝突するもの**に限る。アプリコードを細かくロックしない

## Issueのピック手順

1. `origin/main` を最新化し、重要度順に候補Issueを並べる。
2. 上位から順に以下を確認し、**最初に全て通過したIssueを1つだけ**選ぶ:
   - `CLAIM_LABEL` ラベルが付いていない（ラベルが存在しない場合はこのチェックはスキップ可）
   - **Issueにリンクされた open PR がない** — `issue_read`（method=`get`）が返す `closed_by_pull_requests` で確認する。本文の文字列検索より正確で、1回の呼び出しで済む
   - 触る予定の resource が、他の open PR にclaimされていない（`CLAIM_RESOURCES` 定義時のみ）
3. claim競合を検知したら**同一Issueで再挑戦せず、次の候補へ進む**（先着優先・バックオフ）。

### 横断検索の方法

`CLAIM_SCOPE` が定義されているとき、他セッションのclaimは `search_pull_requests` で引く。このツールは GitHub の PR 検索構文をそのまま受け取る（自然言語ではない）。

- 進行中のclaim一覧: `<CLAIM_SCOPE> is:open is:pr draft:true label:<CLAIM_LABEL>`
- resourceの衝突: `<CLAIM_SCOPE> is:open is:pr "resource: <owner>/<repo>:<name>"`

検索インデックスは遅延しうるので、これは**事前フィルタにすぎない**。最終判定は claim-then-verify で行う。

`search_issues` は自然言語のセマンティック検索なので、claim判定のような厳密な問い合わせには使わない。単一リポのIssue列挙は `list_issues`（`labels` / `state` で絞る）を使う。

## claimの確立（早期Draft PR）

1. 可能なら `CLAIM_LABEL` ラベルをIssueに付与する（なければ・権限がなければ省略可）。
2. ブランチを作り、最初の小さなコミット（計画のみ・空実装でも可）をpushして、**実装を進める前に直ちにDraft PRを作成**する。本文に `Closes #N` と後述のclaimメタデータを含め、**Draft PRにも `CLAIM_LABEL` ラベルを付ける**。PRを作業の最後に作る運用では「着手〜PR作成」の間が無防備になり、リンクPRチェックが機能しない。PR側にもラベルを付けるのは、後述の横断検索がPRをラベルで引くためと、Projectのauto-add workflowがラベル駆動のため。Issueにしか付けないと、どちらも空振りする。
3. **Draft PR作成後、同一Issueにリンクされた open PR を再取得**し、自分より作成時刻の早いPRが存在したら、自分のDraft PRをその旨を本文に記してクローズし、ラベルを外して次の候補Issueへ移る（claim-then-verify。作成時刻はGitHubがサーバ側で採番するため順序が確定する）。
4. `CLAIM_SCOPE` 定義時は、3と同時に**resourceの衝突も再確認**する。同じresourceを持つ、自分より早いPRが存在したら同様に撤退する。

## claimメタデータ（PR descriptionを都度更新）

PR本文の末尾に以下のセクションを置き、**作業の節目（実装開始・push・動作確認開始・ready化など）ごとに `last-heartbeat` / `lease-until` / `status` を更新する**。Issueへのコメント追記ではなくPR description更新にするのは、最新状態が1箇所に保たれ、他セッションの読む場所が固定されるため。タイムスタンプは `date -u +%Y-%m-%dT%H:%M:%SZ` で取得したUTCを使う。

```
## Claim
- branch: <CLAIM_BRANCH_PREFIX>
- executor: <エージェント種別>:<セッション識別子>
- status: In Progress
- attempt: 1
- last-heartbeat: <UTC ISO8601>
- lease-until: <UTC ISO8601>
- resource: <owner>/<repo>:<name>
- resource: shared:<name>
```

- `executor` は「どのエージェントのどのインスタンスが持っているか」。同じエージェント種別の別インスタンスと区別が付くので、stale回収時の判断材料になる
- `resource` は**1行1件**。横断検索にそのまま引っかかる形にするため、複数をカンマで並べない
- `status` の語彙は `Claiming` / `In Progress` / `Review` / `Blocked` / `Done` / `Abandoned`。**これはPR description上だけの値で、ProjectのStatusフィールドとは別物**。Project側は `Todo` / `Done` しか持たない（理由は「3つの層」を参照）ので、中間状態を知りたい他セッションと人間はこの行を読む
- 実行ログはここに書かない。GitHubに残すのは claim / 重要な方針変更 / PR作成 / blocked / 終了 だけにする

## staleなclaimの回収

セッションはコンテナ回収等で予告なく死ぬため、放置されたclaimは回収してよい。以下を**全て**満たす場合にstaleとみなす:

- `last-heartbeat` が `CLAIM_STALE_HOURS`（デフォルト6）時間以上前（claimメタデータがないPRは、PR本文・コミットの最終更新が `CLAIM_STALE_HOURS` 時間以上前）
- ブランチに新しいコミットがない

`lease-until` を過ぎているだけでは回収しない。生きているセッションがheartbeatを1回落としただけで誤回収されるほうが、待つより高くつく。`lease-until` は「いつ頃staleになるか」を人間とProjectに見せるための表示用。

回収する側は、旧Draft PRに回収の旨をコメントしてクローズし、新たに自分のclaim（Draft PR）を確立する。**stale判定に満たないclaimは、進捗が見えなくても上書きしない**（誤回収による重複実装のほうが待ちより高くつく）。

## Issueをcloseするタイミング

PRを作っただけでIssueをcloseしない。`status` を `Review` にするだけにする。closeは `Closes #N` によるmerge時のauto-closeに任せる。これによってProjectの `Review`（AIが仕事を終え、人間/CI待ち）が意味を持つ。

## 完了・撤退時の後始末

- ready化の直前に、**同一Issueへの別open PR・mainへの先行マージがないかを再確認**する（長時間セッションでは着手時のチェックが陳腐化する）。
- PRがマージ/クローズされたら `CLAIM_LABEL` ラベルを**IssueとPRの両方から**外す（`Closes #N` のauto-closeはラベルまでは外さない）。残したままだとProjectのボードに完了済みのclaimが積み上がり、横断検索も空振りが増える。
- 作業を断念する場合は、Draft PRに理由を記してクローズし、同じくIssueとPRの両方からラベルを外す。**黙って放置しない**。
- 先着PRに負けて撤退する場合、閉じるのは**自分のPR**であってIssueではない。Issueは相手のclaimで生きている。
- 重複と判明したIssueを閉じるときは、`issue_write` で `state_reason: duplicate` と `duplicate_of` を指定する。単にcloseするより、Projectからも人間からも追える。

## リポジトリをまたぐ仕事

backend / frontend / SDK を同時に変えるような仕事は、1つの巨大Issueにしない。coordination用のIssueを親にして、各リポジトリのIssueをsub-issueにする（`sub_issue_write` の `add`）。**claimは子Issue単位で取る**。親Issueはclaimの対象にしない。

## その他のルール

- **1 Issue = 1 ブランチ = 1 PR**。「重要度の高いIssueを順次解決して」のように複数Issueをまたぐ指示を受けた場合、**2件目以降もユーザに確認せず新しいブランチを切ってよい**（`CLAIM_BRANCH_PREFIX` に従う）。セッションに作業ブランチが指定されていても、それは1件目の置き場所であって「以降の全Issueをそこに積む」意味ではない。同じブランチに積むと1本のPRが複数Issueの混在になり、`Closes #N` のauto-closeもレビューも成立しなくなる。
- **WIP制限**: 1セッションが同時にclaimしてよいIssueは1つ。PRをopen（Draft作成）してから次のIssueをclaimするのではなく、**現在のPRをready化（または撤退）してから**次をclaimする。横断モードでは `<CLAIM_SCOPE> is:open is:pr draft:true` の結果に自分の `executor` のclaimが1つしか無いことで確認できる。
- **retryで新しいIssueを作らない**。エージェントが交代しても同じIssue・同じPRを再利用し、`executor` と `attempt` を更新する。run単位でIssueを作ると、タスク数とエージェント実行回数が混ざり、Projectの容量も食い潰す。
- 作業途中で同一Issueの別 open PR を発見したら、競合PRをready化せず作業を止め、自分のPR本文に状況を記して撤退する（先着優先）。判断が付かない場合はユーザに報告する。

## 厳密な排他が必要になったら

本プロトコルは先着優先のbest-effortで、GitHubだけで完結する代わりに原子的な排他は提供しない。数十インスタンス規模で衝突が実害になるなら、`claim` / `heartbeat` / `release` を提供する小さなCoordinatorを立て、GitHubは可視化と監査に専念させる設計へ移る。その場合、本skillはCoordinatorの薄いクライアント仕様に置き換わる。
