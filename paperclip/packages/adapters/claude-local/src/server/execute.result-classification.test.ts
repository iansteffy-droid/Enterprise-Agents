import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A run whose CLI already emitted a successful terminal result can still exit
// non-zero: the terminal-result cleanup SIGTERMs a lingering process (background
// tasks), and server restarts/reboots kill it during shutdown. Those kills must
// not turn finished work into a retryable failure (observed live: a QA approval
// recorded as `failed: "Claude run failed: subtype=success: ..."`, exit 143,
// then fully re-run).

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("./preflight.js", () => ({
  evaluateClaudePreflight: vi.fn(async () => ({ block: false })),
}));

import { execute } from "./execute.js";

function procResult(input: {
  exitCode: number | null;
  signal?: string | null;
  stdout: string;
  stdinError?: { errorCode: "adapter_stdin_write_failed"; message: string } | null;
}) {
  return {
    stdinError: input.stdinError ?? null,
    exitCode: input.exitCode,
    signal: input.signal ?? null,
    timedOut: false,
    stdout: input.stdout,
    stderr: "",
    pid: 4242,
    startedAt: new Date().toISOString(),
  };
}

function streamWithResult(resultEvent: Record<string, unknown>) {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-sonnet-4-6" }),
    JSON.stringify({
      type: "assistant",
      session_id: "sess-1",
      message: { content: [{ type: "text", text: "QA gate approved." }] },
    }),
    JSON.stringify(resultEvent),
  ].join("\n");
}

const successResultEvent = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "QA gate approved and closed as done.",
  session_id: "sess-1",
  usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
  total_cost_usd: 0.12,
};

describe("claude run completion classification", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runExecuteWithProc(proc: ReturnType<typeof procResult>) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-classify-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const instructionsPath = path.join(rootDir, "instructions.md");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(instructionsPath, "Do the work.\n", "utf8");

    runChildProcess.mockResolvedValue(proc);

    return execute({
      runId: "run-classify-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Dr Crusher",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        instructionsFilePath: instructionsPath,
        env: {},
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/classify",
          worktreePath: workspaceDir,
        },
      },
      onLog: async () => {},
    });
  }

  it("treats a SIGTERM-killed run with a successful terminal result as succeeded", async () => {
    const result = await runExecuteWithProc(
      procResult({ exitCode: 143, stdout: streamWithResult(successResultEvent) }),
    );

    expect(result.errorMessage).toBeNull();
    expect(result.errorCode).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({
      processExitCode: 143,
      terminatedAfterTerminalResult: true,
    });
    expect(result.summary).toBe("QA gate approved and closed as done.");
  });

  it("treats a signal-killed run (null exit code) with a successful terminal result as succeeded", async () => {
    const result = await runExecuteWithProc(
      procResult({ exitCode: null, signal: "SIGTERM", stdout: streamWithResult(successResultEvent) }),
    );

    expect(result.errorMessage).toBeNull();
    expect(result.errorCode).toBeNull();
    // The heartbeat success gate is `(exitCode ?? 0) === 0 && !errorMessage`.
    expect(result.exitCode ?? 0).toBe(0);
  });

  it("still fails a non-zero exit whose terminal result is an error", async () => {
    const result = await runExecuteWithProc(
      procResult({
        exitCode: 143,
        stdout: streamWithResult({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "something broke",
          session_id: "sess-1",
        }),
      }),
    );

    expect(result.errorMessage).toContain("Claude run failed");
    expect(result.exitCode).toBe(143);
  });

  it("still fails a non-zero exit with no terminal result at all", async () => {
    const result = await runExecuteWithProc(procResult({ exitCode: 143, stdout: "" }));

    expect(result.errorMessage).not.toBeNull();
    expect(result.exitCode).toBe(143);
  });

  it("fails a run whose prompt could not be written to stdin", async () => {
    const result = await runExecuteWithProc(
      procResult({
        exitCode: 0,
        stdout: "",
        stdinError: {
          errorCode: "adapter_stdin_write_failed",
          message: "Failed to write the prompt to the child's stdin (EPIPE): write EPIPE",
        },
      }),
    );

    expect(result.errorCode).toBe("adapter_stdin_write_failed");
    expect(result.errorMessage).toContain("EPIPE");
  });

  it("does not rescue a clean-exit error result", async () => {
    const result = await runExecuteWithProc(
      procResult({
        exitCode: 1,
        stdout: streamWithResult({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          result: "max turns",
          session_id: "sess-1",
        }),
      }),
    );

    expect(result.errorMessage).toContain("Claude run failed");
  });
});
