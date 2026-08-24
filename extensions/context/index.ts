import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionCommandContext,
  Skill,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  estimateTokens,
  formatSkillsForPrompt,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "context-usage";

const CATEGORY_COLORS = {
  "System prompt": "accent",
  "Tool schemas": "warning",
  "Context files": "success",
  Skills: "error",
  Messages: "muted",
} as const;

type CategoryLabel = keyof typeof CATEGORY_COLORS;

type Category = {
  label: CategoryLabel;
  tokens: number;
};

type Detail = {
  label: string;
  tokens: number;
  note: string;
};

export type ContextReport = {
  model: string;
  contextWindow: number;
  totalTokens: number;
  categories: Category[];
  expanded: boolean;
  providerMeasured: boolean;
  counts: {
    activeTools: number;
    contextFiles: number;
    messages: number;
    skills: number;
    visibleSkills: number;
    commandOnlySkills: number;
  };
  details: {
    tools: Detail[];
    contextFiles: Detail[];
    skills: Detail[];
    messages: Detail[];
  };
};

type ContextApi = Pick<ExtensionAPI, "getActiveTools" | "getAllTools">;

type ThemeLike = {
  bold(text: string): string;
  fg(color: string, text: string): string;
};

function estimateText(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatContextFiles(files: NonNullable<BuildSystemPromptOptions["contextFiles"]>): string {
  if (files.length === 0) return "";

  const sections = files.map(
    (file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n`,
  );

  return [
    "\n\n<project_context>\n",
    "Project-specific instructions and guidelines:\n",
    ...sections,
    "</project_context>\n",
  ].join("\n");
}

function shortPath(path: string): string {
  const home = process.env.HOME;
  if (!home || path === home) return path === home ? "~" : path;
  if (!path.startsWith(`${home}/`)) return path;
  return `~/${path.slice(home.length + 1)}`;
}

function estimateTool(tool: ToolInfo): number {
  return estimateText(
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }),
  );
}

function buildToolDetails(api: ContextApi): Detail[] {
  const activeNames = new Set(api.getActiveTools());
  return api
    .getAllTools()
    .filter((tool) => activeNames.has(tool.name))
    .map((tool) => ({
      label: tool.name,
      tokens: estimateTool(tool),
      note: tool.sourceInfo.source,
    }))
    .sort((left, right) => right.tokens - left.tokens || left.label.localeCompare(right.label));
}

function buildContextFileDetails(
  files: NonNullable<BuildSystemPromptOptions["contextFiles"]>,
): Detail[] {
  return files
    .map((file) => ({
      label: shortPath(file.path),
      tokens: estimateText(`${file.path}\n${file.content}`),
      note: "",
    }))
    .sort((left, right) => right.tokens - left.tokens || left.label.localeCompare(right.label));
}

function buildSkillDetails(skills: Skill[]): Detail[] {
  return skills
    .filter((skill) => !skill.disableModelInvocation)
    .map((skill) => ({
      label: skill.name,
      tokens: estimateText(`${skill.name}\n${skill.description}\n${skill.filePath}`),
      note: shortPath(skill.filePath),
    }))
    .sort((left, right) => right.tokens - left.tokens || left.label.localeCompare(right.label));
}

type ContextMessage = ReturnType<typeof sessionEntryToContextMessages>[number];

function buildMessageDetails(messages: ContextMessage[]): Detail[] {
  const byRole = new Map<string, { count: number; tokens: number }>();

  for (const message of messages) {
    const current = byRole.get(message.role);
    if (current) {
      current.count += 1;
      current.tokens += estimateTokens(message);
      continue;
    }

    byRole.set(message.role, { count: 1, tokens: estimateTokens(message) });
  }

  return Array.from(byRole.entries())
    .map(([role, detail]) => ({
      label: role,
      tokens: detail.tokens,
      note: `${detail.count} message${detail.count === 1 ? "" : "s"}`,
    }))
    .sort((left, right) => right.tokens - left.tokens || left.label.localeCompare(right.label));
}

export function buildContextReport(
  api: ContextApi,
  context: ExtensionCommandContext,
  expanded: boolean,
): ContextReport {
  const options = context.getSystemPromptOptions();
  const skills = options.skills ?? [];
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  const contextFiles = options.contextFiles ?? [];
  const messages = context.sessionManager
    .buildContextEntries()
    .flatMap((entry) => sessionEntryToContextMessages(entry));
  const toolDetails = buildToolDetails(api);
  const contextFileDetails = buildContextFileDetails(contextFiles);
  const skillDetails = buildSkillDetails(skills);
  const messageDetails = buildMessageDetails(messages);

  const skillsTokens = estimateText(formatSkillsForPrompt(skills));
  const contextFilesTokens = estimateText(formatContextFiles(contextFiles));
  const fullSystemPromptTokens = estimateText(context.getSystemPrompt());
  const systemPromptTokens = Math.max(0, fullSystemPromptTokens - skillsTokens - contextFilesTokens);
  const toolTokens = toolDetails.reduce((total, detail) => total + detail.tokens, 0);
  const directMessageTokens = messageDetails.reduce((total, detail) => total + detail.tokens, 0);
  const fixedTokens = systemPromptTokens + toolTokens + contextFilesTokens + skillsTokens;
  const usage = context.getContextUsage();
  const measuredTokens = usage?.tokens;
  const providerMeasured = measuredTokens !== null && measuredTokens !== undefined && measuredTokens >= fixedTokens;
  const messageTokens = providerMeasured ? measuredTokens - fixedTokens : directMessageTokens;
  const totalTokens = fixedTokens + messageTokens;
  const contextWindow = usage?.contextWindow ?? context.model?.contextWindow ?? 0;
  const model = context.model ? `${context.model.provider}/${context.model.id}` : "No model";

  return {
    model,
    contextWindow,
    totalTokens,
    categories: [
      { label: "System prompt", tokens: systemPromptTokens },
      { label: "Tool schemas", tokens: toolTokens },
      { label: "Context files", tokens: contextFilesTokens },
      { label: "Skills", tokens: skillsTokens },
      { label: "Messages", tokens: messageTokens },
    ],
    expanded,
    providerMeasured,
    counts: {
      activeTools: toolDetails.length,
      contextFiles: contextFiles.length,
      messages: messages.length,
      skills: skills.length,
      visibleSkills: visibleSkills.length,
      commandOnlySkills: skills.length - visibleSkills.length,
    },
    details: {
      tools: toolDetails,
      contextFiles: contextFileDetails,
      skills: skillDetails,
      messages: messageDetails,
    },
  };
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return tokens.toString();
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  if (tokens < 10_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1_000_000)}M`;
}

function formatPercent(tokens: number, contextWindow: number): string {
  if (contextWindow <= 0) return "?";
  return `${((tokens / contextWindow) * 100).toFixed(1)}%`;
}

function renderBar(report: ContextReport, width: number, theme: ThemeLike): string {
  const barWidth = Math.max(8, Math.min(64, width));
  if (report.contextWindow <= 0) return theme.fg("dim", "░".repeat(barWidth));

  const usedRatio = Math.min(1, report.totalTokens / report.contextWindow);
  const usedCells = Math.min(barWidth, Math.round(usedRatio * barWidth));
  if (usedCells === 0) return theme.fg("dim", "░".repeat(barWidth));

  const segments: string[] = [];
  let cumulativeTokens = 0;
  let assignedCells = 0;

  for (const category of report.categories) {
    cumulativeTokens += category.tokens;
    const nextCell = Math.min(
      usedCells,
      Math.round((cumulativeTokens / Math.max(1, report.totalTokens)) * usedCells),
    );
    const cells = Math.max(0, nextCell - assignedCells);
    if (cells > 0) {
      segments.push(theme.fg(CATEGORY_COLORS[category.label], "█".repeat(cells)));
    }
    assignedCells = nextCell;
  }

  const freeCells = Math.max(0, barWidth - usedCells);
  if (freeCells > 0) segments.push(theme.fg("dim", "░".repeat(freeCells)));
  return segments.join("");
}

function categoryNote(report: ContextReport, category: Category): string {
  if (category.label === "Tool schemas") return `${report.counts.activeTools} active`;
  if (category.label === "Context files") return `${report.counts.contextFiles} files`;
  if (category.label === "Skills") {
    return `${report.counts.visibleSkills} visible, ${report.counts.commandOnlySkills} command-only`;
  }
  if (category.label === "Messages") return `${report.counts.messages} messages`;
  return "";
}

function detailLines(title: string, details: Detail[], theme: ThemeLike): string[] {
  const lines = ["", theme.bold(title)];
  if (details.length === 0) return [...lines, theme.fg("dim", "  none")];

  for (const detail of details) {
    const note = detail.note ? ` · ${detail.note}` : "";
    lines.push(`  ${formatTokens(detail.tokens).padStart(6)}  ${detail.label}${theme.fg("dim", note)}`);
  }

  return lines;
}

function renderReport(report: ContextReport, width: number, theme: ThemeLike): string[] {
  const contextLabel = report.contextWindow > 0 ? formatTokens(report.contextWindow) : "unknown";
  const freeTokens = Math.max(0, report.contextWindow - report.totalTokens);
  const lines = [
    theme.bold("Context Usage"),
    theme.fg("dim", report.model),
    `${formatTokens(report.totalTokens)}/${contextLabel} tokens (${formatPercent(report.totalTokens, report.contextWindow)})`,
    "",
    renderBar(report, Math.max(8, width - 2), theme),
    "",
    theme.bold("Estimated usage by category"),
  ];

  for (const category of report.categories) {
    const color = CATEGORY_COLORS[category.label];
    const note = categoryNote(report, category);
    const suffix = note ? ` · ${note}` : "";
    lines.push(
      `${theme.fg(color, "●")} ${category.label.padEnd(14)} ${formatTokens(category.tokens).padStart(7)} (${formatPercent(category.tokens, report.contextWindow)})${theme.fg("dim", suffix)}`,
    );
  }

  lines.push(
    `${theme.fg("dim", "○")} ${"Free space".padEnd(14)} ${formatTokens(freeTokens).padStart(7)} (${formatPercent(freeTokens, report.contextWindow)})`,
  );

  if (!report.expanded) {
    lines.push("", theme.fg("dim", "/context all to expand"));
    return lines.map((line) => truncateToWidth(line, Math.max(1, width), ""));
  }

  lines.push(...detailLines(`Tool schemas · ${report.counts.activeTools} active`, report.details.tools, theme));
  lines.push(...detailLines(`Context files · ${report.counts.contextFiles}`, report.details.contextFiles, theme));
  lines.push(
    ...detailLines(
      `Skills · ${report.counts.visibleSkills} visible, ${report.counts.commandOnlySkills} command-only`,
      report.details.skills,
      theme,
    ),
  );
  lines.push(...detailLines(`Messages · ${report.counts.messages}`, report.details.messages, theme));
  lines.push(
    "",
    theme.fg(
      "dim",
      report.providerMeasured
        ? "~4 chars/token; provider-only overhead is folded into Messages."
        : "~4 chars/token; no provider usage was available yet.",
    ),
  );

  return lines.map((line) => truncateToWidth(line, Math.max(1, width), ""));
}

function createReportComponent(report: ContextReport, theme: ThemeLike): Component {
  return {
    render(width: number): string[] {
      return renderReport(report, width, theme);
    },
    invalidate(): void {},
  };
}

export default function contextExtension(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<ContextReport>(ENTRY_TYPE, (entry, _options, theme) => {
    if (entry.data) return createReportComponent(entry.data, theme);
    return {
      render(width: number): string[] {
        return [truncateToWidth(theme.fg("error", "Context report unavailable"), width, "")];
      },
      invalidate(): void {},
    };
  });

  pi.registerCommand("context", {
    description: "Show estimated context usage by category",
    async handler(args, context): Promise<void> {
      const argument = args.trim();
      if (argument && argument !== "all") {
        context.ui.notify("Usage: /context [all]", "warning");
        return;
      }

      pi.appendEntry<ContextReport>(ENTRY_TYPE, buildContextReport(pi, context, argument === "all"));
    },
  });
}
