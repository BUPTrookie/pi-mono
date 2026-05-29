import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildRoleSystemPrompt } from "../roles/system-prompts.js";
import type {
	ContractSpec,
	RepairTask,
	RoleDefinition,
	RoleSpec,
	Task,
	TaskSpec,
	TeamPlan,
	ValidationIssue,
} from "../types.js";

function includesAny(text: string, terms: string[]): boolean {
	const lower = text.toLowerCase();
	return terms.some((term) => lower.includes(term));
}

function roleFromSpec(spec: RoleSpec): RoleDefinition {
	return {
		name: spec.name,
		description: spec.description,
		systemPrompt: spec.systemPrompt ?? buildRoleSystemPrompt(spec),
		allowedTools: spec.allowedTools,
		ownedDirectories: spec.ownedDirectories,
		maxTurns: spec.maxTurns,
	};
}

export function createRoleRegistry(plan: TeamPlan): Map<string, RoleDefinition> {
	const registry = new Map<string, RoleDefinition>();
	for (const role of plan.roles) {
		registry.set(role.name, roleFromSpec(role));
	}
	return registry;
}

export function taskFromSpec(spec: TaskSpec): Task {
	return {
		id: spec.id,
		role: spec.role,
		subject: spec.subject,
		description: spec.description,
		dependencies: spec.dependencies,
		status: "pending",
		expectedOutputs: spec.expectedOutputs,
		acceptanceCriteria: spec.acceptanceCriteria,
		repairOf: spec.repairOf,
	};
}

function contract(path: string, kind: ContractSpec["kind"], required: boolean): ContractSpec {
	return { path, kind, required };
}

