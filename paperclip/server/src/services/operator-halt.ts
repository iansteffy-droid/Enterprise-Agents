import type { IssueExecutionState } from "@paperclipai/shared";
import { DEFAULT_WORKFLOW_HALT_PHRASES } from "@paperclipai/shared";
import { OPERATOR_ACTION_PREFIX, buildHeldExecutionState } from "./issue-execution-policy.js";

export { OPERATOR_ACTION_PREFIX };

/** Halt phrases used when the company's blueprint row sets none. */
export const DEFAULT_HALT_PHRASES: readonly string[] = DEFAULT_WORKFLOW_HALT_PHRASES;

/** What may follow a phrase on the first line for it still to count as the phrase. */
const PHRASE_SEPARATORS = [",", ".", ";", ":", " —", " -", " and "] as const;

// Trailing whitespace, sentence-ending punctuation and emoji. "?" is kept on purpose:
// "done?" is a question, not an instruction.
const TRAILING_NOISE = /[\s.!…\p{Extended_Pictographic}‍️]+$/u;

/** Phrases from the blueprint row, or the shared default when the row has none. */
export function resolveHaltPhrases(blueprint: { haltPhrases: string[] | null } | null | undefined): readonly string[] {
  return blueprint?.haltPhrases ?? DEFAULT_HALT_PHRASES;
}

/**
 * The halt phrase an operator comment invokes, or null. Only the first non-empty line counts:
 * it must be the phrase, or the phrase followed by one of PHRASE_SEPARATORS. Longer phrases win
 * ("done and merged" over "done").
 */
export function detectOperatorHalt(body: string, phrases: readonly string[]): string | null {
  const firstLine = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine) return null;
  const line = firstLine.toLowerCase().replace(TRAILING_NOISE, "");
  const candidates = [...new Set(phrases.map((phrase) => phrase.trim().toLowerCase()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const phrase of candidates) {
    if (line === phrase) return phrase;
    if (line.startsWith(phrase) && PHRASE_SEPARATORS.some((sep) => line.startsWith(sep, phrase.length))) {
      return phrase;
    }
  }
  return null;
}

/**
 * The untimed operator hold a halt phrase produces; stage pointers and participants are kept.
 * A halt while changes are requested remembers it, so a resume returns the issue to its author.
 */
export function buildOperatorHaltState(state: IssueExecutionState, reason: string): IssueExecutionState {
  return buildHeldExecutionState(state, {
    reason,
    resumeAt: null,
    heldBy: "operator",
    ...(state.status === "changes_requested" ? { resumeStatus: "changes_requested" as const } : {}),
  });
}
