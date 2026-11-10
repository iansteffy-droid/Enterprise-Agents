import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { workflowApi } from "../api/workflow";
import { agentsApi } from "../api/agents";
import type { WorkflowBlueprint, WorkflowBlueprintStage } from "../api/workflow";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { LifecycleSettings } from "../components/LifecycleSettings";

interface AgentLite {
  id: string;
  name: string;
  role: string;
  status: string;
  title?: string | null;
}

// ── Stage descriptions ────────────────────────────────────────────────────────
// Short muted descriptions shown under each built-in stage label. Custom stages
// (user-added, no matching key) display no description.
const STAGE_DESCRIPTIONS: Record<string, string> = {
  intake: "Raw Tasks arrive here and become clean, executable tickets.",
  plan: "Tickets are scoped and assigned.",
  build: "The ticket is implemented.",
  verify: "Code, security, QA, repro, and visual checks.",
  ship: "Branch hygiene and release integration.",
};

// ── Default spine classifier ──────────────────────────────────────────────────
// The approved "Ticket Lifecycle": Intake → Plan → Build → Verify Gauntlet → Ship.
// Agents are bucketed by role/title; delivery-adjacent agents (CEO, debugger,
// test planning/writing, disabled UI editor) are kept off the spine and surface
// in the off-path tray instead.

const SPINE_STAGES: { key: string; label: string }[] = [
  { key: "intake", label: "Intake" },
  { key: "plan", label: "Plan" },
  { key: "build", label: "Build" },
  { key: "verify", label: "Verify Gauntlet" },
  { key: "ship", label: "Ship" },
];

const OFF_PATH_TITLE = /debug|incident|test planner|test writer|test engineer|strategist|ui editor/;
const SHIP_TITLE = /release|branch hygiene|integration/;
// Order defines the verify-gauntlet sequence: code review → security → QA/acceptance → repro → visual.
const VERIFY_KEYWORDS = ["code review", "security", "qa", "repro", "reproduction", "visual", "acceptance"];

// Security-pod agents — kept entirely out of the dev spine and off-path tray.
const SECURITY_POD_TITLE =
  /red team|pentest|vulnerability researcher|exploit prover|security remediation|cartographer|coverage tracker/i;

export function isSecurityPodAgent(a: AgentLite): boolean {
  return SECURITY_POD_TITLE.test(a.title ?? "");
}

function classifyAgent(a: AgentLite): { stage: string; rank: number } | null {
  const role = (a.role ?? "").toLowerCase();
  const title = (a.title ?? "").toLowerCase();
  // Security-pod agents are rendered in their own static section — never on the dev spine.
  if (SECURITY_POD_TITLE.test(title)) return null;
  if (role === "ceo") return null;
  if (OFF_PATH_TITLE.test(title)) return null;
  if (role === "pm") return { stage: "intake", rank: 0 };
  if (role === "cto") return { stage: "plan", rank: 0 };
  if (SHIP_TITLE.test(title)) return { stage: "ship", rank: 0 };
  if (/developer/.test(title)) return { stage: "build", rank: 0 };
  for (let i = 0; i < VERIFY_KEYWORDS.length; i++) {
    if (title.includes(VERIFY_KEYWORDS[i])) return { stage: "verify", rank: i };
  }
  if (/review|verif/.test(title)) return { stage: "verify", rank: 99 };
  return null; // unclassified → off-path tray
}

function buildDefaultStages(agents: AgentLite[]): WorkflowBlueprintStage[] {
  const buckets = new Map<string, { id: string; rank: number }[]>();
  for (const a of agents) {
    const c = classifyAgent(a);
    if (!c) continue;
    const list = buckets.get(c.stage) ?? [];
    list.push({ id: a.id, rank: c.rank });
    buckets.set(c.stage, list);
  }
  return SPINE_STAGES.map((s, i) => ({
    key: s.key,
    label: s.label,
    position: i,
    agentIds: (buckets.get(s.key) ?? []).sort((x, y) => x.rank - y.rank).map((x) => x.id),
  })).filter((s) => s.agentIds.length > 0);
}

