import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_WORKFLOW_HALT_PHRASES,
  DEFAULT_WORKFLOW_RETRO,
  type WorkflowStageTemplate,
} from "@paperclipai/shared";
import { workflowApi } from "../api/workflow";
import type { SaveBlueprintSettingsInput, WorkflowBlueprint } from "../api/workflow";
import { routinesApi } from "../api/routines";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "./ui/toggle-switch";

interface AgentOption {
  id: string;
  name: string;
}

interface Props {
  companyId: string;
  /** Last stored blueprint; its spine is echoed back so a settings save never edits the spine. */
  stored: WorkflowBlueprint;
  agents: AgentOption[];
  onSaved: (saved: WorkflowBlueprint) => void;
}

type GroupKey = "stages" | "halt" | "intake" | "retro" | "merge";

const selectClass = "rounded-md border border-border bg-background px-2 py-1 text-sm";
const inputClass = "rounded-md border border-border bg-background px-2 py-1 text-sm";
const buttonClass = "rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted";

type Stage = WorkflowStageTemplate;

const isAgentReview = (st: Stage) =>
  st.type === "review" &&
  (st.approvalsNeeded ?? 1) === 1 &&
  st.participants.every((p) => p.type === "agent");

const isUserApproval = (st: Stage) =>
  st.type === "approval" &&
  (st.approvalsNeeded ?? 1) === 1 &&
  st.participants.length > 0 &&
  st.participants.every((p) => p.type === "user");

/** Editable review stages of a stored chain, or null when the editor cannot represent it faithfully. */
function editableRows(chain: Stage[] | null, terminalApproval: boolean): Stage[] | null {
  if (!chain) return [];
  if (!terminalApproval) return chain.every(isAgentReview) ? chain : null;
  if (chain.length === 0) return [];
  const last = chain[chain.length - 1];
  const head = chain.slice(0, -1);
  return isUserApproval(last) && head.every(isAgentReview) ? head : null;
}

function newReviewStage(): Stage {
  return { type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: "", userId: null }] };
}

const withoutBlankParticipants = (st: Stage): Stage => ({
  ...st,
  participants: st.participants.filter((p) => p.type !== "agent" || p.agentId),
});

