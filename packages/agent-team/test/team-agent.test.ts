import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildTaskResultFromAgentState,
	extractChecksRunFromAgentEvents,
	runTeamAgent,
} from "../src/agent/team-agent.js";
import type { RoleDefinition } from "../src/types.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => {
			this.push({ type: "done", reason: "stop", message });
		});
	}
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("team agent helpers", () => {
	it("extracts self-check commands from bash tool events", () => {
		const events: AgentEvent[] = [
			{
				type: "tool_execution_start",
				toolCallId: "read-1",
				toolName: "bash",
				args: { command: "ls src" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "read-1",
				toolName: "bash",
				result: "src/index.js",
				isError: false,
			},
			{
				type: "tool_execution_start",
				toolCallId: "check-1",
				toolName: "bash",
				args: { command: "node --check src/index.js" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "check-1",
				toolName: "bash",
				result: "ok",
				isError: false,
			},
			{
				type: "tool_execution_start",
				toolCallId: "check-2",
				toolName: "bash",
				args: { command: "npm run check" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "check-2",
				toolName: "bash",
				result: "Command exited with code 2",
				isError: true,
			},
		];

		expect(extractChecksRunFromAgentEvents(events)).toEqual([
			{ command: "node --check src/index.js", exitCode: 0, summary: "ok", required: true },
			{ command: "npm run check", exitCode: 2, summary: "Command exited with code 2", required: true },
		]);
	});

	it("extracts setup self-check commands from install and dependency verification events", () => {
		const events: AgentEvent[] = [
			{
				type: "tool_execution_start",
				toolCallId: "install",
				toolName: "bash",
				args: { command: "npm install 2>&1" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "install",
				toolName: "bash",
				result: "added 20 packages",
				isError: false,
			},
			{
				type: "tool_execution_start",
				toolCallId: "deps",
				toolName: "bash",
				args: { command: "node -e \"require('express'); require('sql.js'); console.log('OK')\"" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "deps",
				toolName: "bash",
				result: "OK",
				isError: false,
			},
		];

		expect(extractChecksRunFromAgentEvents(events)).toEqual([
			{ command: "npm install 2>&1", exitCode: 0, summary: "added 20 packages", required: true },
			{
				command: "node -e \"require('express'); require('sql.js'); console.log('OK')\"",
				exitCode: 0,
				summary: "OK",
				required: true,
			},
		]);
	});

	it("marks empty assistant output with no file changes as failed", () => {
		const result = buildTaskResultFromAgentState({
			taskId: "backend",
			roleName: "backend-engineer",
			messages: [
				{
					role: "assistant",
					content: [],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: 1,
				},
			],
			events: [],
			turnsUsed: 1,
			fallbackError: "unused",
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("empty response");
		expect(result.filesCreated).toEqual([]);
	});

	it("marks a task failed when the agent reaches max turns on a normal return path", async () => {
		const role: RoleDefinition = {
			name: "setup",
			profile: "project-setup",
			description: "Setup",
			systemPrompt: "You are setup.",
			allowedTools: [],
			ownedDirectories: ["."],
			skillHints: [],
			maxTurns: 1,
		};
		const result = await runTeamAgent("finish quickly", {
			role,
			model: getModel("openai", "gpt-4o-mini"),
			outputDir: join(tmpdir(), `agent-team-max-turns-${Date.now()}-${Math.random().toString(36).slice(2)}`),
			streamFn: () => new MockAssistantStream(assistantMessage("done")),
			taskId: "setup-project",
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe("Agent reached maximum turns (1)");
		expect(result.turnsUsed).toBe(1);
	});
});
