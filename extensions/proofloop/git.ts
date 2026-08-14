import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { digestValue } from "./canonical";
import type { GitBaseline, GitFileFingerprint, GitSnapshot } from "./types";

const executeFile = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

interface StatusEntry {
  path: string;
  status: string;
  renameSource?: string;
}

export class GitObserver {
  async captureBracketedBaseline<T>(
    root: string,
    expectedHead: string,
    captureWatermark: () => Promise<T>,
  ): Promise<{ baseline: GitBaseline; watermark: T }> {
    const first = await this.capture(root);
    const watermark = await captureWatermark();
    const second = await this.capture(root);
    if (first.head !== expectedHead) throw new GitObserverError("HEAD_MISMATCH", `Expected HEAD ${expectedHead}, observed ${first.head}`);
    if (first.digest !== second.digest) throw new GitObserverError("BASELINE_UNSTABLE", "Git state changed while the baseline was captured");
    return {
      baseline: { ...second, capturedAt: new Date().toISOString() },
      watermark,
    };
  }

  async capture(root: string): Promise<GitSnapshot> {
    const canonicalRoot = await realpath(root);
    const head = await this.gitText(canonicalRoot, ["rev-parse", "HEAD"]);
    const statusBuffer = await this.gitBuffer(canonicalRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const indexBuffer = await this.gitBuffer(canonicalRoot, ["ls-files", "--stage", "-z"]);
    const statuses = parseStatus(statusBuffer);
    const index = parseIndex(indexBuffer);
    const entries: Record<string, GitFileFingerprint> = {};

    for (const entry of statuses) {
      entries[entry.path] = {
        status: entry.status,
        worktree: await fingerprintPath(canonicalRoot, entry.path),
        index: index.get(entry.path),
        renameSource: entry.renameSource,
      };
    }

    return { head, entries, digest: digestValue({ head, entries }) };
  }

  private async gitText(root: string, args: string[]): Promise<string> {
    const value = await this.gitBuffer(root, args);
    return value.toString("utf8").trim();
  }

  private async gitBuffer(root: string, args: string[]): Promise<Buffer> {
    try {
      const result = await executeFile("git", ["-C", root, ...args], {
        encoding: "buffer",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        maxBuffer: MAX_BUFFER,
      });
      return result.stdout as Buffer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GitObserverError("GIT_UNAVAILABLE", message);
    }
  }
}

export class GitObserverError extends Error {
  constructor(
    readonly code: "GIT_UNAVAILABLE" | "HEAD_MISMATCH" | "BASELINE_UNSTABLE",
    message: string,
  ) {
    super(message);
  }
}

function parseStatus(buffer: Buffer): StatusEntry[] {
  const fields = buffer.toString("utf8").split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    const renamed = status.includes("R") || status.includes("C");
    const renameSource = renamed ? fields[index + 1] : undefined;
    if (renamed) index += 1;
    entries.push({ path, status, renameSource: renameSource || undefined });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function parseIndex(buffer: Buffer): Map<string, { mode: string; objectId: string; stage: string }> {
  const result = new Map<string, { mode: string; objectId: string; stage: string }>();
  for (const field of buffer.toString("utf8").split("\0")) {
    if (!field) continue;
    const tab = field.indexOf("\t");
    if (tab < 0) continue;
    const [mode, objectId, stage] = field.slice(0, tab).split(" ");
    const path = field.slice(tab + 1);
    if (stage !== "0") continue;
    result.set(path, { mode, objectId, stage });
  }
  return result;
}

async function fingerprintPath(root: string, path: string): Promise<GitFileFingerprint["worktree"]> {
  const absolutePath = `${root}/${path}`;
  try {
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      return { kind: "symlink", mode: metadata.mode, target: await readlink(absolutePath) };
    }
    if (metadata.isFile()) {
      const content = await readFile(absolutePath);
      const sha256 = createHash("sha256").update(content).digest("hex");
      return { kind: "file", mode: metadata.mode, size: metadata.size, sha256 };
    }
    return { kind: "other", mode: metadata.mode, size: metadata.size };
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
