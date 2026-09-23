---
description: Orcaの/orchestrationでorchestrator・worker・reviewerの3ロールを協調させて実装を進めるプロトコル。workerの実装・テスト・PR作成と動作確認、reviewerのレビュー・マージ・本番確認、piハーネスとモデル指定、--approve指定、workspace status遷移ルールを定める。「Orcaで実装して」「orchestrationを使って」のようにOrcaでの分散実装を指示された時、またはリポジトリのCLAUDE.md/AGENTS.mdでこのskillの利用が指示されている時に使う。
metadata:
  github-path: orca
  github-ref: refs/heads/main
  github-repo: https://github.com/mpppk/skills
  github-tree-sha: c2a8f7b3387c86dadc47bc0ce6f8453f4ef4602a
name: orca
---

# orca

orcaが提供する/orchestrationを利用し、orchestrator, worker, reviewerの3種類のAIエージェントが協調して実装を進めます。

- workerは指示されたタスクの実装やテストを行い、PRを作成します。PRには動作確認結果も記載してください。動作確認時のキャプチャ（画像・動画）は`gh`の`--attach`フラグで直接アップロードしてください。`--attach`は`gh pr create`・`gh pr edit`・`gh pr comment`（および`gh issue create`・`gh issue edit`・`gh issue comment`）で利用できます。例: `gh pr create --title "..." --body "..." --attach './screenshot.png#動作確認のキャプチャ'`。複数ファイルはフラグを繰り返します（最大50件）。本文中で`![alt](./screenshot.png)`のように参照している場合はアップロード後のURLに書き換えられ、参照がない場合は末尾に追記されます。`--web`や`--dry-run`とは併用できません。
- reviewerは指定されたPRについてレビューを行い、必要に応じて必要な変更を指摘してください。レビューの結果がOKであればPRをマージするのもreviewerの責務です。またPRマージ後の本番での動作確認もreviewerが行ってください。
- orchestratorは、タスクごとに新しいorca workspaceを作成し、その中にworkerを作成します。これによりworkerがそれぞれ独自のgit worktreeで作業することになり、作業のコンフリクトを防止できます。orca workspaceにはタスクに紐づくIssueやPRを紐づけてください。またreviewerは、reviewするタスクを担当したworkerと同じorca workspaceに作成します。
- workerとreviewerのハーネスにはそれぞれ、piを利用し、起動時に`--approve`フラグ（opencodeの`--auto`相当。project-localファイルのtrust確認で停止せず無人運転するため）を付与してください。モデルはopencode-go/muse-spark-1.3-contributorを利用してください。

workerとreviewerのworkspace statusを、以下のルールで適宜orchestratorが変更してください。

- 作業中のworkerはIn progressとする
- 作業が完了してレビューを待っているworkerや、レビュー中のreviewerはIn reviewとする
- レビューを行っていないが再利用の可能性があり待機しているworkerやreviewerはWaitingとする
- もう利用しないworkerやreviewerはDoneとして、適宜削除する
