# Operator handoff: the operator must see that it is their move

**Rule:** whenever work cannot continue until the board user (the human operator) decides, confirms, answers, or runs something with their own hands (a git command in their own checkout, a Paperclip UI edit, a credential, network access), you raise **an interaction card and one comment on your own issue**, saying exactly what they must do; if your issue is a subtask, the same comment also goes on the top-level issue the operator watches. Without that comment where the operator looks, or with a `blocked` status instead, the operator sees an agent that stopped for no reason.

This applies to every agent.

## Before you hand off
1. **Exhaust the agent path first.** Everything that does not need the operator is done, committed and pushed in the same run.
2. **Never substitute a different action in the operator's space.** If the needed step is forbidden by git-guard or by your rules (moving the HEAD of the operator's checkout `$PRODUCT_OPERATOR_TREE`, touching the mainline `$GIT_GUARD_MAINLINE`), it is the operator's to run. Doing "something the guard happens to allow" instead is worse than waiting.

## How to hand off
1. **The card goes on the issue you are assigned to**, so the board's answer wakes you (`wake_assignee`). The top-level issue is the one whose `parentId` is `null` (walk `parentId` up); when you own a subtask, the comment in step 3 goes there as well, naming your subtask.
2. **Create the interaction card:** `POST /api/issues/{id}/interactions` with `kind`, optional `title` and `summary`, `continuationPolicy: "wake_assignee"` (set it explicitly: `request_confirmation` defaults to `none`), and a `payload` with `version: 1`:
   - decision or confirmation: `kind: "request_confirmation"`, payload `prompt`, optional `acceptLabel`, `rejectLabel`, `detailsMarkdown`;
   - question: `kind: "ask_user_questions"`, payload `questions` (each `id`, `prompt`, `selectionMode` `single` or `multi`, `options`);
   - manual step: `kind: "request_checkbox_confirmation"`, payload `prompt` and `options` (each `id`, `label`), the literal command or click as the option; the tick is the operator saying it is done.
   When the board resolves the card (accept, reject, answer), you, as the issue's assignee, are woken.
3. **Post one comment** on your issue (and on the top-level issue, if yours is a subtask) that starts with **`Board decision needed:`** (decision or question) or **`Operator action needed:`** (manual step), then the single question or the exact command or click, the options, and what you do next in each case.
4. **Leave status and assignee as they are** on every issue. Never set `in_review` for a handoff: under server-attached chains `in_review` means "submit to the review chain" and would start a stage. Never mark anything `blocked` for it.

**Inside a review stage, use `hold` instead.** A stage participant who needs the operator sends the `hold` verb and never changes the assignee; an untimed hold hands the issue to the board user itself, with a comment starting `Operator action needed:`.

## `blocked` means exactly one thing
`blocked` = waiting on **another issue** (`blockedByIssueIds`). Parking a parent as `blocked` on its subtasks is correct. An issue waiting on the operator is never `blocked`; it is the handoff above.
