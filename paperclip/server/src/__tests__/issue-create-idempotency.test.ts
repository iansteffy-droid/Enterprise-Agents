import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue create idempotency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue create idempotency", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-idempotency-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "PCI") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId };
  }

  async function countByKey(companyId: string, key: string) {
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.idempotencyKey, key)));
    return rows.length;
  }

  it("returns the existing issue when the same idempotencyKey is reused", async () => {
    const { companyId } = await createCompany();

    const first = await svc.create(companyId, {
      title: "Canonical ticket",
      status: "backlog",
      idempotencyKey: "canonical:root:canonical-ticket",
    });
    const second = await svc.create(companyId, {
      title: "Canonical ticket",
      status: "backlog",
      idempotencyKey: "canonical:root:canonical-ticket",
    });

    expect(second.id).toBe(first.id);
    expect(second.identifier).toBe(first.identifier);
    expect(await countByKey(companyId, "canonical:root:canonical-ticket")).toBe(1);
  });

  it("creates distinct issues for different idempotency keys", async () => {
    const { companyId } = await createCompany();

    const a = await svc.create(companyId, {
      title: "Ticket",
      status: "backlog",
      idempotencyKey: "key-a",
    });
    const b = await svc.create(companyId, {
      title: "Ticket",
      status: "backlog",
      idempotencyKey: "key-b",
    });

    expect(b.id).not.toBe(a.id);
  });

  it("does not deduplicate when no idempotencyKey is supplied", async () => {
    const { companyId } = await createCompany();

    const a = await svc.create(companyId, { title: "Same title", status: "backlog" });
    const b = await svc.create(companyId, { title: "Same title", status: "backlog" });

    expect(b.id).not.toBe(a.id);
  });

  it("collapses concurrent creates racing on the same key to a single issue", async () => {
    const { companyId } = await createCompany();
    const key = "canonical:root:race";

    const [first, second] = await Promise.all([
      svc.create(companyId, { title: "Race", status: "backlog", idempotencyKey: key }),
      svc.create(companyId, { title: "Race", status: "backlog", idempotencyKey: key }),
    ]);

    expect(second.id).toBe(first.id);
    expect(await countByKey(companyId, key)).toBe(1);
  });

  it("scopes idempotency keys per company", async () => {
    const { companyId: companyA } = await createCompany("PCA");
    const { companyId: companyB } = await createCompany("PCB");
    const key = "shared-key";

    const a = await svc.create(companyA, { title: "Ticket", status: "backlog", idempotencyKey: key });
    const b = await svc.create(companyB, { title: "Ticket", status: "backlog", idempotencyKey: key });

    expect(b.id).not.toBe(a.id);
    expect(await countByKey(companyA, key)).toBe(1);
    expect(await countByKey(companyB, key)).toBe(1);
  });
});
