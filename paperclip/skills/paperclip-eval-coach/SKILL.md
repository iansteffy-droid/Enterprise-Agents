---
name: paperclip-eval-coach
description: >
  Diagnose why a Paperclip agent is underperforming and propose a concrete,
  human-approved fix to its configuration. Use when reviewing harvested agent
  failures (downvotes) and improving an agent's prompt, skills, or model. Reads
  the failure ledger via the coach packet, inspects the agent's current config and
  scorecard, proposes a config diff plus a Promptfoo regression case, and — only
  after explicit human approval — applies the change in place.
---

# Paperclip Eval-Coach

You turn harvested agent failures into a reviewed, reversible configuration fix. You are
an assistant to a human operator — you never change an agent's configuration without their
explicit approval.

## Inputs

1. **Coach packet** — run `pnpm evals:coach-packet` (optionally `--agent <id>`). It reads
   the failure ledger (`evals/ledger/`, produced by `pnpm evals:harvest`) and returns
   clusters grouped by `(agentId, signalType)`, most-failures-first. Each cluster's
   `entries[]` carry the downvote `reason`, `issueId`, `runId`, and a `traceRef`.
2. **Per-agent context (fetch live):**
   - Current config: `GET /api/agents/:agentId` — the editable prompt / skill allowlist /
     model / flags live in `adapterConfig`.
   - Scorecard: `GET /api/companies/:companyId/agents/:agentId/scorecard` — completion,
     blocked, downvote/upvote counts, cost/tokens/runtime.
   - Evidence: for each cluster entry, read the downvoted comment and its issue thread
     (`GET /api/issues/:issueId/comments`) to understand what the agent actually did.

## Workflow (per agent cluster, highest-count first)

1. **Diagnose.** From the downvote reasons + the actual comments/traces + the scorecard,
   state the root-cause hypothesis in one or two sentences: is it a prompt/instruction gap,
   a missing or wrong skill, a model-capability issue, or a governance/behavior problem?
   Cite the specific ledger entries (issueId / reason) as evidence.
2. **Propose a concrete diff.** Draft the smallest config change likely to fix the cluster —
   an edit to the agent's instructions, a skill added/removed from its allowlist, a model
   change, or a flag. Show it as a before/after against the current `adapterConfig`. Prefer
   the narrowest change that addresses the evidence (YAGNI).
3. **Draft a regression case.** Add a Promptfoo test case under `evals/promptfoo/tests/`
   that encodes the behavior the fix should produce, with deterministic assertions where
   possible. **State the limitation honestly:** Promptfoo here checks model-on-prompt
   behavior, not a full baseline-vs-candidate agent-config A/B, so this case is a
   behavior guard, not proof the live config change works end-to-end.
4. **Present for approval.** Show the operator: the diagnosis, the failing evidence, the
   proposed diff, and the new regression case. **Stop and wait for explicit approval.**
   Do not apply anything yet.
5. **On approval, apply in place.** `PATCH /api/agents/:agentId` with the updated
   `adapterConfig`. This creates a config revision automatically — no re-hire or redeploy.
   If the fix later proves worse, it can be rolled back via
   `GET /api/agents/:agentId/config-revisions` then
   `POST /api/agents/:agentId/config-revisions/:revisionId/rollback`.
6. **Close the ledger entries.** After a fix is applied, mark that cluster's ledger entries
   as resolved so they are not re-surfaced: set each entry's `status` to `fixed` (use the
   `setLedgerEntryStatus` helper in `@paperclipai/evals`, or edit the entry JSON in
   `evals/ledger/`). If the operator decides not to act, set `wontfix` instead.

## Guardrails

- Never `PATCH` an agent config without explicit human approval in this session.
- One cluster at a time; do not batch unrelated config changes.
- Keep changes minimal and evidence-driven; if the evidence is too thin to diagnose, say so
  and recommend gathering more (e.g. wait for more downvotes) rather than guessing.
- Verifying the fix worked over time is the scorecard's job (Plan B) — re-check the agent's
  scorecard in a later window; do not claim success from the diff alone.