function buildReturnEdges(stages: WorkflowBlueprintStage[]): WorkflowBlueprint["returnEdges"] {
  const ship = stages.find((s) => s.key === "ship");
  const plan = stages.find((s) => s.key === "plan");
  if (ship?.agentIds.length && plan?.agentIds.length) {
    return [
      {
        fromAgentId: ship.agentIds[ship.agentIds.length - 1],
        toAgentId: plan.agentIds[0],
        label: "final CTO merge gate",
      },
    ];
  }
  return [];
}

// ── Agent chip ─────────────────────────────────────────────────────────────────

function AgentChip({
  agentId,
  label,
  stageKey,
  editing,
}: {
  agentId: string;
  label: string;
  stageKey: string;
  editing: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: agentId,
    data: { stageKey },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`w-full break-words rounded-md border border-border bg-card px-3 py-2 text-sm leading-snug ${editing ? "cursor-grab" : ""}`}
      {...(editing ? { ...attributes, ...listeners } : {})}
    >
      {label}
    </div>
  );
}

function Arrow({ className = "" }: { className?: string }) {
  return (
    <span className={`select-none px-1 text-muted-foreground ${className}`} aria-hidden="true">
      →
    </span>
  );
}

// ── Stage group (label + horizontal chip rail, droppable) ────────────────────────

