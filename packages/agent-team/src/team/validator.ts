import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { TeamPlan, ValidationIssue } from "../types.js";

interface PackageJson {
	main?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

interface CommandSpec {
	id: string;
	command: string;
	args: string[];
	timeoutMs: number;
	shell?: boolean;
	ownerTaskId?: string;
	ownerRole?: string;
	file?: string;
}

interface CommandResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
}

export interface RuntimeValidationOptions {
	installDependencies?: boolean;
	runPackageScripts?: boolean;
	runSyntaxChecks?: boolean;
	commandTimeoutMs?: number;
	installTimeoutMs?: number;
	signal?: AbortSignal;
}

interface ResolvedRuntimeValidationOptions {
	installDependencies: boolean;
	runPackageScripts: boolean;
	runSyntaxChecks: boolean;
	commandTimeoutMs: number;
	installTimeoutMs: number;
	signal?: AbortSignal;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 180_000;
const MAX_COMMAND_OUTPUT_CHARS = 12_000;

function issue(
	id: string,
	message: string,
	options: Omit<ValidationIssue, "id" | "message"> = { severity: "error" },
): ValidationIssue {
	return { id, message, ...options };
}

function existsOutput(outputDir: string, relativePath: string): boolean {
	return existsSync(join(outputDir, relativePath));
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function readPackageJson(outputDir: string): PackageJson | undefined {
	return readJson(join(outputDir, "package.json")) as PackageJson | undefined;
}

function collectFiles(root: string, limit = 300): string[] {
	const files: string[] = [];
	const visit = (dir: string): void => {
		if (files.length >= limit || !existsSync(dir)) return;
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry === ".git") continue;
			const full = join(dir, entry);
			const stat = statSync(full);
			if (stat.isDirectory()) {
				visit(full);
			} else {
				files.push(full);
			}
		}
	};
	visit(root);
	return files;
}

function readProjectText(outputDir: string): string {
	return collectFiles(outputDir)
		.filter((file) => !file.split(/[\\/]/).join("/").includes("/docs/contracts/"))
		.filter((file) => /\.(ts|tsx|js|jsx|json|md|html|css)$/i.test(file))
		.map((file) => {
			try {
				return readFileSync(file, "utf-8");
			} catch {
				return "";
			}
		})
		.join("\n");
}

function getOpenApiPaths(outputDir: string): string[] {
	const openApi = readJson(join(outputDir, "docs/contracts/openapi.json"));
	const paths = openApi?.paths;
	if (!paths || typeof paths !== "object") return [];
	return Object.keys(paths);
}

/**
 * Check whether an OpenAPI path (e.g. /api/polls/{pollId}/votes) is represented
 * in the project source text. Matches against multiple patterns:
 *   - The path with params removed and slashes collapsed: /api/polls/votes
 *   - Express-style route: /api/polls/:pollId/votes
 *   - Just the meaningful segments joined: polls/votes
 */
function isOpenApiPathRepresented(apiPath: string, projectText: string): boolean {
	// Pattern 1: collapse {param} segments — /api/polls/{pollId}/votes → /api/polls/votes
	const collapsed = apiPath.replace(/\/\{[^}]+\}/g, "/");
	if (projectText.includes(collapsed)) return true;

	// Pattern 2: Express :param style — /api/polls/:pollId/votes
	const expressStyle = apiPath.replace(/\{([^}]+)\}/g, ":$1");
	if (projectText.includes(expressStyle)) return true;

	// Pattern 3: meaningful segments only — ["polls", "votes"] or ["auth", "register"]
	const segments = apiPath.split("/").filter((s) => s && !s.startsWith("{") && s !== "api");
	if (segments.length >= 2) {
		const tail = segments.join("/");
		if (projectText.includes(tail)) return true;
	}

	return false;
}

function npmCommand(): string {
	return "npm";
}

