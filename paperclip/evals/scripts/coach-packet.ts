import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clusterFailures } from "../src/coach.js";
import { readLedgerEntries } from "../src/ledger.js";

function flagValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

async function main(): Promise<void> {
  const agentFilter = flagValue("--agent");
  const dirOverride = flagValue("--dir");
  const ledgerDir = dirOverride ?? join(dirname(fileURLToPath(import.meta.url)), "..", "ledger");

  const all = await readLedgerEntries(ledgerDir);
  const entries = agentFilter ? all.filter((e) => e.agentId === agentFilter) : all;
  const clusters = clusterFailures(entries);

  console.log(JSON.stringify({ ledgerDir, totalEntries: entries.length, clusters }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
