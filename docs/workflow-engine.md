# Workflow Engine — Governed Business Workflow / Composite Action

Parent: [#154](https://github.com/mpppk/ultra-easy/issues/154) / 実装計画: [#164](https://github.com/mpppk/ultra-easy/issues/164)

ultra-easyの **Action Catalog / Authorization / Delegation / Approval / ActionExecutor** を業務フローの
実行基盤として再利用し、Workflow自体をAction Catalog上の **Composite Action** として扱う。
本書は実装済みの契約（contract）と不変条件（invariant）を記録する。

## Package layout

```text
packages/
  expression-core/   # #155 Approval / Workflow / Delegationで共有する属性式（pure）
```

依存方向:

```text
workflow -> ultra-easy Action boundary   OK
approval -> workflow                     NG
approval -> expression-core              OK（共有言語）
```

## Expression Engine (#155)

`@app/expression-core` は `Condition` / `ValueExpression` / `ValueTemplate` と、その評価器を持つ。

- comparison（eq / ne / gt / gte / lt / lte）、and / or / not / in / contains
- 評価器はpure / deterministic。値は注入された `FieldResolver` が外部I/O解決済みの固定contextから返す。
  lint（`no-restricted-imports`）で `@praha/*` 以外への依存を禁止し、I/Oを持ち込めないようにしている。
- field欠落・型不一致・許可外path・unsafe path（`__proto__` / `prototype` / `constructor`）・
  JSON-safeでない値はすべて **error**（fail-closed）。「条件不成立」とは区別する。
- `FieldNamespacePolicy` でbounded contextごとに参照可能範囲を制限する。評価器はnamespaceを知らない。

| Context    | 参照可能namespace                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| approval   | `action.input.*` `actor.*` `authority.*` `origin.*` `organization.settings.*` `attributes.*` `now`                                               |
| workflow   | `workflow.input.*` `variables.*` `nodes.<nodeId>.output.*` `loop.item(.*)` `loop.index` `actor.*` `organization.settings.*` `attributes.*` `now` |
| delegation | `action.type` `action.resource.type` `action.resource.id` `action.input.*` `actor.*` `origin.*` `now`                                            |

Approvalは `approvalFieldResolver`（approval-core）を通じて共有評価器を使い、既存の
`Policy*Error` contractへ写像する（既存Approval semanticsは不変）。

UI（Condition Builder / field picker）は `describeFieldCatalog(policy, fields)` が返す
`FieldCatalogView`（namespace一覧 + 型付きfield）でcontextごとの参照可能fieldを列挙する。
