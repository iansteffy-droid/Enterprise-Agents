export type RoleFlowClassification = "bottleneck" | "backlogged" | "keeping_up";

export interface RoleFlowMetrics {
  busyMs: number;
  queueDepth: number;
  waitP90Ms: number | null;
  flowRatio: number | null;
}

export interface RoleFlowThresholds {
  medianBusyMs: number;
  medianWaitP90Ms: number | null;
}

/**
 * Classify a role's flow state relative to the other roles.
 *
 * Deliberately relative (cross-role medians) rather than absolute hour
 * thresholds, which vary per company. Only `bottleneck` argues for hiring more
 * agents of the role: it requires the role to be both busy (above median) and
 * genuinely falling behind (flow ratio < 1) with work waiting on it.
 */
export function classifyRole(
  metrics: RoleFlowMetrics,
  thresholds: RoleFlowThresholds,
): RoleFlowClassification {
  const fallingBehind = metrics.flowRatio !== null && metrics.flowRatio < 1;
  const isBusy = metrics.busyMs > thresholds.medianBusyMs;
  const waitHigh =
    metrics.waitP90Ms !== null &&
    thresholds.medianWaitP90Ms !== null &&
    metrics.waitP90Ms > thresholds.medianWaitP90Ms;

  if (fallingBehind && isBusy && (metrics.queueDepth > 0 || waitHigh)) {
    return "bottleneck";
  }

  const hasPressure = fallingBehind || metrics.queueDepth > 0;
  if (hasPressure && !isBusy) {
    return "backlogged";
  }

  return "keeping_up";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Cross-role medians used as relative thresholds by {@link classifyRole}. */
export function roleFlowThresholds(
  roles: Array<{ busyMs: number; waitP90Ms: number | null }>,
): RoleFlowThresholds {
  const waits = roles
    .map((role) => role.waitP90Ms)
    .filter((wait): wait is number => wait !== null);
  return {
    medianBusyMs: median(roles.map((role) => role.busyMs)),
    medianWaitP90Ms: waits.length > 0 ? median(waits) : null,
  };
}
