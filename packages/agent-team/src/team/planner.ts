import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { completeSimple } from "@mariozechner/pi-ai";
import { formatRoleProfilesForPlanner, getRoleProfile, isRoleProfileId } from "../roles/role-profiles.js";
import { buildRoleSystemPrompt } from "../roles/system-prompts.js";
import type {
	ContractSpec,
	GeneratedContracts,
	PlannerDiagnostic,
	PlannerOptions,
	PlannerResult,
	RepairTask,
	RoleDefinition,
	RoleSpec,
	Task,
	TaskSpec,
	TeamPlan,
	ValidationIssue,
} from "../types.js";
import { extractJsonText, extractTextContent, isRecord } from "../utils/shared.js";

interface RawPlannerJson {
	teamPlan?: unknown;
	projectManifest?: unknown;
	openapi?: unknown;
	dataModel?: unknown;
	notes?: unknown;
}

function roleFromSpec(spec: RoleSpec): RoleDefinition {
	const profile = getRoleProfile(spec.profile);
	return {
		name: spec.name,
		profile: spec.profile,
		description: spec.description,
		systemPrompt: buildRoleSystemPrompt(spec),
		allowedTools: profile.allowedTools,
		ownedDirectories: spec.ownedDirectories,
		skillHints: profile.skillHints,
		thinkingLevelOverride: profile.thinkingLevelOverride,
		maxTurns: profile.maxTurns,
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

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((item) => typeof item === "string" && item.trim().length > 0)
	);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
	return value;
}

function asString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
	return value.trim();
}

function asStringArray(value: unknown, label: string): string[] {
	if (!isStringArray(value)) throw new Error(`${label} must be a non-empty string array.`);
	return value.map((item) => item.trim());
}

