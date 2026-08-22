/**
 * copyout-quotes — Copy assistant output to clipboard, with blockquote support
 *
 * A clone of pi-copy-output (https://github.com/jal-co/pi-copy-output) that
 * additionally detects markdown blockquotes in the last assistant response
 * and lets you copy exactly the quoted text: the `>` prefixes and extra
 * spacing are stripped, while inline markdown styling (**bold**, *italic*,
 * `code`, links) and nested quote levels are preserved.
 *
 * /copyout opens a picker with the last response's copyable content:
 * full response, sections, quotes, code blocks, and a table grid where
 * you arrow through cells and copy cell/row/column/all.
 *
 * Commands:
 *   /copyout            - Smart picker
 *   /copyout all        - Copy full conversation (no picker)
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	Key,
	SelectList,
	truncateToWidth,
	visibleWidth,
	type SelectItem,
} from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import {
	extractBlockquotes,
	extractCodeBlocks,
	extractParsedTables,
	getAllConversationText,
	getLastAssistantText,
	splitSections,
	stripMarkdownInline,
	type ParsedTable,
} from "./extract.ts";

const COMMAND = "copyout";

// ── Clipboard ────────────────────────────────────────────────────────────────

/**
 * Write text to the system clipboard.
 *
 * On Windows we go through PowerShell's Set-Clipboard, decoding stdin
 * explicitly as UTF-8 — plain `clip` mangles non-ASCII characters (curly
 * quotes, em dashes) that are common in blockquotes.
 */
async function copyToClipboard(text: string): Promise<void> {
	const platform = process.platform;

	let cmd: string;
	let args: string[];
	if (platform === "darwin") {
		cmd = "pbcopy";
		args = [];
	} else if (platform === "win32") {
		cmd = "powershell";
		args = [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$s=[Console]::OpenStandardInput(); $ms=New-Object System.IO.MemoryStream; $s.CopyTo($ms); " +
				"Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString($ms.ToArray()))",
		];
	} else {
		cmd = "xclip";
		args = ["-selection", "clipboard"];
	}

	await new Promise<void>((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
		child.once("error", reject);
		child.once("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)),
		);
		child.stdin.on("error", () => {}); // ignore EPIPE if the child exits early; close/error handles it
		child.stdin.write(text);
		child.stdin.end();
	});
}

async function doCopy(text: string, label: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		await copyToClipboard(text);
		const lines = text.split("\n").length;
		ctx.ui.notify(`Copied ${label} (${lines} line${lines === 1 ? "" : "s"}, ${text.length} chars)`, "info");
	} catch {
		ctx.ui.notify("Failed to copy — clipboard helper unavailable?", "error");
	}
}

// ── Shared UI Helpers ────────────────────────────────────────────────────────

function borderTop(title: string, innerW: number, theme: Theme): string {
	const tw = visibleWidth(title);
	const lp = Math.floor((innerW - tw) / 2);
	const rp = Math.max(0, innerW - tw - lp);
	return (
		theme.fg("border", "╭" + "─".repeat(lp)) +
		theme.fg("accent", theme.bold(title)) +
		theme.fg("border", "─".repeat(rp) + "╮")
	);
}

function borderMid(innerW: number, theme: Theme): string {
	return theme.fg("border", "├" + "─".repeat(innerW) + "┤");
}

function borderBot(innerW: number, theme: Theme): string {
	return theme.fg("border", "╰" + "─".repeat(innerW) + "╯");
}

function padLine(content: string, width: number, theme: Theme): string {
	return theme.fg("border", "│") + truncateToWidth(content, width - 2, "…", true) + theme.fg("border", "│");
}

// ── Table Grid Dialog ────────────────────────────────────────────────────────

