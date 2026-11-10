import { describe, expect, it } from "vitest";
import { updateAgentSchema } from "./agent.js";

describe("updateAgentSchema avatarAssetId", () => {
  it("accepts a uuid", () => {
    const parsed = updateAgentSchema.parse({
      avatarAssetId: "11111111-1111-4111-8111-111111111111",
    });
    expect(parsed.avatarAssetId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("accepts null (removes the picture)", () => {
    const parsed = updateAgentSchema.parse({ avatarAssetId: null });
    expect(parsed.avatarAssetId).toBeNull();
  });

  it("rejects a non-uuid string", () => {
    expect(() => updateAgentSchema.parse({ avatarAssetId: "not-a-uuid" })).toThrow();
  });
});
