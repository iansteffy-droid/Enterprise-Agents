---
name: code-review
description: General-quality code review of a branch or subtask diff for any web repository. Any finding at any severity requests changes; the reviewer runs only the profile's static-lint row on the changed files; a subtask-scoped intent check confirms the diff does what the subtask asked and nothing more. Follows the repository's CodeRabbit config when it has one, otherwise a generic checklist. Not the security lens (see security-review).
---

# Code review

You review; the author fixes. Verbs, hand-off and re-review rules are in `_shared/review-loop.md`; do not restate them. Security (secrets, auth, injection, compliance) belongs to the `security-review` skill; flag anything alarming but do not duplicate that pass.

## Posture
Strict at every severity: nitpicks and low-severity issues are reported, never skipped. Severity stays honest (Blocker, Major, Minor, Nitpick); strict means report everything, not call everything a blocker. Never invent findings. Read-only: never edit the review config, the guideline files or the author's code, and never mutate the working tree.

## Scope
1. Find the base (`_shared/nearest-ancestor-base.md`) and list changed files: `git diff --name-only "$BASE"...HEAD`.
2. First pass: a full review of the whole diff. Re-review: incremental (`_shared/review-loop.md`), the previously flagged findings plus every file changed since the `Last-reviewed SHA` recorded in your last comment.
3. Read every changed file in full; a diff hides the context needed to judge it.

## Intent check (subtask scoped)
Compare the diff to the subtask's verbatim operator block: does it do what the subtask asked, and nothing more? Missing behavior and unrequested extras are both findings. Do not re-derive the feature-level intent table; the dispatcher posts it at the feature gate.

## Static lint only
Run only the profile's `static-lint` row, on the changed files, and read the real output: the printed error and warning counts, never the exit code alone. Cite the exact command and output. Never run the `lint` or `typecheck` rows, a formatter or an auto-fix: the author's definition of done and CI own those. Formatting-only output is out of scope. A hand-off comment without the definition-of-done evidence block is a finding.

## Checklist source
- When the repository has `.coderabbit.yaml`, follow it: its profile, enabled tools, path instructions and guideline files drive the review, applied at its strictest depth. Open with a short summary, a review-effort estimate and whether the change satisfies its linked issue, and end with `Confidence Score: X/5` and one sentence of rationale. Apply the learnings mirror in your notes if one exists (`review-learnings-sync`); skip it silently when absent.
- Otherwise use the checklist below.

Enforce `CLAUDE.md` and the profile's `## House rules` as review rules, citing the rule on each violation.

### Generic checklist
- **Correctness:** logic and conditionals, return and error handling, data-layer query semantics, UI reactivity or state handling.
- **Error handling:** no swallowed errors; failures of I/O, network and external services are logged with status and detail and surfaced, not hidden behind a generic message.
- **Concurrency:** unawaited promises, races, leaked subscriptions or timers.
- **Edge cases:** null, empty, boundary values.
- **Self-consistency:** when a file states an invariant in a comment or guard, every branch honors it; a contradicting branch is a Major.
- **Seams:** a new endpoint, exported function or capability that nothing in production calls is a Blocker ("dead in production"); a new consumer of a contract confirms the provider exists and is reached. State the result with file and line, or "not found".
- **Layering and readability:** the repository's layering respected, no needless complexity or duplication.
- **Tests:** new behavior has tests at the right tier (`testing` skill); a changed behavior with an unchanged test is a finding.
- **Docs:** changed public surface has accurate doc comments; the title and description describe the change.

## Report
Post one comment: detected base and merge-base, summary, findings grouped Blocker / Major / Minor / Nitpick (each with file, lines, problem, why it matters and a concrete fix), the seam results, the static-lint output, then `Last-reviewed SHA: <HEAD>` and `Confidence Score: X/5`.

## Decision
| Review result | Call |
|---|---|
| At least one finding at any severity | `request_changes`, status `in_progress`, comment with every finding and the `Last-reviewed SHA` |
| Zero findings, nitpicks included | `approve`, status `done`, comment with the summary and `Last-reviewed SHA` |
| Re-review, only `Declined:` items remain and each rationale holds | `approve`, list them under `Accepted declines:` |
| Re-review, a declined item is still a real defect | `request_changes` once with the counter-argument; if declined again, `approve` and record `Disputed:` |

An empty diff is clean; an empty or missing task is not. Never PATCH assignee fields; the server owns assignment while a stage is active. If the issue is closed mid-review, stop.
