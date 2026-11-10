// Parser for crew-retrospective comments.
//
// Each retro is an issue titled `Crew retrospective — <REVIEWED>` on which the
// retro facilitator agent posts one comment. Its shape is documented in the
// facilitator's instructions (agents/guinan/AGENTS.md, "The comment"):
//
//   ## Crew retrospective — <KEY> + <N> subtasks (operator score: <N>/10 | unscored (auto: <signal>))
//   **Operator feedback:** <verbatim, or "none given">
//   ### Part 1 … Part 3 (a Part 2 efficiency table among them)
//   ### Part 4 — Proposals
//   | # | Change | Target file | Impact /10 | Effort /10 | Root cause | Scope |
//   ### Part 5 — Where the proposals are
//
// The proposals table is found by its headings (a table whose header names both
// "Change" and "Impact"), and its columns are mapped by heading, not position,
// so a reordered table or one without the Root cause / Scope columns still
// parses. A free-standing "Root causes" section is read when present. The
// parser is tolerant: casing and header style vary, sections may be absent,
// and an unparseable comment yields `{ proposals: [] }` rather than throwing so
// the page never breaks on format drift.

export interface ParsedRetroProposal {
  number: number;
  /**
   * Unique key of the row within the comment: the number, or `<number>.<occurrence>`
   * for a repeated number (the second row numbered 2 is "2.2"), so point keys stay unique.
   */
  key: string;
  change: string;
  targetFile: string | null;
  /** null when the Impact cell is missing/unparseable (caller treats as 0). */
  impact: number | null;
  /** null when the Effort cell is missing/unparseable (caller treats as 0). */
  effort: number | null;
  /** The row's Root cause cell; null when the table has no such column or the cell is empty. */
  rootCause: string | null;
  /** The row's Scope cell (`universal` or `client`); null when absent. */
  scope: string | null;
}

export interface ParsedRetro {
  /** Reviewed feature ticket id parsed from the heading, e.g. "ABC-12". */
  reviewedIdentifier: string | null;
  /** Operator score out of 10 from the heading, e.g. 7. */
  operatorScore: number | null;
  operatorFeedback: string | null;
  rootCauses: string | null;
  proposals: ParsedRetroProposal[];
}

const IDENTIFIER_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;

/** Extract the reviewed ticket id from a retro ticket title. */
export function parseReviewedIdentifierFromTitle(title: string): string | null {
  // Prefer the id that follows the "Crew retrospective —" / "-" separator.
  const afterDash = title.split(/[—–-]/).slice(1).join("-");
  const fromTail = afterDash.match(IDENTIFIER_RE);
  if (fromTail) return fromTail[1]!.toUpperCase();
  const anywhere = title.match(IDENTIFIER_RE);
  return anywhere ? anywhere[1]!.toUpperCase() : null;
}

/** Fallback: `Reviewed ticket: <id>` in the retro description. */
export function parseReviewedIdentifierFromDescription(description: string | null): string | null {
  if (!description) return null;
  const match = description.match(/reviewed\s+ticket\s*[:#-]?\s*([A-Z][A-Z0-9]+-\d+)/i);
  return match ? match[1]!.toUpperCase() : null;
}

function parseScoreFromHeading(body: string): number | null {
  // e.g. "(operator score: 7/10)" — tolerant of spacing and casing.
  const match = body.match(/operator\s+score\s*:?\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  return Number.isFinite(value) ? value : null;
}

function parseReviewedIdentifierFromHeading(body: string): string | null {
  // First heading line usually looks like:
  //   ## Crew retrospective — ABC-12 + 3 subtasks (operator score: 7/10)
  const headingLine = body
    .split(/\r?\n/)
    .find((line) => /crew\s+retrospective/i.test(line));
  if (!headingLine) return null;
  return parseReviewedIdentifierFromTitle(headingLine);
}

/**
 * Extract a named section's text. Matches whichever header style the retro used:
 *   `**Root causes:**`, `## Root Causes`, `### root causes`, `Root causes:`.
 * Returns the text up to the next header/table/blank-block boundary.
 */
export function extractSection(body: string, sectionName: string): string | null {
  const lines = body.split(/\r?\n/);
  const nameRe = escapeRegExp(sectionName);
  // A header line for this section, any of the tolerated styles.
  const headerRe = new RegExp(
    `^\\s*(?:#{1,6}\\s*)?\\*{0,2}\\s*${nameRe}\\s*\\*{0,2}\\s*:?\\s*\\*{0,2}\\s*$`,
    "i",
  );
  // Inline form: `**Root causes:** the text is on the same line`.
  const inlineRe = new RegExp(`^\\s*(?:#{1,6}\\s*)?\\*{0,2}\\s*${nameRe}\\s*:\\s*\\*{0,2}\\s*(.*)$`, "i");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const inline = line.match(inlineRe);
    const inlineTail = inline?.[1]?.replace(/\*+\s*$/, "").trim() ?? "";
    if (inline && inlineTail.length > 0) {
      // Header + text on the same line, plus any continuation lines.
      const rest = collectSectionBody(lines, i + 1);
      const combined = [inlineTail, rest].filter(Boolean).join("\n").trim();
      return combined.length > 0 ? combined : null;
    }
    if (headerRe.test(line)) {
      const rest = collectSectionBody(lines, i + 1);
      return rest.length > 0 ? rest : null;
    }
  }
  return null;
}

/** Gather body lines after a section header, stopping at the next boundary. */
function collectSectionBody(lines: string[], start: number): string {
  const collected: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isSectionBoundary(line)) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}

function isSectionBoundary(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("#")) return true; // next ## / ### header
  if (trimmed.startsWith("|")) return true; // start of a table
  // A `**Something:**`-style header line (bold label, possibly with colon).
  if (/^\*{2}[^*].*\*{2}\s*:?\s*$/.test(trimmed)) return true;
  if (/^\*{2}[^*].*:\*{2}/.test(trimmed)) return true;
  return false;
}

