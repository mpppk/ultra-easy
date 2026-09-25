import { Result } from "@praha/byethrow";

import {
  decodeUriComponent,
  parseBrand,
  type Brand,
  type BrandKind,
  type InvalidUriComponentError,
} from "@app/approval-core";

/**
 * `pattern.exec(pathname)`と同じ形（[0]はmatch全体）で、captureをdecodeして返す。
 * 一致しなければnull、percent-encodingが不正なcaptureがあればerror（400 invalid_path_parameterへ写像する）。
 */
export function matchPathParameters(
  pattern: RegExp,
  pathname: string,
): Result.Result<string[] | null, InvalidUriComponentError> {
  const match = pattern.exec(pathname);
  if (!match) return Result.succeed(null);
  const decoded: string[] = [match[0]];
  for (const capture of match.slice(1)) {
    const value = decodeUriComponent(capture ?? "");
    if (Result.isFailure(value)) return value;
    decoded.push(value.value);
  }
  return Result.succeed(decoded);
}

export function invalidPathParameterResponse(): Response {
  return new Response(
    JSON.stringify({
      type: "urn:ultra-easy:problem:invalid_path_parameter",
      title: "path parameterが不正です",
      status: 400,
      code: "invalid_path_parameter",
    }),
    { status: 400, headers: { "content-type": "application/problem+json" } },
  );
}

type ParameterKind = BrandKind | "string";
type ParameterValue<K extends ParameterKind> = K extends BrandKind ? Brand<string, K> : string;

/**
 * routeのpatternに一致したらcaptureをdecodeし、kindsに従ってbrandへ変換して返す（#96 / #102）。
 * 一致しなければnull、percent-encodingが不正・brandとして不正な値は400 Response。
 */
export function routeParameters<const K extends readonly ParameterKind[]>(
  pattern: RegExp,
  pathname: string,
  kinds: K,
): { [I in keyof K]: ParameterValue<K[I]> } | null | Response {
  const matched = matchPathParameters(pattern, pathname);
  if (Result.isFailure(matched)) return invalidPathParameterResponse();
  if (!matched.value) return null;
  const values: string[] = [];
  for (const [index, kind] of kinds.entries()) {
    const raw = matched.value[index + 1];
    if (kind === "string") {
      if (raw === undefined || raw.length === 0) return invalidPathParameterResponse();
      values.push(raw);
      continue;
    }
    const parsed = parseBrand(kind, raw);
    if (Result.isFailure(parsed)) return invalidPathParameterResponse();
    values.push(parsed.value);
  }
  return values as { [I in keyof K]: ParameterValue<K[I]> };
}
