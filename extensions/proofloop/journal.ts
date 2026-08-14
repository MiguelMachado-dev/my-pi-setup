import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { BackgroundAgentRecord, BackgroundProcessRecord, JournalCursor } from "./types";

const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_HISTORY_BYTES = 256 * 1024 * 1024;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export interface JournalBatch {
  cursor: JournalCursor;
  records: unknown[];
}

export class PiJournalObserver {
  async captureWatermark(
    path: string,
  ): Promise<{
    cursor: JournalCursor;
    backgroundAgents: Record<string, BackgroundAgentRecord>;
    backgroundProcesses: Record<string, BackgroundProcessRecord>;
    isFile: boolean;
  }> {
    const metadata = await statIfPresent(path);
    if (!metadata) {
      const parent = await stat(dirname(path));
      return {
        cursor: { path, device: 0, inode: 0, offset: 0 },
        backgroundAgents: {},
        backgroundProcesses: {},
        isFile: parent.isDirectory(),
      };
    }
    if (metadata.size > MAX_HISTORY_BYTES) {
      throw new JournalObserverError("SESSION_HISTORY_TOO_LARGE", "Pi session history exceeds 256 MiB");
    }
    const buffer = await readRange(path, 0, metadata.size);
    const lastNewline = buffer.lastIndexOf(10);
    const offset = lastNewline < 0 ? 0 : lastNewline + 1;
    const records = parseRecords(buffer.subarray(0, offset).toString("utf8"));
    const owners = reconstructAsyncOwners(records);
    return {
      cursor: {
        path,
        device: metadata.dev,
        inode: metadata.ino,
        offset,
      },
      backgroundAgents: owners.backgroundAgents,
      backgroundProcesses: owners.backgroundProcesses,
      isFile: metadata.isFile(),
    };
  }

  async drain(cursor: JournalCursor): Promise<JournalBatch> {
    const metadata = await statIfPresent(cursor.path);
    if (!metadata && cursor.device === 0 && cursor.inode === 0) return { cursor, records: [] };
    if (!metadata) throw new JournalObserverError("SESSION_REPLACED", "Pi session file disappeared");
    if (!metadata.isFile()) throw new JournalObserverError("SESSION_REPLACED", "Pi session path is not a file");
    const awaitingFirstWrite = cursor.device === 0 && cursor.inode === 0;
    if (!awaitingFirstWrite && (metadata.dev !== cursor.device || metadata.ino !== cursor.inode)) {
      throw new JournalObserverError("SESSION_REPLACED", "Pi session file identity changed");
    }
    const observedCursor = awaitingFirstWrite
      ? { ...cursor, device: metadata.dev, inode: metadata.ino }
      : cursor;
    if (metadata.size < observedCursor.offset) {
      throw new JournalObserverError("SESSION_TRUNCATED", "Pi session file was truncated");
    }
    if (metadata.size === observedCursor.offset) return { cursor: observedCursor, records: [] };

    const length = metadata.size - observedCursor.offset;
    if (length > MAX_BATCH_BYTES) {
      throw new JournalObserverError("SESSION_BATCH_TOO_LARGE", "Pi session append exceeds 64 MiB");
    }
    const buffer = await readRange(observedCursor.path, observedCursor.offset, length);
    const text = buffer.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) return { cursor: observedCursor, records: [] };

    return {
      cursor: {
        ...observedCursor,
        offset: observedCursor.offset + Buffer.byteLength(text.slice(0, lastNewline + 1)),
      },
      records: parseRecords(text.slice(0, lastNewline)),
    };
  }
}

export class JournalObserverError extends Error {
  constructor(
    readonly code:
      | "SESSION_REPLACED"
      | "SESSION_TRUNCATED"
      | "SESSION_BATCH_TOO_LARGE"
      | "SESSION_RECORD_TOO_LARGE"
      | "SESSION_HISTORY_TOO_LARGE",
    message: string,
  ) {
    super(message);
  }
}

async function statIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readRange(path: string, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const handle = await open(path, "r");
  let bytesRead = 0;
  try {
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return buffer.subarray(0, bytesRead);
}

function parseRecords(text: string): unknown[] {
  const records: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
      throw new JournalObserverError("SESSION_RECORD_TOO_LARGE", "Pi session record exceeds 4 MiB");
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return records;
}

function reconstructAsyncOwners(records: unknown[]): {
  backgroundAgents: Record<string, BackgroundAgentRecord>;
  backgroundProcesses: Record<string, BackgroundProcessRecord>;
} {
  const backgroundAgents: Record<string, BackgroundAgentRecord> = {};
  const backgroundProcesses: Record<string, BackgroundProcessRecord> = {};
  for (const record of records) {
    const envelope = asObject(record);
    if (envelope.type === "message") {
      const message = asObject(envelope.message);
      if (message.role !== "toolResult") continue;
      const details = asObject(message.details);
      if (message.toolName === "Agent" && details.status === "background") {
        const agentId = optionalString(details.agentId);
        if (!agentId) continue;
        backgroundAgents[agentId] = {
          id: agentId,
          description: optionalString(details.description),
          observedAt: optionalString(envelope.timestamp) ?? new Date().toISOString(),
        };
        continue;
      }
      if (message.toolName !== "process" || details.action !== "start") continue;
      const process = asObject(details.process);
      const processId = optionalString(process.id);
      const command = optionalString(process.command);
      if (!processId || !command || process.status !== "running") continue;
      backgroundProcesses[processId] = {
        id: processId,
        name: optionalString(process.name),
        command,
        observedAt: optionalString(envelope.timestamp) ?? new Date().toISOString(),
        mutationFingerprintBefore: "",
        toolCallId: optionalString(message.toolCallId) ?? processId,
      };
      continue;
    }
    if (envelope.type === "custom" && envelope.customType === "subagents:record") {
      const data = asObject(envelope.data);
      const agentId = optionalString(data.id);
      const status = optionalString(data.status);
      if (!agentId || !status || !isTerminalBackgroundAgentStatus(status)) continue;
      delete backgroundAgents[agentId];
      continue;
    }
    if (envelope.type !== "custom_message" || envelope.customType !== "ad-process:notification") continue;
    const details = asObject(envelope.details);
    const processId = optionalString(details.processId);
    if (!processId || !isTerminalProcessNotificationKind(details.kind)) continue;
    delete backgroundProcesses[processId];
  }
  return { backgroundAgents, backgroundProcesses };
}

function isTerminalBackgroundAgentStatus(status: string): boolean {
  return ["completed", "failed", "cancelled", "killed"].includes(status);
}

function isTerminalProcessNotificationKind(value: unknown): boolean {
  return ["success", "failure", "crash", "killed"].includes(String(value ?? ""));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
