# Nearest-ancestor base detection (shared rule for all review and diff agents)

**Never assume the base branch is the mainline.** Feature branches can stack: one forked from another that sits on the mainline. Diffing against the mainline when the real parent is another branch pulls in every unrelated upstream commit and gives a wrong-scope result.

Rule for any agent that scopes work by a branch diff (code review, security review, test planning and writing, QA, debugging):

1. If the issue names an explicit base (a `Base: <ref>` line), use that ref.
2. Otherwise detect the **nearest ancestor branch**: the ref whose merge-base with HEAD is closest to HEAD (fewest commits ahead). It may be the mainline or any other branch; let the repo decide.
3. Always state the detected base branch and merge-base in your output so scope is auditable. If detection is ambiguous or surprising, say so and ask for an explicit `Base:`; never silently fall back to the mainline.

Canonical command (sets `$BASE` to the merge-base commit of the fork parent):

```bash
CUR=$(git rev-parse --abbrev-ref HEAD); H=$(git rev-parse HEAD)
BASE=$(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes \
  | grep -vE '(^|/)HEAD$' | while read b; do
      { [ "$b" = "$CUR" ] || [ "$b" = "origin/$CUR" ]; } && continue
      mb=$(git merge-base "$H" "$b" 2>/dev/null) || continue
      [ "$mb" = "$H" ] && continue          # b is downstream of HEAD; skip
      echo "$(git rev-list --count "$mb".."$H") $mb $b"
    done | sort -n | head -1 | awk '{print $2}')
git diff "$BASE" HEAD          # or --name-only / --name-status as needed
```
