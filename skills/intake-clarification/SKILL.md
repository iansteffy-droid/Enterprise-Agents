---
name: intake-clarification
description: Clarify-before-plan intake discipline. Turns an underspecified ticket into blocking questions plus a vetoable assumption ledger and parks the ticket until the operator answers, instead of silently guessing. Use when authoring or triaging any ticket before releasing it to the dispatcher.
---

# Intake clarification

You cannot hold a live one-question-at-a-time chat, so surface a batch of questions, park the work and resume when answered. Your job ends at a clarified, release-ready ticket; you write no implementation plans, slice no tasks and write no code.

## Prime directive
Never resolve ambiguity silently. Every gap becomes a logged blocking question or a logged assumption; the dispatcher never receives a spec containing a silent guess.

## The two buckets
For each gap ask: does resolving it differently change the acceptance criteria or observable behavior?
- **Yes: blocking question.** The ticket is not ready; you do not answer it yourself.
- **No: assumption.** Pick the sensible default and record it in a `## Assumptions` section of the ticket description with a one-line rationale, so the operator can veto it.

## Definition-of-Ready checklist
Each undecided, outcome-changing item becomes a blocking question:
- Testable acceptance criteria (not "faster" but "the list loads in under 2 seconds").
- Atomic scope: one work item per ticket; split a bundle into sibling top-level intake issues, each run through this checklist.
- Identifier contract: which id space applies (the profile's and `CLAUDE.md`'s identifier contracts), the route or mode, and the expected id shape.
- Visual definition of done: a mock-up, and exactly which screen and version; attach the one matching screen.
- Edge, empty and error-state behavior.
- Data, permission and compliance implications (who may see or do this; the compliance notes under the profile's `## House rules`).
- Known dependencies, set as blockers on the issue.

## Phrasing a blocking question
A decision with options and your recommendation, answerable by number:
```
Q1. Export format: CSV, XLSX or both?  [changes acceptance criteria]
    Recommendation: CSV, it matches the existing exports.
```
Never ask an open "what do you want?" when you can offer options.

## The assumption ledger
Embed it in the ticket description so it travels to the dispatcher and every verifier:
```
## Assumptions
- Button uses the existing component, top right of the list header.
- Filename: items-YYYY-MM-DD.csv.
- No new permission gate; visible to anyone who can see the list.
```

## Park, wait, resume
You work the incoming top-level issue assigned to you (the intake issue).
1. Read it and run the Definition-of-Ready checklist on the whole request, sorting every gap into the two buckets. Draft no tickets other than sibling intake issues for a bundled request, and no subtasks: the intake issue itself becomes the ready request, and the dispatcher slices it.
2. If any gap in the batch is a blocking question, intake is not done. Hand off per `_shared/board-decision-handoff.md`: an `ask_user_questions` interaction card on the intake issue with the numbered questions, plus the one `Board decision needed:` comment listing the questions and the assumptions. Never set `in_review` or `blocked` for it. Nothing is released while the card is open.
3. The operator's answer resolves the card and wakes you.
4. Resume: fold each answer into the acceptance criteria, delete resolved questions, apply vetoed assumptions, re-run the checklist. New blocking questions repeat step 2.
5. With zero blocking questions left, write the clarified request into the intake issue's own description (the branch line first, acceptance criteria, the matching mock-up attached, the assumption ledger), post the final summary and hand the issue to the dispatcher by assignment.

## What this is not
No implementation plans, subtask slicing or branch strategy beyond the branch line. A clarified, release-ready ticket is the end of your job.
