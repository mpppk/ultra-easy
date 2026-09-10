# Approval Workflow Platform — Design Doc

**Status:** Draft  
**Audience:** Engineering / Product / Security / Architecture  
**Detailed specification:** [`approval-workflow-spec.md`](approval-workflow-spec.md)  
**OpenAPI:** [`openapi/openapi.yaml`](openapi/openapi.yaml)

## 1. Summary

本プロジェクトでは、アプリケーションから発生する操作要求に対して、

1. その操作を実行する権限があるかを判定し、
2. 必要であれば人間による承認を取得し、
3. 最終的に安全に操作を実行する

ための共通基盤を構築する。

対象は経費・購買・契約・アクセス申請のような従来の業務承認だけではない。チケットのCritical化、本番環境への変更、権限付与、MCP Toolの実行、AI Agentによる代理操作など、**「実行前に追加の人間判断が必要になり得るAction」全般**を同じモデルで扱う。

この基盤の中心となる考え方は、個々の業務ごとにWorkflowを実装するのではなく、**任意のActionを正規化し、そのActionに適用する承認Policyをデータとして評価する**ことである。

---

## 2. Background

実際の業務システムでは、認可と承認は単純なRBACだけでは表現しきれない。

例えばチケット管理システムでも、次のようなルールが必要になる。

- 担当者だけが状態変更できる
- Criticalへの変更にはIncident Managerの承認が必要
- 100万円以上なら部長とFinanceの承認が必要
- 本番権限の付与にはManagerとSecurityの承認が必要
- 申請者自身は承認できない
- 承認者が異動した場合は現在の上長を利用する
- 委任された操作では委任範囲を超えてはならない

つまり実際のルールは、概念的には次の複数軸の組み合わせになる。

```text
Principal × Resource × Action × State × Context × Approval
```

さらにAI Agentが業務システムを操作するようになると、次の問題も同じ設計の中で扱う必要がある。

- 誰が直接操作したのか
- 誰の権限を根拠としているのか
- 人間による実行確認が必要か
- Agentから別Agentへ委任できるか
- 承認待ちの間に権限が失効した場合にどうするか

---

## 3. Problem

現在の典型的な実装方法では、各アプリケーションが個別に認可・承認ロジックを持つ。

```text
Ticket Application
├ Authorization
├ Manager lookup
├ Approval table
├ Approval state machine
├ Notification
├ Retry / timeout
└ Execute operation

Expense Application
├ Authorization
├ Manager lookup
├ Approval table
├ Approval state machine
├ Notification
├ Retry / timeout
└ Execute operation

AI Agent Gateway
├ Authorization
├ Human confirmation
├ Approval state
└ Execute tool
```

この構造には次の問題がある。

### 3.1 同じ仕組みが何度も実装される

「上長承認」「Finance承認」「N人中M人承認」「自己承認禁止」といった概念が、それぞれのシステムで再実装される。実装方式やsemanticsも徐々に異なっていく。

### 3.2 Business ruleとApplication codeが密結合する

例えば次のようなコードを書くと、承認ルール変更のたびにアプリケーションの変更とデプロイが必要になる。

```ts
if (amount >= 1_000_000) {
  await requestApproval(manager);
  await requestApproval(finance);
}
```

### 3.3 AuthorizationとApprovalが混同される

「承認されたから実行してよい」という実装にすると、本来そのActionを実行する権限を持たない主体が、人間の承認によって権限を獲得してしまう可能性がある。これは特にAgentによる操作では危険である。

### 3.4 組織構造との結合が強くなる

「上長」「部署長」「Resource Owner」「Security担当者」などの解決処理をWorkflow側へ埋め込むと、組織モデル変更の影響がWorkflow全体へ広がる。

### 3.5 監査再現性が低い

数か月後に「なぜこの申請ではこの3人の承認が必要だったのか」を説明しようとしても、現在のコードや現在の組織情報しか残っていなければ再現できない。

### 3.6 AI対応が別系統になる

AI Agentの「このコマンドを実行してよいですか？」という確認を、従来の業務承認と別の仕組みにすると、認可・委任・監査のモデルが二重化する。

---

## 4. Why this project is needed

