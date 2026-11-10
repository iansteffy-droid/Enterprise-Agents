// Shared contracts for the Retrospectives page.
//
// A "retro point" is a single proposal row (Part 4) parsed out of the retro
// facilitator's crew-retrospective comment. Content is always re-derived from
// the retro issue; only the status and the proposal reference are persisted
// (see the `retro_point_status` table).

// ── Status enum ───────────────────────────────────────────────────────────────

/**
 * `open`: proposed (the facilitator records it with its proposal reference);
 * `merged` / `rejected`: the human took or declined the proposal.
 */
export const RETRO_POINT_STATUSES = ["open", "merged", "rejected"] as const;
export type RetroPointStatus = (typeof RETRO_POINT_STATUSES)[number];

/** Status a point defaults to when none has been recorded. */
export const DEFAULT_RETRO_POINT_STATUS: RetroPointStatus = "open";

export function isRetroPointStatus(value: unknown): value is RetroPointStatus {
  return typeof value === "string" && (RETRO_POINT_STATUSES as readonly string[]).includes(value);
}

/** Prefix of a proposal reference that names a local branch (no remote, so no PR). */
export const RETRO_PROPOSAL_BRANCH_PREFIX = "branch:";

/** True for an http(s) URL, the form a PR reference takes. */
export function isRetroProposalUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** A valid proposal reference: a PR URL, or `branch:<name>` with a non-empty name and no whitespace. */
export function isRetroProposalRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.startsWith(RETRO_PROPOSAL_BRANCH_PREFIX)) {
    return /^\S+$/.test(value.slice(RETRO_PROPOSAL_BRANCH_PREFIX.length));
  }
  return isRetroProposalUrl(value);
}

// ── Sort options (UI re-sort dimensions) ──────────────────────────────────────

export const RETRO_POINT_SORTS = ["priority", "ratio", "impact", "effort", "newest"] as const;
export type RetroPointSort = (typeof RETRO_POINT_SORTS)[number];

export const DEFAULT_RETRO_POINT_SORT: RetroPointSort = "priority";

// ── Read model ────────────────────────────────────────────────────────────────

/**
 * The "why the agents suggest this" context for a point, surfaced in the
 * expandable panel: the operator's numeric score on the retro, any written
 * operator feedback, the extracted "Root causes" section, and the reasons the
 * operator gave on any down-votes against the retro's comment(s).
 */
export interface RetroPointWhy {
  score: number | null;
  operatorFeedback: string | null;
  rootCauses: string | null;
  downvoteReasons: string[];
}

/**
 * A single ranked, trackable retrospective proposal. Returned by
 * `GET /api/companies/:companyId/retro-points`.
 */
export interface RetroPoint {
  /**
   * Stable id: `${retroIssueId}_${proposalNumber}`; a repeated row number in the
   * same comment gets an occurrence suffix (`_2.2` for the second row numbered 2).
   */
  pointKey: string;

  // Source retro execution ticket (the `Crew retrospective — …` ticket).
  retroIssueId: string;
  retroIdentifier: string | null;
  retroCreatedAt: string;

  // Resolved reviewed feature ticket (the ticket the retro is about, not the retro itself).
  reviewedIssueId: string | null;
  reviewedIdentifier: string | null;
  reviewedTitle: string | null;

  // Parsed proposal fields.
  number: number;
  change: string;
  targetFile: string | null;
  /** `universal` (kit instructions) or `client` (client repo), when the table carries a Scope column. */
  scope: string | null;
  impact: number;
  effort: number;
  /** Deterministic composite priority score (impact - 0.5 * effort). */
  priority: number;

  /** Recorded status; DEFAULT_RETRO_POINT_STATUS ("open") when nothing has been recorded. */
  status: RetroPointStatus;
  /** Where the proposal lives: a PR URL, or `branch:<name>` while the repo has no remote. */
  proposalRef: string | null;
  note: string | null;
  updatedAt: string | null;

  why: RetroPointWhy;
}

// ── Ranking (deterministic) ───────────────────────────────────────────────────

/** Default composite priority: impact-weighted, low effort floats up. */
export function computeRetroPointPriority(impact: number, effort: number): number {
  return impact - 0.5 * effort;
}

/**
 * Sort comparator for the requested dimension. All sorts are deterministic and
 * fall back to reviewed-ticket recency (retroCreatedAt desc) then pointKey so
 * the order is stable across refetches.
 */
export function compareRetroPoints(a: RetroPoint, b: RetroPoint, sort: RetroPointSort): number {
  switch (sort) {
    case "priority": {
      const byPriority = b.priority - a.priority;
      if (byPriority !== 0) return byPriority;
      const byImpact = b.impact - a.impact;
      if (byImpact !== 0) return byImpact;
      return recencyThenKey(a, b);
    }
    case "ratio": {
      const byRatio = retroRatio(b) - retroRatio(a);
      if (byRatio !== 0) return byRatio;
      return recencyThenKey(a, b);
    }
    case "impact": {
      const byImpact = b.impact - a.impact;
      if (byImpact !== 0) return byImpact;
      return recencyThenKey(a, b);
    }
    case "effort": {
      const byEffort = a.effort - b.effort;
      if (byEffort !== 0) return byEffort;
      return recencyThenKey(a, b);
    }
    case "newest":
      return recencyThenKey(a, b);
  }
}

export function sortRetroPoints(points: readonly RetroPoint[], sort: RetroPointSort): RetroPoint[] {
  return [...points].sort((a, b) => compareRetroPoints(a, b, sort));
}

/** Strict impact/effort ratio; effort 0 is treated as 1 to avoid div-by-zero. */
function retroRatio(point: RetroPoint): number {
  return point.impact / Math.max(point.effort, 1);
}

function recencyThenKey(a: RetroPoint, b: RetroPoint): number {
  const byRecency = Date.parse(b.retroCreatedAt) - Date.parse(a.retroCreatedAt);
  if (byRecency !== 0) return byRecency;
  return a.pointKey.localeCompare(b.pointKey);
}

// ── API path constants ────────────────────────────────────────────────────────

export const RETRO_POINTS_API = {
  /** GET (company read) — ranked list of retro points. */
  list: (companyId: string) => `/api/companies/${companyId}/retro-points`,
  /** PATCH (board users and agents of the company) — upsert a point's status and/or proposal reference. */
  point: (companyId: string, pointKey: string) =>
    `/api/companies/${companyId}/retro-points/${encodeURIComponent(pointKey)}`,
} as const;
