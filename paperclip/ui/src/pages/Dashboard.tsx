import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { accessApi } from "../api/access";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";

import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents, formatDurationMs } from "../lib/utils";
import { Bot, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, Pause, PauseCircle, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { WaitingOnYouPanel } from "../components/WaitingOnYouPanel";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import type { Agent, Issue, DashboardRoleFlow, DashboardRoleFlowClassification } from "@paperclipai/shared";
import { buildWaitingOnYouItems, type WaitingOnYouItem } from "../lib/waiting-on-you";
import { PluginSlotOutlet } from "@/plugins/slots";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";

const DASHBOARD_ACTIVITY_LIMIT = 10;

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

const ROLE_FLOW_BADGE: Record<
  DashboardRoleFlowClassification,
  { label: string; className: string; title: string }
> = {
  bottleneck: {
    label: "Bottleneck",
    className: "bg-red-500/10 text-red-400 border-red-500/20",
    title: "Busy and falling behind with work queued — adding agents of this role should help.",
  },
  backlogged: {
    label: "Backlogged",
    className: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    title: "Work is piling up but the role isn't busy — likely blocked, misassigned, or dependency-bound, not a capacity gap.",
  },
  keeping_up: {
    label: "Keeping up",
    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    title: "No meaningful queue forming in front of this role.",
  },
};

const ROLE_FLOW_COLUMNS: { label: string; hint: string; className: string }[] = [
  {
    label: "Role",
    hint: "The agent specialty (Engineer, QA, …). Capacity is a role-level question — 'do we need more of this kind of agent?' — so grading happens per role, with individual agents nested underneath.",
    className: "pl-3 pr-2 text-left",
  },
  {
    label: "Busy",
    hint: "Total time this role's agents spent actively running (finished runs) in the last 14 days. Shows who works the most — but on its own it measures volume, not whether the role is a constraint. A role can be 100% busy and still not be the bottleneck.",
    className: "px-2 text-right",
  },
  {
    label: "Wait p50 / p90",
    hint: "How long work waits before an agent starts it (created → started). p50 is the typical wait; p90 is the near-worst case. Rising wait behind a busy role is the strongest sign work is backing up. Time an agent, project, or company was paused is excluded, so this reflects genuine queueing, not administrative stops.",
    className: "px-2 text-right",
  },
  {
    label: "Queue",
    hint: "Issues assigned to this role right now that haven't been started yet. A persistent, growing queue behind a busy role means demand is outrunning capacity.",
    className: "px-2 text-right",
  },
  {
    label: "Flow",
    hint: "Completed ÷ created over the window. Below 1 means the role finishes work slower than new work arrives — i.e. it is falling behind.",
    className: "px-2 text-right",
  },
  {
    label: "Signal",
    hint: "The verdict. Bottleneck = busy AND falling behind AND queued → adding agents of this role should help. Backlogged = queue but not busy → likely blocked or misassigned, not a capacity gap. Keeping up = no meaningful queue forming.",
    className: "pl-2 pr-3 text-right",
  },
];

const fmtWait = (ms: number | null): string => (ms == null ? "—" : formatDurationMs(ms));
const fmtRatio = (ratio: number | null): string => (ratio == null ? "—" : ratio.toFixed(2));
const roleLabel = (role: string): string =>
  (AGENT_ROLE_LABELS as Record<string, string>)[role] ?? role;

function RoleFlowClassificationBadge({ value }: { value: DashboardRoleFlowClassification }) {
  const badge = ROLE_FLOW_BADGE[value];
  return (
    <span
      title={badge.title}
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        badge.className,
      )}
    >
      {badge.label}
    </span>
  );
}

