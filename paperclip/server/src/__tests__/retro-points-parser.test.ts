import { describe, expect, it } from "vitest";
import {
  extractSection,
  parseReviewedIdentifierFromDescription,
  parseReviewedIdentifierFromTitle,
  parseRetroComment,
} from "../services/retro-points-parser.ts";

// Fixture 0 is the retro facilitator's documented comment shape
// (agents/guinan/AGENTS.md, "The comment"): a Part 2 efficiency table precedes
// the Part 4 proposals table, whose columns are
//   | # | Change | Target file | Impact /10 | Effort /10 | Root cause | Scope |
// Fixtures 1-5 cover the older 5-column table and the tolerated header styles
// for a free-standing "Root causes" section.

const RETRO_FACILITATOR = `## Crew retrospective — ALP-12 + 3 subtasks (operator score: 4/10)
**Operator feedback:** "Too many review loops."
### Part 1 — Task quality (for the human; informational, never a root cause)
- Clarity: 7: readable
- Completeness: 5: missing an edge case
### Part 2 — Efficiency (from retro-metrics)
| Agent | runs | failed/timed out | bounces caught | bounces caused | approvals with findings | cost | wasted wakes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Dev | 6 | 1 | 0 | 3 | 0 | $2.10 | 2 |
| QA | 3 | 0 | 3 | 0 | 1 | $0.80 | 0 |
Wasted steps: lint not run before hand-off (twice).
### Part 3 — What happened
Went wrong: the linter ran only in review. Went well: QA caught every bounce.
### Part 4 — Proposals
| # | Change | Target file | Impact /10 | Effort /10 | Root cause | Scope |
| - | ------ | ----------- | ---------- | ---------- | ---------- | ----- |
| 1 | Dev runs the linter before every hand-off | agents/dev/AGENTS.md | 8 | 1 | lint was optional before hand-off | universal |
| 2 | Dev runs the client test script before hand-off | CLAUDE.md | 6 | 2 | client test command undocumented | client |
### Part 5 — Where the proposals are
https://github.com/example/kit/pull/12
branch:retro/ALP-12`;

const RETRO_UNSCORED = `## Crew retrospective — ALP-13 (operator score: unscored (auto: run_failed))
**Operator feedback:** none given
### Part 4 — Proposals
| # | Change | Target file | Impact /10 | Effort /10 | Root cause | Scope |
| - | ------ | ----------- | ---------- | ---------- | ---------- | ----- |
| 1 | QA re-runs the failing check before approving | agents/qa/AGENTS.md | 5 | 2 | flaky check accepted | universal |`;

// Columns in another order: the parser maps by heading, not position.
const RETRO_REORDERED = `## Crew retrospective — ALP-14 (operator score: 8/10)
| # | Impact /10 | Effort /10 | Change | Scope | Target file | Root cause |
| - | - | - | - | - | - | - |
| 1 | 9 | 3 | Lead asks for a visual reference | universal | agents/lead/AGENTS.md | no mock-up |`;

// Fixture 1 — `**bold:**` headers, 5-column table.
const RETRO_BOLD = `## Crew retrospective — ALP-290 (operator score: 7/10)

**Operator feedback:** "Good instinct, but the fix was over-scoped."

**Root causes:**
The validator only checked the name, not name and colour, so duplicates slipped through.
A missing unique index let the race win.

| # | Change | Target file | Impact /10 | Effort /10 |
| - | ------ | ----------- | ---------- | ---------- |
| 1 | Add a name and colour validator | server/src/services/labels.ts | 8 | 3 |
| 2 | Add a unique index on the label name | packages/db/src/schema/labels.ts | 6 | 2 |

**Next step:** Operator to apply migration.`;

// Fixture 2 — `## Header` (h2) style + Title-Case, different score.
const RETRO_H2 = `## Crew retrospective — ALP-335 (operator score: 9/10)

**Operator feedback:** "Nice."

## Root Causes

A test label rename was incomplete; a stale label survived in one test file.

| # | Change | Target file | Impact /10 | Effort /10 |
| - | ------ | ----------- | ---------- | ---------- |
| 1 | Grep all test files after any label rename | AGENTS.md | 5 | 1 |

**Next step:** Add a lint check.`;

// Fixture 3 — `### header` (h3) + lowercase, no operator feedback.
const RETRO_H3 = `### Crew retrospective — ALP-400 (operator score: 6/10)

### root causes
The connector ECONNRESET flake masked the real failure.

| # | Change | Target file | Impact /10 | Effort /10 |
| - | ------ | ----------- | ---------- | ---------- |
| 1 | Retry the connector on ECONNRESET | server/src/services/connector.ts | 7 | 4 |
| 2 | Log status, code and body on connector errors | server/src/services/connector.ts | 4 | 1 |

**Next step:** Ship retry wrapper.`;

