import { Result } from "@praha/byethrow";

import { decodeUriComponent, type InvalidUriComponentError } from "@app/approval-core";

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

/** routeのpatternに一致したらdecode済みcapture、一致しなければnull、decode失敗は400 Response。 */
export function pathParameters(pattern: RegExp, pathname: string): string[] | null | Response {
  const matched = matchPathParameters(pattern, pathname);
  return Result.isFailure(matched) ? invalidPathParameterResponse() : matched.value;
}
