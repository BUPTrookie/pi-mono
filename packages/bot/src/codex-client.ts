/**
 * CodexClient: manages JSON-RPC over stdio communication with codex app-server.
 *
 * Spawns `codex app-server --listen stdio://`, handles the initialize handshake,
 * thread/turn lifecycle, notification aggregation, and server request callbacks
 * (approval flow for command execution, file changes, permissions, etc.).
 */

import { type ChildProcess, spawn } from "child_process";
import { createInterface, type Interface } from "readline";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CodexClientOptions {
	cwd?: string;
	model?: string;
	sandbox?: "read-only" | "workspace-write" | "danger-full-access";
	approvalPolicy?: "on-request" | "never";
}

export interface PendingServerRequest {
	/** JSON-RPC request id -- must reply with this exact id */
	id: string | number;
	/** Broad category */
	type:
		| "commandExecution"
		| "fileChange"
		| "permissions"
		| "userInput"
		| "mcpElicitation"
		| "toolCall"
		| "legacyExec"
		| "legacyPatch";
	/** Human-readable summary */
	detail: string;
	/** Server-provided decision options (approval types only) */
	availableDecisions?: unknown[];
	/** Raw params from the server request */
	params: unknown;
}

export interface TurnResult {
	/** Aggregated agentMessage text */
	text: string;
	/** Server requests awaiting client response */
	pendingServerRequests: PendingServerRequest[];
	/** Execution summary lines (commands, file changes, etc.) */
	items: string[];
	/** Turn outcome */
	status: "completed" | "waiting_approval" | "interrupted" | "failed";
	error?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RpcMessage {
	id?: string | number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

interface PendingRpc {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
}

interface TurnState {
	threadId: string;
	turnId?: string;
	text: string;
	commandOutputs: Map<string, string>;
	fileChanges: string[];
	planSteps: string[];
	items: string[];
	pendingServerRequests: PendingServerRequest[];
	status: "running" | "completed" | "interrupted" | "failed";
	error?: string;
	/** Resolve the sendTurn/continueTurn promise */
	resolve?: (result: TurnResult) => void;
}

// ---------------------------------------------------------------------------
// CodexClient
// ---------------------------------------------------------------------------

export class CodexClient {
	private process: ChildProcess | null = null;
	private reader: Interface | null = null;
	private nextId = 1;
	private pendingRpc = new Map<string | number, PendingRpc>();
	private turnState: TurnState | null = null;
	private threads = new Map<string, string>(); // conversationKey -> threadId
	private activeThreadTurns = new Map<string, string>(); // threadId -> turnId
	private options: CodexClientOptions;
	private started = false;

	constructor(options: CodexClientOptions = {}) {
		this.options = options;
	}

	// -----------------------------------------------------------------------
	// Process lifecycle
	// -----------------------------------------------------------------------

	async start(): Promise<void> {
		if (this.started) return;

		this.process = spawn("codex", ["app-server", "--listen", "stdio://"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
			cwd: this.options.cwd || process.cwd(),
		});

		this.process.on("exit", (code, signal) => {
			console.error(`codex app-server exited (code=${code}, signal=${signal})`);
			this.handleProcessExit();
		});

		this.process.on("error", (err) => {
			console.error("codex app-server process error:", err.message);
		});

		// stderr -> diagnostic logs
		if (this.process.stderr) {
			const stderrReader = createInterface({ input: this.process.stderr });
			stderrReader.on("line", (line) => {
				console.error(`[codex stderr] ${line}`);
			});
		}

		// stdout -> protocol messages (line-delimited JSON)
		if (this.process.stdout) {
			this.reader = createInterface({ input: this.process.stdout });
			this.reader.on("line", (line) => {
				this.handleLine(line);
			});
		}

		// Initialize handshake
		const initResult = await this.sendRequest("initialize", {
			clientInfo: { name: "pi-bot", title: "pi-bot", version: "1.0.0" },
			capabilities: {
				experimentalApi: false,
				optOutNotificationMethods: null,
			},
		});

		// Send initialized notification (required by protocol)
		this.sendNotification("initialized");

		this.started = true;
		const res = initResult as { userAgent?: string };
		console.log(`codex app-server initialized: ${res.userAgent || "unknown"}`);
	}

	async stop(): Promise<void> {
		if (!this.process) return;

		// Reject any pending RPCs
		for (const [, pending] of this.pendingRpc) {
			pending.reject(new Error("CodexClient stopped"));
		}
		this.pendingRpc.clear();

		// Resolve any waiting turn
		if (this.turnState?.resolve) {
			this.turnState.resolve(this.buildTurnResult("failed", "CodexClient stopped"));
		}

		this.reader?.close();
		this.reader = null;

		const proc = this.process;
		this.process = null;
		this.started = false;

		// Close stdin then SIGTERM
		proc.stdin?.end();
		proc.kill("SIGTERM");

		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				proc.kill("SIGKILL");
				resolve();
			}, 5000);
			proc.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});
	}

	get isRunning(): boolean {
		return this.started && this.process !== null;
	}

	// -----------------------------------------------------------------------
	// Thread management
	// -----------------------------------------------------------------------

	async startThread(conversationKey?: string, cwd?: string): Promise<string> {
		const result = (await this.sendRequest("thread/start", {
			model: this.options.model || null,
			sandbox: this.options.sandbox || "workspace-write",
			approvalPolicy: this.options.approvalPolicy || "on-request",
			approvalsReviewer: "user",
			cwd: cwd || this.options.cwd || process.cwd(),
			ephemeral: true,
			experimentalRawEvents: false,
			persistExtendedHistory: false,
		})) as { thread: { id: string } };

		const threadId = result.thread.id;
		if (conversationKey) {
			this.threads.set(conversationKey, threadId);
		}
		return threadId;
	}

	getThreadId(conversationKey: string): string | undefined {
		return this.threads.get(conversationKey);
	}

	// -----------------------------------------------------------------------
	// Turn management
	// -----------------------------------------------------------------------

	async sendTurn(threadId: string, input: string, model?: string): Promise<TurnResult> {
		// Ensure no concurrent turn on this thread
		if (this.activeThreadTurns.has(threadId) && this.turnState?.status === "running") {
			return {
				text: "",
				pendingServerRequests: [],
				items: [],
				status: "failed",
				error: "A turn is already active on this thread",
			};
		}

		// Reset turn state
		this.turnState = {
			threadId,
			text: "",
			commandOutputs: new Map(),
			fileChanges: [],
			planSteps: [],
			items: [],
			pendingServerRequests: [],
			status: "running",
		};

		const userInput = [{ type: "text" as const, text: input, text_elements: [] }];

		const turnParams: Record<string, unknown> = {
			threadId,
			input: userInput,
			approvalsReviewer: "user",
		};
		if (model) {
			turnParams.model = model;
		}

		// Send turn/start -- response comes back with turn info
		const turnResult = (await this.sendRequest("turn/start", turnParams)) as {
			turn?: { id: string };
		};
		if (turnResult.turn?.id) {
			this.turnState.turnId = turnResult.turn.id;
			this.activeThreadTurns.set(threadId, turnResult.turn.id);
		}

		// Wait for turn completion or a server request (approval)
		return this.awaitTurnResolution();
	}

	/**
	 * After responding to a server request, continue waiting for the turn to finish.
	 */
	async continueTurn(): Promise<TurnResult> {
		if (!this.turnState || this.turnState.status !== "running") {
			return {
				text: this.turnState?.text || "",
				pendingServerRequests: this.turnState?.pendingServerRequests || [],
				items: this.turnState?.items || [],
				status: this.turnState?.status === "running" ? "completed" : this.turnState?.status || "completed",
				error: this.turnState?.error,
			};
		}

		return this.awaitTurnResolution();
	}

	async interrupt(threadId: string): Promise<TurnResult> {
		const turnId = this.activeThreadTurns.get(threadId);
		if (!turnId) {
			return {
				text: "",
				pendingServerRequests: [],
				items: [],
				status: "failed",
				error: "No active turn to interrupt",
			};
		}

		await this.sendRequest("turn/interrupt", { threadId, turnId });

		// The turn/completed notification will resolve the turn
		if (this.turnState?.resolve) {
			// Already waiting -- it'll resolve via notification
			return this.awaitTurnResolution();
		}

		return this.buildTurnResult("interrupted");
	}

	// -----------------------------------------------------------------------
	// Server request responses (approvals, user input, tool calls)
	// -----------------------------------------------------------------------

	respondToServerRequest(requestId: string | number, result: unknown): void {
		this.writeMessage({ id: requestId, result });

		// Remove from pending list
		if (this.turnState) {
			this.turnState.pendingServerRequests = this.turnState.pendingServerRequests.filter((r) => r.id !== requestId);
		}
	}

	// -----------------------------------------------------------------------
	// Review
	// -----------------------------------------------------------------------

	async startReview(
		threadId: string,
		target: { type: "uncommittedChanges" } | { type: "baseBranch"; branch: string },
	): Promise<TurnResult> {
		// Reset turn state for review
		this.turnState = {
			threadId,
			text: "",
			commandOutputs: new Map(),
			fileChanges: [],
			planSteps: [],
			items: [],
			pendingServerRequests: [],
			status: "running",
		};

		await this.sendRequest("review/start", {
			threadId,
			target,
			delivery: "inline",
		});

		return this.awaitTurnResolution();
	}

	// -----------------------------------------------------------------------
	// Internal: transport
	// -----------------------------------------------------------------------

	private writeMessage(msg: Record<string, unknown>): void {
		if (!this.process?.stdin?.writable) {
			console.error("codex app-server stdin not writable");
			return;
		}
		const line = JSON.stringify(msg);
		this.process.stdin.write(`${line}\n`);
	}

	private sendRequest(method: string, params: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			this.pendingRpc.set(id, { resolve, reject });
			this.writeMessage({ id, method, params });
		});
	}

	private sendNotification(method: string, params?: unknown): void {
		const msg: Record<string, unknown> = { method };
		if (params !== undefined) {
			msg.params = params;
		}
		this.writeMessage(msg);
	}

	// -----------------------------------------------------------------------
	// Internal: message dispatch
	// -----------------------------------------------------------------------

	private handleLine(line: string): void {
		if (!line.trim()) return;

		let msg: RpcMessage;
		try {
			msg = JSON.parse(line) as RpcMessage;
		} catch {
			console.error("[codex] invalid JSON line:", line.slice(0, 200));
			return;
		}

		// Response to a client request (has id + result/error, no method)
		if (msg.id !== undefined && !msg.method) {
			this.handleResponse(msg);
			return;
		}

		// Server request (has id + method + params) -- needs a reply
		if (msg.id !== undefined && msg.method) {
			this.handleServerRequest(msg);
			return;
		}

		// Notification (method + params, no id)
		if (msg.method) {
			this.handleNotification(msg);
		}
	}

	private handleResponse(msg: RpcMessage): void {
		const pending = this.pendingRpc.get(msg.id!);
		if (!pending) return;
		this.pendingRpc.delete(msg.id!);

		if (msg.error) {
			pending.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
		} else {
			pending.resolve(msg.result);
		}
	}

	private handleServerRequest(msg: RpcMessage): void {
		const method = msg.method!;
		const params = msg.params as Record<string, unknown>;
		const id = msg.id!;

		// item/tool/call -- we don't support client-side tool execution, auto-reject
		if (method === "item/tool/call") {
			this.writeMessage({
				id,
				result: {
					contentItems: [{ type: "inputText", text: "Not supported by this client" }],
					success: false,
				},
			});
			return;
		}

		// account/chatgptAuthTokens/refresh -- not applicable, reject
		if (method === "account/chatgptAuthTokens/refresh") {
			this.writeMessage({ id, error: { code: -1, message: "Not supported" } });
			return;
		}

		// Build a PendingServerRequest for the LLM
		const pending = this.buildPendingServerRequest(id, method, params);
		if (this.turnState) {
			this.turnState.pendingServerRequests.push(pending);

			// If a turn is waiting, resolve it so the LLM can see the approval request
			if (this.turnState.resolve) {
				const resolve = this.turnState.resolve;
				this.turnState.resolve = undefined;
				resolve(this.buildTurnResult("waiting_approval"));
			}
		}
	}

	private buildPendingServerRequest(
		id: string | number,
		method: string,
		params: Record<string, unknown>,
	): PendingServerRequest {
		switch (method) {
			case "item/commandExecution/requestApproval": {
				const command = (params.command as string) || "(unknown command)";
				const cwd = params.cwd as string | undefined;
				const reason = params.reason as string | undefined;
				let detail = `Command: ${command}`;
				if (cwd) detail += ` (in ${cwd})`;
				if (reason) detail += ` -- ${reason}`;
				return {
					id,
					type: "commandExecution",
					detail,
					availableDecisions: (params.availableDecisions as unknown[]) || [
						"accept",
						"acceptForSession",
						"decline",
						"cancel",
					],
					params,
				};
			}
			case "item/fileChange/requestApproval": {
				const reason = params.reason as string | undefined;
				const grantRoot = params.grantRoot as string | undefined;
				let detail = "File change approval requested";
				if (reason) detail += `: ${reason}`;
				if (grantRoot) detail += ` (grant root: ${grantRoot})`;
				return {
					id,
					type: "fileChange",
					detail,
					availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
					params,
				};
			}
			case "item/permissions/requestApproval": {
				const reason = (params.reason as string) || "Permissions requested";
				return {
					id,
					type: "permissions",
					detail: reason,
					params,
				};
			}
			case "item/tool/requestUserInput": {
				const questions = params.questions as Array<{ id: string; text: string }>;
				const detail = questions?.map((q) => q.text).join("; ") || "User input requested";
				return { id, type: "userInput", detail, params };
			}
			case "mcpServer/elicitation/request": {
				const message = ((params as Record<string, unknown>).message as string) || "MCP elicitation";
				return {
					id,
					type: "mcpElicitation",
					detail: message,
					availableDecisions: ["accept", "decline", "cancel"],
					params,
				};
			}
			// Legacy v1 methods
			case "execCommandApproval": {
				const command = ((params.command as string[]) || []).join(" ");
				return {
					id,
					type: "legacyExec",
					detail: `Legacy exec: ${command}`,
					availableDecisions: ["approved", "approved_for_session", "denied", "abort"],
					params,
				};
			}
			case "applyPatchApproval": {
				const fileChanges = params.fileChanges as Record<string, unknown> | undefined;
				const files = fileChanges ? Object.keys(fileChanges).join(", ") : "unknown files";
				return {
					id,
					type: "legacyPatch",
					detail: `Legacy patch: ${files}`,
					availableDecisions: ["approved", "approved_for_session", "denied", "abort"],
					params,
				};
			}
			default:
				return {
					id,
					type: "commandExecution",
					detail: `Unknown server request: ${method}`,
					params,
				};
		}
	}

	private handleNotification(msg: RpcMessage): void {
		const method = msg.method!;
		const params = msg.params as Record<string, unknown>;

		if (!this.turnState) return;

		switch (method) {
			case "item/agentMessage/delta": {
				const delta = params.delta as string;
				if (delta) this.turnState.text += delta;
				break;
			}
			case "item/commandExecution/outputDelta": {
				const itemId = params.itemId as string;
				const delta = params.delta as string;
				if (itemId && delta) {
					const existing = this.turnState.commandOutputs.get(itemId) || "";
					this.turnState.commandOutputs.set(itemId, existing + delta);
				}
				break;
			}
			case "item/fileChange/outputDelta": {
				const delta = params.delta as string;
				if (delta) this.turnState.fileChanges.push(delta);
				break;
			}
			case "turn/plan/updated": {
				const plan = params.plan as Array<{ title?: string; status?: string }>;
				if (plan) {
					this.turnState.planSteps = plan.map((step) => `${step.status || "pending"}: ${step.title || "?"}`);
				}
				break;
			}
			case "turn/diff/updated": {
				const diff = params.diff as string;
				if (diff) {
					this.turnState.items.push(`[diff] ${diff.split("\n")[0] || "changes"}`);
				}
				break;
			}
			case "turn/started": {
				const turn = params.turn as { id: string } | undefined;
				if (turn?.id && this.turnState) {
					this.turnState.turnId = turn.id;
					this.activeThreadTurns.set(this.turnState.threadId, turn.id);
				}
				break;
			}
			case "turn/completed": {
				const turn = params.turn as { status?: string; error?: { message?: string } } | undefined;
				const status = turn?.status;

				if (status === "interrupted") {
					this.turnState.status = "interrupted";
				} else if (status === "failed") {
					this.turnState.status = "failed";
					this.turnState.error = turn?.error?.message || "Turn failed";
				} else {
					this.turnState.status = "completed";
				}

				this.activeThreadTurns.delete(this.turnState.threadId);

				if (this.turnState.resolve) {
					const resolve = this.turnState.resolve;
					this.turnState.resolve = undefined;
					resolve(this.buildTurnResult(this.turnState.status, this.turnState.error));
				}
				break;
			}
			case "item/started": {
				const item = params.item as { type?: string; id?: string } | undefined;
				if (item?.type) {
					this.turnState.items.push(`[started] ${item.type} (${item.id || "?"})`);
				}
				break;
			}
			case "item/completed": {
				const item = params.item as { type?: string; id?: string } | undefined;
				if (item?.type) {
					this.turnState.items.push(`[completed] ${item.type} (${item.id || "?"})`);
				}
				break;
			}
			case "error": {
				const error = params.error as { message?: string } | undefined;
				const willRetry = params.willRetry as boolean;
				if (error?.message) {
					if (!willRetry) {
						this.turnState.error = error.message;
					}
					this.turnState.items.push(`[error] ${error.message}${willRetry ? " (will retry)" : ""}`);
				}
				break;
			}
			case "serverRequest/resolved":
			case "thread/started":
			case "thread/status/changed":
			case "thread/closed":
			case "thread/name/updated":
			case "thread/tokenUsage/updated":
			case "thread/compacted":
			case "thread/archived":
			case "thread/unarchived":
			case "model/rerouted":
			case "configWarning":
			case "deprecationNotice":
			case "item/autoApprovalReview/started":
			case "item/autoApprovalReview/completed":
			case "item/plan/delta":
			case "item/reasoning/summaryTextDelta":
			case "item/reasoning/summaryPartAdded":
			case "item/reasoning/textDelta":
			case "item/commandExecution/terminalInteraction":
			case "item/mcpToolCall/progress":
			case "rawResponseItem/completed":
			case "skills/changed":
			case "hook/started":
			case "hook/completed":
			case "account/updated":
			case "account/rateLimits/updated":
			case "account/login/completed":
			case "app/list/updated":
			case "command/exec/outputDelta":
			case "fuzzyFileSearch/sessionUpdated":
			case "fuzzyFileSearch/sessionCompleted":
			case "mcpServer/oauthLogin/completed":
			case "thread/realtime/started":
			case "thread/realtime/itemAdded":
			case "thread/realtime/outputAudio/delta":
			case "thread/realtime/error":
			case "thread/realtime/closed":
			case "windows/worldWritableWarning":
			case "windowsSandbox/setupCompleted":
				// Explicitly ignored -- no action needed
				break;
			default:
				// Unknown notification -- log but don't crash
				console.error(`[codex] unknown notification: ${method}`);
				break;
		}
	}

	// -----------------------------------------------------------------------
	// Internal: helpers
	// -----------------------------------------------------------------------

	private awaitTurnResolution(): Promise<TurnResult> {
		if (!this.turnState) {
			return Promise.resolve({
				text: "",
				pendingServerRequests: [],
				items: [],
				status: "failed",
				error: "No active turn",
			});
		}

		// If turn already resolved (e.g. completed before we started waiting)
		if (this.turnState.status !== "running") {
			return Promise.resolve(this.buildTurnResult(this.turnState.status, this.turnState.error));
		}

		// If there are pending server requests, return immediately
		if (this.turnState.pendingServerRequests.length > 0) {
			return Promise.resolve(this.buildTurnResult("waiting_approval"));
		}

		return new Promise<TurnResult>((resolve) => {
			this.turnState!.resolve = resolve;
		});
	}

	private buildTurnResult(
		status: "completed" | "waiting_approval" | "interrupted" | "failed",
		error?: string,
	): TurnResult {
		const state = this.turnState;
		if (!state) {
			return { text: "", pendingServerRequests: [], items: [], status, error };
		}

		// Build command output summaries
		const cmdSummaries: string[] = [];
		for (const [itemId, output] of state.commandOutputs) {
			const preview = output.length > 500 ? `${output.slice(0, 500)}...` : output;
			cmdSummaries.push(`[cmd ${itemId}] ${preview}`);
		}

		return {
			text: state.text,
			pendingServerRequests: [...state.pendingServerRequests],
			items: [...state.items, ...cmdSummaries, ...state.planSteps],
			status,
			error: error || state.error,
		};
	}

	private handleProcessExit(): void {
		this.started = false;

		// Reject all pending RPCs
		for (const [, pending] of this.pendingRpc) {
			pending.reject(new Error("codex app-server process exited"));
		}
		this.pendingRpc.clear();

		// Fail any active turn
		if (this.turnState?.resolve) {
			const resolve = this.turnState.resolve;
			this.turnState.resolve = undefined;
			this.turnState.status = "failed";
			this.turnState.error = "codex app-server process exited";
			resolve(this.buildTurnResult("failed", "codex app-server process exited"));
		}

		this.activeThreadTurns.clear();
	}
}
