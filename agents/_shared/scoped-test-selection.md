# Scoped test selection (shared rule for test-running agents)

**Why:** running the entire suite on every task is slow, and the slow tiers (`integration`, `e2e`) dominate the wall clock. A change confined to one workspace cannot break another workspace's unit tests, so run the tiers the branch actually touched. This rule changes **only which test tiers run**, never the acceptance rigor, the lint and build steps, or the honesty bar. Each agent's file says which mode it uses.

**Prerequisite:** compute the diff scope.

```bash
# $BASE = nearest-ancestor merge-base, per _shared/nearest-ancestor-base.md
CHANGED=$(git diff --name-only "$BASE" HEAD)
```

Workspaces, their paths and their test rows come from the profile (`## Workspaces`, `## Commands`); see `_shared/profile-contract.md`. A workspace the profile marks as shared (built into others) counts as "everything affected". So do root manifests, lockfiles, root compiler config and CI config.

## Mode A: tier level (the QA gate)
Run the **full tier** for every workspace the branch touched; skip the tiers of workspaces it did not touch. Never run a subset of a touched tier, so the gate stays honest.
- Map each path in `$CHANGED` to its workspace. A shared or global change selects every workspace.
- Nothing mapped to any workspace (an unclassified change): scope cannot be proven, so run everything.
- Always run the profile's `build` row first when other workspaces compile against a shared one.
- For each selected workspace: its `lint` and `unit:<workspace>` rows, plus `integration` when that workspace has one. Slow rows (`cost: slow`) follow the agent's own rule; the QA gate leaves CI-covered slow rows to CI.

## Mode B: file level (implementers: developer, test writer)
Run only the tests **related to the files you changed**; the gate runs the full touched tier as the backstop, so a fast inner loop here is safe.
- Use the runner's related-files mode as the profile's `## Test conventions` describes, invoked through the workspace's own runner so its config still applies.
- **Widen to the full tier** when shared code changed, or when related selection returns nothing although source in that workspace changed.

## Always (both modes)
- **Report what you ran, what you skipped, and why** (for example: "only workspace `web` changed: skipped `unit:api` and `integration`"). An unrun tier must be visible in the hand-off; no silent skipping.
- If `$BASE` or the diff detection fails or is surprising, fall back to the full run and say so. Speed never comes at the cost of an unproven skip.
