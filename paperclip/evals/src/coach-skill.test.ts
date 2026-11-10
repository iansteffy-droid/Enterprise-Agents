import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
  "paperclip-eval-coach",
  "SKILL.md",
);

describe("paperclip-eval-coach skill", () => {
  it("has valid frontmatter and the required workflow guardrails", async () => {
    const text = await readFile(skillPath, "utf8");
    // frontmatter with name + description
    expect(text.startsWith("---\n")).toBe(true);
    expect(/\nname:\s*paperclip-eval-coach\b/.test(text)).toBe(true);
    expect(/\ndescription:\s*\S/.test(text)).toBe(true);
    // must reference the packet CLI, the apply mechanism, and the human-approval gate
    expect(text).toContain("evals:coach-packet");
    expect(text).toContain("PATCH /api/agents/");
    expect(text.toLowerCase()).toContain("approval");
    expect(text).toContain("config-revisions");
  });
});
