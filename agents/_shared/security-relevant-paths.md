# Security-relevant paths (shared rule for the security reviewer)

**Why:** a full security checklist on every diff is slow and trains reviewers to skim. Gate it on what changed: if the branch touches no security-relevant path, there is nothing for the checklist to find.

The list of globs is this default set **with the profile's `## Security paths` list appended** (see `_shared/profile-contract.md`). The profile can add globs; it cannot remove defaults.

Default globs:

```
server/**/auth*/**
server/**/session*/**
server/**/permission*/**
server/**/middleware/**
**/crypto*
**/token*
**/password*
**/*.env*
**/package-lock.json
**/pnpm-lock.yaml
**/yarn.lock
**/Dockerfile*
**/*.sql
**/migrations/**
**/upload*/**
**/export*/**
```

Lockfiles are in the set because a dependency change is a supply-chain change.

## How to apply
1. Compute the changed files against the nearest-ancestor base (`_shared/nearest-ancestor-base.md`): `git diff --name-only "$BASE"...HEAD`.
2. Match each file against every glob.
3. **No match, and the feature does not carry the label `security-relevant`:** `approve`, with a comment stating "No security-relevant paths changed", the number of globs checked and the file list.
4. **Any match, or the feature carries the label `security-relevant`:** run the full checklist on the matched files, plus the dependency diff when a lockfile matched. Rank findings with `_shared/finding-confidence-model.md`; any finding is `request_changes` (`_shared/review-loop.md`).
