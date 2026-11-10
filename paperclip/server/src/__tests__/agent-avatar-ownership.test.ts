import { describe, expect, it } from "vitest";
import { validateAvatarAssetOwnership } from "../routes/agents.ts";

describe("validateAvatarAssetOwnership", () => {
  it("accepts an asset from the same company", () => {
    expect(
      validateAvatarAssetOwnership({ asset: { companyId: "c1" }, agentCompanyId: "c1" }),
    ).toEqual({ ok: true });
  });

  it("rejects a missing asset with 404", () => {
    const r = validateAvatarAssetOwnership({ asset: null, agentCompanyId: "c1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("rejects an asset from another company with 400", () => {
    const r = validateAvatarAssetOwnership({ asset: { companyId: "c2" }, agentCompanyId: "c1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});
