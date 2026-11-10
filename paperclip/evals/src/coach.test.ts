import { describe, expect, it } from "vitest";
import { clusterFailures } from "./coach.js";
import type { LedgerEntry } from "./types.js";

function entry(over: Partial<LedgerEntry> & Pick<LedgerEntry, "id" | "agentId">): LedgerEntry {
  return {
    agentName: null,
    signalType: "downvote",
    issueId: "i",
    runId: null,
    reason: null,
    traceRef: null,
    detectedAt: "2026-07-08T00:00:00.000Z",
    status: "new",
    ...over,
  };
}

describe("clusterFailures", () => {
  it("groups by agentId+signalType and sorts by count desc", () => {
    const clusters = clusterFailures([
      entry({ id: "1", agentId: "a", agentName: "Ann" }),
      entry({ id: "2", agentId: "a", agentName: "Ann" }),
      entry({ id: "3", agentId: "b", agentName: "Bob" }),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ agentId: "a", agentName: "Ann", signalType: "downvote", count: 2 });
    expect(clusters[0]!.entries.map((e) => e.id)).toEqual(["1", "2"]);
    expect(clusters[1]).toMatchObject({ agentId: "b", count: 1 });
  });

  it("returns [] for no entries", () => {
    expect(clusterFailures([])).toEqual([]);
  });
});
