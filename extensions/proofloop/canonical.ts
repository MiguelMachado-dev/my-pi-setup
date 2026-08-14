import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestValue(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function normalizeCommand(command: string): string {
  return command.replace(/\r\n/g, "\n").trim();
}

export function isPathInside(path: string, parent: string): boolean {
  const normalizedPath = trimSlashes(path);
  const normalizedParent = trimSlashes(parent);
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

function trimSlashes(value: string): string {
  return value.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
