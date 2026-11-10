# Profile contract (shared rule for all agents)

**Why:** the agent files are the same for every client. Everything stack-specific lives in the client's own files, so an agent never guesses a command or carries one client's habits into another's.

## The client files
Read them from the fleet tree at the start of every run:
- `$PRODUCT_FLEET_TREE/.paperclip-enterprise/profile.md`: the stack profile (commands, workspaces, services, CI, branching, limits).
- `$PRODUCT_FLEET_TREE/.paperclip-enterprise/client.md`: client facts (the product, its users, its deployment model).
- `CLAUDE.md` in the working tree: the client's own house rules.

If `profile.md` is missing, or a row you need is absent, do not improvise: report it through `_shared/board-decision-handoff.md` (or `hold` inside a stage) naming the missing row.

## Precedence
**Universal rules (`_shared/` and your own agent file) > client `CLAUDE.md` > profile.** A client rule can tighten the profile; nothing overrides a universal rule (the mainline rule, the review loop, the handoff).

## Commands are quoted, never inlined
Every stack command comes from the profile's `## Commands` table, by row name, exactly as written. Row names agents quote:
- `build`, `typecheck`, `lint`
- `static-lint`: rule check on changed files only, formatter disabled (the code reviewer's row)
- `unit:<workspace>`: one per workspace in `## Workspaces`
- `integration`, `e2e`

Each row also states `cost` (`fast` or `slow`) and `ci` (`yes` or `no`); scope with `_shared/scoped-test-selection.md`. Report a command by its row name and the exact text you ran.

## Other sections agents read
- `## Security paths`: globs appended to `_shared/security-relevant-paths.md`.
- `## Branching`: `mainline:` (the branch agents never touch, matching `$GIT_GUARD_MAINLINE`) and `scheme:` (how feature branches are named); see `_shared/self-driving-branch-model.md`.
- `## Limits`: `ci_wait_minutes` (how far ahead a `hold` on pending CI sets `holdResumeAt`) and `qa_run_minutes` (the QA run's time budget).
- `## CI`: workflow names, or `none`.
