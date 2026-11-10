#!/usr/bin/env python3
"""git-guard: let Paperclip agents drive the coding chain on a feature branch.

Wired as a PreToolUse(Bash) hook through hooks/claude-settings.json. Enforced only
inside Paperclip agent runs (PAPERCLIP_AGENT_ID set); human sessions pass through.

Environment read (all optional):
- PRODUCT_OPERATOR_TREE        colon-separated working trees whose HEAD an agent may
                               never move (switch/checkout blocked there).
- PRODUCT_FLEET_TREE           colon-separated fleet working trees; a `git commit` on a
                               detached HEAD there is blocked (switch to your branch).
- GIT_GUARD_MAINLINE           comma list of mainline branch names, default
                               "master,main". Never committed to, merged into,
                               rebased, reset, created, switched to or pushed.
- GIT_GUARD_PUSH_ALLOW         comma list of branch globs (fnmatch). When set, a push
                               to any branch not matching is blocked.
- GIT_GUARD_FORCE_PUSH_ALLOW   "1" permits --force/--force-with-lease pushes to a
                               non-mainline branch, plus `git rebase` (non-mainline,
                               non-interactive) and `git worktree add <dir> <branch>`
                               (a worktree that locks a branch): the
                               prepare-for-merge capability set.

Policy:
- ALLOW read-only inspection, patch apply/restore, and `git fetch` for every agent.
- ALLOW the local commit flow (add, commit, stash, mv, rm) unless on a mainline.
- ALLOW creating / switching to a NON-mainline branch; BLOCK mainline targets and
  destructive branch flags (-D, -m, -f, --detach, --orphan, `-- <pathspec>`); a bare
  `git switch --detach` (detach in place) is allowed outside the operator tree.
- ALLOW `git push` of a non-mainline branch for every agent. BLOCK any push to a
  mainline name (also via HEAD:master style refspecs and deletes), --all/--mirror,
  and force pushes unless GIT_GUARD_FORCE_PUSH_ALLOW=1.
- ALLOW `git worktree add --detach <dir> <ref>`, `worktree remove <dir>`, `worktree
  prune` and `worktree list` for every agent (a detached worktree locks no branch);
  BLOCK any of them from or onto a path inside PRODUCT_OPERATOR_TREE. A non-detached
  `worktree add` (or -b/-B) needs GIT_GUARD_FORCE_PUSH_ALLOW=1.
- Wrappers are looked through: `sh/bash/zsh/dash -c '<cmd>'` and `eval` strings are
  re-tokenized and guarded recursively; env/xargs/nohup/timeout/sudo are skipped over
  to the git call (xargs git push is blocked: its refspecs come from stdin).
- BLOCK everything else that touches the remote or rewrites shared history: pull,
  remote, rebase, reset (except --soft off mainline), clean, gc, cherry-pick,
  revert, tag, am, update-ref, filter-branch, reflog, config.
- A push whose remote or refspec holds `$`, a backtick or `$(` is blocked: the guard
  cannot resolve what it would push.
- `gh`: an agent may open a PR (never merge one). BLOCK `gh pr merge`, `gh repo delete`
  and a write `gh api` call (-X/--method PUT|POST|PATCH|DELETE, or the implicit POST of
  -f/-F/--input) whose path holds /merge, /git/refs, /branches or /protection, and a
  `gh api graphql` whose body (fields, -F @file, --input file) holds a mergePullRequest,
  deleteRef or updateRef mutation. Flags between `pr`/`repo` and the subcommand
  (`gh pr -R o/r merge`) are skipped. Every other `gh` command passes. A human merges
  into the mainline.

Exit codes: 0 = allow, 2 = block (stderr shown to the model).

Note: a safety net, not an adversarial sandbox; obfuscated commands (eval, heredoc
into sh) can evade token scanning. The agent instructions carry the same policy.
"""
import json
import os
import re
import shlex
import fnmatch
import subprocess
import sys

def block(msg):
    sys.stderr.write("git-guard: " + msg + "\n")
    sys.exit(2)


# Enforce only inside Paperclip agent runs; human sessions pass through.
if not os.environ.get("PAPERCLIP_AGENT_ID"):
    sys.exit(0)

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

