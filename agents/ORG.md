# Operating model

Eleven agents develop web features on one client repository per company. This file is the universal layer's map; the rules themselves live in each agent's `AGENTS.md` and in `_shared/`.

## Roster
| Codename | Role | Tier | Position |
| --- | --- | --- | --- |
| Data | Intake lead | fast | intake door, before any chain |
| Riker | Dispatcher | capable | slices, parks, submits the feature; its return assignee |
| Geordi | Developer | capable | author of `kind:impl` |
| Lwaxana Troi | Test planner and writer | fast | author of `kind:tests` |
| Hops | Code reviewer | fast | subtask chain, the only stage |
| Worf | Security reviewer | capable | feature stage 1 |
| Dr Crusher | QA and acceptance | capable | feature stage 2 |
| Ro Laren | Visual verifier and repro author | fast | feature stage 3; author of `kind:repro` |
| O'Brien | Branch hygiene and release integration | fast | feature stage 4; prepare-for-merge routine |
| Guinan | Retro facilitator | fast | outside the chain |
| Boothby | Repo onboarder | capable | outside the chain |

The roster sets each agent's model from its tier. Agents carry no ids: to address another agent, fetch the company's agent list and match the codename, which starts each display name (`<Codename> - <Role>`, for example `Geordi - Developer`). Hierarchy is not the execution path: `reportsTo` governs delegation only; review is the server-attached chain. No timer heartbeats: agents wake on assignment, comments, decisions, stage advances and routines.

## The flow and the two chains
Data clarifies a request and assigns it to Riker; that first assignment away from intake attaches the feature chain. Riker slices it into subtasks and parks the feature `blocked` on them. When the last child is `done`, Riker verifies the assembled branch and submits the feature `in_review`.
- **Subtask chain**, attached at creation to `kind:impl` and `kind:tests`: Hops → done.
- **Feature chain**: Worf → Dr Crusher → Ro Laren → O'Brien → the board's approval. The human then opens the PR and merges it; no agent opens, edits or closes a PR.

Nobody sets `executionPolicy`, names a reviewer or changes an assignee: the server routes. A subtask finding returns to its author. A feature finding returns to Riker, who opens one `kind:impl` fix subtask for Geordi on the same branch and re-submits; the chain resumes at the stage that asked.

**Subtask kinds.** `kind:impl` (Geordi), `kind:tests` (Lwaxana Troi, one per feature, blocked by the implementation), `kind:repro` (Ro Laren, first on every bug; the fix is blocked by it). A subtask without a label counts as `impl`. `kind:repro` has no chain: it is done when the script and the evidence that it fails are posted; `Not reproduced` stops the fix. A test that fails on a real product defect stays as written: Lwaxana Troi posts `Defect found:` on the feature and Riker opens a fix subtask.

Standard mode runs one feature at a time per client: the writers share the fleet tree sequentially; parallel features are not supported in this mode.

## Verbs, hold, halt, handoff
- **Reviewer verbs**, exactly three, as a PATCH carrying `executionDecision` and a `comment`, never a `status` (the server derives it): `approve`, `request_changes`, `hold` (optional `holdResumeAt`). Any finding at any severity is `request_changes`. A reviewer never cancels or blocks an issue mid-stage. Authors hand off with a plain `in_review` and answer every finding with `Fixed:` or `Declined:` and a rationale; re-review is incremental at the same stage.
- **Hold.** Timed: the server re-wakes the same participant at `holdResumeAt` (CI pending). Untimed: the issue goes to the board user with a comment starting `Operator action needed:`; the board's resume returns it to the same stage and participant. A hold is never a bounce.
- **Operator halt.** A board comment whose first line is one of the company's configured halt phrases holds the chain: the issue's `executionState.status` becomes `held`, as under any hold. Every agent reads that state first and, while it is `held`, posts nothing and exits; a resume clears it.
- **Handoff card.** Outside a stage, waiting on the human is an interaction card on the agent's own issue (`continuationPolicy: "wake_assignee"`) plus one comment starting `Board decision needed:` or `Operator action needed:`, also on the top-level issue when the agent owns a subtask. Status and assignee never change for it (`_shared/board-decision-handoff.md`). Inside a stage it is `hold`.
- `blocked` means waiting on another issue, nothing else.