export function createTeamPlan(requirement: string): TeamPlan {
	const hasApi = includesAny(requirement, [
		"api",
		"crud",
		"backend",
		"server",
		"auth",
		"login",
		"database",
		"db",
		"poll",
		"vote",
		"sse",
		"server-sent",
	]);
	const hasData = hasApi || includesAny(requirement, ["sqlite", "postgres", "mysql", "schema", "model", "store"]);
	const hasFrontend = includesAny(requirement, [
		"frontend",
		"ui",
		"web",
		"page",
		"dashboard",
		"react",
		"todo",
		"poll",
		"vote",
		"tailwind",
		"dark",
		"full stack",
		"full-stack",
	]);
	const hasDeployment = includesAny(requirement, ["docker", "deploy", "deployment", "compose", "production"]);

	const contracts = [
		contract("docs/contracts/team-plan.json", "team-plan", true),
		contract("docs/contracts/project-manifest.json", "project-manifest", true),
	];
	if (hasApi) contracts.push(contract("docs/contracts/openapi.json", "openapi", true));
	if (hasData) contracts.push(contract("docs/contracts/data-model.json", "data-model", true));

	const roles: RoleSpec[] = [];
	const tasks: TaskSpec[] = [];

	if (hasApi) {
		roles.push({
			name: "api-builder",
			description: "Implements the backend API and root package scripts from the contracts.",
			allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
			ownedDirectories: ["src", "package.json", ".env.example"],
			maxTurns: 40,
		});
		tasks.push({
			id: "task-api",
			role: "api-builder",
			subject: "Backend API implementation",
			description:
				"Implement the backend application from docs/contracts/project-manifest.json, docs/contracts/openapi.json, and docs/contracts/data-model.json when present.",
			dependencies: [],
			ownedDirectories: ["src", "package.json", ".env.example"],
			expectedOutputs: ["src", "package.json"],
			acceptanceCriteria: [
				"Root package.json contains scripts needed to run or check the backend.",
				"Implemented routes match docs/contracts/openapi.json when that contract exists.",
				"Data access matches docs/contracts/data-model.json when that contract exists.",
			],
		});
	}

	if (hasFrontend) {
		roles.push({
			name: "ui-builder",
			description: "Implements the user interface and client-side API integration from the contracts.",
			allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
			ownedDirectories: ["client"],
			maxTurns: 40,
		});
		tasks.push({
			id: "task-ui",
			role: "ui-builder",
			subject: "User interface implementation",
			description:
				"Implement the frontend in client/ from docs/contracts/project-manifest.json and docs/contracts/openapi.json when present.",
			dependencies: hasApi ? ["task-api"] : [],
			ownedDirectories: ["client"],
			expectedOutputs: ["client"],
			acceptanceCriteria: [
				"UI covers the user-facing requirements.",
				"Client API calls match docs/contracts/openapi.json when that contract exists.",
				"Forms and error states are represented where the requirement needs them.",
			],
		});
	}

	if (!hasApi && !hasFrontend) {
		roles.push({
			name: "project-builder",
			description: "Implements the requested project from the contracts.",
			allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
			ownedDirectories: ["src", "package.json", "README.md"],
			maxTurns: 35,
		});
		tasks.push({
			id: "task-build",
			role: "project-builder",
			subject: "Project implementation",
			description: "Implement the requested project from docs/contracts/project-manifest.json.",
			dependencies: [],
			ownedDirectories: ["src", "package.json", "README.md"],
			expectedOutputs: ["src", "package.json"],
			acceptanceCriteria: [
				"Implementation satisfies the project manifest.",
				"README explains how to run the project.",
			],
		});
	}

	roles.push({
		name: "integration-writer",
		description:
			"Writes project documentation and lightweight integration artifacts without running long-lived services.",
		allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
		ownedDirectories: hasDeployment
			? ["README.md", "scripts", "Dockerfile", "docker-compose.yml", ".env.example"]
			: ["README.md", "scripts", ".env.example"],
		maxTurns: 25,
	});
	tasks.push({
		id: "task-integration",
		role: "integration-writer",
		subject: "Documentation and integration artifacts",
		description:
			"Read the contracts and implemented files. Write README.md, lightweight setup scripts, and deployment artifacts only when requested. Do not run npm install or start long-lived services.",
		dependencies: tasks.map((task) => task.id),
		ownedDirectories: hasDeployment
			? ["README.md", "scripts", "Dockerfile", "docker-compose.yml", ".env.example"]
			: ["README.md", "scripts", ".env.example"],
		expectedOutputs: ["README.md"],
		acceptanceCriteria: [
			"README describes the project, contracts, setup, and run commands.",
			"Scripts are lightweight and do not assume services are already running.",
		],
	});

	return {
		id: `plan-${Date.now()}`,
		summary: hasApi
			? "Dynamic API-oriented implementation plan generated from the user requirement."
			: "Dynamic implementation plan generated from the user requirement.",
		roles,
		tasks,
		contracts,
		validationRules: [
			"All required contract files must exist.",
			"Task expected outputs must exist after execution.",
			"OpenAPI paths must be represented by backend and frontend code when applicable.",
			"Root package.json must be valid JSON and expose at least one useful script when present.",
		],
	};
}

