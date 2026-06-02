import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { TaskGraph } from "../src/task/task-graph.js";
import {
	createRepairTasks,
	llmPlannerRunner,
	parsePlannerOutput,
	taskFromSpec,
	writeContracts,
} from "../src/team/planner.js";

const completeSimpleMock = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-ai", () => ({
	completeSimple: completeSimpleMock,
}));

const model: Model<Api> = {
	id: "fake",
	name: "fake",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 1000,
};

function tempProject(): string {
	return join(tmpdir(), `agent-team-planner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function assistantText(text: string): {
	content: Array<{ type: "text"; text: string }>;
	stopReason: "stop";
} {
	return { content: [{ type: "text", text }], stopReason: "stop" };
}

function plannerJson(domain: "polling" | "commerce"): string {
	const isPolling = domain === "polling";
	return JSON.stringify({
		teamPlan: {
			id: `${domain}-plan`,
			summary: isPolling ? "Realtime polling app" : "Commerce storefront and API",
			roles: [
				{
					name: "builder",
					profile: "project-setup",
					description: "Implements the planned project",
					ownedDirectories: ["."],
				},
				{
					name: "validator",
					profile: "e2e-verifier",
					description: "Checks implementation against contracts",
					ownedDirectories: ["tests/e2e", "docs/e2e-report.md"],
				},
			],
			tasks: [
				{
					id: "build-app",
					role: "builder",
					subject: "Build application",
					description: "Implement the project from the generated contracts.",
					dependencies: [],
					ownedDirectories: ["."],
					expectedOutputs: ["src/index.js", "package.json"],
					acceptanceCriteria: ["Implementation follows the generated contracts."],
				},
				{
					id: "validate-app",
					role: "validator",
					subject: "Validate application",
					description: "Check generated output against contracts.",
					dependencies: ["build-app"],
					ownedDirectories: ["tests/e2e", "docs/e2e-report.md"],
					expectedOutputs: ["docs/e2e-report.md"],
					acceptanceCriteria: ["End-to-end report is captured."],
				},
			],
			validationRules: ["Required outputs exist.", "API routes match the generated OpenAPI contract."],
		},
		projectManifest: {
			goal: isPolling ? "Build a realtime voting system" : "Build an ecommerce system",
			features: isPolling ? ["session auth", "polls", "votes", "SSE updates"] : ["products", "cart", "orders"],
		},
		openapi: {
			openapi: "3.1.0",
			info: { title: isPolling ? "Polling API" : "Commerce API", version: "1.0.0" },
			paths: isPolling
				? {
						"/api/auth/register": {},
						"/api/polls": {},
						"/api/polls/{pollId}/votes": {},
						"/api/polls/{pollId}/events": {},
					}
				: {
						"/api/products": {},
						"/api/cart/items": {},
						"/api/orders": {},
					},
		},
		dataModel: {
			entities: isPolling
				? [{ name: "User" }, { name: "Poll" }, { name: "PollOption" }, { name: "Vote" }]
				: [{ name: "Product" }, { name: "CartItem" }, { name: "Order" }],
		},
	});
}

describe("LLM planner", () => {
	it("writes polling contracts exactly from planner output", () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const result = parsePlannerOutput(plannerJson("polling"));

		writeContracts(outputDir, result);

		const openApi = JSON.parse(readFileSync(join(outputDir, "docs/contracts/openapi.json"), "utf-8")) as {
			paths: Record<string, unknown>;
		};
		const manifest = JSON.parse(readFileSync(join(outputDir, "docs/contracts/project-manifest.json"), "utf-8"));
		expect(Object.keys(openApi.paths)).toEqual([
			"/api/auth/register",
			"/api/polls",
			"/api/polls/{pollId}/votes",
			"/api/polls/{pollId}/events",
		]);
		expect(manifest).toEqual(result.contracts.projectManifest);
	});

	it("accepts non-template domains without generic placeholder routes", () => {
		const outputDir = tempProject();
		mkdirSync(outputDir, { recursive: true });
		const result = parsePlannerOutput(plannerJson("commerce"));

		writeContracts(outputDir, result);

		const contractText = readFileSync(join(outputDir, "docs/contracts/openapi.json"), "utf-8");
		const forbiddenRoute = `/api/${"items"}`;
		expect(contractText).toContain("/api/products");
		expect(contractText).not.toContain(forbiddenRoute);
	});

	it("turns planner tasks into a valid dependency graph", () => {
		const result = parsePlannerOutput(plannerJson("polling"));
		const graph = new TaskGraph();
		for (const task of result.plan.tasks.map(taskFromSpec)) {
			graph.addTask(task);
		}

		expect(graph.getReadyTasks().map((task) => task.id)).toEqual(["build-app"]);
	});

	it("repairs malformed planner JSON once", async () => {
		completeSimpleMock.mockReset();
		completeSimpleMock
			.mockResolvedValueOnce(assistantText("{ broken json"))
			.mockResolvedValueOnce(assistantText(plannerJson("polling")));

		const result = await llmPlannerRunner({
			requirement: "Build a realtime voting app",
			model,
			getApiKey: () => "key",
		});

		expect(result.plan.id).toBe("polling-plan");
		expect(result.diagnostics[0]?.severity).toBe("warning");
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
	});

	it("fails planning when repair output is still invalid", async () => {
		completeSimpleMock.mockReset();
		completeSimpleMock
			.mockResolvedValueOnce(assistantText("{ broken json"))
			.mockResolvedValueOnce(assistantText("{ still broken"));

		await expect(
			llmPlannerRunner({
				requirement: "Build an app",
				model,
				getApiKey: () => "key",
			}),
		).rejects.toThrow("Planner failed after repair attempt");
	});

	it("rejects unknown task dependencies", () => {
		const text = plannerJson("polling").replace('"dependencies":["build-app"]', '"dependencies":["missing-task"]');
		expect(() => parsePlannerOutput(text)).toThrow("unknown dependency");
	});

	it("rejects cyclic task dependencies", () => {
		const text = plannerJson("polling")
			.replace('"dependencies":[]', '"dependencies":["validate-app"]')
			.replace('"dependencies":["build-app"]', '"dependencies":["build-app"]');

		expect(() => parsePlannerOutput(text)).toThrow("cyclic dependency");
	});

	it("rejects roles without owned paths", () => {
		const text = plannerJson("polling").replace('"ownedDirectories":["."]', '"ownedDirectories":[]');
		expect(() => parsePlannerOutput(text)).toThrow("ownedDirectories");
	});

	it("rejects unknown role profiles", () => {
		const text = plannerJson("polling").replace('"profile":"project-setup"', '"profile":"custom-engineer"');
		expect(() => parsePlannerOutput(text)).toThrow("Unknown role profile");
	});

	it("rejects planner-defined role runtime configuration", () => {
		const text = plannerJson("polling").replace(
			'"ownedDirectories":["."]',
			'"allowedTools":["bash"],"ownedDirectories":["."]',
		);
		expect(() => parsePlannerOutput(text)).toThrow("must not define allowedTools");
	});

	it("requires exactly one e2e verifier task", () => {
		const text = plannerJson("polling").replace('"profile":"e2e-verifier"', '"profile":"docs-engineer"');
		expect(() => parsePlannerOutput(text)).toThrow("exactly one e2e-verifier task");
	});

	it("requires the e2e verifier task to depend on implementation and test tasks", () => {
		const text = plannerJson("polling").replace('"dependencies":["build-app"]', '"dependencies":[]');
		expect(() => parsePlannerOutput(text)).toThrow("must depend on");
	});

	it("allows broad ownership in open permission mode", () => {
		const text = plannerJson("polling").replace('"ownedDirectories":["."]', '"ownedDirectories":["src"]');

		expect(() => parsePlannerOutput(text)).not.toThrow();
	});

	it("rejects task expected outputs outside role owned paths in owned permission mode", () => {
		const text = plannerJson("polling").replace('"ownedDirectories":["."]', '"ownedDirectories":["src"]');

		expect(() => parsePlannerOutput(text, { permissionMode: "owned" })).toThrow(
			"expected output package.json is not covered",
		);
	});

	it("rejects root write ownership for non project-setup profiles in owned permission mode", () => {
		const text = plannerJson("polling").replace('"profile":"project-setup"', '"profile":"backend-engineer"');

		expect(() => parsePlannerOutput(text, { permissionMode: "owned" })).toThrow(
			'Only project-setup roles may use "."',
		);
	});

	it("allows project-setup roles to own the project root", () => {
		const result = parsePlannerOutput(plannerJson("polling"));
		expect(result.plan.roles[0]?.profile).toBe("project-setup");
		expect(result.plan.roles[0]?.ownedDirectories).toContain(".");
	});

	it("routes repair tasks by owner task id, then file ownership, then fallback warning", () => {
		const result = parsePlannerOutput(plannerJson("polling"));
		result.plan.tasks[0].ownedDirectories = ["src"];
		const repairTasks = createRepairTasks(
			result.plan,
			[
				{ id: "owned", severity: "error", message: "Fix source", file: "src/index.js" },
				{ id: "explicit", severity: "error", message: "Fix validator", ownerTaskId: "validate-app" },
				{ id: "fallback", severity: "error", message: "Unknown owner", file: "outside/path.txt" },
			],
			1,
		);

		expect(repairTasks.map((task) => task.id)).toEqual(["repair-1-build-app", "repair-1-validate-app"]);
		expect(repairTasks.find((task) => task.id === "repair-1-build-app")?.description).toContain(
			"repair routing used fallback task",
		);
	});

	it("routes file repairs to the most specific owned path", () => {
		const result = parsePlannerOutput(plannerJson("polling"));
		const repairTasks = createRepairTasks(
			result.plan,
			[
				{
					id: "e2e-report",
					severity: "error",
					message: "Report incomplete",
					file: "docs/e2e-report.md",
				},
			],
			1,
		);

		expect(repairTasks.map((task) => task.id)).toEqual(["repair-1-validate-app"]);
	});

	it("adds explicit repair focus for empty agent output", () => {
		const result = parsePlannerOutput(plannerJson("polling"));
		const repairTasks = createRepairTasks(
			result.plan,
			[
				{
					id: "task-failed-build-app",
					severity: "error",
					message: "Task build-app failed: Agent produced no output and changed no files.",
					ownerTaskId: "build-app",
				},
			],
			1,
		);

		expect(repairTasks[0]?.description).toContain("Previous failure context");
		expect(repairTasks[0]?.description).toContain("Agent produced no output");
		expect(repairTasks[0]?.description).toContain("This repair must create or update the expected outputs");
		expect(repairTasks[0]?.description).toContain("src/index.js");
	});
});
