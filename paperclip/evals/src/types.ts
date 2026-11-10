export type LedgerSignalType = "downvote";

export type LedgerStatus = "new" | "triaged" | "cased" | "fixed" | "wontfix";

export type LedgerEntry = {
  /** Stable, dedup id. For downvotes: `downvote:<feedbackVoteId>`. */
  id: string;
  agentId: string;
  agentName: string | null;
  signalType: LedgerSignalType;
  issueId: string;
  /** Run that produced the voted-on artifact, if known. */
  runId: string | null;
  /** Downvote reason, if the voter provided one. */
  reason: string | null;
  /** Pointer to an exported feedback trace bundle, if one exists. Never inlines the trace. */
  traceRef: string | null;
  /** ISO timestamp of the originating signal (the vote's createdAt). */
  detectedAt: string;
  status: LedgerStatus;
};