function StageGroup({
  stage,
  agentById,
  editing,
  onLabelChange,
  onRemove,
  onMove,
  canMoveLeft,
  canMoveRight,
}: {
  stage: WorkflowBlueprintStage;
  agentById: Map<string, AgentLite>;
  editing: boolean;
  onLabelChange: (key: string, label: string) => void;
  onRemove: (key: string) => void;
  onMove: (key: string, dir: -1 | 1) => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage:${stage.key}`, data: { stageKey: stage.key } });
  const description = STAGE_DESCRIPTIONS[stage.key];

  return (
    <div className="flex flex-col">
      {editing ? (
        <div className="mb-1 flex flex-col gap-0.5">
          <div className="flex h-6 items-center gap-1">
            <input
              aria-label="Stage name"
              value={stage.label}
              onChange={(e) => onLabelChange(stage.key, e.target.value)}
              className="w-28 rounded border border-border bg-transparent px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide"
            />
            <button type="button" title="Move left" disabled={!canMoveLeft} onClick={() => onMove(stage.key, -1)} className="px-0.5 text-xs text-muted-foreground disabled:opacity-30">◀</button>
            <button type="button" title="Move right" disabled={!canMoveRight} onClick={() => onMove(stage.key, 1)} className="px-0.5 text-xs text-muted-foreground disabled:opacity-30">▶</button>
            <button type="button" title="Remove stage" onClick={() => onRemove(stage.key)} className="px-0.5 text-xs text-destructive">×</button>
          </div>
          {description && (
            <p className="w-[200px] text-[11px] leading-snug text-muted-foreground">{description}</p>
          )}
        </div>
      ) : (
        <div className="mb-2 flex flex-col gap-0.5">
          <div className="flex h-6 items-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {stage.label}
          </div>
          {description && (
            <p className="w-[200px] text-[11px] leading-snug text-muted-foreground">{description}</p>
          )}
        </div>
      )}

      <div
        ref={setNodeRef}
        className={`w-[200px] rounded-lg border p-2 ${isOver ? "border-primary bg-muted/40" : "border-transparent bg-muted/30"}`}
      >
        <SortableContext items={stage.agentIds} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1.5">
            {stage.agentIds.map((id, i) => (
              <div key={id}>
                {i > 0 && !editing && (
                  <div className="flex justify-center py-0.5 text-xs text-muted-foreground" aria-hidden="true">
                    ↓
                  </div>
                )}
                <AgentChip
                  agentId={id}
                  label={agentById.get(id)?.name ?? id}
                  stageKey={stage.key}
                  editing={editing}
                />
              </div>
            ))}
            {stage.agentIds.length === 0 && (
              <div className="rounded-md border border-dashed border-border px-4 py-3 text-center text-xs text-muted-foreground">
                drop an agent here
              </div>
            )}
          </div>
        </SortableContext>
      </div>
    </div>
  );
}

// ── Security Pod Spine ────────────────────────────────────────────────────────
// A READ-ONLY static section; no dnd/edit/blueprint/save/adherence wiring.

interface SecurityStage {
  label: string;
  description: string;
  agentTitle: string; // title to match against AgentLite.title
  fallback: string;   // codename/role label shown when agent isn't in roster
  gated?: boolean;    // only runs on explicit operator command (not part of the default report-only flow)
}

const SECURITY_STAGES: SecurityStage[] = [
  {
    label: "Dispatch",
    description: "The red team lead carves the codebase into attack-surface audit units and dispatches hunts.",
    agentTitle: "Red Team Lead / Pentest Dispatcher",
    fallback: "Red team lead",
  },
  {
    label: "Hunt",
    description: "The vulnerability researcher audits a unit (SAST + light dynamic), emits findings with file:line + severity.",
    agentTitle: "Vulnerability Researcher",
    fallback: "Vulnerability researcher",
  },
  {
    label: "Prove",
    description: "The exploit prover adversarially verifies each finding (refute-first, network-truth); only confirmed exploits pass.",
    agentTitle: "Exploit Prover",
    fallback: "Exploit prover",
  },
  {
    label: "Report",
    description: "The red team lead records confirmed findings in the pentest report — the pod's deliverable. What gets fixed is the operator's call.",
    agentTitle: "Red Team Lead / Pentest Dispatcher",
    fallback: "Red team lead",
  },
  {
    label: "Remediate",
    description: "Only on explicit operator command: the security remediation engineer fixes the vuln on a feature branch with a regression test and opens a PR.",
    agentTitle: "Security Remediation Engineer",
    fallback: "Security remediation engineer",
    gated: true,
  },
  {
    label: "Re-prove",
    description: "The exploit prover re-attacks the patched branch; a commanded fix is done only when the hole is killed.",
    agentTitle: "Exploit Prover",
    fallback: "Exploit prover",
    gated: true,
  },
];

function SecurityPodSpine({ podAgents }: { podAgents: AgentLite[] }) {
  function resolveAgentName(agentTitle: string, fallback: string): string {
    const match = podAgents.find(
      (a) => (a.title ?? "").toLowerCase() === agentTitle.toLowerCase(),
    );
    return match ? match.name : fallback;
  }

  const cartographer = podAgents.find((a) =>
    /cartographer|coverage tracker/i.test(a.title ?? ""),
  );
  const cartographerName = cartographer ? cartographer.name : "Coverage cartographer";

  if (podAgents.length === 0) return null;

  const defaultStages = SECURITY_STAGES.filter((s) => !s.gated);
  const gatedStages = SECURITY_STAGES.filter((s) => s.gated);

  function renderStage(stage: SecurityStage, showArrow: boolean) {
    return (
      <div key={stage.label} className="flex items-start">
        {showArrow && <Arrow className="mt-[52px]" />}
        <div className="flex flex-col">
          <div className="mb-2 flex flex-col gap-0.5">
            <div className="flex h-6 items-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {stage.label}
            </div>
            <p className="w-[200px] text-[11px] leading-snug text-muted-foreground">
              {stage.description}
            </p>
          </div>
          <div className="w-[200px] rounded-lg border border-transparent bg-muted/30 p-2">
            <div
              className={`rounded-md px-3 py-2 text-sm leading-snug ${
                stage.gated
                  ? "border border-dashed border-border bg-card/60 text-muted-foreground"
                  : "border border-border bg-card"
              }`}
            >
              {resolveAgentName(stage.agentTitle, stage.fallback)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="mt-10 border-t border-border pt-8">
      <div className="mb-1">
        <h2 className="text-base font-semibold">Security Pod — Vulnerability Lifecycle</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          A red team that sweeps the codebase for vulnerabilities — find → prove → report. The pod never
          fixes code or opens PRs on its own; remediation runs only on the operator's explicit
          command.
        </p>
      </div>

      {/* Coverage note */}
      <div className="mt-3 mb-4 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Coverage</span>
        <span aria-hidden="true">·</span>
        <span>
          {cartographerName} maintains the durable map of what has been pen-tested and when; the red
          team lead reads it to prioritize.
        </span>
      </div>

      {/* Default report-only spine: find → prove → report */}
      <div className="mt-2 flex items-start gap-1 overflow-x-auto pb-3">
        {defaultStages.map((stage, i) => renderStage(stage, i > 0))}
        <div className="mt-[52px] flex items-center">
          <Arrow />
          <span className="whitespace-nowrap rounded-md border border-emerald-600/40 bg-emerald-600/10 px-3 py-2 text-sm text-emerald-700">
            ★ Deliverable · report + coverage map
          </span>
        </div>
      </div>

      {/* Gated remediation — operator command only */}
      <div className="mt-4 rounded-lg border border-dashed border-border bg-muted/10 p-3">
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-amber-600/40 bg-amber-600/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-amber-700">
          On operator command only
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          The pod does not remediate on its own. Only when the operator explicitly commands a
          specific fix does the blue-team path run — on a feature branch, human-merged, never the mainline.
        </p>
        <div className="flex items-start gap-1 overflow-x-auto pb-1">
          {gatedStages.map((stage, i) => renderStage(stage, i > 0))}
          <div className="mt-[52px] flex items-center">
            <Arrow />
            <span className="whitespace-nowrap rounded-md border border-amber-600/40 bg-amber-600/10 px-3 py-2 text-sm text-amber-700">
              ✓ Killed
            </span>
          </div>
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Human merge only — agents never push directly to the mainline, and never open a PR without an
        operator command.
      </p>
    </section>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function PerfectRun() {
  const { selectedCompanyId: companyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [blueprint, setBlueprint] = useState<WorkflowBlueprint | null>(null);
  // Last blueprint the server returned; the settings editor echoes its spine back, so
  // unsaved spine edits never leak into a settings save (and vice versa).
  const [stored, setStored] = useState<WorkflowBlueprint | null>(null);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Ticket Lifecycle" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (!companyId) return;
    let alive = true;
    (async () => {
      try {
        const [bp, roster] = await Promise.all([
          workflowApi.getBlueprint(companyId),
          agentsApi.list(companyId),
        ]);
        if (!alive) return;
        const lite: AgentLite[] = roster.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role ?? "",
          status: a.status ?? "",
          title: (a as { title?: string | null }).title ?? null,
        }));
        setAgents(lite);
        const resolved: WorkflowBlueprint =
          bp && bp.stages.length > 0
            ? bp
            : (() => {
                const stages = buildDefaultStages(lite);
                return {
                  companyId,
                  name: "Ticket Lifecycle",
                  updatedAt: null,
                  stages,
                  returnEdges: buildReturnEdges(stages),
                  // Spine-only editor: chain/halt/retro settings are not edited here and a
                  // save omits them, so the server keeps whatever is stored.
                  mode: "standard",
                  subtaskStages: null,
                  featureStages: null,
                  haltPhrases: null,
                  intakeAgentId: null,
                  gatedSubtaskKinds: ["impl", "tests"],
                  retro: null,
                  prepareForMergeRoutineId: null,
                };
              })();
        setBlueprint(resolved);
        setStored(resolved);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load workflow");
      }
    })();
    return () => {
      alive = false;
    };
  }, [companyId]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  // Adherence is compared against the spine currently shown. Routed through
  // react-query so LiveUpdatesProvider can invalidate it on relevant issue
  // events — the stat then refetches live (only while this page is mounted,
  // and only when real activity fires; no polling).
  const blueprintRef = useRef<WorkflowBlueprint | null>(null);
  blueprintRef.current = blueprint;
  const { data: adherence } = useQuery({
    queryKey: queryKeys.workflowAdherence(companyId ?? ""),
    queryFn: () => {
      const bp = blueprintRef.current!;
      return workflowApi.previewAdherence(companyId!, {
        name: bp.name,
        stages: bp.stages,
        returnEdges: bp.returnEdges,
      });
    },
    enabled: !!companyId && !!blueprint,
    staleTime: 15_000,
  });

  const offPathAgents = useMemo(() => {
    if (!blueprint) return [];
    const placed = new Set(blueprint.stages.flatMap((s) => s.agentIds));
    // Security-pod agents are shown in their own section, not in the off-path tray.
    return agents.filter((a) => !placed.has(a.id) && !isSecurityPodAgent(a));
  }, [agents, blueprint]);

  const securityPodAgents = useMemo(() => agents.filter(isSecurityPodAgent), [agents]);

  const idealHandoffs = useMemo(() => {
    if (!blueprint) return 0;
    const count = blueprint.stages.reduce((n, s) => n + s.agentIds.length, 0);
    return Math.max(0, count - 1);
  }, [blueprint]);

  const sensors = useSensors(useSensor(PointerSensor));

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    if (!blueprint) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const draggedId = active.id as string;
    const overId = over.id as string;
    const sourceStageKey = active.data.current?.stageKey as string | undefined;
    const targetStageKey = over.data.current?.stageKey as string | undefined;
    if (!sourceStageKey || !targetStageKey) return;

    if (sourceStageKey === targetStageKey) {
      const stage = blueprint.stages.find((s) => s.key === sourceStageKey);
      if (!stage) return;
      const oldIndex = stage.agentIds.indexOf(draggedId);
      const newIndex = stage.agentIds.indexOf(overId);
      if (oldIndex === -1 || newIndex === -1) return;
      setBlueprint({
        ...blueprint,
        stages: blueprint.stages.map((s) =>
          s.key === sourceStageKey ? { ...s, agentIds: arrayMove(s.agentIds, oldIndex, newIndex) } : s,
        ),
      });
      return;
    }

    const nextStages = blueprint.stages.map((stage) => {
      if (stage.key === sourceStageKey) {
        return { ...stage, agentIds: stage.agentIds.filter((id) => id !== draggedId) };
      }
      if (stage.key === targetStageKey) {
        const overIndex = stage.agentIds.indexOf(overId);
        const insertAt = overIndex === -1 ? stage.agentIds.length : overIndex;
        const next = [...stage.agentIds];
        next.splice(insertAt, 0, draggedId);
        return { ...stage, agentIds: next };
      }
      return stage;
    });
    setBlueprint({ ...blueprint, stages: nextStages });
  }

  function updateStageLabel(key: string, label: string) {
    if (!blueprint) return;
    setBlueprint({ ...blueprint, stages: blueprint.stages.map((s) => (s.key === key ? { ...s, label } : s)) });
  }

  function removeStage(key: string) {
    if (!blueprint) return;
    setBlueprint({
      ...blueprint,
      stages: blueprint.stages.filter((s) => s.key !== key).map((s, i) => ({ ...s, position: i })),
    });
  }

  function moveStage(key: string, dir: -1 | 1) {
    if (!blueprint) return;
    const ordered = [...blueprint.stages].sort((a, b) => a.position - b.position);
    const idx = ordered.findIndex((s) => s.key === key);
    const j = idx + dir;
    if (idx === -1 || j < 0 || j >= ordered.length) return;
    [ordered[idx], ordered[j]] = [ordered[j], ordered[idx]];
    setBlueprint({ ...blueprint, stages: ordered.map((s, i) => ({ ...s, position: i })) });
  }

  function addStage() {
    if (!blueprint) return;
    const key = `stage-${crypto.randomUUID().slice(0, 8)}`;
    setBlueprint({
      ...blueprint,
      stages: [...blueprint.stages, { key, label: "New stage", position: blueprint.stages.length, agentIds: [] }],
    });
  }

  async function handleSave() {
    if (!companyId || !blueprint) return;
    setSaving(true);
    try {
      const orderedStages = blueprint.stages
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((s, i) => ({ ...s, position: i }));
      const saved = await workflowApi.saveBlueprint(companyId, {
        name: blueprint.name,
        stages: orderedStages,
        returnEdges: blueprint.returnEdges,
      });
      setBlueprint(saved);
      setStored(saved);
      setEditing(false);
      // Recompute against the newly-saved spine.
      await queryClient.invalidateQueries({ queryKey: queryKeys.workflowAdherence(companyId) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (error) return <div className="p-6 text-sm text-destructive">{error}</div>;
  if (!blueprint) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const sortedStages = [...blueprint.stages].sort((a, b) => a.position - b.position);
  const activeAgentLabel = activeId ? (agentById.get(activeId)?.name ?? activeId) : null;
  const pct = adherence ? Math.round(adherence.adherenceRate * 100) : null;

  return (
    <div className="p-6">
      <header className="mb-2 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Ticket Lifecycle</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
            How the crew turns a raw Task into a delivered ticket — forward through every stage,
            never handed back. Compare it against what real tickets actually did.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className={`rounded-md border border-border px-3 py-1.5 text-sm ${overlay ? "bg-muted font-medium" : "hover:bg-muted"}`}
            onClick={() => setOverlay((v) => !v)}
          >
            {overlay ? "Hide comparison" : "Compare real tickets"}
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Done" : "Edit"}
          </button>
          {editing && (
            <>
              <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted" onClick={addStage}>
                + Stage
              </button>
              <button
                type="button"
                disabled={saving}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                onClick={handleSave}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      </header>

      {editing && (
        <p className="mb-4 text-xs text-muted-foreground">
          Drag agents between stages, rename or reorder stages, then Save to make this your crew's
          official Ticket Lifecycle.
        </p>
      )}

      {/* The spine */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="mt-4 flex items-start gap-1 overflow-x-auto pb-3">
          {sortedStages.map((stage, i) => (
            <div key={stage.key} className="flex items-start">
              {i > 0 && !editing && <Arrow className="mt-[52px]" />}
              {i > 0 && editing && <span className="w-2" />}
              <StageGroup
                stage={stage}
                agentById={agentById}
                editing={editing}
                onLabelChange={updateStageLabel}
                onRemove={removeStage}
                onMove={moveStage}
                canMoveLeft={i > 0}
                canMoveRight={i < sortedStages.length - 1}
              />
            </div>
          ))}
          {!editing && sortedStages.length > 0 && (
            <div className="mt-[52px] flex items-center">
              <Arrow />
              <span className="whitespace-nowrap rounded-md border border-emerald-600/40 bg-emerald-600/10 px-3 py-2 text-sm text-emerald-700">
                ✓ Done
              </span>
            </div>
          )}
        </div>

        {editing && (
          <aside className="mt-2 rounded-lg border border-dashed border-border p-3">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Off the perfect run {offPathAgents.length === 0 && "· none"}
            </div>
            {offPathAgents.length > 0 && (
              <p className="mb-2 text-xs text-muted-foreground">
                These agents don't belong on a clean delivery (escalation, incidents, test authoring).
                Drag one onto a stage to add it.
              </p>
            )}
            <SortableContext items={offPathAgents.map((a) => a.id)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-wrap gap-2">
                {offPathAgents.map((agent) => (
                  <AgentChip key={agent.id} agentId={agent.id} label={agent.name} stageKey="__off_path__" editing={editing} />
                ))}
              </div>
            </SortableContext>
          </aside>
        )}

        <DragOverlay>
          {activeAgentLabel ? (
            <div className="rounded-md border border-border bg-card px-3 py-2 text-sm shadow-lg">{activeAgentLabel}</div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Comparison against real tickets */}
      {overlay && adherence && (
        <section className="mt-8 border-t border-border pt-6">
          <div className="mb-4">
            <h2 className="text-base font-semibold">
              {adherence.cleanTicketCount} of {adherence.ticketCount} delivered tickets ran clean
              {pct !== null && <span className="text-muted-foreground"> ({pct}%)</span>}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              A clean run moves forward through every stage and never returns to an agent who already
              worked the ticket. The rest took detours — shown below.
            </p>
          </div>

          <div className="grid gap-8 md:grid-cols-2">
            <div>
              <h3 className="text-sm font-medium">Where work bounced back</h3>
              <p className="mb-3 text-xs text-muted-foreground">
                Hand-offs that went <span className="text-destructive">backward</span> to an agent
                earlier in the run. Every one is rework you want to design out.
              </p>
              {adherence.reworkLoops.length === 0 ? (
                <p className="text-sm text-muted-foreground">No backward hand-offs — work flowed forward. 🎉</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {adherence.reworkLoops.map((l) => {
                    const extra = l.ticketCount - l.exampleIssueIdentifiers.length;
                    return (
                      <li key={`${l.fromAgentId}->${l.toAgentId}`} className="border-b border-border/50 pb-2 last:border-0 last:pb-0">
                        <div className="flex items-baseline justify-between gap-3">
                          <span>
                            <span className="font-medium">{agentById.get(l.fromAgentId)?.name ?? l.fromAgentId}</span>
                            <span className="text-muted-foreground"> sent work back to </span>
                            <span className="font-medium">{agentById.get(l.toAgentId)?.name ?? l.toAgentId}</span>
                          </span>
                          <span className="shrink-0 tabular-nums">
                            <span className="text-destructive">{l.count}×</span>
                            <span className="text-muted-foreground">
                              {" "}
                              across {l.ticketCount} ticket{l.ticketCount === 1 ? "" : "s"}
                            </span>
                          </span>
                        </div>
                        {l.exampleIssueIdentifiers.length > 0 && (
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            e.g. {l.exampleIssueIdentifiers.join(", ")}
                            {extra > 0 && ` +${extra} more`}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div>
              <h3 className="text-sm font-medium">Tickets that strayed furthest</h3>
              <p className="mb-3 text-xs text-muted-foreground">
                Most hand-offs and most return trips. A clean run is ~{idealHandoffs} hand-offs and 0
                returns.
              </p>
              {adherence.worstTickets.length === 0 ? (
                <p className="text-sm text-muted-foreground">No troubled tickets in this window.</p>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {adherence.worstTickets.map((t) => (
                    <li key={t.issueId} className="flex items-baseline justify-between gap-3">
                      <span className="font-medium">{t.identifier}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {t.hopCount} hand-offs
                        {t.revisitCount > 0 && (
                          <span className="text-destructive"> · came back {t.revisitCount}×</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}

      {stored && companyId && (
        <LifecycleSettings
          companyId={companyId}
          stored={stored}
          agents={agents}
          onSaved={(saved) => {
            setStored(saved);
            // Keep the settings fields current on the spine view without touching its edits.
            setBlueprint((cur) =>
              cur && editing ? { ...cur, ...saved, stages: cur.stages, returnEdges: cur.returnEdges, name: cur.name } : saved,
            );
          }}
        />
      )}

      <SecurityPodSpine podAgents={securityPodAgents} />
    </div>
  );
}
