import { describe, expect, it } from "vitest";
import { getRoleProfile, isRoleProfileId, ROLE_PROFILE_IDS } from "../src/roles/role-profiles.js";
import { buildRoleSystemPrompt } from "../src/roles/system-prompts.js";
import type { RoleSpec } from "../src/types.js";

function role(profile: RoleSpec["profile"]): RoleSpec {
	return {
		name: "verifier",
		profile,
		description: "Verifies the generated project.",
		ownedDirectories: ["tests/e2e", "docs/e2e-report.md"],
	};
}

describe("role profiles", () => {
	it("defines fixed runtime config for every built-in profile", () => {
		expect(ROLE_PROFILE_IDS).toEqual([
			"project-setup",
			"backend-engineer",
			"data-engineer",
			"frontend-engineer",
			"test-engineer",
			"e2e-verifier",
			"docs-engineer",
		]);

		for (const id of ROLE_PROFILE_IDS) {
			const profile = getRoleProfile(id);
			expect(profile?.allowedTools.length).toBeGreaterThan(0);
			expect(profile?.systemPromptTitle).toContain("Agent");
			expect(profile?.maxTurns).toBe(200);
		}
		expect(isRoleProfileId("custom-engineer")).toBe(false);
	});

	it("builds an e2e verifier prompt focused on final end-to-end validation", () => {
		const prompt = buildRoleSystemPrompt(role("e2e-verifier"));

		expect(prompt).toContain("End-to-End Verification Agent");
		expect(prompt).toContain("npm run start");
		expect(prompt).toContain("localhost");
		expect(prompt).toContain("ordinary unit tests");
		expect(prompt).toContain("docs/e2e-report.md");
		expect(prompt).toContain("complete user workflows");
	});

	it("describes open and owned permission modes differently", () => {
		const openPrompt = buildRoleSystemPrompt(role("backend-engineer"), "open");
		const ownedPrompt = buildRoleSystemPrompt(role("backend-engineer"), "owned");

		expect(openPrompt).toContain("Prefer your assigned paths");
		expect(openPrompt).toContain("may edit other project files");
		expect(ownedPrompt).toContain("Only write files inside your owned paths");
	});

	it("describes open and restricted execution modes differently", () => {
		const openPrompt = buildRoleSystemPrompt(role("backend-engineer"), "open", "open");
		const restrictedPrompt = buildRoleSystemPrompt(role("backend-engineer"), "open", "restricted");

		expect(openPrompt).toContain("Execution is open");
		expect(openPrompt).toContain("approval flow");
		expect(restrictedPrompt).toContain("Execution is restricted");
	});

	it("keeps docs engineer away from bash execution", () => {
		const profile = getRoleProfile("docs-engineer");

		expect(profile?.allowedTools).toEqual(["read", "write", "edit", "grep", "find", "ls"]);
	});
});
