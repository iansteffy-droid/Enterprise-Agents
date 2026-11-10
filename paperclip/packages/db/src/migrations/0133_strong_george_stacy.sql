CREATE TABLE "retro_point_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"point_key" text NOT NULL,
	"status" text NOT NULL,
	"proposal_ref" text,
	"note" text,
	"updated_by_user_id" text,
	"updated_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retro_point_status" ADD CONSTRAINT "retro_point_status_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retro_point_status" ADD CONSTRAINT "retro_point_status_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retro_point_status_company_point_key_idx" ON "retro_point_status" USING btree ("company_id","point_key");--> statement-breakpoint
CREATE INDEX "retro_point_status_company_updated_idx" ON "retro_point_status" USING btree ("company_id","updated_at");