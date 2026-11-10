ALTER TABLE "workflow_blueprints" ADD COLUMN "mode" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_blueprints" ADD COLUMN "subtask_stages" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_blueprints" ADD COLUMN "feature_stages" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_blueprints" ADD COLUMN "halt_phrases" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_blueprints" ADD COLUMN "intake_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_blueprints" ADD COLUMN "gated_subtask_kinds" jsonb DEFAULT '["impl","tests"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_blueprints" ADD COLUMN "retro" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_blueprints" ADD COLUMN "prepare_for_merge_routine_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_blueprints" ADD CONSTRAINT "workflow_blueprints_intake_agent_id_agents_id_fk" FOREIGN KEY ("intake_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_blueprints" ADD CONSTRAINT "workflow_blueprints_prepare_for_merge_routine_id_routines_id_fk" FOREIGN KEY ("prepare_for_merge_routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;