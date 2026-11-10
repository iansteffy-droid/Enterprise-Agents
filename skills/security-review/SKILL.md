---
name: security-review
description: Security review of a branch for any web repository. OWASP-style checklist, secrets scan and dependency audit as generic steps, with compliance rules taken from the profile. Use when security-reviewing a feature branch that touches security-relevant paths.
---

# Security review

This is the security lens; general correctness, lint and style belong to the `code-review` skill. Treat data-protection failures as high-impact. Assume all input is untrusted, all secrets are leaked and all new dependencies are unvetted. Verbs and re-review are in `_shared/review-loop.md`; ranking is in `_shared/finding-confidence-model.md`.

## Gate first
Compute the changed files against the base and match them to `_shared/security-relevant-paths.md` plus the profile's `## Security paths`. No match: `approve` with the "No security-relevant paths changed" comment. A match: run the steps below on the matched files.

## Known baseline
Read the client `CLAUDE.md` and the profile's `## House rules` for documented, accepted gaps. Flag regressions and new exposure that widen them; do not re-litigate the baseline.

## Workflow
1. **Diff:** `git diff "$BASE"...HEAD` and `git diff --name-status "$BASE"...HEAD`; read matched files in full where context matters.
2. **Secrets scan:** keys, tokens and passwords as literals; private keys and certificates; connection strings; shared secrets; an added `.env`; environment values printed, logged or returned in responses. A "test" key is still a leaked key.
3. **Checklist** (cite `file:line`):
   - **Injection:** where the stack has the relevant surface: query or operator injection through user-controlled input, SQL built from input, shell or template injection. Queries are parameterized, and input handling follows the house rules (field whitelists, parameter type checks).
   - **Broken authentication:** token signatures verified, no unsigned-token acceptance, guards on every new endpoint, rate limiting on login, reset and one-time-code flows.
   - **Session lifecycle** (where the stack has sessions or tokens; any change to authentication, sessions, tokens or credentials): logout revokes server-side (a client-only clear is not logout); a credential change invalidates the account's other sessions on the production path (find the revocation call itself, not just a method that exists); rotation of single-use tokens is one atomic claim, not read-check-write; an upstream outage surfaces as a server error, never as an auth rejection that counts toward lockout; block, delete and logout-all revoke every live session and any other live connection the stack keeps open.
   - **Access control:** authorization from server context, never client-supplied parameters; object-level checks (IDOR) and tenant scoping on new endpoints; privileged routes gated.
   - **Sensitive data:** personal data or secrets in errors, logs or over-broad responses; transport encryption enforced.
   - **Mass assignment:** controllers persisting the raw request body instead of a whitelist.
   - **Header and output injection:** values sanitized before becoming headers or keys; user-controlled values never rendered unescaped.
   - **Misconfiguration:** wildcard CORS, verbose stack traces on production paths, permissive uploads, containers running as root or carrying secrets.
   - **Crypto:** weak hashes for security, hardcoded keys or IVs, non-cryptographic randomness for tokens, ECB.
   - **Audit logging:** each entry records actor, target, action and result; a no-op must not log a success.
   - **Compliance:** apply the profile's compliance notes under `## House rules` (data-protection and sector rules); a violation is a finding.
4. **Dependencies:** when a lockfile or manifest changed, run the package manager's audit and read the dependency diff. Vet each new package: well known and maintained, purpose matches usage, no typosquatting.
5. **Report** only confident findings, by severity: Critical (secrets, auth bypass, injection, privilege escalation), High (XSS, missing auth checks, weak crypto in production paths), Medium (verbose errors, missing rate limits, insecure defaults), Low (defense in depth). Each: vulnerability type, `file:line`, why it matters, a specific fix; include the audit output.
6. **Verdict:** any finding is `request_changes`; none is `approve` (`_shared/review-loop.md`). Record an accepted risk the operator has decided in the issue rather than dropping it silently.