function npmCommandSpec(args: string[]): Pick<CommandSpec, "command" | "args" | "shell"> {
	if (process.platform === "win32") {
		return { command: ["npm", ...args].join(" "), args: [], shell: true };
	}
	return { command: npmCommand(), args };
}

function truncateOutput(text: string): string {
	if (text.length <= MAX_COMMAND_OUTPUT_CHARS) return text;
	return text.slice(text.length - MAX_COMMAND_OUTPUT_CHARS);
}

function runCommand(outputDir: string, spec: CommandSpec, signal?: AbortSignal): Promise<CommandResult> {
	return new Promise((resolveCommand) => {
		let output = "";
		let settled = false;
		let timedOut = false;
		let timeout: NodeJS.Timeout | undefined;
		const append = (chunk: Buffer): void => {
			output = truncateOutput(output + chunk.toString("utf-8"));
		};
		const finish = (exitCode: number | null): void => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			resolveCommand({ exitCode, output: output.trim(), timedOut });
		};
		const abort = (): void => {
			timedOut = signal?.aborted ?? timedOut;
			child.kill();
			finish(null);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(spec.command, spec.args, {
				cwd: outputDir,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				shell: spec.shell ?? false,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			resolveCommand({ exitCode: 1, output: message, timedOut: false });
			return;
		}
		timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
			finish(null);
		}, spec.timeoutMs);

		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", (error) => {
			append(Buffer.from(error.message));
			finish(1);
		});
		child.on("close", finish);
		if (signal) {
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

function hasDependencies(packageJson: PackageJson): boolean {
	return (
		Object.keys(packageJson.dependencies ?? {}).length > 0 ||
		Object.keys(packageJson.devDependencies ?? {}).length > 0
	);
}

function isUsefulTestScript(script: string | undefined): boolean {
	if (!script) return false;
	return !/no test specified/i.test(script);
}

function scriptExists(packageJson: PackageJson, name: string): boolean {
	return typeof packageJson.scripts?.[name] === "string" && packageJson.scripts[name].trim().length > 0;
}

function ownerForFile(plan: TeamPlan, file: string): Pick<ValidationIssue, "ownerRole" | "ownerTaskId"> {
	const normalized = file.split(/[\\/]/).join("/");
	let ownerTask: TeamPlan["tasks"][number] | undefined;
	let bestLength = -1;
	for (const task of plan.tasks) {
		for (const owned of task.ownedDirectories) {
			const ownedPath = owned.split(/[\\/]/).join("/");
			const pathLength = ownedPath === "." ? 0 : ownedPath.length;
			const matches = ownedPath === "." || normalized === ownedPath || normalized.startsWith(`${ownedPath}/`);
			if (matches && pathLength > bestLength) {
				ownerTask = task;
				bestLength = pathLength;
			}
		}
	}
	return { ownerRole: ownerTask?.role, ownerTaskId: ownerTask?.id };
}

function ownerForPackage(plan: TeamPlan): Pick<ValidationIssue, "ownerRole" | "ownerTaskId"> {
	const ownerTask =
		plan.tasks.find((task) => task.expectedOutputs.includes("package.json")) ??
		plan.tasks.find(
			(task) => task.ownedDirectories.includes(".") || task.ownedDirectories.includes("package.json"),
		) ??
		plan.tasks[0];
	return { ownerRole: ownerTask?.role, ownerTaskId: ownerTask?.id };
}

function ownerForWholeProjectCheck(plan: TeamPlan): Pick<ValidationIssue, "ownerRole" | "ownerTaskId"> {
	const qaTask =
		plan.tasks.find((task) => /test|qa|validat|review/i.test(`${task.id} ${task.role} ${task.subject}`)) ??
		plan.tasks.find((task) => task.expectedOutputs.some((output) => output.startsWith("tests"))) ??
		plan.tasks[0];
	return { ownerRole: qaTask?.role, ownerTaskId: qaTask?.id };
}

function ownerForApiImplementation(plan: TeamPlan): Pick<ValidationIssue, "ownerRole" | "ownerTaskId"> {
	const apiTask =
		plan.tasks.find((task) => /api|backend|server|route|endpoint/i.test(`${task.id} ${task.role} ${task.subject}`)) ??
		plan.tasks.find((task) =>
			task.expectedOutputs.some((output) => /^(src|server|api|app|package\.json)(\/|$)/i.test(output)),
		) ??
		plan.tasks[0];
	return { ownerRole: apiTask?.role, ownerTaskId: apiTask?.id };
}

function commandLabel(spec: CommandSpec): string {
	return [spec.command, ...spec.args].join(" ");
}

function issueForCommandFailure(spec: CommandSpec, result: CommandResult): ValidationIssue {
	const suffix = result.timedOut
		? `timed out after ${Math.round(spec.timeoutMs / 1000)}s`
		: `exited with code ${result.exitCode}`;
	const output = result.output ? `\nOutput:\n${result.output}` : "";
	return issue(`runtime-check-${spec.id}`, `Runtime check failed: ${commandLabel(spec)} ${suffix}.${output}`, {
		severity: "error",
		ownerRole: spec.ownerRole,
		ownerTaskId: spec.ownerTaskId,
		file: spec.file,
	});
}

function buildRuntimeCommands(
	outputDir: string,
	plan: TeamPlan,
	options: ResolvedRuntimeValidationOptions,
): CommandSpec[] {
	const packageJson = readPackageJson(outputDir);
	if (!packageJson) return [];

	const packageOwner = ownerForPackage(plan);
	const projectOwner = ownerForWholeProjectCheck(plan);
	const commands: CommandSpec[] = [];

	if (options.installDependencies && hasDependencies(packageJson) && !existsSync(join(outputDir, "node_modules"))) {
		commands.push({
			id: "npm-install",
			...npmCommandSpec(["install"]),
			timeoutMs: options.installTimeoutMs,
			file: "package.json",
			...packageOwner,
		});
	}

	if (options.runPackageScripts && scriptExists(packageJson, "check")) {
		commands.push({
			id: "npm-run-check",
			...npmCommandSpec(["run", "check"]),
			timeoutMs: options.commandTimeoutMs,
			file: "package.json",
			...packageOwner,
		});
	}

	if (options.runPackageScripts && isUsefulTestScript(packageJson.scripts?.test)) {
		commands.push({
			id: "npm-test",
			...npmCommandSpec(["test"]),
			timeoutMs: options.commandTimeoutMs,
			file: "package.json",
			...projectOwner,
		});
	}

	if (options.runPackageScripts && scriptExists(packageJson, "build")) {
		commands.push({
			id: "npm-run-build",
			...npmCommandSpec(["run", "build"]),
			timeoutMs: options.commandTimeoutMs,
			file: "package.json",
			...projectOwner,
		});
	}

	return commands;
}

function collectSyntaxCheckFiles(outputDir: string): string[] {
	return collectFiles(outputDir, 120)
		.filter((file) => /\.(cjs|mjs|js)$/i.test(file))
		.filter((file) => !file.split(/[\\/]/).join("/").includes("/docs/contracts/"))
		.slice(0, 80);
}

function buildSyntaxCommands(outputDir: string, plan: TeamPlan, timeoutMs: number): CommandSpec[] {
	return collectSyntaxCheckFiles(outputDir).map((file) => {
		const relativePath = relative(outputDir, file);
		return {
			id: `node-check-${relativePath.replace(/[^a-z0-9]+/gi, "-")}`,
			command: process.execPath,
			args: ["--check", relativePath],
			timeoutMs,
			file: relativePath,
			...ownerForFile(plan, relativePath),
		};
	});
}

export function validateTeamOutput(outputDir: string, plan: TeamPlan): ValidationIssue[] {
	const issues: ValidationIssue[] = [];

	for (const contract of plan.contracts) {
		if (contract.required && !existsOutput(outputDir, contract.path)) {
			issues.push(
				issue(`missing-contract-${contract.kind}`, `Required contract is missing: ${contract.path}`, {
					severity: "error",
					ownerTaskId: contract.ownerTaskId,
					file: contract.path,
				}),
			);
		}
	}

	for (const task of plan.tasks) {
		for (const expected of task.expectedOutputs) {
			if (!existsOutput(outputDir, expected)) {
				issues.push(
					issue(
						`missing-output-${task.id}-${expected.replace(/[^a-z0-9]+/gi, "-")}`,
						`Task ${task.id} did not produce expected output: ${expected}`,
						{ severity: "error", ownerRole: task.role, ownerTaskId: task.id, file: expected },
					),
				);
			}
		}
	}

	const packageJsonPath = join(outputDir, "package.json");
	if (existsSync(packageJsonPath)) {
		const packageJson = readJson(packageJsonPath);
		const scripts = packageJson?.scripts;
		if (!packageJson) {
			issues.push(
				issue("invalid-package-json", "Root package.json is not valid JSON.", {
					severity: "error",
					file: "package.json",
				}),
			);
		} else if (!scripts || typeof scripts !== "object" || Object.keys(scripts).length === 0) {
			issues.push(
				issue("missing-package-scripts", "Root package.json must expose at least one useful script.", {
					severity: "error",
					file: "package.json",
					...ownerForPackage(plan),
				}),
			);
		}
	}

	const openApiPaths = getOpenApiPaths(outputDir);
	if (openApiPaths.length > 0) {
		const projectText = readProjectText(outputDir);
		for (const apiPath of openApiPaths) {
			if (isOpenApiPathRepresented(apiPath, projectText)) continue;
			issues.push(
				issue(
					`missing-openapi-path-${apiPath.replace(/[^a-z0-9]+/gi, "-")}`,
					`OpenAPI path is not represented in implementation: ${apiPath}`,
					{
						severity: "error",
						...ownerForApiImplementation(plan),
					},
				),
			);
		}
	}

	return issues;
}

export async function validateTeamOutputWithChecks(
	outputDir: string,
	plan: TeamPlan,
	signalOrOptions?: AbortSignal | RuntimeValidationOptions,
): Promise<ValidationIssue[]> {
	const staticIssues = validateTeamOutput(outputDir, plan);
	if (staticIssues.some((item) => item.severity === "error")) return staticIssues;

	const options: ResolvedRuntimeValidationOptions = {
		installDependencies: true,
		runPackageScripts: true,
		runSyntaxChecks: true,
		commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
		installTimeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
		signal: signalOrOptions instanceof AbortSignal ? signalOrOptions : signalOrOptions?.signal,
	};
	if (!(signalOrOptions instanceof AbortSignal) && signalOrOptions) {
		options.installDependencies = signalOrOptions.installDependencies ?? options.installDependencies;
		options.runPackageScripts = signalOrOptions.runPackageScripts ?? options.runPackageScripts;
		options.runSyntaxChecks = signalOrOptions.runSyntaxChecks ?? options.runSyntaxChecks;
		options.commandTimeoutMs = signalOrOptions.commandTimeoutMs ?? options.commandTimeoutMs;
		options.installTimeoutMs = signalOrOptions.installTimeoutMs ?? options.installTimeoutMs;
	}

	const commands = [
		...(options.runSyntaxChecks ? buildSyntaxCommands(outputDir, plan, options.commandTimeoutMs) : []),
		...buildRuntimeCommands(outputDir, plan, options),
	];
	const issues: ValidationIssue[] = [];
	for (const command of commands) {
		if (options.signal?.aborted) break;
		const result = await runCommand(outputDir, command, options.signal);
		if (result.exitCode !== 0 || result.timedOut) {
			issues.push(issueForCommandFailure(command, result));
			break;
		}
	}
	return issues;
}