承認要件が1つしかない単一アプリケーションであれば、そのアプリケーション内に専用実装を書く方が早い。

しかし、対象Actionや利用アプリケーションが増えると要求は次のように積み重なる。

```text
上長承認
↓
金額条件
↓
Finance承認
↓
代理承認
↓
異動対応
↓
Quorum
↓
自己承認禁止
↓
監査
↓
Policy Versioning
↓
AI Agent対応
```

結果として各Applicationに小さなApproval Engineが生まれ、複数の似ているが微妙に異なる実装を保守することになる。

本プロジェクトは、将来的に繰り返し必要になるこれらの共通部分を、**Action Authorization + Human Approvalという明確な境界で共通化する**ものである。

---

## 5. Goals

本プロジェクトでは次を実現する。

- AuthorizationとApprovalを明確に分離する
- 任意のApplication Actionを共通モデルで表現する
- 承認PolicyをApplication codeから切り離す
- 単一承認、多段承認、parallel、quorumなどを共通表現する
- 組織階層やResource Owner等を動的に解決できる
- 人間、Service、AI Agentを同じPrincipal modelで扱う
- 長時間の承認待ちをdurableに実行できる
- Policy変更後も過去の承認判断を再現できる
- 各業務システムがApprovalの状態機械を実装しなくてよい状態にする

## 6. Non-goals

v1では以下を目標としない。

- BPMN互換の汎用Workflow Engine
- 任意の業務プロセス自動化
- Policy内での任意コード実行
- 組織・人事情報そのものの管理
- OpenFGAを組織マスタとして利用すること
- GUI Workflow Designerの完成
- 複雑なCompensation / Saga Engine
- Break Glass / Post Approvalの完全対応
- Line-item Approvalの汎用モデル

本基盤は「汎用Workflow Engine」ではなく、**Action AuthorizationとHuman Approvalに特化した基盤**である。

---

## 7. Core Ideas

### 7.1 Everything starts from an Action

システムへの操作をまず`ActionRequest`へ正規化する。

```text
actor
  誰が直接操作したか

authority
  誰の権限を根拠としているか

action
  何をしようとしているか

resource
  何に対する操作か

input
  どのような内容か

origin
  UI / API / MCP / System
```

Ticket、Expense、MCP Toolなどの違いは、その後の承認基盤から見るとActionの種類の違いになる。

### 7.2 Authorization comes before Approval

処理順序は必ず次の順序とする。

```text
Action
  ↓
Authorization
  ↓ allow
Approval Policy
  ↓
Approval
  ↓
Re-Authorization
  ↓
Execute
```

重要なinvariantは、**ApprovalはAuthorizationを昇格させない**ことである。

例えばAI Agentに本番DB削除権限がなければ、人間が「承認」ボタンを押しても削除できない。

### 7.3 Policy is Data

承認ルールをアプリケーションコードではなくJSON ASTとして表現する。

概念的には次のようなPolicyになる。

```text
WHEN
  amount >= 1,000,000

THEN
  Manager
  ↓
  Finance
  ↓
  CFO
```

TypeScript Builderも将来のGUI Editorも、同じASTを生成する。

```text
Policy Definition
      ↓
   JSON AST
    ↙   ↘
TypeScript  GUI
```

これによりPolicyの保存、validation、versioning、simulation、auditを共通化できる。

### 7.4 Relationship resolution is separated from Flow

Workflowは「requesterのmanagerの承認が必要」という意味だけを持つ。

```text
managerOf(requester)
```

「requesterのmanagerが現在誰なのか」はWorkflow自身では管理しない。

```text
Approval Engine
  WHAT approval is required?

OpenFGA / Relationship Resolver
  WHO satisfies that role/relation?
```

組織情報のSource of TruthはHRISや業務DBに置き、OpenFGAはauthorization/relationship projectionとして利用する。

### 7.5 One generic Workflow interprets many policies

PolicyごとにWorkflowのコードを生成しない。

```text
Generic ActionWorkflow
        ↓
  Flow Interpreter
        ↓
 Materialized Flow
```

例えば次のすべてを同じruntimeで処理する。

```text
Action A
Manager

Action B
Manager → Finance

Action C
Security AND Legal
```

