import { describe, expect, it } from "vitest";
import { evaluateClaudePreflight } from "./preflight.js";

// A pre-flight gate that runs BEFORE context is assembled and the CLI is spawned.
// Its whole point is to fail fast (zero tokens) on a doomed run, and to NEVER
// false-block a healthy run — so every uncertain signal must fail open.
const RESETS_AT = "2026-08-06T15:00:00.000Z";

function okUsage(fiveHour: { utilization: number | null; resets_at?: string | null }) {
  return async () => ({ status: 200, body: { five_hour: fiveHour } });
}

describe("evaluateClaudePreflight", () => {
  it("blocks with claude_auth_required when no credential token is present", async () => {
    const verdict = await evaluateClaudePreflight({
      deps: { readToken: async () => null, fetchUsage: okUsage({ utilization: 0 }) },
    });
    expect(verdict.block).toBe(true);
    expect(verdict.block && verdict.errorCode).toBe("claude_auth_required");
  });

  it("blocks with claude_auth_required when the usage API rejects the token (401)", async () => {
    const verdict = await evaluateClaudePreflight({
      deps: {
        readToken: async () => "tok",
        fetchUsage: async () => ({ status: 401, body: { error: "unauthorized" } }),
      },
    });
    expect(verdict.block).toBe(true);
    expect(verdict.block && verdict.errorCode).toBe("claude_auth_required");
  });

  it("blocks with claude_usage_limit_reached and defers to reset when the 5h window is exhausted", async () => {
    const verdict = await evaluateClaudePreflight({
      deps: {
        readToken: async () => "tok",
        fetchUsage: okUsage({ utilization: 100, resets_at: RESETS_AT }),
      },
    });
    expect(verdict.block).toBe(true);
    if (!verdict.block) throw new Error("expected block");
    expect(verdict.errorCode).toBe("claude_usage_limit_reached");
    expect(verdict.errorFamily).toBe("usage_limit");
    expect(verdict.retryNotBefore).toBe(RESETS_AT);
  });

  it("does not block when the 5h window has headroom", async () => {
    const verdict = await evaluateClaudePreflight({
      deps: { readToken: async () => "tok", fetchUsage: okUsage({ utilization: 40, resets_at: RESETS_AT }) },
    });
    expect(verdict.block).toBe(false);
  });

  it("fails open (does not block) when the credential file cannot be read", async () => {
    const verdict = await evaluateClaudePreflight({
      deps: {
        readToken: async () => {
          throw new Error("EACCES");
        },
        fetchUsage: okUsage({ utilization: 0 }),
      },
    });
    expect(verdict.block).toBe(false);
  });

  it("fails open when the usage API is unreachable", async () => {
    const verdict = await evaluateClaudePreflight({
      deps: {
        readToken: async () => "tok",
        fetchUsage: async () => {
          throw new Error("ETIMEDOUT");
        },
      },
    });
    expect(verdict.block).toBe(false);
  });

  it("fails open on a transient usage-API status (429/5xx) rather than blocking", async () => {
    const rateLimited = await evaluateClaudePreflight({
      deps: { readToken: async () => "tok", fetchUsage: async () => ({ status: 429, body: {} }) },
    });
    const serverErr = await evaluateClaudePreflight({
      deps: { readToken: async () => "tok", fetchUsage: async () => ({ status: 503, body: {} }) },
    });
    expect(rateLimited.block).toBe(false);
    expect(serverErr.block).toBe(false);
  });
});

describe("evaluateClaudePreflight credentials directory", () => {
  it("reads the explicit config dir (not HOME/.claude) and blocks only when it lacks credentials", async () => {
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const withCreds = await fsp.mkdtemp(pathMod.join(os.tmpdir(), "preflight-ok-"));
    const without = await fsp.mkdtemp(pathMod.join(os.tmpdir(), "preflight-none-"));
    await fsp.writeFile(
      pathMod.join(withCreds, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "fake-token" } }),
    );
    const prev = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    const seen: string[] = [];
    const fetchUsage = async (token: string) => {
      seen.push(token);
      return { status: 200, body: { five_hour: { utilization: 0 } } };
    };
    try {
      const ok = await evaluateClaudePreflight({ configDir: withCreds, deps: { fetchUsage } });
      expect(ok.block).toBe(false);
      expect(seen).toEqual(["fake-token"]);
      const missing = await evaluateClaudePreflight({ configDir: without, deps: { fetchUsage } });
      expect(missing.block && missing.errorCode).toBe("claude_auth_required");
    } finally {
      if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev;
      await fsp.rm(withCreds, { recursive: true, force: true });
      await fsp.rm(without, { recursive: true, force: true });
    }
  });
});
