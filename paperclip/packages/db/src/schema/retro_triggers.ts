import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { routineRuns } from "./routines.js";

/** One row per auto-triggered retrospective; the cooldown reads the newest row per root. */
export const retroTriggers = pgTable(
  "retro_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    rootIssueId: uuid("root_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    signalKind: text("signal_kind").notNull(),
    detail: text("detail").notNull().default(""),
    routineRunId: uuid("routine_run_id").references(() => routineRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRootCreatedIdx: index("retro_triggers_company_root_created_idx").on(
      table.companyId,
      table.rootIssueId,
      table.createdAt,
    ),
  }),
);
