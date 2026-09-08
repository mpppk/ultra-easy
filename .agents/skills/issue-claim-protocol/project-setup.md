# GitHub Project セットアップ手順（管理者向け・1回だけ）

複数リポジトリで並行作業するエージェントの状況を、人間が1画面で見るためのProjectを用意する。claimプロトコル本体は [SKILL.md](SKILL.md)。

**前提: エージェントはProjectに書き込まない。** Projectは Issue/PR の状態から automation で自動投入される投影であり、claimの権威ではない（理由は SKILL.md「なぜclaimをGitHub Projectに置かないか」）。

## 設計上の制約

エージェントがProject APIを呼ばないので、**Projectのfieldは Issue/PR の状態から自動導出できるものに限る**。`Executor` や `Last Heartbeat` のように導出できないものをボードに出したい場合は、PR descriptionから同期するActionsを別途置く（手順6）。

この制約の結果、ボードで見えるものと見えないものは次のようになる。

| 見たいもの                                            | この構成で見えるか                                  |
| ----------------------------------------------------- | --------------------------------------------------- |
| claim中のIssueが全リポジトリで何件あるか              | **見える**（`CLAIM_LABEL` 駆動のauto-add）          |
| 対応するDraft PRと、それがready化されたか             | **見える**（PRもProjectに載せるため。手順3）        |
| どのリポジトリにエージェントが集中しているか          | **見える**（Group by: Repository）                  |
| 完了したか                                            | **見える**（built-inで `Done`）                     |
| 今どのフェーズか（実装中 / 検証中 / blocked）         | **見えない**。PR descriptionのclaimメタデータを読む |
| 誰（どのセッション）が持っているか、heartbeatはいつか | **見えない**。同上                                  |
| 同じresourceを持つclaimが競合していないか             | **見えない**。横断検索（SKILL.md）で引く            |

下2つをボードに出したい場合は手順6の同期Actionsが必要で、`project` scope を持つtokenの管理が発生する。

## 1. Projectを作る

owner配下に1つだけ作る（例: `AI Work`）。組織ならorganization project、個人ならuser project。どちらも**複数リポジトリのIssue/PRを1つのProjectに集められる**。

Issue自体は原則として変更対象のリポジトリに作る。Projectは横断ビューを提供するだけで、Issueの置き場所ではない。

## 2. Status のオプションは Todo / Done だけにする

GitHubのbuilt-in workflowが自動で設定できるStatusは `Todo` と `Done` だけで、**PRがopenされた時にStatusを変えるbuilt-inは存在せず、PRに紐づくIssueへ作用するworkflowも無い**。エージェントがProjectに書かない構成では、それ以外のオプションを作っても誰も設定できず、手で動かさない限り値が腐る。

そのため、Projectの Status は `Todo` / `Done` の2つに絞る。

| 状態                                  | Project Status | 何が動かすか                        |
| ------------------------------------- | -------------- | ----------------------------------- |
| claim中・実装中・レビュー待ち         | `Todo`         | auto-add + built-in（item added）   |
| PRがmerge済み、またはIssueがclose済み | `Done`         | built-in（item closed / PR merged） |

**進行中の詳細な状態（Claiming / In Progress / Review / Blocked / Abandoned）はProjectに載らない。** これらはPR descriptionのclaimメタデータ（SKILL.md参照）にだけ存在する。ボードで「今どこで詰まっているか」まで見たい場合は、手順6の同期Actionsが必要になる。

Issueのclose reasonとの対応は次のとおり。`Abandoned` / `Duplicate` はStatusでは区別できないので、Issue側の `state_reason` で追う。

| Issue                  | Project Status | 区別の付け方                             |
| ---------------------- | -------------- | ---------------------------------------- |
| open                   | `Todo`         | 詳細はPRのclaimメタデータ                |
| closed (`completed`)   | `Done`         |                                          |
| closed (`not_planned`) | `Done`         | Issueの `state_reason`                   |
| closed (`duplicate`)   | `Done`         | Issueの `state_reason` と `duplicate_of` |

## 3. auto-add workflow を設定する

Project の Workflows → **Auto-add to project**。フィルタ:

