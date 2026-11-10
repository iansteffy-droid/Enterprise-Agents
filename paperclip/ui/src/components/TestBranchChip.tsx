import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, GitBranch } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Compact header chip that surfaces the git branch an issue's crew worked on,
 * so an operator can check it out and test the feature. Click-to-copy hands the
 * exact branch name to the clipboard (the full name, even when truncated in the
 * pill). Renders nothing when the branch is unknown — planning/research tickets
 * and issues that never got an isolated workspace simply omit it.
 */
export function TestBranchChip({
  branchName,
  via,
  className,
}: {
  branchName: string | null | undefined;
  /** Ancestor ticket identifier when the branch comes from the parent-branch rule (subtickets work on the parent's branch). */
  via?: string | null;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(async () => {
    if (!branchName) return;
    try {
      await navigator.clipboard.writeText(branchName);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — nothing actionable to surface */
    }
  }, [branchName]);

  if (!branchName) return null;

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={
        copied
          ? "Copied!"
          : `Branch to test: ${branchName}${via ? ` (parent branch — ${via})` : ""} — click to copy`
      }
      aria-label={`Copy branch ${branchName} to test`}
      data-testid="issue-detail-test-branch"
      className={cn(
        "group/branch inline-flex min-w-0 max-w-full shrink items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
        className,
      )}
    >
      <GitBranch className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 truncate font-mono">{branchName}</span>
      {via ? (
        <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs text-muted-foreground/80">
          parent branch — {via}
        </span>
      ) : null}
      {copied ? (
        <Check className="h-4 w-4 shrink-0 text-green-500" aria-hidden />
      ) : (
        <Copy className="h-4 w-4 shrink-0 opacity-60 group-hover/branch:opacity-100" aria-hidden />
      )}
    </button>
  );
}
