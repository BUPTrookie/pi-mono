import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { explainUnsafeBash } from "../agent/bash-safety.js";
import type { TaskCheckResult, TeamPlan, ValidationIssue } from "../types.js";
import { sanitizeTaskId } from "../utils/shared.js";

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

interface HandoffFile {
	taskId?: unknown;
	changedFiles?: unknown;
	contractsSatisfied?: unknown;
	checksRun?: unknown;
	knownRisks?: unknown;
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

/**
 * Glob-style existence check. Supports `*` wildcard in path segments.
 * Returns list of matched relative paths (empty if none).
 */
function globOutput(outputDir: string, pattern: string): string[] {
	if (!pattern.includes("*") && !pattern.includes("?")) return [];
	const segments = pattern.split("/");
	const results: string[] = [];
	const visit = (dir: string, segIndex: number, built: string[]): void => {
		if (segIndex >= segments.length) {
			const fullPath = join(outputDir, ...built);
			if (existsSync(fullPath)) results.push(built.join("/"));
			return;
		}
		const seg = segments[segIndex];
		const isLast = segIndex === segments.length - 1;
		if (!seg.includes("*") && !seg.includes("?")) {
			visit(join(dir, seg), segIndex + 1, [...built, seg]);
			return;
		}
		// Convert glob segment to regex
		const re = new RegExp(
			`^${seg
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, "[^/]*")
				.replace(/\?/g, "[^/]")}$`,
		);
		const currentDir = built.length === 0 ? outputDir : join(outputDir, ...built);
		if (!existsSync(currentDir)) return;
		for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
			if (re.test(entry.name)) {
				const isFile = entry.isFile();
				const isDir = entry.isDirectory();
				if (isLast ? isFile || isDir : isDir) {
					visit(join(currentDir, entry.name), segIndex + 1, [...built, entry.name]);
				}
			}
		}
	};
	visit(outputDir, 0, []);
	return results;
}

/**
 * Fuzzy match: when an exact path doesn't exist, check whether a file with
 * the same basename (different extension) or a similar name exists anywhere
 * under the output directory. Returns the best match path or undefined.
 */
