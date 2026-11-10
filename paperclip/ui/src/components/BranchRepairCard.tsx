import { GitMerge, Loader2 } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";

/**
 * Operator "Prepare for merge" action, shown at the bottom of a ticket detail while the
 * ticket is in review. Clicking runs the company's configured prepare-for-merge routine on
 * the feature branch named in the ticket's latest hand-off comment (`Branch: <name>`): it
 * rebases the branch onto its base, squashes it into one commit and pushes it with
 * --force-with-lease. The human then merges the pull request.
 */
export function BranchRepairCard({
  issue,
  onRepair,
  isPending,
}: {
  issue: Issue;
  onRepair: () => void;
  isPending: boolean;
}) {
  if (issue.status !== "in_review") return null;

  return (
    <div className="rounded-md border p-3">
      <p className="mb-2 text-sm text-muted-foreground">
        Prepare this ticket's feature branch for merge: the routine rebases it onto its base, squashes
        it into one commit and pushes it with force-with-lease. You then merge the pull request.
      </p>
      <Button size="sm" variant="outline" onClick={onRepair} disabled={isPending}>
        {isPending ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <GitMerge className="mr-1.5 h-3.5 w-3.5" />
        )}
        Prepare for merge
      </Button>
    </div>
  );
}
