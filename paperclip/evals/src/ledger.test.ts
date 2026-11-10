import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeLedgerEntries, readLedgerEntries, setLedgerEntryStatus } from "./ledger.js";
import type { LedgerEntry } from "./types.js";

const entry: LedgerEntry = {
  id: "downvote:11111111-1111-1111-1111-111111111111",
  agentId: "agent-1",
  agentName: "Engineer",
  signalType: "downvote",
  issueId: "issue-1",
  runId: "run-1",
  reason: "wrong answer",
  traceRef: null,
  detectedAt: "2026-07-08T00:00:00.000Z",
  status: "new",
};

describe("writeLedgerEntries", () => {
  it("writes one json file per new entry and is idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-ledger-"));

    const first = await writeLedgerEntries(dir, [entry]);
    expect(first).toEqual({ written: 1, skipped: 0 });

    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const parsed = JSON.parse(await readFile(join(dir, files[0]!), "utf8"));
    expect(parsed.id).toBe(entry.id);
    expect(parsed.signalType).toBe("downvote");

    const second = await writeLedgerEntries(dir, [entry]);
    expect(second).toEqual({ written: 0, skipped: 1 });
    expect((await readdir(dir)).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  });
});

describe("readLedgerEntries", () => {
  it("returns [] for a missing directory", async () => {
    const dir = join(tmpdir(), "evals-ledger-does-not-exist-xyz");
    expect(await readLedgerEntries(dir)).toEqual([]);
  });

  it("round-trips entries written by writeLedgerEntries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-ledger-read-"));
    const e: LedgerEntry = {
      id: "downvote:aaa",
      agentId: "agent-1",
      agentName: "Engineer",
      signalType: "downvote",
      issueId: "issue-1",
      runId: "run-1",
      reason: "bad",
      traceRef: null,
      detectedAt: "2026-07-08T00:00:00.000Z",
      status: "new",
    };
    await writeLedgerEntries(dir, [e]);
    const read = await readLedgerEntries(dir);
    expect(read).toHaveLength(1);
    expect(read[0]).toEqual(e);
  });
});

describe("setLedgerEntryStatus", () => {
  it("updates the matching entry's status and returns true; false when not found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-ledger-status-"));
    const e: LedgerEntry = {
      id: "downvote:bbb",
      agentId: "agent-1",
      agentName: null,
      signalType: "downvote",
      issueId: "issue-2",
      runId: null,
      reason: null,
      traceRef: null,
      detectedAt: "2026-07-08T00:00:00.000Z",
      status: "new",
    };
    await writeLedgerEntries(dir, [e]);

    expect(await setLedgerEntryStatus(dir, "downvote:bbb", "fixed")).toBe(true);
    const read = await readLedgerEntries(dir);
    expect(read[0]!.status).toBe("fixed");

    expect(await setLedgerEntryStatus(dir, "downvote:missing", "fixed")).toBe(false);
  });
});
