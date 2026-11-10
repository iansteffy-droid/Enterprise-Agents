// Retrospectives page
//
// The status board for the retro facilitator's proposals, grouped by retro
// issue. Content is report-only (re-derived server-side from each retro's
// comment); each point shows its status (open | merged | rejected) and where
// the proposal lives (a PR link, or `branch:<name>` while the repo has no
// remote). The facilitator records the reference; the human sets the status.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ClipboardList, ExternalLink, GitBranch, Sparkles } from "lucide-react";
import {
  DEFAULT_RETRO_POINT_STATUS,
  RETRO_POINT_SORTS,
  RETRO_POINT_STATUSES,
  isRetroProposalUrl,
  sortRetroPoints,
  type RetroPoint,
  type RetroPointSort,
  type RetroPointStatus,
} from "@paperclipai/shared";
import { retroPointsApi } from "../api/retro-points";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const REFETCH_INTERVAL_MS = 15_000;
const LAST_VISIT_STORAGE_PREFIX = "paperclip.retrospectives.lastVisit";

// ── Status presentation ───────────────────────────────────────────────────────

const STATUS_LABELS: Record<RetroPointStatus, string> = {
  open: "Open",
  merged: "Merged",
  rejected: "Rejected",
};

function statusClasses(status: RetroPointStatus): string {
  switch (status) {
    case "open":
      return "bg-muted text-muted-foreground border-border";
    case "merged":
      return "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/20";
    case "rejected":
      return "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20";
  }
}

const SORT_LABELS: Record<RetroPointSort, string> = {
  priority: "Priority",
  ratio: "Impact / effort ratio",
  impact: "Impact",
  effort: "Effort (lowest first)",
  newest: "Newest",
};

/** The server always sends a status; the fallback only guards an older server's null. */
function effectiveStatus(point: RetroPoint): RetroPointStatus {
  return (point.status as RetroPointStatus | null) ?? DEFAULT_RETRO_POINT_STATUS;
}

// ── Score chip ────────────────────────────────────────────────────────────────

function ScoreChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
      <span className="font-medium text-foreground/80">{label}</span>
      {value}
    </span>
  );
}

// ── Status chip ───────────────────────────────────────────────────────────────

