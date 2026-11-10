import { describe, expect, it } from "vitest";
import { buildAgentAvatarUrl } from "../services/agents.ts";

describe("buildAgentAvatarUrl", () => {
  it("builds the asset content path when an asset id is set", () => {
    expect(buildAgentAvatarUrl("abc-123")).toBe("/api/assets/abc-123/content");
  });

  it("returns null when no asset id", () => {
    expect(buildAgentAvatarUrl(null)).toBeNull();
    expect(buildAgentAvatarUrl(undefined)).toBeNull();
  });
});
