import type { AgentScorecard } from "@paperclipai/shared";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn, formatCents, formatDurationMs } from "@/lib/utils";
import {
  CheckCircle2,
  CircleDot,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp,
  DollarSign,
  Cpu,
  Timer,
  Play,
} from "lucide-react";

// ── Metric tile ───────────────────────────────────────────────────────────────

interface MetricProps {
  icon: React.ElementType;
  label: string;
  value: string;
  /** Subtle accent applied to the icon and value when truthy */
  accent?: "positive" | "negative" | "neutral";
}

function Metric({ icon: Icon, label, value, accent }: MetricProps) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-1.5">
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            accent === "positive" && "text-green-500",
            accent === "negative" && "text-red-400",
            (!accent || accent === "neutral") && "text-muted-foreground",
          )}
        />
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
      </div>
      <span
        className={cn(
          "text-2xl font-bold tabular-nums leading-none",
          accent === "positive" && "text-green-500",
          accent === "negative" && "text-red-400",
        )}
      >
        {value}
      </span>
    </div>
  );
}

// ── Sentiment bar ─────────────────────────────────────────────────────────────

function SentimentBar({ upvotes, downvotes }: { upvotes: number; downvotes: number }) {
  const total = upvotes + downvotes;
  if (total === 0) return null;
  const positivePct = Math.round((upvotes / total) * 100);
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <ThumbsUp className="h-3 w-3 shrink-0 text-green-500" />
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-green-500"
          style={{ width: `${positivePct}%` }}
        />
      </div>
      <ThumbsDown className="h-3 w-3 shrink-0 text-red-400" />
      <span className="tabular-nums">
        {positivePct}% positive
      </span>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AgentScorecardCard({ data }: { data: AgentScorecard }) {
  const costPerCompleted =
    data.costCentsPerCompletedIssue == null
      ? "—"
      : formatCents(data.costCentsPerCompletedIssue);

  const totalTokens = data.inputTokens + data.cachedInputTokens + data.outputTokens;
  const tokensDisplay =
    totalTokens >= 1_000_000
      ? `${(totalTokens / 1_000_000).toFixed(1)}M`
      : totalTokens >= 1_000
        ? `${(totalTokens / 1_000).toFixed(1)}K`
        : String(totalTokens);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Performance</CardTitle>
        <CardDescription className="text-xs">
          All-time outcomes, feedback, and efficiency.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Sentiment bar */}
        <SentimentBar upvotes={data.upvotes} downvotes={data.downvotes} />

        {/* Outcomes */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Metric
            icon={CheckCircle2}
            label="Completed"
            value={String(data.completedIssues)}
            accent="positive"
          />
          <Metric
            icon={CircleDot}
            label="Open"
            value={String(data.openIssues)}
            accent="neutral"
          />
          <Metric
            icon={ShieldAlert}
            label="Blocked"
            value={String(data.blockedIssues)}
            accent={data.blockedIssues > 0 ? "negative" : "neutral"}
          />
        </div>

        {/* Feedback */}
        <div className="grid grid-cols-2 gap-2">
          <Metric
            icon={ThumbsUp}
            label="Upvotes"
            value={String(data.upvotes)}
            accent="positive"
          />
          <Metric
            icon={ThumbsDown}
            label="Downvotes"
            value={String(data.downvotes)}
            accent={data.downvotes > 0 ? "negative" : "neutral"}
          />
        </div>

        <Separator />

        {/* Efficiency */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric
            icon={DollarSign}
            label="Total cost"
            value={formatCents(data.costCents)}
            accent="neutral"
          />
          <Metric
            icon={DollarSign}
            label="Cost / completed"
            value={costPerCompleted}
            accent="neutral"
          />
          <Metric
            icon={Cpu}
            label="Tokens"
            value={tokensDisplay}
            accent="neutral"
          />
          <Metric
            icon={Timer}
            label="Runtime"
            value={formatDurationMs(data.runtimeMs)}
            accent="neutral"
          />
        </div>

        {/* Run count */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Play className="h-3 w-3" />
          <span>
            <span className="tabular-nums font-medium text-foreground">{data.runCount}</span>
            {" "}run{data.runCount === 1 ? "" : "s"} total
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
