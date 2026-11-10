# Acceptance scenarios

The script for verifying the kit on a throwaway client: after `scripts/new-client` has provisioned it, a human (or a verifier agent) creates the issues below through the Paperclip API or UI and compares what happens against the expected decision rows and agent wakes. Each scenario of `agents/ORG.md` `## Acceptance scenarios` has a section here (3 and 4 share one feature), plus the handoff card. Run them in order, one at a time.

Names used throughout:
- **F**: the scenario's top-level feature (or bug) issue. **I**: its `kind:impl` subtask. **T**: its `kind:tests` subtask. **X**: a fix subtask (`kind:impl`). **R**: a `kind:repro` subtask.
- **Board**: the board user (`$PAPERCLIP_BOARD_USER_ID`), the human operator.
- Agents by codename, as in `agents/ORG.md`. Their display names contain the codename; resolve them from the company's agent list, never from a stored id.

## Global preconditions

1. The throwaway client is provisioned on an empty remote with the shipped profile: `scripts/new-client --name <throwaway> --new --repo <empty remote> --profile vue-nest-mongo` exited 0 and printed its summary. Every later step reads its values from `clients/<throwaway>/client.yaml` in the kit.
2. The app is that profile's `## Scaffold`, unchanged by any feature: a `client` workspace from the Vite `vue-ts` template (the home page is `client/src/App.vue`, rendering `client/src/components/HelloWorld.vue` with its counter button `@click="count++"`; the client package manifest is `client/package.json`), a `server` workspace from the Nest CLI (`server/src/app.controller.ts`), plus `shared` and `e2e`. Scenarios 1, 2, 7, 8 and 10 name these files; on another scaffold, map each named file to its equivalent before starting and write the mapping into `$RUNBOOK_OUT/scaffold-map.txt`.
3. Boothby's onboarding is finished: the onboarding PR is merged by the human, so `.paperclip-enterprise/profile.md` and `client.md` are on the mainline; the CI workflows that `## CI` names exist on the mainline and are green; the onboarding issue's handoff card is resolved and the human closed the issue. Keep the remote branch `onboarding/<throwaway>` (scenario 9 looks for it).
4. `gh` is authenticated for the client remote in the operator tree.
5. The throwaway profile on the mainline carries `ci_wait_minutes: 1` under `## Limits`. The human makes this edit in the operator tree, commits and pushes it on the mainline before scenario 1, so every feature branch cut afterwards carries it. Scenarios 3 and 4 depend on it; the rest only run faster.
6. Every agent is idle and no feature is open: standard mode runs one feature at a time per client.

## Conventions for the commands

Run from the kit checkout. The calls run as the board user, the way `scripts/new-client` calls the API on a local trusted instance; on an authenticated deployment, do the same through the UI.

```bash
CLIENT=<throwaway>
Y="clients/$CLIENT/client.yaml"
yv() { sed -n "s/^$1: \"\(.*\)\"$/\1/p" "$Y" | head -n1; }
API="$(yv api)" CID="$(yv company_id)" PROJECT="$(yv project_id)" OP="$(yv operator_tree)" ML="$(yv mainline)"
COMPLETION_GATE_EVIDENCE_DIR="$(yv completion_gate_evidence_dir)" QA_EVIDENCE_DIR="$(yv qa_evidence_dir)"
PG="postgres://paperclip:paperclip@127.0.0.1:$(yv db_port)/paperclip"   # the embedded database's defaults
RUNBOOK_OUT=<a scratch directory outside the kit and the client trees>
get()   { curl -sf "$API$1"; }
post()  { curl -sf -X POST  -H 'content-type: application/json' -d @"$2" "$API$1"; }
api_patch() { curl -sf -X PATCH -H 'content-type: application/json' -d @"$2" "$API$1"; }
agent() { get "/api/companies/$CID/agents" | jq -r --arg n "$1" '[.[]|select(.name|contains($n))][0].id'; }
label() { get "/api/companies/$CID/labels" | jq -r --arg n "$1" '.[]|select(.name==$n)|.id'; }
key_id() { get "/api/companies/$CID/issues?limit=1000" | jq -r --arg k "$1" '.[]|select(.identifier==$k)|.id'; }
```

**Creating an issue.** Write the description to a file, build the body with `jq`, post it. Every scenario issue is created top-level (no parent) and assigned to Data, the intake door; never straight to Riker.

```bash
jq -n --arg t "<title>" --rawfile d "$RUNBOOK_OUT/sN/description.md" --arg a "$(agent Data)" --arg p "$PROJECT" \
  '{title: $t, description: $d, status: "todo", priority: "medium", assigneeAgentId: $a, projectId: $p}' \
  > "$RUNBOOK_OUT/sN/issue-body.json"
post "/api/companies/$CID/issues" "$RUNBOOK_OUT/sN/issue-body.json" | tee "$RUNBOOK_OUT/sN/issue.json" | jq -r .identifier
```

To add a label at creation, add `labelIds: [$l]` with `--arg l "$(label <name>)"`. No scenario issue carries a label, an `executionPolicy` or a reviewer: Data adds `security-relevant` when the request calls for it, Riker adds the `kind:` labels, the server attaches the chains.

**Board actions.** Four bodies, each sent with `api_patch "/api/issues/$F_ID" <file>` where `F_ID="$(key_id <F key>)"`:

`resume.json`, the board's resume of any hold or halt (it returns the issue to the same stage):
```json
{ "status": "in_review" }
```

`approve.json`, the board's sign-off at the approval stage:
```json
{ "executionDecision": "approve", "comment": "Approved for merge." }
```

`cancel.json`, the board's disposition of a throwaway issue that a scenario abandons (10b, or a scenario recorded as not exercised); cancelling after work started is a retro signal:
```json
{ "status": "cancelled" }
```

`comment.json`, posted with `post "/api/issues/$F_ID/comments" comment.json`:
```json
{ "body": "merged" }
```

Never send a bare status change to complete an issue: the board's sign-off is the `approve` decision, and a status override on a held issue completes the whole workflow without the stages.

## How to read the decisions table

