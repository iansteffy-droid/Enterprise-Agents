// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetroPoint } from "@paperclipai/shared";
import { Retrospectives } from "./Retrospectives";

const companyState = vi.hoisted(() => ({ selectedCompanyId: "company-1" }));
const breadcrumbState = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));
const retroPointsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  setStatus: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));
vi.mock("../api/retro-points", () => ({
  retroPointsApi: retroPointsApiMock,
}));

// Render shadcn Select as a native <select> so option changes are deterministic
// in jsdom (the radix portal + pointer capture is unreliable under jsdom). The
// marker components below are identified by reference identity while walking the
// child tree — no invalid DOM attributes are emitted.
vi.mock("@/components/ui/select", () => {
  const SELECT_ITEM = Symbol("SelectItem");
  const SELECT_TRIGGER = Symbol("SelectTrigger");
  // Marker stubs: never rendered directly — the parent Select reads their props
  // by reference identity while walking the child tree.
  const SelectItem = (_props: { value: string; children: React.ReactNode }) => null;
  (SelectItem as unknown as { marker: symbol }).marker = SELECT_ITEM;
  const SelectTrigger = (_props: { children: React.ReactNode; "data-test"?: string }) => null;
  (SelectTrigger as unknown as { marker: symbol }).marker = SELECT_TRIGGER;

  const Select = ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => {
    const items: Array<{ value: string; label: string }> = [];
    let dataTest: string | undefined;
    const walk = (n: any) => {
      if (!n) return;
      if (Array.isArray(n)) return n.forEach(walk);
      const marker = (n.type as { marker?: symbol } | undefined)?.marker;
      if (marker === SELECT_ITEM) {
        const label = typeof n.props.children === "string" ? n.props.children : n.props.value;
        items.push({ value: n.props.value, label });
        return;
      }
      if (marker === SELECT_TRIGGER) {
        dataTest = n.props["data-test"];
      }
      if (n.props?.children) walk(n.props.children);
    };
    walk(children);
    return (
      <select
        data-test={dataTest}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    );
  };

  return {
    Select,
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem,
  };
});

