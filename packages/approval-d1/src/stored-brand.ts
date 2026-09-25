import { Result } from "@praha/byethrow";

import { parseBrand, parseBrands, type Brand, type BrandKind } from "@app/approval-core";

/**
 * D1 rowの識別子列をsmart constructorでbrandへ変換する（#102）。自分たちが書いた値でも
 * 検証を通し、壊れた値はrepositoryのerrorへ写像する（castで素通りさせない）。
 */
export function storedBrand<K extends BrandKind, E extends Error>(
  kind: K,
  value: unknown,
  toError: (message: string) => E,
): Result.Result<Brand<string, K>, E> {
  const parsed = parseBrand(kind, value);
  // EがPromiseでないことを型引数では表現できないため、failureの型だけ明示する。
  const failure = Result.fail(toError(`保存済みの${kind}が不正です`)) as Result.Result<never, E>;
  return Result.isFailure(parsed) ? failure : parsed;
}

export function storedBrands<K extends BrandKind, E extends Error>(
  kind: K,
  values: readonly unknown[],
  toError: (message: string) => E,
): Result.Result<Brand<string, K>[], E> {
  const parsed = parseBrands(kind, values);
  // EがPromiseでないことを型引数では表現できないため、failureの型だけ明示する。
  const failure = Result.fail(toError(`保存済みの${kind}が不正です`)) as Result.Result<never, E>;
  return Result.isFailure(parsed) ? failure : parsed;
}