// Fixture 4 — inline `**Root causes:** text on same line`, missing effort cell.
const RETRO_INLINE = `## Crew retrospective — ALP-401 (operator score: 8/10)

**Operator feedback:** "Agreed."

**Root causes:** A single shared dev env caused visual-gate contention.

| # | Change | Target file | Impact /10 | Effort /10 |
| - | ------ | ----------- | ---------- | ---------- |
| 1 | Stand up isolated per-agent envs | docker/compose.yml | 9 |  |

**Next step:** Operator decision.`;

// Fixture 5 — plain `Root causes:` (no markdown), decimal score, no reviewed id in heading.
const RETRO_PLAIN = `## Crew retrospective (operator score: 7.5/10)

Reviewed ticket: ALP-324

Operator feedback: "Fine as is."

Root causes:
Over-gating a settings test blocked a legitimate flow.

| # | Change | Target file | Impact /10 | Effort /10 |
| - | ------ | ----------- | ---------- | ---------- |
| 1 | Remove the extra permission gate | ui/src/pages/Settings.tsx | 6 | 2 |

Next step: done.`;

describe("parseRetroComment on the facilitator's comment format", () => {
  it("reads the Part 4 proposals table, not the Part 2 efficiency table", () => {
    const parsed = parseRetroComment(RETRO_FACILITATOR);
    expect(parsed.reviewedIdentifier).toBe("ALP-12");
    expect(parsed.operatorScore).toBe(4);
    expect(parsed.operatorFeedback).toBe("Too many review loops.");
    expect(parsed.proposals).toEqual([
      {
        number: 1,
        key: "1",
        change: "Dev runs the linter before every hand-off",
        targetFile: "agents/dev/AGENTS.md",
        impact: 8,
        effort: 1,
        rootCause: "lint was optional before hand-off",
        scope: "universal",
      },
      {
        number: 2,
        key: "2",
        change: "Dev runs the client test script before hand-off",
        targetFile: "CLAUDE.md",
        impact: 6,
        effort: 2,
        rootCause: "client test command undocumented",
        scope: "client",
      },
    ]);
  });

  it("treats an unscored (auto) retro as having no operator score", () => {
    const parsed = parseRetroComment(RETRO_UNSCORED);
    expect(parsed.reviewedIdentifier).toBe("ALP-13");
    expect(parsed.operatorScore).toBeNull();
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0]).toMatchObject({ rootCause: "flaky check accepted", scope: "universal" });
  });

  it("suffixes a repeated row number so each proposal keeps a unique key", () => {
    const parsed = parseRetroComment(`## Crew retrospective — ALP-15 (operator score: 5/10)
| # | Change | Target file | Impact /10 | Effort /10 | Root cause | Scope |
| - | - | - | - | - | - | - |
| 1 | First | a.md | 5 | 1 | x | universal |
| 1 | Repeated number | b.md | 4 | 1 | y | universal |
| 1 | Repeated again | c.md | 3 | 1 | z | client |
| 2 | Second | d.md | 2 | 1 | w | client |`);
    expect(parsed.proposals.map((p) => [p.number, p.key])).toEqual([
      [1, "1"],
      [1, "1.2"],
      [1, "1.3"],
      [2, "2"],
    ]);
  });

  it("maps columns by heading, whatever their order", () => {
    const parsed = parseRetroComment(RETRO_REORDERED);
    expect(parsed.proposals).toEqual([
      {
        number: 1,
        key: "1",
        change: "Lead asks for a visual reference",
        targetFile: "agents/lead/AGENTS.md",
        impact: 9,
        effort: 3,
        rootCause: "no mock-up",
        scope: "universal",
      },
    ]);
  });
});

describe("parseReviewedIdentifierFromTitle", () => {
  it("extracts the reviewed id after the em-dash", () => {
    expect(parseReviewedIdentifierFromTitle("Crew retrospective — ALP-397")).toBe("ALP-397");
  });
  it("handles hyphen and en-dash separators", () => {
    expect(parseReviewedIdentifierFromTitle("Crew retrospective - ABC-12")).toBe("ABC-12");
    expect(parseReviewedIdentifierFromTitle("Crew retrospective – XY-3")).toBe("XY-3");
  });
  it("returns null when no identifier is present", () => {
    expect(parseReviewedIdentifierFromTitle("Crew retrospective — misc cleanup")).toBeNull();
  });
});