function asOptionalStringArray(value: unknown, label: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${label} must be a string array when provided.`);
	return value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
}

function normalizeRole(value: unknown, index: number): RoleSpec {
	const role = asRecord(value, `teamPlan.roles[${index}]`);
	const ownedDirectories = asStringArray(role.ownedDirectories, `teamPlan.roles[${index}].ownedDirectories`);
	for (const field of ["allowedTools", "systemPrompt", "maxTurns", "modelOverride", "thinkingLevelOverride"]) {
		if (field in role) throw new Error(`teamPlan.roles[${index}] must not define ${field}; use role profiles.`);
	}
	const profile = asString(role.profile, `teamPlan.roles[${index}].profile`);
	if (!isRoleProfileId(profile)) throw new Error(`Unknown role profile: ${profile}`);
	return {
		name: asString(role.name, `teamPlan.roles[${index}].name`),
		profile,
		description: asString(role.description, `teamPlan.roles[${index}].description`),
		ownedDirectories,
	};
}

function normalizeTask(value: unknown, index: number): TaskSpec {
	const task = asRecord(value, `teamPlan.tasks[${index}]`);
	return {
		id: asString(task.id, `teamPlan.tasks[${index}].id`),
		role: asString(task.role, `teamPlan.tasks[${index}].role`),
		subject: asString(task.subject, `teamPlan.tasks[${index}].subject`),
		description: asString(task.description, `teamPlan.tasks[${index}].description`),
		dependencies: asOptionalStringArray(task.dependencies, `teamPlan.tasks[${index}].dependencies`),
		ownedDirectories: asStringArray(task.ownedDirectories, `teamPlan.tasks[${index}].ownedDirectories`),
		expectedOutputs: asStringArray(task.expectedOutputs, `teamPlan.tasks[${index}].expectedOutputs`),
		acceptanceCriteria: asStringArray(task.acceptanceCriteria, `teamPlan.tasks[${index}].acceptanceCriteria`),
	};
}

function validateSafePaths(paths: string[], label: string): void {
	for (const path of paths) {
		if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.split(/[\\/]/).includes("..")) {
			throw new Error(`${label} contains unsafe path: ${path}`);
		}
	}
}

function normalizePlanPath(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/\/+$/g, "") || ".";
}

function isPathCoveredByOwnedPath(path: string, ownedPath: string): boolean {
	const normalizedPath = normalizePlanPath(path);
	const normalizedOwned = normalizePlanPath(ownedPath);
	if (normalizedOwned === ".") return true;
	return normalizedPath === normalizedOwned || normalizedPath.startsWith(`${normalizedOwned}/`);
}

function ownedPathSpecificity(ownedPath: string): number {
	const normalized = normalizePlanPath(ownedPath);
	return normalized === "." ? 0 : normalized.length;
}

function findTaskOwnerForFile(plan: TeamPlan, file: string): string | undefined {
	let ownerTaskId: string | undefined;
	let bestSpecificity = -1;
	for (const task of plan.tasks) {
		for (const owned of task.ownedDirectories) {
			if (!isPathCoveredByOwnedPath(file, owned)) continue;
			const specificity = ownedPathSpecificity(owned);
			if (specificity > bestSpecificity) {
				ownerTaskId = task.id;
				bestSpecificity = specificity;
			}
		}
	}
	return ownerTaskId;
}

function validateRoleOwnership(_roles: RoleSpec[], _tasks: TaskSpec[]): void {
	// Ownership restrictions removed — all agents have full file access.
}

function validateAcyclicTasks(tasks: TaskSpec[]): void {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const visiting = new Set<string>();
	const visited = new Set<string>();

	const visit = (taskId: string, path: string[]): void => {
		if (visited.has(taskId)) return;
		if (visiting.has(taskId)) {
			const cycleStart = path.indexOf(taskId);
			const cycle = path.slice(cycleStart).join(" -> ");
			throw new Error(`Task plan contains cyclic dependency: ${cycle}`);
		}

		const task = byId.get(taskId);
		if (!task) return;
		visiting.add(taskId);
		for (const dependency of task.dependencies) {
			visit(dependency, [...path, dependency]);
		}
		visiting.delete(taskId);
		visited.add(taskId);
	};

	for (const task of tasks) {
		visit(task.id, [task.id]);
	}
}

function validateE2eVerifierTask(roles: RoleSpec[], tasks: TaskSpec[]): void {
	const rolesByName = new Map(roles.map((role) => [role.name, role]));
	const e2eTasks = tasks.filter((task) => rolesByName.get(task.role)?.profile === "e2e-verifier");
	if (e2eTasks.length !== 1) {
		throw new Error("teamPlan.tasks must contain exactly one e2e-verifier task.");
	}

	const e2eTask = e2eTasks[0];
	const dependencies = new Set(e2eTask.dependencies);
	const requiredDependencies = tasks.filter((task) => {
		if (task.id === e2eTask.id) return false;
		return rolesByName.get(task.role)?.profile !== "docs-engineer";
	});
	for (const dependency of requiredDependencies) {
		if (!dependencies.has(dependency.id)) {
			throw new Error(`e2e-verifier task ${e2eTask.id} must depend on ${dependency.id}.`);
		}
	}
}

function buildContracts(raw: RawPlannerJson): GeneratedContracts {
	const projectManifest = asRecord(raw.projectManifest, "projectManifest");
	const contracts: GeneratedContracts = { projectManifest };
	if (raw.openapi !== undefined) contracts.openapi = asRecord(raw.openapi, "openapi");
	if (raw.dataModel !== undefined) contracts.dataModel = asRecord(raw.dataModel, "dataModel");
	if (raw.notes !== undefined) contracts.notes = asRecord(raw.notes, "notes");
	return contracts;
}

function validatePlannerJson(raw: RawPlannerJson): PlannerResult {
	const planRecord = asRecord(raw.teamPlan, "teamPlan");
	const rolesRaw = planRecord.roles;
	const tasksRaw = planRecord.tasks;
	if (!Array.isArray(rolesRaw) || rolesRaw.length === 0)
		throw new Error("teamPlan.roles must contain at least one role.");
	if (!Array.isArray(tasksRaw) || tasksRaw.length === 0)
		throw new Error("teamPlan.tasks must contain at least one task.");

	const roles = rolesRaw.map(normalizeRole);
	const tasks = tasksRaw.map(normalizeTask);
	const roleNames = new Set(roles.map((role) => role.name));
	const taskIds = new Set<string>();
	for (const role of roles) {
		validateSafePaths(role.ownedDirectories, `role ${role.name} ownedDirectories`);
	}
	for (const task of tasks) {
		if (taskIds.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
		taskIds.add(task.id);
		if (!roleNames.has(task.role)) throw new Error(`Task ${task.id} references unknown role: ${task.role}`);
		validateSafePaths(task.ownedDirectories, `task ${task.id} ownedDirectories`);
		validateSafePaths(task.expectedOutputs, `task ${task.id} expectedOutputs`);
	}
	for (const task of tasks) {
		for (const dependency of task.dependencies) {
			if (!taskIds.has(dependency)) throw new Error(`Task ${task.id} references unknown dependency: ${dependency}`);
			if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself.`);
		}
	}
	validateAcyclicTasks(tasks);
	validateRoleOwnership(roles, tasks);
	validateE2eVerifierTask(roles, tasks);

	const contracts = buildContracts(raw);
	const plan: TeamPlan = {
		id:
			typeof planRecord.id === "string" && planRecord.id.trim().length > 0
				? planRecord.id.trim()
				: `plan-${Date.now()}`,
		summary: asString(planRecord.summary, "teamPlan.summary"),
		roles,
		tasks,
		contracts: [
			contract("docs/contracts/team-plan.json", "team-plan", true),
			contract("docs/contracts/project-manifest.json", "project-manifest", true),
			...(contracts.openapi ? [contract("docs/contracts/openapi.json", "openapi", true)] : []),
			...(contracts.dataModel ? [contract("docs/contracts/data-model.json", "data-model", true)] : []),
			...(contracts.notes ? [contract("docs/contracts/notes.json", "notes", false)] : []),
		],
		validationRules: isStringArray(planRecord.validationRules)
			? planRecord.validationRules
			: [
					"All required contract files must exist.",
					"Task expected outputs must exist after execution.",
					"Implementation must satisfy projectManifest and any generated OpenAPI/dataModel contracts.",
				],
	};

	return { plan, contracts, diagnostics: [] };
}

