export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

export interface DashboardAgentRunTime {
  agentId: string;
  agentName: string;
  agentStatus: string;
  totalMs: number;
  runCount: number;
}

export type DashboardRoleFlowClassification = "bottleneck" | "backlogged" | "keeping_up";

export interface DashboardRoleFlowAgent {
  agentId: string;
  agentName: string;
  agentStatus: string;
  busyMs: number;
  queueDepth: number;
  waitP50Ms: number | null;
  waitP90Ms: number | null;
}

export interface DashboardRoleFlow {
  role: string;
  busyMs: number;
  queueDepth: number;
  waitP50Ms: number | null;
  waitP90Ms: number | null;
  createdCount: number;
  completedCount: number;
  flowRatio: number | null;
  classification: DashboardRoleFlowClassification;
  agents: DashboardRoleFlowAgent[];
}

/** Where a {@link PendingHumanInputItem} originated. */
export type PendingHumanInputSource = "approval" | "interaction";

/** The concrete request kind behind a {@link PendingHumanInputItem}. */
export type PendingHumanInputKind =
  | "approval"
  | "request_confirmation"
  | "request_checkbox_confirmation"
  | "ask_user_questions"
  | "suggest_tasks";

export interface PendingHumanInputAgent {
  id: string;
  name: string;
  /** Resolved avatar URL (`/api/assets/:id/content`) or null when unset. */
  avatarUrl: string | null;
}

export interface PendingHumanInputIssueRef {
  id: string;
  identifier: string | null;
  title: string;
}

/**
 * One request currently waiting on the human board user to resolve — either a
 * governed {@link Approval} or a pending issue-thread interaction. Normalized so
 * the dashboard "Waiting on you" table can render every kind as a single row
 * without an N+1 fetch loop.
 */
export interface PendingHumanInputItem {
  /** Stable row id: the approval id or the interaction id. */
  id: string;
  source: PendingHumanInputSource;
  kind: PendingHumanInputKind;
  /**
   * The linked issue, when the request is attached to one. Interactions always
   * carry an issue; approvals may be unlinked.
   */
  issue: PendingHumanInputIssueRef | null;
  /** Human-facing prompt/message for the request. */
  message: string;
  /** Primary (approve/confirm/submit) button label, matching the ticket. */
  acceptLabel: string;
  /** Secondary (reject/decline) button label, or null when there is no decline action. */
  rejectLabel: string | null;
  /**
   * Whether the request can be fully resolved with the inline accept/reject
   * buttons. Requests needing structured input (answering questions, selecting
   * suggested tasks / checkbox options) are resolved on the ticket instead.
   */
  canResolveInline: boolean;
  requestingAgent: PendingHumanInputAgent | null;
  /** ISO timestamp the request was raised. */
  createdAt: string;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
  agentRunTime: DashboardAgentRunTime[];
  roleFlow: DashboardRoleFlow[];
}
