#!/usr/bin/env python3
"""completion_gate_parse.py: the parser behind completion-gate.sh.

Reads the Bash command from $GATE_CMD (and the hook input's cwd from $GATE_CWD) and
evaluates every curl / http / wget invocation in it on its own. For each PATCH of
/api/issues/<id> (no further path segment) it finds that invocation's body and prints:

  GATE<TAB><id>      the body sets status "done": the caller checks evidence for <id>
  DENY<TAB><reason>  the body cannot be read or the command cannot be parsed (fail closed)

Nothing is printed for anything else. A PATCH is exempt only when its own body, parsed
as JSON, is an object whose top-level "executionDecision" is approve, request_changes or
hold: a decision string elsewhere in the command or inside a string value never counts.
A body that is not JSON is scanned as text for the done pair (or status=done), and a
body that cannot be resolved (a shell variable or substitution left in it) is gated.

Bodies read: curl -d/--data/--data-ascii/--data-binary/--data-raw/--json (inline or
@file), --data-urlencode (content, name=content, @file, name@file), -T/--upload-file
<file>; httpie key=value / key:=json items; wget --body-data / --body-file. Relative
files resolve against $GATE_CWD (else the current dir); "-" (stdin) is unreadable.
"""
import json
import os
import re
import shlex
import sys

VERBS = {"approve", "request_changes", "hold"}
SHELLS = {"sh", "bash", "zsh", "dash"}
SEP_CHARS = set(";&|()<>")
ISSUE_RE = re.compile(r"/api/issues/([^/?#\s]+)(?:[?#]|$)")
DONE_RE = re.compile(r'\\?"status\\?"\s*:\s*\\?"done\\?"')
FORM_DONE_RE = re.compile(r"(?:^|&)status=done(?:&|$)")
CWD = os.environ.get("GATE_CWD") or os.getcwd()

# curl short options that take a value (the value is the rest of the cluster or the next token).
CURL_SHORT_VAL = set("XdTHoueAbcKmrwxyzEDCYUPQtF")
CURL_LONG_VAL = {
    "--request", "--data", "--data-binary", "--data-raw", "--data-ascii", "--data-urlencode",
    "--json", "--upload-file", "--header", "--output", "--user", "--form", "--form-string",
    "--url", "--user-agent", "--referer", "--cookie", "--cookie-jar", "--cacert", "--cert",
    "--key", "--max-time", "--connect-timeout", "--retry", "--proxy", "--resolve",
    "--write-out", "--config", "--range", "--limit-rate", "--max-filesize", "--oauth2-bearer",
    "--variable", "--expand-data",
}


def out(kind, value):
    sys.stdout.write("%s\t%s\n" % (kind, value.replace("\n", " ")))


def is_sep(tok):
    return bool(tok) and set(tok) <= SEP_CHARS


