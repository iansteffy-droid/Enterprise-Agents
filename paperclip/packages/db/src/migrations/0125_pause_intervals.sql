CREATE TABLE "pause_intervals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pause_intervals" ADD CONSTRAINT "pause_intervals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pause_intervals_scope_idx" ON "pause_intervals" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "pause_intervals_company_started_idx" ON "pause_intervals" USING btree ("company_id","started_at");
