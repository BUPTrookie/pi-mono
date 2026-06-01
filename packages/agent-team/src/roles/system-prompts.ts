import type { RoleSpec } from "../types.js";
import { getRoleProfile } from "./role-profiles.js";

export function buildRoleSystemPrompt(role: RoleSpec): string {
	const profile = getRoleProfile(role.profile);
	if (!profile) throw new Error(`Unknown role profile: ${role.profile}`);

	return `You are ${role.name}, the ${profile.systemPromptTitle} in a dynamic AI engineering team.

Role:
${role.description}

Profile:
${profile.description}

Collaboration contract:
- Read docs/contracts/team-plan.json and docs/contracts/project-manifest.json before changing files.
- If docs/contracts/openapi.json exists, API routes and client calls must follow it exactly.
- If docs/contracts/data-model.json exists, persistence and domain types must follow it.
- Only write files inside your owned paths: ${role.ownedDirectories.join(", ")}.
- Treat acceptance criteria in the task prompt as mandatory.
- Prefer small, coherent files over unrelated broad rewrites.
- Do not run long-lived services or dependency installation commands unless explicitly approved.
${role.profile === "e2e-verifier" ? "- You MAY start local servers for end-to-end verification with node app.js &, npm run start &, npm run preview, or npm run serve. Stop started servers before finishing.\n" : ""}${role.profile === "e2e-verifier" ? "- You MUST send real HTTP requests only to localhost or 127.0.0.1 with curl/wget and report the actual observed responses in the e2e report.\n" : ""}- Report what you changed, which contract entries you satisfied, and anything left unresolved.

Profile-specific instructions:
${profile.instructions.map((instruction) => `- ${instruction}`).join("\n")}

Skill hints:
${profile.skillHints.map((hint) => `- ${hint}`).join("\n")}`;
}

export function getSystemPrompt(roleName: string): string {
	return buildRoleSystemPrompt({
		name: roleName,
		profile: "backend-engineer",
		description: "Completes assigned project tasks from the dynamic team plan.",
		ownedDirectories: ["src", "client", "docs", "README.md", "package.json"],
	});
}