export function parsePlannerOutput(text: string): PlannerResult {
	const parsed = JSON.parse(extractJsonText(text)) as RawPlannerJson;
	return validatePlannerJson(parsed);
}

function extractAssistantText(message: Awaited<ReturnType<typeof completeSimple>>): string {
	return extractTextContent(message.content);
}

function plannerSystemPrompt(): string {
	return `You are the Lead Planner for a dynamic AI engineering team.

Your job is to understand the user's project globally and produce the collaboration contracts worker agents will implement.

Return ONLY valid JSON. Do not use markdown.

Required top-level shape:
{
  "teamPlan": {
    "id": "short-plan-id",
    "summary": "project summary",
    "roles": [
      {
        "name": "role-id",
        "profile": "backend-engineer",
        "description": "role purpose",
        "ownedDirectories": ["src"]
      }
    ],
    "tasks": [
      {
        "id": "task-id",
        "role": "role-id",
        "subject": "task subject",
        "description": "specific implementation instructions",
        "dependencies": [],
        "ownedDirectories": ["src"],
        "expectedOutputs": ["src", "package.json"],
        "acceptanceCriteria": ["concrete criterion"]
      }
    ],
    "validationRules": ["project-specific validation rule"]
  },
  "projectManifest": {
    "goal": "what to build",
    "features": ["feature"],
    "nonFunctionalRequirements": ["requirement"],
    "implementationNotes": ["note"]
  },
  "openapi": { "openapi": "3.1.0", "info": {}, "paths": {} },
  "dataModel": { "entities": [] },
  "notes": { "risks": [], "handoff": [] }
}

Rules:
- You decide roles, tasks, dependencies, contracts, and validation rules from the actual requirement.
- Select roles only from these available role profiles:
${formatRoleProfilesForPlanner()}
- Do not invent tools, system prompts, max turns, model overrides, or thinking overrides. Role profile runtime config is fixed by the system.
- Create exactly one final e2e-verifier task for every generated project.
- The e2e-verifier task must depend on every implementation and test task, but not on optional docs-only tasks.
- Unit and module tests belong to implementation agents or test-engineer tasks. The e2e-verifier checks complete user workflows and writes docs/e2e-report.md.
- Prefer pure-JavaScript packages that install without native compilation. Never use packages that require node-gyp, prebuilds, or C++ build tools. For SQLite use sql.js instead of better-sqlite3. For bcrypt use bcryptjs. For sharp use canvas or a WASM alternative. If no pure-JS alternative exists, use the simplest API surface that avoids native addons.
- Include openapi only if the project needs an HTTP API.
- Include dataModel only if the project needs persistent or structured domain data.
- Do not invent generic placeholder APIs or domain objects.
- All paths must be relative to the project root. Never use absolute paths or ..
- ownedDirectories must cover every path in expectedOutputs. If a task must produce root-level files (package.json, .gitignore, tsconfig.json, etc.), its role's ownedDirectories must include "." so the agent can write to the project root. Match ownedDirectories to the actual directories the task writes to — do not blindly use ["src"].
- Every task role must exist in teamPlan.roles.
- Every task dependency must reference an existing task id.
- Contract files are communication artifacts for workers; make them specific enough to prevent drift.`;
}