function makePoint(overrides: Partial<RetroPoint> = {}): RetroPoint {
  return {
    pointKey: "retro-1_1",
    retroIssueId: "retro-1",
    retroIdentifier: "ALP-900",
    retroCreatedAt: "2026-01-01T00:00:00.000Z",
    reviewedIssueId: "reviewed-1",
    reviewedIdentifier: "ALP-100",
    reviewedTitle: "Login rework",
    number: 1,
    change: "Add a name and colour validator",
    targetFile: "server/src/services/labels.ts",
    scope: "universal",
    impact: 8,
    effort: 3,
    priority: 6.5,
    status: "open",
    proposalRef: null,
    note: null,
    updatedAt: null,
    why: {
      score: 7,
      operatorFeedback: "Good instinct.",
      rootCauses: "Validator only checked name.",
      downvoteReasons: ["Missed the real cause"],
    },
    ...overrides,
  };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function render(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/retrospectives"]}>
          <Retrospectives />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

describe("Retrospectives page", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    breadcrumbState.setBreadcrumbs.mockReset();
    retroPointsApiMock.list.mockReset();
    retroPointsApiMock.setStatus.mockReset();
    retroPointsApiMock.setStatus.mockResolvedValue({});
    window.localStorage.clear();
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("renders a ranked point with its reviewed-ticket link and scores", async () => {
    retroPointsApiMock.list.mockResolvedValue([makePoint()]);
    const rendered = render(container);
    root = rendered.root;

    await waitFor(() => {
      const link = container.querySelector('a[href="/issues/ALP-100"]');
      expect(link?.textContent).toContain("ALP-100");
      expect(container.textContent).toContain("Add a name and colour validator");
      expect(container.querySelector('a[href="/issues/ALP-900"]')?.textContent).toContain("ALP-900");
    });
  });

  it("expands the Why panel to reveal score, feedback, root causes and downvotes", async () => {
    retroPointsApiMock.list.mockResolvedValue([makePoint()]);
    const rendered = render(container);
    root = rendered.root;

    await waitFor(() => {
      expect(container.querySelector('[data-test="retro-why-toggle-retro-1_1"]')).toBeTruthy();
    });
    const toggle = container.querySelector('[data-test="retro-why-toggle-retro-1_1"]') as HTMLButtonElement;
    flushSync(() => toggle.click());

    await waitFor(() => {
      expect(container.textContent).toContain("Operator score:");
      expect(container.textContent).toContain("Good instinct.");
      expect(container.textContent).toContain("Validator only checked name.");
      expect(container.textContent).toContain("Missed the real cause");
    });
  });

  it("PATCHes the new status when the inline dropdown changes", async () => {
    retroPointsApiMock.list.mockResolvedValue([makePoint()]);
    const rendered = render(container);
    root = rendered.root;

    await waitFor(() => {
      expect(container.querySelector('[data-test="retro-status-retro-1_1"]')).toBeTruthy();
    });
    const select = container.querySelector('[data-test="retro-status-retro-1_1"]') as HTMLSelectElement;

    flushSync(() => {
      select.value = "merged";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => {
      expect(retroPointsApiMock.setStatus).toHaveBeenCalledWith("company-1", "retro-1_1", {
        status: "merged",
      });
    });
  });

  it("shows a status chip per point, open by default", async () => {
    retroPointsApiMock.list.mockResolvedValue([
      makePoint(),
      makePoint({ pointKey: "retro-1_2", number: 2, status: "merged" }),
      makePoint({ pointKey: "retro-1_3", number: 3, status: "rejected" }),
    ]);
    const rendered = render(container);
    root = rendered.root;

    await waitFor(() => {
      expect(container.querySelector('[data-test="retro-status-chip-retro-1_1"]')?.textContent).toBe("Open");
      expect(container.querySelector('[data-test="retro-status-chip-retro-1_2"]')?.textContent).toBe("Merged");
      expect(container.querySelector('[data-test="retro-status-chip-retro-1_3"]')?.textContent).toBe("Rejected");
    });
  });

  it("links a PR URL proposal reference and shows a branch reference as text", async () => {
    const prUrl = "https://github.com/example/kit/pull/12";
    retroPointsApiMock.list.mockResolvedValue([
      makePoint({ proposalRef: prUrl }),
      makePoint({ pointKey: "retro-1_2", number: 2, proposalRef: "branch:retro/ALP-100" }),
      makePoint({ pointKey: "retro-1_3", number: 3, proposalRef: null }),
    ]);
    const rendered = render(container);
    root = rendered.root;

    await waitFor(() => {
      const prRef = container.querySelector('[data-test="retro-ref-retro-1_1"]');
      expect(prRef?.tagName).toBe("A");
      expect(prRef?.getAttribute("href")).toBe(prUrl);
      expect(prRef?.getAttribute("target")).toBe("_blank");

      const branchRef = container.querySelector('[data-test="retro-ref-retro-1_2"]');
      expect(branchRef?.tagName).not.toBe("A");
      expect(branchRef?.textContent).toContain("branch:retro/ALP-100");
      expect(branchRef?.querySelector("a")).toBeNull();

      expect(container.querySelector('[data-test="retro-ref-retro-1_3"]')?.textContent).toContain(
        "No proposal yet",
      );
    });
  });

  it("does not render a non-http reference as a link", async () => {
    retroPointsApiMock.list.mockResolvedValue([makePoint({ proposalRef: "javascript:alert(1)" })]);
    const rendered = render(container);
    root = rendered.root;

    await waitFor(() => {
      const ref = container.querySelector('[data-test="retro-ref-retro-1_1"]');
      expect(ref).toBeTruthy();
      expect(ref?.tagName).not.toBe("A");
      expect(ref?.querySelector("a")).toBeNull();
    });
  });

  it("groups points by retro issue, newest retro first", async () => {
    retroPointsApiMock.list.mockResolvedValue([
      makePoint(),
      makePoint({ pointKey: "retro-1_2", number: 2, change: "Second change from retro one" }),
      makePoint({
        pointKey: "retro-2_1",
        retroIssueId: "retro-2",
        retroIdentifier: "ALP-901",
        retroCreatedAt: "2026-02-01T00:00:00.000Z",
        reviewedIssueId: "reviewed-2",
        reviewedIdentifier: "ALP-101",
        reviewedTitle: "Export",
        change: "Change from retro two",
      }),
    ]);
    const rendered = render(container);
    root = rendered.root;

    await waitFor(() => {
      const groups = [...container.querySelectorAll('[data-test^="retro-group-"]')];
      expect(groups.map((g) => g.getAttribute("data-test"))).toEqual(["retro-group-retro-2", "retro-group-retro-1"]);
      expect(groups[0]?.textContent).toContain("Change from retro two");
      expect(groups[0]?.textContent).not.toContain("Second change from retro one");
      expect(groups[1]?.textContent).toContain("Add a name and colour validator");
      expect(groups[1]?.textContent).toContain("Second change from retro one");
      expect(groups[1]?.querySelector('a[href="/issues/ALP-100"]')).toBeTruthy();
      expect(groups[1]?.querySelector('a[href="/issues/ALP-900"]')).toBeTruthy();
    });
  });

  it("links the group header to the retro issue id when the retro has no identifier", async () => {
    retroPointsApiMock.list.mockResolvedValue([makePoint({ retroIdentifier: null })]);
    const rendered = render(container);
    root = rendered.root;

    await waitFor(() => {
      const group = container.querySelector('[data-test="retro-group-retro-1"]');
      const link = group?.querySelector('a[href="/issues/retro-1"]');
      expect(link).toBeTruthy();
      expect(link?.textContent).toContain("Retro");
    });
  });

  it("shows the empty state when there are no points", async () => {
    retroPointsApiMock.list.mockResolvedValue([]);
    const rendered = render(container);
    root = rendered.root;

    await waitFor(() => {
      expect(container.textContent).toContain("No retrospective points yet");
    });
  });
});
