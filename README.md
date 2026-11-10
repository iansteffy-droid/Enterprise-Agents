# Paperclip Enterprise

A white-label kit: an agent team plus a copy of the Paperclip control plane, provisioned once per client.

## Layers

1. **Agent team** - instruction files for each role, written client-neutral.
2. **Paperclip control plane** - the orchestration service the agents run under, run as a local instance.
3. **Client provisioning** - scripts that stamp out a per-client workspace under `clients/` (git-ignored).

## Quickstart (ten minutes)

In this order, from the kit root:

```bash
(cd paperclip && pnpm install)                  # the control plane's dependencies
mkdir -p "$HOME/.paperclip-enterprise/lint"     # then copy your private banned-terms.txt and
                                                # banned-patterns.txt into it (see Instruction linter)
CLAUDE_CONFIG_DIR="$HOME/.claude-paperclip-enterprise" claude login   # the agents' subscription login
scripts/install-git-hooks.sh                    # once per checkout: the pre-commit hook
scripts/paperclip-instance.sh start
scripts/new-client --name <client> --repo <git url>   # see scripts/new-client --help
```

## Instruction linter

Run `scripts/install-git-hooks.sh` once; then every commit runs `scripts/lint-instructions.sh` (plus `scripts/validate-templates.sh` and `scripts/validate-profile.sh` on each stack profile). It keeps client-specific names, ids and routing shortcuts out of the kit. Test it with `bash scripts/lint/test_lint_instructions.sh`.

The banned-term lists are private and the kit ships none. Install them once per machine: copy your `banned-terms.txt` (one term per line, matched case-insensitively) and `banned-patterns.txt` (one extended regex per line, case-sensitive) into `$HOME/.paperclip-enterprise/lint/`, or point `LINT_BANNED_TERMS_DIR` at the directory that holds them. Without both files the linter exits 2 with `banned-term lists not installed`. The tests write their own neutral list and never read yours.
