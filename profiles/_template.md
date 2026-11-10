# Profile: <name>

<one line: what stack this profile describes>

## Stack
<one line per workspace: framework, language, test runner>

## Workspaces
<one line per workspace: name and purpose; build order if any>

## Commands
Quote rows by step name. `cost` is `fast` or `slow`. `ci` says whether CI runs the row: `yes` means a workflow named in `## CI` runs this row on every push (fast rows via the fast workflow, slow rows via the full workflow); `no` means no workflow runs it. Required rows: build, typecheck, lint, static-lint, format-policy, unit:<workspace> (one per workspace), integration, e2e.

| step | command | cost | ci |
| --- | --- | --- | --- |
| build | <command> | <fast or slow> | <yes or no> |
| typecheck | <command> | <fast or slow> | <yes or no> |
| lint | <command> | <fast or slow> | <yes or no> |
| static-lint | <rule check on changed files only, formatter disabled> | <fast or slow> | <yes or no> |
| format-policy | <policy text, e.g. lint errors gate; formatter out of scope> | <fast or slow> | <yes or no> |
| unit:<workspace> | <command> | <fast or slow> | <yes or no> |
| integration | <command> | <fast or slow> | <yes or no> |
| e2e | <command> | <fast or slow> | <yes or no> |

static-lint: <how its changed-files placeholder is filled>

Prerequisites, one line per slow row: <row: services, ports, builds it needs>

## Services
<each service a tier needs: start command, port, teardown; or "none">

## Test conventions
<spec file suffixes, where tests live, scoping rules>

## House rules
<stack-level coding rules the implementer must satisfy>

## Security paths
<globs appended to agents/_shared/security-relevant-paths.md>

## Identifier contracts
<optional: identifiers whose format must never change; delete this section if none>

## Dev data policy
<which data stores agents may write to, and how test data is created>

## CI
<workflow file names and which rows each runs, or "none">

## Branching
- mainline: <branch agents never touch>
- scheme: <feature branch naming, e.g. feat/<issue-key>-<slug>>

## Scaffold
<optional: commands the onboarder runs on an empty repository; delete this section if none>

## Limits
- ci_wait_minutes: <integer>
- qa_run_minutes: <integer>
