# Acceptance Test

このディレクトリには、マイルストーン単位の外部観測可能な受け入れ挙動を検証するテストを配置する。

## 命名規則

- ファイル名: `m{milestone}-{capability}.test.ts`
- テスト名: `AC-M{milestone}-{number}: <期待する挙動>`
- 同じAcceptance IDを実装計画、テスト、GitHub Issueで共通利用する

## テストの役割

Unit testやPort contract testで内部のsemanticsを細かく検証し、このディレクトリでは複数componentを跨いだ能力を検証する。

M0のAcceptance Criteriaは、型契約・serialization smoke test・architecture dependency testに分かれているため、それぞれ該当packageまたは`tests/architecture`で検証する。M1以降ではcritical pathをここへ追加する。
