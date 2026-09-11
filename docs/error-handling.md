# エラー処理方針

このプロジェクトでは、失敗可能な処理を型として追跡できるようにするため、`throw`文を使用しない。

## 基本方針

- 同期処理の失敗は原則として`@praha/byethrow`の`Result`で表現する。
- 非同期処理の失敗は原則として`ResultAsync`で表現する。
- `Error`の派生classは型付きの失敗値として利用してよいが、`throw`しない。
- Promise、外部SDK、標準APIなど例外を投げうる境界は`Result.fn`等で捕捉し、domainまたはadapter固有の型付きerrorへ変換する。
- 呼び出し側が処理可能な失敗を例外として隠蔽せず、戻り値の型に含める。

## Lintによる強制

Oxlintの`no-restricted-syntax`で`ThrowStatement`をリポジトリ全体から禁止する。production codeだけでなく、test、fixture、testing helperも対象とする。

`@praha/byethrow-oxlint`のルールも併用し、Byethrow利用時の誤用を検出する。

CIでは`vp check`を実行し、`throw`文が追加された場合は失敗させる。

## 境界での例外変換

例外を投げうるAPIを呼び出す場合、その例外をそのまま上位へ伝播させない。境界でByethrowへ変換する。

```ts
import { Result } from "@praha/byethrow";

const parseJson = Result.fn({
  try: (value: string): unknown => JSON.parse(value),
  catch: (error) => new JsonParseError(error),
});
```

この方針により、core domainからadapterまで「どの失敗が起こりうるか」をTypeScriptの型として確認できる状態を維持する。
