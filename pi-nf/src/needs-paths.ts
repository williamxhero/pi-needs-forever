import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ContractGap } from "./needs-forever.js";

export type ProjectConfig = Record<string, unknown>;

export type ProjectConfigFile = {
  path: string;
  directory: string;
  value: ProjectConfig;
};

export function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberFromIssue(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error("issue must be a positive integer.");
  return value;
}

export function repoSlug(repo: string): string {
  return repo.replaceAll(/[^A-Za-z0-9_.-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "repo";
}

export function requestKeyOf(repo: string, issue: number): string {
  return `${repo}#${issue}`;
}

export function splitRequestKey(value: string): { repo: string; issue: number } {
  const hash = value.lastIndexOf("#");
  if (hash <= 0) throw new Error(`invalid request key: ${value}`);
  const repo = value.slice(0, hash);
  const issue = Number(value.slice(hash + 1));
  if (!Number.isInteger(issue) || issue <= 0) throw new Error(`invalid request key: ${value}`);
  return { repo, issue };
}

export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/** A malformed or missing JSON file is simply absent, never a crash. */
export function safeJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}
