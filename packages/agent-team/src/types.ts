import type { AgentEvent, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

// --- Role types ---

export type AgentRoleName = string;

export type InterventionMode = "none" | "approval" | "interactive";

export interface RoleDefinition {
	name: AgentRoleName;
	description: string;
	systemPrompt: string;
	allowedTools: string[];
	ownedDirectories: string[];
	modelOverride?: { provider: string; model: string };
	thinkingLevelOverride?: ThinkingLevel;
	maxTurns: number;
}

// --- Plan and contract types ---

export type ContractKind = "team-plan" | "project-manifest" | "openapi" | "data-model" | "notes";

export interface ContractSpec {
	path: string;
	kind: ContractKind;
	required: boolean;
	ownerTaskId?: string;
}

export interface RoleSpec {
	name: AgentRoleName;
	description: string;
	allowedTools: string[];
	ownedDirectories: string[];
	maxTurns: number;
	systemPrompt?: string;
}

export interface TaskSpec {
	id: string;
	role: AgentRoleName;
	subject: string;
	description: string;
	dependencies: string[];
	ownedDirectories: string[];
	expectedOutputs: string[];
	acceptanceCriteria: string[];
	repairOf?: string[];
}

export interface TeamPlan {
	id: string;
	summary: string;
	roles: RoleSpec[];
	tasks: TaskSpec[];
	contracts: ContractSpec[];
	validationRules: string[];
}

export interface GeneratedContracts {
	projectManifest: Record<string, unknown>;
	openapi?: Record<string, unknown>;
	dataModel?: Record<string, unknown>;
	notes?: Record<string, unknown>;
}

export interface PlannerDiagnostic {
	severity: "error" | "warning" | "info";
	message: string;
}

export interface PlannerResult {
	plan: TeamPlan;
	contracts: GeneratedContracts;
	diagnostics: PlannerDiagnostic[];
}

export interface PlannerOptions {
	requirement: string;
	model: Model<Api>;
	getApiKey: (provider: string) => Promise<string | undefined> | string | undefined;
	thinkingLevel?: ThinkingLevel;
	signal?: AbortSignal;
}

export type PlannerRunner = (options: PlannerOptions) => Promise<PlannerResult>;

// --- Task types ---

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface Task {
	id: string;
	role: AgentRoleName;
	subject: string;
	description: string;
	dependencies: string[];
	status: TaskStatus;
	result?: TaskResult;
	expectedOutputs: string[];
	acceptanceCriteria: string[];
	repairOf?: string[];
}

export interface TaskResult {
	taskId: string;
	success: boolean;
	output: string;
	filesCreated: string[];
	error?: string;
	turnsUsed: number;
}

export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
	id: string;
	severity: ValidationSeverity;
	message: string;
	ownerRole?: AgentRoleName;
	ownerTaskId?: string;
	file?: string;
}

export interface RepairTask extends TaskSpec {
	repairOf: string[];
}

// --- Team configuration ---

export interface TeamConfig {
	requirement: string;
	outputDir: string;
	model: {
		provider?: string;
		model: string;
		apiKey?: string;
		baseUrl?: string;
	};
	maxParallelAgents?: number;
	thinkingLevel?: ThinkingLevel;
	interventionMode?: InterventionMode;
	maxRepairRounds?: number;
}

// --- Team result ---

export interface TeamResult {
	success: boolean;
	outputDir: string;
	tasks: TaskResult[];
	totalTurns: number;
	plan?: TeamPlan;
	validationIssues?: ValidationIssue[];
	error?: string;
}

export type ApprovalDecision = "approve" | "reject";

export type TeamEvent =
	| { type: "run_start"; requirement: string; outputDir: string; timestamp: number }
	| { type: "run_end"; result: TeamResult; timestamp: number }
	| { type: "plan_created"; plan: TeamPlan; timestamp: number }
	| { type: "plan_updated"; plan: TeamPlan; reason: string; timestamp: number }
	| { type: "task_start"; task: Task; timestamp: number }
	| { type: "task_progress"; taskId: string; message: string; timestamp: number }
	| { type: "task_end"; task: Task; result: TaskResult; timestamp: number }
	| { type: "agent_event"; taskId: string; role: AgentRoleName; event: AgentEvent; timestamp: number }
	| {
			type: "approval_requested";
			requestId: string;
			taskId: string;
			reason: string;
			command?: string;
			timestamp: number;
	  }
	| { type: "approval_resolved"; requestId: string; decision: ApprovalDecision; timestamp: number }
	| { type: "validation_start"; round: number; timestamp: number }
	| { type: "validation_end"; round: number; issues: ValidationIssue[]; timestamp: number }
	| { type: "repair_requested"; round: number; issues: ValidationIssue[]; tasks: RepairTask[]; timestamp: number }
	| { type: "run_paused"; timestamp: number }
	| { type: "run_resumed"; timestamp: number }
	| { type: "intervention"; message: string; timestamp: number };

export type TeamEventListener = (event: TeamEvent) => void;

export interface TeamRun {
	start(): Promise<TeamResult>;
	subscribe(listener: TeamEventListener): () => void;
	pause(): void;
	resume(): void;
	abort(): void;
	approve(requestId: string, decision: ApprovalDecision): void;
	intervene(message: string): void;
}
