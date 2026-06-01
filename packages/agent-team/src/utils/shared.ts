export function sanitizeTaskId(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	return match ? match[1].trim() : trimmed;
}

export function extractJsonText(text: string): string {
	const stripped = stripCodeFence(text);
	const first = stripped.indexOf("{");
	const last = stripped.lastIndexOf("}");
	if (first === -1 || last === -1 || last <= first) return stripped;
	return stripped.slice(first, last + 1);
}

export function extractTextContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
}