describe("parseReviewedIdentifierFromDescription", () => {
  it("reads `Reviewed ticket: <id>` from the description", () => {
    expect(parseReviewedIdentifierFromDescription("Reviewed ticket: ALP-324")).toBe("ALP-324");
  });
  it("is case-insensitive and tolerant of punctuation", () => {
    expect(parseReviewedIdentifierFromDescription("reviewed ticket # PAP-9")).toBe("PAP-9");
  });
  it("returns null when absent", () => {
    expect(parseReviewedIdentifierFromDescription("nothing here")).toBeNull();
    expect(parseReviewedIdentifierFromDescription(null)).toBeNull();
  });
});

describe("extractSection header-style tolerance", () => {
  it("reads a **bold:** section", () => {
    expect(extractSection(RETRO_BOLD, "Root causes")).toContain("only checked the name");
  });
  it("reads a ## header section (Title-Case)", () => {
    expect(extractSection(RETRO_H2, "Root causes")).toContain("rename was incomplete");
  });
  it("reads a ### header section (lowercase)", () => {
    expect(extractSection(RETRO_H3, "Root causes")).toContain("ECONNRESET flake");
  });
  it("reads an inline `**Root causes:** text` section", () => {
    expect(extractSection(RETRO_INLINE, "Root causes")).toContain("shared dev env");
  });
  it("reads a plain `Root causes:` section", () => {
    expect(extractSection(RETRO_PLAIN, "Root causes")).toContain("Over-gating");
  });
  it("does not bleed the table into the section body", () => {
    expect(extractSection(RETRO_BOLD, "Root causes")).not.toContain("|");
  });
});

describe("parseRetroComment on the 5-column table", () => {
  it("parses the bold fixture fully", () => {
    const parsed = parseRetroComment(RETRO_BOLD);
    expect(parsed.reviewedIdentifier).toBe("ALP-290");
    expect(parsed.operatorScore).toBe(7);
    expect(parsed.operatorFeedback).toBe("Good instinct, but the fix was over-scoped.");
    expect(parsed.rootCauses).toContain("duplicates slipped through");
    expect(parsed.proposals).toHaveLength(2);
    expect(parsed.proposals[0]).toMatchObject({
      number: 1,
      change: "Add a name and colour validator",
      targetFile: "server/src/services/labels.ts",
      impact: 8,
      effort: 3,
      rootCause: null,
      scope: null,
    });
    expect(parsed.proposals[1]).toMatchObject({ number: 2, impact: 6, effort: 2 });
  });

  it("parses the ## header fixture", () => {
    const parsed = parseRetroComment(RETRO_H2);
    expect(parsed.reviewedIdentifier).toBe("ALP-335");
    expect(parsed.operatorScore).toBe(9);
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0]?.impact).toBe(5);
  });

  it("parses the ### header fixture with no operator feedback", () => {
    const parsed = parseRetroComment(RETRO_H3);
    expect(parsed.reviewedIdentifier).toBe("ALP-400");
    expect(parsed.operatorFeedback).toBeNull();
    expect(parsed.proposals).toHaveLength(2);
  });

  it("treats a missing effort cell as null (caller defaults to 0)", () => {
    const parsed = parseRetroComment(RETRO_INLINE);
    expect(parsed.reviewedIdentifier).toBe("ALP-401");
    expect(parsed.proposals).toHaveLength(1);
    expect(parsed.proposals[0]?.impact).toBe(9);
    expect(parsed.proposals[0]?.effort).toBeNull();
  });

  it("parses decimal score + plain headers + description-fallback reviewed id", () => {
    const parsed = parseRetroComment(RETRO_PLAIN);
    // No id in heading; heading parse yields null, service falls back to description.
    expect(parsed.reviewedIdentifier).toBeNull();
    expect(parseReviewedIdentifierFromDescription(RETRO_PLAIN)).toBe("ALP-324");
    expect(parsed.operatorScore).toBe(7.5);
    expect(parsed.rootCauses).toContain("Over-gating");
    expect(parsed.proposals[0]).toMatchObject({ number: 1, impact: 6, effort: 2 });
  });

  it("returns empty proposals (never throws) on an unparseable body", () => {
    const parsed = parseRetroComment("just some prose with no table and no heading");
    expect(parsed.proposals).toEqual([]);
    expect(parsed.reviewedIdentifier).toBeNull();
  });
});