The server writes one `issue_execution_decisions` row per stage verdict: outcome `approved`, `changes_requested` or `held`, with `stage_type` `review` or `approval`, the actor (an agent, or the board user for the approval stage and a halt), and the decision comment as `body`. Read them through `GET /api/issues/:id/execution-decisions` (company-scoped through the issue; the issue's rows in `createdAt` order, each with `outcome`, `stageId`, `stageType`, `actorAgentId`, `actorUserId`, `body`, `createdByRunId`, `createdAt`). Every row in the tree under a feature, feature first then each subtask:
```bash
decisions() { # feature-id
  { echo "$1"; get "/api/companies/$CID/issues?descendantOf=$1" | jq -r '.[].id'; } |
    while read -r i; do get "/api/issues/$i/execution-decisions" | jq -c --arg i "$i" '.[] | {issue: $i, createdAt, stageType, outcome, actorAgentId, actorUserId, body: .body[0:80]}'; done |
    jq -s 'sort_by(.createdAt)'
}
```

Fallback when the API is unreachable: the same rows straight from the instance database. `$RUNBOOK_OUT/decisions.sql`, every row in the tree under a root key:
```sql
WITH RECURSIVE tree(id) AS (
  SELECT id FROM issues WHERE identifier = :'root'
  UNION SELECT i.id FROM issues i JOIN tree t ON i.parent_id = t.id
)
SELECT d.created_at, i.identifier, d.stage_type, d.outcome,
       COALESCE(a.name, 'board') AS actor, left(d.body, 80) AS body
FROM issue_execution_decisions d
JOIN issues i ON i.id = d.issue_id
LEFT JOIN agents a ON a.id = d.actor_agent_id
WHERE d.issue_id IN (SELECT id FROM tree)
ORDER BY d.created_at;
```

`$RUNBOOK_OUT/wakes.sql`, every agent wake for an issue in the same tree:
```sql
WITH RECURSIVE tree(id) AS (
  SELECT id FROM issues WHERE identifier = :'root'
  UNION SELECT i.id FROM issues i JOIN tree t ON i.parent_id = t.id
)
SELECT w.created_at, i.identifier, a.name AS agent, w.reason, w.status
FROM agent_wakeup_requests w
JOIN agents a ON a.id = w.agent_id
JOIN issues i ON i.id::text = w.payload->>'issueId'
WHERE i.id IN (SELECT id FROM tree)
ORDER BY w.created_at;
```

Wakes have no list endpoint; save `$RUNBOOK_OUT/wakes.sql` once and run it (and the decisions fallback) with `psql "$PG" -v root=<F key> -f "$RUNBOOK_OUT/wakes.sql"`. Cross-checks through the API:
- `get "/api/issues/$F_ID"`: `status`, `assigneeAgentId`, `assigneeUserId`, and `executionState` (`status` `pending`, `changes_requested` or `held`; `currentStageType`; `currentParticipant`; `returnAssignee`; `lastDecisionOutcome`; `hold` with `reason`, `resumeAt`, `heldBy`).
- `get "/api/issues/$F_ID/activity"`: `issue.execution_policy_attached`, `issue.execution_held`, `issue.execution_hold_resumed`.
- `get "/api/companies/$CID/issues/$F_ID/retro-metrics"`: `totals.decisions`, `totals.bounces` (a bounce is a `changes_requested` row; `held` never is), per-agent counts and `bounceTimeline`.

The wake reasons the scenarios expect: `issue_assigned` (a new assignment), `execution_review_requested` (a review stage became the agent's), `execution_changes_requested` (a stage sent the issue back to its author), `execution_hold_resumed` (a timed hold came due, or the board resumed a hold or a halt), `issue_blockers_resolved` (every blocker of the issue is `done`), `issue_children_completed` (every child of a parked parent is `done`), `issue_commented` (a comment, or the board resolving an interaction card on the agent's issue). A subtask created with open blockers may also give its assignee an `issue_assigned` wake that the agent ends without work; that is not a deviation.

**Capture after every scenario:**
```bash
capture() { # scenario-dir feature-key
  local out="$RUNBOOK_OUT/$1" id; id="$(key_id "$2")"; mkdir -p "$out"
  get "/api/issues/$id" > "$out/issue.json"
  get "/api/issues/$id/activity" > "$out/activity.json"
  get "/api/companies/$CID/issues?descendantOf=$id" > "$out/subtasks.json"
  get "/api/companies/$CID/issues/$id/retro-metrics" > "$out/retro-metrics.json"
  decisions "$id" > "$out/decisions.json"
  psql "$PG" -v root="$2" -f "$RUNBOOK_OUT/wakes.sql" > "$out/wakes.txt"
  ls -lR "$COMPLETION_GATE_EVIDENCE_DIR/$id" "$QA_EVIDENCE_DIR/$id" > "$out/evidence-listing.txt" 2>&1
  (cd "$OP" && gh pr list --state all --json url,headRefName,title) > "$out/prs.json"
}
```

## Reset between scenarios

- Each scenario creates its own new F; nothing is reused or deleted to make room for the next one. The only cancellation is `cancel.json` on an F the scenario itself abandons (10b, or one recorded as not exercised), sent to F and each of its open subtasks.
- Start the next scenario only when the previous F is `done` (or the scenario says it stops earlier) and every agent is idle: standard mode runs one feature at a time.
- After a passing scenario the human may merge its PR; later feature branches are cut from the moved mainline.
- Undo any operator-side change the scenario made (a disabled workflow, a planted defect) the way the scenario's **Undo** line says, by a new commit or setting, never by rewriting history, before the next scenario starts.
- A retro issue `Crew retrospective — <key>` that the server fires during a scenario stays open for Guinan and the human; it does not block the next scenario.

---

## 1. One feature end to end

**Preconditions.** The global ones.

**Setup.** Issue, assigned to Data, no labels, no parent:
- Title: `Home page shows the server status`
- Description:
```
The home page should tell the user whether the server is reachable.

Acceptance criteria:
- GIVEN the server is running, WHEN a user opens the home page, THEN a line under the main heading reads "Server: online". Screenshot required.
- GIVEN the server is stopped, WHEN a user opens the home page, THEN the same line reads "Server: offline" and the page shows no uncaught error. Screenshot required.
- While the status request is in flight, the line reads "Server: checking".
- The server answers GET /api/status with HTTP 200 and the JSON body {"status":"ok"}.

No new dependencies. No sign-in is involved.
```

**Expected sequence.**

| # | Actor | Action | Issue: status / assignee | Decision row | Wake |
| --- | --- | --- | --- | --- | --- |
| 1 | Board | creates F | F: `todo` / Data | none | Data: `issue_assigned` |
| 2 | Data | rewrites F's description (`Branch:` on line 1, criteria, `## Assumptions`), comments a summary and releases in one update, then posts `Task grade (for the retrospective, informational):` | F: `todo` / Riker; activity `issue.execution_policy_attached` | none | Riker: `issue_assigned` |
| 3 | Riker | creates I (`kind:impl`, Geordi) and T (`kind:tests`, Lwaxana Troi, `blockedByIssueIds` = [I]), both carrying F's `Branch:` line; parks F | F: `blocked` on [I, T] / Riker; I and T each get the subtask chain at creation | none | Geordi: `issue_assigned` |
| 4 | Geordi | implements on the feature branch, records `Subtask base:`, runs the definition of done, pushes, hands off with `Branch:`, `Range:` and the evidence | I: `in_review` / Hops | none | Hops: `execution_review_requested` |
| 5 | Hops | `approve`, ending with `Last-reviewed SHA:` and `Confidence Score:` | I: `done` (server) | I: `approved` (review, Hops) | Lwaxana Troi: `issue_blockers_resolved` |
| 6 | Lwaxana Troi | writes the `test-plan` document, the tests, runs them, pushes, hands off with `Coverage:` and `Failing on a product defect: none` | T: `in_review` / Hops | none | Hops: `execution_review_requested` |
| 7 | Hops | `approve` | T: `done` | T: `approved` (review, Hops) | Riker: `issue_children_completed` |
| 8 | Riker | verifies the branch in a detached temporary worktree; submits with `Branch:`, `HEAD:`, the log, the intent-match table and `Changed but never asked` | F: `in_review` / Worf | none | Worf: `execution_review_requested` |
| 9 | Worf | a changed file matches a glob (with the shipped profile, the new endpoint's server file does): full `security-review` pass on the matched files, `approve` | F: `in_review` / Dr Crusher | F: `approved` (review, Worf) | Dr Crusher: `execution_review_requested` |
| 10 | Dr Crusher | five steps; CI still running at step 3 gives a timed `hold` (`QA on hold: CI pending for <sha>`), zero or more times | F: `in_review` / Dr Crusher throughout | F: `held` (review, Dr Crusher) per hold | Dr Crusher: `execution_hold_resumed` per hold |
| 11 | Dr Crusher | CI green, every criterion observed: `approve` | F: `in_review` / Ro Laren | F: `approved` (review, Dr Crusher) | Ro Laren: `execution_review_requested` |
| 12 | Ro Laren | numbered walkthrough, one screenshot per step, network log: `approve` | F: `in_review` / O'Brien | F: `approved` (review, Ro Laren) | O'Brien: `execution_review_requested` |
| 13 | O'Brien | the eight checks; opens the PR with `gh pr create`: `approve` | F: `in_review` / Board (approval stage) | F: `approved` (review, O'Brien) | none: the board's turn; F shows in the dashboard's "Waiting on you" panel as `Approve or reject` |
| 14 | Board | sends `approve.json` | F: `done` | F: `approved` (approval, Board) | none |
| 15 | Human | merges the PR outside Paperclip | unchanged | none | none |

A subtask bounce (Hops `request_changes`) is allowed: it adds `changes_requested` on that subtask, wakes its author with `execution_changes_requested`, and the re-submission is re-reviewed at the same stage. Record it; two bounces in the tree fire the retro routine (scenario 6 describes what that looks like).

**Evidence to capture.** `capture s1 <F key>`. Then:
- `$COMPLETION_GATE_EVIDENCE_DIR/<F id>/`: Ro Laren's screenshots `01-…`, `02-…` and the network log, also attached to F.
- `$QA_EVIDENCE_DIR/<F id>/<sha>/`: Dr Crusher's per-step status files, command outputs, network and console logs, her edge list.
- The PR URL from O'Brien's approve comment, in `$RUNBOOK_OUT/s1/pr.txt`.
- F's comments (`get "/api/issues/$F_ID/comments"`), for Data's task grade, Riker's submission and each verdict.

**Pass criteria.**
- The decision rows are exactly: I `approved`; T `approved`; on F, Worf `approved`, then zero or more Dr Crusher `held`, then Dr Crusher, Ro Laren and O'Brien `approved`, then the board's `approved` with stage type `approval`. Any subtask bounce adds only its own pair of rows.
- The board acted only at steps 1 and 14; nobody set an assignee, a policy or a reviewer by hand.
- Every agent verdict ends with `Last-reviewed SHA:`; Hops' verdicts also carry `Confidence Score:`.
- Both evidence roots hold their files; nothing of Dr Crusher's is under `$COMPLETION_GATE_EVIDENCE_DIR`.
- One branch, one PR, open against the mainline; `retro-metrics` `totals.bounces` matches the `changes_requested` rows (zero on a clean run).

## 2. Worf's short run

**Preconditions.** Scenario 1 passed. Count the globs Worf must report:
```bash
d="$(sed -n '/^```$/,/^```$/p' agents/_shared/security-relevant-paths.md | grep -vc '^```')"
p="$(git -C "$OP" show "origin/$ML:.paperclip-enterprise/profile.md" | awk '/^## Security paths/{f=1;next} /^## /{f=0} f && /^- `/' | wc -l)"
echo "globs: $((d + p))"
```

**Setup.** Issue, assigned to Data, no labels:
- Title: `Footer shows the app version`
- Description:
```
Every page should show the app's version in a footer, so users can tell support which build they run.

Acceptance criteria:
- GIVEN any page, WHEN it renders, THEN a footer line reads "Version <v>", where <v> is the version field of the client package manifest. Screenshot required.
- The footer makes no network request.

Only the client's app shell changes: no new dependency, no server change, no routing or sign-in change.
```

**Expected sequence.** Steps 1 to 8 as in scenario 1. Then:

| # | Actor | Action | Issue: status / assignee | Decision row | Wake |
| --- | --- | --- | --- | --- | --- |
| 9 | Worf | lists the changed files against the glob list; no match, no `security-relevant` label: `approve` in the same run | F: `in_review` / Dr Crusher | F: `approved` (review, Worf), body starting `No security-relevant paths changed. Globs checked: <n>. Files:` | Dr Crusher: `execution_review_requested` |

Steps 10 to 15 as in scenario 1; Ro Laren's walkthrough shows the footer.

**Evidence to capture.** `capture s2 <F key>`; Worf's verdict comment in `$RUNBOOK_OUT/s2/worf.txt`; `git -C "$OP" diff --name-only origin/$ML...origin/<feature branch>` in `$RUNBOOK_OUT/s2/files.txt`; the evidence roots and PR URL as in scenario 1.

**Pass criteria.**
- Worf has exactly one `execution_review_requested` wake and one `approved` row on F, and his comment is the one line `No security-relevant paths changed. Globs checked: <n>. Files: <list>` (plus `Last-reviewed SHA:`), with `<n>` equal to the count above.
- Every file in `files.txt` matches none of those globs (check by hand). If one does (a lockfile, a router file), the scenario was not exercised: record that and repeat it with a narrower ticket.

## 3 and 4. A timed hold that resumes on its own, then an untimed hold resumed by the board

Both scenarios run on one feature, because only one path makes a timed hold certain: when Dr Crusher reaches her CI step, the CI of the subtask pushes has usually finished, so pending CI cannot be relied on. With CI stopped, she finds no run for the hand-off SHA, which gives a timed hold every time (scenario 3); the resumed run still finds none, which gives the untimed hold (scenario 4).

**Preconditions.** Scenario 2 passed. Global precondition 5 (`ci_wait_minutes: 1`) is on the mainline. Both workflows that `## CI` names declare a `workflow_dispatch` trigger on the mainline (check with `git -C "$OP" grep -n workflow_dispatch "origin/$ML" -- .github/workflows`; if not, the human adds it on the mainline first). Then, before creating F, the human stops CI from running, in the operator tree:
```bash
gh workflow disable <fast workflow>
gh workflow disable <full workflow>
```
**Undo:** step 13 below re-enables both; confirm with `gh workflow list` before scenario 5.

**Setup.** Issue, assigned to Data, no labels:
- Title: `Home page shows a welcome message`
- Description:
```
The home page should welcome the user.

Acceptance criteria:
- GIVEN any visitor, WHEN they open the home page, THEN the main heading reads "Welcome". Screenshot required.

No new dependencies.
```

**Expected sequence.** Steps 1 to 9 as in scenario 2 (no CI runs for any push meanwhile; no agent before Dr Crusher reads CI). Then:

| # | Actor | Action | Issue: status / assignee | Decision row | Wake |
| --- | --- | --- | --- | --- | --- |
| 10 | Dr Crusher | steps 1 and 2 pass and are saved; step 3 finds no CI run for the SHA: `hold` with `holdResumeAt` = now + 1 minute, comment `QA on hold: CI pending for <sha>` | F: `in_review` / Dr Crusher (unchanged); `executionState.status` `held`, `hold.resumeAt` set, `hold.heldBy` `participant`; the issue page shows `On hold — … (resumes <time>)` | F: `held` (review, Dr Crusher) | none yet |
| 11 | Server | the timer comes due, with no human action | F: `in_review` / Dr Crusher; `executionState.status` `pending`, same stage, `hold` null; activity `issue.execution_hold_resumed` | none | Dr Crusher: `execution_hold_resumed` |
| 12 | Dr Crusher | resumes at step 3 without re-running steps 1 and 2; still no run for the SHA: untimed `hold`, comment `Operator action needed: CI did not run for <sha>` | F: `in_review` / Board (`assigneeUserId`), no agent assignee; `executionState.status` `held`, `hold.resumeAt` null; the issue page shows `On hold — … (waiting on you)` | F: `held` (review, Dr Crusher) | none |
| 13 | Human | re-enables the workflows and starts both for the feature branch (below), waits until both runs are listed for the SHA | unchanged | none | none |
| 14 | Board | sends `resume.json` | F: `in_review` / Dr Crusher, same stage, `pending`; activity `issue.execution_hold_resumed` | none | Dr Crusher: `execution_hold_resumed` |
| 15 | Dr Crusher | runs still pending: another timed hold and automatic resume as in rows 10 and 11; green: `approve` | F: `in_review` / Ro Laren | F: `held` per further timed hold, then `approved` (review, Dr Crusher) | Dr Crusher: `execution_hold_resumed` per further hold; then Ro Laren: `execution_review_requested` |

Step 13, in the operator tree:
```bash
gh workflow enable <fast workflow>
gh workflow enable <full workflow>
gh workflow run <fast workflow> --ref <feature branch>
gh workflow run <full workflow> --ref <feature branch>
gh run list --branch <feature branch> --commit <sha>
```

Steps 12 to 15 of scenario 1 follow.

**Evidence to capture.** `capture s3-4 <F key>`; `get "/api/issues/$F_ID"` saved three times, during the timed hold (row 10), during the untimed hold (row 12) and after the resume (row 14); both hold comments; the `$QA_EVIDENCE_DIR/<F id>/<sha>/` listing with timestamps (`ls -l --time-style=full-iso`); the `gh run list` output.

**Pass criteria, scenario 3.**
- The first Dr Crusher `held` row on F is followed by an `execution_hold_resumed` wake for her about a minute later (allow for the scheduler's tick), with no human action in between.
- During that timed hold F's assignee stays Dr Crusher: never the board user, never Riker.
- The evidence for her steps 1 and 2 predates the first hold and was not rewritten after a resume.

**Pass criteria, scenario 4.**
- The untimed `held` row is followed by no wake for any agent until the board's resume, and the resume wakes Dr Crusher alone, with `execution_hold_resumed`, at the same stage id as before the hold.
- While untimed-held, F is assigned to the board user and to no agent; after the resume, to Dr Crusher.

**Pass criteria, both.**
- No `changes_requested` row anywhere in the scenario, and `retro-metrics` counts no bounce for any hold; no stage before Dr Crusher's ran again.
- Both workflows are enabled again at the end.

## 5. An operator halt

**Preconditions.** Scenarios 3 and 4 passed. Read the company's halt phrases: `get "/api/companies/$CID/workflow/blueprint" | jq .haltPhrases`; the steps use `merged`.

**Setup.** Issue, assigned to Data, no labels:
- Title: `Home page shows a help link`
- Description:
```
The home page should offer help.

Acceptance criteria:
- GIVEN any visitor, WHEN they open the home page, THEN a link labelled "Help" is visible under the main heading. Screenshot required.
- WHEN the user follows it, THEN a page with the heading "Help" opens. Screenshot required.

No new dependencies.
```

**Expected sequence.** Steps 1 to 9 as in scenario 2. As soon as Worf's `approved` row appears (F `in_review` / Dr Crusher, `pending`):

| # | Actor | Action | Issue: status / assignee | Decision row | Wake |
| --- | --- | --- | --- | --- | --- |
| 10 | Board | comments `I'm not done reviewing` | unchanged, `pending` | none | none required (a plain comment) |
| 11 | Board | comments `merged` (`comment.json`) | F: `in_review` / Board; `executionState.status` `held`, `hold.reason` `merged`, `hold.heldBy` `operator`, `hold.resumeAt` null; a system comment starting `Operator action needed: merged` and saying the review chain halted; activity `issue.execution_held` | F: `held` (review, Board), body `merged` | none |
| 12 | Dr Crusher | a run already in flight: its decision is refused with 422 `execution_held`; any later run reads `held`, posts nothing and exits | unchanged | none | none |
| 13 | Board | waits a few minutes, then sends `resume.json` | F: `in_review` / Dr Crusher, same stage, `pending`, `hold` null; activity `issue.execution_hold_resumed` | none | Dr Crusher: `execution_hold_resumed` |
| 14 | Dr Crusher | continues her stage: `approve` (with timed holds as in scenario 3 if CI is pending) | F: `in_review` / Ro Laren | F: `approved` (review, Dr Crusher) | Ro Laren: `execution_review_requested` |

Steps 12 to 15 of scenario 1 follow.

**Evidence to capture.** `capture s5 <F key>`; `get "/api/issues/$F_ID"` saved while halted and after the resume; F's comments (the system halt comment); the wakes between the halt and the resume.

**Pass criteria.**
- Step 10 changed nothing: a comment that only contains a halt word does not halt.
- The halt wrote exactly one row, `held` by the board user with body `merged`, and no agent was woken by it.
- No agent decision row and no agent comment on F between the halt and the resume.
- The resume returned F to the same stage and participant, and the chain then finished normally.

## 6. A feature-level request_changes producing a fix subtask through Riker

**Preconditions.** Scenario 5 passed. The finding is produced on purpose: O'Brien's gate treats a feature branch that is behind its base as a finding.

**Setup.** Issue, assigned to Data, no labels:
- Title: `Home page shows a contact address`
- Description:
```
The home page should show where to write for support.

Acceptance criteria:
- GIVEN any visitor, WHEN they open the home page, THEN the line "Contact: support@example.com" is visible under the main heading. Screenshot required.

No new dependencies.
```
Then, once Riker has submitted F (F `in_review` / Worf) and before O'Brien's stage starts, the human moves the mainline by one commit that touches no file of the feature, in the operator tree on the mainline:
```bash
git -C "$OP" switch "$ML" && git -C "$OP" merge --ff-only "origin/$ML"
echo "Acceptance run note." >> "$OP/README.md"
git -C "$OP" commit -am "docs: acceptance run note"
git -C "$OP" push origin "$ML"
```
**Undo:** none needed; the note is harmless and stays on the mainline.

**Expected sequence.** Steps 1 to 12 as in scenario 1 (Worf's depth follows his gate). Then:

| # | Actor | Action | Issue: status / assignee | Decision row | Wake |
| --- | --- | --- | --- | --- | --- |
| 13 | O'Brien | check 4 finds the branch behind its base: `request_changes` naming the refs and "merge the base in" | F: `in_progress` / Riker; `executionState.status` `changes_requested`, `returnAssignee` Riker | F: `changes_requested` (review, O'Brien) | Riker: `execution_changes_requested` |
| 14 | Riker | creates one X (`kind:impl`, Geordi, F's `Branch:` line, the finding quoted verbatim, acceptance "each item is fixed or declined with a one-line technical rationale"); parks F | F: `blocked` on [X] / Riker; X gets the subtask chain | none | Geordi: `issue_assigned` |
| 15 | Geordi | merges the base into the feature branch, re-runs the definition of done, pushes, hands off with `Fixed:` | X: `in_review` / Hops | none | Hops: `execution_review_requested` |
| 16 | Hops | `approve` | X: `done` | X: `approved` (review, Hops) | Riker: `issue_children_completed` (or `issue_blockers_resolved`) |
| 17 | Riker | Verify and submit again; the submission adds `Fixed:` and `Declined:` from X and the new `HEAD:` | F: `in_review` / O'Brien (the stage that asked) | none | O'Brien: `execution_review_requested` |
| 18 | O'Brien | the branch is reconciled: `approve`, PR updated | F: `in_review` / Board (approval stage) | F: `approved` (review, O'Brien) | none |
| 19 | Board | sends `approve.json` | F: `done` | F: `approved` (approval, Board) | none |

If the tree's `changes_requested` count reaches the blueprint's bounce threshold (2) with this bounce, the server also fires the retro routine once: a new issue `Crew retrospective — <F key>` assigned to Guinan, with `satisfactionScore` `unscored (auto: bounce_threshold)`. That is expected and not part of this scenario's pass.

**Evidence to capture.** `capture s6 <F key>`; O'Brien's two verdict comments; Riker's re-submission comment; X's hand-off; the retro issue's key, if one was fired.

**Pass criteria.**
- Exactly one fix subtask was created, by Riker, assigned to Geordi, labelled `kind:impl`, carrying F's `Branch:` line and O'Brien's finding verbatim.
- The finding went to Riker (`execution_changes_requested` on F), never to Geordi on F and never forward to the board.
- After the bounce, Worf, Dr Crusher and Ro Laren have no new row and no new wake on F: the chain resumed at O'Brien.
- `retro-metrics` shows the bounce: `totals.bounces` at least 1 and O'Brien's `changesRequestedIssued` 1.

## 7. A test-exposed defect producing a fix subtask

**Preconditions.** Scenario 6 passed. The human plants a product defect on the mainline, in existing code the feature will rely on: a helper that nothing calls yet, correct for every day except the last day of a month (where it returns 1 instead of 0). In the operator tree:
```bash
git -C "$OP" switch "$ML" && git -C "$OP" merge --ff-only "origin/$ML"
mkdir -p "$OP/client/src/utils"
cat > "$OP/client/src/utils/daysUntilEndOfMonth.ts" <<'TS'
export function daysUntilEndOfMonth(date: Date): number {
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const left = lastDay - date.getDate();
  return left === 0 ? 1 : left;
}
TS
git -C "$OP" add client/src/utils/daysUntilEndOfMonth.ts
git -C "$OP" commit -m "feat: add a days-until-end-of-month helper"
git -C "$OP" push origin "$ML"
git -C "$OP" rev-parse HEAD > "$RUNBOOK_OUT/s7/plant.sha"
```
The commit message stays neutral so it does not point an agent at the defect; the defect is the `left === 0 ? 1 : left` line.

**Undo:** when the scenario ends, the human merges F's PR (Geordi's fix then reaches the mainline). If the PR is not merged, or the scenario was not exercised, revert the plant on the mainline: `git -C "$OP" revert --no-edit "$(cat "$RUNBOOK_OUT/s7/plant.sha")" && git -C "$OP" push origin "$ML"`. Check: `git -C "$OP" show "origin/$ML:client/src/utils/daysUntilEndOfMonth.ts"` no longer returns 1 on the last day (or the file is gone).

**Setup.** Issue, assigned to Data, no labels:
- Title: `Home page shows the days left in the month`
- Description:
```
The home page should tell the user how many days are left in the current month, using the existing date helper for it.

Acceptance criteria:
- GIVEN any day, WHEN a user opens the home page, THEN a line under the main heading reads "Days left this month: <n>". Screenshot required.

No new dependencies.
```
The ticket names no edge case on purpose: Lwaxana Troi derives her own edge list.

**Expected sequence.** Steps 1 to 5 as in scenario 1. Then:

| # | Actor | Action | Issue: status / assignee | Decision row | Wake |
| --- | --- | --- | --- | --- | --- |
| 6 | Lwaxana Troi | her last-day-of-month case fails on the product: posts `Defect found:` on F (test name, output, root cause with `file:line`), keeps the test unchanged, hands off T with `Failing on a product defect: <test>` | T: `in_review` / Hops | none | Hops: `execution_review_requested` |
| 7 | Hops | reviews the test's correctness, not its outcome: `approve` | T: `done` | T: `approved` (review, Hops) | Riker: `issue_children_completed` |
| 8 | Riker | finds the `Defect found:` entry: creates X (`kind:impl`, Geordi, the entry quoted verbatim, acceptance "the named test passes, unchanged"), comments `Fix for Defect found: <test> is <X key>`, parks F; does not submit | F: `blocked` on [X] / Riker | none | Geordi: `issue_assigned` |
| 9 | Geordi | fixes the helper, regression covered by the named test, hands off | X: `in_review` / Hops | none | Hops: `execution_review_requested` |
| 10 | Hops | `approve` | X: `done` | X: `approved` (review, Hops) | Riker: `issue_children_completed` (or `issue_blockers_resolved`) |
| 11 | Riker | every `Defect found:` entry has a `done` fix: Verify and submit | F: `in_review` / Worf | none | Worf: `execution_review_requested` |

Steps 9 to 15 of scenario 1 follow.

**Evidence to capture.** `capture s7 <F key>`; the `Defect found:` comment; Riker's `Fix for Defect found:` comment; `git -C "$OP" diff <T head>..origin/<feature branch> -- <test file>` (from T's `Range:` line) in `$RUNBOOK_OUT/s7/test-diff.txt`.

