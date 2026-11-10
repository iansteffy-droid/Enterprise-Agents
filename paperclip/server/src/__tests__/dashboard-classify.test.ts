import { describe, expect, it } from "vitest";
import { classifyRole, roleFlowThresholds } from "../services/dashboard-classify.ts";

const thresholds = { medianBusyMs: 1_000, medianWaitP90Ms: 500 };

describe("classifyRole", () => {
  it("flags a bottleneck when busy is above median, flow is falling behind, and a queue exists", () => {
    expect(
      classifyRole({ busyMs: 2_000, queueDepth: 3, waitP90Ms: 400, flowRatio: 0.5 }, thresholds),
    ).toBe("bottleneck");
  });

  it("flags a bottleneck driven by high wait even when nothing is queued right now", () => {
    expect(
      classifyRole({ busyMs: 2_000, queueDepth: 0, waitP90Ms: 900, flowRatio: 0.5 }, thresholds),
    ).toBe("bottleneck");
  });

  it("calls it backlogged when there is pressure but the role is not busy (below median)", () => {
    expect(
      classifyRole({ busyMs: 500, queueDepth: 5, waitP90Ms: 900, flowRatio: 0.5 }, thresholds),
    ).toBe("backlogged");
  });

  it("does not flag a bottleneck at exactly the median busy time", () => {
    expect(
      classifyRole({ busyMs: 1_000, queueDepth: 5, waitP90Ms: 900, flowRatio: 0.5 }, thresholds),
    ).toBe("backlogged");
  });

  it("keeps up when flow is healthy and nothing is queued", () => {
    expect(
      classifyRole({ busyMs: 2_000, queueDepth: 0, waitP90Ms: 100, flowRatio: 1.2 }, thresholds),
    ).toBe("keeping_up");
  });

  it("does not claim a bottleneck when flow ratio is unknown (no issues created in window)", () => {
    expect(
      classifyRole({ busyMs: 2_000, queueDepth: 3, waitP90Ms: 900, flowRatio: null }, thresholds),
    ).toBe("keeping_up");
  });

  it("treats a queue with below-median busy and unknown flow as backlogged", () => {
    expect(
      classifyRole({ busyMs: 100, queueDepth: 3, waitP90Ms: null, flowRatio: null }, thresholds),
    ).toBe("backlogged");
  });
});

describe("roleFlowThresholds", () => {
  it("computes the median busy time across roles", () => {
    const t = roleFlowThresholds([
      { busyMs: 100, waitP90Ms: null },
      { busyMs: 300, waitP90Ms: null },
      { busyMs: 200, waitP90Ms: null },
    ]);
    expect(t.medianBusyMs).toBe(200);
  });

  it("computes the median wait ignoring null waits, and is null when no waits exist", () => {
    expect(
      roleFlowThresholds([
        { busyMs: 0, waitP90Ms: 400 },
        { busyMs: 0, waitP90Ms: null },
        { busyMs: 0, waitP90Ms: 800 },
      ]).medianWaitP90Ms,
    ).toBe(600);
    expect(
      roleFlowThresholds([{ busyMs: 0, waitP90Ms: null }]).medianWaitP90Ms,
    ).toBeNull();
  });
});
