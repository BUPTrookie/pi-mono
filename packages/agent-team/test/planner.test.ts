import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { TaskGraph } from "../src/task/task-graph.js";
import { llmPlannerRunner, parsePlannerOutput, taskFromSpec, writeContracts } from "../src/team/planner.js";

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
					description: "Implements the planned project",
					allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
					ownedDirectories: ["src", "client"],
					maxTurns: 40,
				},
				{
					name: "validator",
					description: "Checks implementation against contracts",
					allowedTools: ["read", "bash", "grep", "find", "ls"],
					ownedDirectories: ["docs"],
					maxTurns: 20,
				},
			],
			tasks: [
				{
					id: "build-app",
					role: "builder",
					subject: "Build application",
					description: "Implement the project from the generated contracts.",
					dependencies: [],
					ownedDirectories: ["src", "client"],
					expectedOutputs: ["src/index.js", "package.json"],
					acceptanceCriteria: ["Implementation follows the generated contracts."],
				},
				{
					id: "validate-app",
					role: "validator",
					subject: "Validate application",
					description: "Check generated output against contracts.",
					dependencies: ["build-app"],
					ownedDirectories: ["docs"],
					expectedOutputs: ["README.md"],
					acceptanceCriteria: ["Validation notes are captured."],
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

	it("rejects roles without owned paths", () => {
		const text = plannerJson("polling").replace('"ownedDirectories":["src","client"]', '"ownedDirectories":[]');
		expect(() => parsePlannerOutput(text)).toThrow("ownedDirectories");
	});
});
