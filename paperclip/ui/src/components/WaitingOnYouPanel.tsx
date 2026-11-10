import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import type { WaitingOnYouItem } from "../lib/waiting-on-you";
import { Identity } from "./Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

interface WaitingOnYouPanelProps {
  items: WaitingOnYouItem[];
  /** Resolve an inline-resolvable request positively (approve/confirm). */
  onAccept?: (item: WaitingOnYouItem) => Promise<void> | void;
  /** Resolve an inline-resolvable request negatively (reject/decline). */
  onReject?: (item: WaitingOnYouItem) => Promise<void> | void;
}

function ticketHref(item: WaitingOnYouItem): string | null {
  if (!item.issue) return null;
  return `/issues/${item.issue.identifier ?? item.issue.id}`;
}

function TicketCell({ item }: { item: WaitingOnYouItem }) {
  const href = ticketHref(item);
  if (!item.issue || !href) {
    return <span className="text-xs text-muted-foreground">No linked ticket</span>;
  }
  return (
    <Link
      to={href}
      target="_blank"
      rel="noreferrer"
      disableIssueQuicklook
      className="inline-flex max-w-full items-center gap-1.5 no-underline text-inherit hover:underline"
      title={item.issue.title}
    >
      <span className="font-mono text-xs text-muted-foreground shrink-0">
        {item.issue.identifier ?? item.issue.id.slice(0, 8)}
      </span>
      <span className="min-w-0 truncate text-sm">{item.issue.title}</span>
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
    </Link>
  );
}

function RequestedCell({ item }: { item: WaitingOnYouItem }) {
  // Review rows synthesize createdAt from issue.updatedAt and yield "" when
  // the date fails to parse.
  const date = item.createdAt ? new Date(item.createdAt) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <span className="text-xs text-muted-foreground" title={date.toLocaleString()}>
      {timeAgo(date)}
    </span>
  );
}

function ActionsCell({
  item,
  working,
  onAccept,
  onReject,
}: {
  item: WaitingOnYouItem;
  working: { id: string; action: "accept" | "reject" } | null;
  onAccept?: (item: WaitingOnYouItem) => Promise<void> | void;
  onReject?: (item: WaitingOnYouItem) => Promise<void> | void;
}) {
  const busy = working?.id === item.id;
  const anyBusy = working !== null;
  const href = ticketHref(item);

  // Requests that need structured input to resolve (answer a form, pick
  // suggested tasks / checkbox options) are resolved on the ticket, not inline.
  if (!item.canResolveInline) {
    if (!href) return <span className="text-xs text-muted-foreground">—</span>;
    return (
      <Button asChild size="sm" variant="outline">
        <Link to={href} target="_blank" rel="noreferrer" disableIssueQuicklook>
          {item.acceptLabel}
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </Button>
    );
  }

  return (
    <div className="flex flex-nowrap items-center justify-end gap-2 whitespace-nowrap">
      <Button
        size="sm"
        variant="default"
        disabled={anyBusy || !onAccept}
        onClick={() => void onAccept?.(item)}
      >
        {busy && working?.action === "accept" ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Working…
          </>
        ) : (
          item.acceptLabel
        )}
      </Button>
      {item.rejectLabel ? (
        <Button
          size="sm"
          variant="destructive"
          disabled={anyBusy || !onReject}
          onClick={() => void onReject?.(item)}
        >
          {busy && working?.action === "reject" ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Working…
            </>
          ) : (
            item.rejectLabel
          )}
        </Button>
      ) : null}
    </div>
  );
}

export function WaitingOnYouPanel({ items, onAccept, onReject }: WaitingOnYouPanelProps) {
  const [working, setWorking] = useState<{ id: string; action: "accept" | "reject" } | null>(null);

  if (items.length === 0) return null;

  async function runAction(
    item: WaitingOnYouItem,
    action: "accept" | "reject",
    handler?: (item: WaitingOnYouItem) => Promise<void> | void,
  ) {
    if (!handler || working) return;
    setWorking({ id: item.id, action });
    try {
      await handler(item);
    } finally {
      setWorking((current) => (current?.id === item.id && current.action === action ? null : current));
    }
  }

  return (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
        Waiting on you, Q. Please dont make me regret this.
        <span className="ml-2 normal-case font-normal text-xs">
          {items.length} {items.length === 1 ? "request" : "requests"}
        </span>
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Requests your crew has raised and tickets handed to you for review. Resolve them here, or
        open the ticket for the ones that need more input.
      </p>
      <div className="max-h-96 overflow-x-auto overflow-y-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="bg-accent/20 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pl-3 pr-2 font-medium">Ticket</th>
              <th className="py-2 px-2 font-medium">Request</th>
              <th className="py-2 px-2 font-medium">Requested by</th>
              <th className="py-2 px-2 font-medium">Requested</th>
              <th className="py-2 pl-2 pr-3 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((item) => (
              <tr key={item.id} className="align-top hover:bg-accent/30 transition-colors">
                <td className="py-3 pl-3 pr-2 max-w-[16rem]">
                  <TicketCell item={item} />
                </td>
                <td className="py-3 px-2">
                  <p className={cn("text-sm leading-5 text-foreground", "line-clamp-3")}>
                    {item.message}
                  </p>
                </td>
                <td className="py-3 px-2 w-[8.5rem] max-w-[8.5rem]">
                  {item.requestingAgent ? (
                    <Link
                      to={`/agents/${item.requestingAgent.id}`}
                      className="flex min-w-0 no-underline text-inherit hover:underline"
                    >
                      <Identity
                        name={item.requestingAgent.name}
                        avatarUrl={item.requestingAgent.avatarUrl}
                        size="lg"
                        className="min-w-0 max-w-full"
                      />
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">Unknown</span>
                  )}
                </td>
                <td className="py-3 px-2 whitespace-nowrap">
                  <RequestedCell item={item} />
                </td>
                <td className="py-3 pl-2 pr-3 text-right whitespace-nowrap">
                  <ActionsCell
                    item={item}
                    working={working}
                    onAccept={(target) => runAction(target, "accept", onAccept)}
                    onReject={(target) => runAction(target, "reject", onReject)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
