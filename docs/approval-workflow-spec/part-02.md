# **2\. 用語と責務境界**

| 用語 | 定義 |
| :---- | :---- |
| Policy | ActionRequestとEvaluation Contextに対し、どのApproval Flowを生成するかを定義する不変バージョン付きルール。 |
| Policy AST | Policyの正規シリアライズ形式。JSONとして保存可能。 |
| Rule | ConditionとFlowの組。上から評価し最初に一致したRuleを採用する。 |
| Flow | Serial / Parallel / Approval Stepからなる承認構造。 |
| Workflow | Materialized Flow ASTを実行するCloudflare Workflows instance。 |
| Approval Step | Flow AST内の承認node。承認者targetとresolution/self-approval等の制約を持つ。 |
| ApproverResolver | 「このユーザーが承認可能か」「候補者は誰か」を解決するPort。 |
| FGA Projection | 組織DB等の事実をAuthorization TupleとしてFGAへ投影したもの。 |
| Decision | approve/reject等の実行結果。append-only監査ログ。 |

## **2.1 責務分担**

| 機能 | Policy/Workflow | FGA |
| :---- | :---- | :---- |
| 金額条件・種別条件 | ○ | \- |
| 承認順序 | ○ | \- |
| 現在のStep | ○ | \- |
| approve/reject/cancel | ○ | \- |
| 自己承認禁止 | ○ | \- |
| AND/OR/quorum | ○ | \- |
| 部署所属・manager | \- | ○ |
| 上位部署manager | \- | ○ |
| 経理/役員等のrole | \- | ○ |
| 代理承認 | 実行はWorkflows / relation評価はFGA | ○ |
| 承認可能性の最終判定 | 制約をAND | Check |

## **2.2 ActionRequest / Actor / Authority**

# **基盤内部ではApprovalRequestより一般的なActionRequestを正規ドメイン入力とする。ActionRequestはactor（実際に要求した主体）、authority（権限の根拠となるprincipal）、delegation（principalからactorへ委譲されたgrant/chain）、action（resource・operation・input）、origin（ui/api/mcp/system等）を保持する。**

# **AI Agentが人間の代理で動く場合、actorはagent、authority.principalは権限元principal、delegation.delegatorId/grantIdは委譲元とgrantを表す。AI作成者の全権限を自動継承してはならず、実効権限は元principalの現在権限・token scope・delegation grant・agent policy・organization policyの積集合としてattenuateする。多段Agentではdelegation chainを監査可能に保持し、下流Agentが上流より強い権限を得ないようにする。**

# **AuthorizationはApprovalより前段で実行し、権限のないActionRequestを人間の承認だけで昇格させてはならない。Authorizationを通過したActionRequestに対してのみApproval Policyを評価し、承認不要なら直接execute、承認が必要ならMaterialized Flowを生成してGeneric ActionWorkflowを開始する。**

#

# **3\. システムアーキテクチャ**

UI / REST API / MCP Server / System Trigger  
                 |  
                 v  
\+-----------------------------------+  
| Input Adapters                    |  
| \-\> normalize to ActionRequest     |  
\+----------------+------------------+  
                 |  
                 v  
\+-----------------------------------+  
| approval-core                     |  
| ActionRequest / ActionAuthorizer  |  
| Policy / Flow AST                 |  
| Validator / Evaluator / Semantics|  
| ApproverResolver (port)           |  
\+----------------+------------------+  
                 |  
          Authorization  
          | allow / deny  
          v  
       Approval Policy  
          | no flow \-\> Execute  
          | flow  
          v  
\+-----------------------------------+  
| approval-runtime-cloudflare       |  
| Generic ActionWorkflow          |  
| Flow Interpreter                  |  
| step.do / waitForEvent / sleep    |  
\+-------------+---------------------+  
              |              |  
              v              v  
       \+-------------+   \+-------------+  
       | approval-fga|   | approval-d1 |  
       | Auth0 FGA   |   | D1 read/audit|  
       \+-------------+   \+-------------+

依存方向は常にAdapterからCoreへ向ける。approval-coreはHTTP、DB、OpenFGA SDK、Zod等の具体実装をimportしてはならない。

## **3.1 Cloudflare実行環境**

Application runtimeはCloudflare Workersとする。approval-coreはWeb標準APIとpure TypeScriptのみを前提とし、Node.js固有APIへの依存を避ける。Workersのcompatibility dateは2026-08-04以降を推奨し、Node.js compatibilityが必要なnpm packageを利用する場合もWorkersでの動作をCIで検証する。

D1はWorker binding（例: env.DB）経由で利用する。Auth0 FGA AdapterはWeb標準fetchによるREST API呼び出しを標準実装とし、OpenFGA SDKはWorkers対応を確認した場合のみ任意に差し替え可能とする。