cmd = (data.get("tool_input") or {}).get("command", "") or ""
if "git" not in cmd and not re.search(r"\bgh\b", cmd):
    sys.exit(0)

CWD = (data.get("cwd") or os.getcwd())

# The operator's own checkout(s): an agent never moves their HEAD (not to a mainline,
# not to any other branch, not to "free a lock"). Colon-separated list.
OPERATOR_TREES = {
    os.path.realpath(os.path.expanduser(p))
    for p in os.environ.get("PRODUCT_OPERATOR_TREE", "").split(":")
    if p
}
# The fleet tree(s) agents work in: a commit there must land on a branch, never on a
# detached HEAD (the auto-detach hook leaves the tree detached between runs).
FLEET_TREES = {
    os.path.realpath(os.path.expanduser(p))
    for p in os.environ.get("PRODUCT_FLEET_TREE", "").split(":")
    if p
}


def _csv(name, default=""):
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        raw = default
    return [x.strip() for x in raw.split(",") if x.strip()]


REF_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/+-]*")
MAINLINE_ERROR = ""
_raw_ml = os.environ.get("GIT_GUARD_MAINLINE")
if _raw_ml is None or not _raw_ml.strip():
    _raw_ml = "master,main"
# Split on commas and whitespace; any empty or ref-invalid name makes the config unusable.
_ml_names = re.split(r"[,\s]", _raw_ml.strip())
if any(not REF_NAME_RE.fullmatch(n) for n in _ml_names):
    MAINLINE_ERROR = ("GIT_GUARD_MAINLINE=%r is malformed (use a comma list of plain branch "
                      "names); refusing every git command until it is fixed." % _raw_ml)
MAINLINE = set(_ml_names)
PUSH_ALLOW_GLOBS = _csv("GIT_GUARD_PUSH_ALLOW")
FORCE_PUSH_ALLOW = os.environ.get("GIT_GUARD_FORCE_PUSH_ALLOW") == "1"
if MAINLINE_ERROR:
    block(MAINLINE_ERROR)

# Read-only inspection + working-tree-only transport (never history/refs/remote).
READONLY = {
    "diff", "show", "log", "status", "rev-parse", "rev-list", "ls-files",
    "ls-tree", "cat-file", "blame", "describe", "shortlog", "merge-base",
    "name-rev", "for-each-ref", "var", "version", "help", "grep",
    "whatchanged", "apply", "restore",
    # merge-tree computes a merge in memory (with --write-tree it writes tree/blob
    # objects to the object DB only — never refs, the working tree, or the remote),
    # so it is safe for read-only conflict *detection* against remote master.
    "merge-tree",
}
# Local commit flow on the current branch — allowed unless on a mainline.
WRITE_LOCAL = {"add", "commit", "stash", "mv", "rm"}
# Branch manipulation — allowed only to create/switch a non-mainline feature
# branch (see branch_op_decision); destructive forms below are always blocked.
BRANCH_OPS = {"branch", "switch", "checkout"}
DESTRUCTIVE_BRANCH_FLAGS = {
    "-d", "-D", "--delete", "-m", "-M", "--move", "-f", "--force",
    "-B", "-C", "--detach", "--orphan",
}

OPTS_WITH_ARG = {"-c", "-C", "--git-dir", "--work-tree", "--exec-path", "--namespace"}
# shlex groups runs of punctuation (e.g. "&&", ">>", ";;", ")>"): any token made only of
# these characters is a separator.
SHELLS = {"sh", "bash", "zsh", "dash"}
SEP_CHARS = set(";&|()<>")
SEPARATORS = {"&&", "||", ";", "|", "|&", "&", ">", ">>", "<", "<<", "(", ")"}


def is_sep(t):
    return bool(t) and set(t) <= SEP_CHARS



