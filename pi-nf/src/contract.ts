import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { C2Mode, PreparedContract, TaskContract, TaskLimits, VerifyConfig } from "./types.js";
import { ContractError } from "./types.js";

type UnknownRecord = Record<string, unknown>;

function objectOf(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError(`${field} must be an object.`);
  }
  return value as UnknownRecord;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContractError(`${field} must be a nonempty string.`);
  }
  return value;
}

function integerOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ContractError(`${field} must be null or a positive integer.`);
  }
  return value;
}

function minutesOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ContractError(`${field} must be null or a positive number.`);
  }
  return value;
}

function c2Mode(value: unknown): C2Mode {
  if (value === undefined) return "enforce";
  const mode = nonEmpty(value, "c2.mode");
  if (mode !== "enforce" && mode !== "shadow" && mode !== "legacy") {
    throw new ContractError("c2.mode must be enforce, shadow or legacy.");
  }
  return mode;
}

function verifyConfig(value: unknown): VerifyConfig {
  const raw = objectOf(value, "verify");
  if (!Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new ContractError("verify.argv must be a nonempty string array.");
  }
  if (typeof raw.timeout_seconds !== "number" || !Number.isFinite(raw.timeout_seconds) || raw.timeout_seconds <= 0) {
    throw new ContractError("verify.timeout_seconds must be a positive number.");
  }
  if (!Array.isArray(raw.protected_files) || raw.protected_files.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new ContractError("verify.protected_files must be a string array.");
  }
  return {
    argv: [...raw.argv],
    timeout_seconds: raw.timeout_seconds,
    protected_files: [...raw.protected_files],
  };
}

function limits(value: unknown): TaskLimits {
  const raw = objectOf(value, "limits");
  return {
    max_worker_turns: integerOrNull(raw.max_worker_turns, "limits.max_worker_turns"),
    max_minutes: minutesOrNull(raw.max_minutes, "limits.max_minutes"),
  };
}

function acceptance(value: unknown): { id: string; text: string }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ContractError("acceptance must be a nonempty array.");
  }
  const items = value.map((entry, index) => {
    const raw = objectOf(entry, `acceptance[${index}]`);
    return {
      id: nonEmpty(raw.id, `acceptance[${index}].id`),
      text: nonEmpty(raw.text, `acceptance[${index}].text`),
    };
  });
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new ContractError(`acceptance id "${item.id}" is duplicated.`);
    ids.add(item.id);
  }
  return items;
}

export function normalizeContract(input: unknown): TaskContract {
  const raw = objectOf(input, "contract");
  if (raw.schema_version !== 1) throw new ContractError("schema_version must be 1.");
  const taskId = nonEmpty(raw.task_id, "task_id");
  const workspaceInput = nonEmpty(raw.workspace, "workspace");
  if (!isAbsolute(workspaceInput)) throw new ContractError("workspace must be an absolute path.");
  const workspace = resolve(workspaceInput);
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = realpathSync(workspace);
    if (!statSync(canonicalWorkspace).isDirectory()) throw new ContractError("workspace must be a directory.");
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError(`workspace does not exist or cannot be resolved: ${workspace}`);
  }
  const mode = c2Mode(raw.c2 === undefined ? undefined : objectOf(raw.c2, "c2").mode);
  const verify = raw.verify === undefined ? undefined : verifyConfig(raw.verify);
  const task: TaskContract = {
    schema_version: 1,
    task_id: taskId,
    workspace: canonicalWorkspace,
    goal: nonEmpty(raw.goal, "goal"),
    acceptance: acceptance(raw.acceptance),
    authorization: nonEmpty(raw.authorization, "authorization"),
    c2: { mode },
    limits: limits(raw.limits),
    ...(verify ? { verify } : {}),
  };
  return task;
}

export function contractHash(task: TaskContract): string {
  const canonical = {
    schema_version: task.schema_version,
    task_id: task.task_id,
    workspace: task.workspace,
    goal: task.goal,
    acceptance: task.acceptance.map((item) => ({ id: item.id, text: item.text })),
    authorization: task.authorization,
    c2: { mode: task.c2?.mode ?? "legacy" },
    limits: {
      max_worker_turns: task.limits.max_worker_turns,
      max_minutes: task.limits.max_minutes,
    },
    ...(task.verify
      ? {
          verify: {
            argv: task.verify.argv,
            timeout_seconds: task.verify.timeout_seconds,
            protected_files: task.verify.protected_files,
          },
        }
      : {}),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export class ContractPolicy {
  prepare(input: unknown): PreparedContract {
    const task = normalizeContract(input);
    return { task, contract_sha256: contractHash(task) };
  }
}

export function readContractFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ContractError(`contract file is not valid JSON: ${path}`);
    throw new ContractError(`cannot read contract file: ${path}`);
  }
}
