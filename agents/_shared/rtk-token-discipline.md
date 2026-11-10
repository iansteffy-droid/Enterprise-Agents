# RTK token discipline (shared rule for all agents)

**Read and search files through the shell, not the built-in tools, so RTK can compress the output.** RTK (Rust Token Killer) is a token-optimizing proxy that strips most of the tokens out of routine dev-command output. It is wired as a `PreToolUse` Bash hook: it rewrites bare commands (`git status` becomes `rtk git status`, `grep` becomes `rtk grep`) and compresses their output before it reaches your context. You do not type `rtk` yourself; the hook does it.

**The catch: the hook only sees the `Bash` tool.** The built-in `Read`, `Grep` and `Glob` tools bypass it, so their output lands in context uncompressed. Reading and searching files is the biggest token sink, so the built-in tools silently defeat RTK.

Rules:

1. **Do not use the built-in `Read`, `Grep` or `Glob` tools.** Use the shell equivalents through `Bash` (`cat`, `sed -n`, `grep`, `rg`, `find`, `ls`). `Write` and `Edit` are fine; they are not output-heavy.
2. **Read big files by structure first.** Prefer `rtk smart <file>` (or `rtk read <file> -l aggressive`) to see signatures before dumping a whole file; then read only the range you need.
3. **Recover truncated logs from disk, not by re-running.** When a test or build fails, RTK keeps only the errors. For the full trace, read the log file path RTK prints at the bottom of its output; do not re-run the suite to see it again.
4. **Wrap massive-output runs in `rtk test <command>`** (end-to-end suites and similar) to filter to the failures.
5. **`rtk proxy <command>` is the escape hatch, used sparingly.** RTK keys on command names and occasionally misreads a result (a false non-zero exit, a mangled summary). When the filtered result contradicts what you expect, re-run that one command under `rtk proxy` for the real result. Never use it to routinely dump raw output.

The rule holds where RTK is absent: shell reads are no worse, and the habit stays the same on every machine.