function fuzzyMatchOutput(outputDir: string, relativePath: string): string | undefined {
	const basename = relativePath.split("/").pop() ?? "";
	const nameWithoutExt = basename.replace(/\.[^.]+$/, "");
	if (!nameWithoutExt || nameWithoutExt === basename) return undefined;

	const allFiles = collectFiles(outputDir, 500);
	for (const file of allFiles) {
		const rel = relative(outputDir, file).split(/[\\/]/).join("/");
		const fileBasename = rel.split("/").pop() ?? "";
		const fileWithoutExt = fileBasename.replace(/\.[^.]+$/, "");
		if (fileWithoutExt === nameWithoutExt && fileBasename !== basename) {
			return rel;
		}
	}
	return undefined;
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function readHandoff(outputDir: string, taskId: string): HandoffFile | undefined {
	return readJson(join(outputDir, "docs", "agent-team", "tasks", `${sanitizeTaskId(taskId)}-handoff.json`));
}

function normalizeChecksRun(value: unknown): TaskCheckResult[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
		)
		.map((item) => ({
			command: typeof item.command === "string" ? item.command : "",
			exitCode: typeof item.exitCode === "number" || item.exitCode === null ? item.exitCode : null,
			summary: typeof item.summary === "string" ? item.summary : "",
			required: typeof item.required === "boolean" ? item.required : true,
		}))
		.filter((check) => check.command.trim().length > 0);
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

function isDangerousPackageScript(script: string): boolean {
	return explainUnsafeBash(script) !== undefined;
}

function packageScriptIssue(
	name: string,
	script: string,
	owner: Pick<ValidationIssue, "ownerRole" | "ownerTaskId">,
): ValidationIssue {
	return issue(
		`security-package-script-${name.replace(/[^a-z0-9]+/gi, "-")}`,
		`Package script "${name}" is unsafe and was not executed: ${script}`,
		{
			severity: "error",
			file: "package.json",
			...owner,
		},
	);
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

const NATIVE_ADDON_FAILURE_PATTERNS = [
	/node-gyp/i,
	/Could not find any Visual Studio installation/i,
	/Could not locate the bindings file/i,
	/No prebuilt binaries found/i,
	/gyp ERR!/i,
	/Could not find binding file/i,
	/prebuild-install.*warn.*install/i,
];

function isNativeAddonFailure(output: string): boolean {
	return NATIVE_ADDON_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

function issueForCommandFailure(spec: CommandSpec, result: CommandResult): ValidationIssue {
	const suffix = result.timedOut
		? `timed out after ${Math.round(spec.timeoutMs / 1000)}s`
		: `exited with code ${result.exitCode}`;
	const output = result.output ? `\nOutput:\n${result.output}` : "";

	// Native addon failures are environment issues, not code bugs.
	// Downgrade to warning so repair loops don't waste turns on unfixable problems.
	if (isNativeAddonFailure(result.output)) {
		return issue(
			`native-addon-${spec.id}`,
			`Native addon compilation failed: ${commandLabel(spec)} ${suffix}.${output}\n\nThis project uses packages that require native compilation (e.g. better-sqlite3, bcrypt, sharp). The agent runtime lacks C++ build tools. Use pure-JS alternatives: sql.js instead of better-sqlite3, bcryptjs instead of bcrypt, etc.`,
			{
				severity: "warning",
				ownerRole: spec.ownerRole,
				ownerTaskId: spec.ownerTaskId,
				file: spec.file,
			},
		);
	}

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
): { commands: CommandSpec[]; issues: ValidationIssue[] } {
	const packageJson = readPackageJson(outputDir);
	if (!packageJson) return { commands: [], issues: [] };

	const packageOwner = ownerForPackage(plan);
	const projectOwner = ownerForWholeProjectCheck(plan);
	const commands: CommandSpec[] = [];
	const issues: ValidationIssue[] = [];

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
		const script = packageJson.scripts?.check ?? "";
		if (isDangerousPackageScript(script)) {
			issues.push(packageScriptIssue("check", script, packageOwner));
		} else {
			commands.push({
				id: "npm-run-check",
				...npmCommandSpec(["run", "check"]),
				timeoutMs: options.commandTimeoutMs,
				file: "package.json",
				...packageOwner,
			});
		}
	}

	if (options.runPackageScripts && isUsefulTestScript(packageJson.scripts?.test)) {
		const script = packageJson.scripts?.test ?? "";
		if (isDangerousPackageScript(script)) {
			issues.push(packageScriptIssue("test", script, projectOwner));
		} else {
			commands.push({
				id: "npm-test",
				...npmCommandSpec(["test"]),
				timeoutMs: options.commandTimeoutMs,
				file: "package.json",
				...projectOwner,
			});
		}
	}

	if (options.runPackageScripts && scriptExists(packageJson, "build")) {
		const script = packageJson.scripts?.build ?? "";
		if (isDangerousPackageScript(script)) {
			issues.push(packageScriptIssue("build", script, projectOwner));
		} else {
			commands.push({
				id: "npm-run-build",
				...npmCommandSpec(["run", "build"]),
				timeoutMs: options.commandTimeoutMs,
				file: "package.json",
				...projectOwner,
			});
		}
	}

	return { commands, issues };
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
			// 1. Exact match
			if (existsOutput(outputDir, expected)) continue;
			// 2. Glob match (e.g. vitest.config.*)
			if (globOutput(outputDir, expected).length > 0) continue;
			// 3. Fuzzy match - same basename, different extension/path
			const fuzzy = fuzzyMatchOutput(outputDir, expected);
			if (fuzzy) {
				issues.push(
					issue(
						`fuzzy-output-${task.id}-${expected.replace(/[^a-z0-9]+/gi, "-")}`,
						`Task ${task.id} expected "${expected}" but found similar: "${fuzzy}"`,
						{ severity: "warning", ownerRole: task.role, ownerTaskId: task.id, file: fuzzy },
					),
				);
				continue;
			}
			// 4. No match - report as error
			issues.push(
				issue(
					`missing-output-${task.id}-${expected.replace(/[^a-z0-9]+/gi, "-")}`,
					`Task ${task.id} did not produce expected output: ${expected}`,
					{ severity: "error", ownerRole: task.role, ownerTaskId: task.id, file: expected },
				),
			);
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

	const rolesByName = new Map(plan.roles.map((role) => [role.name, role]));
	for (const task of plan.tasks) {
		if (rolesByName.get(task.role)?.profile !== "e2e-verifier") continue;
		const reportPath = task.expectedOutputs.find((path) => path.endsWith("e2e-report.md")) ?? "docs/e2e-report.md";
		if (!existsOutput(outputDir, reportPath)) continue;
		let reportText = "";
		try {
			reportText = readFileSync(join(outputDir, reportPath), "utf-8").toLowerCase();
		} catch {
			continue;
		}
		const hasCommands = /\bcommands?\b/.test(reportText);
		const hasExitStatus = /\b(exit\s+status|exit\s+code|status)\b/.test(reportText);
		const hasObservedResult = /\bobserved\s+result\b/.test(reportText);
		const hasAcceptanceStatus = /\bacceptance\s+status\b/.test(reportText);
		if (!hasCommands || !hasExitStatus || !hasObservedResult || !hasAcceptanceStatus) {
			issues.push(
				issue(
					`incomplete-e2e-report-${task.id}`,
					`E2E report ${reportPath} must include commands, exit status, observed result, and acceptance status.`,
					{ severity: "error", ownerRole: task.role, ownerTaskId: task.id, file: reportPath },
				),
			);
		}
	}

	return issues;
}

function validateTaskHandoffs(outputDir: string, plan: TeamPlan): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const rolesByName = new Map(plan.roles.map((role) => [role.name, role]));
	for (const task of plan.tasks) {
		const role = rolesByName.get(task.role);
		if (role?.profile === "docs-engineer") continue;

		const handoff = readHandoff(outputDir, task.id);
		if (!handoff) {
			issues.push(
				issue(`missing-handoff-${task.id}`, `Task ${task.id} did not write its handoff JSON.`, {
					severity: "error",
					ownerRole: task.role,
					ownerTaskId: task.id,
				}),
			);
			issues.push(
				issue(`missing-checks-run-${task.id}`, `Task ${task.id} did not report required self-checks.`, {
					severity: "error",
					ownerRole: task.role,
					ownerTaskId: task.id,
				}),
			);
			continue;
		}

		const checks = normalizeChecksRun(handoff.checksRun);
		if (checks.length === 0) {
			issues.push(
				issue(`missing-checks-run-${task.id}`, `Task ${task.id} did not report required self-checks.`, {
					severity: "error",
					ownerRole: task.role,
					ownerTaskId: task.id,
				}),
			);
			continue;
		}
		if (!checks.some((check) => check.exitCode === 0)) {
			issues.push(
				issue(`failed-checks-run-${task.id}`, `Task ${task.id} reported checks but none succeeded.`, {
					severity: "error",
					ownerRole: task.role,
					ownerTaskId: task.id,
				}),
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

	const runtime = buildRuntimeCommands(outputDir, plan, options);
	const commands = [
		...(options.runSyntaxChecks ? buildSyntaxCommands(outputDir, plan, options.commandTimeoutMs) : []),
		...runtime.commands,
	];
	const issues: ValidationIssue[] = [...staticIssues, ...validateTaskHandoffs(outputDir, plan), ...runtime.issues];
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
