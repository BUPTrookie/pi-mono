#!/usr/bin/env node
/**
 * Smoke test: tests the full core chain with a real LLM call.
 * Uses ZAI (GLM) via BigModel China endpoint.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { AgentRunner } from "./agent-runner.js";
import type { Channel, MessageHandler, OutboundMessage } from "./channels/types.js";
import type { BotConfig } from "./config.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
	if (condition) {
		console.log(`  [PASS] ${label}`);
		passed++;
	} else {
		console.log(`  [FAIL] ${label}`);
		failed++;
	}
}

class TestChannel implements Channel {
	readonly type = "test";
	sent: { action: string; text: string }[] = [];

	async start() {}
	async stop() {}
	onMessage(_handler: MessageHandler) {}

	async send(msg: OutboundMessage): Promise<string | undefined> {
		this.sent.push({ action: "send", text: msg.text });
		return "msg-1";
	}

	async updateMessage(_chatId: string, _messageId: string, text: string) {
		this.sent.push({ action: "update", text });
	}

	reset() {
		this.sent.length = 0;
	}
}

async function main() {
	const apiKey = process.env.ZAI_API_KEY;
	if (!apiKey) {
		console.error("Set ZAI_API_KEY env var to run this test");
		process.exit(1);
	}

	const dataDir = `/tmp/bot-smoke-${Date.now()}`;
	mkdirSync(dataDir, { recursive: true });

	const config: BotConfig = {
		dataDir,
		model: {
			provider: "zai",
			model: "glm-4.7",
			thinkingLevel: "off",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
			apiKey,
		},
	};

	console.log("=== Bot Core Chain Smoke Test (GLM via BigModel CN) ===");
	console.log(`Model: ${config.model.provider}/${config.model.model}`);
	console.log(`Base URL: ${config.model.baseUrl}`);
	console.log(`Data dir: ${dataDir}\n`);

	const runner = new AgentRunner(config);
	const channel = new TestChannel();
	runner.registerChannel(channel);

	// Test 1: Simple question (no tools)
	console.log("Test 1: Simple question (2+2)");
	await runner.processMessage({
		id: "t1",
		channelType: "test",
		chatId: "smoke1",
		senderId: "tester",
		senderName: "tester",
		text: "What is 2+2? Reply with just the number, nothing else.",
		timestamp: Date.now(),
		attachments: [],
	});

	const lastMsg1 = channel.sent[channel.sent.length - 1];
	console.log(`  Response: "${lastMsg1?.text?.substring(0, 200)}"\n`);
	const noError1 = !lastMsg1?.text?.includes("Sorry, something went wrong");
	assert(noError1, "no error in response");
	if (noError1) {
		assert(lastMsg1?.text?.includes("4") === true, "LLM responded with correct answer");
	}

	// Check session persistence
	const contextFile1 = join(dataDir, "test", "smoke1", "context.jsonl");
	if (noError1) {
		assert(existsSync(contextFile1), "session file persisted");
	}

	// Test 2: Tool use (bash)
	console.log("Test 2: Tool use (bash echo)");
	channel.reset();

	await runner.processMessage({
		id: "t2",
		channelType: "test",
		chatId: "smoke2",
		senderId: "tester",
		senderName: "tester",
		text: "Use the bash tool to run: echo hello_bot_test\nThen tell me the exact output.",
		timestamp: Date.now(),
		attachments: [],
	});

	const lastMsg2 = channel.sent[channel.sent.length - 1];
	console.log(`  Response: "${lastMsg2?.text?.substring(0, 300)}"\n`);
	const noError2 = !lastMsg2?.text?.includes("Sorry, something went wrong");
	assert(noError2, "no error in tool use");

	// Check if tool was called (status messages show "... <label>")
	const toolUpdates = channel.sent.filter((m) => m.action === "update" && m.text.startsWith("..."));
	if (noError2) {
		console.log(`  Tool status updates: ${toolUpdates.length}`);
		assert(toolUpdates.length > 0, "tool was invoked (status update seen)");
	}

	// Test 3: Multi-turn (verify session continuity)
	console.log("Test 3: Multi-turn conversation");
	channel.reset();

	await runner.processMessage({
		id: "t3a",
		channelType: "test",
		chatId: "smoke3",
		senderId: "tester",
		senderName: "tester",
		text: "Remember this secret number: 42. Just confirm you got it.",
		timestamp: Date.now(),
		attachments: [],
	});

	const resp3a = channel.sent[channel.sent.length - 1];
	console.log(`  Turn 1: "${resp3a?.text?.substring(0, 100)}"`);
	channel.reset();

	await runner.processMessage({
		id: "t3b",
		channelType: "test",
		chatId: "smoke3",
		senderId: "tester",
		senderName: "tester",
		text: "What was the secret number I told you? Reply with just the number.",
		timestamp: Date.now(),
		attachments: [],
	});

	const resp3b = channel.sent[channel.sent.length - 1];
	console.log(`  Turn 2: "${resp3b?.text?.substring(0, 100)}"\n`);
	const noError3 = !resp3b?.text?.includes("Sorry, something went wrong");
	assert(noError3, "no error in multi-turn");
	if (noError3) {
		assert(resp3b?.text?.includes("42") === true, "multi-turn: remembered the number");
	}

	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("\n[FATAL]", err);
	process.exit(1);
});