**Pass criteria.**
- One `Defect found:` comment, posted once, and one fix subtask for it.
- No `changes_requested` row arises from the defect: it is not a bounce.
- `test-diff.txt` is empty: the failing test was never weakened.
- F was submitted only after X was `done`.
- If Geordi's own tests caught and fixed the defect before T started, the scenario was not exercised: record that, undo the plant, plant a different boundary defect and repeat it.
- The Undo line was carried out: the mainline helper is correct or absent.

## 8. A bug's kind:repro subtask gating its fix

**Preconditions.** Scenario 7 passed and its Undo is done. The human plants a visible defect on the mainline: the home page's counter button raises the count by two. In the operator tree:
```bash
git -C "$OP" switch "$ML" && git -C "$OP" merge --ff-only "origin/$ML"
sed -i 's/@click="count++"/@click="count += 2"/' "$OP/client/src/components/HelloWorld.vue"
git -C "$OP" diff --stat    # exactly one line changed in HelloWorld.vue
git -C "$OP" commit -am "refactor: counter button handler"
git -C "$OP" push origin "$ML"
git -C "$OP" rev-parse HEAD > "$RUNBOOK_OUT/s8/plant.sha"
```

**Undo:** when the scenario ends, the human merges F's PR. If it is not merged, revert the plant: `git -C "$OP" revert --no-edit "$(cat "$RUNBOOK_OUT/s8/plant.sha")" && git -C "$OP" push origin "$ML"`. Check: `git -C "$OP" show "origin/$ML:client/src/components/HelloWorld.vue" | grep -F 'count += 2'` prints nothing.