def tokenize(text):
    """POSIX shell tokens with ; & | ( ) < > as their own tokens (even when glued to a
    word). Newlines and backticks act as separators; a backtick also leaves a lone "`"
    token before its separator so a push can see that its arguments were cut by a
    command substitution. Fails closed on a parse error."""
    lex = shlex.shlex(text.replace("\n", " ; ").replace("`", " ` ; "),
                      posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = ""
    try:
        return list(lex)
    except ValueError as e:
        block("cannot parse the command (%s); refusing to guess what it runs." % e)


tokens = tokenize(cmd)


def _resolve_dir(path, base):
    """Resolve a `cd`/`-C` operand against the directory the shell is in."""
    path = os.path.expanduser(path.strip("\"'`"))
    if not os.path.isabs(path):
        path = os.path.join(base, path)
    return os.path.normpath(path)


def git_invocations(toks, base_dir=None, via_xargs=False):
    """Yield (subcommand, args, dir) for each `git` call in the command line.

    args are the tokens after the subcommand, up to the next shell separator or
    the next `git` invocation. Global `git` options (and their values) before
    the subcommand are skipped so they are not mistaken for the subcommand.
    dir is the directory the call really runs in: the payload cwd, moved by any
    preceding `cd <dir>` and by a `git -C <dir>` global option — so the
    branch/tree checks below look at the tree the command targets, not at the
    tree the session happens to sit in.
    """
    out = []
    i, n = 0, len(toks)
    shell_dir = base_dir or CWD
    xa = via_xargs
    while i < n:
        t = toks[i].strip("\"'`")
        if is_sep(t):
            xa = via_xargs
        base = os.path.basename(t)
        if base == "xargs":
            xa = True
        if base in SHELLS or base == "eval":
            # Look into the quoted script: sh -c '<script>' / eval '<script>'.
            j = i + 1
            scripts = []
            if base == "eval":
                while j < n and not is_sep(toks[j]):
                    scripts.append(toks[j])
                    j += 1
            else:
                while j < n and not is_sep(toks[j]):
                    tj = toks[j]
                    if re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", tj) and j + 1 < n:
                        scripts.append(toks[j + 1])
                        j += 2
                        break
                    j += 1
            if scripts:
                sub_toks = tokenize(" ".join(scripts) if base == "eval" else scripts[0])
                out.extend(git_invocations(sub_toks, shell_dir, xa))
                i = j
                continue
        if t == "cd" and i + 1 < n and not is_sep(toks[i + 1]) and toks[i + 1] != "`":
            shell_dir = _resolve_dir(toks[i + 1], shell_dir)
            i += 2
            continue
        if t == "git" or t.endswith("/git"):
            gdir = shell_dir
            j = i + 1
            sub = None
            gopts = []
            while j < n:
                tj = toks[j].strip("\"'`")
                if is_sep(tj):
                    break
                if tj.startswith("-"):
                    gopts.append(tj)
                if tj in OPTS_WITH_ARG:
                    if tj == "-C" and j + 1 < n:
                        gdir = _resolve_dir(toks[j + 1], gdir)
                    j += 2
                    continue
                if tj.startswith("-"):
                    j += 1
                    continue
                sub = tj
                j += 1
                break
            args = []
            while j < n:
                if toks[j] == "`":
                    if sub == "push":
                        args.append("`")  # cut by a command substitution: unresolvable
                    break
                tj = toks[j].strip("\"'`")
                if is_sep(tj) or tj == "git" or tj.endswith("/git"):
                    break
                args.append(tj)
                j += 1
            out.append((sub, args, gdir, gopts, xa))
            i = j
            continue
        i += 1
    return out


def current_branch(gdir=None):
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=gdir or CWD, capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip()
    except Exception:
        return ""


def tree_toplevel(gdir):
    """Real path of the working tree `gdir` belongs to ('' if none / unresolvable)."""
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=gdir, capture_output=True, text=True, timeout=5,
        )
        top = r.stdout.strip()
        return os.path.realpath(top) if top else ""
    except Exception:
        return ""


PUSH_FLAGS = {
    "-n", "--dry-run", "-v", "--verbose", "-q", "--quiet", "-u", "--set-upstream",
    "--tags", "--follow-tags", "--no-verify", "--verify", "--atomic", "--no-atomic",
    "--porcelain", "--progress", "--thin", "--no-thin", "-d", "--delete",
    "--no-force-with-lease", "--ipv4", "--ipv6", "-4", "-6", "--signed",
    "--no-signed", "--no-follow-tags", "--no-tags", "--no-recurse-submodules",
}
PUSH_FORCE_FLAGS = {"-f", "--force", "--force-if-includes"}
PUSH_SHORT = set("nvqudf46")  # short flags that may be clustered (-fu, -uf, -vn ...)