function StatusChip({ point }: { point: RetroPoint }) {
  const status = effectiveStatus(point);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        statusClasses(status),
      )}
      data-test={`retro-status-chip-${point.pointKey}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

// ── Proposal reference: PR URL as a link, `branch:<name>` as text ─────────────

function ProposalRef({ point }: { point: RetroPoint }) {
  const ref = point.proposalRef;
  const dataTest = `retro-ref-${point.pointKey}`;
  if (ref && isRetroProposalUrl(ref)) {
    return (
      <a
        href={ref}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex max-w-full items-center gap-1 truncate text-xs text-primary hover:underline"
        data-test={dataTest}
      >
        <ExternalLink className="h-3 w-3 shrink-0" />
        <span className="truncate">{ref.replace(/^https?:\/\//i, "")}</span>
      </a>
    );
  }
  if (ref) {
    return (
      <span
        className="inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground"
        data-test={dataTest}
        title="Local branch (no remote yet)"
      >
        <GitBranch className="h-3 w-3 shrink-0" />
        <code className="truncate font-mono">{ref}</code>
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground/70" data-test={dataTest}>
      No proposal yet
    </span>
  );
}

// ── Inline status dropdown → PATCH ────────────────────────────────────────────

function StatusSelect({
  point,
  companyId,
}: {
  point: RetroPoint;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (status: RetroPointStatus) =>
      retroPointsApi.setStatus(companyId, point.pointKey, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.retroPoints.list(companyId) });
    },
  });

  return (
    <Select
      value={effectiveStatus(point)}
      onValueChange={(next) => mutation.mutate(next as RetroPointStatus)}
      disabled={mutation.isPending}
    >
      <SelectTrigger
        className="h-8 w-[112px] text-xs"
        data-test={`retro-status-${point.pointKey}`}
        aria-label="Set status"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RETRO_POINT_STATUSES.map((status) => (
          <SelectItem key={status} value={status}>
            {STATUS_LABELS[status]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── "Why" expandable panel ────────────────────────────────────────────────────

function WhyPanel({ point }: { point: RetroPoint }) {
  const { score, operatorFeedback, rootCauses, downvoteReasons } = point.why;
  const hasContent =
    score != null || operatorFeedback || rootCauses || downvoteReasons.length > 0;

  if (!hasContent) {
    return <p className="text-xs text-muted-foreground">No additional context recorded for this retro.</p>;
  }

  return (
    <div className="space-y-2 text-xs">
      {score != null && (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">Operator score:</span> {score}/10
        </p>
      )}
      {operatorFeedback && (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">Operator feedback:</span> {operatorFeedback}
        </p>
      )}
      {rootCauses && (
        <div className="text-muted-foreground">
          <span className="font-medium text-foreground">Root causes:</span>
          <p className="mt-0.5 whitespace-pre-line">{rootCauses}</p>
        </div>
      )}
      {downvoteReasons.length > 0 && (
        <div className="text-muted-foreground">
          <span className="font-medium text-foreground">Operator down-vote reasons:</span>
          <ul className="mt-0.5 list-disc pl-4">
            {downvoteReasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Reviewed-ticket link ──────────────────────────────────────────────────────

function ReviewedTicketCell({ point }: { point: RetroPoint }) {
  if (point.reviewedIdentifier && point.reviewedIssueId) {
    return (
      <Link
        to={`/issues/${point.reviewedIdentifier}`}
        className="font-medium text-primary hover:underline"
      >
        {point.reviewedIdentifier}
      </Link>
    );
  }
  // Unresolved identifier → show raw text without a link.
  if (point.reviewedIdentifier) {
    return <span className="font-medium text-foreground">{point.reviewedIdentifier}</span>;
  }
  return <span className="text-muted-foreground">—</span>;
}

// ── Row ───────────────────────────────────────────────────────────────────────

function RetroPointRow({ point, companyId }: { point: RetroPoint; companyId: string }) {
  const [expanded, setExpanded] = useState(false);
  const missingScores = point.impact === 0 && point.effort === 0;

  return (
    <div className="border-b border-border/60 last:border-0" data-test={`retro-point-${point.pointKey}`}>
      <div className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:gap-4">
        {/* Proposal */}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground">#{point.number}</span>
            <p className="text-sm text-foreground">{point.change}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 pl-6">
            {point.targetFile && (
              <span className="inline-flex items-center rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {point.targetFile}
              </span>
            )}
            {point.scope && (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{point.scope}</span>
            )}
            <ProposalRef point={point} />
          </div>
        </div>

        {/* Scores */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <ScoreChip label="I" value={point.impact} />
          <ScoreChip label="E" value={point.effort} />
          <ScoreChip label="P" value={Number(point.priority.toFixed(1))} />
          {missingScores && (
            <span className="text-[10px] text-amber-500" title="Impact/effort could not be parsed">
              unscored
            </span>
          )}
        </div>

        {/* Status + expand */}
        <div className="flex shrink-0 items-center gap-2">
          <StatusChip point={point} />
          <StatusSelect point={point} companyId={companyId} />
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={expanded}
            aria-label={expanded ? "Hide why" : "Show why"}
            data-test={`retro-why-toggle-${point.pointKey}`}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Why
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/50 bg-muted/20 px-3 py-3">
          <WhyPanel point={point} />
        </div>
      )}
    </div>
  );
}

// ── Group: one retro issue and its points ─────────────────────────────────────

interface RetroGroup {
  retroIssueId: string;
  points: RetroPoint[];
}

/** Group points by retro issue (newest retro first), keeping the chosen order inside each group. */
function groupByRetro(points: RetroPoint[]): RetroGroup[] {
  const groups = new Map<string, RetroGroup>();
  for (const point of points) {
    const group = groups.get(point.retroIssueId) ?? { retroIssueId: point.retroIssueId, points: [] };
    group.points.push(point);
    groups.set(point.retroIssueId, group);
  }
  return [...groups.values()].sort((a, b) => {
    const byRecency = Date.parse(b.points[0]!.retroCreatedAt) - Date.parse(a.points[0]!.retroCreatedAt);
    if (byRecency !== 0) return byRecency;
    return a.retroIssueId.localeCompare(b.retroIssueId);
  });
}

function RetroGroupCard({
  group,
  companyId,
  isNew,
}: {
  group: RetroGroup;
  companyId: string;
  isNew: boolean;
}) {
  const first = group.points[0]!;
  const counts = RETRO_POINT_STATUSES.map((status) => ({
    status,
    count: group.points.filter((point) => effectiveStatus(point) === status).length,
  })).filter((entry) => entry.count > 0);

  return (
    <section
      className="rounded-lg border border-border bg-card"
      data-test={`retro-group-${group.retroIssueId}`}
      aria-label={`Retro ${first.retroIdentifier ?? group.retroIssueId}`}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2">
        <Link
          to={`/issues/${first.retroIdentifier ?? first.retroIssueId}`}
          className="text-sm font-semibold hover:underline"
        >
          Retro{first.retroIdentifier ? ` ${first.retroIdentifier}` : ""}
        </Link>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          reviews <ReviewedTicketCell point={first} />
          {first.reviewedTitle && <span className="truncate">{first.reviewedTitle}</span>}
        </span>
        {isNew && (
          <Badge variant="secondary" className="gap-1 text-[10px]">
            <Sparkles className="h-3 w-3" /> New
          </Badge>
        )}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {counts.map((entry) => `${entry.count} ${STATUS_LABELS[entry.status].toLowerCase()}`).join(" · ")}
        </span>
      </header>
      {group.points.map((point) => (
        <RetroPointRow key={point.pointKey} point={point} companyId={companyId} />
      ))}
    </section>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function RetrospectivesSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-80" />
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const ALL = "__all__";

export function Retrospectives() {
  const { selectedCompanyId: companyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [statusFilter, setStatusFilter] = useState<string>(ALL);
  const [reviewedFilter, setReviewedFilter] = useState<string>(ALL);
  const [sort, setSort] = useState<RetroPointSort>("priority");

  useEffect(() => {
    setBreadcrumbs([{ label: "Retrospectives" }]);
  }, [setBreadcrumbs]);

  const {
    data: points,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.retroPoints.list(companyId ?? ""),
    queryFn: () => retroPointsApi.list(companyId!),
    enabled: !!companyId,
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  // "New since last visit": compare each point's retroCreatedAt to the stored
  // timestamp, then bump the timestamp to now on mount.
  const lastVisitKey = companyId ? `${LAST_VISIT_STORAGE_PREFIX}.${companyId}` : null;
  const [lastVisit] = useState<number>(() => {
    if (!lastVisitKey || typeof window === "undefined") return 0;
    const raw = window.localStorage.getItem(lastVisitKey);
    return raw ? Number.parseInt(raw, 10) || 0 : 0;
  });
  useEffect(() => {
    if (!lastVisitKey || typeof window === "undefined") return;
    window.localStorage.setItem(lastVisitKey, String(Date.now()));
  }, [lastVisitKey]);

  const reviewedOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const point of points ?? []) {
      if (point.reviewedIdentifier) {
        seen.set(point.reviewedIdentifier, point.reviewedTitle ?? point.reviewedIdentifier);
      }
    }
    return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [points]);

  const groups = useMemo(() => {
    const filtered = (points ?? []).filter((point) => {
      if (statusFilter !== ALL && effectiveStatus(point) !== statusFilter) return false;
      if (reviewedFilter !== ALL && point.reviewedIdentifier !== reviewedFilter) return false;
      return true;
    });
    return groupByRetro(sortRetroPoints(filtered, sort));
  }, [points, statusFilter, reviewedFilter, sort]);

  const header = (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <ClipboardList className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-bold">Retrospectives</h1>
        {points && points.length > 0 && (
          <Badge variant="secondary" className="text-xs font-normal tabular-nums">
            {points.length} point{points.length !== 1 ? "s" : ""}
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Every crew-retrospective proposal, grouped by retro, with where it lives and whether it was
        merged or rejected. Content is re-derived from the retro issues.
      </p>
    </div>
  );

  if (isLoading) {
    return (
      <div className="max-w-5xl space-y-6">
        <RetrospectivesSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-5xl space-y-4">
        {header}
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <p className="text-sm text-destructive">
            Failed to load retrospectives. Check your connection and try again.
          </p>
        </div>
      </div>
    );
  }

  if (!points || points.length === 0) {
    return (
      <div className="max-w-5xl space-y-4">
        {header}
        <EmptyState
          icon={ClipboardList}
          message="No retrospective points yet — they appear automatically once a Crew retrospective ticket has proposals."
        />
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-4">
      {header}

      {/* Filters + sort */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-[150px] text-xs" data-test="retro-filter-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {RETRO_POINT_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={reviewedFilter} onValueChange={setReviewedFilter}>
          <SelectTrigger className="h-8 w-[180px] text-xs" data-test="retro-filter-reviewed">
            <SelectValue placeholder="Reviewed ticket" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All reviewed tickets</SelectItem>
            {reviewedOptions.map(([identifier, title]) => (
              <SelectItem key={identifier} value={identifier}>
                {identifier}
                {title && title !== identifier ? ` — ${title}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Sort</span>
          <Select value={sort} onValueChange={(next) => setSort(next as RetroPointSort)}>
            <SelectTrigger className="h-8 w-[180px] text-xs" data-test="retro-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RETRO_POINT_SORTS.map((option) => (
                <SelectItem key={option} value={option}>
                  {SORT_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Groups */}
      {groups.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-3 py-8 text-center text-sm text-muted-foreground">
          No points match the current filters.
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <RetroGroupCard
              key={group.retroIssueId}
              group={group}
              companyId={companyId!}
              isNew={lastVisit > 0 && Date.parse(group.points[0]!.retroCreatedAt) > lastVisit}
            />
          ))}
        </div>
      )}
    </div>
  );
}