**Setup.** Issue, assigned to Data, no labels:
- Title: `Counter goes up by two per click`
- Description:
```
Bug: on the home page, each click on the counter button raises the count by two. It should raise it by one.

Expected: one click shows 1, two clicks show 2.
Actual: one click shows 2.
```

**Expected sequence.**

| # | Actor | Action | Issue: status / assignee | Decision row | Wake |
| --- | --- | --- | --- | --- | --- |
| 1 | Board | creates F | F: `todo` / Data | none | Data: `issue_assigned` |
| 2 | Data | establishes the repro from the report and the code; writes the ticket with severity; releases | F: `todo` / Riker; chain attached | none | Riker: `issue_assigned` |
| 3 | Riker | creates R (`kind:repro`, Ro Laren) and X (`kind:impl`, Geordi, `blockedByIssueIds` = [R], acceptance includes "the posted repro, which failed before this change, now passes"); parks F | F: `blocked` on its children / Riker; R has no chain (`executionPolicy` null) | none | Ro Laren: `issue_assigned` |
| 4 | Ro Laren | reproduces in the real app, writes the numbered script, saves evidence that it fails now, posts `Reproduction steps` on R and on F, sets R `done` | R: `done` / Ro Laren | none (R has no stage) | Geordi: `issue_blockers_resolved` |
| 5 | Geordi | uses the script as his failing case, writes a regression test that fails before the fix, fixes, hands off | X: `in_review` / Hops | none | Hops: `execution_review_requested` |
| 6 | Hops | `approve` | X: `done` | X: `approved` (review, Hops) | without T: Riker: `issue_children_completed`; with T (below): Lwaxana Troi: `issue_blockers_resolved` |
| 7 | Riker | Verify and submit | F: `in_review` / Worf | none | Worf: `execution_review_requested` |
| 8 | Worf, Dr Crusher, Ro Laren, O'Brien, Board | the feature chain as in scenario 1, steps 9 to 14; Ro Laren's visual stage follows the repro script literally and shows it now passes | F: `done` | F: one `approved` per stage (plus any `held`) | as in scenario 1 |