### 7.6 Human and AI use the same model

AI Agentによる操作も特殊ケースにしない。

```text
AI Agent
   ↓
Caller confirmation
   ↓
Manager approval
   ↓
Execute Tool
```

これは`execution_consent`と`business_approval`という通常のApproval Stepとして表現できる。

これによりAI専用のHuman-in-the-loop基盤を別途構築する必要がない。

---

## 8. High-level Architecture

```text
Application / AI Agent / MCP
             │
             ▼
        ActionRequest
             │
             ▼
       ActionAuthorizer
          │      │
       deny     allow
                  │
                  ▼
          Approval Policies
                  │
            ┌─────┴─────┐
          none          Flow
            │             │
            │             ▼
            │      Generic Workflow
            │             │
            │      Human Decisions
            │             │
            └──────┬──────┘
                   ▼
            Re-Authorization
                   │
                   ▼
             ActionExecutor
                   │
                   ▼
                Result
```

周辺では次を利用する。

| Component            | Responsibility                          |
| -------------------- | --------------------------------------- |
| OpenFGA              | authorization / relationship resolution |
| D1                   | policy, audit, read model               |
| Cloudflare Workflows | durable approval execution              |
| Queues               | notification / asynchronous integration |

Domain Coreはこれらの具体製品には依存しない。

---

## 9. Example: ticket priority change

Ticket `T-123` のpriorityをCriticalへ変更するとする。

Applicationからは次のActionRequestを送る。

```text
POST ActionRequest

action = ticket.priority.change
resource = ticket:T-123
priority = critical
```

Approval Platformはまず、そのユーザーがpriorityを変更可能かAuthorizationする。

Policyには次が定義されている。

```text
priority == critical
→ Incident Manager approval
```

Incident ManagerをRelationship Resolverで解決し、Approval Taskを生成する。

Managerが承認した後、priority変更権限をもう一度確認し、その時点でも許可されていればActionExecutorがTicketを更新する。

Ticket Application自身は、Approval table、Approval state machine、Manager lookup、Retry、Approval sequencingを実装しない。

---

## 10. Alternatives Considered

### 10.1 Applicationごとに実装する

最初の実装コストは最小。

一方、ルール・監査・委任・AI対応がApplicationごとに重複する。単純なプロダクトで承認要件が1〜2個しかない場合はこちらが合理的だが、複数業務へ展開する場合にはスケールしない。

### 10.2 OpenFGAだけで実装する

OpenFGAは「誰がこのActionを行えるか」の表現には適している。

しかし次のような、時間と状態を伴う承認プロセスの実行主体にはならない。

```text
Manager
  ↓
Finance
  ↓
2 of 3 Security members
```

AuthorizationとApprovalの意味も異なるため、同じPolicy modelへ統合しない。

### 10.3 汎用Workflow / BPMN Engineを利用する

非常に柔軟だが、今回必要な問題より抽象度が高い。

任意Workflowを許すことでDeterminism、Policy validation、Security analysis、GUI complexityも大きくなる。本プロジェクトではApprovalに必要なFlowへ意図的に機能を限定する。

### 10.4 PolicyごとにWorkflow codeを生成する

Runtimeは単純になる一方、Policy変更にdeployが必要になり、tenant-specific codeとversion管理が複雑になるため採用しない。

---

## 11. Key Design Decisions

| Decision                         | Rationale                                |
| -------------------------------- | ---------------------------------------- |
| ActionRequestを共通入口にする    | Approvalの有無をcallerが意識しなくてよい |
| AuthorizationとApprovalを分離    | Approvalによる権限昇格を防止             |
| PolicyをJSON AST化               | Versioning、GUI、監査再現性              |
| OpenFGAをrelation resolverに利用 | 組織・resource relationshipとFlowを分離  |
| Generic Workflowを1つだけ持つ    | Policyごとのcode/deployを避ける          |
| 実行直前にRe-Authorization       | 長時間待機中の権限変更へ対応             |
| Published Policyをimmutable化    | 過去判断を再現可能にする                 |
| fail closedを原則とする          | approver解決不能等で承認を迂回させない   |
| CoreをCloudflare/FGA非依存にする | テスト容易性と将来的な移植性             |

---