def parse_push(args, gopts):
    """Return (remote, refspecs, forced, plain_force); block on anything unknown."""
    if any(g.startswith("-c") or g.startswith("--config-env") for g in gopts):
        block("`git -c ...` config overrides are blocked on push (they can swap the transport).")
    remote, positionals = None, []
    forced = plain_force = False
    i, n = 0, len(args)
    while i < n:
        a = args[i]
        i += 1
        if a == "--":
            positionals += args[i:]
            break
        if not a.startswith("-") or a == "-":
            positionals.append(a)
            continue
        if a.startswith("--"):
            name, eq, val = a.partition("=")
            if name in ("--receive-pack", "--exec"):
                block("`git push %s` is blocked (it runs an arbitrary program)." % name)
            if name in ("--all", "--mirror", "--prune"):
                block("`git push %s` is blocked (it can touch or delete the mainline)." % name)
            if name == "--repo":
                if not eq:
                    if i >= n:
                        block("`git push --repo` without a value.")
                    val, i = args[i], i + 1
                remote = val
                continue
            if name == "--push-option":
                if not eq:
                    if i >= n:
                        block("`git push --push-option` without a value.")
                    i += 1
                continue
            if name == "--force-with-lease":
                forced = True
                continue
            if name in PUSH_FORCE_FLAGS:
                forced = True
                plain_force = plain_force or name == "--force"
                continue
            if name == "--recurse-submodules" or name in PUSH_FLAGS:
                continue
            block("unknown `git push` option '%s'; refusing (fail closed)." % a)
        # short-flag cluster, e.g. -fu / -uf / -o value / -ovalue
        j = 1
        while j < len(a):
            c = a[j]
            if c == "o":
                if j + 1 >= len(a):
                    if i >= n:
                        block("`git push -o` without a value.")
                    i += 1
                break
            if c not in PUSH_SHORT:
                block("unknown `git push` option '-%s'; refusing (fail closed)." % c)
            if c == "f":
                forced = plain_force = True
            j += 1
    if remote is None and positionals:
        remote, positionals = positionals[0], positionals[1:]
    return remote, positionals, forced, plain_force


def push_destination(rs, gdir):
    """Normalised destination branch of one push refspec (blocks globs/empties)."""
    if any(ch in rs for ch in "*?[") or rs.startswith("^"):
        block("refusing wildcard/negative refspec '%s'." % rs)
    if rs.startswith("+"):
        rs = rs[1:]
    if ":" in rs:
        _, dst = rs.split(":", 1)
    else:
        dst = rs
    if not dst or ":" in dst:
        block("refusing refspec '%s': empty or malformed destination." % rs)
    if dst in ("HEAD", "@"):
        dst = current_branch(gdir)
        if not dst:
            block("cannot resolve HEAD for the push destination.")
    if dst.startswith("refs/"):
        dst = dst[len("refs/"):]
    if dst.startswith("heads/"):
        dst = dst[len("heads/"):]
    return dst


