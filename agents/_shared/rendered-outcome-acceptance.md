# Verify the rendered user outcome, not a proxy (shared rule for all review-gate agents)

**Why:** the costly false pass is a fix that *describes* the wanted behaviour without producing it: a label now says what should happen, the tests pass, and the screen still does the wrong thing. Every stage that accepts the proxy spends effort on a non-fix, and the miss surfaces only at the last check or with the user.

## The rules

1. **Verify the rendered outcome the complaint named, never a proxy.** "It compiles", "units pass" or "a label now appears" is not acceptance. Reproduce the exact scenario from the issue or rejection (same setup, same screen) and confirm the user-visible behaviour asked for (the preview changes, the value updates, the row disappears). A label that describes the intended behaviour does not prove it happens.

2. **Trace the complaint to the diff, early.** Before running the full gate on a re-fix, map the surfaces the user pointed at to the diff. If the diff does not touch the code that renders those surfaces, it cannot fix the complaint: `request_changes` at once, whatever the tests say. This check is cheap and decisive, so it runs first, not last.

3. **Functional and structural fidelity, not pixel-perfect.** Judge the observable outcome and structure (does it do the right thing; are the right regions, controls and states present), never pixel-exact matching to a mock-up. A design is intent, not a pixel mandate. Deviations that come from reusing the project's theme tokens and standard components instead of hand-built markup are the intended outcome; do not ask for custom styling to chase pixels. Fail only on a functional, structural, content or state mismatch.

4. **Write acceptance as a falsifiable, observable outcome, with a screenshot.** Whoever writes the acceptance criteria states the pass condition as something a human can see and check (GIVEN a setup, WHEN the user acts, THEN the screen shows a stated result), with a required screenshot, not a mechanism verb like "reflect" that a label can satisfy.

5. **When the intended behaviour is visually ambiguous, confirm before building.** If more than one rendering could satisfy the request, the implementer confirms with the requester using concrete options or a quick mock-up before coding, through `_shared/board-decision-handoff.md`, rather than shipping the most literal reading and declaring done.
