import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

export class InvalidUriComponentError extends ErrorFactory({
  name: "InvalidUriComponentError",
  message: "URI componentのpercent-encodingが不正です",
  fields: ErrorFactory.fields<{ code: "invalid_uri_component" }>(),
}) {}

/**
 * `decodeURIComponent`はpercent-encodingが不正だと`URIError`を投げる。境界（HTTP path、
 * service bindingのpath等）では必ずこの関数を通し、失敗をResultで扱う（直接呼び出しはlintで禁止）。
 */
export const decodeUriComponent = Result.fn({
  try: (value: string): string => decodeURIComponent(value),
  catch: (): InvalidUriComponentError =>
    new InvalidUriComponentError({ code: "invalid_uri_component" }),
});