def tokenize(text):
    lex = shlex.shlex(text.replace("\n", " ; ").replace("`", " ; "), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = ""
    return list(lex)


def invocations(toks):
    """(program, args) for each curl/http/wget call, looking into sh -c and eval scripts."""
    found = []
    i, n = 0, len(toks)
    while i < n:
        base = os.path.basename(toks[i])
        if base in SHELLS or base == "eval":
            j, scripts = i + 1, []
            while j < n and not is_sep(toks[j]):
                if base == "eval":
                    scripts.append(toks[j])
                elif re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", toks[j]) and j + 1 < n:
                    scripts.append(toks[j + 1])
                    j += 2
                    break
                j += 1
            if scripts:
                found.extend(invocations(tokenize(" ".join(scripts) if base == "eval" else scripts[0])))
                i = j
                continue
        if base in ("curl", "http", "https", "wget"):
            j, args = i + 1, []
            while j < n and not is_sep(toks[j]):
                args.append(toks[j])
                j += 1
            found.append((base, args))
            i = j
            continue
        i += 1
    return found


def read_file(name):
    """File content, or None when it cannot be read."""
    if name in ("", "-"):
        return None
    path = os.path.expanduser(name)
    if not os.path.isabs(path):
        path = os.path.join(CWD, path)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


class Unreadable(Exception):
    pass


def file_body(name):
    content = read_file(name)
    if content is None:
        raise Unreadable(name)
    return content


def curl_parse(args):
    method, bodies, urls = None, [], []
    i, n = 0, len(args)

    def take(rest):
        nonlocal i
        if rest:
            return rest
        if i < n:
            v = args[i]
            i += 1
            return v
        return ""

    def add_body(opt, val):
        if opt in ("-d", "--data", "--data-ascii", "--data-binary", "--json"):
            bodies.append(file_body(val[1:]) if val.startswith("@") else val)
        elif opt == "--data-raw":
            bodies.append(val)
        elif opt == "--data-urlencode":
            m = re.match(r"^([^=@]*)@(.*)$", val)
            if m and "=" not in val.split("@", 1)[0]:
                bodies.append(file_body(m.group(2)))
            else:
                bodies.append(val.split("=", 1)[1] if "=" in val else val)
        elif opt in ("-T", "--upload-file"):
            bodies.append(file_body(val))

    while i < n:
        a = args[i]
        i += 1
        if a.startswith("--"):
            name, eq, val = a.partition("=")
            if name in CURL_LONG_VAL:
                val = val if eq else take("")
                if name == "--request":
                    method = val
                elif name == "--url":
                    urls.append(val)
                else:
                    add_body(name, val)
            continue
        if a.startswith("-") and len(a) > 1:
            j = 1
            while j < len(a):
                c = a[j]
                if c in CURL_SHORT_VAL:
                    val = take(a[j + 1:])
                    if c == "X":
                        method = val
                    elif c in ("d", "T"):
                        add_body("-" + c, val)
                    break
                j += 1
            continue
        urls.append(a)
    return method, bodies, urls


def http_parse(args):
    method, items, urls = None, [], []
    positionals = [a for a in args if not a.startswith("-")]
    if positionals and re.fullmatch(r"[A-Z]+", positionals[0]):
        method = positionals.pop(0)
    if positionals:
        urls.append(positionals.pop(0))
    items = positionals
    return method, items, urls


def wget_parse(args):
    method, bodies, urls = None, [], []
    for a in args:
        name, eq, val = a.partition("=")
        if name == "--method" and eq:
            method = val
        elif name == "--body-data" and eq:
            bodies.append(val)
        elif name == "--body-file" and eq:
            bodies.append(file_body(val))
        elif not a.startswith("-"):
            urls.append(a)
    return method, bodies, urls


def body_verdict(bodies):
    """'exempt', 'gate' or None for the bodies one invocation sends."""
    if not bodies:
        return None
    text = "&".join(bodies)
    if len(bodies) == 1:
        try:
            obj = json.loads(bodies[0])
        except ValueError:
            obj = None
        if isinstance(obj, dict):
            if obj.get("executionDecision") in VERBS:
                return "exempt"
            return "gate" if obj.get("status") == "done" else None
    if DONE_RE.search(text) or FORM_DONE_RE.search(text):
        return "gate"
    if "$" in text:
        return "gate"  # a shell variable or substitution the gate cannot resolve
    return None


def http_items_verdict(items):
    decision = status = None
    for it in items:
        m = re.match(r"^([A-Za-z_][\w.]*)(:=|=)(.*)$", it)
        if not m:
            continue
        key, op, val = m.groups()
        if op == ":=":
            try:
                val = json.loads(val)
            except ValueError:
                pass
        if key == "executionDecision":
            decision = val
        elif key == "status":
            status = val
    if decision in VERBS:
        return "exempt"
    if status == "done":
        return "gate"
    if any("$" in it for it in items):
        return "gate"
    return None


def main():
    cmd = os.environ.get("GATE_CMD", "")
    try:
        toks = tokenize(cmd)
    except ValueError as e:
        if "/api/issues/" in cmd and "PATCH" in cmd:
            out("DENY", "BLOCKED: the completion gate cannot parse this command (%s), so it cannot "
                "check whether it marks an issue done. Simplify the quoting and retry." % e)
        return
    for prog, args in invocations(toks):
        try:
            if prog == "curl":
                method, bodies, urls = curl_parse(args)
                verdict_fn = lambda: body_verdict(bodies)
            elif prog == "wget":
                method, bodies, urls = wget_parse(args)
                verdict_fn = lambda: body_verdict(bodies)
            else:
                method, items, urls = http_parse(args)
                verdict_fn = lambda: http_items_verdict(items)
        except Unreadable as e:
            if any(ISSUE_RE.search(a) for a in args):
                out("DENY", "BLOCKED: the completion gate cannot read the request body file %s "
                    "(relative to %s), so it cannot check whether this PATCH marks an issue done. "
                    "Make the file readable or send the body inline, then retry." % (e.args[0], CWD))
                return
            continue
        if (method or "").upper() != "PATCH":
            continue
        issue = next((m.group(1) for m in (ISSUE_RE.search(u) for u in urls) if m), None)
        if not issue:
            continue
        if verdict_fn() == "gate":
            out("GATE", issue)


if __name__ == "__main__":
    main()
