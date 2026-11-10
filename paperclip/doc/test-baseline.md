# Test baseline

Recorded 2026-11-09 on the imported tree; runner and full-suite counts updated 2026-11-10. Verification for later tasks: `pnpm -r typecheck` is green and `pnpm test:run` has no failures beyond the eight listed here.

`pnpm test:run` (`scripts/run-vitest-stable.mjs`) runs every group and every project even when one fails: general-server, general-workspaces-a (ui, cli), general-workspaces-b (every package and adapter project of the root `vitest.config.ts`) and the 106 serialized route suites one by one. It ends with a combined summary (per-group counts and every failed test by name) and exits non-zero if anything failed. Before 2026-11-10 it stopped at the first failing invocation, so only general-server ever ran.

Full run on the dev machine, 2026-11-10 (about 22 minutes): general-server 2135 passed / 4 failed / 1 skipped; general-workspaces-a 2191 passed / 2 failed; general-workspaces-b 713 passed / 2 failed; serialized 1145 passed / 0 failed. Total 6184 passed, 8 failed, 1 skipped. The 8 are exactly sections 1 to 5 below.

## Typecheck

Green. Two pre-existing failures were fixed by adding `avatarAssetId: null` and `avatarUrl: null` (the `Agent` shape in `packages/shared/src/types/agent.ts:90-91`) to the Agent fixtures in:

- `packages/plugins/plugin-llm-wiki/tests/plugin.spec.ts` (`wikiMaintainerAgent`)
- `cli/src/__tests__/secrets.test.ts`

## Test failures (8: 4 environment-dependent, 4 pre-existing upstream test drift; none caused by the kit)

General-server, 2026-11-09: 4 failed, 1974 passed, 1 skipped (234 files). No test was skipped, weakened or deleted.

The original baseline had 24 failures; 20 were in `server/src/__tests__/claude-local-execute.test.ts` and were test drift, not environment: the fork added a subscription preflight gate (`packages/adapters/claude-local/src/server/execute.ts:459`, `preflight.ts:88`) that blocks runs without OAuth credentials when `ANTHROPIC_API_KEY` is unset. The file's `describe("claude execute")` block now sets a dummy `ANTHROPIC_API_KEY` in `beforeEach` (restored in `afterEach`); the file passes 22/22 with no key in the environment. The gate has its own tests in `packages/adapters/claude-local/src/server/preflight.test.ts`.

Verification status of the documented setups: the workspace-runtime setup below was run and passes 68/68. The cursor setup (system `node` in `/usr/local/bin`) was NOT run because it needs root; only the mechanism was reproduced.

### 1. `server/src/__tests__/cursor-local-execute.test.ts` (2 failures)

- `cursor execute > prefers ~/.local/bin/cursor-agent for remote sandbox execution when using the default command` (line 371)
- `cursor execute > keeps explicit command overrides for remote sandbox execution` (line 437)

### 2. `server/src/__tests__/cursor-local-adapter-environment.test.ts` (1 failure)

- `cursor environment diagnostics > prefers ~/.local/bin/cursor-agent for remote sandbox probes when using the default command` (line 219)

Cause (both files): the fake cursor agents are `#!/usr/bin/env node` scripts (`writeFakeSandboxCursorAgent`, `writeFakeCursorAgentCommand`) run through a sandbox runner with `env: input.env ?? {}`. The adapter then fills in `PATH` from `defaultPathForPlatform()` = `/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin` (`packages/adapter-utils/src/server-utils.ts:1834-1839`, applied by `ensurePathInEnv`, line 1968). `node` on this machine lives only in `~/.volta/bin`, so the shebang fails: `env: 'node': No such file or directory`, exit 127 (captured in the run output and the `cursor_version_probe_failed` check).

Class: environment-dependent (node installed outside the default sandbox PATH).

Setup that makes them pass: a real `node` binary in one of the default PATH directories, e.g. `sudo ln -s "$(volta which node | xargs readlink -f)" /usr/local/bin/node` (or install node through the system package manager). Then:

```
pnpm --filter @paperclipai/server exec vitest run src/__tests__/cursor-local-execute.test.ts src/__tests__/cursor-local-adapter-environment.test.ts
```

Not run with the fix applied (needs root to write `/usr/local/bin`); the mechanism was verified by running `env -i PATH=<default path> /usr/bin/env node -v`, which fails with the same message. CI hosts with a system node (the usual case) are unaffected.

### 3. `server/src/__tests__/workspace-runtime.test.ts` (1 failure)

- `workspace runtime startup reconciliation > does not reuse a stopped auto-port service port while another process owns it` (line 3545)

