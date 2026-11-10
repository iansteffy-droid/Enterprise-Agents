import type { LedgerEntry, LedgerSignalType } from "./types.js";

export type FailureCluster = {
  agentId: string;
  agentName: string | null;
  signalType: LedgerSignalType;
  count: number;
  entries: LedgerEntry[];
};

/** Groups ledger entries by (agentId, signalType), most-failures-first. */
export function clusterFailures(entries: LedgerEntry[]): FailureCluster[] {
  const byKey = new Map<string, FailureCluster>();
  for (const e of entries) {
    const key = `${e.agentId}::${e.signalType}`;
    let cluster = byKey.get(key);
    if (!cluster) {
      cluster = { agentId: e.agentId, agentName: e.agentName, signalType: e.signalType, count: 0, entries: [] };
      byKey.set(key, cluster);
    }
    cluster.count += 1;
    cluster.entries.push(e);
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.agentId.localeCompare(b.agentId));
}