Riker's file asks for one `kind:tests` subtask per feature and does not exempt bugs, so both variants pass. **Without T:** the rows above as written. **With T** (`blockedByIssueIds` = [X], assigned to Lwaxana Troi at step 3): Hops' approval of X at step 6 wakes Lwaxana Troi with `issue_blockers_resolved`, not Riker; T then runs as in scenario 1, steps 6 and 7 (T `approved` by Hops), and Hops' approval of T wakes Riker with `issue_children_completed` before step 7 here.

**Evidence to capture.** `capture s8 <F key>`; `$COMPLETION_GATE_EVIDENCE_DIR/<R id>/` (the failing-now evidence) and `$COMPLETION_GATE_EVIDENCE_DIR/<F id>/` (the passing walkthrough); the `Reproduction steps` comment on R and on F; R's completion time from its activity, and the start of Geordi's first run on X:
```bash
get "/api/issues/<X id>/runs" > "$RUNBOOK_OUT/s8/x-runs.json"
```

**Pass criteria.**
- R has no decision row and no review chain; its status changes are Ro Laren's own: her checkout to `in_progress` (if she checks it out) and her `done`. No other agent changes R's status.
- Geordi's first run on X started after R was `done`.
- The same `Reproduction steps` comment is on R and on F, with literal values and expected versus actual.
- The Undo line was carried out: the mainline counter raises the count by one.
- Ro Laren's visual-stage walkthrough on F follows the repro script's numbered steps and shows the fixed behavior.