## Three layers
Universal (`ORG.md`, `_shared/`, each `AGENTS.md`) > the client's `CLAUDE.md` > the stack profile `.paperclip-enterprise/profile.md`. Stack commands are quoted from the profile's `## Commands` by row name, never inlined. Client facts live in `.paperclip-enterprise/client.md`.

## Push policy
Agents may push any branch except the mainline (`$GIT_GUARD_MAINLINE`), which no agent commits to, merges into, switches to, resets or pushes; only a human merge changes it. One request, one feature, one branch, one PR, opened by the human; sub-branches merge back and are deleted. Branches are pushed with `git push -u origin HEAD` after switching to them. `GIT_GUARD_PUSH_ALLOW` narrows an agent to globs: Guinan `retro/*`, Boothby `onboarding/*`. Force-push is O'Brien's alone, `--force-with-lease` on the feature branch in prepare-for-merge (`GIT_GUARD_FORCE_PUSH_ALLOW`). Nothing squashes automatically; the operator triggers prepare-for-merge.

## Worktrees per client
- **Operator tree** (`$PRODUCT_OPERATOR_TREE`): the human's checkout. No agent moves its HEAD; a branch held there is an `Operator action needed:` one-liner.
- **Fleet tree** (`$PRODUCT_FLEET_TREE`): every agent's working tree and the home of `.paperclip-enterprise/`.
- **Retro tree** (`$PRODUCT_RETRO_TREE`): Guinan's client-specific `retro/<issue>` branches.
- **Kit fleet worktree** (`paperclip-enterprise-fleet`, beside the kit): Guinan's universal `retro/<issue>` branches. The kit tree itself (`$AGENTS_REPO`) is what agents read live and is never branched.

Temporary worktrees are detached and removed before a run ends; the fleet and retro trees detach at session end so the human can check out any branch.

## Evidence roots
- `$COMPLETION_GATE_EVIDENCE_DIR/<issueId>/`: Ro Laren's screenshots, or a `WAIVER`; the completion gate reads it before a top-level issue may be `done`.
- `$QA_EVIDENCE_DIR/<issueId>/<sha>/`: Dr Crusher's per-commit evidence, so an interrupted run resumes. Never under the visual root.

## Agent env
`AGENTS_REPO` (the kit), `PRODUCT_OPERATOR_TREE`, `PRODUCT_FLEET_TREE`, `PRODUCT_RETRO_TREE`, `CLAUDE_CONFIG_DIR` (the subscription login), `COMPLETION_GATE_EVIDENCE_DIR`, `QA_EVIDENCE_DIR`, `PAPERCLIP_BOARD_USER_ID`, `GIT_GUARD_MAINLINE`, `GIT_GUARD_PUSH_ALLOW`, `GIT_GUARD_FORCE_PUSH_ALLOW`, `LINT_BANNED_TERMS_DIR` (the private lint lists).

## Retro contract
The retro routine fires by hand or on a signal: the bounce threshold, a human changes-requested, a failed or timed-out run, a cancellation after work started (then `satisfactionScore` is `unscored (auto: <signal>)`). Guinan mines the whole ticket tree and its metrics in one run and writes two outputs, never mixed: a task-quality grade for the human (informational) and agent improvement, where every root cause ends in an agent-side action and none targets the operator. Proposals are exact diffs on `retro/<issue>` branches, universal ones to the kit, client-specific ones to the client repo, as PRs (or branch and diff while a repo has no remote); each retro point records its `proposalRef`. The human merges or closes.

## Acceptance scenarios
The runbook runs each on a throwaway client:
1. One feature end to end: intake → dispatch → implementation → Hops → Lwaxana Troi → Worf → Dr Crusher → Ro Laren → O'Brien → board approval, with no manual intervention.
2. Worf's short run on a diff that touches no security-relevant path.
3. A timed hold (CI pending) that resumes on its own.
4. An untimed hold resumed by the board.
5. An operator halt.
6. A feature-level `request_changes` producing a fix subtask through Riker.
7. A test-exposed defect (`Defect found:`) producing a fix subtask.
8. A bug's `kind:repro` subtask gating its fix.
9. Provisioning re-run: nothing changes.
