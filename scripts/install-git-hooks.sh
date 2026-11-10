#!/usr/bin/env bash
# Usage: scripts/install-git-hooks.sh
# Installs the kit's pre-commit hook into this checkout's git hooks directory. The hook runs
# scripts/lint-instructions.sh, scripts/validate-templates.sh and scripts/validate-profile.sh
# on every stack profile (profiles/*.md except README.md and _template.md). Idempotent: a
# re-run rewrites the kit's own hook; a foreign pre-commit hook is left alone (exit 1).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS="$(git -C "$ROOT" rev-parse --path-format=absolute --git-path hooks)"
MARK="# paperclip-enterprise pre-commit (scripts/install-git-hooks.sh)"
DEST="$HOOKS/pre-commit"
if [ -e "$DEST" ] && ! grep -qxF "$MARK" "$DEST"; then
  echo "install-git-hooks: $DEST exists and is not the kit's hook; leaving it alone." >&2
  echo "Remove it (or merge it by hand) and re-run." >&2
  exit 1
fi
mkdir -p "$HOOKS"
tmp="$(mktemp "$HOOKS/.pre-commit.XXXXXX")"
cat > "$tmp" <<HOOK
#!/usr/bin/env bash
$MARK
set -uo pipefail
cd "\$(git rev-parse --show-toplevel)" || exit 1
scripts/lint-instructions.sh || { echo "pre-commit: scripts/lint-instructions.sh failed" >&2; exit 1; }
scripts/validate-templates.sh >/dev/null || { scripts/validate-templates.sh; echo "pre-commit: scripts/validate-templates.sh failed" >&2; exit 1; }
for f in profiles/*.md; do
  case "\$(basename "\$f")" in README.md|_*) continue ;; esac
  scripts/validate-profile.sh "\$f" >/dev/null || { scripts/validate-profile.sh "\$f"; echo "pre-commit: \$f is not a valid profile" >&2; exit 1; }
done
exit 0
HOOK
chmod +x "$tmp"
if [ -e "$DEST" ] && cmp -s "$tmp" "$DEST"; then
  rm -f "$tmp"; echo "pre-commit hook already installed: $DEST"
else
  mv "$tmp" "$DEST"; echo "pre-commit hook installed: $DEST"
fi
