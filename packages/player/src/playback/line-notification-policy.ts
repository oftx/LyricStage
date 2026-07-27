export interface LineNotificationDiff {
  readonly enteredLineIds: readonly string[];
  readonly exitedLineIds: readonly string[];
  readonly retainedLineIds: readonly string[];
}

function uniqueInOrder(lineIds: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(lineIds)]);
}

/**
 * Diffs only the current and previous active vectors. Empty is a real current
 * state, so this policy never retains a prior row as a fallback.
 */
export function diffLineNotifications(
  currentLineIdsInSourceOrder: readonly string[],
  previousLineIdsInSourceOrder: readonly string[],
): LineNotificationDiff {
  const current = uniqueInOrder(currentLineIdsInSourceOrder);
  const previous = uniqueInOrder(previousLineIdsInSourceOrder);
  const currentSet = new Set(current);
  const previousSet = new Set(previous);

  return Object.freeze({
    enteredLineIds: Object.freeze(
      current.filter((lineId) => !previousSet.has(lineId)),
    ),
    exitedLineIds: Object.freeze(
      previous.filter((lineId) => !currentSet.has(lineId)),
    ),
    retainedLineIds: Object.freeze(
      current.filter((lineId) => previousSet.has(lineId)),
    ),
  });
}
