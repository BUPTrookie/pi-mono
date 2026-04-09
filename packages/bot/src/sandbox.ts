/**
 * Command execution abstraction.
 * Provides HostExecutor (direct) and SandboxExecutor (OS-level sandbox via @anthropic-ai/sandbox-runtime).
 */

import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { spawn } from "child_process";
import type { SandboxConfig } from "./config.js";

export interface Executor {
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}

export interface ExecOptions {
	timeout?: number;
	signal?: AbortSignal;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export class HostExecutor implements Executor {
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return new Promise((resolve, reject) => {
			const shell = process.platform === "win32" ? "cmd" : "sh";
			const shellArgs = process.platform === "win32" ? ["/c"] : ["-c"];

			const child = spawn(shell, [...shellArgs, command], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;

			const timeoutHandle =
				options?.timeout && options.timeout > 0
					? setTimeout(() => {
							timedOut = true;
							killProcessTree(child.pid!);
						}, options.timeout * 1000)
					: undefined;

			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString();
				if (stdout.length > 10 * 1024 * 1024) {
					stdout = stdout.slice(0, 10 * 1024 * 1024);
				}
			});

			child.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
				if (stderr.length > 10 * 1024 * 1024) {
					stderr = stderr.slice(0, 10 * 1024 * 1024);
				}
			});

			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}

				if (options?.signal?.aborted) {
					reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
					return;
				}

				if (timedOut) {
					reject(new Error(`${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim()));
					return;
				}

				resolve({ stdout, stderr, code: code ?? 0 });
			});
		});
	}
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore errors
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}

// ============================================================================
// OS-level sandbox via @anthropic-ai/sandbox-runtime
// ============================================================================

const DEFAULT_SANDBOX_RUNTIME_CONFIG: SandboxRuntimeConfig = {
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

/**
 * Merge user sandbox config with defaults to produce a SandboxRuntimeConfig.
 */
function buildRuntimeConfig(config: SandboxConfig): SandboxRuntimeConfig {
	return {
		network: {
			allowedDomains: config.network?.allowedDomains ?? DEFAULT_SANDBOX_RUNTIME_CONFIG.network.allowedDomains,
			deniedDomains: config.network?.deniedDomains ?? DEFAULT_SANDBOX_RUNTIME_CONFIG.network.deniedDomains,
		},
		filesystem: {
			denyRead: config.filesystem?.denyRead ?? DEFAULT_SANDBOX_RUNTIME_CONFIG.filesystem.denyRead,
			allowWrite: config.filesystem?.allowWrite ?? DEFAULT_SANDBOX_RUNTIME_CONFIG.filesystem.allowWrite,
			denyWrite: config.filesystem?.denyWrite ?? DEFAULT_SANDBOX_RUNTIME_CONFIG.filesystem.denyWrite,
		},
	};
}

let sandboxInitialized = false;

/**
 * Initialize the OS-level sandbox. Must be called before creating a SandboxExecutor.
 * Returns false if the platform is not supported.
 */
export async function initializeSandbox(config: SandboxConfig): Promise<boolean> {
	const platform = process.platform;
	if (platform !== "darwin" && platform !== "linux") {
		return false;
	}

	const runtimeConfig = buildRuntimeConfig(config);
	await SandboxManager.initialize(runtimeConfig);
	sandboxInitialized = true;
	return true;
}

/**
 * Tear down the sandbox (release proxy ports, stop log monitors).
 */
export async function resetSandbox(): Promise<void> {
	if (sandboxInitialized) {
		try {
			await SandboxManager.reset();
		} catch {
			// Ignore cleanup errors
		}
		sandboxInitialized = false;
	}
}

/**
 * Executor that wraps every command with OS-level sandbox enforcement.
 * Uses SandboxManager.wrapWithSandbox() from @anthropic-ai/sandbox-runtime.
 *
 * On macOS: uses sandbox-exec (seatbelt) with per-command profiles.
 * On Linux: uses bubblewrap with network namespace isolation + seccomp.
 */
export class SandboxExecutor implements Executor {
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

		return new Promise((resolve, reject) => {
			// sandbox-exec requires bash, not sh
			const child = spawn("bash", ["-c", wrappedCommand], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;

			const timeoutHandle =
				options?.timeout && options.timeout > 0
					? setTimeout(() => {
							timedOut = true;
							killProcessTree(child.pid!);
						}, options.timeout * 1000)
					: undefined;

			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString();
				if (stdout.length > 10 * 1024 * 1024) {
					stdout = stdout.slice(0, 10 * 1024 * 1024);
				}
			});

			child.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
				if (stderr.length > 10 * 1024 * 1024) {
					stderr = stderr.slice(0, 10 * 1024 * 1024);
				}
			});

			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}

				if (options?.signal?.aborted) {
					reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
					return;
				}

				if (timedOut) {
					reject(new Error(`${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim()));
					return;
				}

				// Annotate stderr with sandbox violation info if available
				const annotatedStderr = SandboxManager.annotateStderrWithSandboxFailures(command, stderr);

				resolve({ stdout, stderr: annotatedStderr, code: code ?? 0 });
			});
		});
	}
}