## 9. Provisioning re-run: nothing changes

**Preconditions.** Scenarios 1 to 8 are finished. The remote branch `onboarding/<throwaway>` still exists. Nobody edited the company's review chains, halt phrases or retro settings in the UI since provisioning (otherwise the re-run resets them to the template and prints `updated blueprint`).

**Setup.** No issue. Snapshot, re-run with exactly the first run's arguments, snapshot again:
```bash
# Fields that move on their own (heartbeats, routine triggers) are dropped before comparing;
# a real update shows in the re-run's own `updated` lines.
VOLATILE='walk(if type == "object" then del(.lastHeartbeatAt, .lastTriggeredAt, .lastEnqueuedAt, .lastFiredAt, .nextRunAt, .updatedAt) else . end)'
snap() { # dir
  mkdir -p "$1"
  for p in agents labels routines projects skills workflow/blueprint; do
    get "/api/companies/$CID/$p" | jq -S "$VOLATILE" > "$1/$(echo "$p" | tr / -).json"
  done
  get "/api/companies/$CID/issues?limit=1000" | jq 'length' > "$1/issue-count.txt"
  sha256sum "$Y" "clients/$CLIENT/agent-env" > "$1/files.sha256"
}
snap "$RUNBOOK_OUT/s9/before"
date -u +%Y-%m-%dT%H:%M:%SZ > "$RUNBOOK_OUT/s9/start.txt"
scripts/new-client --name "$CLIENT" --repo <the same remote> <the same options> | tee "$RUNBOOK_OUT/s9/rerun.txt"
snap "$RUNBOOK_OUT/s9/after"
```

