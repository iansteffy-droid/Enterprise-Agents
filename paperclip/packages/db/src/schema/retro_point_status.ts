import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Recorded state of a single retrospective proposal ("retro point").
 *
 * Content is NEVER stored here: the point itself is always re-derived from the
 * retro issue's comment, so edits and new retros flow through automatically.
 * A row holds the point's status (open | merged | rejected) and its proposal
 * reference (a PR URL, or `branch:<name>` while the repo has no remote). The
 * retro facilitator agent writes the reference; the human sets merged or
 * rejected. A row exists only once something has been recorded; unset points
 * read as "open" with no reference.
 *
 * `pointKey` is the stable identifier `${retroIssueId}_${proposalNumber}`.
 */
export const retroPointStatus = pgTable(
  "retro_point_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    pointKey: text("point_key").notNull(),
    status: text("status").notNull(),
    proposalRef: text("proposal_ref"),
    note: text("note"),
    /** Board user of the last write; null when an agent wrote it. */
    updatedByUserId: text("updated_by_user_id"),
    /** Agent of the last write; null when a board user wrote it. */
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPointKeyUniqueIdx: uniqueIndex("retro_point_status_company_point_key_idx").on(
      table.companyId,
      table.pointKey,
    ),
    companyUpdatedIdx: index("retro_point_status_company_updated_idx").on(table.companyId, table.updatedAt),
  }),
);