def branch_op_decision(sub, args, gdir):
    """Block (call block) destructive/mainline branch ops; return for allowed."""
    flags = [a for a in args if a.startswith("-")]
    positionals = [a for a in args if not a.startswith("-")]

    # The operator's own checkout: its HEAD is never moved by an agent (checked
    # first so `git switch -` / a bare `git checkout` cannot slip past below).
    if sub in ("switch", "checkout") and tree_toplevel(gdir) in OPERATOR_TREES:
        block(
            "refusing `git %s` inside the operator's own checkout (%s). That tree's HEAD "
            "belongs to the operator — agents work in their own fleet tree and never move "
            "it, not even to 'free' a branch. If the branch you need is checked out there, "
            "finish what you can and post an 'Operator action needed:' handoff on the "
            "top-level issue (the board-decision handoff rule)." % (sub, gdir)
        )

    # Safe delete of a NON-mainline branch (`git branch -d <name>` / --delete) is
    # allowed so a sub-branch can be cleaned up after it has been merged back into
    # its feature branch (the operator-mandated no-orphan-branches model, 2026-07-01).
    # `-d` refuses to delete an un-merged branch, so this cannot lose unmerged work;
    # force-delete (`-D`) stays blocked, and deleting a mainline stays blocked.
    if sub == "branch" and any(f in ("-d", "--delete") for f in flags) and "-D" not in flags:
        if not positionals:
            block("refusing `git branch -d` with no branch name.")
        if any(t in MAINLINE for t in positionals):
            block("refusing to delete the mainline.")
        return  # allowed: safe delete of a merged non-mainline sub-branch

    # `git switch --detach` with no target detaches HEAD in place (same commit, nothing
    # discarded) so a pushed branch is no longer checked out and locked; the operator's
    # checkout was refused above.
    if sub == "switch" and flags == ["--detach"] and not positionals:
        return

    for f in flags:
        if f in DESTRUCTIVE_BRANCH_FLAGS:
            block(
                "blocked branch flag '%s' on `git %s`. Agents may only create or "
                "switch to a feature branch — not delete, rename, force, detach, "
                "or orphan. The operator owns destructive branch ops." % (f, sub)
            )
    if "--" in args:
        block(
            "blocked `git %s -- <pathspec>` (discards working-tree changes). "
            "Use `git restore` for a deliberate file restore." % sub
        )

    # No positional target: `git branch` / `git branch --list` (listing) or a
    # bare `git switch` (errors anyway) — harmless, allow.
    if not positionals:
        return

    target = positionals[0]
    if target in MAINLINE:
        block(
            "refusing `git %s %s`: agents must not create or switch to "
            "the mainline. Create/use a feature branch off the mainline "
            "(`git switch -c <the profile's branch scheme>`) and commit there; the "
            "operator reviews and merges into the mainline." % (sub, target)
        )
    # Create/switch to a non-mainline feature branch — allowed.
    return


def gh_invocations(toks):
    """Yield the argument list of each `gh` call (sh -c / eval scripts looked into)."""
    out = []
    i, n = 0, len(toks)
    while i < n:
        t = toks[i].strip("\"'`")
        base = os.path.basename(t)
        if base in SHELLS or base == "eval":
            j = i + 1
            scripts = []
            while j < n and not is_sep(toks[j]):
                if base == "eval":
                    scripts.append(toks[j])
                elif re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", toks[j]) and j + 1 < n:
                    scripts.append(toks[j + 1])
                    j += 2
                    break
                j += 1
            if scripts:
                out.extend(gh_invocations(tokenize(" ".join(scripts) if base == "eval" else scripts[0])))
                i = j
                continue
        if base == "gh":
            j = i + 1
            args = []
            while j < n and toks[j] != "`" and not is_sep(toks[j]):
                args.append(toks[j].strip("\"'`"))
                j += 1
            out.append(args)
            i = j
            continue
        i += 1
    return out


GH_WRITE_METHODS = {"PUT", "POST", "PATCH", "DELETE"}
GH_PROTECTED_PATHS = ("/merge", "/git/refs", "/branches", "/protection")
# `gh api` options that take a value (the value is not the endpoint path).
GH_API_OPTS_WITH_ARG = {"-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header",
                        "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache",
                        "-p", "--preview"}
GH_API_BODY_OPTS = {"-f", "--raw-field", "-F", "--field", "--input"}


GH_BOOL_FLAGS = {"-h", "--help"}
GH_GRAPHQL_WRITES = re.compile(r"\b(mergePullRequest|deleteRef|updateRef)\b")


def gh_positionals(args):
    """gh's positional words, skipping flags and their values (-R o/r, --repo o/r, --repo=o/r)."""
    words, i, n = [], 0, len(args)
    while i < n:
        a = args[i]
        if a.startswith("-"):
            # A flag without "=" takes the next token as its value, except the boolean ones.
            i += 1 if ("=" in a or a in GH_BOOL_FLAGS) else 2
            continue
        words.append(a)
        i += 1
    return words


