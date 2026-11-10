import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LedgerEntry, LedgerStatus } from "./types.js";

function fileNameFor(entry: LedgerEntry): string {
  const safe = entry.id.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  return `${safe}.json`;
}

/**
 * Writes each entry as its own JSON file in `dir`. Idempotent: an entry whose
 * file already exists is skipped (never overwritten). Returns write/skip counts.
 */
export async function writeLedgerEntries(
  dir: string,
  entries: LedgerEntry[],
): Promise<{ written: number; skipped: number }> {
  await mkdir(dir, { recursive: true });
  const existing = new Set((await readdir(dir)).filter((f) => f.endsWith(".json")));
  let written = 0;
  let skipped = 0;
  for (const entry of entries) {
    const name = fileNameFor(entry);
    if (existing.has(name)) {
      skipped++;
      continue;
    }
    await writeFile(join(dir, name), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    existing.add(name);
    written++;
  }
  return { written, skipped };
}

/** Reads all ledger entries from `dir`. Returns [] if the directory does not exist. */
export async function readLedgerEntries(dir: string): Promise<LedgerEntry[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const entries: LedgerEntry[] = [];
  for (const name of names.sort()) {
    const raw = await readFile(join(dir, name), "utf8");
    entries.push(JSON.parse(raw) as LedgerEntry);
  }
  return entries;
}

/** Sets the status of the entry with the given id. Returns true if found and updated. */
export async function setLedgerEntryStatus(dir: string, id: string, status: LedgerStatus): Promise<boolean> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
  for (const name of names) {
    const path = join(dir, name);
    const entry = JSON.parse(await readFile(path, "utf8")) as LedgerEntry;
    if (entry.id === id) {
      entry.status = status;
      await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
      return true;
    }
  }
  return false;
}