function writeJson(outputDir: string, relativePath: string, value: unknown): void {
	const absolutePath = join(outputDir, relativePath);
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function buildProjectManifest(requirement: string, plan: TeamPlan): Record<string, unknown> {
	return {
		requirement,
		summary: plan.summary,
		features: inferFeatures(requirement),
		tasks: plan.tasks.map((task) => ({
			id: task.id,
			role: task.role,
			subject: task.subject,
			expectedOutputs: task.expectedOutputs,
			acceptanceCriteria: task.acceptanceCriteria,
		})),
	};
}

function inferFeatures(requirement: string): string[] {
	const features: string[] = [];
	if (includesAny(requirement, ["auth", "login", "register", "session"])) {
		features.push("session-based authentication", "user registration and login");
	}
	if (includesAny(requirement, ["poll", "vote"])) {
		features.push("poll creation", "single vote per user per poll", "poll expiration");
	}
	if (includesAny(requirement, ["sse", "server-sent", "real-time", "realtime", "实时"])) {
		features.push("server-sent events for realtime updates");
	}
	if (includesAny(requirement, ["search", "filter", "active", "expired", "my polls"])) {
		features.push("search and status/ownership filters");
	}
	if (includesAny(requirement, ["tailwind", "dark"])) {
		features.push("Tailwind CSS dark theme");
	}
	if (includesAny(requirement, ["validation", "error"])) {
		features.push("input validation and user-facing errors");
	}
	return features;
}

function response(description: string): Record<string, unknown> {
	return { description };
}

function requestJson(required: string[]): Record<string, unknown> {
	return {
		required: true,
		content: {
			"application/json": {
				schema: {
					type: "object",
					required,
					additionalProperties: true,
				},
			},
		},
	};
}

function buildOpenApi(requirement: string): Record<string, unknown> {
	const wantsAuth = includesAny(requirement, ["auth", "login", "user"]);
	const wantsPolling = includesAny(requirement, ["poll", "vote"]);
	const wantsSse = includesAny(requirement, ["sse", "server-sent", "real-time", "realtime", "实时"]);
	if (wantsPolling) {
		const paths: Record<string, unknown> = {
			"/api/auth/register": {
				post: {
					summary: "Register a user and create a session",
					requestBody: requestJson(["email", "password", "name"]),
					responses: { "201": response("Registered"), "400": response("Validation error") },
				},
			},
			"/api/auth/login": {
				post: {
					summary: "Login with session-based authentication",
					requestBody: requestJson(["email", "password"]),
					responses: { "200": response("Authenticated"), "401": response("Invalid credentials") },
				},
			},
			"/api/auth/logout": {
				post: { summary: "Destroy current session", responses: { "204": response("Logged out") } },
			},
			"/api/me": {
				get: {
					summary: "Get the current authenticated user",
					responses: { "200": response("Current user"), "401": response("Unauthenticated") },
				},
			},
			"/api/polls": {
				get: {
					summary: "List polls with search and filters",
					parameters: [
						{ name: "q", in: "query", schema: { type: "string" } },
						{ name: "status", in: "query", schema: { type: "string", enum: ["active", "expired"] } },
						{ name: "mine", in: "query", schema: { type: "boolean" } },
					],
					responses: { "200": response("Poll list") },
				},
				post: {
					summary: "Create a poll with options and expiration",
					requestBody: requestJson(["title", "options", "expiresAt"]),
					responses: {
						"201": response("Poll created"),
						"400": response("Validation error"),
						"401": response("Unauthenticated"),
					},
				},
			},
			"/api/polls/{pollId}": {
				get: {
					summary: "Get poll details and current results",
					parameters: [{ name: "pollId", in: "path", required: true, schema: { type: "string" } }],
					responses: { "200": response("Poll details"), "404": response("Poll not found") },
				},
			},
			"/api/polls/{pollId}/votes": {
				post: {
					summary: "Cast one vote for a poll option; each user may vote once per poll",
					parameters: [{ name: "pollId", in: "path", required: true, schema: { type: "string" } }],
					requestBody: requestJson(["optionId"]),
					responses: {
						"201": response("Vote recorded"),
						"400": response("Invalid or expired poll"),
						"401": response("Unauthenticated"),
						"409": response("User already voted on this poll"),
					},
				},
			},
		};
		if (wantsSse) {
			paths["/api/polls/{pollId}/events"] = {
				get: {
					summary: "Subscribe to Server-Sent Events for poll result updates",
					parameters: [{ name: "pollId", in: "path", required: true, schema: { type: "string" } }],
					responses: { "200": { description: "text/event-stream poll updates" } },
				},
			};
		}

		return {
			openapi: "3.1.0",
			info: { title: "Realtime polling API", version: "0.1.0" },
			paths,
		};
	}

	const noun = includesAny(requirement, ["todo", "task"]) ? "todos" : "items";
	const paths: Record<string, unknown> = {
		[`/api/${noun}`]: {
			get: { summary: `List ${noun}`, responses: { "200": { description: "Success" } } },
			post: { summary: `Create ${noun.slice(0, -1) || noun}`, responses: { "201": { description: "Created" } } },
		},
		[`/api/${noun}/{id}`]: {
			get: { summary: `Get ${noun.slice(0, -1) || noun}`, responses: { "200": { description: "Success" } } },
			put: { summary: `Update ${noun.slice(0, -1) || noun}`, responses: { "200": { description: "Success" } } },
			delete: { summary: `Delete ${noun.slice(0, -1) || noun}`, responses: { "204": { description: "Deleted" } } },
		},
	};
	if (wantsAuth) {
		paths["/api/auth/login"] = {
			post: { summary: "Login", responses: { "200": { description: "Authenticated" } } },
		};
	}

	return {
		openapi: "3.1.0",
		info: { title: "Generated project API", version: "0.1.0" },
		paths,
	};
}

function buildDataModel(requirement: string): Record<string, unknown> {
	if (includesAny(requirement, ["poll", "vote"])) {
		return {
			entities: [
				{
					name: "User",
					fields: [
						{ name: "id", type: "string", required: true },
						{ name: "email", type: "string", required: true, unique: true },
						{ name: "name", type: "string", required: true },
						{ name: "passwordHash", type: "string", required: true },
						{ name: "createdAt", type: "datetime", required: true },
					],
				},
				{
					name: "Poll",
					fields: [
						{ name: "id", type: "string", required: true },
						{ name: "creatorId", type: "string", required: true, references: "User.id" },
						{ name: "title", type: "string", required: true },
						{ name: "description", type: "string", required: false },
						{ name: "expiresAt", type: "datetime", required: true },
						{ name: "createdAt", type: "datetime", required: true },
					],
				},
				{
					name: "PollOption",
					fields: [
						{ name: "id", type: "string", required: true },
						{ name: "pollId", type: "string", required: true, references: "Poll.id" },
						{ name: "label", type: "string", required: true },
					],
				},
				{
					name: "Vote",
					fields: [
						{ name: "id", type: "string", required: true },
						{ name: "pollId", type: "string", required: true, references: "Poll.id" },
						{ name: "optionId", type: "string", required: true, references: "PollOption.id" },
						{ name: "userId", type: "string", required: true, references: "User.id" },
						{ name: "createdAt", type: "datetime", required: true },
					],
					constraints: ["unique(pollId,userId)"],
				},
			],
		};
	}

	const entity = includesAny(requirement, ["todo", "task"]) ? "Todo" : "Item";
	return {
		entities: [
			{
				name: entity,
				fields: [
					{ name: "id", type: "string", required: true },
					{ name: "title", type: "string", required: true },
					{ name: "createdAt", type: "datetime", required: true },
					{ name: "updatedAt", type: "datetime", required: false },
				],
			},
		],
	};
}

export function writeContracts(outputDir: string, requirement: string, plan: TeamPlan): void {
	writeJson(outputDir, "docs/contracts/team-plan.json", plan);
	writeJson(outputDir, "docs/contracts/project-manifest.json", buildProjectManifest(requirement, plan));
	if (plan.contracts.some((item) => item.kind === "openapi")) {
		writeJson(outputDir, "docs/contracts/openapi.json", buildOpenApi(requirement));
	}
	if (plan.contracts.some((item) => item.kind === "data-model")) {
		writeJson(outputDir, "docs/contracts/data-model.json", buildDataModel(requirement));
	}
}

export function createRepairTasks(plan: TeamPlan, issues: ValidationIssue[], round: number): RepairTask[] {
	const grouped = new Map<string, ValidationIssue[]>();
	for (const issue of issues.filter((item) => item.severity === "error")) {
		const key = issue.ownerTaskId ?? issue.ownerRole ?? plan.tasks[0]?.id;
		if (!key) continue;
		const current = grouped.get(key) ?? [];
		current.push(issue);
		grouped.set(key, current);
	}

	const tasks: RepairTask[] = [];
	for (const [owner, ownerIssues] of grouped.entries()) {
		const originalTask =
			plan.tasks.find((task) => task.id === owner) ??
			plan.tasks.find((task) => task.role === owner) ??
			plan.tasks[0];
		if (!originalTask) continue;
		const issueText = ownerIssues.map((issue) => `- ${issue.id}: ${issue.message}`).join("\n");
		tasks.push({
			...originalTask,
			id: `repair-${round}-${originalTask.id}`,
			subject: `Repair ${originalTask.subject}`,
			description: `${originalTask.description}\n\nFix these validation issues:\n${issueText}`,
			dependencies: [],
			repairOf: ownerIssues.map((issue) => issue.id),
		});
	}
	return tasks;
}