def gh_subcommand(args, group):
    """The subcommand of `gh <group> ...`, or None when the command is another group."""
    words = gh_positionals(args)
    return words[1] if len(words) > 1 and words[0] == group else None


def gh_graphql_body(rest):
    """Everything a `gh api graphql` call sends: field values and the files -F @file / --input name."""
    parts, i = [], 0
    while i < len(rest):
        a = rest[i]
        i += 1
        if a.startswith("--"):
            name, eq, val = a.partition("=")
        elif a[:2] in ("-f", "-F"):
            name, eq, val = a[:2], ("=" if len(a) > 2 else ""), a[2:]
        else:
            continue
        if name not in ("-f", "--raw-field", "-F", "--field", "--input"):
            continue
        if not eq:
            val = rest[i] if i < len(rest) else ""
            i += 1
        if name == "--input":
            path = val
        elif name in ("-F", "--field") and "=" in val and val.split("=", 1)[1].startswith("@"):
            path = val.split("=", 1)[1][1:]
        else:
            parts.append(val)
            continue
        if path in ("", "-"):
            block("`gh api graphql` reads its body from stdin; the guard cannot check it for merge "
                  "or ref mutations.")
        try:
            with open(_resolve_dir(path, CWD), "r") as fh:
                parts.append(fh.read())
        except OSError:
            block("`gh api graphql` body file '%s' cannot be read, so the guard cannot check it "
                  "for merge or ref mutations." % path)
    return "\n".join(parts)


def gh_decision(args):
    """Block what merges, deletes a repo or rewrites refs/branch protection; pass the rest."""
    if gh_subcommand(args, "pr") == "merge":
        block("`gh pr merge` is blocked: an agent may open a PR, never merge one. "
              "A human merges the PR into the mainline.")
    if gh_subcommand(args, "repo") == "delete":
        block("`gh repo delete` is blocked.")
    if "api" not in args:
        return
    rest = args[args.index("api") + 1:]
    method, paths, has_body = None, [], False
    i = 0
    while i < len(rest):
        a = rest[i]
        name, eq, val = a.partition("=") if a.startswith("--") else (a, "", "")
        if a.startswith("-X") and len(a) > 2:
            method = a[2:]
        elif name in GH_API_OPTS_WITH_ARG:
            if not eq:
                val = rest[i + 1] if i + 1 < len(rest) else ""
                i += 1
            if name in ("-X", "--method"):
                method = val
            if name in GH_API_BODY_OPTS:
                has_body = True
        elif a.startswith("-"):
            if a[:2] in ("-f", "-F"):
                has_body = True
        else:
            paths.append(a)
        i += 1
    if paths and paths[0] == "graphql" and GH_GRAPHQL_WRITES.search(gh_graphql_body(rest)):
        block("`gh api graphql` with a mergePullRequest / deleteRef / updateRef mutation is blocked: "
              "an agent never merges a PR or moves a ref. A human merges the PR into the mainline.")
    if method is None and has_body:
        method = "POST"  # gh api sends POST when fields or --input are given
    if (method or "GET").upper() in GH_WRITE_METHODS and any(
            seg in p for p in paths for seg in GH_PROTECTED_PATHS):
        block("`gh api` %s on %s is blocked: it can merge, move refs or change branch "
              "protection. A human merges the PR into the mainline." % (method.upper(), " ".join(paths)))


for gh_args in gh_invocations(tokens):
    gh_decision(gh_args)


