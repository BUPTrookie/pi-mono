/**
 * Codex tool: exposes codex app-server capabilities to the LLM as an AgentTool.
 *
 * Actions:
 *   ask      - Send a prompt to codex (creates thread if needed)
 *   review   - Start a code review via codex
 *   respond  - Reply to a pending server request (approval, user input, etc.)
 *   interrupt - Interrupt the current active turn
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { CodexClient, TurnResult } from "../codex-client.js";

const codexSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're doing with codex (shown to user)" }),
	action: Type.Union(
		[Type.Literal("ask"), Type.Literal("review"), Type.Literal("respond"), Type.Literal("interrupt")],
		{
			description:
				'Action: "ask" to send a prompt, "review" for code review, "respond" to reply to a pending approval/request, "interrupt" to stop the current turn',
		},
	),
	// action=ask
	prompt: Type.Optional(Type.String({ description: "Prompt to send to codex (action=ask)" })),
	model: Type.Optional(Type.String({ description: "Model override for this request" })),
	cwd: Type.Optional(
		Type.String({
			description:
				"Project directory for codex to work in (action=ask/review). Different cwd = different codex thread.",
		}),
	),
	// action=review
	base: Type.Optional(Type.String({ description: "Base branch for review (action=review)" })),
	uncommitted: Type.Optional(
		Type.Boolean({ description: "Review uncommitted changes (action=review, default true)" }),
	),
	// action=respond
	requestId: Type.Optional(
		Type.Union([Type.String(), Type.Number()], { description: "Server request ID to respond to (action=respond)" }),
	),
	response: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				'Response payload for the server request. Structure depends on request type: commandExecution/fileChange: {decision:"accept"|"decline"|...}, permissions: {permissions:{...},scope:"turn"|"session"}, userInput: {answers:{...}}',
		}),
	),
});

type CodexParams = {
	label: string;
	action: "ask" | "review" | "respond" | "interrupt";
	prompt?: string;
	model?: string;
	cwd?: string;
	base?: string;
	uncommitted?: boolean;
	requestId?: string | number;
	response?: Record<string, unknown>;
};

export function createCodexTool(
	codexClient: CodexClient,
	channelType: string,
	chatId: string,
): AgentTool<typeof codexSchema> {
	const baseConversationKey = `${channelType}:${chatId}`;

	async function ensureThread(cwd?: string): Promise<string> {
		const conversationKey = cwd ? `${baseConversationKey}:${cwd}` : baseConversationKey;
		let threadId = codexClient.getThreadId(conversationKey);
		if (!threadId) {
			threadId = await codexClient.startThread(conversationKey, cwd);
		}
		return threadId;
	}

	return {
		name: "codex",
		label: "codex",
		description: `Delegate tasks to Codex, an AI coding agent. Actions:
- ask: Send a prompt to codex to execute coding tasks (runs commands, edits files, etc.)
- review: Start a code review (uncommitted changes or vs a base branch)
- respond: Reply to a pending approval request from codex (command execution, file changes, permissions)
- interrupt: Stop the current codex turn

Use "cwd" to specify which project directory codex should work in. Different cwd values create separate codex threads, so codex stays scoped to that project.

When codex needs to run commands or edit files, it requests approval. You will see pending requests with their IDs and available decisions. Use action="respond" with the requestId and appropriate response to approve or decline.`,
		parameters: codexSchema,
		execute: async (
			_toolCallId: string,
			params: CodexParams,
			_signal?: AbortSignal,
		): Promise<{ content: TextContent[]; details: undefined }> => {
			if (!codexClient.isRunning) {
				throw new Error("Codex client is not running. Check if codex is installed and configured.");
			}

			switch (params.action) {
				case "ask": {
					if (!params.prompt) {
						throw new Error('action="ask" requires a prompt parameter');
					}
					const threadId = await ensureThread(params.cwd);
					const result = await codexClient.sendTurn(threadId, params.prompt, params.model);
					return { content: [{ type: "text", text: formatTurnResult(result) }], details: undefined };
				}

				case "review": {
					const threadId = await ensureThread(params.cwd);
					const target = params.base
						? { type: "baseBranch" as const, branch: params.base }
						: { type: "uncommittedChanges" as const };
					const result = await codexClient.startReview(threadId, target);
					return { content: [{ type: "text", text: formatTurnResult(result) }], details: undefined };
				}

				case "respond": {
					if (params.requestId === undefined) {
						throw new Error('action="respond" requires a requestId parameter');
					}
					if (!params.response) {
						throw new Error('action="respond" requires a response parameter');
					}
					codexClient.respondToServerRequest(params.requestId, params.response);
					const result = await codexClient.continueTurn();
					return { content: [{ type: "text", text: formatTurnResult(result) }], details: undefined };
				}

				case "interrupt": {
					const interruptKey = params.cwd ? `${baseConversationKey}:${params.cwd}` : baseConversationKey;
					const threadId = codexClient.getThreadId(interruptKey);
					if (!threadId) {
						throw new Error("No active codex thread for this conversation");
					}
					const result = await codexClient.interrupt(threadId);
					return { content: [{ type: "text", text: formatTurnResult(result) }], details: undefined };
				}

				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	};
}

function formatTurnResult(result: TurnResult): string {
	const parts: string[] = [];

	parts.push(`[Codex] Status: ${result.status}`);

	if (result.error) {
		parts.push(`\nError: ${result.error}`);
	}

	if (result.text.trim()) {
		parts.push(`\nOutput:\n${result.text}`);
	}

	if (result.pendingServerRequests.length > 0) {
		parts.push("\nPending requests:");
		for (const req of result.pendingServerRequests) {
			const decisions = req.availableDecisions
				? ` [decisions: ${(req.availableDecisions as string[]).join(", ")}]`
				: "";
			parts.push(`  [${req.type}] (id: ${req.id}): ${req.detail}${decisions}`);
		}
		parts.push('\nUse action="respond" with requestId and response to approve/decline each.');
	}

	if (result.items.length > 0) {
		const summary = result.items.slice(0, 20);
		if (summary.length > 0) {
			parts.push(`\nActivity (${result.items.length} items):`);
			for (const item of summary) {
				parts.push(`  ${item}`);
			}
			if (result.items.length > 20) {
				parts.push(`  ... and ${result.items.length - 20} more`);
			}
		}
	}

	return parts.join("\n");
}
