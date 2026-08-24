import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({
  estimateTokens(message: { content?: unknown }): number {
    return Math.ceil(JSON.stringify(message.content ?? "").length / 4);
  },
  formatSkillsForPrompt(skills: Array<{ disableModelInvocation: boolean; name: string }>): string {
    return skills
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => `<skill>${skill.name}</skill>`)
      .join("\n");
  },
  sessionEntryToContextMessages(entry: { message?: unknown }): unknown[] {
    return entry.message ? [entry.message] : [];
  },
}));

mock.module("@earendil-works/pi-tui", () => ({
  truncateToWidth(text: string, width: number): string {
    return text.slice(0, width);
  },
}));

const { default: contextExtension } = await import("./index");

test("reports visible skill overhead without adding the report to model context", () => {
  let command: { handler(args: string, context: any): void } | undefined;
  let renderer: ((entry: any, options: any, theme: any) => any) | undefined;
  const entries: any[] = [];
  const notifications: string[] = [];

  const skills = [
    {
      name: "visible-skill",
      description: "Loads automatically when relevant.",
      filePath: "/tmp/visible/SKILL.md",
      baseDir: "/tmp/visible",
      disableModelInvocation: false,
      sourceInfo: { source: "local", scope: "user", origin: "top-level", path: "/tmp/visible/SKILL.md" },
    },
    {
      name: "command-only-skill",
      description: "Only runs when explicitly invoked.",
      filePath: "/tmp/command-only/SKILL.md",
      baseDir: "/tmp/command-only",
      disableModelInvocation: true,
      sourceInfo: { source: "local", scope: "user", origin: "top-level", path: "/tmp/command-only/SKILL.md" },
    },
  ];

  const api = {
    getActiveTools: () => ["read"],
    getAllTools: () => [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        sourceInfo: { source: "builtin" },
      },
    ],
    registerCommand(name: string, value: typeof command) {
      if (name === "context") command = value;
    },
    registerEntryRenderer(_name: string, value: typeof renderer) {
      renderer = value;
    },
    appendEntry(_name: string, report: any) {
      entries.push(report);
    },
  };

  const context = {
    model: { provider: "test", id: "model", contextWindow: 10_000 },
    getContextUsage: () => ({ tokens: 2_000, contextWindow: 10_000, percent: 20 }),
    getSystemPrompt: () => "base prompt".repeat(100),
    getSystemPromptOptions: () => ({
      cwd: "/tmp/project",
      skills,
      contextFiles: [{ path: "/tmp/project/AGENTS.md", content: "Keep changes small." }],
    }),
    sessionManager: {
      buildContextEntries: () => [
        { type: "message", message: { role: "user", content: "hello", timestamp: Date.now() } },
      ],
    },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  };

  contextExtension(api as any);
  command?.handler("all", context);

  expect(entries).toHaveLength(1);
  expect(entries[0].counts).toMatchObject({
    skills: 2,
    visibleSkills: 1,
    commandOnlySkills: 1,
  });
  expect(entries[0].categories.reduce((total, category) => total + category.tokens, 0)).toBe(2_000);
  expect(entries[0].categories.find((category) => category.label === "Skills")?.tokens).toBeGreaterThan(0);

  const component = renderer?.(
    { data: entries[0] },
    {},
    { bold: (text: string) => text, fg: (_color: string, text: string) => text },
  );
  const lines = component.render(60) as string[];
  expect(lines.some((line) => line.includes("Skills"))).toBe(true);
  expect(lines.every((line) => line.length <= 60)).toBe(true);

  command?.handler("wat", context);
  expect(entries).toHaveLength(1);
  expect(notifications).toEqual(["Usage: /context [all]"]);
});
