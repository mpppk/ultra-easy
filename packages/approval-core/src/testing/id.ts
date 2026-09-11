import { Result } from "@praha/byethrow";

export class DeterministicIdExhaustedError extends Error {
  readonly name = "DeterministicIdExhaustedError";
}

export interface DeterministicIdGenerator<Id extends string> {
  next(): Result.Result<Id, DeterministicIdExhaustedError>;
}

/**
 * テストで予測可能な順序でIDを払い出す。
 * 用意したIDを使い切った場合はFailureを返し、意図しない追加生成を検出する。
 */
export function createDeterministicIdGenerator<Id extends string>(
  ids: readonly Id[],
): DeterministicIdGenerator<Id> {
  let index = 0;

  return {
    next(): Result.Result<Id, DeterministicIdExhaustedError> {
      const id = ids[index];

      if (id === undefined) {
        return Result.fail(new DeterministicIdExhaustedError("deterministic IDを使い切りました"));
      }

      index += 1;
      return Result.succeed(id);
    },
  };
}
