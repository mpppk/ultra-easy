# **0\. エグゼクティブサマリー**

本仕様は、人間・AI Agent・Serviceから発生するActionRequestに対して、実効権限を認可し、必要な承認Flowを動的に生成・実行できるヘッドレスなTypeScript承認ワークフロー基盤のv1仕様を定義する。経費・稟議・購買・契約等の業務申請に加え、MCP tool実行やAI Agentによる操作要求も同一ドメインモデルで扱う。

| 関心事 | 正本 / 実装責務 |
| :---- | :---- |
| 承認ルール | シリアライズ可能なPolicy JSON AST |
| TypeScriptでの記述 | JSON ASTを生成する型安全なBuilder |
| 入力検証 | StandardSchemaV1を受け取るSchemaResolver |
| GUI用スキーマ情報 | StandardJSONSchemaV1を任意Capabilityとして利用 |
| 承認順序・実行 | Flow Interpreter \+ Cloudflare Workflows runtime |
| 誰が承認可能か | ApproverResolver。v1標準AdapterはAuth0 FGA |
| 組織情報 | Cloudflare D1/HRIS等をSource of TruthとしFGAへProjection |
| 監査 | actionFingerprint、EvaluationSnapshot、PolicyBinding/Policy Version、Materialized Approval Plan、Authorization/Delegation evidence、Decision Log、Final Resultを監査可能に保持 |

**最重要の分離  Authorizationは「このactorが委譲されたauthorityの範囲内でactionを要求可能か」を判定し、Approval Policyは「認可済みActionRequestを実行する前に誰の承認が必要か」を決定する。承認Flowはcaller()、relation(...)、user(...)等のApproverExpressionから構成し、AIの実行確認も業務承認も同じApproval Step semanticsで扱う。**

# **1\. 目的・スコープ**

## **1.1 目的**

* ActionRequestのactor/authority/delegationと、組織構造・役職・代理権限に基づくAuthorization/承認者解決を、Workflow状態管理から分離する。  
* 承認PolicyをJSONとして保存・バージョニングし、将来のGUI編集とTypeScript定義を同一モデルに統合する。  
* Zod等の特定Schemaライブラリへの依存を避け、Standard Schema互換スキーマを受け入れる。  
* 承認ロジックの中心をpure functionとして実装し、高いテスト容易性と監査再現性を得る。  
* Auth0 FGAを利用しつつ、approval-core自体はFGA実装にも依存しない。

## **1.2 主なユースケース**

* 経費申請  
* 購買申請  
* 稟議  
* 契約レビュー  
* チケット操作（状態遷移・assign・priority変更等） / アクセス申請 / AI AgentによるMCP tool実行 / Serviceからの操作要求  
* 組織階層に応じた多段階承認  
* 金額・種別・actor種別・origin・delegation等の条件による承認ルート分岐

## **1.3 非目標**

* BPMN互換の汎用プロセスエンジンをv1で実装すること。  
* 任意コード実行をPolicy DSL内で許可すること。  
* FGAを組織マスタや業務データのSource of Truthとして利用すること。  
* GUI Policy Editorをv1の必須成果物にすること。
