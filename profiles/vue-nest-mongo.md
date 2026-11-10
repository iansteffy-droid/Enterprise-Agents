# Profile: vue-nest-mongo

A Vue 3 client, a NestJS + Mongoose server, a shared TypeScript package and a Cucumber + Puppeteer e2e suite, in one npm workspaces repository.

## Stack
- `client`: Vue 3 (Composition API, `<script setup>`), a Vue component library, Pinia for state, Vite; tests with Vitest and `@vue/test-utils`.
- `server`: NestJS, Mongoose, RxJS; tests with Jest, ts-jest and supertest.
- `shared`: TypeScript package used by client and server; built first.
- `e2e`: Cucumber.js with Puppeteer.
- Database: MongoDB (replica set not required).

## Workspaces
- `client`: the web app.
- `server`: the API.
- `shared`: shared types and validators; run its `build` before client or server typecheck and tests.
- `e2e`: browser scenarios against a running client and server.

## Commands
Agents quote a row by its step name and run the command cell exactly as written. `cost` is `fast` or `slow` (the onboarder re-tags it by measured duration). `ci` says whether CI runs the row: `yes` means a workflow named in `## CI` runs this row on every push (fast rows via the fast workflow, slow rows via the full workflow); `no` means no workflow runs it.

| step | command | cost | ci |
| --- | --- | --- | --- |
| build | `npm run build --prefix shared` | fast | yes |
| typecheck | `npm run typecheck --prefix client && npm run typecheck --prefix server` | fast | yes |
| lint | `npm run lint --prefix client && npm run lint --prefix server` | fast | yes |
| static-lint | `npx eslint --rule '{"prettier/prettier":"off"}' <changed .ts/.js/.vue files>` | fast | yes |
| format-policy | lint errors gate; formatter is out of scope | fast | no |
| unit:client | `npm run test:unit --prefix client` | fast | yes |
| unit:server | `npm run test:unit --prefix server` | fast | yes |
| unit:shared | `npm run test:unit --prefix shared` | fast | yes |
| integration | `npm run test:integration --prefix server` | slow | yes |
| e2e | `npm run test:e2e --prefix e2e` | slow | yes |

`static-lint`: `<changed files>` is filled with the changed-file list from the nearest-ancestor diff (`_shared/nearest-ancestor-base.md`), filtered to `.ts`, `.js` and `.vue`.

Prerequisites (a tier whose prerequisite is not running is unverified, not passed):
- integration: MongoDB on 27017; `shared` built.
- e2e: `shared` built; server on 3000; client on 5173; MongoDB on 27017.

## Services
Start each service before the tier that needs it and stop it afterwards.
- MongoDB, port 27017 (integration, e2e). Start: `docker run -d --name test-mongo -p 27017:27017 mongo:7`. Teardown: `docker rm -f test-mongo`.
- server, port 3000 (e2e). Start: `npm run start --prefix server`. Teardown: stop that process.
- client, port 5173 (e2e). Start: `npm run dev --prefix client`. Teardown: stop that process.
- Build `shared` first (`build` row) for integration and e2e.

## Test conventions
- Unit specs: `*.spec.ts`, next to the code under test.
- Integration specs: `*.e2e-spec.ts` in the server, run with Jest against a real MongoDB.
- Browser scenarios: Cucumber `.feature` files in the `e2e` workspace.
- Tests never live inside a production file.
- Run only the tests related to the changed files while iterating (`_shared/scoped-test-selection.md`); run the full tier when shared code changed.

## House rules
- One type per concept; no duplicated DTO types for the same thing.
- Type Mongoose queries with `FilterQuery<T>`.
- Whitelist request fields; guard query parameters against NoSQL operator injection.
- Prefer a `*.service.ts` over manipulating a model in a controller.
- Declare root-level variables at the top of a Vue `<script setup>` block.
- No global (unscoped) styles in Vue components.

## Security paths
Appended to `agents/_shared/security-relevant-paths.md`:
- `server/src/**/auth/**`
- `server/src/**/*.guard.ts`
- `server/src/**/*.controller.ts`
- `server/src/**/*.schema.ts`
- `client/src/router/**`
- `client/src/stores/**/auth*`

## Identifier contracts
- None recorded for the stack; onboarding fills this from the client's code (or deletes the section).

## Dev data policy
- Agents never write to any database or data store except ones named `test-*`.
- Test data is created through the running app's API or UI, never by writing to the store directly.

## CI
- `ci.yml`: every push; runs the `ci: yes` rows with cost `fast` (build, typecheck, lint, static-lint, unit:client, unit:server, unit:shared).
- `ci-full.yml`: every push; runs the `ci: yes` rows with cost `slow` (integration, e2e), with MongoDB, server and client started as listed in `## Services`.

## Branching
- mainline: master
- scheme: feat/<issue-key>-<slug>

## Scaffold
Used by the onboarder on an empty repository:
- `npm create vite@latest client -- --template vue-ts`
- `npx @nestjs/cli new server --package-manager npm`
- a root `package.json` declaring the workspaces `client`, `server`, `shared`, `e2e`
- `.github/workflows/ci.yml` (fast tiers on every push) and `.github/workflows/ci-full.yml` (slow tiers)

## Limits
- ci_wait_minutes: 10
- qa_run_minutes: 60