## 12. Trade-offs

この設計には意図的なコストもある。

第一に、小規模な単一Applicationだけを見ると、専用実装より構成要素が多い。

第二に、Authorization、Approval、Organization、Executionを明確に分離するため、最初にdomain boundaryを理解する必要がある。

第三に、Policyを自由なコードではなくASTへ制限するため、表現できない特殊Workflowが出る可能性がある。

これらは、**任意の柔軟性より、予測可能性・監査可能性・再利用性を優先する**という選択である。

---

## 13. Security Invariants

以下は実装上変更してはならない。

1. AuthorizationでdenyされたActionはApprovalへ進めない。
2. Approvalによって新しいauthorityを取得してはならない。
3. Agentへのdelegationは元のauthorityより強くしてはならない。
4. 実行前には必ずRe-Authorizationする。
5. 承認対象Actionが変更された場合、既存Approvalを再利用しない。
6. approverを解決できない場合は原則denyする。
7. DecisionとPolicy Versionを監査可能に保持する。

---

## 14. Rollout Strategy

最初から全業務へ導入しない。

Phase 1では、比較的分かりやすいActionを対象にする。

```text
Ticket priority change
Ticket state transition
Access grant
AI/MCP tool execution
```

まず以下を安定させる。

```text
none
single approval
serial approval
parallel / quorum
```

その後、次へ広げる。

```text
delegation
dynamic approver
policy management
notifications
```

既存ApplicationはActionExecutor Adapterを1つずつ追加することで段階移行できる。

---

## 15. Success Metrics

このプロジェクトの成功を単に「Workflowが動くこと」では測らない。

以下を確認する。

- 新しいApproval use caseをApplication側のstate machine追加なしで実装できる
- Policy変更だけで承認経路を変更できる
- 同じ承認Policyを複数Actionへ再利用できる
- 過去Actionについて「なぜこの承認経路だったか」を説明できる
- AI AgentとHuman initiated actionで同じ基盤を利用できる
- Authorization bypassや自己承認等の重要invariantを共通テストで保証できる
- Applicationごとのapproval-specific code量が減少する

---

## 16. Risks

### 16.1 基盤の過剰一般化

将来必要になるかもしれないWorkflow機能を先回りしすぎると、汎用BPM Engine化する。

対策として、実際のユースケースから抽象化した機能のみ追加する。

### 16.2 Policy DSLの複雑化

条件式やFlow機能が増えすぎると、新しいProgramming Languageになる。

複雑な計算はAction Definition側でDerived Attributeとして計算し、Policyは判断に集中させる。

### 16.3 Organization modelとの境界

OpenFGAへすべての業務データを入れ始めると責務が崩れる。

HRIS / Application DBをSource of Truthとし、OpenFGAはauthorization用projectionとして利用する。

### 16.4 Platform dependency

Cloudflare WorkflowsやAuth0 FGA固有機能にCore modelが引っ張られる可能性がある。

Port / Adapter境界を維持する。

---

## 17. Open Questions

実装を進めながら、特に次の項目を検証する。

- Delegation Grantのscope表現
- Break Glass / Post ApprovalをAction modelへどう統合するか
- Partial / Line-item ApprovalをAction分割でどこまで表現できるか
- Policy Editorをどの時点で提供するか
- Approval SLA / Reminder / EscalationをFlow semanticsへどこまで入れるか
- 大規模組織でのdynamic approver candidate projectionの性能
- どの機能までをPlatform標準とし、どこからをApplication-specific extensionとするか

---

## 18. Mental Model

このプロジェクトを最も短く説明するなら、次のようになる。

> **「操作を直接実行する」のではなく、一度Actionとして表現し、そのActionに対して認可と必要な人間判断を共通基盤で適用してから実行する仕組み。**

```text
Before

Application
  ↓
if (...) {
  managerApproval();
}
  ↓
execute();


After

Application
  ↓
ActionRequest
  ↓
Authorization
  ↓
Policy
  ↓
Approval if required
  ↓
Execute
```

個々のApplicationから「承認」という横断的関心事を取り除きながら、Authorization・Human approval・AI delegation・Auditを一貫したモデルで扱えることが、このプロジェクトの価値である。
