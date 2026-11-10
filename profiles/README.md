# Stack profiles

A profile tells the agents how a client's stack is built, tested and secured. Agents quote its `## Commands` rows by step name and never inline a command. Provisioning copies the chosen profile into the client repository as `.paperclip-enterprise/profile.md`; the onboarder then runs each command and re-tags its `cost` by measured duration.

## Pick a profile
List the files here (everything except `_template.md` and this README) and choose the one matching the client stack:

    new-client --profile vue-nest-mongo

If none fits, write one (below). The default is `vue-nest-mongo.md`: Vue 3 client, NestJS + Mongoose server, shared TypeScript package, Cucumber + Puppeteer e2e, MongoDB.

## Write a profile in an hour
1. Copy `_template.md` to `profiles/<stack-name>.md`; keep every heading, delete only the optional `## Identifier contracts` and `## Scaffold` if unused.
2. Fill `## Stack` and `## Workspaces` from the repository layout.
3. Fill the `## Commands` table. Each row needs a real command (not empty, not `<placeholder>`), `cost` (`fast` or `slow`) and `ci` (`yes` or `no`). `ci` says whether CI runs the row: `yes` means a workflow named in `## CI` runs this row on every push (fast rows via the fast workflow, slow rows via the full workflow); `no` means no workflow runs it. Under the table, state the prerequisites of each slow row. Required rows: `build`, `typecheck`, `lint`, `static-lint` (rule check on changed files, formatter disabled), `format-policy` (policy text in the command cell), one `unit:<workspace>` per workspace, `integration`, `e2e`. Keep cells free of the `|` character.
4. Fill `## Services` (start command, port and teardown per service), `## Test conventions`, `## House rules`, `## Security paths`, `## Dev data policy`, `## CI`.
5. Set `## Branching` (`mainline:`, `scheme:`) and `## Limits` (`ci_wait_minutes`, `qa_run_minutes`, integers).
6. Check it:

        scripts/validate-profile.sh profiles/<stack-name>.md

   Exit 0 means every required heading, row and value is present; otherwise the first problem is printed.

Keep client names, product names and identifiers out of profiles: they describe a stack, not a client. Client facts live in `client.md`, client rules in the client's `CLAUDE.md`.
