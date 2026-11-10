---
name: testing
description: Testing conventions and test-review heuristics for any web repository. Tiers, file placement, runners and fixtures come from the profile's Test conventions; this skill holds the plan-to-write handoff, the quality bar and the mocking rules. Use when planning, writing or reviewing tests, deciding which tier a test belongs to, or judging whether a delivered test suite is adequate.
---

# Testing and test review

Read the profile's `## Test conventions`, `## Workspaces` and `## Commands` (`_shared/profile-contract.md`) and the client `CLAUDE.md` before acting. The profile says which tiers exist, where tests live, what they are named and how they run. This skill says what a good test is.

## Tier rule
Prove each behavior at the lowest tier that can prove it. Reserve the integration tier for persistence and wiring, the browser tier for user-facing or cross-service flows. Use the exact placement and naming of the tier, confirmed against a neighboring test; never invent a new convention.

## Conventions
- Fixtures come from the repository's factories or helpers. Do not hand-build data when a helper exists; add one if it does not.
- Validators and pure functions are tested directly with valid and invalid inputs.
- Where the stack has an integration tier, its tests exercise the real dependencies the profile's `## Services` lists rather than mocks of them.
- Mocking: external HTTP and third-party services are stubbed; time and randomness are stubbed, never wall-clock. Never mock the thing under test.
- Placement: tests live in their own files, never inside a production file.
- Run commands by profile row name (`unit:<workspace>`, `integration`, `e2e`), scoped with `_shared/scoped-test-selection.md`.

## Quality bar (writing and reviewing)
- Assertions are specific and meaningful (an exact value, not "truthy"). No test without an assertion.
- Coverage of the change: every public function, endpoint or component has a test; success and error paths; edge cases (null, empty, boundary values) and the hardening cases in the profile's `## House rules` (injection, mass assignment, input sanitizing).
- Isolation: no order dependence or shared mutable state, external dependencies stubbed, not flaky in CI.
- Structure: names that explain intent, table-driven tests over copy-paste, correct setup and teardown.

## Priority
- **Critical** (tested before merge): core business logic, authentication and authorization, anything that mutates user data or has side effects.
- **High:** error and rejection branches, public API changes, the hardening guards.
- **Optional:** rare edges, performance paths, scenarios a higher tier already covers.

## Plan to write handoff
The planner writes the coverage plan; the writer implements it. A plan item is accurate only when it carries all of:
1. **Target:** source file and symbol, endpoint or component.
2. **Test file:** exact path and naming for the tier, existing or to create.
3. **Tier and command:** the profile row that runs it.
4. **Cases:** each with its priority and the precise input and expected outcome.
5. **Fixtures and mocking:** which helper to use or add, and the stub strategy.
6. **Assertions:** the concrete ones expected.

The writer implements exactly that, runs the named row, reports pass or fail with the output, and asks before deviating. The planner then checks the delivered suite against the plan and lists any remaining Critical or High gaps. A suite that leaves a Critical path untested is not done.

## Review pass
1. Map the diff against the base (`_shared/nearest-ancestor-base.md`); split source from test files and find each source file's test. A source file with no test is a finding.
2. Read each test in full and judge it against the quality bar.
3. List gaps by priority.
4. Report:
```
### Test Review Report
Overall Test Health: N/10
File coverage: source file | test file | tier | ok / partial / missing
Critical gaps: path:symbol, what is untested and why
Quality issues: test name, the problem and the fix
Recommended additions: 2-3 concrete example tests for the top gaps
```
Never bless a suite that leaves a Critical path untested.

## A failing test is not weakened
- A test that fails on the branch but is unchanged from the base is catching a real regression: fix the application, never weaken, skip or delete the test. Check with `git diff "$BASE" -- <test file>`; an empty diff means the app changed.
- "N failures" is usually several distinct root causes. Read each failing test's own error and artifacts before generalizing.
