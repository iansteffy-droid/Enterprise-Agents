export type AgentScorecardIssueStatusCount = {
  status: string;
  count: number;
};

export type AgentScorecard = {
  agentId: string;
  agentName: string | null;
  /** Fixed for v1 — no date-range windowing yet. */
  window: "all_time";
  /** Point-in-time counts of the agent's assigned issues, grouped by current status. */
  issueStatusCounts: AgentScorecardIssueStatusCount[];
  completedIssues: number;
  blockedIssues: number;
  openIssues: number;
  downvotes: number;
  upvotes: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  runtimeMs: number;
  runCount: number;
  costCentsPerCompletedIssue: number | null;
  tokensPerCompletedIssue: number | null;
};