```
is:open label:in-progress
```

`is:issue` を付けないのがポイントで、こうするとIssueとPRの両方が載る。SKILL.md の手順ではDraft PRにも `CLAIM_LABEL` を付けるので、**claim中のIssueと、それに対応するDraft PRが対で並ぶ**。PRが載っていれば built-in の「Pull request merged → Done」も効く。

auto-add のフィルタで使える修飾子は `is` / `label` / `reason` / `assignee` / `no` に限られる（`is` は open, closed, merged, draft, issue, pr）。

**本数制限に注意する。1つのworkflowが対象にできるリポジトリは1つで、作れるworkflowの数はプランで決まる:**

| プラン     | auto-add workflow の上限 |
| ---------- | ------------------------ |
| Free       | 1                        |
| Pro / Team | 5                        |
| Enterprise | 20                       |

つまり**Freeプランでは1リポジトリしか自動投入できない**。複数リポジトリを横断して見るのがこの構成の目的なので、対象リポジトリ数ぶんのworkflowが要る。足りない場合は、Projectへの追加を手動で行うか、対象リポジトリを絞る。

## 4. built-in workflow を有効にする

有効にできるのは次の3つだけ。

- **Item closed** → Status: `Done`
- **Pull request merged** → Status: `Done`
- **Item added to project** → Status: `Todo`

`Closes #N` を書いたPRがmergeされるとIssueが自動closeされ、Issue側もPR側もDoneになる。エージェントは何もしない。

## 5. View を作る

Statusが `Todo` / `Done` しか無いので、Viewの絞り込みはStatusではなく **item の種別と開閉状態** で行う。

| View       | 設定                                    | 用途                                                          |
| ---------- | --------------------------------------- | ------------------------------------------------------------- |
| Active     | Filter: `is:open`、Group by: Repository | 今claimされている作業の全体像                                 |
| Review待ち | Filter: `is:pr is:open -is:draft`       | AIが仕事を終え、人間/CIを待っているPR。**最も見る価値がある** |
| 着手直後   | Filter: `is:pr is:open is:draft`        | Draft PRのまま。claim済みだがまだ実装中                       |
| Done       | Filter: `is:closed`                     | 完了分。溜まってきたら auto-archive で退避する                |

Repository は Project が最初から持っているので、custom field を作る必要はない。

「Blocked」はこの構成では機械的に判別できない。PR descriptionの `status: Blocked` を人が読むか、手順6の同期Actionsを入れる。

## 6. （任意）claimメタデータの同期

**ボードで中間状態（Claiming / In Progress / Review / Blocked）まで見たい場合は、これが唯一の手段になる。** `Executor` / `Last Heartbeat` / `Resource` を出したい場合も同じ。PR description の `## Claim` ブロックをパースして `gh project item-edit` で書くActionsを、対象リポの `pull_request` イベントに仕掛ける。

- **Actions の `GITHUB_TOKEN` では Projects v2 を操作できない。** `project` scope を持つPAT、またはprojects権限を付けたGitHub Appのinstallation tokenが要る
- ローカルから `gh` で操作する場合も、`project` scope はgh既定のスコープに含まれない（`gh auth refresh -s project` が必要）
- **無くてもプロトコルは完全に動く。** 落ちるのはボードの情報量だけで、claim・排他・stale回収はすべてIssue/PR側で完結している。token管理のコストと釣り合うときだけ入れる

## 7. 容量に注意する

Projectは active + archived 合わせて **50,000 item** が上限。1 Issue = 1 work item を守っていれば到達しないが、agent run / tool invocation / retry ごとにIssueを作り始めると数日で埋まる。

- Project / Issue = **work item**
- 外部DB / OpenTelemetry / エージェント基盤 = **execution log**

と分ける。SKILL.md の「retryで新しいIssueを作らない」はこの制約と対になっている。

## 注意

- Projectの表示は automation 経由なので**遅延する**。エージェントのclaim判定に使ってはいけない
- Project の field は last-write-wins で、複数セッションが同じitemを触ると壊れる。権威ではないので許容範囲だが、そこに真実があると思ってはいけない
