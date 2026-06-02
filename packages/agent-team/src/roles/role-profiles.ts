import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { RoleProfileId } from "../types.js";

export interface RoleProfile {
	id: RoleProfileId;
	systemPromptTitle: string;
	description: string;
	allowedTools: string[];
	maxTurns: number;
	thinkingLevelOverride?: ThinkingLevel;
	skillHints: string[];
	instructions: string[];
}

const FULL_TOOLSET = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const READ_AND_CHECK_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const DOCS_TOOLSET = ["read", "write", "edit", "grep", "find", "ls"];

export const ROLE_PROFILE_IDS = [
	"project-setup",
	"backend-engineer",
	"data-engineer",
	"frontend-engineer",
	"test-engineer",
	"e2e-verifier",
	"docs-engineer",
] as const satisfies readonly RoleProfileId[];

const ROLE_PROFILES: Record<RoleProfileId, RoleProfile> = {
	"project-setup": {
		id: "project-setup",
		systemPromptTitle: "Project Setup Agent",
		description: "Creates package metadata, project structure, scripts, configuration, and README foundations.",
		allowedTools: FULL_TOOLSET,
		maxTurns: 200,
		skillHints: ["project scaffolding", "package scripts", "configuration hygiene"],
		instructions: [
			"Create the smallest useful project skeleton that downstream agents can build on.",
			"Prefer pure JavaScript dependencies and scripts that run in a clean Node environment.",
			"Keep package scripts explicit and useful for checks, tests, builds, or project startup.",
		],
	},
	"backend-engineer": {
		id: "backend-engineer",
		systemPromptTitle: "Backend Engineering Agent",
		description: "Implements APIs, server behavior, routing, and backend business logic.",
		allowedTools: FULL_TOOLSET,
		maxTurns: 200,
		skillHints: ["API implementation", "server architecture", "contract alignment"],
		instructions: [
			"Implement backend behavior exactly from OpenAPI and project contracts when they exist.",
			"Keep route handlers, services, and validation logic easy to test independently.",
			"Run focused syntax or package checks after backend changes when scripts are available.",
		],
	},
	"data-engineer": {
		id: "data-engineer",
		systemPromptTitle: "Data Engineering Agent",
		description: "Implements schemas, persistence adapters, seed data, and domain data flows.",
		allowedTools: FULL_TOOLSET,
		maxTurns: 200,
		skillHints: ["data modeling", "persistence", "migration-free local storage"],
		instructions: [
			"Follow data-model contracts exactly when present.",
			"Prefer pure JavaScript or file-backed persistence over native addons.",
			"Keep data helpers deterministic and easy for API and test agents to use.",
		],
	},
	"frontend-engineer": {
		id: "frontend-engineer",
		systemPromptTitle: "Frontend Engineering Agent",
		description: "Implements UI, client state, app shell, and browser-facing behavior.",
		allowedTools: FULL_TOOLSET,
		maxTurns: 200,
		skillHints: ["frontend implementation", "client integration", "responsive UI checks"],
		instructions: [
			"Implement user-facing flows from the project manifest and API contracts.",
			"Keep UI code cohesive, accessible, and connected to real client behavior.",
			"Run focused frontend checks or builds when package scripts are available.",
		],
	},
	"test-engineer": {
		id: "test-engineer",
		systemPromptTitle: "Test Engineering Agent",
		description: "Writes unit and integration tests for specific modules or contracts.",
		allowedTools: FULL_TOOLSET,
		maxTurns: 200,
		thinkingLevelOverride: "low",
		skillHints: ["unit testing", "integration testing", "regression coverage"],
		instructions: [
			"Write focused unit or integration tests for assigned modules.",
			"Do not take over final end-to-end verification; that belongs to e2e-verifier.",
			"Run the narrowest relevant test command after creating or changing tests.",
		],
	},
	"e2e-verifier": {
		id: "e2e-verifier",
		systemPromptTitle: "End-to-End Verification Agent",
		description: "Runs final project-level validation across completed implementation and writes the E2E report.",
		allowedTools: READ_AND_CHECK_TOOLS,
		maxTurns: 200,
		thinkingLevelOverride: "medium",
		skillHints: ["end-to-end testing", "acceptance verification", "delivery review"],
		instructions: [
			"Verify complete user workflows by actually running the service and sending real HTTP requests.",
			"For HTTP servers: start in background with node src/app.js &, npm run start &, npm run preview, or npm run serve; use only localhost or 127.0.0.1 URLs; verify responses; then stop the server.",
			"For CLIs: run with sample inputs and verify the output matches expectations.",
			"Run npm test (or equivalent) and report exit code and any failures.",
			"Do not write ordinary unit tests; unit and module tests belong to implementation or test-engineer tasks.",
			"Write docs/e2e-report.md with every scenario command, exit code or status, observed result, evidence, and acceptance status as PASS or FAIL.",
			"If a workflow fails because upstream implementation is wrong, report suspectedOwnerTaskId or suspectedFile when you can infer it, but do not fix business code yourself.",
		],
	},
	"docs-engineer": {
		id: "docs-engineer",
		systemPromptTitle: "Documentation Agent",
		description: "Writes usage documentation, handoff notes, and project-facing docs.",
		allowedTools: DOCS_TOOLSET,
		maxTurns: 200,
		skillHints: ["technical writing", "handoff documentation", "usage instructions"],
		instructions: [
			"Document what was built and how to run or validate it.",
			"Do not invent behavior that is not represented in contracts or implementation files.",
			"Keep docs concise and accurate for the generated project.",
		],
	},
};

export function isRoleProfileId(value: string): value is RoleProfileId {
	return (ROLE_PROFILE_IDS as readonly string[]).includes(value);
}

export function getRoleProfile(id: RoleProfileId): RoleProfile;
export function getRoleProfile(id: string): RoleProfile | undefined;
export function getRoleProfile(id: string): RoleProfile | undefined {
	return isRoleProfileId(id) ? ROLE_PROFILES[id] : undefined;
}

export function formatRoleProfilesForPlanner(): string {
	return ROLE_PROFILE_IDS.map((id) => {
		const profile = ROLE_PROFILES[id];
		return `- ${profile.id}: ${profile.description} Tools: ${profile.allowedTools.join(", ")}. Max turns: ${profile.maxTurns}.`;
	}).join("\n");
}
