import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pauseIntervals } from "@paperclipai/db";

// A db handle or a transaction handle both satisfy the query builder we use.
type PauseExecutor = Pick<Db, "select" | "insert" | "update">;

export async function openPauseInterval(
  exec: PauseExecutor,
  args: { companyId: string; scopeType: string; scopeId: string; reason: string; at: Date },
): Promise<void> {
  const existingOpen = await exec
    .select({ id: pauseIntervals.id })
    .from(pauseIntervals)
    .where(
      and(
        eq(pauseIntervals.scopeType, args.scopeType),
        eq(pauseIntervals.scopeId, args.scopeId),
        isNull(pauseIntervals.endedAt),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (existingOpen) return; // idempotent: don't stack open intervals

  await exec.insert(pauseIntervals).values({
    companyId: args.companyId,
    scopeType: args.scopeType,
    scopeId: args.scopeId,
    reason: args.reason,
    startedAt: args.at,
  });
}

export async function closePauseInterval(
  exec: PauseExecutor,
  args: { scopeType: string; scopeId: string; at: Date },
): Promise<void> {
  await exec
    .update(pauseIntervals)
    .set({ endedAt: args.at })
    .where(
      and(
        eq(pauseIntervals.scopeType, args.scopeType),
        eq(pauseIntervals.scopeId, args.scopeId),
        isNull(pauseIntervals.endedAt),
      ),
    );
}
