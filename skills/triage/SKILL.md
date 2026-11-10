---
name: triage
description: Turn issues, feature requests and bug reports into well-formed tickets with a definition of done, risk-aware severity and correct workspace routing. Use when triaging incoming requests, scoping or prioritizing work, or writing a ticket for the team.
---

# Triage and ticketing

Ground yourself in the client `CLAUDE.md` and the profile (`## Workspaces`, `## House rules`). Clarify gaps with `intake-clarification` before releasing.

## A good ticket carries
1. **Goal and target user:** who benefits and the problem solved.
2. **Workspaces touched:** route to the lowest workspace that owns the behavior; shared types to the shared workspace, API and persistence to the server, UI to the client.
3. **Acceptance criteria:** concrete, testable bullets stating what is observably true when done.
4. **Definition of done:** the checklist from the client rules and profile: the profile's `build`, `typecheck`, `lint` and the tier rows for each affected workspace, tests for the change, docs updated where the client requires.
5. **Risk and data class:** does it touch personal data, authentication, payments or other regulated data? If so, mark it for security review and apply the compliance notes under the profile's `## House rules`.
6. **Repro (bugs):** exact steps, expected versus actual, environment. Rule out environmental causes first (`debugging-playbook`) so noise is not filed as a code bug.

## Severity
- **Critical:** data loss or corruption, authentication or authorization bypass, payment errors, anything that blocks the core workflow. Fast-track.
- **High:** error paths, public API changes, regressions in core flows, the security hardening guards.
- **Medium or Low:** UX polish, rare edges, performance, cosmetic.

## Subtask kinds
Slice work with the kind labels the dispatcher uses: `kind:impl`, `kind:tests`, `kind:repro`. A bug ticket gets its repro first and the fix blocked by it. Express real dependencies as blockers, never free text. The server attaches the review chain; never name reviewers in a ticket.

## Conventions to state in the ticket
- Commit messages follow the repository's convention (Conventional Commits unless `CLAUDE.md` says otherwise).
- Branch naming follows the profile's `## Branching` `scheme:`; state the branch explicitly.
- Link related tickets with the issue-prefix link style, and set the parent for delegated subtasks.