**Expected sequence.**

| # | Actor | Action | Result | Decision row | Wake |
| --- | --- | --- | --- | --- | --- |
| 1 | Human | runs `scripts/new-client` again | each numbered step prints `exists …`, `ok …`, `resolved …` or `unchanged <agent>`, and the hook check passes; exit 0 | none | none |
| 2 | Human | compares the snapshots | `before` and `after` identical | none | none |

**Evidence to capture.** `rerun.txt`; the two snapshot directories; `diff -r "$RUNBOOK_OUT/s9/before" "$RUNBOOK_OUT/s9/after"` in `$RUNBOOK_OUT/s9/diff.txt`; every agent wake since the re-run started, in `$RUNBOOK_OUT/s9/wakes.txt`:
```bash
psql "$PG" -v since="$(cat "$RUNBOOK_OUT/s9/start.txt")" -v cid="$CID" > "$RUNBOOK_OUT/s9/wakes.txt" <<'SQL'
SELECT w.created_at, a.name, w.reason
FROM agent_wakeup_requests w JOIN agents a ON a.id = w.agent_id
WHERE a.company_id::text = :'cid' AND w.created_at >= :'since'
ORDER BY w.created_at;
SQL
```

**Pass criteria.**
- `grep -E '^(created|updated|started) ' rerun.txt` prints nothing, and the exit status is 0.
- `diff.txt` is empty: same agents (eleven), labels, routines, project, skills, blueprint and issue count; `client.yaml` and `agent-env` unchanged.
- No new issue titled `Onboard <throwaway>`, and `wakes.txt` lists no row: the re-run woke no agent.

