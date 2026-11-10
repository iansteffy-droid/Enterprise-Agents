import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentConfigRevisions,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  costEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueExecutionDecisions,
  issues,
  issueComments,
} from "@paperclipai/db";
import {
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
  getAgentWorkEligibility,
  isUuidLike,
  normalizeAgentApiKeyScope,
  normalizeAgentUrlKey,
  type AgentEligibilityAgent,
  type AgentApiKeyScope,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { syncAgentAdapterEnvBindings } from "./agent-secret-bindings.js";
import { normalizeAgentPermissions } from "./agent-permissions.js";
import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";
import { secretService } from "./secrets.js";
import { openPauseInterval, closePauseInterval } from "./pause-intervals.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

const CONFIG_REVISION_FIELDS = [
  "name",
  "role",
  "title",
  "reportsTo",
  "capabilities",
  "adapterType",
  "adapterConfig",
  "runtimeConfig",
  "defaultEnvironmentId",
  "budgetMonthlyCents",
  "metadata",
] as const;

type ConfigRevisionField = (typeof CONFIG_REVISION_FIELDS)[number];
type AgentConfigSnapshot = Pick<typeof agents.$inferSelect, ConfigRevisionField>;

interface RevisionMetadata {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  source?: string;
  rolledBackFromRevisionId?: string | null;
}

interface UpdateAgentOptions {
  recordRevision?: RevisionMetadata;
}

interface AgentShortnameRow {
  id: string;
  name: string;
  status: string;
}

interface AgentShortnameCollisionOptions {
  excludeAgentId?: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildConfigSnapshot(
  row: Pick<typeof agents.$inferSelect, ConfigRevisionField>,
): AgentConfigSnapshot {
  const adapterConfig =
    typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
      ? sanitizeRecord(row.adapterConfig as Record<string, unknown>)
      : {};
  const runtimeConfig =
    typeof row.runtimeConfig === "object" && row.runtimeConfig !== null && !Array.isArray(row.runtimeConfig)
      ? sanitizeRecord(row.runtimeConfig as Record<string, unknown>)
      : {};
  const metadata =
    typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
      ? sanitizeRecord(row.metadata as Record<string, unknown>)
      : row.metadata ?? null;
  return {
    name: row.name,
    role: row.role,
    title: row.title,
    reportsTo: row.reportsTo,
    capabilities: row.capabilities,
    adapterType: row.adapterType,
    adapterConfig,
    runtimeConfig,
    defaultEnvironmentId: row.defaultEnvironmentId,
    budgetMonthlyCents: row.budgetMonthlyCents,
    metadata,
  };
}

function containsRedactedMarker(value: unknown): boolean {
  if (value === REDACTED_EVENT_VALUE) return true;
  if (Array.isArray(value)) return value.some((item) => containsRedactedMarker(item));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((entry) => containsRedactedMarker(entry));
}

function hasConfigPatchFields(data: Partial<typeof agents.$inferInsert>) {
  return CONFIG_REVISION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

function parseFiniteNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRuntimeConfigForNewAgent(runtimeConfig: unknown): Record<string, unknown> {
  const normalizedRuntimeConfig = isPlainRecord(runtimeConfig) ? { ...runtimeConfig } : {};
  const heartbeat = isPlainRecord(normalizedRuntimeConfig.heartbeat)
    ? { ...normalizedRuntimeConfig.heartbeat }
    : {};
  if (parseFiniteNumberLike(heartbeat.maxConcurrentRuns) == null) {
    heartbeat.maxConcurrentRuns = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
  }
  normalizedRuntimeConfig.heartbeat = heartbeat;
  return normalizedRuntimeConfig;
}

function diffConfigSnapshot(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): string[] {
  return CONFIG_REVISION_FIELDS.filter((field) => !jsonEqual(before[field], after[field]));
}

function configPatchFromSnapshot(snapshot: unknown): Partial<typeof agents.$inferInsert> {
  if (!isPlainRecord(snapshot)) throw unprocessable("Invalid revision snapshot");

  if (typeof snapshot.name !== "string" || snapshot.name.length === 0) {
    throw unprocessable("Invalid revision snapshot: name");
  }
  if (typeof snapshot.role !== "string" || snapshot.role.length === 0) {
    throw unprocessable("Invalid revision snapshot: role");
  }
  if (typeof snapshot.adapterType !== "string" || snapshot.adapterType.length === 0) {
    throw unprocessable("Invalid revision snapshot: adapterType");
  }
  if (typeof snapshot.budgetMonthlyCents !== "number" || !Number.isFinite(snapshot.budgetMonthlyCents)) {
    throw unprocessable("Invalid revision snapshot: budgetMonthlyCents");
  }

  return {
    name: snapshot.name,
    role: snapshot.role,
    title: typeof snapshot.title === "string" || snapshot.title === null ? snapshot.title : null,
    reportsTo:
      typeof snapshot.reportsTo === "string" || snapshot.reportsTo === null ? snapshot.reportsTo : null,
    capabilities:
      typeof snapshot.capabilities === "string" || snapshot.capabilities === null
        ? snapshot.capabilities
        : null,
    adapterType: snapshot.adapterType,
    adapterConfig: isPlainRecord(snapshot.adapterConfig) ? snapshot.adapterConfig : {},
    runtimeConfig: isPlainRecord(snapshot.runtimeConfig) ? snapshot.runtimeConfig : {},
    defaultEnvironmentId:
      typeof snapshot.defaultEnvironmentId === "string" || snapshot.defaultEnvironmentId === null
        ? snapshot.defaultEnvironmentId
        : null,
    budgetMonthlyCents: Math.max(0, Math.floor(snapshot.budgetMonthlyCents)),
    metadata: isPlainRecord(snapshot.metadata) || snapshot.metadata === null ? snapshot.metadata : null,
  };
}

export function hasAgentShortnameCollision(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
  options?: AgentShortnameCollisionOptions,
): boolean {
  const candidateShortname = normalizeAgentUrlKey(candidateName);
  if (!candidateShortname) return false;

  return existingAgents.some((agent) => {
    if (agent.status === "terminated") return false;
    if (options?.excludeAgentId && agent.id === options.excludeAgentId) return false;
    return normalizeAgentUrlKey(agent.name) === candidateShortname;
  });
}

export function deduplicateAgentName(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
): string {
  if (!hasAgentShortnameCollision(candidateName, existingAgents)) {
    return candidateName;
  }
  for (let i = 2; i <= 100; i++) {
    const suffixed = `${candidateName} ${i}`;
    if (!hasAgentShortnameCollision(suffixed, existingAgents)) {
      return suffixed;
    }
  }
  return `${candidateName} ${Date.now()}`;
}

export function buildAgentAvatarUrl(avatarAssetId: string | null | undefined): string | null {
  return avatarAssetId ? `/api/assets/${avatarAssetId}/content` : null;
}

export function agentService(db: Db) {
  const secretsSvc = secretService(db);

  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  function withUrlKey<T extends { id: string; name: string }>(row: T) {
    return {
      ...row,
      urlKey: normalizeAgentUrlKey(row.name) ?? row.id,
    };
  }

  function normalizeAgentBaseRow(row: typeof agents.$inferSelect) {
    return withUrlKey({
      ...row,
      permissions: normalizeAgentPermissions(row.permissions, row.role),
      avatarUrl: buildAgentAvatarUrl(row.avatarAssetId),
    });
  }

  function toEligibilityAgent(row: Pick<typeof agents.$inferSelect, "id" | "companyId" | "name" | "status" | "reportsTo">): AgentEligibilityAgent {
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      status: row.status,
      reportsTo: row.reportsTo,
    };
  }

  function normalizeAgentRows(rows: (typeof agents.$inferSelect)[], allCompanyRows = rows) {
    const eligibilityAgents = allCompanyRows.map(toEligibilityAgent);
    return rows.map((row) => {
      const base = normalizeAgentBaseRow(row);
      return {
        ...base,
        orgChainHealth: getAgentWorkEligibility({
          agent: toEligibilityAgent(row),
          agents: eligibilityAgents,
        }).orgChainHealth,
      };
    });
  }

  function normalizeAgentRow(row: typeof agents.$inferSelect, allCompanyRows?: (typeof agents.$inferSelect)[]) {
    return normalizeAgentRows([row], allCompanyRows)[0]!;
  }

  async function listCompanyAgentRows(companyId: string) {
    return db.select().from(agents).where(eq(agents.companyId, companyId));
  }

  async function getMonthlySpendByAgentIds(companyId: string, agentIds: string[]) {
    if (agentIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await db
      .select({
        agentId: costEvents.agentId,
        spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          inArray(costEvents.agentId, agentIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.agentId);
    return new Map(rows.map((row) => [row.agentId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateAgentSpend<T extends { id: string; companyId: string; spentMonthlyCents: number }>(rows: T[]) {
    const agentIds = rows.map((row) => row.id);
    const companyId = rows[0]?.companyId;
    if (!companyId || agentIds.length === 0) return rows;
    const spendByAgentId = await getMonthlySpendByAgentIds(companyId, agentIds);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByAgentId.get(row.id) ?? 0,
    }));
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [companyRows, hydrated] = await Promise.all([
      listCompanyAgentRows(row.companyId),
      hydrateAgentSpend([row]).then((rows) => rows[0]!),
    ]);
    return normalizeAgentRow(hydrated, companyRows);
  }

  async function requireGetById(id: string) {
    const agent = await getById(id);
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  async function ensureManager(companyId: string, managerId: string) {
    const manager = await getById(managerId);
    if (!manager) throw notFound("Manager not found");
    if (manager.companyId !== companyId) {
      throw unprocessable("Manager must belong to same company");
    }
    return manager;
  }

  async function assertNoCycle(agentId: string, reportsTo: string | null | undefined) {
    if (!reportsTo) return;
    if (reportsTo === agentId) throw unprocessable("Agent cannot report to itself");

    let cursor: string | null = reportsTo;
    while (cursor) {
      if (cursor === agentId) throw unprocessable("Reporting relationship would create cycle");
      const next = await getById(cursor);
      cursor = next?.reportsTo ?? null;
    }
  }

  async function assertCompanyShortnameAvailable(
    companyId: string,
    candidateName: string,
    options?: AgentShortnameCollisionOptions,
  ) {
    const candidateShortname = normalizeAgentUrlKey(candidateName);
    if (!candidateShortname) return;

    const existingAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const hasCollision = hasAgentShortnameCollision(candidateName, existingAgents, options);
    if (hasCollision) {
      throw conflict(
        `Agent shortname '${candidateShortname}' is already in use in this company`,
      );
    }
  }

  async function syncAgentSecretBindings(
    agent: { id: string; companyId: string; adapterConfig: unknown },
    dbClient: Db = db,
  ) {
    const scopedSecretsSvc = dbClient === db ? secretsSvc : secretService(dbClient);
    await syncAgentAdapterEnvBindings({
      secretsSvc: scopedSecretsSvc,
      companyId: agent.companyId,
      agentId: agent.id,
      adapterConfig: agent.adapterConfig,
    });
  }

  async function updateAgent(
    id: string,
    data: Partial<typeof agents.$inferInsert>,
    options?: UpdateAgentOptions,
  ) {
    const existing = await getById(id);
    if (!existing) return null;

    if (existing.status === "terminated" && data.status && data.status !== "terminated") {
      throw conflict("Terminated agents cannot be resumed");
    }
    if (
      existing.status === "pending_approval" &&
      data.status &&
      data.status !== "pending_approval" &&
      data.status !== "terminated"
    ) {
      throw conflict("Pending approval agents cannot be activated directly");
    }

    if (data.reportsTo !== undefined) {
      if (data.reportsTo) {
        await ensureManager(existing.companyId, data.reportsTo);
      }
      await assertNoCycle(id, data.reportsTo);
    }

    if (data.name !== undefined) {
      const previousShortname = normalizeAgentUrlKey(existing.name);
      const nextShortname = normalizeAgentUrlKey(data.name);
      if (previousShortname !== nextShortname) {
        await assertCompanyShortnameAvailable(existing.companyId, data.name, { excludeAgentId: id });
      }
    }

    const normalizedPatch = { ...data } as Partial<typeof agents.$inferInsert>;
    if (data.permissions !== undefined) {
      const role = (data.role ?? existing.role) as string;
      normalizedPatch.permissions = normalizeAgentPermissions(data.permissions, role);
    }
    if (
      Object.prototype.hasOwnProperty.call(normalizedPatch, "adapterConfig") &&
      isPlainRecord(normalizedPatch.adapterConfig)
    ) {
      normalizedPatch.adapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        existing.companyId,
        normalizedPatch.adapterConfig,
        { adapterType: (normalizedPatch.adapterType ?? existing.adapterType) as string },
      );
    }

    const shouldRecordRevision = Boolean(options?.recordRevision) && hasConfigPatchFields(normalizedPatch);
    const beforeConfig = shouldRecordRevision ? buildConfigSnapshot(existing) : null;

    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const updated = await tx
        .update(agents)
        .set({ ...normalizedPatch, updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;

      if (Object.prototype.hasOwnProperty.call(normalizedPatch, "adapterConfig")) {
        await syncAgentSecretBindings(updated, txDb);
      }

      const normalizedUpdated = await agentService(txDb).getById(updated.id);
      if (!normalizedUpdated) {
        throw notFound("Agent not found");
      }

      if (shouldRecordRevision && beforeConfig) {
        const afterConfig = buildConfigSnapshot(normalizedUpdated);
        const changedKeys = diffConfigSnapshot(beforeConfig, afterConfig);
        if (changedKeys.length > 0) {
          await tx.insert(agentConfigRevisions).values({
            companyId: normalizedUpdated.companyId,
            agentId: normalizedUpdated.id,
            createdByAgentId: options?.recordRevision?.createdByAgentId ?? null,
            createdByUserId: options?.recordRevision?.createdByUserId ?? null,
            source: options?.recordRevision?.source ?? "patch",
            rolledBackFromRevisionId: options?.recordRevision?.rolledBackFromRevisionId ?? null,
            changedKeys,
            beforeConfig: beforeConfig as unknown as Record<string, unknown>,
            afterConfig: afterConfig as unknown as Record<string, unknown>,
          });
        }
      }

      return normalizedUpdated;
    });
  }

  return {
    list: async (companyId: string, options?: { includeTerminated?: boolean }) => {
      const conditions = [eq(agents.companyId, companyId)];
      if (!options?.includeTerminated) {
        conditions.push(ne(agents.status, "terminated"));
      }
      const [rows, allCompanyRows] = await Promise.all([
        db.select().from(agents).where(and(...conditions)),
        listCompanyAgentRows(companyId),
      ]);
      const hydrated = await hydrateAgentSpend(rows);
      return normalizeAgentRows(hydrated, allCompanyRows);
    },

    getById,

    create: async (companyId: string, data: Omit<typeof agents.$inferInsert, "companyId">) => {
      if (data.reportsTo) {
        await ensureManager(companyId, data.reportsTo);
      }

      const existingAgents = await db
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      const uniqueName = deduplicateAgentName(data.name, existingAgents);

      const role = data.role ?? "general";
      const normalizedPermissions = normalizeAgentPermissions(data.permissions, role);
      const runtimeConfig = normalizeRuntimeConfigForNewAgent(data.runtimeConfig);
      const adapterType = data.adapterType ?? "process";
      const adapterConfig = isPlainRecord(data.adapterConfig)
        ? await secretsSvc.normalizeAdapterConfigForPersistence(companyId, data.adapterConfig, { adapterType })
        : {};
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const created = await tx
          .insert(agents)
          .values({
            ...data,
            name: uniqueName,
            companyId,
            role,
            adapterType,
            adapterConfig,
            permissions: normalizedPermissions,
            runtimeConfig,
          })
          .returning()
          .then((rows) => rows[0]);
        await syncAgentSecretBindings(created, txDb);
        const normalizedCreated = await agentService(txDb).getById(created.id);
        if (!normalizedCreated) {
          throw notFound("Agent not found");
        }
        return normalizedCreated;
      });
    },

    update: updateAgent,

    pause: async (id: string, reason: "manual" | "budget" | "system" = "manual") => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot pause terminated agent");

      const updated = await db
        .update(agents)
        .set({
          status: "paused",
          pauseReason: reason,
          pausedAt: new Date(),
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (updated) {
        await openPauseInterval(db, {
          companyId: updated.companyId,
          scopeType: "agent",
          scopeId: updated.id,
          reason,
          at: updated.pausedAt ?? new Date(),
        });
      }
      return updated ? getById(updated.id) : null;
    },

    resume: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot resume terminated agent");
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agents cannot be resumed");
      }

      const updated = await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (updated) {
        await closePauseInterval(db, { scopeType: "agent", scopeId: updated.id, at: new Date() });
      }
      return updated ? getById(updated.id) : null;
    },

    clearError: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot clear error on terminated agent");
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agents cannot have errors cleared");
      }
      if (existing.status !== "error") {
        throw conflict("Only agents in error status can have their error cleared");
      }

      const updated = await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(and(eq(agents.id, id), eq(agents.status, "error")))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) {
        throw conflict("Only agents in error status can have their error cleared");
      }
      await closePauseInterval(db, { scopeType: "agent", scopeId: updated.id, at: new Date() });
      return getById(updated.id);
    },

    terminate: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      await db
        .update(agents)
        .set({
          status: "terminated",
          pauseReason: null,
          pausedAt: null,
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id));

      await closePauseInterval(db, { scopeType: "agent", scopeId: id, at: new Date() });

      await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(agentApiKeys.agentId, id));

      return getById(id);
    },

    remove: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      return db.transaction(async (tx) => {
        await tx.update(agents).set({ reportsTo: null }).where(eq(agents.reportsTo, id));
        await tx
          .update(issues)
          .set({ assigneeAgentId: null, createdByAgentId: null })
          .where(or(eq(issues.assigneeAgentId, id), eq(issues.createdByAgentId, id)));
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.agentId, id));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, id));
        await tx.delete(activityLog).where(
          or(
            eq(activityLog.agentId, id),
            sql`${activityLog.runId} in (select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.agentId} = ${id})`,
          ),
        );
        await tx.delete(issueExecutionDecisions).where(eq(issueExecutionDecisions.actorAgentId, id));
        await tx.delete(issueComments).where(eq(issueComments.authorAgentId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.agentId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, id));
        const deleted = await tx
          .delete(agents)
          .where(eq(agents.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return deleted ? normalizeAgentRow(deleted) : null;
      });
    },

    activatePendingApproval: async (id: string) => {
      const activatedAgent = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const updated = await tx
          .update(agents)
          .set({ status: "idle", updatedAt: new Date() })
          .where(and(eq(agents.id, id), eq(agents.status, "pending_approval")))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        await syncAgentSecretBindings(updated, txDb);
        const agent = await agentService(txDb).getById(updated.id);
        if (!agent) {
          throw notFound("Agent not found");
        }
        return agent;
      });

      if (activatedAgent) {
        return { agent: activatedAgent, activated: true };
      }

      const existing = await getById(id);
      return existing ? { agent: existing, activated: false } : null;
    },

    updatePermissions: async (id: string, permissions: Record<string, unknown> & { canCreateAgents: boolean }) => {
      const existing = await getById(id);
      if (!existing) return null;

      const updated = await db
        .update(agents)
        .set({
          permissions: normalizeAgentPermissions({ ...existing.permissions, ...permissions }, existing.role),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? getById(updated.id) : null;
    },

    listConfigRevisions: async (id: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(eq(agentConfigRevisions.agentId, id))
        .orderBy(desc(agentConfigRevisions.createdAt)),

    getConfigRevision: async (id: string, revisionId: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null),

    rollbackConfigRevision: async (
      id: string,
      revisionId: string,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      const revision = await db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null);
      if (!revision) return null;
      if (containsRedactedMarker(revision.afterConfig)) {
        throw unprocessable("Cannot roll back a revision that contains redacted secret values");
      }

      const patch = configPatchFromSnapshot(revision.afterConfig);
      return updateAgent(id, patch, {
        recordRevision: {
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          source: "rollback",
          rolledBackFromRevisionId: revision.id,
        },
      });
    },

    createApiKey: async (id: string, name: string, scope: AgentApiKeyScope = { kind: "standard" }) => {
      const existing = await getById(id);
      if (!existing) throw notFound("Agent not found");
      if (existing.status === "pending_approval") {
        throw conflict("Cannot create keys for pending approval agents");
      }
      if (existing.status === "terminated") {
        throw conflict("Cannot create keys for terminated agents");
      }

      const token = createToken();
      const keyHash = hashToken(token);
      const created = await db
        .insert(agentApiKeys)
        .values({
          agentId: id,
          companyId: existing.companyId,
          name,
          keyHash,
          scopeConfig: scope.kind === "standard" ? null : scope,
        })
        .returning()
        .then((rows) => rows[0]);

      return {
        id: created.id,
        name: created.name,
        scope: normalizeAgentApiKeyScope(created.scopeConfig),
        token,
        createdAt: created.createdAt,
      };
    },

    listKeys: (id: string) =>
      db
        .select({
          id: agentApiKeys.id,
          name: agentApiKeys.name,
          scopeConfig: agentApiKeys.scopeConfig,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, id))
        .then((rows) => rows.map((row) => ({
          id: row.id,
          name: row.name,
          scope: normalizeAgentApiKeyScope(row.scopeConfig),
          createdAt: row.createdAt,
          revokedAt: row.revokedAt,
        }))),

    getKeyById: async (keyId: string) =>
      db
        .select({
          id: agentApiKeys.id,
          agentId: agentApiKeys.agentId,
          companyId: agentApiKeys.companyId,
          name: agentApiKeys.name,
          scopeConfig: agentApiKeys.scopeConfig,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.id, keyId))
        .then((rows) => {
          const row = rows[0] ?? null;
          return row
            ? {
              ...row,
              scope: normalizeAgentApiKeyScope(row.scopeConfig),
            }
            : null;
        }),

    revokeKey: async (agentId: string, keyId: string) => {
      const rows = await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(agentApiKeys.id, keyId), eq(agentApiKeys.agentId, agentId)))
        .returning();
      return rows[0] ?? null;
    },

    orgForCompany: async (companyId: string) => {
      const allCompanyRows = await listCompanyAgentRows(companyId);
      const rows = allCompanyRows.filter((row) => row.status !== "terminated");
      const normalizedRows = normalizeAgentRows(rows, allCompanyRows);
      const byManager = new Map<string | null, typeof normalizedRows>();
      for (const row of normalizedRows) {
        const key = row.reportsTo && rows.some((candidate) => candidate.id === row.reportsTo) ? row.reportsTo : null;
        const group = byManager.get(key) ?? [];
        group.push(row);
        byManager.set(key, group);
      }

      const build = (managerId: string | null): Array<Record<string, unknown>> => {
        const members = byManager.get(managerId) ?? [];
        return members.map((member) => ({
          ...member,
          reports: build(member.id),
        }));
      };

      return build(null);
    },

    // Derives the recency-weighted "average" agentic handoff graph for feature
    // work. A feature is a top-level (parent) ticket whose lineage the Project
    // Manager ("pm" role) touched; within each feature's lineage we read the
    // time-ordered sequence of agents that acted (activity_log.agentId) and
    // treat consecutive distinct agents as a handoff A -> B. Features are
    // weighted by exponential recency decay so the current process dominates.
    // Result is intentionally shaped for a future live overlay: stable agentId
    // node keys and `${from}->${to}` edge ids.
    workflowForCompany: async (companyId: string) => {
      // Edge strength reflects agent interaction over a rolling recent window;
      // within it we still lean on newer tickets via a short half-life.
      const WINDOW_DAYS = 14;
      const HALF_LIFE_DAYS = 14;
      const tau = HALF_LIFE_DAYS / Math.LN2;
      const now = Date.now();
      const lookbackDate = new Date(now - WINDOW_DAYS * 86_400_000);
      const round = (n: number) => Math.round(n * 1000) / 1000;

      // Agent metadata lookup (include terminated so past contributors render).
      const agentRows = await db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          status: agents.status,
          adapterType: agents.adapterType,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      const agentById = new Map(agentRows.map((a) => [a.id, a]));
      const pmIds = new Set(agentRows.filter((a) => a.role === "pm").map((a) => a.id));

      const emptyGraph = {
        nodes: [] as Array<Record<string, unknown>>,
        edges: [] as Array<Record<string, unknown>>,
        meta: { ticketCount: 0, windowDays: WINDOW_DAYS, generatedAt: new Date(now).toISOString() },
      };
      if (pmIds.size === 0) return emptyGraph;

      // All issues for lineage resolution + recency dates.
      const issueRows = await db
        .select({
          id: issues.id,
          parentId: issues.parentId,
          createdByAgentId: issues.createdByAgentId,
          completedAt: issues.completedAt,
          startedAt: issues.startedAt,
          createdAt: issues.createdAt,
          hiddenAt: issues.hiddenAt,
        })
        .from(issues)
        .where(eq(issues.companyId, companyId));
      const issueById = new Map(issueRows.map((i) => [i.id, i]));

      // Resolve each issue to its top-level ancestor (cycle-guarded, memoized).
      const rootCache = new Map<string, string>();
      const rootOf = (startId: string): string => {
        const path: string[] = [];
        const guard = new Set<string>();
        let cur = startId;
        for (;;) {
          const cached = rootCache.get(cur);
          if (cached) {
            for (const p of path) rootCache.set(p, cached);
            return cached;
          }
          const row = issueById.get(cur);
          const parent =
            row?.parentId && issueById.has(row.parentId) && !guard.has(row.parentId) ? row.parentId : null;
          if (!parent) {
            rootCache.set(cur, cur);
            for (const p of path) rootCache.set(p, cur);
            return cur;
          }
          guard.add(cur);
          path.push(cur);
          cur = parent;
        }
      };

      const lineageByRoot = new Map<string, string[]>();
      for (const row of issueRows) {
        const root = rootOf(row.id);
        const list = lineageByRoot.get(root) ?? [];
        list.push(row.id);
        lineageByRoot.set(root, list);
      }

      // Time-ordered agent touch events per issue (bounded lookback window).
      const activityRows = await db
        .select({
          entityId: activityLog.entityId,
          agentId: activityLog.agentId,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            sql`${activityLog.agentId} is not null`,
            gte(activityLog.createdAt, lookbackDate),
          ),
        )
        .orderBy(asc(activityLog.createdAt));
      const touchesByIssue = new Map<string, Array<{ agentId: string; t: number }>>();
      const pushTouch = (issueId: string, agentId: string, t: number) => {
        const list = touchesByIssue.get(issueId) ?? [];
        list.push({ agentId, t });
        touchesByIssue.set(issueId, list);
      };
      for (const r of activityRows) {
        if (!r.agentId) continue;
        pushTouch(r.entityId, r.agentId, r.createdAt.getTime());
      }

      // Comment authorship is a richer handoff signal than activity_log alone:
      // reviewers/QA/security often only surface in the comment thread. Merge
      // comment-author events into the same per-issue touch stream; the
      // per-feature loop re-sorts everything by timestamp.
      const commentRows = await db
        .select({
          issueId: issueComments.issueId,
          authorAgentId: issueComments.authorAgentId,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            sql`${issueComments.authorAgentId} is not null`,
            gte(issueComments.createdAt, lookbackDate),
          ),
        );
      for (const r of commentRows) {
        if (!r.authorAgentId) continue;
        pushTouch(r.issueId, r.authorAgentId, r.createdAt.getTime());
      }

      const nodeWeight = new Map<string, number>();
      const nodeStageSum = new Map<string, number>();
      const edgeWeight = new Map<string, number>();
      const edgeTicketCount = new Map<string, number>();
      const edgeCount = new Map<string, number>();
      const edgeEnds = new Map<string, { from: string; to: string }>();
      let featureCount = 0;

      for (const [root, lineage] of lineageByRoot) {
        const rootRow = issueById.get(root);
        if (!rootRow || rootRow.parentId || rootRow.hiddenAt) continue;

        // Merge lineage touch events into one time-ordered chain of distinct agents.
        const events: Array<{ agentId: string; t: number }> = [];
        for (const iid of lineage) {
          const es = touchesByIssue.get(iid);
          if (es) events.push(...es);
        }
        events.sort((a, b) => a.t - b.t);
        const chain: string[] = [];
        for (const e of events) {
          if (!agentById.has(e.agentId)) continue;
          if (chain[chain.length - 1] === e.agentId) continue;
          chain.push(e.agentId);
        }

        const creators = lineage
          .map((iid) => issueById.get(iid)?.createdByAgentId)
          .filter((id): id is string => Boolean(id));
        const involvesPm = chain.some((id) => pmIds.has(id)) || creators.some((id) => pmIds.has(id));
        if (!involvesPm) continue;

        // Seed with the root's creating agent (the handoff origin).
        if (
          rootRow.createdByAgentId &&
          agentById.has(rootRow.createdByAgentId) &&
          chain[0] !== rootRow.createdByAgentId
        ) {
          chain.unshift(rootRow.createdByAgentId);
        }
        if (chain.length === 0) continue;
        featureCount++;

        const ref = rootRow.completedAt ?? rootRow.startedAt ?? rootRow.createdAt;
        const ageDays = Math.max(0, (now - ref.getTime()) / 86_400_000);
        const w = Math.exp(-ageDays / tau);

        // Node stage = first normalized position in the chain, weighted by recency.
        const denom = Math.max(1, chain.length - 1);
        const firstPos = new Map<string, number>();
        chain.forEach((id, idx) => {
          if (!firstPos.has(id)) firstPos.set(id, idx / denom);
        });
        for (const [id, pos] of firstPos) {
          nodeWeight.set(id, (nodeWeight.get(id) ?? 0) + w);
          nodeStageSum.set(id, (nodeStageSum.get(id) ?? 0) + w * pos);
        }

        const seenEdge = new Set<string>();
        for (let k = 1; k < chain.length; k++) {
          const from = chain[k - 1]!;
          const to = chain[k]!;
          if (from === to) continue;
          const eid = `${from}->${to}`;
          edgeEnds.set(eid, { from, to });
          // Raw occurrence count — "how many times this handoff happened",
          // including repeats within a ticket (rework loops).
          edgeCount.set(eid, (edgeCount.get(eid) ?? 0) + 1);
          // Recency weight + feature count are tallied once per feature.
          if (seenEdge.has(eid)) continue;
          seenEdge.add(eid);
          edgeWeight.set(eid, (edgeWeight.get(eid) ?? 0) + w);
          edgeTicketCount.set(eid, (edgeTicketCount.get(eid) ?? 0) + 1);
        }
      }

      const nodes = [...nodeWeight.keys()]
        .map((id) => {
          const a = agentById.get(id)!;
          const weight = nodeWeight.get(id)!;
          return {
            agentId: id,
            name: a.name,
            role: a.role,
            status: a.status,
            adapterType: a.adapterType,
            weight: round(weight),
            avgStage: round((nodeStageSum.get(id) ?? 0) / weight),
          };
        })
        .sort((a, b) => a.avgStage - b.avgStage || b.weight - a.weight);

      const edges = [...edgeEnds.keys()]
        .map((eid) => {
          const { from, to } = edgeEnds.get(eid)!;
          return {
            id: eid,
            from,
            to,
            weight: round(edgeWeight.get(eid) ?? 0),
            ticketCount: edgeTicketCount.get(eid) ?? 0,
            count: edgeCount.get(eid) ?? 0,
          };
        })
        .sort((a, b) => b.count - a.count);

      return {
        nodes,
        edges,
        meta: { ticketCount: featureCount, windowDays: WINDOW_DAYS, generatedAt: new Date(now).toISOString() },
      };
    },

    getChainOfCommand: async (agentId: string) => {
      const chain: { id: string; name: string; role: string; title: string | null }[] = [];
      const visited = new Set<string>([agentId]);
      const start = await getById(agentId);
      let currentId = start?.reportsTo ?? null;
      while (currentId && !visited.has(currentId) && chain.length < 50) {
        visited.add(currentId);
        const mgr = await getById(currentId);
        if (!mgr) break;
        chain.push({ id: mgr.id, name: mgr.name, role: mgr.role, title: mgr.title ?? null });
        currentId = mgr.reportsTo ?? null;
      }
      return chain;
    },

    runningForAgent: (agentId: string) =>
      db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"]))),

    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { agent: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const byId = await getById(raw);
        if (!byId || byId.companyId !== companyId) {
          return { agent: null, ambiguous: false } as const;
        }
        return { agent: byId, ambiguous: false } as const;
      }

      const urlKey = normalizeAgentUrlKey(raw);
      if (!urlKey) {
        return { agent: null, ambiguous: false } as const;
      }

      const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
      const matches = normalizeAgentRows(rows, rows)
        .filter((agent) => agent.urlKey === urlKey && agent.status !== "terminated");
      if (matches.length === 1) {
        return { agent: matches[0] ?? null, ambiguous: false } as const;
      }
      if (matches.length > 1) {
        return { agent: null, ambiguous: true } as const;
      }
      return { agent: null, ambiguous: false } as const;
    },
  };
}
