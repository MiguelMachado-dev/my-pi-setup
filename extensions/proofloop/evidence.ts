import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { sha256 } from "./canonical";
import type { GitBaseline } from "./types";

const MAX_ARCHIVED_BYTES = 512 * 1024 * 1024;

export class EvidenceStore {
  constructor(private readonly root: string) {}

  runPath(runId: string): string {
    return join(this.root, "runs", runId);
  }

  exists(runId: string): boolean {
    return existsSync(this.runPath(runId));
  }

  create(runId: string): string {
    const runsPath = join(this.root, "runs");
    mkdirSync(runsPath, { mode: 0o700, recursive: true });
    const path = this.runPath(runId);
    mkdirSync(path, { mode: 0o700, recursive: false });
    return path;
  }

  remove(runId: string): void {
    rmSync(this.runPath(runId), { force: true, recursive: true });
  }

  archiveBaseline(runId: string, worktreeRoot: string, baseline: GitBaseline): void {
    const blobsPath = join(this.runPath(runId), "blobs");
    mkdirSync(blobsPath, { mode: 0o700, recursive: false });
    const canonicalRoot = resolve(worktreeRoot);
    let archivedBytes = 0;

    for (const [path, fingerprint] of Object.entries(baseline.entries)) {
      if (fingerprint.worktree.kind !== "file") continue;
      if (isAbsolute(path)) throw new Error(`Git baseline path must be relative: ${path}`);
      const sourcePath = resolve(canonicalRoot, path);
      if (!sourcePath.startsWith(`${canonicalRoot}/`)) throw new Error(`Git baseline path escaped the worktree: ${path}`);
      const content = readFileSync(sourcePath);
      archivedBytes += content.length;
      if (archivedBytes > MAX_ARCHIVED_BYTES) throw new Error("Baseline archive exceeds 512 MiB");
      if (sha256(content) !== fingerprint.worktree.sha256) throw new Error(`Baseline changed before archival: ${path}`);
      const destination = join(blobsPath, fingerprint.worktree.sha256);
      if (!existsSync(destination)) writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
    }
  }

  writeJson(runId: string, name: string, value: unknown): void {
    const path = join(this.runPath(runId), name);
    atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  appendJson(runId: string, name: string, value: unknown): void {
    const path = join(this.runPath(runId), name);
    const descriptor = openSync(path, "a", 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(value)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, content, { mode: 0o600 });
  const descriptor = openSync(temporaryPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
}
