import { useState } from "react";
import type { Issue, IssueWorkProduct } from "@paperclipai/shared";
import { AlertCircle, Check, Copy, GitBranch, MessageSquarePlus, PauseCircle, Play } from "lucide-react";
import { Identity } from "./Identity";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ExecutionDecisionAction = "approve" | "request_changes";

export function shouldShowExecutionDecision(
  issue: Pick<Issue, "status" | "executionState">,
  currentUserId: string | null,
): boolean {
  if (issue.status !== "in_review") return false;
  const state = issue.executionState;
  if (!state || state.status !== "pending") return false;
  const participant = state.currentParticipant;
  if (!participant || participant.type !== "user") return false;
  return !!currentUserId && participant.userId === currentUserId;
}

export function shouldShowReviewNotice(
  issue: Pick<Issue, "status" | "executionState" | "assigneeUserId">,
  currentUserId: string | null,
): boolean {
  if (issue.status !== "in_review") return false;
  // A held chain gets its own "On hold" row instead.
  if (issue.executionState?.status === "held") return false;
  // The notice and the action banner are NOT mutually exclusive — when both apply
  // (assigned to me AND I'm the execution participant) they stack as two rows.
  return !!currentUserId && issue.assigneeUserId === currentUserId;
}

/** "On hold — <reason> (resumes <time> | waiting on you)" for a held chain, else null. */
export function holdBannerText(
  issue: Pick<Issue, "executionState">,
  formatTime: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): string | null {
  const state = issue.executionState;
  if (!state || state.status !== "held" || !state.hold) return null;
  const when = state.hold.resumeAt ? `resumes ${formatTime(state.hold.resumeAt)}` : "waiting on you";
  return `On hold — ${state.hold.reason} (${when})`;
}

export function decisionStatusFor(action: ExecutionDecisionAction): "done" | "in_progress" {
  return action === "approve" ? "done" : "in_progress";
}

// The reviewer needs to know where to check the work out. Prefer an explicit
// `branch` work product (primary first, then newest); fall back to a pull
// request link when no branch was registered.
export function selectTestWorkProduct(
  workProducts: IssueWorkProduct[] | null | undefined,
): IssueWorkProduct | null {
  const newestFirst = (items: IssueWorkProduct[]) =>
    [...items].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  for (const type of ["branch", "pull_request"] as const) {
    const candidates = (workProducts ?? []).filter((wp) => wp.type === type);
    if (candidates.length === 0) continue;
    return candidates.find((wp) => wp.isPrimary) ?? newestFirst(candidates)[0];
  }
  return null;
}

export interface ExecutionStageDecisionInput {
  status: "done" | "in_progress";
  comment: string;
  /**
   * The reviewer's explicit sign-off. The server refuses to read a status change
   * alone as a stage decision, so this must ride along with it.
   */
  executionDecision: ExecutionDecisionAction;
}

export interface ExecutionStageDecisionBannerProps {
  issue: Pick<Issue, "status" | "executionState" | "assigneeUserId">;
  currentUserId: string | null;
  onSubmitDecision: (input: ExecutionStageDecisionInput) => Promise<void>;
  /** Board resume of a held chain: PATCH { status: "in_review" }. */
  onResume?: () => Promise<void>;
  reviewerName?: string | null;
  reviewerAvatarUrl?: string | null;
  workProducts?: IssueWorkProduct[] | null;
}

