import type { BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";
import type { ApprovalDecision, ApprovalPolicy, ExecutionMode, InterventionMode } from "../types.js";

export interface BashApprovalRequest {
	taskId: string;
	reason: string;
	command: string;
	approvalKey?: string;
	riskLevel?: BashRiskLevel;
	category?: string;
}

export interface BashSafetyOptions {
	taskId: string;
	interventionMode: InterventionMode;
	executionMode?: ExecutionMode;
	approvalPolicy?: ApprovalPolicy;
	requestApproval?: (request: BashApprovalRequest) => Promise<ApprovalDecision>;
	allowLocalServerLifecycle?: boolean;
}

export interface BashExplainOptions {
	allowLocalServerLifecycle?: boolean;
}

export type BashRiskLevel = "safe" | "medium" | "high";

export interface BashCommandRisk {
	level: BashRiskLevel;
	category: string;
	reason?: string;
	approvalKey?: string;
}

const SAFE_MKDIR_PATTERN = /^(?:mkdir|md)\s+(?:-p\s+)?[a-zA-Z0-9_./-]+(?:\s+[a-zA-Z0-9_./-]+)*$/i;
const SAFE_NODE_SERVER_START = /^node\s+[a-zA-Z0-9_./-]+\.js\s*&?\s*$/i;
const SAFE_NPM_SERVER_START = /^npm\s+(?:(?:run\s+(?:start|preview|serve))|start)\s*&?\s*$/i;
const SAFE_LOCAL_HTTP_CHECK =
	/^(?:curl|wget)\s+(?:"|')?https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/"'\s?#]|$)/i;
const SAFE_KILL = /^(?:kill|pkill)\s+/i;
const SAFE_TEST_RUNNER = /\b(?:mocha|jest|vitest|node --test|npm test|npm run test|npx mocha|npx jest|npx vitest)\b/i;
const MEDIUM_PACKAGE_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove)\b/i;
const MEDIUM_PACKAGE_RUNNER = /\bnpx\s+/i;
const MEDIUM_LOCAL_SERVICE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+dev|run\s+start|start|run\s+preview|run\s+serve)\b/i;
const HIGH_DELETE = /\b(?:rm|del|erase|rmdir)\s+/i;
const HIGH_CHMOD = /\bchmod\s+/i;
const HIGH_DOCKER = /\bdocker\s+(?:build|up)\b|\bdocker\s+compose\s+(?:build|up)\b|\bdocker-compose\s+(?:build|up)\b/i;
const HIGH_NETWORK_PIPE = /\b(?:curl|wget)\b[\s\S]*\|\s*(?:bash|sh)\b/i;
const HIGH_COMMAND_SUBSTITUTION = /\$\(|`/;

function isSafeDirectoryCreation(command: string): boolean {
	const normalized = command.trim();
	if (/[;&|>`$]/.test(normalized)) return false;
	return SAFE_MKDIR_PATTERN.test(normalized);
}

