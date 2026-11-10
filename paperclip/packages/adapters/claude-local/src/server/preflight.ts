import { fetchWithTimeout, readClaudeToken, toPercent } from "./quota.js";

// Pre-flight access gate for subscription (OAuth) claude_local runs.
//
// Without this, auth/usage failures are only discovered AFTER a run has already
// assembled full context and called the model — so a doomed run can burn tens of
// millions of cached-input tokens before failing with `claude_auth_required` or
// `claude_usage_limit_reached`. This checks cheaply up front and, on a DEFINITE
// negative signal, fails the run fast with zero token burn. Every UNCERTAIN
// signal (missing/rate-limited/unreachable usage API, unreadable credentials)
// fails OPEN — the run proceeds exactly as before — so a healthy run is never
// blocked by a flaky probe.

export type ClaudePreflightVerdict =
  | { block: false; reason?: string }
  | {
      block: true;
      errorCode: "claude_auth_required";
      errorFamily: null;
      retryNotBefore: null;
      message: string;
    }
  | {
      block: true;
      errorCode: "claude_usage_limit_reached";
      errorFamily: "usage_limit";
      retryNotBefore: string | null;
      message: string;
    };

export interface ClaudePreflightDeps {
  /** Reads the shared OAuth access token (defaults to the credential file reader). */
  readToken: () => Promise<string | null>;
  /** Probes the Anthropic OAuth usage endpoint; returns HTTP status + parsed body. */
  fetchUsage: (token: string) => Promise<{ status: number; body: unknown }>;
}

interface FiveHourWindow {
  utilization: number | null;
  resets_at: string | null;
}

function readFiveHourWindow(body: unknown): FiveHourWindow | null {
  if (typeof body !== "object" || body === null) return null;
  const five = (body as Record<string, unknown>).five_hour;
  if (typeof five !== "object" || five === null) return null;
  const rec = five as Record<string, unknown>;
  return {
    utilization: typeof rec.utilization === "number" ? rec.utilization : null,
    resets_at: typeof rec.resets_at === "string" ? rec.resets_at : null,
  };
}

async function defaultFetchUsage(token: string): Promise<{ status: number; body: unknown }> {
  const resp = await fetchWithTimeout(
    "https://api.anthropic.com/api/oauth/usage",
    { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" } },
    6_000,
  );
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  return { status: resp.status, body };
}

/**
 * Decide whether a subscription claude_local run should be blocked before it
 * spends any tokens. Callers should only invoke this for subscription billing;
 * API-key runs have no OAuth token and must never be gated here.
 */
export async function evaluateClaudePreflight(
  opts: { sessionBlockPercent?: number; configDir?: string | null; deps?: Partial<ClaudePreflightDeps> } = {},
): Promise<ClaudePreflightVerdict> {
  const blockPercent = opts.sessionBlockPercent ?? 100;
  const readToken = opts.deps?.readToken ?? (() => readClaudeToken(opts.configDir));
  const fetchUsage = opts.deps?.fetchUsage ?? defaultFetchUsage;

  let token: string | null;
  try {
    token = await readToken();
  } catch {
    return { block: false, reason: "token_read_error" };
  }
  if (!token) {
    return {
      block: true,
      errorCode: "claude_auth_required",
      errorFamily: null,
      retryNotBefore: null,
      message: "Claude subscription credentials are missing; run `claude login`.",
    };
  }

  let response: { status: number; body: unknown };
  try {
    response = await fetchUsage(token);
  } catch {
    return { block: false, reason: "usage_fetch_error" };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      block: true,
      errorCode: "claude_auth_required",
      errorFamily: null,
      retryNotBefore: null,
      message: "Claude subscription token was rejected (auth error); run `claude login`.",
    };
  }
  if (response.status < 200 || response.status >= 300) {
    // Rate-limited / server error / anything non-2xx that is not auth: cannot
    // conclude the run is doomed, so proceed as before.
    return { block: false, reason: `usage_status_${response.status}` };
  }

  const fiveHour = readFiveHourWindow(response.body);
  const usedPercent = toPercent(fiveHour?.utilization ?? null);
  if (usedPercent != null && usedPercent >= blockPercent) {
    return {
      block: true,
      errorCode: "claude_usage_limit_reached",
      errorFamily: "usage_limit",
      retryNotBefore: fiveHour?.resets_at ?? null,
      message: `Claude 5-hour session usage is exhausted (${usedPercent}%); deferring until it resets.`,
    };
  }

  return { block: false };
}
