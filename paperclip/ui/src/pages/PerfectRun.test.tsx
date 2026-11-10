// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerfectRun } from "./PerfectRun";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockWorkflowApi = vi.hoisted(() => ({
  graph: vi.fn(),
  getBlueprint: vi.fn(),
  adherence: vi.fn(),
  previewAdherence: vi.fn(),
  saveBlueprint: vi.fn(),
  saveBlueprintSettings: vi.fn(),
}));

const mockRoutinesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));

const EMPTY_ADHERENCE = {
  adherenceRate: 1,
  cleanTicketCount: 1,
  ticketCount: 1,
  edges: [],
  reworkLoops: [],
  worstTickets: [],
  windowDays: 14,
  generatedAt: "",
};

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("../api/workflow", () => ({
  workflowApi: mockWorkflowApi,
}));

vi.mock("../api/routines", () => ({ routinesApi: mockRoutinesApi }));
vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    // Several rounds to drain the mount effect → setBlueprint → react-query
    // adherence fetch → setState chain.
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PerfectRun", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockWorkflowApi.graph.mockResolvedValue({
      nodes: [],
      edges: [],
      meta: { ticketCount: 0, windowDays: 14, generatedAt: "" },
    });
    mockWorkflowApi.getBlueprint.mockResolvedValue({
      companyId: "company-1",
      name: "The Perfect Run",
      updatedAt: null,
      returnEdges: [],
      stages: [{ key: "intake", label: "Intake", position: 0, agentIds: ["a1"] }],
    });
    mockWorkflowApi.adherence.mockResolvedValue(EMPTY_ADHERENCE);
    mockWorkflowApi.previewAdherence.mockResolvedValue(EMPTY_ADHERENCE);
    mockAgentsApi.list.mockResolvedValue([
      { id: "a1", name: "Intake agent", role: "pm", status: "idle" },
      { id: "a2", name: "Reviewer", role: "qa", status: "idle" },
    ]);
    mockRoutinesApi.list.mockResolvedValue([
      { id: "r1", title: "Retrospective" },
      { id: "r2", title: "Merge prep" },
    ]);
    mockAuthApi.getSession.mockResolvedValue({ session: { id: "s", userId: "board-1" }, user: { id: "board-1" } });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the stage label and its agent", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PerfectRun />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Intake");
    expect(container.textContent).toContain("Intake agent");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a Save button after clicking Edit", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PerfectRun />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    // No Save button yet
    const saveBeforeEdit = Array.from(container.querySelectorAll("button")).find(
      (b) => /save/i.test(b.textContent ?? ""),
    );
    expect(saveBeforeEdit).toBeUndefined();

    // Click Edit button
    const editBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => /edit/i.test(b.textContent ?? ""),
    );
    expect(editBtn).toBeDefined();
    await act(async () => {
      editBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Save button should appear
    const saveAfterEdit = Array.from(container.querySelectorAll("button")).find(
      (b) => /save/i.test(b.textContent ?? ""),
    );
    expect(saveAfterEdit).toBeDefined();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows rework loops and worst-offender tickets when the comparison is enabled", async () => {
    mockWorkflowApi.previewAdherence.mockResolvedValue({
      adherenceRate: 0.5,
      cleanTicketCount: 1,
      ticketCount: 2,
      windowDays: 14,
      generatedAt: "",
      edges: [
        { fromAgentId: "a1", toAgentId: "a1", count: 3, kind: "backward", medianDwellMs: 60000 },
      ],
      reworkLoops: [
        { fromAgentId: "a1", toAgentId: "a1", count: 3, ticketCount: 1, exampleIssueIdentifiers: ["ACME-124"] },
      ],
      worstTickets: [
        { issueId: "i1", identifier: "ACME-124", hopCount: 17, revisitCount: 4 },
      ],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PerfectRun />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    // Comparison toggle should exist but metrics not shown yet
    const overlayBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => /compare real tickets/i.test(b.textContent ?? ""),
    );
    expect(overlayBtn).toBeDefined();
    expect(container.textContent).not.toContain("ACME-124");

    // Click the overlay toggle
    await act(async () => {
      overlayBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // Metrics panel should now show the worst-offender ticket
    expect(container.textContent).toContain("ACME-124");

    await act(async () => {
      root.unmount();
    });
  });

  it("calls saveBlueprint with companyId, stages, and returnEdges when Save is clicked", async () => {
    mockWorkflowApi.saveBlueprint.mockResolvedValue({
      companyId: "company-1",
      name: "The Perfect Run",
      updatedAt: "now",
      returnEdges: [],
      stages: [{ key: "intake", label: "Intake", position: 0, agentIds: ["a1"] }],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PerfectRun />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    // Enter edit mode
    const editBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => /edit/i.test(b.textContent ?? ""),
    );
    await act(async () => {
      editBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Click Save
    const saveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => /save/i.test(b.textContent ?? ""),
    );
    expect(saveBtn).toBeDefined();
    await act(async () => {
      saveBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockWorkflowApi.saveBlueprint).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        stages: expect.any(Array),
        returnEdges: expect.any(Array),
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("seeds the approved multi-stage spine and excludes off-path agents when no blueprint is saved", async () => {
    mockWorkflowApi.getBlueprint.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([
      { id: "a1", name: "Intake agent", role: "pm", status: "idle", title: "Triage & Intake Lead" },
      { id: "a2", name: "Dispatch agent", role: "cto", status: "idle", title: "Chief Technology Officer" },
      { id: "a3", name: "Build agent", role: "engineer", status: "idle", title: "Developer" },
      { id: "a4", name: "Executive agent", role: "ceo", status: "idle", title: "Chief Executive Officer" },
    ]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PerfectRun />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    // The curated spine renders distinct stages…
    expect(container.textContent).toContain("Intake");
    expect(container.textContent).toContain("Plan");
    expect(container.textContent).toContain("Build");
    // …with the right agents on the spine…
    expect(container.textContent).toContain("Intake agent");
    expect(container.textContent).toContain("Dispatch agent");
    expect(container.textContent).toContain("Build agent");
    // …and the CEO excluded (off-path; not shown in read mode).
    expect(container.textContent).not.toContain("Executive agent");

    await act(async () => {
      root.unmount();
    });
  });

  it("adds a new stage when '+ Stage' is clicked in edit mode", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PerfectRun />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const editBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => /edit/i.test(b.textContent ?? ""),
    );
    await act(async () => {
      editBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const addBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => /\+\s*stage/i.test(b.textContent ?? ""),
    );
    expect(addBtn).toBeDefined();
    await act(async () => {
      addBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const hasNewStage = Array.from(container.querySelectorAll("input")).some(
      (i) => (i as HTMLInputElement).value === "New stage",
    );
    expect(hasNewStage).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders the 'Ticket Lifecycle' page title and the Intake stage description", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PerfectRun />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    // Page heading should read "Ticket Lifecycle" (renamed from "The Perfect Run").
    expect(container.textContent).toContain("Ticket Lifecycle");

    // Intake stage description conveys the raw-Task → clean-ticket framing.
    expect(container.textContent).toContain(
      "Raw Tasks arrive here and become clean, executable tickets.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("renders the security pod lifecycle section with all stage labels and pod agent names, and keeps the remediation agent out of the dev Verify Gauntlet", async () => {
    mockWorkflowApi.getBlueprint.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([
      // Dev spine agents
      { id: "a1", name: "Intake agent", role: "pm", status: "idle", title: "Triage & Intake Lead" },
      { id: "a2", name: "Dispatch agent", role: "cto", status: "idle", title: "Chief Technology Officer" },
      { id: "a3", name: "Build agent", role: "engineer", status: "idle", title: "Developer" },
      // Security pod agents
      {
        id: "s1",
        name: "Red team lead agent",
        role: "engineer",
        status: "idle",
        title: "Red Team Lead / Pentest Dispatcher",
      },
      {
        id: "s2",
        name: "Vulnerability researcher agent",
        role: "engineer",
        status: "idle",
        title: "Vulnerability Researcher",
      },
      {
        id: "s3",
        name: "Exploit prover agent",
        role: "engineer",
        status: "idle",
        title: "Exploit Prover",
      },
      {
        id: "s4",
        name: "Security remediation agent",
        role: "engineer",
        status: "idle",
        title: "Security Remediation Engineer",
      },
      {
        id: "s5",
        name: "Coverage cartographer agent",
        role: "engineer",
        status: "idle",
        title: "Attack-Surface Cartographer & Coverage Tracker",
      },
    ]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PerfectRun />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const text = container.textContent ?? "";

    // Security section heading
    expect(text).toContain("Vulnerability Lifecycle");

    // Stage labels — default report-only spine + gated remediation
    expect(text).toContain("Dispatch");
    expect(text).toContain("Hunt");
    expect(text).toContain("Prove");
    expect(text).toContain("Report");
    expect(text).toContain("Remediate");
    expect(text).toContain("Re-prove");

    // Report-only framing: deliverable is the report; remediation is gated on operator command.
    expect(text).toContain("Deliverable");
    expect(text).toContain("On operator command only");
    expect(text).toContain("never open a PR without an");

    // Pod agent names rendered in the security section
    expect(text).toContain("Red team lead agent");
    expect(text).toContain("Vulnerability researcher agent");
    expect(text).toContain("Exploit prover agent");
    expect(text).toContain("Security remediation agent");
    expect(text).toContain("Coverage cartographer agent");

    // The remediation agent must NOT appear inside the dev Verify Gauntlet stage group.
    // The Verify Gauntlet stage chip column is contained in a div with the
    // stage label "Verify Gauntlet". We verify by checking that neither the
    // security-pod agents appear among the dev spine stages (none of them
    // should be classified into a dev stage).
    const devSpineEl = container.querySelector('[class*="flex items-start gap-1"]');
    const devSpineText = devSpineEl?.textContent ?? "";
    // The remediation agent should not be inside the dev spine's rendered area
    expect(devSpineText).not.toContain("Security remediation agent");

    await act(async () => {
      root.unmount();
    });
  });

  describe("lifecycle settings", () => {
    const STORED_SPINE = {
      companyId: "company-1",
      name: "The Perfect Run",
      updatedAt: "t0",
      returnEdges: [],
      stages: [{ key: "intake", label: "Intake", position: 0, agentIds: ["a1"] }],
      mode: "standard",
      subtaskStages: null,
      featureStages: null,
      haltPhrases: null,
      intakeAgentId: null,
      gatedSubtaskKinds: ["impl", "tests"],
      retro: null,
      prepareForMergeRoutineId: null,
    };

    async function mount(overrides: Record<string, unknown> = {}) {
      mockWorkflowApi.getBlueprint.mockResolvedValue({ ...STORED_SPINE, ...overrides });
      mockWorkflowApi.saveBlueprintSettings.mockImplementation(async (_c: string, input: Record<string, unknown>) => ({
        ...STORED_SPINE,
        ...overrides,
        ...input,
      }));
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <PerfectRun />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      await flushReact();
      await click(buttonByText("Show settings"));
      return root;
    }

    const byLabel = <T extends HTMLElement>(label: string) =>
      container.querySelector(`[aria-label="${label}"]`) as T;
    const buttonByText = (text: string) =>
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

    async function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
      });
    }
    async function click(el: HTMLElement) {
      await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
    }
    const lastPut = () => mockWorkflowApi.saveBlueprintSettings.mock.calls.at(-1)![1];

    it("stages: saves subtask and feature chains with a terminal board-user approval, shows the 422 message", async () => {
      const root = await mount();
      await click(byLabel("Attach default chain to Subtask chain"));
      await click(buttonByText("+ Review stage"));
      await setValue(byLabel("Subtask chain stage 1 participant 1"), "a2");
      await click(byLabel("Attach default chain to Feature chain"));
      await click(container.querySelectorAll<HTMLButtonElement>("[data-testid='chain-Feature chain'] button")[1]);
      await setValue(byLabel("Feature chain stage 1 participant 1"), "a2");

      await click(buttonByText("Apply chains"));
      expect(lastPut()).toEqual({
        name: "The Perfect Run",
        stages: STORED_SPINE.stages,
        returnEdges: [],
        subtaskStages: [{ type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: "a2", userId: null }] }],
        featureStages: [
          { type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: "a2", userId: null }] },
          { type: "approval", approvalsNeeded: 1, participants: [{ type: "user", userId: "board-1", agentId: null }] },
        ],
      });
      expect(container.textContent).toContain("Board user");

      mockWorkflowApi.saveBlueprintSettings.mockRejectedValueOnce(new Error("A subtask execution policy cannot have a user participant"));
      await click(buttonByText("Apply chains"));
      expect(container.querySelector("[role=alert]")?.textContent).toBe(
        "A subtask execution policy cannot have a user participant",
      );
      await act(async () => root.unmount());
    });

    it("halt phrases: add and remove chips, PUT carries only the phrases", async () => {
      const root = await mount({ haltPhrases: ["stop", "halt"] });
      await click(byLabel("Remove halt"));
      await setValue(byLabel("Halt phrases input"), "hold everything");
      await click(byLabel("Add to Halt phrases"));
      await click(buttonByText("Apply halt phrases"));
      expect(lastPut()).toEqual({
        name: "The Perfect Run",
        stages: STORED_SPINE.stages,
        returnEdges: [],
        haltPhrases: ["stop", "hold everything"],
      });
      mockWorkflowApi.saveBlueprintSettings.mockRejectedValueOnce(new Error("Invalid workflow blueprint settings"));
      await click(buttonByText("Apply halt phrases"));
      expect(container.querySelector("[role=alert]")?.textContent).toBe("Invalid workflow blueprint settings");
      await act(async () => root.unmount());
    });

    it("intake and kinds: PUT carries intakeAgentId and gatedSubtaskKinds, shows the 422 message", async () => {
      const root = await mount();
      await setValue(byLabel("Intake agent"), "a1");
      await click(byLabel("Remove tests"));
      await setValue(byLabel("Gated subtask kinds input"), "docs");
      await click(byLabel("Add to Gated subtask kinds"));
      mockWorkflowApi.saveBlueprintSettings.mockRejectedValueOnce(new Error("Agent is not in this company"));
      await click(buttonByText("Apply intake settings"));
      expect(container.querySelector("[role=alert]")?.textContent).toBe("Agent is not in this company");
      await click(buttonByText("Apply intake settings"));
      expect(lastPut()).toEqual({
        name: "The Perfect Run",
        stages: STORED_SPINE.stages,
        returnEdges: [],
        intakeAgentId: "a1",
        gatedSubtaskKinds: ["impl", "docs"],
      });
      await act(async () => root.unmount());
    });

    it("retro: routine picker lists routines, toggle/threshold/cooldown reach the PUT, 422 shown", async () => {
      const root = await mount();
      const options = Array.from(byLabel<HTMLSelectElement>("Retro routine").options).map((o) => o.textContent);
      expect(options).toEqual(["None", "Retrospective", "Merge prep"]);
      await setValue(byLabel("Retro routine"), "r1");
      await click(byLabel("Retro auto-trigger"));
      await setValue(byLabel("Retro bounce threshold"), "3");
      await setValue(byLabel("Retro cooldown hours"), "12");
      await click(buttonByText("Apply retro settings"));
      expect(lastPut()).toEqual({
        name: "The Perfect Run",
        stages: STORED_SPINE.stages,
        returnEdges: [],
        retro: { routineId: "r1", autoTrigger: true, bounceThreshold: 3, cooldownHours: 12 },
      });
      mockWorkflowApi.saveBlueprintSettings.mockRejectedValueOnce(new Error("Routine is not in this company"));
      await click(buttonByText("Apply retro settings"));
      expect(container.querySelector("[role=alert]")?.textContent).toBe("Routine is not in this company");
      await act(async () => root.unmount());
    });

    it("prepare for merge: PUT carries only the routine id, 422 shown", async () => {
      const root = await mount();
      await setValue(byLabel("Prepare-for-merge routine"), "r2");
      await click(buttonByText("Apply merge routine"));
      expect(lastPut()).toEqual({
        name: "The Perfect Run",
        stages: STORED_SPINE.stages,
        returnEdges: [],
        prepareForMergeRoutineId: "r2",
      });
      mockWorkflowApi.saveBlueprintSettings.mockRejectedValueOnce(new Error("Routine is not in this company"));
      await click(buttonByText("Apply merge routine"));
      expect(container.querySelector("[role=alert]")?.textContent).toBe("Routine is not in this company");
      await act(async () => root.unmount());
    });

    it("refetches the stored spine right before a settings PUT and echoes it", async () => {
      const root = await mount();
      const newer = {
        ...STORED_SPINE,
        updatedAt: "t1",
        returnEdges: [{ fromAgentId: "a1", toAgentId: "a2", label: "x" }],
        stages: [{ key: "build", label: "Build", position: 0, agentIds: ["a2"] }],
      };
      mockWorkflowApi.getBlueprint.mockResolvedValue(newer);
      await setValue(byLabel("Prepare-for-merge routine"), "r2");
      await click(buttonByText("Apply merge routine"));
      expect(lastPut()).toEqual({
        name: "The Perfect Run",
        stages: newer.stages,
        returnEdges: newer.returnEdges,
        prepareForMergeRoutineId: "r2",
      });
      await act(async () => root.unmount());
    });

    it("preserves stored stage fields and blocks Apply for chains it cannot represent", async () => {
      const agentStage = (n: number) => ({
        id: "s-1",
        type: "review",
        approvalsNeeded: n,
        participants: [{ id: "p-1", type: "agent", agentId: "a2", userId: null }],
      });
      const approval = {
        id: "s-2",
        type: "approval",
        approvalsNeeded: 1,
        participants: [{ id: "p-2", type: "user", userId: "board-9", agentId: null }],
      };
      // Representable chain: ids and the stored approval stage survive an unrelated edit.
      let root = await mount({ featureStages: [agentStage(1), approval] });
      await setValue(byLabel("Feature chain stage 1 participant 1"), "a1");
      await click(buttonByText("Apply chains"));
      expect(lastPut().featureStages).toEqual([
        { ...agentStage(1), participants: [{ id: "p-1", type: "agent", agentId: "a1", userId: null }] },
        approval,
      ]);
      await act(async () => root.unmount());
      container.innerHTML = "";

      // approvalsNeeded: 2 cannot be represented: warning shown, Apply disabled, nothing sent.
      mockWorkflowApi.saveBlueprintSettings.mockClear();
      root = await mount({ subtaskStages: [agentStage(2)] });
      expect(container.querySelector("[role=note]")?.textContent).toContain("cannot represent");
      expect(buttonByText("Apply chains").disabled).toBe(true);
      await click(buttonByText("Apply chains"));
      expect(mockWorkflowApi.saveBlueprintSettings).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    });
  });
});
