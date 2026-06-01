import type { BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";
import type { ApprovalDecision, InterventionMode } from "../types.js";

export interface BashApprovalRequest {
	taskId: string;
	reason: string;
	command: string;
}

export interface BashSafetyOptions {
	taskId: string;
	interventionMode: InterventionMode;
	requestApproval?: (request: BashApprovalRequest) => Promise<ApprovalDecision>;
	allowLocalServerLifecycle?: boolean;
}

export interface BashExplainOptions {
	allowLocalServerLifecycle?: boolean;
}

const ALWAYS_DANGEROUS_PATTERNS = [
	/\$\(|`/,
	/\brm\s+/i,
	/\b(?:del|erase|rmdir)\s+.*(?:\/s|\/q|-[a-z]*[rf][a-z]*)/i,
	/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|run\s+dev)\b/i,
	/\bnpx\s+/i,
	/\bchmod\s+/i,
	/\b(?:curl|wget)\b[\s\S]*\|\s*(?:bash|sh)\b/i,
	/\bdocker\s+(?:build|up)\b/i,
	/\bdocker\s+compose\s+(?:build|up)\b/i,
	/\bdocker-compose\s+(?:build|up)\b/i,
];

const GENERAL_DANGEROUS_PATTERNS = [
	/(?:^|[^&])&(?!&)/,
	/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+start|start)\b/i,
	/^(?:curl|wget)\s+/i,
];
const SAFE_MKDIR_PATTERN = /^(?:mkdir|md)\s+(?:-p\s+)?[a-zA-Z0-9_./-]+(?:\s+[a-zA-Z0-9_./-]+)*$/i;
const SAFE_NODE_SERVER_START = /^node\s+[a-zA-Z0-9_./-]+\.js\s*&?\s*$/i;
const SAFE_NPM_SERVER_START = /^npm\s+(?:(?:run\s+(?:start|preview|serve))|start)\s*&?\s*$/i;
const SAFE_LOCAL_HTTP_CHECK =
	/^(?:curl|wget)\s+(?:"|')?https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/"'\s?#]|$)/i;
const SAFE_KILL = /^(?:kill|pkill)\s+/i;
const SAFE_TEST_RUNNER = /\b(?:mocha|jest|vitest|node --test|npm test|npm run test|npx mocha|npx jest|npx vitest)\b/i;

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

export function explainUnsafeBash(command: string, options: BashExplainOptions = {}): string | undefined {
	const normalized = command.trim();
	if (!normalized) return "Empty bash command is not useful for this task.";
	if (isSafeDirectoryCreation(normalized)) return undefined;
	if (SAFE_TEST_RUNNER.test(normalized)) return undefined;
	if (options.allowLocalServerLifecycle && isSafeLocalServerLifecycleCommand(normalized)) return undefined;
	if (
		ALWAYS_DANGEROUS_PATTERNS.some((pattern) => pattern.test(normalized)) ||
		GENERAL_DANGEROUS_PATTERNS.some((pattern) => pattern.test(normalized))
	) {
		return "Bash command may delete files, install dependencies, start long-lived services, or consume excessive resources.";
	}
	return undefined;
}

export function createBashSafetyGuard(
	options: BashSafetyOptions,
): (context: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined> {
	return async (context) => {
		if (context.toolCall.name !== "bash") return undefined;
		const args = context.args as { command?: string };
		const command = args.command ?? "";
		const reason = explainUnsafeBash(command, {
			allowLocalServerLifecycle: options.allowLocalServerLifecycle,
		});
		if (!reason) return undefined;

		if (options.interventionMode === "none" || !options.requestApproval) {
			return {
				block: true,
				reason: `${reason} Use read/grep/find/ls or request a safer targeted change through write/edit.`,
			};
		}

		const decision = await options.requestApproval({ taskId: options.taskId, reason, command });
		if (decision === "approve") return undefined;
		return { block: true, reason: `Bash command rejected by approval flow: ${reason}` };
	};
}
