---
name: debugging-playbook
description: Method for reproducing, isolating and root-causing a failure, a flaky test or a "nothing loads" symptom before guessing at a code fix, plus the environmental false-bug patterns to rule out first. Use when a failure needs a root cause or a bug ticket needs a repro.
---

# Debugging playbook

Method first: reproduce, isolate, root-cause, hand over the minimal fix. Commands come from the profile by row name (`_shared/profile-contract.md`); tiers from `testing`.

## 1. Rule out the environment first
These steps are for the author or debugger. A reviewer in a review stage never runs them (no `build`, `lint` or `typecheck` rows); a reviewer who suspects an environmental cause says so as a finding.

Many failures look like code bugs and are not. Check before editing code:
- **Stale build:** a dependent workspace built before its upstream changed gives phantom type or runtime errors. Rebuild with the profile's `build` row, then retry.
- **Services:** a required service (the profile's `## Services`) not running, on the wrong port, or left over from an earlier run. Check the port and the process.
- **Unreachable dependency:** a required external system that is down, unreachable or resolving to the wrong place makes everything that depends on it fail at once. Check that it is reachable from where the run happens before touching code or configuration.
- **Output filtering:** a command wrapper that reformats output can hide or misreport a result. Re-run the command raw and compare.
- **Tool versions:** runtime or toolchain version differing from the profile's `## Stack`.
Say explicitly when the cause is environmental so no one "fixes" working code.

## 2. Reproduce
Get a numbered, minimal procedure that fails every time, with the exact command and its captured output. If it fails only sometimes, find what varies: ordering, timing, shared state, parallel workers sharing a data store, time or randomness. A test that passes only on retry is flaky, which is a real finding, not a pass.

## 3. Isolate
Run the smallest scope that still fails (`_shared/scoped-test-selection.md`). Bisect by commit or by input. Read each failing case's own error and artifacts; several failures are usually several causes. A test unchanged from the base that now fails is catching a real regression: do not weaken it.

## 4. Root-cause
Find the file and line where behavior first diverges from intent. Suspect swallowed errors: when a failure is impossible to diagnose, add logging of status, code and body before mapping the error, and the cause often becomes obvious. State the cause as one sentence you could be proven wrong on.

## 5. Hand over
Deliver: the exact reproduction command, the root cause (`file:line`), the minimal diff, and a regression test at the lowest tier that proves it. Reproduction evidence is pasted, not described.