for sub, args, gdir, gopts, via_xargs in git_invocations(tokens):
    if sub is None:
        continue

    if sub in READONLY:
        continue

    if sub == "fetch":
        if any(g.startswith("-c") or g.startswith("--config-env") for g in gopts):
            block("`git -c ...` config overrides are blocked on fetch (they can swap the transport).")
        continue  # allowed for every agent: only updates remote-tracking refs

    if sub in BRANCH_OPS:
        branch_op_decision(sub, args, gdir)
        continue

    if sub in WRITE_LOCAL:
        cb = current_branch(gdir)
        if cb in MAINLINE:
            block(
                "refusing to %s on '%s'. Agents must never commit to the mainline.\n"
                "Create or switch to a feature branch first "
                "(`git switch -c <the profile's branch scheme>`), then commit there." % (sub, cb)
            )
        if sub == "commit" and cb == "HEAD" and FLEET_TREES and tree_toplevel(gdir) in FLEET_TREES:
            block(
                "refusing `git commit` on a detached HEAD in the fleet tree (%s): the commit "
                "would land on no branch. Switch to your branch first "
                "(`git switch <your feature branch>`), then commit." % gdir
            )
        continue

    # Local merge of a sub-branch BACK INTO a non-mainline feature branch is allowed
    # (operator-mandated model, 2026-07-01: sub-work merges back into the feature
    # branch, then the sub-branch is deleted). Merging onto a mainline stays blocked
    # — the mainline only ever changes when a human merges the PR on the platform.
    if sub == "merge":
        cb = current_branch(gdir)
        if cb in MAINLINE:
            block(
                "refusing `git merge` on '%s'. Agents must NEVER merge into the mainline.\n"
                "Merge sub-branches into the FEATURE branch only; the human merges the "
                "feature branch's PR into the mainline on the platform." % cb
            )
        continue  # allowed: merge a sub-branch into a non-mainline feature branch

    # SOFT reset on a NON-mainline branch is allowed so the prepare-for-merge run can
    # squash a feature branch's history into a clean, readable set before it is finished
    # (`git reset --soft <base>` keeps the tree + index — it only collapses commits, so no
    # work is lost). `--hard`/`--mixed`/`--merge`/`--keep`, reset on a mainline, and all
    # remote/push ops stay blocked (a squash of an already-pushed branch is finalized by the
    # human's push / PR squash-merge — a push needs the push policy to allow it).
    if sub == "reset":
        cb = current_branch(gdir)
        flagset = {a for a in args if a.startswith("-")}
        if cb in MAINLINE:
            block("refusing `git reset` on the mainline — it is never rewritten by an agent.")
        if "--soft" in flagset and not (flagset & {"--hard", "--mixed", "--merge", "--keep"}):
            continue  # allowed: soft reset to squash on a non-mainline feature branch
        block(
            "only `git reset --soft <base>` on a feature branch is allowed (for squashing). "
            "`--hard`/`--mixed`/`--merge`/`--keep` are blocked (they can discard work)."
        )

    # Prepare-for-merge only (GIT_GUARD_FORCE_PUSH_ALLOW=1): rebase a NON-mainline
    # feature branch onto its upstream. Interactive/exec/root rebases and any rebase
    # while on a mainline stay blocked; without the env every rebase is blocked.
    if sub == "rebase":
        if not FORCE_PUSH_ALLOW:
            block(
                "`git rebase` is blocked. Only a prepare-for-merge run "
                "(GIT_GUARD_FORCE_PUSH_ALLOW=1) may rebase a feature branch onto the remote mainline."
            )
        flagset = {a for a in args if a.startswith("-")}
        if flagset & {"--abort", "--continue", "--quit", "--skip"}:
            continue  # allowed: manage an in-progress rebase (e.g. abort on conflict)
        if flagset & {"-i", "--interactive", "--exec", "-x", "--root"}:
            block(
                "interactive/exec/root rebase is blocked; use a plain "
                "`git rebase origin/<the mainline>` on the feature branch."
            )
        cb = current_branch(gdir)
        if cb in MAINLINE:
            block(
                "refusing `git rebase` while on '%s' — the mainline is never rewritten. "
                "Rebase a non-mainline feature branch only." % cb
            )
        # Constrain the upstream / --onto target: rebase onto the remote mainline (a remote
        # ref) or another non-mainline ref — never a bare local `master`/`main` (matches
        # the designed envelope; `origin/<mainline>` is not in MAINLINE so it stays allowed).
        if any(a in MAINLINE for a in args if not a.startswith("-")):
            block(
                "refusing `git rebase` with a bare mainline ref as upstream/onto target — "
                "rebase onto the remote mainline (origin/<the mainline>) or a non-mainline ref, not the local mainline."
            )
        continue  # allowed: prepare-for-merge rebases a non-mainline branch onto its upstream

    # Prepare-for-merge only (GIT_GUARD_FORCE_PUSH_ALLOW=1): manage an isolated worktree
    # so the rebase/squash runs off the shared checkout. A worktree may not be created
    # on a mainline; without the env every worktree command is blocked.
    if sub == "worktree":
        wsub = args[0] if args else ""
        if wsub not in ("add", "remove", "prune", "list"):
            block(
                "`git worktree %s` is not allowed; only add --detach/remove/prune/list "
                "(add of a branch needs a prepare-for-merge run)." % (wsub or "(none)")
            )
        # Never touch the operator's own checkout: not from inside it, not by path
        # (inside it either), with or without --force.
        if wsub != "list" and tree_toplevel(gdir) in OPERATOR_TREES:
            block("refusing `git worktree %s` from inside the operator's checkout." % wsub)
        for t in args[1:]:
            if t.startswith("-"):
                continue
            p = os.path.realpath(_resolve_dir(t, gdir))
            if any(p == o or p.startswith(o + os.sep) for o in OPERATOR_TREES):
                block("refusing `git worktree %s` on a path in the operator's checkout (%s)." % (wsub, t))
        if wsub == "add":
            creates_branch = any(t in ("-b", "-B") or t.startswith(("-b", "-B")) for t in args[1:]
                                 if t.startswith("-") and not t.startswith("--"))
            detached = "--detach" in args and not creates_branch
            if not detached:
                if not FORCE_PUSH_ALLOW:
                    block("`git worktree add` without --detach is blocked (it locks a branch); "
                          "use `git worktree add --detach <dir> <ref>`.")
                if any(t in MAINLINE for t in args):
                    block(
                        "refusing `git worktree add` on the mainline — the isolated worktree is "
                        "for a non-mainline feature branch only."
                    )
        continue  # allowed: detached add, remove, prune, list (and branch add in prepare runs)

    # Push: any agent may push a NON-mainline branch. A mainline destination is blocked
    # for everyone (plain, refspec, HEAD/@ resolved, delete forms); --all/--mirror/--prune
    # are blocked; force is blocked unless GIT_GUARD_FORCE_PUSH_ALLOW=1 (and then only
    # --force-with-lease); GIT_GUARD_PUSH_ALLOW narrows by glob. Unknown options, `-c`
    # config overrides, --receive-pack/--exec and glob/empty refspecs fail closed.
    if sub == "push":
        if via_xargs:
            block("`xargs git push` is blocked: its refspecs come from stdin and cannot be checked.")
        remote, refspecs, forced, plain_force = parse_push(args, gopts)
        for t in ([remote] if remote else []) + refspecs:
            if "$" in t or "`" in t:
                block("refusing `git push` with '%s': a shell variable or command substitution "
                      "cannot be resolved by the guard. Switch to the branch and push "
                      "`git push -u origin HEAD`." % t)
        forced = forced or any(rs.startswith("+") for rs in refspecs)
        dests = []
        for rs in refspecs:
            dests.append(push_destination(rs, gdir))
        if not refspecs:
            dests = [current_branch(gdir)]
        if any(d in MAINLINE for d in dests):
            block("refusing to push to a mainline branch; the mainline is never pushed by an agent.")
        if plain_force:
            block("plain --force is blocked; use --force-with-lease (prepare-for-merge runs only).")
        if forced and not FORCE_PUSH_ALLOW:
            block("force push is blocked (only prepare-for-merge runs may use --force-with-lease).")
        if PUSH_ALLOW_GLOBS:
            for d in dests:
                if not any(fnmatch.fnmatchcase(d, g) for g in PUSH_ALLOW_GLOBS):
                    block("push to '%s' is blocked: allowed branches match %s." % (d, ", ".join(PUSH_ALLOW_GLOBS)))
        continue  # allowed: push of a non-mainline branch

    block(
        "blocked git subcommand: %s.\n"
        "Agents may NOT push/pull/fetch/rebase/reset/clean or rewrite "
        "history, and NEVER touch the mainline. Commit on your feature branch; "
        "merge sub-branches back into it; the human merges the PR." % sub
    )

sys.exit(0)