export function ExecutionStageDecisionBanner({
  issue,
  currentUserId,
  onSubmitDecision,
  onResume,
  reviewerName,
  reviewerAvatarUrl,
  workProducts,
}: ExecutionStageDecisionBannerProps) {
  const [action, setAction] = useState<ExecutionDecisionAction | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const showDecision = shouldShowExecutionDecision(issue, currentUserId);
  const showNotice = shouldShowReviewNotice(issue, currentUserId);
  const holdText = holdBannerText(issue);
  if (!showDecision && !showNotice && !holdText) return null;

  const resume = async () => {
    if (!onResume) return;
    setResuming(true);
    setResumeError(null);
    try {
      await onResume();
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : "Failed to resume.");
    } finally {
      setResuming(false);
    }
  };

  const testWorkProduct = selectTestWorkProduct(workProducts);

  const stageLabel = issue.executionState?.currentStageType === "review" ? "Review" : "Approval";
  const isApprove = action === "approve";

  const open = (next: ExecutionDecisionAction) => {
    setError(null);
    setComment("");
    setAction(next);
  };

  const close = () => {
    if (submitting) return;
    setAction(null);
    setComment("");
    setError(null);
  };

  const submit = async () => {
    if (!comment.trim() || !action) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmitDecision({
        status: decisionStatusFor(action),
        comment: comment.trim(),
        executionDecision: action,
      });
      setSubmitting(false);
      setAction(null);
      setComment("");
    } catch (err) {
      setSubmitting(false);
      setError(err instanceof Error ? err.message : "Failed to submit decision.");
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
      {holdText && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p data-testid="exec-hold" className="flex items-center gap-2 text-sm font-medium text-foreground">
            <PauseCircle className="h-4 w-4 text-amber-600" /> {holdText}
          </p>
          {currentUserId && onResume && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              data-testid="exec-resume"
              disabled={resuming}
              onClick={() => void resume()}
            >
              <Play className="h-4 w-4" /> {resuming ? "Resuming…" : "Resume"}
            </Button>
          )}
          {resumeError && (
            <p data-testid="exec-resume-error" className="flex w-full items-center gap-1.5 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" /> {resumeError}
            </p>
          )}
        </div>
      )}
      {showNotice && (
        <div className="flex items-center gap-3">
          <Identity
            name={reviewerName && reviewerName.trim() ? reviewerName : "You"}
            avatarUrl={reviewerAvatarUrl ?? null}
            size="sm"
          />
          <p data-testid="review-notice" className="text-sm font-medium text-foreground">
            You must review this ticket for it to continue.
          </p>
        </div>
      )}
      {testWorkProduct && (
        <div data-testid="review-test-branch" className="flex flex-wrap items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {testWorkProduct.type === "branch" ? "Test on branch:" : "Test via pull request:"}
          </span>
          {testWorkProduct.type === "branch" ? (
            <>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm font-medium">
                {testWorkProduct.title}
              </code>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-1.5 text-muted-foreground"
                data-testid="review-test-branch-copy"
                title="Copy branch name"
                onClick={() => {
                  void navigator.clipboard?.writeText(testWorkProduct.title);
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : (
            <a
              href={testWorkProduct.url ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium underline underline-offset-2"
            >
              {testWorkProduct.title}
            </a>
          )}
        </div>
      )}
      {showDecision && (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">
          {stageLabel} pending — your decision needed
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="gap-1.5 bg-green-700 text-white hover:bg-green-800"
            data-testid="exec-approve"
            onClick={() => open("approve")}
          >
            <Check className="h-4 w-4" /> Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            data-testid="exec-request-changes"
            onClick={() => open("request_changes")}
          >
            <MessageSquarePlus className="h-4 w-4" /> Request changes
          </Button>
        </div>
      </div>
      )}

      {showDecision && (
      <Dialog open={action !== null} onOpenChange={(next) => { if (!next) close(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isApprove ? "Approve" : "Request changes"}</DialogTitle>
            <DialogDescription>
              {isApprove
                ? "Approve this stage. A comment is required."
                : "Send this back for changes. A comment is required."}
            </DialogDescription>
          </DialogHeader>
          <textarea
            data-testid="exec-decision-comment"
            className="min-h-[100px] w-full resize-none rounded-md border border-border bg-transparent p-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            placeholder={isApprove ? "What did you approve and why?" : "What needs to change?"}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={submitting}
            autoFocus
          />
          {error && (
            <p data-testid="exec-decision-error" className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" /> {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={submitting}>
              Cancel
            </Button>
            <Button
              data-testid="exec-decision-confirm"
              onClick={submit}
              disabled={submitting || !comment.trim()}
              className={isApprove ? "bg-green-700 text-white hover:bg-green-800" : undefined}
            >
              {submitting ? "Submitting…" : isApprove ? "Approve" : "Request changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      )}
    </div>
  );
}
