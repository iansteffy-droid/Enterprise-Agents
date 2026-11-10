import { describe, expect, it, vi } from "vitest";

import { ensureFreshClaudeToken, type ClaudeCredentialFile } from "./refresh.js";

// The refresh path guards a credential file shared by a whole fleet of agents.
// It must: skip cheaply when the token is fresh, refresh under a lock when it is
// at/near expiry, preserve unrelated credential fields, and NEVER throw — every
// failure mode falls open so the CLI behaves exactly as before.

const NOW = Date.UTC(2026, 7, 24, 10, 0, 0);
const MINUTE = 60 * 1000;

function credFile(oauth: Record<string, unknown>): ClaudeCredentialFile {
  return {
    filePath: "/home/agent/.claude/.credentials.json",
    parsed: { schemaVersion: 3, claudeAiOauth: oauth },
    oauth,
  };
}

function noopLock() {
  return async () => ({ release: async () => {} });
}

describe("ensureFreshClaudeToken", () => {
  it("no-ops when the access token still has plenty of life", async () => {
    const write = vi.fn();
    const post = vi.fn();
    const result = await ensureFreshClaudeToken({
      deps: {
        now: () => NOW,
        readCredentialFile: async () =>
          credFile({ accessToken: "acc", refreshToken: "ref", expiresAt: NOW + 60 * MINUTE }),
        writeCredentialFile: write,
        postTokenRefresh: post,
        acquireLock: noopLock(),
      },
    });
    expect(result).toEqual({ refreshed: false, reason: "still_fresh" });
    expect(post).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("refreshes near expiry, rotates the refresh token, and preserves other fields", async () => {
    let written: { filePath: string; contents: string } | null = null;
    const result = await ensureFreshClaudeToken({
      deps: {
        now: () => NOW,
        readCredentialFile: async () =>
          credFile({
            accessToken: "old-access",
            refreshToken: "old-refresh",
            expiresAt: NOW + 60 * 1000, // 1 min left -> under the 5 min threshold
            subscriptionType: "max",
            scopes: ["user:inference"],
          }),
        writeCredentialFile: async (filePath, contents) => {
          written = { filePath, contents };
        },
        postTokenRefresh: async (refreshToken) => {
          expect(refreshToken).toBe("old-refresh");
          return {
            status: 200,
            body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 },
          };
        },
        acquireLock: noopLock(),
      },
    });

    expect(result).toEqual({ refreshed: true, expiresAt: NOW + 3600 * 1000 });
    expect(written).not.toBeNull();
    const persisted = JSON.parse(written!.contents) as Record<string, unknown>;
    const oauth = persisted.claudeAiOauth as Record<string, unknown>;
    expect(oauth.accessToken).toBe("new-access");
    expect(oauth.refreshToken).toBe("new-refresh");
    expect(oauth.expiresAt).toBe(NOW + 3600 * 1000);
    // Untouched fields survive the rewrite.
    expect(oauth.subscriptionType).toBe("max");
    expect(persisted.schemaVersion).toBe(3);
  });

  it("keeps the current refresh token when the response omits a rotated one", async () => {
    let written: string | null = null;
    const result = await ensureFreshClaudeToken({
      deps: {
        now: () => NOW,
        readCredentialFile: async () =>
          credFile({ accessToken: "old", refreshToken: "keep-me", expiresAt: NOW - 1000 }),
        writeCredentialFile: async (_filePath, contents) => {
          written = contents;
        },
        postTokenRefresh: async () => ({
          status: 200,
          body: { access_token: "new", expires_in: 3600 },
        }),
        acquireLock: noopLock(),
      },
    });
    expect(result.refreshed).toBe(true);
    const oauth = (JSON.parse(written!) as Record<string, unknown>).claudeAiOauth as Record<string, unknown>;
    expect(oauth.refreshToken).toBe("keep-me");
  });

  it("skips the network entirely when a peer already refreshed while we waited for the lock", async () => {
    const post = vi.fn();
    let reads = 0;
    const result = await ensureFreshClaudeToken({
      deps: {
        now: () => NOW,
        // First read (pre-lock) sees an expired token; the re-read under the lock
        // sees a token a peer already refreshed.
        readCredentialFile: async () => {
          reads += 1;
          return reads === 1
            ? credFile({ accessToken: "old", refreshToken: "ref", expiresAt: NOW - 1000 })
            : credFile({ accessToken: "peer", refreshToken: "ref2", expiresAt: NOW + 60 * MINUTE });
        },
        writeCredentialFile: vi.fn(),
        postTokenRefresh: post,
        acquireLock: noopLock(),
      },
    });
    expect(result).toEqual({ refreshed: false, reason: "refreshed_by_peer" });
    expect(post).not.toHaveBeenCalled();
  });

  it("fails open (never throws) on an HTTP error from the token endpoint", async () => {
    const write = vi.fn();
    const result = await ensureFreshClaudeToken({
      deps: {
        now: () => NOW,
        readCredentialFile: async () =>
          credFile({ accessToken: "old", refreshToken: "ref", expiresAt: NOW - 1000 }),
        writeCredentialFile: write,
        postTokenRefresh: async () => ({ status: 400, body: { error: "invalid_grant" } }),
        acquireLock: noopLock(),
      },
    });
    expect(result).toEqual({ refreshed: false, reason: "refresh_http_400" });
    expect(write).not.toHaveBeenCalled();
  });

  it("no-ops for an API-key / unmanaged setup with no refresh token", async () => {
    const result = await ensureFreshClaudeToken({
      deps: {
        now: () => NOW,
        readCredentialFile: async () => credFile({ accessToken: "acc" }),
        writeCredentialFile: vi.fn(),
        postTokenRefresh: vi.fn(),
        acquireLock: noopLock(),
      },
    });
    expect(result).toEqual({ refreshed: false, reason: "no_refresh_token" });
  });

  it("does not block when the lock cannot be acquired", async () => {
    const post = vi.fn();
    const result = await ensureFreshClaudeToken({
      deps: {
        now: () => NOW,
        readCredentialFile: async () =>
          credFile({ accessToken: "old", refreshToken: "ref", expiresAt: NOW - 1000 }),
        writeCredentialFile: vi.fn(),
        postTokenRefresh: post,
        acquireLock: async () => null,
      },
    });
    expect(result).toEqual({ refreshed: false, reason: "lock_unavailable" });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("ensureFreshClaudeToken credentials directory", () => {
  async function setup(withFile: boolean) {
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const root = await fsp.mkdtemp(pathMod.join(os.tmpdir(), "refresh-test-"));
    const credPath = pathMod.join(root, ".credentials.json");
    if (withFile) {
      await fsp.writeFile(
        credPath,
        JSON.stringify({ schemaVersion: 3, claudeAiOauth: { accessToken: "fake-old", refreshToken: "fake-ref", expiresAt: 1 } }),
      );
    }
    return { fsp, root, credPath };
  }
  const stubPost = async () => ({
    status: 200,
    body: { access_token: "fake-new", refresh_token: "fake-ref2", expires_in: 3600 },
  });

  it("reads and atomically rewrites the credentials file under CLAUDE_CONFIG_DIR when set", async () => {
    const { fsp, root, credPath } = await setup(true);
    const prev = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR; // the run's value must win, not process env
    try {
      const result = await ensureFreshClaudeToken({
        configDir: root,
        deps: { postTokenRefresh: stubPost },
      });
      expect(result.refreshed).toBe(true);
      const persisted = JSON.parse(await fsp.readFile(credPath, "utf8"));
      expect(persisted.claudeAiOauth.accessToken).toBe("fake-new");
      expect(persisted.claudeAiOauth.refreshToken).toBe("fake-ref2");
      expect(persisted.schemaVersion).toBe(3);
      expect((await fsp.readdir(root)).sort()).toEqual([".credentials.json"]); // no tmp/lock left
    } finally {
      if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev;
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to HOME/.claude when CLAUDE_CONFIG_DIR is unset", async () => {
    const { fsp, root } = await setup(false);
    const prevHome = process.env.HOME;
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const pathMod = await import("node:path");
    const claudeDir = pathMod.join(root, ".claude");
    await fsp.mkdir(claudeDir);
    const credPath = pathMod.join(claudeDir, ".credentials.json");
    await fsp.writeFile(
      credPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "fake-old", refreshToken: "fake-ref", expiresAt: 1 } }),
    );
    process.env.HOME = root;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const result = await ensureFreshClaudeToken({ deps: { postTokenRefresh: stubPost } });
      expect(result.refreshed).toBe(true);
      const persisted = JSON.parse(await fsp.readFile(credPath, "utf8"));
      expect(persisted.claudeAiOauth.accessToken).toBe("fake-new");
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      if (prevDir !== undefined) process.env.CLAUDE_CONFIG_DIR = prevDir;
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