async function openTableGrid(
	table: ParsedTable,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const result = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => {
			let cursorRow = 0;
			let cursorCol = 0;

			const clean = (r: number, c: number): string => {
				if (r === -1) return stripMarkdownInline(table.headers[c] ?? "");
				return stripMarkdownInline(table.rows[r]?.[c] ?? "");
			};

			const getCellText = () => clean(cursorRow, cursorCol);

			const getRowText = () => {
				const src = cursorRow === -1 ? table.headers : (table.rows[cursorRow] ?? []);
				return src.map((_, ci) => clean(cursorRow, ci)).join("\t");
			};

			const getColumnText = () => {
				const vals = [stripMarkdownInline(table.headers[cursorCol] ?? "")];
				for (let ri = 0; ri < table.rows.length; ri++) {
					vals.push(clean(ri, cursorCol));
				}
				return vals.join("\n");
			};

			const getAllText = () => table.raw;

			const colWidths = table.headers.map((h, ci) => {
				let max = stripMarkdownInline(h).length;
				for (const row of table.rows) {
					const w = stripMarkdownInline(row[ci] ?? "").length;
					if (w > max) max = w;
				}
				return Math.min(Math.max(max, 4), 40);
			});

			const pad = (content: string, width: number) => padLine(content, width, theme);
			const maxVisibleRows = 14;

			return {
				render(width: number): string[] {
					const innerW = Math.max(1, width - 2);
					const lines: string[] = [];

					// Title
					lines.push(borderTop(
						` Table (${table.rows.length} rows x ${table.headers.length} cols) `,
						innerW, theme,
					));

					// Breathing room
					lines.push(pad("", width));

					// Header row
					const headerCells = table.headers.map((h, ci) => {
						const txt = stripMarkdownInline(h);
						const padded = txt.slice(0, colWidths[ci]).padEnd(colWidths[ci]);
						const highlighted = cursorRow === -1 && cursorCol === ci;
						if (highlighted) return theme.bg("selectedBg", theme.fg("accent", padded));
						return theme.fg("text", theme.bold(padded));
					});
					lines.push(pad(`  ${headerCells.join(theme.fg("border", " │ "))}`, width));

					// Header separator
					const sep = colWidths.map((w) => "─".repeat(w)).join("─┼─");
					lines.push(pad(`  ${theme.fg("border", sep)}`, width));

					// Data rows (scrolled)
					const startRow = Math.max(0, cursorRow - Math.floor(maxVisibleRows / 2));
					const endRow = Math.min(table.rows.length, startRow + maxVisibleRows);

					for (let ri = startRow; ri < endRow; ri++) {
						const row = table.rows[ri] ?? [];
						const cells = table.headers.map((_, ci) => {
							const txt = stripMarkdownInline(row[ci] ?? "");
							const padded = txt.slice(0, colWidths[ci]).padEnd(colWidths[ci]);
							const highlighted = cursorRow === ri && cursorCol === ci;
							if (highlighted) return theme.bg("selectedBg", theme.fg("accent", padded));
							return theme.fg("text", padded);
						});
						lines.push(pad(`  ${cells.join(theme.fg("border", " │ "))}`, width));
					}

					if (table.rows.length > maxVisibleRows) {
						lines.push(pad(
							`  ${theme.fg("dim", `${startRow + 1}–${endRow} of ${table.rows.length}`)}`,
							width,
						));
					}

					// Footer
					lines.push(borderMid(innerW, theme));

					const cell = getCellText();
					const preview = cell.length > 50 ? cell.slice(0, 50) + "…" : cell;
					lines.push(pad(` ${theme.fg("muted", "Cell:")} ${theme.fg("text", preview)}`, width));

					const actions = [
						`${theme.fg("accent", "enter")} copy cell`,
						`${theme.fg("accent", "r")} copy row`,
						`${theme.fg("accent", "c")} copy column`,
						`${theme.fg("accent", "a")} copy all`,
						`${theme.fg("accent", "esc")} back`,
					].join(theme.fg("dim", "  ·  "));
					lines.push(pad(` ${actions}`, width));

					lines.push(borderBot(innerW, theme));

					return lines;
				},

				invalidate() {},

				handleInput(data: string) {
					if (matchesKey(data, Key.escape)) { done(null); return; }

					if (matchesKey(data, Key.up)) {
						if (cursorRow > -1) { cursorRow--; tui.requestRender(); }
						return;
					}
					if (matchesKey(data, Key.down)) {
						if (cursorRow < table.rows.length - 1) { cursorRow++; tui.requestRender(); }
						return;
					}
					if (matchesKey(data, Key.left)) {
						if (cursorCol > 0) { cursorCol--; tui.requestRender(); }
						return;
					}
					if (matchesKey(data, Key.right)) {
						if (cursorCol < table.headers.length - 1) { cursorCol++; tui.requestRender(); }
						return;
					}

					if (matchesKey(data, Key.enter)) { done(getCellText()); return; }
					if (matchesKey(data, "r")) { done(getRowText()); return; }
					if (matchesKey(data, "c")) { done(getColumnText()); return; }
					if (matchesKey(data, "a")) { done(getAllText()); return; }
				},
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "85%", minWidth: 60, maxHeight: "85%" } },
	);

	if (result !== null) {
		await doCopy(result, "table selection", ctx);
	}
}

// ── Top-Level Picker ─────────────────────────────────────────────────────────

interface PickerItem {
	label: string;
	description: string;
	action: "copy" | "table";
	content: string;
	tableIndex?: number;
}

