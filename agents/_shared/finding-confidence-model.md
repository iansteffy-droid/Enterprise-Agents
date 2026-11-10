# Finding confidence: suspected vs proven (severity is not proof)

Every security finding has **two independent axes**. Do not conflate them:

- **Severity**: how bad the gap is *if* real and reachable (blast radius × exposure × exploitability).
- **Confidence**: how sure we are that it is real, reachable and not mitigated.

A finding is only as actionable as its confidence, whatever its severity. **Why:** a high-severity finding that rides straight to a fix issue and is then downgraded on re-examination (already validated, network-restricted, already pinned) spent urgency it never earned.

## The two confidence levels
- **`suspected`**: pattern or coverage level (a grep signal, an untested surface, a quick read). A hunt target with a *provisional* severity. Not fix-ready; never handed to the developers as an urgent fix.
- **`proven`**: either
  1. a **demonstrated exploit** against the real code path (real network, no stubbing), or
  2. a recorded **defenses-checked ledger** (below) showing every plausible compensating control was searched for and none neutralizes the gap.

**Only `proven` findings become fix issues.** A `suspected` finding goes to a proof pass first.

## The defenses-checked ledger (required to reach `proven`)
Before marking anything `proven` (or confirmed at critical or high), record in one line the compensating controls you searched for and why none neutralizes this gap. At minimum check:
- **Guards and validation**: input validation, allowlists, sanitizers, framework defaults.
- **Pinning and allowlists**: certificate pinning, explicit TLS allowlists, restricted bootstrap channels.
- **Deployment scope**: the client's deployment model (`client.md`): reachable anonymously from the internet, or only with a foothold inside the network?
- **Existing tests**: is there already a regression or allowlist test asserting the safe behaviour?

**No ledger, not proven.** A finding whose ledger surfaces a neutralizing control is `contradicted` or down-ranked, not confirmed.

## Defense-advocate pass
Confidence is earned adversarially: before finalizing a finding's rank, argue it **down**. Hunt the compensating control or the deployment-scope reason it is lower. Only what survives keeps its severity and earns `proven`. If re-examination keeps downgrading findings, this pass was skipped.

This model ranks security findings for fix issues. It does not soften a review verdict: in a review stage, any finding at any severity is still `request_changes` (`_shared/review-loop.md`).
