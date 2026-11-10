// server/src/services/wait-time.ts

/** Total ms of the UNION of `intervals` intersected with [windowStart, windowEnd]. */
export function pausedOverlapMs(
  windowStart: Date,
  windowEnd: Date,
  intervals: { startedAt: Date; endedAt: Date | null }[],
  now: Date,
): number {
  const winStart = windowStart.getTime();
  const winEnd = windowEnd.getTime();
  if (winEnd <= winStart) return 0;

  // Clip each interval to the window; drop empties.
  const clipped = intervals
    .map((iv) => {
      const s = Math.max(winStart, iv.startedAt.getTime());
      const e = Math.min(winEnd, (iv.endedAt ?? now).getTime());
      return [s, e] as const;
    })
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  // Merge overlapping/adjacent ranges and sum their lengths.
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of clipped) {
    if (curEnd === -1) {
      curStart = s;
      curEnd = e;
    } else if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  if (curEnd !== -1) total += curEnd - curStart;
  return total;
}

/** Postgres-compatible continuous percentile (linear interpolation). */
export function percentileCont(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lower = Math.floor(rank);
  const frac = rank - lower;
  if (lower + 1 >= sorted.length) return sorted[lower];
  return sorted[lower] + frac * (sorted[lower + 1] - sorted[lower]);
}
