---
description: ユーザから指定されたリポジトリ名でpublic repositoryをghコマンド経由で作成し、マージ設定（squashのみ有効・ブランチ自動削除）を適用する。「public repoを作って」「ghでリポジトリを作成して」のようにGitHubリポジトリの新規作成を指示された時、またはリポジトリのCLAUDE.md/AGENTS.mdでこのskillの利用が指示されている時に使う。
metadata:
  github-path: setup-gh-pub-repo
  github-ref: refs/heads/main
  github-repo: https://github.com/mpppk/skills
  github-tree-sha: 8bbd7c8161ba546f2cb1959f7ffe2e884875b0fd
name: setup-gh-pub-repo
---

# setup-gh-pub-repo

ユーザから指定されたリポジトリ名で public repository を `gh` コマンド経由で作成し、以下のマージ設定を自動適用する。

```bash
gh repo edit mpppk/REPO \
  --enable-rebase-merge=false \
  --enable-merge-commit=false \
  --enable-squash-merge=true \
  --delete-branch-on-merge=true
```

## 前提

- `gh` がインストール済みで、`gh auth status` が正常であること。未認証なら作業を止めてユーザに `gh auth login` を促す。

## 手順

### 1. リポジトリ名を確定する

- OWNER は常に `mpppk`。ユーザ指定が `OWNER/REPO` 形式でも `REPO` 部分だけを取り出し、`mpppk/REPO` とする。

### 2. 既存チェック

作成前に同名リポジトリが存在しないか確認する。

```bash
gh repo view mpppk/REPO
```

- 存在すれば作成せず、ユーザに報告して止まる。上書き・削除はしない。

### 3. public repository を作成する

```bash
gh repo create mpppk/REPO --public
```

- ユーザから `--description` / `--clone` / `--add-readme` などの追加指定があれば付与してよい。指定がなければ素の `--public` のみで作成する。
- private で作らない。`--private` / `--internal` を付けない。

### 4. マージ設定を適用する

作成直後に以下を必ず実行する。省略・変更しない。

```bash
gh repo edit mpppk/REPO \
  --enable-rebase-merge=false \
  --enable-merge-commit=false \
  --enable-squash-merge=true \
  --delete-branch-on-merge=true
```

### 5. 動作確認

```bash
gh repo view mpppk/REPO --json name,visibility,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge
```

- `visibility` が `PUBLIC` であること。
- squash のみ `true`、他が期待通りであること。
