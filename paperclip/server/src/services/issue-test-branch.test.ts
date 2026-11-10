import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { branchNamesIssue, resolveIssueTestBranch } from "./issue-test-branch.js";

/**
 * The shared-workspace convention names branches `pc/<ISSUE-KEY>-<slug>`, so the
 * ticket key must match as a delimited token — never as a prefix of a longer
 * number (ACME-304 must not claim ACME-3040's branch).
 */
describe("branchNamesIssue", () => {
  it("matches the ticket's own convention branch", () => {
    expect(branchNamesIssue("pc/ACME-304-ci-shard-shard", "ACME-304")).toBe(true);
    expect(branchNamesIssue("origin/pc/ACME-304-ci-shard-shard", "ACME-304")).toBe(true);
    expect(branchNamesIssue("ACME-304", "ACME-304")).toBe(true);
  });

  it("does not match a longer ticket number that shares the prefix", () => {
    expect(branchNamesIssue("pc/ACME-3040-something", "ACME-304")).toBe(false);
    expect(branchNamesIssue("pc/ACME-3049", "ACME-304")).toBe(false);
  });

  it("does not match an unrelated ticket", () => {
    expect(branchNamesIssue("pc/ACME-401-other", "ACME-304")).toBe(false);
    expect(branchNamesIssue("main", "ACME-304")).toBe(false);
  });

  it("is case-insensitive on the key", () => {
    expect(branchNamesIssue("pc/acme-304-lower", "ACME-304")).toBe(true);
  });
});

/**
 * Fake just enough of the Drizzle query chain for the workspace lookup.
 * `resultsPerCall` feeds successive `db.select()...limit()` invocations —
 * first the issue's own workspace rows, then each ancestor's during the
 * parent-chain walk.
 */
function fakeDb(resultsPerCall: Array<Array<{ branchName: string | null; cwd: string | null }>>): Db {
  let call = 0;
  const rows = () => Promise.resolve(resultsPerCall[call++] ?? []);
  return {
    select: () => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: rows }) }) }),
    }),
  } as unknown as Db;
}

function git(cwd: string, args: string[], committerDate?: string): void {
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    env: committerDate
      ? { ...process.env, GIT_COMMITTER_DATE: committerDate, GIT_AUTHOR_DATE: committerDate }
      : process.env,
    stdio: "ignore",
  });
}

describe("resolveIssueTestBranch", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "issue-test-branch-"));
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["commit", "--allow-empty", "-m", "base"], "2026-08-01T10:00:00Z");
    git(repo, ["branch", "pc/ACME-290-arbeitsplatz-stale-login-validation"]);
    git(repo, ["checkout", "-q", "-b", "pc/ACME-290-arbeitsplatz-stale-refix"]);
    git(repo, ["commit", "--allow-empty", "-m", "refix"], "2026-08-17T10:00:00Z");
    git(repo, ["checkout", "-q", "main"]);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("falls back to the parent's branch for a subticket worked under the parent-branch rule", async () => {
    const parent = {
      id: "par-1",
      companyId: "co-1",
      identifier: "ACME-290",
      executionWorkspaceId: null,
      projectWorkspaceId: null,
      parentId: null,
    };
    const result = await resolveIssueTestBranch({
      db: fakeDb([[], [{ branchName: null, cwd: repo }]]),
      issue: {
        id: "sub-1",
        companyId: "co-1",
        identifier: "ACME-322",
        executionWorkspaceId: null,
        projectWorkspaceId: null,
        parentId: "par-1",
      },
      getWorkspace: async () => null,
      getProjectWorkspace: async () => null,
      getIssue: async (id) => (id === "par-1" ? parent : null),
    });
    expect(result).toEqual({
      branch: "pc/ACME-290-arbeitsplatz-stale-refix",
      source: "git",
      via: "ACME-290",
    });
  });

  it("prefers the ticket's most recently committed branch and reports via null for its own", async () => {
    const result = await resolveIssueTestBranch({
      db: fakeDb([[{ branchName: null, cwd: repo }]]),
      issue: {
        id: "own-1",
        companyId: "co-1",
        identifier: "ACME-290",
        executionWorkspaceId: null,
        projectWorkspaceId: null,
        parentId: null,
      },
      getWorkspace: async () => null,
      getProjectWorkspace: async () => null,
      getIssue: async () => null,
    });
    expect(result).toEqual({
      branch: "pc/ACME-290-arbeitsplatz-stale-refix",
      source: "git",
      via: null,
    });
  });

  it("never surfaces a branch from an ancestor in another company", async () => {
    const foreignParent = {
      id: "par-2",
      companyId: "co-OTHER",
      identifier: "ACME-290",
      executionWorkspaceId: null,
      projectWorkspaceId: null,
      parentId: null,
    };
    const result = await resolveIssueTestBranch({
      db: fakeDb([[], [{ branchName: null, cwd: repo }]]),
      issue: {
        id: "sub-2",
        companyId: "co-1",
        identifier: "ACME-322",
        executionWorkspaceId: null,
        projectWorkspaceId: null,
        parentId: "par-2",
      },
      getWorkspace: async () => null,
      getProjectWorkspace: async () => null,
      getIssue: async (id) => (id === "par-2" ? foreignParent : null),
    });
    expect(result).toEqual({ branch: null, source: null, via: null });
  });
});

/**
 * A shared-workspace ticket that never had an execution workspace record has no
 * cwd of its own, so the git scan used to be skipped entirely and the operator
 * lost the branch chip. The project's own workspace is the repo the
 * crew worked in — fall back to it.
 */
describe("resolveIssueTestBranch — project workspace fallback", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "issue-test-branch-pw-"));
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["commit", "--allow-empty", "-m", "base"], "2026-09-01T10:00:00Z");
    git(repo, ["branch", "pc/ACME-484-toolbar-loading-indicator"]);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("scans the project workspace repo when the ticket has no execution workspace", async () => {
    const result = await resolveIssueTestBranch({
      db: fakeDb([[]]),
      issue: {
        id: "own-pw",
        companyId: "co-1",
        identifier: "ACME-484",
        executionWorkspaceId: null,
        projectWorkspaceId: "pw-1",
        parentId: null,
      },
      getWorkspace: async () => null,
      getProjectWorkspace: async (id) => (id === "pw-1" ? { cwd: repo } : null),
      getIssue: async () => null,
    });

    expect(result).toEqual({
      branch: "pc/ACME-484-toolbar-loading-indicator",
      source: "git",
      via: null,
    });
  });

  it("falls back to the parent's project workspace for a subticket", async () => {
    const parent = {
      id: "par-pw",
      companyId: "co-1",
      identifier: "ACME-484",
      executionWorkspaceId: null,
      projectWorkspaceId: "pw-1",
      parentId: null,
    };
    const result = await resolveIssueTestBranch({
      db: fakeDb([[], []]),
      issue: {
        id: "sub-pw",
        companyId: "co-1",
        identifier: "ACME-485",
        executionWorkspaceId: null,
        projectWorkspaceId: null,
        parentId: "par-pw",
      },
      getWorkspace: async () => null,
      getProjectWorkspace: async (id) => (id === "pw-1" ? { cwd: repo } : null),
      getIssue: async (id) => (id === "par-pw" ? parent : null),
    });

    expect(result).toEqual({
      branch: "pc/ACME-484-toolbar-loading-indicator",
      source: "git",
      via: "ACME-484",
    });
  });
});
