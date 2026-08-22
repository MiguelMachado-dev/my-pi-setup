/**
 * Pure markdown extraction helpers for copyout-quotes.
 *
 * Kept free of pi imports so this module can be unit-tested with plain Node.
 */

// ── Inline markdown ──────────────────────────────────────────────────────────

/** Strip inline markdown markers (bold/italic/code/links) for previews. */
export function stripMarkdownInline(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

// ── Blockquotes ──────────────────────────────────────────────────────────────

export interface Blockquote {
	/** The original lines, including the `>` prefixes. */
	raw: string;
	/**
	 * The quote body with one level of `>` prefix and its single following
	 * space removed. Inline markdown (bold, italic, code, links) and nested
	 * quote levels (`>`) are preserved. Blank `>` lines become empty lines,
	 * keeping paragraph breaks inside the quote.
	 */
	content: string;
}

const QUOTE_PREFIX = /^ {0,3}>[ ]?(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Extract markdown blockquotes from assistant text.
 *
 * A quote is a run of consecutive lines starting with `>` (up to 3 leading
 * spaces allowed). The run ends at the first non-quote line. Lines inside
 * fenced code blocks are never treated as quotes.
 */
export function extractBlockquotes(text: string): Blockquote[] {
	const quotes: Blockquote[] = [];
	const lines = text.split("\n");
	let inCode = false;
	let current: string[] = [];
	let currentRaw: string[] = [];

	const flush = () => {
		// Drop leading/trailing blank lines (from bare `>` lines at the edges).
		while (current.length > 0 && current[current.length - 1].trim() === "") current.pop();
		while (current.length > 0 && current[0].trim() === "") current.shift();
		if (current.length > 0) {
			quotes.push({ raw: currentRaw.join("\n"), content: current.join("\n") });
		}
		current = [];
		currentRaw = [];
	};

	for (const line of lines) {
		const m = inCode ? null : line.match(QUOTE_PREFIX);
		if (m) {
			current.push(m[1]);
			currentRaw.push(line);
			continue;
		}
		flush();
		if (FENCE.test(line)) inCode = !inCode;
	}
	flush();

	return quotes;
}

// ── Code blocks ──────────────────────────────────────────────────────────────

export interface CodeBlock {
	lang: string;
	code: string;
}

export function extractCodeBlocks(text: string): CodeBlock[] {
	const blocks: CodeBlock[] = [];
	const regex = /```(\w*)\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		blocks.push({ lang: match[1] || "text", code: match[2].trimEnd() });
	}
	return blocks;
}

// ── Tables ───────────────────────────────────────────────────────────────────

export interface ParsedTable {
	headers: string[];
	rows: string[][];
	raw: string;
}

function parseTableRow(line: string): string[] {
	return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
	return parseTableRow(line).every((c) => /^:?-+:?$/.test(c));
}

export function extractParsedTables(text: string): ParsedTable[] {
	const tables: ParsedTable[] = [];
	const lines = text.split("\n");
	let tableLines: string[] = [];
	let inTable = false;

	const flush = () => {
		if (tableLines.length < 2) {
			tableLines = [];
			inTable = false;
			return;
		}
		const headers = parseTableRow(tableLines[0]);
		let dataStart = 1;
		if (tableLines.length > 1 && isSeparatorRow(tableLines[1])) dataStart = 2;
		const rows: string[][] = [];
		for (let i = dataStart; i < tableLines.length; i++) {
			if (!isSeparatorRow(tableLines[i])) rows.push(parseTableRow(tableLines[i]));
		}
		if (headers.length > 0) tables.push({ headers, rows, raw: tableLines.join("\n") });
		tableLines = [];
		inTable = false;
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
			inTable = true;
			tableLines.push(trimmed);
		} else if (inTable) {
			flush();
		}
	}
	if (inTable) flush();
	return tables;
}

// ── Sections ─────────────────────────────────────────────────────────────────

/** Split text on markdown horizontal rules into sections. */
export function splitSections(text: string): string[] {
	const parts = text.split(/\n(?:---+|\*\*\*+|___+)\s*\n/);
	return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ── Assistant message text ───────────────────────────────────────────────────

type ContentBlock = { type?: string; text?: string };
export type SessionEntryLike = { type: string; message?: { role?: string; content?: unknown } };

export function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

export function getLastAssistantText(entries: SessionEntryLike[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const text = extractAssistantText(entry.message.content);
			if (text.trim()) return text;
		}
	}
	return null;
}

export function getAllConversationText(entries: SessionEntryLike[]): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractAssistantText(entry.message.content);
		if (!text.trim()) continue;
		sections.push(`## ${role === "user" ? "User" : "Assistant"}\n\n${text}`);
	}
	return sections.join("\n\n---\n\n");
}
