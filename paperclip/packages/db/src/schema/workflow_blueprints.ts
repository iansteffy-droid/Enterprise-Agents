import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { WorkflowRetroSettings, WorkflowStageTemplate } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { routines } from "./routines.js";

export interface WorkflowBlueprintStage {
  key: string;
  label: string;
  position: number;
  agentIds: string[];
}

export interface WorkflowBlueprintReturnEdge {
  fromAgentId: string;
  toAgentId: string;
  label: string;
}

export const workflowBlueprints = pgTable(
  "workflow_blueprints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("The Perfect Run"),
    stages: jsonb("stages").$type<WorkflowBlueprintStage[]>().notNull().default([]),
    returnEdges: jsonb("return_edges").$type<WorkflowBlueprintReturnEdge[]>().notNull().default([]),
    mode: text("mode").notNull().default("standard"),
    subtaskStages: jsonb("subtask_stages").$type<WorkflowStageTemplate[] | null>(),
    featureStages: jsonb("feature_stages").$type<WorkflowStageTemplate[] | null>(),
    haltPhrases: jsonb("halt_phrases").$type<string[] | null>(),
    intakeAgentId: uuid("intake_agent_id").references(() => agents.id, { onDelete: "set null" }),
    gatedSubtaskKinds: jsonb("gated_subtask_kinds").$type<string[]>().notNull().default(["impl", "tests"]),
    retro: jsonb("retro").$type<WorkflowRetroSettings | null>(),
    prepareForMergeRoutineId: uuid("prepare_for_merge_routine_id").references(() => routines.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("workflow_blueprints_company_uq").on(table.companyId),
    companyIdx: index("workflow_blueprints_company_idx").on(table.companyId),
  }),
);
