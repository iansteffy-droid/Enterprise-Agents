---
name: review-learnings-sync
description: Refresh the code reviewer's local mirror of the review tool's learned rules for a client repository, harvested from the review bot's pull-request comments and accumulated without duplicates. Use only from the scheduled routine, never during a review, and only when the repository uses a review tool with learnings.
---

# Review learnings sync (accumulate)

A repository's review rules live in three places. Two are in git and the reviewer reads them live (the review-tool config such as `.coderabbit.yaml`, and the guideline files). The third, the review tool's cloud learnings, is not in the repo and may have no public API. This skill mirrors those learnings into a local notes file so the reviewer applies them without a network call.

If the repository has no review-tool config or the tool exposes no learnings, report "nothing to sync" and stop.

**The source of truth stays the tool.** The notes file is a read-only mirror for the reviewer. Never edit the review config, the dashboard or the working tree; only read, and write the one notes file.

## What learnings look like
The review bot (its login ends in `[bot]`) posts them in pull-request comments in two shapes: a collapsible "Learnings added" when it captures one, and a "Learnings used" collapsible listing the entries it applied, each with the author, pull request, file and line range, timestamp and the rule text. Harvest both; they are the same rule. The file line, when present, is the scope; the free text is the rule.

## Procedure (daily, incremental)
1. **Window.** `TODAY=$(date -u +%F)`. Read `Last synced:` from the notes header and start the window 3 days before it (`date -u -d "$LAST_SYNCED - 3 days" +%F`); the overlap absorbs time skew and late edits. If the file is missing, unparseable or `never`, use 30 days. The window bounds what you look at, never what you keep.
2. **Candidate pull requests:** list the repository's pull requests updated since the window start, all states, through the GitHub tooling (`gh` or the connected server).
3. **Read the bot's comments** (issue and review comments) on each; skip every other author.
4. **Extract** each learning: `text` (the rule, whitespace-normalized), `scope` (the file path or glob, else `repo`), `src` (the pull request).
5. **Dedupe and accumulate.** Each entry line carries a stable key `<!--k:HASH-->`, the first 10 hex of a hash of the lowercased, whitespace-collapsed text. Known key: refresh its `seen:` date and add a new `src` if different. New key: append. Never delete entries; the only prune is, above 200 entries, dropping the oldest `seen:` dates down to 200 and noting the count in the changelog.
6. **Rewrite** the notes file keeping the header verbatim, entries grouped by scope (repo-wide first, then paths alphabetically), one per line:
   `- <!--k:HASH--> **[scope]** <rule text>  _(src: <repo>#N, seen: YYYY-MM-DD)_`
   Update `Last synced:`, `PRs scanned:` and the window, and append `- YYYY-MM-DD: +X new, Y refreshed, Z total`.
7. **Report** in the routine's comment: pull requests scanned, new, refreshed and total entries, and the file path. If GitHub access fails, say so and leave the file untouched; a failed sync never wipes accumulated learnings.

## Guardrails
- Accumulate, never reset: a run with zero new learnings succeeds and leaves the file intact.
- Never run inside a code review, so reviews stay fast and a harvest failure cannot block one.
- The mirror can lag by about a day and only holds learnings the bot surfaced in comments, not the whole dashboard; the file header says so, so the reviewer does not overtrust its completeness.
