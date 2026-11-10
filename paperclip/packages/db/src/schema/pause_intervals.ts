// packages/db/src/schema/pause_intervals.ts
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const pauseIntervals = pgTable(
  "pause_intervals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // "agent" | "project" | "company"
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    // "manual" | "budget" | "system" | "company_archived"
    reason: text("reason").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    // null while the scope is still paused; set on resume
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeIdx: index("pause_intervals_scope_idx").on(table.scopeType, table.scopeId),
    companyOpenIdx: index("pause_intervals_company_started_idx").on(
      table.companyId,
      table.startedAt,
    ),
  }),
);