function RoleFlowHeaderCell({
  label,
  hint,
  className,
}: {
  label: string;
  hint: string;
  className: string;
}) {
  return (
    <th className={cn("py-2 font-medium", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-4">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-xs text-left font-normal normal-case leading-relaxed tracking-normal"
        >
          {hint}
        </TooltipContent>
      </Tooltip>
    </th>
  );
}

function RoleFlowPanel({ roleFlow }: { roleFlow?: DashboardRoleFlow[] }) {
  const rows = roleFlow ?? [];
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (role: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });

  return (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
        Role Flow
        <span className="ml-2 normal-case font-normal text-xs">Last 14 days</span>
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Busy time paired with the queue forming in front of each role. A role is a bottleneck only
        when it's busy <em>and</em> work is piling up behind it.
      </p>
      {rows.length === 0 ? (
        <div className="border border-border rounded-md p-4">
          <p className="text-sm text-muted-foreground">No assigned work in the last 14 days.</p>
        </div>
      ) : (
        <TooltipProvider delayDuration={150}>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-accent/20 text-left text-xs uppercase tracking-wide text-muted-foreground">
                {ROLE_FLOW_COLUMNS.map((col) => (
                  <RoleFlowHeaderCell key={col.label} {...col} />
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((role) => {
                const isOpen = expanded.has(role.role);
                const Chevron = isOpen ? ChevronDown : ChevronRight;
                return (
                  <Fragment key={role.role}>
                    <tr
                      className="cursor-pointer hover:bg-accent/50 transition-colors"
                      onClick={() => toggle(role.role)}
                    >
                      <td className="py-2.5 pl-3 pr-2">
                        <span className="flex items-center gap-1.5">
                          <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="font-medium">{roleLabel(role.role)}</span>
                          <span className="text-xs text-muted-foreground">
                            {role.agents.length}
                          </span>
                        </span>
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                        {fmtWait(role.busyMs)}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                        {fmtWait(role.waitP50Ms)} / {fmtWait(role.waitP90Ms)}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                        {role.queueDepth}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                        {fmtRatio(role.flowRatio)}
                      </td>
                      <td className="py-2.5 pl-2 pr-3 text-right">
                        <RoleFlowClassificationBadge value={role.classification} />
                      </td>
                    </tr>
                    {isOpen &&
                      role.agents.map((agent) => (
                        <tr key={agent.agentId} className="bg-muted/30 text-xs">
                          <td className="py-2 pl-8 pr-2">
                            <Link
                              to={`/agents/${agent.agentId}`}
                              className="no-underline text-inherit hover:underline"
                            >
                              <Identity name={agent.agentName} size="sm" />
                            </Link>
                          </td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums">
                            {fmtWait(agent.busyMs)}
                          </td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums">
                            {fmtWait(agent.waitP50Ms)} / {fmtWait(agent.waitP90Ms)}
                          </td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums">
                            {agent.queueDepth}
                          </td>
                          <td className="py-2 px-2" />
                          <td className="py-2 pl-2 pr-3" />
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        </TooltipProvider>
      )}
    </div>
  );
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [pauseAllOpen, setPauseAllOpen] = useState(false);
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: activity } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), { limit: DASHBOARD_ACTIVITY_LIMIT }],
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: DASHBOARD_ACTIVITY_LIMIT }),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const { data: pendingHumanInput } = useQuery({
    queryKey: queryKeys.pendingHumanInput(selectedCompanyId!),
    queryFn: () => dashboardApi.pendingHumanInput(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Server-listed requests plus review handoffs derived from the issues list,
  // which the live event stream already keeps fresh — see waiting-on-you.ts.
  const waitingOnYou = useMemo(
    () => buildWaitingOnYouItems({ pendingHumanInput, issues, agents }),
    [pendingHumanInput, issues, agents],
  );

  const resolvePending = useMutation({
    mutationFn: async ({ item, action }: { item: WaitingOnYouItem; action: "accept" | "reject" }) => {
      if (item.source === "review") {
        throw new Error("Reviews are resolved on the ticket, not inline.");
      }
      if (item.source === "approval") {
        if (action === "accept") await approvalsApi.approve(item.id);
        else await approvalsApi.reject(item.id);
        return;
      }
      const issueId = item.issue?.id;
      if (!issueId) {
        throw new Error("This request has no linked ticket to resolve against.");
      }
      if (action === "accept") await issuesApi.acceptInteraction(issueId, item.id);
      else await issuesApi.rejectInteraction(issueId, item.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pendingHumanInput(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
    onError: (error) => {
      pushToast({
        title: "Couldn't resolve request",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const recentIssues = issues ? getRecentIssues(issues) : [];
  const recentActivity = useMemo(() => (activity ?? []).slice(0, 10), [activity]);

  const runningCount = useMemo(
    () => (issues ?? []).filter((issue) => issue.status === "in_progress").length,
    [issues],
  );

  const pauseAll = useMutation({
    mutationFn: () => issuesApi.pauseAllRunning(selectedCompanyId!),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId!) });
      setPauseAllOpen(false);
      if (result.failed > 0) {
        pushToast({
          title: `Paused ${result.paused} of ${result.total} tickets`,
          body: `${result.failed} could not be paused. Try again to catch the rest.`,
          tone: "warn",
        });
      } else {
        pushToast({
          title: `Paused ${result.paused} ticket${result.paused === 1 ? "" : "s"}`,
          body: "Each running ticket was moved to Blocked.",
          tone: "success",
        });
      }
    },
    onError: (error) => {
      pushToast({
        title: "Couldn't pause tickets",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  useEffect(() => {
    for (const timer of activityAnimationTimersRef.current) {
      window.clearTimeout(timer);
    }
    activityAnimationTimersRef.current = [];
    seenActivityIdsRef.current = new Set();
    hydratedActivityRef.current = false;
    setAnimatedActivityIds(new Set());
  }, [selectedCompanyId]);

  useEffect(() => {
    if (recentActivity.length === 0) return;

    const seen = seenActivityIdsRef.current;
    const currentIds = recentActivity.map((event) => event.id);

    if (!hydratedActivityRef.current) {
      for (const id of currentIds) seen.add(id);
      hydratedActivityRef.current = true;
      return;
    }

    const newIds = currentIds.filter((id) => !seen.has(id));
    if (newIds.length === 0) {
      for (const id of currentIds) seen.add(id);
      return;
    }

    setAnimatedActivityIds((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });

    for (const id of newIds) seen.add(id);

    const timer = window.setTimeout(() => {
      setAnimatedActivityIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
      activityAnimationTimersRef.current = activityAnimationTimersRef.current.filter((t) => t !== timer);
    }, 980);
    activityAnimationTimersRef.current.push(timer);
  }, [recentActivity]);

  useEffect(() => {
    return () => {
      for (const timer of activityAnimationTimersRef.current) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    return map;
  }, [issues, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to Paperclip. Set up your first company and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select a company to view the dashboard." />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">"Make it so, number 1"</h1>
        {runningCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPauseAllOpen(true)}
            disabled={pauseAll.isPending}
          >
            <Pause className="h-4 w-4" />
            {pauseAll.isPending ? "Pausing…" : "Pause all"}
          </Button>
        )}
      </div>

      <AlertDialog open={pauseAllOpen} onOpenChange={setPauseAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pause all running tickets?</AlertDialogTitle>
            <AlertDialogDescription>
              This moves {runningCount} in-progress ticket{runningCount === 1 ? "" : "s"} in this
              company to <span className="font-medium text-foreground">Blocked</span>. Only this
              company's tickets are affected, and you can move them back individually afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pauseAll.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                pauseAll.mutate();
              }}
              disabled={pauseAll.isPending}
            >
              {pauseAll.isPending ? "Pausing…" : `Pause ${runningCount} ticket${runningCount === 1 ? "" : "s"}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {waitingOnYou.length > 0 && (
        <WaitingOnYouPanel
          items={waitingOnYou}
          onAccept={(item) => resolvePending.mutateAsync({ item, action: "accept" }).catch(() => {})}
          onReject={(item) => resolvePending.mutateAsync({ item, action: "reject" }).catch(() => {})}
        />
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      <ActiveAgentsPanel companyId={selectedCompanyId!} />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-[linear-gradient(180deg,rgba(255,80,80,0.12),rgba(255,255,255,0.02))] px-4 py-3">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                <div>
                  <p className="text-sm font-medium text-red-50">
                    {data.budgets.activeIncidents} active budget incident{data.budgets.activeIncidents === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-red-100/70">
                    {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects paused · {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-100">
                Open budgets
              </Link>
            </div>
          ) : null}

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
            <MetricCard
              icon={Bot}
              value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
              label="Agents Enabled"
              to="/agents"
              description={
                <span>
                  {data.agents.running} running{", "}
                  {data.agents.paused} paused{", "}
                  {data.agents.error} errors
                </span>
              }
            />
            <MetricCard
              icon={CircleDot}
              value={data.tasks.inProgress}
              label="Tasks In Progress"
              to="/issues"
              description={
                <span>
                  {data.tasks.open} open{", "}
                  {data.tasks.blocked} blocked
                </span>
              }
            />
            <MetricCard
              icon={DollarSign}
              value={formatCents(data.costs.monthSpendCents)}
              label="Month Spend"
              to="/costs"
              description={
                <span>
                  {data.costs.monthBudgetCents > 0
                    ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`
                    : "Unlimited budget"}
                </span>
              }
            />
            <MetricCard
              icon={ShieldCheck}
              value={data.pendingApprovals + data.budgets.pendingApprovals}
              label="Pending Approvals"
              to="/approvals"
              description={
                <span>
                  {data.budgets.pendingApprovals > 0
                    ? `${data.budgets.pendingApprovals} budget overrides awaiting board review`
                    : "Awaiting board review"}
                </span>
              }
            />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <ChartCard title="Run Activity" subtitle="Last 14 days">
              <RunActivityChart activity={data.runActivity} />
            </ChartCard>
            <ChartCard title="Tasks by Priority" subtitle="Last 14 days">
              <PriorityChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Tasks by Status" subtitle="Last 14 days">
              <IssueStatusChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Success Rate" subtitle="Last 14 days">
              <SuccessRateChart activity={data.runActivity} />
            </ChartCard>
          </div>

          {/* Role Flow — busy time vs. the queue forming in front of each role */}
          <RoleFlowPanel roleFlow={data.roleFlow} />

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />

          <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Activity */}
            {recentActivity.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  Recent Activity
                </h3>
                <div className="border border-border divide-y divide-border overflow-hidden">
                  {recentActivity.map((event) => (
                    <ActivityRow
                      key={event.id}
                      event={event}
                      agentMap={agentMap}
                      userProfileMap={userProfileMap}
                      entityNameMap={entityNameMap}
                      entityTitleMap={entityTitleMap}
                      className={animatedActivityIds.has(event.id) ? "activity-row-enter" : undefined}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Recent Tasks */}
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Recent Tasks
              </h3>
              {recentIssues.length === 0 ? (
                <div className="border border-border p-4">
                  <p className="text-sm text-muted-foreground">No tasks yet.</p>
                </div>
              ) : (
                <div className="border border-border divide-y divide-border overflow-hidden">
                  {recentIssues.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit block"
                    >
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        {/* Status icon - left column on mobile */}
                        <span className="shrink-0 sm:hidden">
                          <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                        </span>

                        {/* Right column on mobile: title + metadata stacked */}
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {issue.title}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} /></span>
                            <span className="text-xs font-mono text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            {issue.assigneeAgentId && (() => {
                              const name = agentName(issue.assigneeAgentId);
                              return name
                                ? <span className="hidden sm:inline-flex"><Identity name={name} size="sm" /></span>
                                : null;
                            })()}
                            <span className="text-xs text-muted-foreground sm:hidden">&middot;</span>
                            <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
                              {timeAgo(issue.updatedAt)}
                            </span>
                          </span>
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>

        </>
      )}
    </div>
  );
}