function repairPrompt(requirement: string, previousOutput: string, error: string): string {
	return `The previous planning JSON was invalid.

Validation error:
${error}

Original project requirement:
${requirement}

Previous output:
${previousOutput}

Return corrected JSON only, using the required schema.`;
}

async function completePlannerJson(options: PlannerOptions, userPrompt: string): Promise<string> {
	const apiKey = await options.getApiKey(options.model.provider);
	const message = await completeSimple(
		options.model,
		{
			systemPrompt: plannerSystemPrompt(),
			messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
		},
		{
			apiKey,
			reasoning: options.thinkingLevel === "off" ? undefined : options.thinkingLevel,
			signal: options.signal,
		},
	);
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(message.errorMessage ?? `Planner model stopped with ${message.stopReason}`);
	}
	return extractAssistantText(message);
}

export async function llmPlannerRunner(options: PlannerOptions): Promise<PlannerResult> {
	const firstPrompt = `Project requirement:
${options.requirement}

Plan the team and generate contracts. Return JSON only.`;
	const firstOutput = await completePlannerJson(options, firstPrompt);
	try {
		return parsePlannerOutput(firstOutput);
	} catch (firstError) {
		const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
		const repairedOutput = await completePlannerJson(
			options,
			repairPrompt(options.requirement, firstOutput, firstMessage),
		);
		try {
			const result = parsePlannerOutput(repairedOutput);
			const diagnostic: PlannerDiagnostic = {
				severity: "warning",
				message: `Planner output required one repair attempt: ${firstMessage}`,
			};
			return { ...result, diagnostics: [diagnostic, ...result.diagnostics] };
		} catch (secondError) {
			const secondMessage = secondError instanceof Error ? secondError.message : String(secondError);
			throw new Error(
				`Planner failed after repair attempt. Initial error: ${firstMessage}. Repair error: ${secondMessage}`,
			);
		}
	}
}

function writeJson(outputDir: string, relativePath: string, value: unknown): void {
	const absolutePath = join(outputDir, relativePath);
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function writeContracts(outputDir: string, result: PlannerResult): void {
	writeJson(outputDir, "docs/contracts/team-plan.json", result.plan);
	writeJson(outputDir, "docs/contracts/project-manifest.json", result.contracts.projectManifest);
	if (result.contracts.openapi) writeJson(outputDir, "docs/contracts/openapi.json", result.contracts.openapi);
	if (result.contracts.dataModel) writeJson(outputDir, "docs/contracts/data-model.json", result.contracts.dataModel);
	if (result.contracts.notes) writeJson(outputDir, "docs/contracts/notes.json", result.contracts.notes);
}

function repairFocusText(task: TaskSpec, issues: ValidationIssue[]): string {
	const expectedOutputs = task.expectedOutputs.map((output) => `- ${output}`).join("\n");
	const previousFailures = issues.map((issue) => `- ${issue.id}: ${issue.message}`).join("\n");
	return [
		"Previous failure context:",
		previousFailures,
		"",
		"This repair must create or update the expected outputs below. Do not finish with an empty response or zero file changes.",
		expectedOutputs,
	].join("\n");
}

export function createRepairTasks(plan: TeamPlan, issues: ValidationIssue[], round: number): RepairTask[] {
	const grouped = new Map<string, ValidationIssue[]>();
	for (const issue of issues.filter((item) => item.severity === "error")) {
		const ownerByFile = issue.file !== undefined ? findTaskOwnerForFile(plan, issue.file) : undefined;
		const fallback = plan.tasks[0]?.id;
		const key = issue.ownerTaskId ?? ownerByFile ?? issue.ownerRole ?? fallback;
		if (!key) continue;
		const current = grouped.get(key) ?? [];
		current.push(
			issue.ownerTaskId || ownerByFile || issue.ownerRole
				? issue
				: {
						...issue,
						message: `${issue.message} (warning: repair routing used fallback task because no owner matched.)`,
					},
		);
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
			description: `${originalTask.description}\n\nFix these validation issues:\n${issueText}\n\n${repairFocusText(
				originalTask,
				ownerIssues,
			)}`,
			dependencies: [],
			repairOf: ownerIssues.map((issue) => issue.id),
		});
	}
	return tasks;
}
