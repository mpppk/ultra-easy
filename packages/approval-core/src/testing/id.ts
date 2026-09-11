export interface DeterministicIdGenerator<Id extends string> {
  next(): Id;
}

/**
 * テストで予測可能な順序でIDを払い出す。
 * 用意したIDを使い切った場合は、意図しない追加生成を検出するため例外にする。
 */
export function createDeterministicIdGenerator<Id extends string>(
  ids: readonly Id[],
): DeterministicIdGenerator<Id> {
  let index = 0;

  return {
    next(): Id {
      const id = ids[index];

      if (id === undefined) {
        throw new Error("deterministic IDを使い切りました");
      }

      index += 1;
      return id;
    },
  };
}
