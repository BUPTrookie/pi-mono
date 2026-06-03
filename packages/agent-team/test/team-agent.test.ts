import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildTaskResultFromAgentState,
	createTeamAgentSession,
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

function streamMessages(texts: string[]): () => MockAssistantStream {
	let index = 0;
	return () => new MockAssistantStream(assistantMessage(texts[index++] ?? texts[texts.length - 1] ?? "done"));
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

	it("summarizes structured bash tool results from text content", () => {
		const events: AgentEvent[] = [
			{
				type: "tool_execution_start",
				toolCallId: "check",
				toolName: "bash",
				args: { command: "npm test" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "check",
				toolName: "bash",
				result: {
					content: [{ type: "text", text: "PASS tests/notes.test.js\n3 tests passed" }],
					details: {},
				},
				isError: false,
			},
		];

		expect(extractChecksRunFromAgentEvents(events)).toEqual([
			{ command: "npm test", exitCode: 0, summary: "PASS tests/notes.test.js 3 tests passed", required: true },
		]);
	});

	it("extracts exit code from structured bash tool details", () => {
		const events: AgentEvent[] = [
			{
				type: "tool_execution_start",
				toolCallId: "check",
				toolName: "bash",
				args: { command: "npm run check" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "check",
				toolName: "bash",
				result: {
					content: [{ type: "text", text: "Type error" }],
					details: { exitCode: 2 },
				},
				isError: true,
			},
		];

		expect(extractChecksRunFromAgentEvents(events)).toEqual([
			{ command: "npm run check", exitCode: 2, summary: "Type error", required: true },
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

	it("continues the same task session with prior messages and attempt metadata", async () => {
		const role: RoleDefinition = {
			name: "setup",
			profile: "project-setup",
			description: "Setup",
			systemPrompt: "You are setup.",
			allowedTools: [],
			ownedDirectories: ["."],
			skillHints: [],
			maxTurns: 10,
		};
		const session = createTeamAgentSession({
			role,
			model: getModel("openai", "gpt-4o-mini"),
			outputDir: join(tmpdir(), `agent-team-session-${Date.now()}-${Math.random().toString(36).slice(2)}`),
			streamFn: streamMessages(["first done", "second done"]),
			taskId: "setup-project",
		});

		const first = await session.prompt("Create the project.", {
			taskId: "setup-project",
			attempt: 1,
			attemptMode: "initial",
		});
		const second = await session.continueWith("Fix missing package.json.", {
			taskId: "setup-project",
			attempt: 2,
			attemptMode: "continue",
			continuedFrom: "setup-project",
		});

		const userMessages = session.messages.filter((message) => message.role === "user");
		expect(first.attempt).toBe(1);
		expect(first.attemptMode).toBe("initial");
		expect(second.attempt).toBe(2);
		expect(second.attemptMode).toBe("continue");
		expect(second.continuedFrom).toBe("setup-project");
		expect(second.turnsUsed).toBe(2);
		expect(userMessages).toHaveLength(2);
		expect(userMessages[1]?.content).toEqual([{ type: "text", text: "Fix missing package.json." }]);
	});

	it("does not send orphaned tool results after context trimming", async () => {
		const role: RoleDefinition = {
			name: "e2e",
			profile: "e2e-verifier",
			description: "Verify",
			systemPrompt: "You are e2e.",
			allowedTools: [],
			ownedDirectories: ["docs"],
			skillHints: [],
			maxTurns: 10,
		};
		let sawOrphanedToolResult = false;
		const session = createTeamAgentSession({
			role,
			model: getModel("openai", "gpt-4o-mini"),
			outputDir: join(tmpdir(), `agent-team-trim-${Date.now()}-${Math.random().toString(36).slice(2)}`),
			streamFn: (_model, context) => {
				const visibleToolCalls = new Set<string>();
				for (const message of context.messages) {
					if (message.role === "assistant") {
						for (const block of message.content) {
							if (block.type === "toolCall") visibleToolCalls.add(block.id);
						}
					}
					if (message.role === "toolResult" && !visibleToolCalls.has(message.toolCallId)) {
						sawOrphanedToolResult = true;
					}
				}
				return new MockAssistantStream(assistantMessage("done"));
			},
			taskId: "e2e",
		});
		const seeded = session.messages as AgentMessage[];
		seeded.push({ role: "user", content: [{ type: "text", text: "Initial task" }], timestamp: 1 });
		seeded.push({
			...assistantMessage(""),
			content: [{ type: "toolCall", id: "old-call", name: "read", arguments: { path: "package.json" } }],
			stopReason: "toolUse",
		});
		seeded.push({
			role: "toolResult",
			toolCallId: "old-call",
			toolName: "read",
			content: [{ type: "text", text: "package" }],
			details: {},
			isError: false,
			timestamp: 1,
		});
		for (let index = 0; index < 117; index++) {
			seeded.push(assistantMessage(`filler ${index}`));
		}

		await session.prompt("Continue verification.", {
			taskId: "e2e",
			attempt: 1,
			attemptMode: "initial",
		});

		expect(sawOrphanedToolResult).toBe(false);
	});

	it("repairs assistant toolCalls missing their toolResults", async () => {
		const role: RoleDefinition = {
			name: "e2e",
			profile: "e2e-verifier",
			description: "Verify",
			systemPrompt: "You are e2e.",
			allowedTools: [],
			ownedDirectories: ["docs"],
			skillHints: [],
			maxTurns: 10,
		};
		let sawOrphanedToolResult = false;
		let sawDanglingToolCall = false;
		const session = createTeamAgentSession({
			role,
			model: getModel("openai", "gpt-4o-mini"),
			outputDir: join(tmpdir(), `agent-team-repair-${Date.now()}-${Math.random().toString(36).slice(2)}`),
			streamFn: (_model, context) => {
				const visibleToolCalls = new Set<string>();
				for (const message of context.messages) {
					if (message.role === "assistant") {
						for (const block of message.content) {
							if (block.type === "toolCall") visibleToolCalls.add(block.id);
						}
					}
					if (message.role === "toolResult" && !visibleToolCalls.has(message.toolCallId)) {
						sawOrphanedToolResult = true;
					}
				}
				// Check that every toolCall has a matching toolResult
				const toolResults = new Set<string>();
				for (const message of context.messages) {
					if (message.role === "toolResult") toolResults.add(message.toolCallId);
				}
				for (const message of context.messages) {
					if (message.role !== "assistant") continue;
					for (const block of message.content) {
						if (block.type === "toolCall" && !toolResults.has(block.id)) {
							sawDanglingToolCall = true;
						}
					}
				}
				return new MockAssistantStream(assistantMessage("done"));
			},
			taskId: "e2e",
		});
		const seeded = session.messages as AgentMessage[];
		seeded.push({ role: "user", content: [{ type: "text", text: "Initial task" }], timestamp: 1 });
		// Assistant with 3 toolCalls but only 1 toolResult in the recent window
		seeded.push({
			...assistantMessage(""),
			content: [
				{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.js" } },
				{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.js" } },
				{ type: "toolCall", id: "call-c", name: "read", arguments: { path: "c.js" } },
			],
			stopReason: "toolUse",
		});
		seeded.push({
			role: "toolResult",
			toolCallId: "call-a",
			toolName: "read",
			content: [{ type: "text", text: "a" }],
			details: {},
			isError: false,
			timestamp: 1,
		});
		seeded.push({
			role: "toolResult",
			toolCallId: "call-b",
			toolName: "read",
			content: [{ type: "text", text: "b" }],
			details: {},
			isError: false,
			timestamp: 1,
		});
		seeded.push({
			role: "toolResult",
			toolCallId: "call-c",
			toolName: "read",
			content: [{ type: "text", text: "c" }],
			details: {},
			isError: false,
			timestamp: 1,
		});
		// Push enough filler so the toolResults for call-b and call-c fall outside the recent window
		for (let index = 0; index < 118; index++) {
			seeded.push(assistantMessage(`filler ${index}`));
		}

		await session.prompt("Continue verification.", {
			taskId: "e2e",
			attempt: 1,
			attemptMode: "initial",
		});

		expect(sawOrphanedToolResult).toBe(false);
		expect(sawDanglingToolCall).toBe(false);
	});
});