function parseOperatorFeedback(body: string): string | null {
  const section = extractSection(body, "Operator feedback");
  if (!section) return null;
  // Strip surrounding quotes if present.
  return section.replace(/^["'“”]+/, "").replace(/["'“”]+$/, "").trim() || null;
}

type ProposalColumn = "number" | "change" | "targetFile" | "impact" | "effort" | "rootCause" | "scope";

/** Map a header cell to the proposal field it holds (by heading text, case-insensitive). */
function columnForHeading(cell: string): ProposalColumn | null {
  const heading = cell.trim().toLowerCase();
  if (heading === "#" || heading === "no" || heading === "no." || heading === "number") return "number";
  if (heading.startsWith("change")) return "change";
  if (heading.startsWith("target")) return "targetFile";
  if (heading.startsWith("impact")) return "impact";
  if (heading.startsWith("effort")) return "effort";
  if (heading.startsWith("root cause")) return "rootCause";
  if (heading.startsWith("scope")) return "scope";
  return null;
}

/** Positional fallback for the five-column table, used for any heading not recognised. */
const POSITIONAL_COLUMNS: ProposalColumn[] = ["number", "change", "targetFile", "impact", "effort"];

function buildColumnMap(headerCells: string[]): Map<ProposalColumn, number> {
  const map = new Map<ProposalColumn, number>();
  headerCells.forEach((cell, index) => {
    const column = columnForHeading(cell);
    if (column && !map.has(column)) map.set(column, index);
  });
  POSITIONAL_COLUMNS.forEach((column, index) => {
    if (!map.has(column) && index < headerCells.length && !columnForHeading(headerCells[index] ?? "")) {
      map.set(column, index);
    }
  });
  return map;
}

/**
 * Parse the proposals table: the first table whose header row names both
 * "Change" and "Impact" (the Part 4 table; the Part 2 efficiency table has
 * neither). Columns are mapped by heading.
 */
function parseProposalsTable(body: string): ParsedRetroProposal[] {
  const lines = body.split(/\r?\n/);
  const rows: string[][] = [];
  let columns: Map<ProposalColumn, number> | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    const isTableRow = line.startsWith("|") && line.includes("|", 1);
    if (!isTableRow) {
      if (columns) break; // the proposals table ended
      continue;
    }
    const cells = splitTableRow(line);
    if (!columns) {
      const headings = cells.map((cell) => columnForHeading(cell));
      if (headings.includes("change") && headings.includes("impact")) {
        columns = buildColumnMap(cells);
      }
      continue;
    }
    // Skip the separator row (---|---).
    if (cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s/g, "")) || cell.trim() === "")) {
      continue;
    }
    rows.push(cells);
  }
  if (!columns) return [];

  const cellOf = (cells: string[], column: ProposalColumn): string => {
    const index = columns!.get(column);
    return index == null ? "" : (cells[index] ?? "").trim();
  };
  const textOrNull = (value: string): string | null => (value.length > 0 ? value : null);

  const proposals: ParsedRetroProposal[] = [];
  const occurrences = new Map<number, number>();
  for (const cells of rows) {
    if (cells.length < 2) continue;
    const number = parseIntOrNull(cellOf(cells, "number"));
    if (number == null) continue; // rows without a proposal number are skipped
    const change = cellOf(cells, "change");
    if (change.length === 0) continue;
    const occurrence = (occurrences.get(number) ?? 0) + 1;
    occurrences.set(number, occurrence);
    proposals.push({
      number,
      key: occurrence === 1 ? String(number) : `${number}.${occurrence}`,
      change,
      targetFile: textOrNull(cellOf(cells, "targetFile")),
      impact: parseScoreCell(cellOf(cells, "impact")),
      effort: parseScoreCell(cellOf(cells, "effort")),
      rootCause: textOrNull(cellOf(cells, "rootCause")),
      scope: textOrNull(cellOf(cells, "scope").toLowerCase()),
    });
  }
  return proposals;
}

function splitTableRow(line: string): string[] {
  // Drop the leading/trailing pipes, then split on unescaped pipes.
  const trimmed = line.replace(/^\|/, "").replace(/\|\s*$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseIntOrNull(value: string | undefined): number | null {
  if (value == null) return null;
  const match = value.match(/\d+/);
  if (!match) return null;
  const n = Number.parseInt(match[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** Parse an Impact/Effort cell like "8", "8/10", "high (8)" → 8. */
function parseScoreCell(value: string | undefined): number | null {
  if (value == null) return null;
  const match = value.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number.parseFloat(match[0]);
  return Number.isFinite(n) ? n : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse a full retro comment body into structured data. Never throws. */
export function parseRetroComment(body: string): ParsedRetro {
  const safeBody = typeof body === "string" ? body : "";
  return {
    reviewedIdentifier: parseReviewedIdentifierFromHeading(safeBody),
    operatorScore: parseScoreFromHeading(safeBody),
    operatorFeedback: parseOperatorFeedback(safeBody),
    rootCauses: extractSection(safeBody, "Root causes"),
    proposals: parseProposalsTable(safeBody),
  };
}