function buildPickerItems(text: string, tables: ParsedTable[]): PickerItem[] {
	const items: PickerItem[] = [];

	items.push({
		label: "Full response",
		description: `${text.split("\n").length} lines, ${text.length} chars`,
		action: "copy",
		content: text,
	});

	const sections = splitSections(text);
	if (sections.length > 1) {
		for (let i = 0; i < sections.length; i++) {
			const sec = sections[i];
			const preview = sec.split("\n")[0]?.slice(0, 70) ?? "";
			items.push({
				label: `Section ${i + 1}`,
				description: preview,
				action: "copy",
				content: sec,
			});
		}
	}

	const quotes = extractBlockquotes(text);
	for (let i = 0; i < quotes.length; i++) {
		const q = quotes[i];
		const firstLine = q.content.split("\n").find((l) => l.trim().length > 0) ?? "";
		const preview = stripMarkdownInline(firstLine).slice(0, 70);
		items.push({
			label: `Quote${quotes.length > 1 ? ` ${i + 1}` : ""}`,
			description: preview,
			action: "copy",
			content: q.content,
		});
	}

	const codeBlocks = extractCodeBlocks(text);
	for (let i = 0; i < codeBlocks.length; i++) {
		const { lang, code } = codeBlocks[i];
		const preview = code.split("\n")[0]?.slice(0, 70) ?? "";
		items.push({
			label: `Code block${codeBlocks.length > 1 ? ` ${i + 1}` : ""} [${lang}]`,
			description: preview,
			action: "copy",
			content: code,
		});
	}

	for (let ti = 0; ti < tables.length; ti++) {
		const t = tables[ti];
		const prefix = tables.length > 1 ? `Table ${ti + 1}` : "Table";
		items.push({
			label: `${prefix} (${t.rows.length} rows x ${t.headers.length} cols)`,
			description: t.headers.map((h) => stripMarkdownInline(h)).join(", ").slice(0, 70),
			action: "table",
			content: t.raw,
			tableIndex: ti,
		});
	}

	return items;
}

async function showPicker(
	items: PickerItem[],
	ctx: ExtensionCommandContext,
): Promise<PickerItem | null> {
	const selectItems: SelectItem[] = items.map((item, i) => ({
		value: String(i),
		label: item.label,
		description: item.description,
	}));

	return ctx.ui.custom<PickerItem | null>(
		(tui, theme, _kb, done) => {
			const selectList = new SelectList(selectItems, Math.min(selectItems.length, 14), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(items[parseInt(item.value, 10)] ?? null);
			selectList.onCancel = () => done(null);

			const pad = (content: string, width: number) => padLine(content, width, theme);

			return {
				render(width: number): string[] {
					const innerW = Math.max(1, width - 2);
					const lines: string[] = [];

					lines.push(borderTop(" Copy ", innerW, theme));

					for (const ll of selectList.render(innerW)) lines.push(pad(ll, width));

					lines.push(borderMid(innerW, theme));
					lines.push(pad(
						` ${theme.fg("dim", "up/down navigate · enter select · esc cancel")}`,
						width,
					));
					lines.push(borderBot(innerW, theme));

					return lines;
				},
				invalidate() { selectList.invalidate(); },
				handleInput(data: string) { selectList.handleInput(data); tui.requestRender(); },
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "65%", minWidth: 50, maxHeight: "80%" } },
	);
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function openPicker(ctx: ExtensionCommandContext): Promise<void> {
	const text = getLastAssistantText(ctx.sessionManager.getBranch());
	if (!text) { ctx.ui.notify("No assistant response to copy", "warning"); return; }

	const tables = extractParsedTables(text);
	const items = buildPickerItems(text, tables);

	if (items.length === 1) {
		await doCopy(text, "response", ctx);
		return;
	}

	const selected = await showPicker(items, ctx);
	if (!selected) return;

	if (selected.action === "table" && selected.tableIndex !== undefined) {
		await openTableGrid(tables[selected.tableIndex], ctx);
		return;
	}

	await doCopy(selected.content, selected.label.toLowerCase(), ctx);
}

async function copyAll(ctx: ExtensionCommandContext): Promise<void> {
	const text = getAllConversationText(ctx.sessionManager.getBranch());
	if (!text.trim()) { ctx.ui.notify("No conversation to copy", "warning"); return; }
	await doCopy(text, "full conversation", ctx);
}

// ── Main Extension ───────────────────────────────────────────────────────────

export default function copyoutQuotesExtension(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND, {
		description: "Copy assistant output to clipboard (full response, sections, quotes, code blocks, tables)",
		getArgumentCompletions: (prefix) => {
			const subs = [{ value: "all", label: "all", description: "Copy full conversation" }];
			const filtered = subs.filter((s) => s.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) { ctx.ui.notify("copyout-quotes requires interactive mode", "error"); return; }
			switch (args.trim()) {
				case "all": await copyAll(ctx); break;
				case "": await openPicker(ctx); break;
				default: ctx.ui.notify(`Unknown: "${args.trim()}". Try /${COMMAND} or /${COMMAND} all`, "warning");
			}
		},
	});
}
