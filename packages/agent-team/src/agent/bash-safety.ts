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
}

const DANGEROUS_PATTERNS = [
	/\brm\s+.*(?:-[a-z]*[rf][a-z]*|\/s|\/q)/i,
	/\b(?:del|erase|rmdir)\s+.*(?:\/s|\/q|-[a-z]*[rf][a-z]*)/i,
	/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|start|run\s+(?:dev|build|test|start)|test)\b/i,
	/\bdocker\s+(?:build|up)\b/i,
	/\bdocker\s+compose\s+(?:build|up)\b/i,
	/\bdocker-compose\s+(?:build|up)\b/i,
];

const SAFE_MKDIR_PATTERN = /^(?:mkdir|md)\s+(?:-p\s+)?[a-zA-Z0-9_./-]+(?:\s+[a-zA-Z0-9_./-]+)*$/i;

function isSafeDirectoryCreation(command: string): boolean {
	const normalized = command.trim();
	if (/[;&|>`$]/.test(normalized)) return false;
	return SAFE_MKDIR_PATTERN.test(normalized);
}

export function explainUnsafeBash(command: string): string | undefined {
	const normalized = command.trim();
	if (!normalized) return "Empty bash command is not useful for this task.";
	if (isSafeDirectoryCreation(normalized)) return undefined;
	if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(normalized))) {
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
		const reason = explainUnsafeBash(command);
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