## 10. The handoff card in the waiting-on-you panel

Two cards: one on a top-level issue, one on a subtask. Neither is inside a review stage, so neither writes a decision row.

**Preconditions.** Scenario 9 passed. Scenario 8's Undo is done, so the mainline counter raises the count by one; check it with `git -C "$OP" show "origin/$ML:client/src/components/HelloWorld.vue" | grep -F 'count++'`, which must print the button line. The board user has the company dashboard open: the "Waiting on you" panel is on it, a table with the columns Ticket, Request, Requested by, Requested and Action, listing open interaction cards and tickets handed to the board for review.

### 10a. A card on the top-level issue

**Setup.** Issue, assigned to Data, no labels:
- Title: `Home page shows today's date`
- Description:
```
The home page must show today's date only in the user's local format.
The home page must never show a date in the user's local format: show dates in ISO format only, so they match the logs.
```
The two behaviours conflict outright: no ticket satisfies both, and which one is right changes what gets built. That is the intent ambiguity Data escalates rather than logs as an assumption.

**Expected sequence.**

| # | Actor | Action | Issue: status / assignee | Decision row | Wake |
| --- | --- | --- | --- | --- | --- |
| 1 | Board | creates F | F: `todo` / Data | none | Data: `issue_assigned` |
| 2 | Data | parks: an `ask_user_questions` card on F (`continuationPolicy: "wake_assignee"`), numbered questions with options and a recommendation, and one comment starting `Board decision needed:` | F: `todo` / Data (unchanged); `executionPolicy` null (never left intake) | none | none |
| 3 | Board | sees the card in the panel (below), opens the ticket and answers | unchanged | none | Data: `issue_commented` |
| 4 | Data | folds the answers into the criteria, re-runs the gate, releases | F: `todo` / Riker | none | Riker: `issue_assigned` |

In the panel the card is one row: Ticket shows F's key and title; Request shows the card's title; Requested by shows Data; Action is a `Submit answers` button that opens the ticket (questions are answered on the ticket, not inline). After step 4 the feature runs as in scenario 1 from step 3; let it finish before 10b.

### 10b. A card on a subtask

**Setup.** No defect is planted (see the preconditions). Issue, assigned to Data, no labels:
- Title: `Counter resets to zero after ten clicks`
- Description:
```
Bug: on the home page, the counter goes back to 0 on the eleventh click. It should keep counting.

Expected: eleven clicks show 11.
Actual: eleven clicks show 0.
```

**Expected sequence.**

| # | Actor | Action | Issue: status / assignee | Decision row | Wake |
| --- | --- | --- | --- | --- | --- |
| 1 to 3 | Board, Data, Riker | as in scenario 8, steps 1 to 3 | F: `blocked` / Riker; R and X created | none | Ro Laren: `issue_assigned` |
| 4 | Ro Laren | cannot reproduce after driving the real app: posts `Not reproduced` with what she tried and saw, on R and on F; sets R `done` | R: `done` | none | Geordi: `issue_blockers_resolved` |
| 5 | Geordi | writes no fix; raises a card on X (`continuationPolicy: "wake_assignee"`) and one comment starting `Board decision needed:` on X and on F, naming X and quoting what was tried | X: unchanged status / Geordi; F: `blocked` / Riker (unchanged) | none | none |
| 6 | Board | sees the subtask card in the panel (below) and resolves it, choosing "not a bug" | unchanged | none | Geordi: `issue_commented` |
| 7 | Geordi | **unspecified**: his file does not say what he does on an `issue_commented` wake for a resolved card (an amendment is pending separately); record what he did, do not judge it | not judged | not judged | not judged |
| 8 | Board | once Geordi's run has ended, sends `cancel.json` to X, to R if still open, and to F: not a bug (a disposition of this scenario, not a reset step) | F and X: `cancelled` | none | none |

In the panel the subtask card is one row whose Ticket cell shows the subtask X's key and title, not the feature's; Request shows the card's prompt; Requested by shows Geordi. A `request_confirmation` card resolves inline with its accept and reject buttons (`Confirm` and `Decline` unless the card names its own labels); an `ask_user_questions` card shows `Submit answers`, which opens X. The `Board decision needed:` comment is on F as well, so the board sees it from the feature too.

Closing a bug after work started is a retro signal: the server may fire `Crew retrospective — <F key>` with `satisfactionScore` `unscored (auto: <signal>)`. That is expected.

**Evidence to capture (10a and 10b).** `capture s10a <F key>` and `capture s10b <F key>`; `get "/api/companies/$CID/pending-human-input"` saved while each card is open; `get "/api/issues/<id>/interactions"` for F (10a) and X (10b); a screenshot of the panel with each card visible; the `Board decision needed:` comments.

**Pass criteria.**
- Each card is on the agent's own issue (F for Data, X for Geordi), with `continuationPolicy` `wake_assignee`, and the matching `Board decision needed:` comment exists (on X and on F for the subtask card).
- No status or assignee changed for a card: F stayed `todo` / Data in 10a; in 10b, up to the board's resolution, X stayed assigned to Geordi with no status change beyond his own checkout to `in_progress`, and F stayed `blocked` / Riker. Nothing went `in_review` or `blocked` for the handoff.
- 10b passes on rows 1 to 6 and 8; Geordi's behaviour in row 7 is recorded, not a pass criterion.
- Each card appeared in the panel as described and resolving it woke the card's issue assignee.
- No decision row on any issue for either card.
