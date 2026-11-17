import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { contractHash, normalizeContract, readContractFile } from "./contract.js";
import { recordOf, stringOf, type ProjectConfig, type ProjectConfigFile } from "./needs-paths.js";
import type { ContractGap, ContractPreview, IssueReader, IssueRequest, IssueSnapshot } from "./needs-forever.js";
import type { TaskContract } from "./types.js";

const execFileAsync = promisify(execFile);

function parseChecklist(body: string): { id: string; text: string }[] {
  const items: { id: string; text: string }[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/);
    if (!match) continue;
    const text = match[1]!.trim();
    if (!text) continue;
    items.push({ id: `A${items.length + 1}`, text });
  }
  return items;
}

function parseAcceptance(value: unknown): { id: string; text: string }[] | null {
  if (!Array.isArray(value)) return null;
  const items: { id: string; text: string }[] = [];
  for (const raw of value) {
    const entry = recordOf(raw);
    const id = stringOf(entry?.id);
    const text = stringOf(entry?.text);
    if (!id || !text) return null;
    items.push({ id, text });
  }
  return items.length ? items : null;
}

export function findProjectConfig(cwd: string): { file: ProjectConfigFile | null; error: string | null } {
  let directory = resolve(cwd);
  for (;;) {
    for (const name of [".needs-forever.json", "needs-forever.json"]) {
      const path = join(directory, name);
      if (!existsSync(path)) continue;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
        const value = recordOf(parsed);
        if (!value) return { file: null, error: `project config is not an object: ${path}` };
        return { file: { path, directory, value: value as ProjectConfig }, error: null };
      } catch (error) {
        return { file: null, error: `cannot read project config ${path}: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return { file: null, error: null };
    directory = parent;
  }
}

function configWorkspace(file: ProjectConfigFile, request: IssueRequest, cwd: string): string {
  const raw = stringOf(request.workspace) ?? stringOf(file.value.workspace);
  return raw ? resolve(file.directory, raw) : resolve(cwd);
}

export function mergeGaps(...groups: (ContractGap | null | undefined)[][]): ContractGap[] {
  const result: ContractGap[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const gap of group) {
      if (!gap) continue;
      const key = `${gap.field}\0${gap.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(gap);
    }
  }
  return result;
}

function normalizeWithGaps(draft: Record<string, unknown>): { contract: TaskContract | null; hash: string | null; gap: ContractGap | null } {
  try {
    const contract = normalizeContract(draft);
    return { contract, hash: contractHash(contract), gap: null };
  } catch (error) {
    return {
      contract: null,
      hash: null,
      gap: { field: "contract", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export function requiredGaps(contract: TaskContract | null): ContractGap[] {
  if (!contract) return [];
  return contract.verify ? [] : [{ field: "verify", message: "A fixed-argv verifier is required for DONE; add verify to the project config or contract." }];
}

export function issueReaderFromGh(): IssueReader {
  return async (repo, issue, cwd) => {
    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["issue", "view", String(issue), "--repo", repo, "--json", "number,title,body,url,state"],
        { cwd, encoding: "utf8", timeout: 15_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      );
      const value = JSON.parse(String(stdout)) as Record<string, unknown>;
      const number = typeof value.number === "number" ? value.number : issue;
      const title = stringOf(value.title);
      if (!title) return null;
      return {
        repo,
        number,
        title,
        body: stringOf(value.body) ?? "",
        url: stringOf(value.url) ?? `https://github.com/${repo}/issues/${issue}`,
        state: stringOf(value.state) ?? "UNKNOWN",
      };
    } catch {
      return null;
    }
  };
}

export function resolveGitHubRepo(cwd: string): string | null {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

function readProjectConfig(file: ProjectConfigFile): {
  workspace: string;
  goal: string | null;
  acceptance: { id: string; text: string }[] | null;
  authorization: string | null;
  verify: unknown;
  c2: unknown;
  limits: unknown;
  taskIdPrefix: string | null;
  gap: ContractGap | null;
} {
  const acceptance = parseAcceptance(file.value.acceptance);
  const acceptanceError = file.value.acceptance !== undefined && acceptance === null
    ? { field: "acceptance", message: `project config acceptance must be a nonempty array of {id,text}: ${file.path}` }
    : null;
  return {
    workspace: resolve(file.directory, stringOf(file.value.workspace) ?? "."),
    goal: stringOf(file.value.goal),
    acceptance,
    authorization: stringOf(file.value.authorization),
    verify: file.value.verify,
    c2: file.value.c2,
    limits: file.value.limits,
    taskIdPrefix: stringOf(file.value.task_id_prefix),
    gap: acceptanceError,
  };
}

export function draftFromConfig(
  request: IssueRequest,
  cwd: string,
  file: ProjectConfigFile,
  issue: IssueSnapshot | null,
): { draft: Record<string, unknown>; gaps: ContractGap[] } {
  const config = readProjectConfig(file);
  const gaps: ContractGap[] = [];
  if (config.gap) gaps.push(config.gap);
  const acceptance = config.acceptance ?? (issue ? parseChecklist(issue.body) : []);
  if (!acceptance.length) {
    gaps.push({ field: "acceptance", message: "No acceptance checklist was found in the issue and the project config has no acceptance items." });
  }
  if (!config.authorization) {
    gaps.push({ field: "authorization", message: "The project config needs an authorization statement for worker A." });
  }
  if (config.verify === undefined) {
    gaps.push({ field: "verify", message: "The project config needs a fixed-argv verify block." });
  }
  const workspace = configWorkspace(file, request, cwd);
  const goal = config.goal ?? issue?.title ?? "";
  if (!goal.trim()) gaps.push({ field: "goal", message: "The issue has no title and the project config has no goal." });
  const draft: Record<string, unknown> = {
    schema_version: 1,
    task_id: `${config.taskIdPrefix ?? "issue"}-${request.issue}`,
    workspace,
    goal,
    acceptance,
    authorization: config.authorization ?? "",
    c2: config.c2 ?? { mode: "enforce" },
    limits: config.limits ?? { max_worker_turns: null, max_minutes: null },
    ...(config.verify === undefined ? {} : { verify: config.verify }),
  };
  return { draft, gaps };
}

export function draftFromIssue(request: IssueRequest, cwd: string, issue: IssueSnapshot | null): { draft: Record<string, unknown>; gaps: ContractGap[] } {
  const gaps: ContractGap[] = [];
  if (!issue) {
    gaps.push({ field: "issue", message: `Issue ${request.repo}#${request.issue} could not be read from the configured tracker.` });
  }
  const acceptance = issue ? parseChecklist(issue.body) : [];
  if (!acceptance.length) {
    gaps.push({ field: "acceptance", message: "The issue has no markdown acceptance checklist; provide a project config or an explicit contract." });
  }
  gaps.push({ field: "authorization", message: "No authorization statement is configured; provide a project config or an explicit contract." });
  gaps.push({ field: "verify", message: "No fixed-argv verifier is configured; provide a project config or an explicit contract." });
  const draft: Record<string, unknown> = {
    schema_version: 1,
    task_id: `issue-${request.issue}`,
    workspace: resolve(cwd),
    goal: issue?.title ?? "",
    acceptance,
    authorization: "",
    c2: { mode: "enforce" },
    limits: { max_worker_turns: null, max_minutes: null },
  };
  return { draft, gaps };
}

export function previewFromDraft(
  requestKey: string,
  source: ContractPreview["source"],
  draft: Record<string, unknown>,
  extraGaps: ContractGap[],
): ContractPreview {
  const normalized = normalizeWithGaps(draft);
  const gaps = mergeGaps(extraGaps, normalized.gap ? [normalized.gap] : [], requiredGaps(normalized.contract));
  return {
    requestKey,
    contract: normalized.contract,
    draft,
    contractHash: normalized.hash,
    source,
    gaps,
  };
}

/** An explicitly reviewed contract file; a read/parse failure becomes a gap, never a guess. */
export function previewExplicit(requestKey: string, cwd: string, contractPath: string): ContractPreview {
  try {
    const raw = readContractFile(resolve(cwd, contractPath));
    const draft = recordOf(raw);
    if (!draft) throw new Error("contract file must be a JSON object.");
    return previewFromDraft(requestKey, "explicit", draft, []);
  } catch (error) {
    return previewFromDraft(
      requestKey,
      "explicit",
      {},
      [{ field: "contract", message: error instanceof Error ? error.message : String(error) }],
    );
  }
}

/** Project config first, then the issue itself, then an honest empty draft. */
export function previewProjectOrIssue(input: {
  requestKey: string;
  request: IssueRequest;
  cwd: string;
  config: ReturnType<typeof findProjectConfig>;
  issue: IssueSnapshot | null;
  damagedReceiptPath: string | null;
}): ContractPreview {
  const projectGap = input.config.error ? [{ field: "project", message: input.config.error }] : [];
  const receiptGap = input.damagedReceiptPath
    ? [{ field: "receipt", message: `Existing receipt ${input.damagedReceiptPath} could not be read.` }]
    : [];
  if (input.config.file) {
    const built = draftFromConfig(input.request, input.cwd, input.config.file, input.issue);
    return previewFromDraft(input.requestKey, "project", built.draft, mergeGaps(built.gaps, projectGap));
  }
  const built = draftFromIssue(input.request, input.cwd, input.issue);
  return previewFromDraft(input.requestKey, input.issue ? "issue" : "draft", built.draft, mergeGaps(built.gaps, projectGap, receiptGap));
}
