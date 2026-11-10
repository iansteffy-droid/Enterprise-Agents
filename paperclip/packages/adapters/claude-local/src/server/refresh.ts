import fs from "node:fs/promises";
import path from "node:path";

import { claudeConfigDir, fetchWithTimeout } from "./quota.js";

// Proactive, fleet-serialized OAuth token refresh for subscription claude_local
// runs.
//
// A fleet of agents shares one <CLAUDE_CONFIG_DIR>/.credentials.json (default ~/.claude). The access token is
// short-lived; when it expires, concurrent `claude` launches all try to refresh
// at once and race to rotate a single-use refresh token — the loser gets
// "401 OAuth access token has expired. Re-authenticate to continue." and the run
// fails with adapter_failed. Refreshing ourselves under a cross-process lock
// BEFORE spawning the CLI keeps the launched process on a valid token so it never
// needs to refresh, eliminating the race. Everything fails OPEN: on any problem
// we leave the credentials untouched and let the CLI behave exactly as before.
//
// Coordinates were extracted authoritatively from the Claude Code CLI bundle:
//   TOKEN_URL = https://platform.claude.com/v1/oauth/token
//   CLIENT_ID = 9d1c250a-e61b-44d9-88ed-5944d1962f5e
//   refresh body = { grant_type: "refresh_token", refresh_token, client_id }
//   response     = { access_token, expires_in, refresh_token? }
const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Refresh once the access token has this little life left (or is already expired).
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const REFRESH_HTTP_TIMEOUT_MS = 10 * 1000;
// Lock guards the shared credential file across the fleet.
const LOCK_FILENAME = ".paperclip-token-refresh.lock";
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 8 * 1000;
const LOCK_POLL_MS = 150;

const CREDENTIAL_FILENAMES = [".credentials.json", "credentials.json"] as const;

export type ClaudeTokenRefreshResult =
  | { refreshed: false; reason: string }
  | { refreshed: true; expiresAt: number };

export interface ClaudeCredentialFile {
  filePath: string;
  parsed: Record<string, unknown>;
  oauth: Record<string, unknown>;
}

export interface ClaudeTokenRefreshDeps {
  /** Reads and parses the shared OAuth credential file (first match wins). */
  readCredentialFile: () => Promise<ClaudeCredentialFile | null>;
  /** Atomically persists updated credential JSON back to disk. */
  writeCredentialFile: (filePath: string, contents: string) => Promise<void>;
  /** POSTs a refresh-token grant; returns HTTP status + parsed JSON body. */
  postTokenRefresh: (refreshToken: string) => Promise<{ status: number; body: unknown }>;
  /** Current epoch millis (injectable for tests). */
  now: () => number;
  /** Acquires the cross-process refresh lock, or null if it could not be taken. */
  acquireLock: () => Promise<{ release: () => Promise<void> } | null>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function defaultReadCredentialFile(configDir: string): Promise<ClaudeCredentialFile | null> {
  for (const filename of CREDENTIAL_FILENAMES) {
    const filePath = path.join(configDir, filename);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    const oauth = obj.claudeAiOauth;
    if (typeof oauth !== "object" || oauth === null) continue;
    return { filePath, parsed: obj, oauth: oauth as Record<string, unknown> };
  }
  return null;
}

async function defaultWriteCredentialFile(filePath: string, contents: string): Promise<void> {
  // Write to a sibling temp file then rename, so a reader never observes a
  // half-written credential file. Credentials stay owner-only (0600).
  const tmpPath = `${filePath}.paperclip-${process.pid}.tmp`;
  await fs.writeFile(tmpPath, contents, { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

async function defaultPostTokenRefresh(
  refreshToken: string,
): Promise<{ status: number; body: unknown }> {
  const resp = await fetchWithTimeout(
    CLAUDE_OAUTH_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
    },
    REFRESH_HTTP_TIMEOUT_MS,
  );
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  return { status: resp.status, body };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultAcquireLock(
  configDir: string,
  now: () => number,
): Promise<{ release: () => Promise<void> } | null> {
  const lockPath = path.join(configDir, LOCK_FILENAME);
  const deadline = now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: now() }));
      await handle.close();
      return {
        release: async () => {
          try {
            await fs.unlink(lockPath);
          } catch {
            /* already gone */
          }
        },
      };
    } catch {
      // Lock held. Steal it if it is stale, otherwise wait and retry.
      try {
        const stat = await fs.stat(lockPath);
        if (now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        // Lock vanished between open and stat — retry immediately.
        continue;
      }
      if (now() >= deadline) return null;
      await sleep(LOCK_POLL_MS);
    }
  }
}

