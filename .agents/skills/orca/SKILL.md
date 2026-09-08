---
description: Orcaの/orchestrationでorchestrator・worker・reviewerの3ロールを協調させて実装を進めるプロトコル。workerの実装・テスト・PR作成と動作確認、reviewerのレビュー・マージ・本番確認、opencodeハーネスとモデル指定、workspace status遷移ルールを定める。「Orcaで実装して」「orchestrationを使って」のようにOrcaでの分散実装を指示された時、またはリポジトリのCLAUDE.md/AGENTS.mdでこのskillの利用が指示されている時に使う。
metadata:
  github-path: orca
  github-ref: refs/heads/main
  github-repo: https://github.com/mpppk/skills
  github-tree-sha: ee92cf3cec166479a0db2f44bebfa116f7dd1ac7
name: orca
---

# orca

orcaが提供する/orchestrationを利用し、orchestrator, worker, reviewerの3種類のAIエージェントが協調して実装を進めます。

- workerは指示されたタスクの実装やテストを行い、PRを作成します。PRには動作確認結果も記載してください。gyazoが利用可能な環境であれば動作確認時のキャプチャも付与してください。利用可能な環境では、GYAZO_API_TOKENなどの環境変数からトークンを取得できます。この環境変数は.envファイルから取得できることもあります。この.envは1password MCPがマウントします。
- reviewerは指定されたPRについてレビューを行い、必要に応じて必要な変更を指摘してください。レビューの結果がOKであればPRをマージするのもreviewerの責務です。またPRマージ後の本番での動作確認もreviewerが行ってください。
- workerとreviewerのハーネスにはそれぞれ、opencodeを利用し、モデルはopencode-go/muse-spark-1.3-contributorを利用してください。

workerとreviewerのworkspace statusを、以下のルールで適宜orchestratorが変更してください。

- 作業中のworkerはIn progressとする
- 作業が完了してレビューを待っているworkerや、レビュー中のreviewerはIn reviewとする
- レビューを行っていないが再利用の可能性があり待機しているreviewerはWaitingとする
- もう利用しないworkerやreviewerはDoneとして、適宜削除する