function ChipList({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  function add() {
    const v = text.trim();
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
    setText("");
  }
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs">
            {v}
            <button type="button" aria-label={`Remove ${v}`} className="text-muted-foreground hover:text-foreground" onClick={() => onChange(values.filter((x) => x !== v))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className={inputClass}
          aria-label={`${label} input`}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className={buttonClass} aria-label={`Add to ${label}`} onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

function ChainEditor({
  title,
  enabled,
  onEnabled,
  rows,
  onRows,
  agents,
  terminalApproval,
  unsupported,
}: {
  title: string;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  rows: Stage[];
  onRows: (rows: Stage[]) => void;
  agents: AgentOption[];
  terminalApproval: boolean;
  unsupported: boolean;
}) {
  const setParticipant = (r: number, p: number, id: string) =>
    onRows(
      rows.map((st, i) =>
        i === r
          ? { ...st, participants: st.participants.map((x, j) => (j === p ? { ...x, agentId: id } : x)) }
          : st,
      ),
    );
  return (
    <div className="rounded-lg border border-border p-3" data-testid={`chain-${title}`}>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-medium">{title}</h4>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Attach a default chain
          <ToggleSwitch checked={enabled} onCheckedChange={onEnabled} aria-label={`Attach default chain to ${title}`} />
        </label>
      </div>
      {enabled && unsupported && (
        <p role="note" className="text-xs text-amber-700">
          This stored chain has stages the editor cannot represent faithfully (other stage types, more than one
          approval needed, or non-agent reviewers). It is shown read-only and Apply is disabled so it is not rewritten.
        </p>
      )}
      {enabled && !unsupported && (
        <ol className="space-y-2">
          {rows.map((row, r) => (
            <li key={r} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-24 text-xs text-muted-foreground">Review {r + 1}</span>
              {row.participants.map((part, p) => (
                <select
                  key={p}
                  className={selectClass}
                  aria-label={`${title} stage ${r + 1} participant ${p + 1}`}
                  value={part.agentId ?? ""}
                  onChange={(e) => setParticipant(r, p, e.target.value)}
                >
                  <option value="">Select agent…</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              ))}
              <button type="button" className={buttonClass} onClick={() =>
                  onRows(
                    rows.map((x, i) =>
                      i === r ? { ...x, participants: [...x.participants, { type: "agent", agentId: "", userId: null }] } : x,
                    ),
                  )
                }>
                + Participant
              </button>
              <button type="button" className={buttonClass} aria-label={`Remove ${title} stage ${r + 1}`} onClick={() => onRows(rows.filter((_, i) => i !== r))}>
                Remove stage
              </button>
            </li>
          ))}
          {terminalApproval && (
            <li className="flex items-center gap-2 text-sm">
              <span className="w-24 text-xs text-muted-foreground">Approval</span>
              <span className="rounded-md border border-dashed border-border px-2 py-1">Board user</span>
            </li>
          )}
        </ol>
      )}
      {enabled && !unsupported && (
        <button type="button" className={`${buttonClass} mt-2`} onClick={() => onRows([...rows, newReviewStage()])}>
          + Review stage
        </button>
      )}
    </div>
  );
}

export function LifecycleSettings({ companyId, stored, agents, onSaved }: Props) {
  const { data: routines = [] } = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const [subtaskOn, setSubtaskOn] = useState(stored.subtaskStages !== null);
  const subtaskInit = editableRows(stored.subtaskStages, false);
  const featureInit = editableRows(stored.featureStages, true);
  const subtaskUnsupported = subtaskInit === null;
  const featureUnsupported = featureInit === null;
  const [subtaskRows, setSubtaskRows] = useState<Stage[]>(subtaskInit ?? []);
  const [featureOn, setFeatureOn] = useState(stored.featureStages !== null);
  const [featureRows, setFeatureRows] = useState<Stage[]>(featureInit ?? []);
  const [halt, setHalt] = useState<string[] | null>(stored.haltPhrases);
  const [intake, setIntake] = useState<string>(stored.intakeAgentId ?? "");
  const [kinds, setKinds] = useState<string[]>(stored.gatedSubtaskKinds);
  const [retro, setRetro] = useState(() => ({ ...DEFAULT_WORKFLOW_RETRO, ...(stored.retro ?? {}) }));
  const [mergeRoutine, setMergeRoutine] = useState<string>(stored.prepareForMergeRoutineId ?? "");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<GroupKey | null>(null);
  const [errors, setErrors] = useState<Partial<Record<GroupKey, string>>>({});
  const [notice, setNotice] = useState<GroupKey | null>(null);

  function boardUserId(): string | null {
    return session?.user.id ?? session?.session.userId ?? null;
  }

  async function saveGroup(group: GroupKey, settings: Partial<SaveBlueprintSettingsInput>) {
    setSaving(group);
    setNotice(null);
    setErrors((e) => ({ ...e, [group]: undefined }));
    try {
      // Echo the spine as it is stored right now, not as loaded: another tab may have saved it.
      const fresh = (await workflowApi.getBlueprint(companyId)) ?? stored;
      const saved = await workflowApi.saveBlueprintSettings(companyId, {
        name: fresh.name,
        stages: fresh.stages,
        returnEdges: fresh.returnEdges,
        ...settings,
      });
      onSaved(saved);
      setNotice(group);
    } catch (e) {
      setErrors((prev) => ({ ...prev, [group]: e instanceof Error ? e.message : "Failed to save" }));
    } finally {
      setSaving(null);
    }
  }

  function saveStages() {
    const storedApproval = stored.featureStages?.at(-1);
    const approval: Stage =
      storedApproval && isUserApproval(storedApproval)
        ? storedApproval
        : {
            type: "approval",
            approvalsNeeded: 1,
            participants: [{ type: "user", userId: boardUserId(), agentId: null }],
          };
    void saveGroup("stages", {
      subtaskStages: subtaskOn ? subtaskRows.map(withoutBlankParticipants) : null,
      featureStages: featureOn ? [...featureRows.map(withoutBlankParticipants), approval] : null,
    });
  }

  function groupFooter(group: GroupKey, label: string, onClick: () => void, blocked = false) {
    return (
      <div className="mt-3 flex items-center gap-3">
        <button type="button" disabled={saving !== null || blocked} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50" onClick={onClick}>
          {saving === group ? "Working…" : label}
        </button>
        {notice === group && <span className="text-xs text-emerald-700">Stored.</span>}
        {errors[group] && <span role="alert" className="text-xs text-destructive">{errors[group]}</span>}
      </div>
    );
  }

  const section = "rounded-lg border border-border p-4";

  return (
    <section className="mt-8 space-y-4 border-t border-border pt-6" aria-label="Lifecycle settings">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Lifecycle settings</h2>
        <button type="button" className={buttonClass} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide settings" : "Show settings"}
        </button>
      </div>
      {open && (
      <>

      <div className={section}>
        <h3 className="mb-1 text-sm font-medium">Default review chains</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Attached to new tickets that carry no chain of their own. Subtask chains hold agent review stages only;
          feature chains end in one approval by the board user.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <ChainEditor title="Subtask chain" enabled={subtaskOn} onEnabled={setSubtaskOn} rows={subtaskRows} onRows={setSubtaskRows} agents={agents} terminalApproval={false} unsupported={subtaskUnsupported} />
          <ChainEditor title="Feature chain" enabled={featureOn} onEnabled={setFeatureOn} rows={featureRows} onRows={setFeatureRows} agents={agents} terminalApproval unsupported={featureUnsupported} />
        </div>
        {groupFooter("stages", "Apply chains", saveStages, (subtaskOn && subtaskUnsupported) || (featureOn && featureUnsupported))}
      </div>

      <div className={section}>
        <h3 className="mb-1 text-sm font-medium">Halt phrases</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          A comment containing one of these stops agent work on the ticket.
          {halt === null && " Using the built-in list."}
        </p>
        <ChipList label="Halt phrases" values={halt ?? [...DEFAULT_WORKFLOW_HALT_PHRASES]} onChange={setHalt} placeholder="Add a phrase" />
        {groupFooter("halt", "Apply halt phrases", () => void saveGroup("halt", { haltPhrases: halt }))}
      </div>

      <div className={section}>
        <h3 className="mb-1 text-sm font-medium">Intake and gated subtasks</h3>
        <label className="mb-3 flex items-center gap-2 text-sm">
          Intake agent
          <select className={selectClass} aria-label="Intake agent" value={intake} onChange={(e) => setIntake(e.target.value)}>
            <option value="">None</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
        <ChipList label="Gated subtask kinds" values={kinds} onChange={setKinds} placeholder="Add a kind" />
        {groupFooter("intake", "Apply intake settings", () =>
          void saveGroup("intake", { intakeAgentId: intake || null, gatedSubtaskKinds: kinds }),
        )}
      </div>

      <div className={section}>
        <h3 className="mb-2 text-sm font-medium">Retrospective trigger</h3>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            Routine
            <select className={selectClass} aria-label="Retro routine" value={retro.routineId ?? ""} onChange={(e) => setRetro({ ...retro, routineId: e.target.value || null })}>
              <option value="">None</option>
              {routines.map((r) => (
                <option key={r.id} value={r.id}>{r.title}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            Auto-trigger
            <ToggleSwitch checked={retro.autoTrigger} onCheckedChange={(v) => setRetro({ ...retro, autoTrigger: v })} aria-label="Retro auto-trigger" />
          </label>
          <label className="flex items-center gap-2">
            Bounce threshold
            <input type="number" min={1} max={100} className={`${inputClass} w-20`} aria-label="Retro bounce threshold" value={retro.bounceThreshold} onChange={(e) => setRetro({ ...retro, bounceThreshold: Number(e.target.value) })} />
          </label>
          <label className="flex items-center gap-2">
            Cooldown (hours)
            <input type="number" min={0} className={`${inputClass} w-20`} aria-label="Retro cooldown hours" value={retro.cooldownHours} onChange={(e) => setRetro({ ...retro, cooldownHours: Number(e.target.value) })} />
          </label>
        </div>
        {groupFooter("retro", "Apply retro settings", () => void saveGroup("retro", { retro }))}
      </div>

      <div className={section}>
        <h3 className="mb-2 text-sm font-medium">Prepare for merge</h3>
        <label className="flex items-center gap-2 text-sm">
          Routine
          <select className={selectClass} aria-label="Prepare-for-merge routine" value={mergeRoutine} onChange={(e) => setMergeRoutine(e.target.value)}>
            <option value="">None</option>
            {routines.map((r) => (
              <option key={r.id} value={r.id}>{r.title}</option>
            ))}
          </select>
        </label>
        {groupFooter("merge", "Apply merge routine", () => void saveGroup("merge", { prepareForMergeRoutineId: mergeRoutine || null }))}
      </div>
      </>
      )}
    </section>
  );
}