Cause: the test spawns `$SHELL -lc "node -e '<http server>'"` and asserts the PID listening on the stale port (found with `lsof`) equals the spawned shell PID (`staleProcess.pid`, lines 3392 and 3545), which holds only if the shell `exec`s node in place. Here `node` resolves to the Volta shim (`~/.volta/bin/node` -> `volta-shim`), which stays resident as the parent of the real node process, so the listener's PID is the child's (`expected 787155 to be 787095`). Additionally `~/.profile` re-prepends `~/.volta/bin` for every login shell, so putting a real node first on the test's PATH alone is not enough.

Class: environment-dependent (Volta shim plus login-shell PATH rewrite).

Command that makes it pass (verified, 68/68): put the real node binary first on PATH and use a login-less shell wrapper that execs bash directly:

```
N=$(ls -d ~/.volta/tools/image/node/*/bin | tail -1)      # real node, not the shim
T=$(mktemp -d); ln -s "$N/node" "$T/node"
printf '#!/bin/sh\nexec /bin/bash --noprofile --norc -c "$2"\n' > "$T/nologin-sh"; chmod +x "$T/nologin-sh"
SHELL="$T/nologin-sh" PATH="$T:$PATH" pnpm --filter @paperclipai/server exec vitest run src/__tests__/workspace-runtime.test.ts
```

On a host with a system node and no profile that rewrites PATH, the test passes unmodified.

### 4. `ui/src/pages/OrgChart.test.tsx` (2 failures, general-workspaces-a)

Present before the kit's UI settings work and unchanged by it (re-run 2026-11-10; only the import commit has touched the org chart):

- `OrgChart mobile gestures > pans the chart with one-finger touch drag` (line 210; `expected 'translate(50px, 65px) scale(1)' to be 'translate(50px, 105px) scale(1)'`)
- `OrgChart mobile gestures > pinch-zooms toward the touch center` (line 248)

Class: pre-existing upstream test drift, deterministic on every host (not environment). Command that reproduces: `pnpm exec vitest run --project @paperclipai/ui ui/src/pages/OrgChart.test.tsx`. No setup makes it pass; it needs an upstream fix of the gesture handler or its expectations.

### 5. Sandbox restore in two adapter projects (2 failures, general-workspaces-b)

- `packages/adapters/cursor-local/src/server/execute.test.ts > cursor execute > reruns sandbox command resolution after managed runtime setup and keeps the original sandbox home`
- `packages/adapters/gemini-local/src/server/execute.remote.test.ts > gemini remote execution > pre-selects gemini-api-key auth in the managed HOME for sandbox execution`

Cause: `packages/adapter-utils/src/command-managed-runtime.ts` `readFile` first asks the remote for the file size (`wc -c < <file>`) and throws `Could not determine remote file size` when the answer is not a number. Both tests' fake sandbox runners answer every `sh` command with empty stdout, so the workspace restore after the run fails. Returning a size alone is not enough (the restore then untars an empty archive and fails on `tar -xf`); the fakes would need to serve a real workspace tarball. Both fail identically at the kit's base commit `13cb570` and were never run before the runner change.

Class: pre-existing upstream test drift, deterministic (not environment). Command that reproduces: `pnpm exec vitest run --project @paperclipai/adapter-cursor-local --project @paperclipai/adapter-gemini-local`.

## Serialized route suites fixed on 2026-11-10

Once the runner ran them, 6 route suites failed deterministically at `13cb570`, and 6 more failed only under load. None of these failures came from the kit's code:
- `environment-selection-route-guards`, `issue-assigned-backlog-contract-routes`, `issue-agent-mutation-ownership-routes`: the fork's issue-create route reads `select().from(projects).where().limit()` (`companyHasAnyProject`); the tests' db stubs had no `select`/`limit`. Each stub now answers "no projects".
- `issue-activity-events-routes`: the fork rejects a policy naming a participant who can never be woken; the test's `agentService.getById` returned null. It now returns an idle agent of the company.
- `openapi-routes`: the spec lacked the kit's routes; they are now documented.
- First-test timeouts at the 5 s default (cold import of the issue routes, and load from embedded Postgres): `issue-agent-mutation-ownership-routes`, `issue-assigned-backlog-contract-routes`, `permissions-upgrade-boundary-routes`, `agent-cross-tenant-authz-routes`, `document-annotation-routes`, `external-object-routes`, `issue-dependency-wakeups-routes`, `issue-feedback-routes`, `issue-update-comment-wakeup-routes` now set `vi.setConfig({ testTimeout: 30_000 })`. Under host load (load average around 10 while agent runs were active) other route suites hit the same 5 s default, so the runner also passes `--testTimeout=30000` to every serialized suite.

Stale compiled tests: `packages/db/dist/*.test.js` (a `tsc` build without `dist/migrations`) used to run and fail. Every project config without an `include` now excludes `**/dist/**`. The server config sets no exclude, because a config exclude replaces the runner's CLI `--exclude` list; the runner passes `**/dist/**` there instead.

## Notes

- Embedded-Postgres tests in this file ran (they were not skipped on the dev machine).
- Full-suite command: `pnpm test:run` (all groups and serialized suites).
