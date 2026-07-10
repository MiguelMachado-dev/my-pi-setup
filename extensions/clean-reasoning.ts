import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function cleanReasoning(reasoning: string): string {
  return reasoning
    .replace(/^[\t ]*<!--[\t ]*-->[\t ]*(?:\r?\n|$)/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default function cleanReasoningExtension(pi: ExtensionAPI): void {
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") {
      return;
    }

    return {
      message: {
        ...event.message,
        content: event.message.content.map((content) => {
          if (content.type !== "thinking") {
            return content;
          }

          return {
            ...content,
            thinking: cleanReasoning(content.thinking),
          };
        }),
      },
    };
  });
}
