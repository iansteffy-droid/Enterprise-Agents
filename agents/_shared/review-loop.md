# Review loop (shared contract for the author and every reviewer)

**Why:** one mechanism moves work between author and reviewers: the server. It attaches the company's review chain itself (to a subtask at creation, by its `kind:` label; to a top-level issue when it leaves intake), so no agent ever sets a policy, names a reviewer or changes an assignee. Every finding goes back to its author, so nothing unresolved is passed forward.

## Author: hand-off
Set the issue to `in_review` with one comment: what changed, the definition-of-done evidence, how to verify, and the HEAD SHA. The server sends it to the current stage. You never mark your own issue `done`.

## Reviewer: three verbs
Each verdict is one update of the issue carrying a `comment` and an `executionDecision`, and never a `status` field: the server derives the status from the decision.
- `approve`: the stage passes; the server moves the issue to the next stage or completes it.
- `request_changes`: **any finding at any severity**, listed one per item. There is no "minor, approve anyway".
- `hold`: the stage cannot decide yet (CI pending, the operator needed). Add `holdResumeAt` (an ISO timestamp) to be woken again at that time; an untimed hold hands the issue to the board user with a comment starting `Operator action needed:`.

A reviewer never cancels the issue or marks it `blocked` mid-stage.

## Author: answering request_changes
You are woken with `PAPERCLIP_WAKE_REASON=execution_changes_requested` (treat `issue_commented` on an `in_progress` issue assigned to you the same way). Exception: when `PAPERCLIP_WAKE_PAYLOAD_JSON` carries an `interactionId`, the wake is a resolved interaction card, not a review: read the card's answer (`GET /api/issues/{id}/interactions`, the one with that id) and resume the work that asked, with the decision applied. Only an `issue_commented` wake without an `interactionId` is a review comment. For **every** item in the latest reviewer comment, either fix and commit it, or list it under `Declined:` with a one-line technical rationale. Re-submit with the same hand-off plus `Fixed:` and `Declined:` lists and the new HEAD SHA.

## Re-review
Re-review is **incremental, at the same stage**: check the fixes and the rationale for each declined item, plus anything the new commits touched. A declined item whose rationale holds is not raised again. A reviewer who disagrees may answer one decline once, with a counter-argument, through `request_changes`. If the author declines again, the reviewer approves and records the item under `Disputed:` for the operator. There is no third round.

## Operator halt
A board user's comment whose first line is one of the company's configured halt phrases holds the chain: the issue's `executionState.status` becomes `held`. Read that state, never the comment text: while it is `held`, post nothing and exit; do not resume, re-submit or re-review; wait for the operator.

## Forbidden for everyone in the loop
Setting `assigneeAgentId` or `assigneeUserId`, mentioning an agent to summon it, setting an execution policy, and marking your own issue `done`. Waiting on the operator outside a stage is an interaction card, not an assignee change (`_shared/board-decision-handoff.md`).
