// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RoutineListItem } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listMock, runMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  runMock: vi.fn(),
}));

vi.mock("../api/routines", () => ({
  routinesApi: {
    list: listMock,
    run: runMock,
  },
}));

import { IssueRoutineActions, issueRoutineActionLabel } from "./IssueRoutineActions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function settleEffects() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushUi(callback: () => void) {
  flushSync(callback);
  await settleEffects();
}

function makeRoutine(overrides: Partial<RoutineListItem> = {}): RoutineListItem {
  return {
    id: "routine-1",
    title: "Write repro steps — {{issueIdentifier}}",
    status: "active",
    variables: [
      {
        name: "issueIdentifier",
        label: "Feature ticket",
        type: "text",
        required: true,
        options: [],
        defaultValue: null,
      },
    ],
    triggers: [],
    lastRun: null,
    activeIssue: null,
    ...overrides,
  } as unknown as RoutineListItem;
}

describe("IssueRoutineActions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    runMock.mockResolvedValue({ id: "run-1", status: "issue_created" });
  });

  afterEach(async () => {
    await flushUi(() => root.unmount());
    container.remove();
    queryClient.clear();
    vi.clearAllMocks();
  });

  async function render(issueIdentifier = "ACME-226") {
    await flushUi(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueRoutineActions companyId="company-1" issueIdentifier={issueIdentifier} />
        </QueryClientProvider>,
      );
    });
    await settleEffects();
  }

  it("renders a button per active routine that declares the issue-context variable", async () => {
    listMock.mockResolvedValue([makeRoutine()]);

    await render();

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("Write repro steps");
    expect(button!.textContent).not.toContain("{{");
  });

  it("renders nothing when no active routine declares the variable", async () => {
    listMock.mockResolvedValue([
      makeRoutine({ id: "routine-2", variables: [] } as Partial<RoutineListItem>),
      makeRoutine({ id: "routine-3", status: "paused" } as Partial<RoutineListItem>),
    ]);

    await render();

    expect(container.querySelector("button")).toBeNull();
  });

  it("fires the routine with the current issue identifier prefilled", async () => {
    listMock.mockResolvedValue([makeRoutine()]);

    await render("ACME-226");
    const button = container.querySelector("button")!;
    await flushUi(() => button.click());
    await settleEffects();

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith("routine-1", {
      variables: { issueIdentifier: "ACME-226" },
    });
    expect(container.textContent).toContain("Queued");
  });

  it("surfaces a failed run and allows retry", async () => {
    listMock.mockResolvedValue([makeRoutine()]);
    runMock.mockRejectedValueOnce(new Error("boom"));

    await render();
    const button = container.querySelector("button")!;
    await flushUi(() => button.click());
    await settleEffects();

    expect(container.textContent).toContain("Failed — retry");
    expect(container.querySelector("button")!.hasAttribute("disabled")).toBe(false);
  });

  it("strips the variable placeholder from the action label", () => {
    expect(issueRoutineActionLabel("Write repro steps — {{issueIdentifier}}")).toBe(
      "Write repro steps",
    );
    expect(issueRoutineActionLabel("Plain title")).toBe("Plain title");
  });

  // --- routines that declare variables beyond issueIdentifier ---

  function makeRetroRoutine(overrides: Partial<RoutineListItem> = {}): RoutineListItem {
    return makeRoutine({
      id: "routine-retro",
      title: "Crew retrospective — {{issueIdentifier}}",
      variables: [
        {
          name: "issueIdentifier",
          label: "Ticket",
          type: "text",
          required: true,
          options: [],
          defaultValue: null,
        },
        {
          name: "satisfactionScore",
          label: "Satisfaction score",
          type: "select",
          required: true,
          options: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
          defaultValue: null,
        },
        {
          name: "operatorFeedback",
          label: "Operator feedback",
          type: "textarea",
          required: false,
          options: [],
          defaultValue: null,
        },
      ],
      ...overrides,
    } as Partial<RoutineListItem>);
  }

  function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function findDialogSubmitButton() {
    return Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Run routine",
    ) as HTMLButtonElement | undefined;
  }

  it("opens a variables dialog instead of firing when the routine declares extra variables", async () => {
    listMock.mockResolvedValue([makeRetroRoutine()]);

    await render("ACME-290");
    const button = container.querySelector("button")!;
    await flushUi(() => button.click());
    await settleEffects();

    expect(runMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Satisfaction score");
    expect(document.body.textContent).toContain("Operator feedback");
    expect(document.body.textContent).toContain("ACME-290");
  });

  it("submits dialog values merged with the prefilled issue identifier", async () => {
    const routine = makeRetroRoutine();
    // Give the required select a default so the submit gate is satisfied without
    // driving Radix Select (not drivable in jsdom); default plumbing is the point.
    (routine.variables ?? []).find((variable) => variable.name === "satisfactionScore")!.defaultValue =
      "7";
    listMock.mockResolvedValue([routine]);

    await render("ACME-290");
    const button = container.querySelector("button")!;
    await flushUi(() => button.click());
    await settleEffects();

    const feedback = document.body.querySelector("textarea");
    expect(feedback).not.toBeNull();
    await flushUi(() => setTextareaValue(feedback as HTMLTextAreaElement, "Great turnaround"));

    const submit = findDialogSubmitButton();
    expect(submit).toBeTruthy();
    expect(submit!.hasAttribute("disabled")).toBe(false);
    await flushUi(() => submit!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settleEffects();

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith("routine-retro", {
      variables: {
        issueIdentifier: "ACME-290",
        satisfactionScore: "7",
        operatorFeedback: "Great turnaround",
      },
    });
  });

  it("disables submit while a required extra variable is missing", async () => {
    listMock.mockResolvedValue([makeRetroRoutine()]);

    await render("ACME-290");
    const button = container.querySelector("button")!;
    await flushUi(() => button.click());
    await settleEffects();

    const submit = findDialogSubmitButton();
    expect(submit).toBeTruthy();
    expect(submit!.hasAttribute("disabled")).toBe(true);
    expect(runMock).not.toHaveBeenCalled();
  });
});
