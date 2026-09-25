# エラー処理方針

このプロジェクトでは、失敗可能な処理を型として追跡できるようにするため、`throw`文を使用しない。

## 基本方針

- 同期処理の失敗は原則として`@praha/byethrow`の`Result`で表現する。
- 非同期処理の失敗は原則として`ResultAsync`で表現する。
- 呼び出し側が処理可能な失敗は`@praha/error-factory`で定義したカスタムErrorをFailure値として返す。
- カスタムErrorは`throw`せず、`Result.fail(error)`で返す。
- Promise、外部SDK、標準APIなど例外を投げうる境界は`Result.fn`等で捕捉し、domainまたはadapter固有のカスタムErrorへ変換する。
- 呼び出し側が処理可能な失敗を例外として隠蔽せず、戻り値の型に含める。

## カスタムErrorの設計

カスタムErrorは`ErrorFactory`で定義し、`name`を必ずliteralで明示する。これにより、呼び出し側は`instanceof`だけでなく`error.name`によるdiscriminated unionとしても安全に分岐できる。

```ts
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

class ResourceNotFoundError extends ErrorFactory({
  name: "ResourceNotFoundError",
  message: ({ resourceId }) => `resourceが見つかりません: ${resourceId}`,
  fields: ErrorFactory.fields<{
    code: "resource_not_found";
    resourceId: string;
  }>(),
}) {}

function findResource(resourceId: string): Result.Result<string, ResourceNotFoundError> {
  return Result.fail(
    new ResourceNotFoundError({
      code: "resource_not_found",
      resourceId,
    }),
  );
}
```

公開operationごとに、そのoperationから返り得るError classのunionを定義する。システム全体のErrorを1つの巨大unionへ集約しない。

下位層の失敗を上位層のErrorへ変換する場合は、元のErrorを`cause`へ保持する。上位層から下位Errorの詳細へ型安全にアクセスする必要がある場合は、typed fieldも併せて持たせる。

## Lintによる強制

Oxlintの`no-restricted-syntax`で`ThrowStatement`をリポジトリ全体から禁止する。production codeだけでなく、test、fixture、testing helperも対象とする。

`@praha/byethrow-oxlint`のルールも併用し、Byethrow利用時の誤用を検出する。

CIでは`vp check`を実行し、`throw`文が追加された場合は失敗させる。

`decodeURIComponent` / `decodeURI`は不正なpercent-encodingで`URIError`を投げるため、同じ
`no-restricted-syntax`で直接呼び出しを禁止する。`@app/approval-core`の`decodeUriComponent`（Result）
を使い、HTTP routeでは`pathParameters`（400 `invalid_path_parameter`）を通す。

## HTTPエラーの対応付け

Port（`ActionDefinitionResolver` / `SchemaResolver`等）はPromiseのrejectではなく`ResultAsync`で失敗を返し、
「見つからない（入力誤り・設定不備）」はnull、依存障害だけをerrorにする。HTTP adapterはerror codeから
statusを明示的な対応表で決める（`actionRequestErrorStatus`）。

| 種別                              | status    | 例                                                                                  |
| --------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| 利用者の入力誤り                  | 400 / 422 | `invalid_path_parameter`、`action_type_not_found`、`action_input_validation_failed` |
| 状態競合・重複                    | 409       | `action_request_already_exists`、`idempotency_key_reused`                           |
| 依存障害（retriable）             | 503       | D1 / FGA / Workflowの一時障害                                                       |
| 契約違反・設定不備（非retriable） | 500       | `schema_not_found`、FGAのrelation未定義（`authorization_provider_failed`）          |

応答の`detail`は利用者の入力に由来する安全な文言だけにする。D1・provider・例外のmessageは返さず、
error codeで識別する（最上位のcatchも固定のproblemを返す）。

## 境界での例外変換

例外を投げうるAPIを呼び出す場合、その例外をそのまま上位へ伝播させない。境界でByethrowへ変換する。

```ts
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

class JsonParseError extends ErrorFactory({
  name: "JsonParseError",
  message: "JSONをparseできませんでした。",
}) {}

const parseJson = Result.fn({
  try: (value: string): unknown => JSON.parse(value),
  catch: (error) => new JsonParseError({ cause: error }),
});
```

この方針により、core domainからadapterまで「どの失敗が起こりうるか」と「呼び出し側がどのErrorを識別できるか」をTypeScriptの型として確認できる状態を維持する。
