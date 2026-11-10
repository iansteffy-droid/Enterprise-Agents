import { ArrowDown, Loader2, Play, PlayCircle, Square, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  IssueThreadInteraction,
  RequestCheckboxConfirmationInteraction,
  RequestConfirmationInteraction,
  SuggestTasksInteraction,
} from "@paperclipai/shared";

// Mirrors the local alias in IssueDetail.tsx: the interaction kinds that can be
// accepted/rejected directly (vs. ask_user_questions, which needs answers).
type ActionableIssueThreadInteraction =
  | SuggestTasksInteraction
  | RequestConfirmationInteraction
  | RequestCheckboxConfirmationInteraction;

export interface IssueDetailActionBarProps {
  /** Pending thread interactions (already filtered to status === "pending"). */
  pendingInteractions: readonly IssueThreadInteraction[];
  onAcceptInteraction: (interaction: ActionableIssueThreadInteraction) => Promise<void> | void;
  onRejectInteraction: (
    interaction: ActionableIssueThreadInteraction,
    reason?: string,
  ) => Promise<void> | void;
  /** Bring a richer interaction (multi-select / questions) into view in the thread. */
  onReviewInteractions: () => void;
  acceptingInteractionId: string | null;
  rejectingInteractionId: string | null;
  /** Backlog task that can be moved to todo to start. */
  canStartFromBacklog: boolean;
  onStartFromBacklog?: () => Promise<void> | void;
  startingFromBacklog: boolean;
  /** A run is live and the viewer is allowed to stop it. */
  canStopRun: boolean;
  onStopRun?: () => Promise<void> | void;
  stoppingRun: boolean;
  /** Work is paused and the viewer is allowed to resume it. */
  canResume: boolean;
  onResume?: () => void;
}

/**
 * A sticky bar pinned to the top of the issue detail page that surfaces the
 * primary start / stop controls. Without it, the only way to confirm-and-start
 * a task (accept a request_confirmation) or stop a running agent is buried
 * inline in the comment thread, forcing the user to scroll through the logs.
 */
export function IssueDetailActionBar({
  pendingInteractions,
  onAcceptInteraction,
  onRejectInteraction,
  onReviewInteractions,
  acceptingInteractionId,
  rejectingInteractionId,
  canStartFromBacklog,
  onStartFromBacklog,
  startingFromBacklog,
  canStopRun,
  onStopRun,
  stoppingRun,
  canResume,
  onResume,
}: IssueDetailActionBarProps) {
  // A request_confirmation is a plain yes/no, so we can act on it directly from
  // the bar. Other actionable kinds (suggest_tasks, checkbox) and questions need
  // their inline selection UI, so for those we jump the user to the card.
  const confirmation = pendingInteractions.find(
    (interaction): interaction is ActionableIssueThreadInteraction =>
      interaction.kind === "request_confirmation",
  );
  const otherPending = pendingInteractions.find(
    (interaction) => interaction.kind !== "request_confirmation",
  );

  const hasContent =
    Boolean(confirmation) ||
    Boolean(otherPending) ||
    canStartFromBacklog ||
    canStopRun ||
    canResume;

  if (!hasContent) return null;

  const message = confirmation
    ? confirmation.title?.trim() || "Waiting for your confirmation to start this task."
    : otherPending
      ? otherPending.title?.trim() || "This task has a request waiting for your response."
      : canStopRun
        ? "This task is running."
        : canStartFromBacklog
          ? "This task is ready to start."
          : "This task is paused.";

  const isAccepting = confirmation ? acceptingInteractionId === confirmation.id : false;
  const isRejecting = confirmation ? rejectingInteractionId === confirmation.id : false;
  const interactionBusy = isAccepting || isRejecting;

  return (
    <div
      className={cn(
        "sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-2",
        "rounded-lg border bg-background/90 px-3 py-2 shadow-sm backdrop-blur",
        "supports-[backdrop-filter]:bg-background/75",
      )}
    >
      <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {message}
      </p>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {confirmation ? (
          <>
            <Button
              size="sm"
              onClick={() => void onAcceptInteraction(confirmation)}
              disabled={interactionBusy}
            >
              {isAccepting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-1.5 h-3.5 w-3.5" />
              )}
              Start
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onRejectInteraction(confirmation)}
              disabled={interactionBusy}
            >
              {isRejecting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <X className="mr-1.5 h-3.5 w-3.5" />
              )}
              Decline
            </Button>
          </>
        ) : otherPending ? (
          <Button size="sm" onClick={onReviewInteractions}>
            <ArrowDown className="mr-1.5 h-3.5 w-3.5" />
            Review request
          </Button>
        ) : null}

        {canStartFromBacklog && onStartFromBacklog ? (
          <Button
            size="sm"
            onClick={() => void onStartFromBacklog()}
            disabled={startingFromBacklog}
          >
            {startingFromBacklog ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-3.5 w-3.5" />
            )}
            Start work
          </Button>
        ) : null}

        {canResume && onResume ? (
          <Button size="sm" onClick={onResume}>
            <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
            Resume
          </Button>
        ) : null}

        {canStopRun && onStopRun ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onStopRun()}
            disabled={stoppingRun}
          >
            {stoppingRun ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="mr-1.5 h-3.5 w-3.5" />
            )}
            {stoppingRun ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