function defaultDeps(configDir: string): ClaudeTokenRefreshDeps {
  const now = () => Date.now();
  return {
    readCredentialFile: () => defaultReadCredentialFile(configDir),
    writeCredentialFile: defaultWriteCredentialFile,
    postTokenRefresh: defaultPostTokenRefresh,
    now,
    acquireLock: () => defaultAcquireLock(configDir, now),
  };
}

/**
 * Refresh the shared Claude subscription OAuth access token when it is at/near
 * expiry, serialized across the fleet so agents do not race to rotate the
 * refresh token. Safe to call before every subscription run: it is a cheap
 * no-op when the token is still fresh, and never throws.
 */
export async function ensureFreshClaudeToken(
  opts: {
    /**
     * The run's resolved CLAUDE_CONFIG_DIR (from adapterConfig.env). When unset
     * or blank, falls back to the process env, then `$HOME/.claude`.
     */
    configDir?: string | null;
    deps?: Partial<ClaudeTokenRefreshDeps>;
  } = {},
): Promise<ClaudeTokenRefreshResult> {
  const explicitDir = typeof opts.configDir === "string" ? opts.configDir.trim() : "";
  const deps = { ...defaultDeps(explicitDir || claudeConfigDir()), ...opts.deps };
  try {
    const cred = await deps.readCredentialFile();
    if (!cred) return { refreshed: false, reason: "no_credentials" };

    const refreshToken = readString(cred.oauth.refreshToken);
    const expiresAt = readNumber(cred.oauth.expiresAt);
    // No refresh token / expiry means this is an API-key or unmanaged setup —
    // nothing for us to refresh.
    if (!refreshToken) return { refreshed: false, reason: "no_refresh_token" };
    if (expiresAt == null) return { refreshed: false, reason: "no_expiry" };
    if (expiresAt - deps.now() > REFRESH_THRESHOLD_MS) {
      return { refreshed: false, reason: "still_fresh" };
    }

    const lock = await deps.acquireLock();
    if (!lock) return { refreshed: false, reason: "lock_unavailable" };
    try {
      // Re-read under the lock: a peer may have refreshed while we waited.
      const current = (await deps.readCredentialFile()) ?? cred;
      const currentExpiry = readNumber(current.oauth.expiresAt);
      if (currentExpiry != null && currentExpiry - deps.now() > REFRESH_THRESHOLD_MS) {
        return { refreshed: false, reason: "refreshed_by_peer" };
      }
      const currentRefreshToken = readString(current.oauth.refreshToken) ?? refreshToken;

      const resp = await deps.postTokenRefresh(currentRefreshToken);
      if (resp.status < 200 || resp.status >= 300) {
        return { refreshed: false, reason: `refresh_http_${resp.status}` };
      }
      const body =
        typeof resp.body === "object" && resp.body !== null
          ? (resp.body as Record<string, unknown>)
          : {};
      const accessToken = readString(body.access_token);
      const expiresIn = readNumber(body.expires_in);
      if (!accessToken || expiresIn == null) {
        return { refreshed: false, reason: "refresh_bad_response" };
      }

      const newExpiresAt = deps.now() + expiresIn * 1000;
      // A rotated refresh token replaces the old one; if the response omits it,
      // the current refresh token is still valid.
      const newRefreshToken = readString(body.refresh_token) ?? currentRefreshToken;
      const nextOauth = {
        ...current.oauth,
        accessToken,
        refreshToken: newRefreshToken,
        expiresAt: newExpiresAt,
      };
      const nextParsed = { ...current.parsed, claudeAiOauth: nextOauth };
      await deps.writeCredentialFile(current.filePath, JSON.stringify(nextParsed, null, 2));
      return { refreshed: true, expiresAt: newExpiresAt };
    } finally {
      await lock.release().catch(() => {});
    }
  } catch {
    return { refreshed: false, reason: "refresh_error" };
  }
}