function hasShellControlSyntax(command: string): boolean {
	return /[;|`$]/.test(command);
}

function isSafeLocalHttpCheck(command: string): boolean {
	if (hasShellControlSyntax(command) || /(?:^|[^&])&(?!&)/.test(command)) return false;
	return SAFE_LOCAL_HTTP_CHECK.test(command);
}

function isSafeLocalServerLifecycleCommand(command: string): boolean {
	return (
		SAFE_NODE_SERVER_START.test(command) ||
		SAFE_NPM_SERVER_START.test(command) ||
		isSafeLocalHttpCheck(command) ||
		SAFE_KILL.test(command)
	);
}

function commandTokens(command: string): string[] {
	return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function stripQuotes(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function pathTargetKey(command: string): string {
	const targets = commandTokens(command)
		.slice(1)
		.map(stripQuotes)
		.filter((token) => token && !token.startsWith("-"));
	return targets.length > 0 ? targets.join(",") : normalizeCommand(command);
}

function firstUrlOrigin(command: string): string | undefined {
	const match = /https?:\/\/[^\s"'|)]+/i.exec(command);
	if (!match) return undefined;
	try {
		return new URL(match[0]).origin;
	} catch {
		return undefined;
	}
}

function highRisk(command: string): BashCommandRisk | undefined {
	if (HIGH_COMMAND_SUBSTITUTION.test(command)) {
		return {
			level: "high",
			category: "command-substitution",
			reason: "high-risk bash command uses command substitution.",
			approvalKey: `high:command-substitution:${normalizeCommand(command)}`,
		};
	}
	if (HIGH_NETWORK_PIPE.test(command)) {
		const origin = firstUrlOrigin(command) ?? normalizeCommand(command);
		return {
			level: "high",
			category: "network-pipe",
			reason: "high-risk bash command downloads external content and pipes it to a shell.",
			approvalKey: `high:network-pipe:${origin}`,
		};
	}
	if (HIGH_DELETE.test(command)) {
		return {
			level: "high",
			category: "delete",
			reason: "high-risk bash command may delete files.",
			approvalKey: `high:delete:${pathTargetKey(command)}`,
		};
	}
	if (HIGH_CHMOD.test(command)) {
		return {
			level: "high",
			category: "chmod",
			reason: "high-risk bash command changes executable permissions.",
			approvalKey: `high:chmod:${pathTargetKey(command)}`,
		};
	}
	if (HIGH_DOCKER.test(command)) {
		return {
			level: "high",
			category: "docker",
			reason: "high-risk bash command starts or builds Docker resources.",
			approvalKey: `high:docker:${normalizeCommand(command)}`,
		};
	}
	if (/^(?:curl|wget)\s+/i.test(command) && !isSafeLocalHttpCheck(command)) {
		const origin = firstUrlOrigin(command) ?? normalizeCommand(command);
		return {
			level: "high",
			category: "external-network",
			reason: "high-risk bash command accesses a non-local network endpoint.",
			approvalKey: `high:external-network:${origin}`,
		};
	}
	return undefined;
}

function mediumRisk(command: string): BashCommandRisk | undefined {
	if (MEDIUM_PACKAGE_COMMAND.test(command)) {
		return {
			level: "medium",
			category: "package-management",
			reason: "medium-risk bash command changes project dependencies.",
			approvalKey: `medium:package-management:${normalizeCommand(command)}`,
		};
	}
	if (MEDIUM_PACKAGE_RUNNER.test(command)) {
		return {
			level: "medium",
			category: "package-runner",
			reason: "medium-risk bash command runs a package executable.",
			approvalKey: `medium:package-runner:${normalizeCommand(command)}`,
		};
	}
	if (MEDIUM_LOCAL_SERVICE.test(command) || /(?:^|[^&])&(?!&)/.test(command)) {
		return {
			level: "medium",
			category: "local-service",
			reason: "medium-risk bash command starts a local service or background process.",
			approvalKey: `medium:local-service:${normalizeCommand(command)}`,
		};
	}
	return undefined;
}

export function classifyBashCommand(command: string, options: BashExplainOptions = {}): BashCommandRisk {
	const normalized = command.trim();
	if (!normalized) {
		return {
			level: "high",
			category: "empty",
			reason: "high-risk bash command is empty and not useful for this task.",
			approvalKey: "high:empty",
		};
	}
	if (isSafeDirectoryCreation(normalized)) return { level: "safe", category: "file-operation" };
	if (SAFE_TEST_RUNNER.test(normalized)) return { level: "safe", category: "self-check" };
	if (isSafeLocalHttpCheck(normalized)) return { level: "safe", category: "local-http" };
	if (options.allowLocalServerLifecycle && isSafeLocalServerLifecycleCommand(normalized)) {
		return { level: "safe", category: "local-server-lifecycle" };
	}
	return highRisk(normalized) ?? mediumRisk(normalized) ?? { level: "safe", category: "general" };
}

export function explainUnsafeBash(command: string, options: BashExplainOptions = {}): string | undefined {
	const risk = classifyBashCommand(command, options);
	return risk.level === "safe" ? undefined : risk.reason;
}

export function createBashSafetyGuard(
	options: BashSafetyOptions,
): (context: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined> {
	return async (context) => {
		if (context.toolCall.name !== "bash") return undefined;
		const args = context.args as { command?: string };
		const command = args.command ?? "";
		const risk = classifyBashCommand(command, {
			allowLocalServerLifecycle: options.allowLocalServerLifecycle,
		});
		if (risk.level === "safe") return undefined;

		const policy = options.approvalPolicy ?? "minimal";
		const requiresApproval = risk.level === "high" || policy === "strict";
		if (!requiresApproval) return undefined;

		const reason =
			risk.reason ?? `${risk.level === "high" ? "High" : "Medium"}-risk bash command requires approval by policy.`;

		if (options.interventionMode === "none" || !options.requestApproval) {
			return {
				block: true,
				reason: `${reason} Use read/grep/find/ls or request a safer targeted change through write/edit.`,
			};
		}

		const decision = await options.requestApproval({
			taskId: options.taskId,
			reason,
			command,
			approvalKey: risk.approvalKey,
			riskLevel: risk.level,
			category: risk.category,
		});
		if (decision === "approve") return undefined;
		return { block: true, reason: `Bash command rejected by approval flow: ${reason}` };
	};
}
