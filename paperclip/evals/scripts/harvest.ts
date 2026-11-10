import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@paperclipai/db";
import { collectDownvoteFailures } from "../src/collectors/downvotes.js";
import { writeLedgerEntries } from "../src/ledger.js";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const companyId = process.env.PAPERCLIP_COMPANY_ID ?? process.argv[2];
  if (!companyId || companyId.startsWith("--")) {
    throw new Error("companyId required (PAPERCLIP_COMPANY_ID env or first positional arg)");
  }
  const dryRun = process.argv.includes("--dry-run");

  const db = createDb(url);
  const entries = await collectDownvoteFailures(db, companyId);

  if (dryRun) {
    console.log(JSON.stringify(entries, null, 2));
    console.log(`[dry-run] ${entries.length} entr${entries.length === 1 ? "y" : "ies"} found (nothing written)`);
    return;
  }

  const ledgerDir = join(dirname(fileURLToPath(import.meta.url)), "..", "ledger");
  const result = await writeLedgerEntries(ledgerDir, entries);
  console.log(`harvest: ${result.written} new, ${result.skipped} existing -> ${ledgerDir}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
