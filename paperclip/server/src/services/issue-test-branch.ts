import { execFile } from "node:child_process";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces } from "@paperclipai/db";

/**
 * The branch an operator can check out to test a ticket.
 *
 * Three realities in this org:
 *  - Isolated/worktree tickets record their branch structurally on the
 *    execution workspace (`branchName`).
 *  - The crew's default is `shared_workspace` mode, where the branch is NOT on
 *    any Paperclip record — agents follow the self-driving convention
 *    `pc/<ISSUE-KEY>-<slug>` with raw git inside the shared repo (see the
 *    check-repair-branch route). For those we resolve the real git branch by
 *    scanning the project's repo for a ref that names the ticket — the repo
 *    comes from the ticket's execution workspace, or from the project workspace
 *    when the crew never created one.
 *  - Subtickets follow the parent-branch rule: work lands on the PARENT's
 *    branch, so no ref ever names the subticket itself. For those we walk the
 *    parent chain and surface the ancestor's branch, reporting which ancestor
 *    it came from in `via`.
 */
export interface IssueTestBranch {
  branch: string | null;
  source: "workspace" | "git" | null;
  /** Identifier of the ancestor whose branch is surfaced; null when it is the issue's own. */
  via: string | null;
}

interface IssueTestBranchInput {
  id: string;
  companyId: string;
  identifier: string | null;
  executionWorkspaceId: string | null;
  projectWorkspaceId: string | null;
  parentId: string | null;
}

interface ResolveDeps {
  db: Db;
  issue: IssueTestBranchInput;
  getWorkspace: (id: string) => Promise<{ branchName: string | null; cwd: string | null } | null>;
  getProjectWorkspace: (id: string) => Promise<{ cwd: string | null } | null>;
  getIssue: (id: string) => Promise<IssueTestBranchInput | null>;
}

/** Bound the parent walk — deeper chains than this are malformed data, not real hierarchies. */
const MAX_PARENT_DEPTH = 10;

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: 5_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? "" : stdout ?? ""),
    );
  });
}

/**
 * True when `branch` names `identifier` as a delimited token — so `ACME-304`
 * matches `pc/ACME-304-ci-shard` but not `pc/ACME-3040-...`.
 */
export function branchNamesIssue(branch: string, identifier: string): boolean {
  const esc = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^0-9A-Za-z])${esc}(?![0-9A-Za-z])`, "i").test(branch);
}

/** Strip the remote name (`origin/pc/x` -> `pc/x`) so the value is checkout-friendly after a fetch. */
function stripRemote(name: string): string {
  const idx = name.indexOf("/");
  return idx >= 0 ? name.slice(idx + 1) : name;
}

type OwnBranch = { branch: string; source: "workspace" | "git" } | null;

async function resolveOwnBranch(
  deps: Pick<ResolveDeps, "db" | "getWorkspace" | "getProjectWorkspace">,
  issue: IssueTestBranchInput,
): Promise<OwnBranch> {
  const { db, getWorkspace, getProjectWorkspace } = deps;

  // 1. Structural branch on the current (isolated/worktree) workspace.
  const current = issue.executionWorkspaceId ? await getWorkspace(issue.executionWorkspaceId) : null;
  if (current?.branchName) return { branch: current.branchName, source: "workspace" };

  // 2. Any workspace ever linked to the ticket that recorded a branch; also collect a repo cwd.
  const rows = await db
    .select({ branchName: executionWorkspaces.branchName, cwd: executionWorkspaces.cwd })
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.companyId, issue.companyId),
        eq(executionWorkspaces.sourceIssueId, issue.id),
      ),
    )
    .orderBy(desc(executionWorkspaces.lastUsedAt))
    .limit(50);

  const recorded = rows.find((r) => r.branchName)?.branchName ?? null;
  if (recorded) return { branch: recorded, source: "workspace" };

  // 3. shared_workspace convention: a real git branch named after the ticket.
  //    The repo to scan is the ticket's own execution workspace when it has one,
  //    else the project's workspace — a ticket whose crew used raw git in the
  //    shared repo never gets an execution workspace record of its own, and
  //    without this fallback its branch would be unfindable.
  const identifier = issue.identifier;
  const projectCwd = issue.projectWorkspaceId
    ? (await getProjectWorkspace(issue.projectWorkspaceId))?.cwd ?? null
    : null;
  const cwd = current?.cwd ?? rows.find((r) => r.cwd)?.cwd ?? projectCwd;
  if (!identifier || !cwd) return null;

  const insideWorkTree = (await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (insideWorkTree !== "true") return null;

  // Most recently committed first: a ticket can accrue several matching
  // branches over its life (original fix, refix); the active one is the
  // one still moving.
  const refs = await runGit(cwd, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
  ]);
  const locals: string[] = [];
  const remotes: string[] = [];
  for (const line of refs.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith("refs/heads/")) {
      locals.push(line.slice("refs/heads/".length));
    } else if (line.startsWith("refs/remotes/")) {
      const name = line.slice("refs/remotes/".length);
      if (!name.endsWith("/HEAD")) remotes.push(name);
    }
  }

  const localMatches = locals.filter((b) => branchNamesIssue(b, identifier));
  const pcLocal = localMatches.find((b) => b.startsWith("pc/"));
  if (pcLocal) return { branch: pcLocal, source: "git" };
  if (localMatches.length > 0) return { branch: localMatches[0]!, source: "git" };

  const remoteMatches = remotes.filter((b) => branchNamesIssue(b, identifier)).map(stripRemote);
  const pcRemote = remoteMatches.find((b) => b.startsWith("pc/"));
  if (pcRemote) return { branch: pcRemote, source: "git" };
  if (remoteMatches.length > 0) return { branch: remoteMatches[0]!, source: "git" };

  return null;
}

export async function resolveIssueTestBranch(deps: ResolveDeps): Promise<IssueTestBranch> {
  const { issue, getIssue } = deps;

  const own = await resolveOwnBranch(deps, issue);
  if (own) return { ...own, via: null };

  // Parent-branch rule: subticket work lands on an ancestor's branch.
  const visited = new Set<string>([issue.id]);
  let parentId = issue.parentId;
  for (let depth = 0; parentId && depth < MAX_PARENT_DEPTH; depth++) {
    if (visited.has(parentId)) break;
    visited.add(parentId);

    const ancestor = await getIssue(parentId);
    if (!ancestor || ancestor.companyId !== issue.companyId) break;

    const branch = await resolveOwnBranch(deps, ancestor);
    if (branch) return { ...branch, via: ancestor.identifier };

    parentId = ancestor.parentId;
  }

  return { branch: null, source: null, via: null };
}
