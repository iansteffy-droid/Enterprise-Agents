// server/src/__tests__/wait-time.test.ts
import { describe, expect, it } from "vitest";
import { pausedOverlapMs, percentileCont } from "../services/wait-time.ts";

const d = (iso: string) => new Date(iso);
const NOW = d("2026-07-09T00:00:00.000Z");

describe("pausedOverlapMs", () => {
  it("clips an interval to the window", () => {
    // window 00:00–02:00, pause 01:00–03:00 -> overlap 01:00–02:00 = 1h
    const ms = pausedOverlapMs(
      d("2026-07-01T00:00:00Z"),
      d("2026-07-01T02:00:00Z"),
      [{ startedAt: d("2026-07-01T01:00:00Z"), endedAt: d("2026-07-01T03:00:00Z") }],
      NOW,
    );
    expect(ms).toBe(60 * 60 * 1000);
  });

  it("unions overlapping intervals without double-counting", () => {
    // 00:00–02:00 and 01:00–03:00 union to 00:00–03:00; window 00:00–04:00 -> 3h
    const ms = pausedOverlapMs(
      d("2026-07-01T00:00:00Z"),
      d("2026-07-01T04:00:00Z"),
      [
        { startedAt: d("2026-07-01T00:00:00Z"), endedAt: d("2026-07-01T02:00:00Z") },
        { startedAt: d("2026-07-01T01:00:00Z"), endedAt: d("2026-07-01T03:00:00Z") },
      ],
      NOW,
    );
    expect(ms).toBe(3 * 60 * 60 * 1000);
  });

  it("treats an open interval as ending now", () => {
    const ms = pausedOverlapMs(
      d("2026-07-08T22:00:00Z"),
      d("2026-07-09T02:00:00Z"), // window end after NOW
      [{ startedAt: d("2026-07-08T23:00:00Z"), endedAt: null }],
      NOW, // 2026-07-09T00:00:00Z
    );
    // overlap 23:00–00:00 (clamped at NOW) = 1h
    expect(ms).toBe(60 * 60 * 1000);
  });

  it("returns 0 when no interval overlaps the window", () => {
    const ms = pausedOverlapMs(
      d("2026-07-01T00:00:00Z"),
      d("2026-07-01T01:00:00Z"),
      [{ startedAt: d("2026-07-02T00:00:00Z"), endedAt: d("2026-07-02T01:00:00Z") }],
      NOW,
    );
    expect(ms).toBe(0);
  });
});

describe("percentileCont", () => {
  it("matches Postgres percentile_cont on [10,20,30] minutes", () => {
    const vals = [600_000, 1_200_000, 1_800_000];
    expect(percentileCont(vals, 0.5)).toBe(1_200_000);
    expect(percentileCont(vals, 0.9)).toBe(1_680_000);
  });

  it("returns null for empty input", () => {
    expect(percentileCont([], 0.5)).toBeNull();
  });
});
