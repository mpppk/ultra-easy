# 承認ワークフロー基盤 仕様書 v1.0

> Google Docs から GitHub へ移行した仕様書。HTTP API の機械可読な契約は [`openapi/openapi.yaml`](openapi/openapi.yaml) を参照。

## Overview

- [Design Doc — project background, motivation, core ideas, trade-offs, rollout](design-doc.md)

## Sections

- [0. エグゼクティブサマリー / 1. 目的・スコープ](approval-workflow-spec/part-01.md)
- [2. 用語と責務境界 / 3. システムアーキテクチャ](approval-workflow-spec/part-02.md)
- [4. パッケージ構成と依存方向](approval-workflow-spec/part-03.md)
- [5. Standard Schema統合仕様](approval-workflow-spec/part-04.md)
- [6. PolicyモデルとJSON AST](approval-workflow-spec/part-05.md)
- [7. Condition / Expression仕様](approval-workflow-spec/part-06.md)
- [8. Flow / Approval Step仕様](approval-workflow-spec/part-07.md)
- [9. TypeScript Builder仕様 / 10. Policy検証・公開・評価](approval-workflow-spec/part-08.md)
- [11. Flow MaterializationとCloudflare Workflows実行モデル — Part 1](approval-workflow-spec/part-09.md)
- [11. Flow MaterializationとCloudflare Workflows実行モデル — Part 2](approval-workflow-spec/part-10.md)
- [12. Authorization / ApproverResolver / Auth0 FGA連携 — Part 1](approval-workflow-spec/part-11.md)
- [12. Authorization / ApproverResolver / Auth0 FGA連携 — Part 2 / 13. 組織マスタ・FGA同期・代理承認](approval-workflow-spec/part-12.md)
- [14. 永続化モデル — Part 1](approval-workflow-spec/part-13.md)
- [14. 永続化モデル — Part 2 / 15. 主要ユースケース — Part 1](approval-workflow-spec/part-14.md)
- [15. 主要ユースケースと整合性制御 — Part 2](approval-workflow-spec/part-15.md)
- [15. 主要ユースケースと整合性制御 — Part 3](approval-workflow-spec/part-16.md)
- [15. 主要ユースケースと整合性制御 — Part 4](approval-workflow-spec/part-17.md)
- [15. 主要ユースケースと整合性制御 — Part 5](approval-workflow-spec/part-18.md)
- [16. 外部インターフェース境界 — Part 1](approval-workflow-spec/part-19.md)
- [16. 外部インターフェース境界 — Part 2](approval-workflow-spec/part-20.md)
- [17. イベント・Outbox・監査](approval-workflow-spec/part-21.md)
- [18. マルチテナントとセキュリティ](approval-workflow-spec/part-22.md)
- [19. テスト戦略 / v1スコープ表](approval-workflow-spec/part-23.md)
- [20. v1スコープ・非スコープ / 実装ロードマップ](approval-workflow-spec/part-24.md)
- [21. 実装ロードマップ / 22. 未確定事項](approval-workflow-spec/part-25.md)
- [付録A. Policy JSON例 / 付録B. TypeScript Builder例 / 付録C. FGAモデル例](approval-workflow-spec/part-26.md)
- [付録D. 参考資料](approval-workflow-spec/part-27.md)

## OpenAPI

- [OpenAPI 3.1 root](openapi/openapi.yaml)
- [OpenAPI modularization notes](openapi/README.md)

## Source

- Migrated from Google Docs: `承認ワークフロー基盤 仕様書 v1.0`
- HTTP contract: [`openapi/openapi.yaml`](openapi/openapi.yaml)

The repository copy is the maintainable source after this migration.
