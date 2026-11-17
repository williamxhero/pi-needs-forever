import { execFile, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { auditDirectory } from "./audit.js";
import { contractHash, normalizeContract, readContractFile } from "./contract.js";
import { Host } from "./host.js";
import type { TaskContract } from "./types.js";

const execFileAsync = promisify(execFile);

export type ContractGap = {
  field: string;
  message: string;
};

export type IssueSnapshot = {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
};

export type IssueReader = (repo: string, issue: number, cwd: string) => Promise<IssueSnapshot | null>;

export type IssueRequest = {
  repo: string;
  issue: number;
  workspace?: string;
  contractPath?: string;
  cwd?: string;
  yes?: boolean;
  restart?: boolean;
};

export type ContractPreview = {
  requestKey: string;
  contract: TaskContract | null;
  draft: Record<string, unknown>;
  contractHash: string | null;
  source: "existing" | "explicit" | "project" | "issue" | "draft";
  gaps: ContractGap[];
};

export type HandoffReceipt = {
  requestKey: string;
  taskId: string;
  contractHash: string;
  workspace: string;
  stateDb: string;
  contractPath: string;
  logPath: string;
  receiptPath: string;
  nfgPath: string;
  startedAt: string;
  status: "starting" | "running" | "exited" | "failed";
  pid: number | null;
};

export type StartResult =
  | { kind: "started"; receipt: HandoffReceipt }
  | { kind: "existing"; receipt: HandoffReceipt }
  | { kind: "rejected"; preview: ContractPreview; reason: "gaps" | "confirmation_required" }
  | { kind: "conflict"; receipt: HandoffReceipt; reason: string };

export type LaunchMode = "start" | "recover";

export type HandoffLaunch = {
  mode: LaunchMode;
  contractPath: string;
  dbPath: string;
  logPath: string;
  workspace: string;
};

export type HandoffRuntime = {
  launch(input: HandoffLaunch): Promise<{ pid: number | null }>;
  isAlive(pid: number | null): boolean;
  terminate(pid: number | null): void;
};

export interface NeedsForever {
  preview(request: IssueRequest): Promise<ContractPreview>;
  start(request: IssueRequest): Promise<StartResult>;
  inspect(request: string | IssueRequest): Promise<HandoffReceipt | null>;
}

export type NeedsForeverOptions = {
  cwd?: string;
  home?: string;
  issueReader?: IssueReader;
  runtime?: HandoffRuntime;
  probe?: (dbPath: string) => Promise<{ task_id: string; status?: string }>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  cliPath?: string;
};

type ProjectConfig = Record<string, unknown> & {
  workspace?: unknown;
  goal?: unknown;
  acceptance?: unknown;
  authorization?: unknown;
  verify?: unknown;
  c2?: unknown;
  limits?: unknown;
  task_id_prefix?: unknown;
};

type ProjectConfigFile = {
  path: string;
  directory: string;
  value: ProjectConfig;
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberFromIssue(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error("issue must be a positive integer.");
  return value;
}

function repoSlug(repo: string): string {
  return repo.replaceAll(/[^A-Za-z0-9_.-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "repo";
}

function requestKeyOf(repo: string, issue: number): string {
  return `${repo}#${issue}`;
}

function splitRequestKey(value: string): { repo: string; issue: number } {
  const hash = value.lastIndexOf("#");
  if (hash <= 0) throw new Error(`invalid request key: ${value}`);
  const repo = value.slice(0, hash);
  const issue = Number(value.slice(hash + 1));
  if (!Number.isInteger(issue) || issue <= 0) throw new Error(`invalid request key: ${value}`);
  return { repo, issue };
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

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

function findProjectConfig(cwd: string): { file: ProjectConfigFile | null; error: string | null } {
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

function mergeGaps(...groups: (ContractGap | null | undefined)[][]): ContractGap[] {
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

function requiredGaps(contract: TaskContract | null): ContractGap[] {
  if (!contract) return [];
  return contract.verify ? [] : [{ field: "verify", message: "A fixed-argv verifier is required for DONE; add verify to the project config or contract." }];
}

function issueReaderFromGh(): IssueReader {
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

function draftFromConfig(
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

function draftFromIssue(request: IssueRequest, cwd: string, issue: IssueSnapshot | null): { draft: Record<string, unknown>; gaps: ContractGap[] } {
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

function previewFromDraft(
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

export class DetachedCliRuntime implements HandoffRuntime {
  private readonly cliPath: string;

  constructor(options: { cliPath?: string; command?: string } = {}) {
    this.cliPath = options.cliPath ?? resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
    this.command = options.command ?? process.execPath;
  }

  private readonly command: string;

  async launch(input: HandoffLaunch): Promise<{ pid: number | null }> {
    mkdirSync(dirname(input.logPath), { recursive: true });
    const log = openSync(input.logPath, "a");
    try {
      const args = input.mode === "recover"
        ? [this.cliPath, "recover", "--db", input.dbPath]
        : [this.cliPath, "start", "--task", input.contractPath, "--db", input.dbPath];
      const child = (await import("node:child_process")).spawn(this.command, args, {
        cwd: input.workspace,
        detached: true,
        stdio: ["ignore", log, log],
        windowsHide: true,
        env: process.env,
      });
      child.unref();
      return { pid: child.pid ?? null };
    } finally {
      closeSync(log);
    }
  }

  isAlive(pid: number | null): boolean {
    if (pid === null) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  terminate(pid: number | null): void {
    if (pid === null) return;
    try {
      process.kill(pid);
    } catch {
      // The detached child may already be gone.
    }
  }
}

export class NeedsForeverService implements NeedsForever {
  private readonly cwd: string;
  private readonly home: string;
  private readonly issueReader: IssueReader;
  private readonly runtime: HandoffRuntime;
  private readonly probe: (dbPath: string) => Promise<{ task_id: string; status?: string }>;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readyTimeoutMs: number;

  constructor(options: NeedsForeverOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.home = resolve(options.home ?? process.env.PI_NF_HOME ?? join(homedir(), ".pi-nf"));
    this.issueReader = options.issueReader ?? issueReaderFromGh();
    this.runtime = options.runtime ?? new DetachedCliRuntime(options.cliPath ? { cliPath: options.cliPath } : {});
    this.probe = options.probe ?? (async (dbPath) => {
      const status = await Host.status(dbPath);
      return { task_id: status.task_id, status: status.status };
    });
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  }

  private requestContext(request: IssueRequest): { cwd: string; repo: string; requestKey: string } {
    const cwd = resolve(request.cwd ?? this.cwd);
    const repo = stringOf(request.repo) ?? resolveGitHubRepo(cwd) ?? "unknown";
    return { cwd, repo, requestKey: requestKeyOf(repo, numberFromIssue(request.issue)) };
  }

  private receiptPath(repo: string, issue: number): string {
    return join(this.home, "handoff", repoSlug(repo), `${issue}.json`);
  }

  private taskDirectory(repo: string, issue: number): string {
    return join(this.home, "tasks", repoSlug(repo), String(issue));
  }

  private readReceipt(repo: string, issue: number): HandoffReceipt | null {
    const path = this.receiptPath(repo, issue);
    if (!existsSync(path)) return null;
    try {
      const value = recordOf(JSON.parse(readFileSync(path, "utf8")));
      if (!value) return null;
      if (!stringOf(value.requestKey) || !stringOf(value.taskId) || !stringOf(value.contractHash)) return null;
      return value as unknown as HandoffReceipt;
    } catch {
      return null;
    }
  }

  private writeReceipt(receipt: HandoffReceipt): void {
    atomicJson(receipt.receiptPath, receipt);
  }

  private async readIssue(repo: string, issue: number, cwd: string): Promise<IssueSnapshot | null> {
    try {
      return await this.issueReader(repo, issue, cwd);
    } catch {
      return null;
    }
  }

  async preview(request: IssueRequest): Promise<ContractPreview> {
    const { cwd, repo, requestKey } = this.requestContext(request);
    const existing = this.readReceipt(repo, request.issue);
    if (existing) {
      try {
        const draft = readContractFile(existing.contractPath);
        const raw = recordOf(draft);
        if (raw) return previewFromDraft(requestKey, "existing", raw, []);
      } catch {
        // A damaged existing receipt falls through to a fresh preview and is reported below.
      }
    }

    if (request.contractPath) {
      try {
        const raw = readContractFile(resolve(cwd, request.contractPath));
        const draft = recordOf(raw);
        if (!draft) throw new Error("contract file must be a JSON object.");
        return previewFromDraft(requestKey, "explicit", draft, []);
      } catch (error) {
        const draft: Record<string, unknown> = {};
        return previewFromDraft(
          requestKey,
          "explicit",
          draft,
          [{ field: "contract", message: error instanceof Error ? error.message : String(error) }],
        );
      }
    }

    const config = findProjectConfig(cwd);
    const issue = await this.readIssue(repo, request.issue, cwd);
    if (config.file) {
      const built = draftFromConfig(request, cwd, config.file, issue);
      return previewFromDraft(requestKey, "project", built.draft, mergeGaps(built.gaps, config.error ? [{ field: "project", message: config.error }] : []));
    }
    const built = draftFromIssue(request, cwd, issue);
    return previewFromDraft(requestKey, issue ? "issue" : "draft", built.draft, mergeGaps(
      built.gaps,
      config.error ? [{ field: "project", message: config.error }] : [],
      existing ? [{ field: "receipt", message: `Existing receipt ${existing.receiptPath} could not be read.` }] : [],
    ));
  }

  private canonicalContract(requestKey: string, contract: TaskContract): { directory: string; contractPath: string; stateDb: string; logPath: string; receiptPath: string; nfgPath: string } {
    const { repo, issue } = splitRequestKey(requestKey);
    const directory = this.taskDirectory(repo, issue);
    const contractPath = join(directory, "contract.json");
    const stateDb = join(directory, "state.sqlite");
    const logPath = join(directory, "run.log");
    const receiptPath = this.receiptPath(repo, issue);
    const nfgPath = join(auditDirectory(contract.workspace, contract.task_id), "audit.json");
    return { directory, contractPath, stateDb, logPath, receiptPath, nfgPath };
  }

  private async waitForTask(dbPath: string, taskId: string, pid: number | null): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (!this.runtime.isAlive(pid)) {
        throw new Error(`detached pi-nf process exited before the task became readable (pid ${pid ?? "unknown"}).`);
      }
      try {
        const status = await this.probe(dbPath);
        if (status.task_id === taskId) return;
      } catch (error) {
        lastError = error;
      }
      await this.sleep(50);
    }
    throw new Error(`timed out waiting for pi-nf task ${taskId} to become readable: ${lastError instanceof Error ? lastError.message : String(lastError ?? "no error")}`);
  }

  private async launch(
    request: IssueRequest,
    requestKey: string,
    contract: TaskContract,
    contractHashValue: string,
    mode: LaunchMode,
  ): Promise<StartResult> {
    const paths = this.canonicalContract(requestKey, contract);
    mkdirSync(paths.directory, { recursive: true });
    atomicJson(paths.contractPath, contract);
    const { repo, issue } = splitRequestKey(requestKey);
    let pid: number | null = null;
    try {
      const launched = await this.runtime.launch({
        mode,
        contractPath: paths.contractPath,
        dbPath: paths.stateDb,
        logPath: paths.logPath,
        workspace: contract.workspace,
      });
      pid = launched.pid;
      await this.waitForTask(paths.stateDb, contract.task_id, pid);
    } catch (error) {
      this.runtime.terminate(pid);
      if (mode === "start") {
        rmSync(paths.contractPath, { force: true });
        rmSync(paths.stateDb, { force: true });
      }
      throw error;
    }

    const receipt: HandoffReceipt = {
      requestKey,
      taskId: contract.task_id,
      contractHash: contractHashValue,
      workspace: contract.workspace,
      stateDb: paths.stateDb,
      contractPath: paths.contractPath,
      logPath: paths.logPath,
      receiptPath: paths.receiptPath,
      nfgPath: paths.nfgPath,
      startedAt: this.now().toISOString(),
      status: "running",
      pid,
    };
    this.writeReceipt(receipt);
    return { kind: "started", receipt };
  }

  async start(request: IssueRequest): Promise<StartResult> {
    const preview = await this.preview(request);
    if (!preview.contract || preview.gaps.length > 0 || !preview.contractHash) {
      return { kind: "rejected", preview, reason: "gaps" };
    }
    const { repo, issue } = splitRequestKey(preview.requestKey);
    const existing = this.readReceipt(repo, issue);
    if (existing) {
      if (existing.contractHash !== preview.contractHash) {
        return { kind: "conflict", receipt: existing, reason: "The existing task was started with a different contract hash." };
      }
      if (this.runtime.isAlive(existing.pid)) {
        return { kind: "existing", receipt: { ...existing, status: "running" } };
      }
      if (!request.restart) {
        return { kind: "conflict", receipt: existing, reason: "The previous handoff process is no longer alive; pass --restart to recover it explicitly." };
      }
      return this.launch(request, preview.requestKey, preview.contract, preview.contractHash, "recover");
    }

    if (!request.yes && !request.contractPath && !request.restart) {
      return { kind: "rejected", preview, reason: "confirmation_required" };
    }
    const paths = this.canonicalContract(preview.requestKey, preview.contract);
    if (existsSync(paths.stateDb)) {
      const orphanReceipt: HandoffReceipt = {
        requestKey: preview.requestKey,
        taskId: preview.contract.task_id,
        contractHash: preview.contractHash,
        workspace: preview.contract.workspace,
        stateDb: paths.stateDb,
        contractPath: paths.contractPath,
        logPath: paths.logPath,
        receiptPath: paths.receiptPath,
        nfgPath: paths.nfgPath,
        startedAt: this.now().toISOString(),
        status: "exited",
        pid: null,
      };
      if (!request.restart) {
        return {
          kind: "conflict",
          receipt: orphanReceipt,
          reason: "A state database exists without a handoff receipt; pass --restart to recover it explicitly.",
        };
      }
      try {
        const existingContract = await Host.readContract(paths.stateDb);
        if (contractHash(existingContract) !== preview.contractHash) {
          return { kind: "conflict", receipt: orphanReceipt, reason: "The orphan state database has a different contract hash." };
        }
      } catch (error) {
        return {
          kind: "conflict",
          receipt: orphanReceipt,
          reason: `The orphan state database could not be read: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return this.launch(request, preview.requestKey, preview.contract, preview.contractHash, "recover");
    }
    return this.launch(request, preview.requestKey, preview.contract, preview.contractHash, "start");
  }

  async inspect(request: string | IssueRequest): Promise<HandoffReceipt | null> {
    const key = typeof request === "string"
      ? request
      : this.requestContext(request).requestKey;
    const { repo, issue } = splitRequestKey(key);
    const receipt = this.readReceipt(repo, issue);
    if (!receipt) return null;
    return {
      ...receipt,
      status: this.runtime.isAlive(receipt.pid) ? "running" : "exited",
    };
  }
}

export function createNeedsForever(options: NeedsForeverOptions = {}): NeedsForever {
  return new NeedsForeverService(options);
}

export function formatGaps(gaps: ContractGap[]): string {
  return gaps.length ? gaps.map((gap) => `- ${gap.field}: ${gap.message}`).join("\n") : "- none";
}

export function formatPreview(preview: ContractPreview): string {
  const contract = preview.contract;
  const lines = [
    `Needs Forever preview ${preview.requestKey}`,
    `source: ${preview.source}`,
    `contract hash: ${preview.contractHash ?? "-"}`,
    `workspace: ${contract?.workspace ?? String(preview.draft.workspace ?? "-")}`,
    `goal: ${contract?.goal ?? String(preview.draft.goal ?? "-")}`,
    "acceptance:",
    ...(contract?.acceptance.length
      ? contract.acceptance.map((item) => `- ${item.id}: ${item.text}`)
      : [(preview.draft.acceptance as unknown[] | undefined)?.length ? "- (draft acceptance; inspect the issue/config)" : "- missing"]),
    `authorization: ${contract?.authorization ?? String(preview.draft.authorization ?? "-")}`,
    `verify: ${contract?.verify ? contract.verify.argv.join(" ") : "missing"}`,
    `limits: turns=${contract?.limits.max_worker_turns ?? "none"} minutes=${contract?.limits.max_minutes ?? "none"}`,
    "gaps:",
    formatGaps(preview.gaps),
  ];
  if (preview.gaps.length === 0) {
    lines.push("", `Next: /needs-forever ${preview.requestKey.split("#")[1]} --yes`);
  }
  return lines.join("\n");
}

export function formatReceipt(receipt: HandoffReceipt): string {
  return [
    "Handoff receipt",
    `task: ${receipt.taskId}`,
    `request: ${receipt.requestKey}`,
    `status: ${receipt.status}`,
    `contract hash: ${receipt.contractHash}`,
    `workspace: ${receipt.workspace}`,
    `state db: ${receipt.stateDb}`,
    `log: ${receipt.logPath}`,
    `NFG projection: ${receipt.nfgPath}`,
    `pid: ${receipt.pid ?? "-"}`,
  ].join("\n");
}

export function formatStartResult(result: StartResult): string {
  switch (result.kind) {
    case "started":
      return [
        "Started a new A session via pi-nf handoff.",
        "The current Pi session is only the launcher/observer; it is not the new A.",
        formatReceipt(result.receipt),
        "NFG visibility is separate from process startup; open the projection path to confirm.",
      ].join("\n");
    case "existing":
      return [
        "Reused the existing live handoff; no second writer was started.",
        formatReceipt(result.receipt),
      ].join("\n");
    case "rejected":
      return [
        result.reason === "confirmation_required"
          ? "Not started: confirmation is required."
          : "Not started: the contract has gaps.",
        formatPreview(result.preview),
      ].join("\n");
    case "conflict":
      return [
        `Handoff conflict: ${result.reason}`,
        formatReceipt(result.receipt),
        "Use --restart only after confirming the previous writer is gone.",
      ].join("\n");
  }
}

export function formatHelp(): string {
  return [
    "Usage:",
    "  /needs-forever 454              preview the issue contract; does not start",
    "  /needs-forever 454 --dry-run    explicit preview only",
    "  /needs-forever 454 --yes        start after reviewing a complete preview",
    "  /needs-forever 454 --contract <path>  use a reviewed contract",
    "  /needs-forever 454 --restart    recover a dead handoff receipt explicitly",
    "  /needs-forever status 454       show the handoff receipt",
    "  /needs-forever help             show this help",
    "",
    "A successful start creates a NEW A session. This Pi session remains the launcher and observer.",
  ].join("\n");
}

export type ParsedNeedsForeverCommand = {
  mode: "help" | "preview" | "start" | "status";
  request: IssueRequest;
};

export function parseNeedsForeverCommand(input: string): ParsedNeedsForeverCommand {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === "help" || tokens.length === 0) {
    return { mode: "help", request: { repo: "", issue: 0 } };
  }
  let mode: ParsedNeedsForeverCommand["mode"] = "preview";
  if (tokens[0] === "status") {
    mode = "status";
    tokens.shift();
  }
  const issueToken = tokens.find((token) => /^\d+$/.test(token));
  if (!issueToken) throw new Error("an issue number is required, for example: /needs-forever 454");
  const issue = Number(issueToken);
  const request: IssueRequest = { repo: "", issue };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === issueToken) continue;
    if (token === "--yes") {
      request.yes = true;
      if (mode === "preview") mode = "start";
    } else if (token === "--restart") {
      request.restart = true;
      if (mode === "preview") mode = "start";
    } else if (token === "--dry-run") {
      mode = "preview";
    } else if (token === "--contract") {
      const value = tokens[++index];
      if (!value) throw new Error("--contract requires a path.");
      request.contractPath = value;
      if (mode === "preview") mode = "start";
    } else if (token === "--repo") {
      const value = tokens[++index];
      if (!value) throw new Error("--repo requires owner/name.");
      request.repo = value;
    } else if (token === "--workspace") {
      const value = tokens[++index];
      if (!value) throw new Error("--workspace requires a path.");
      request.workspace = value;
    } else if (token.startsWith("--")) {
      throw new Error(`unknown option: ${token}`);
    }
  }
  return { mode, request };
}

export type PiExtensionContext = {
  cwd: string;
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
};

export type PiExtensionApi = {
  registerCommand(name: string, options: {
    description: string;
    handler: (args: string, ctx: PiExtensionContext) => Promise<void>;
  }): void;
};

export function createNeedsForeverExtension(needs: NeedsForever): (pi: PiExtensionApi) => void {
  return (pi) => {
    pi.registerCommand("needs-forever", {
      description: "Preview or start a pi-nf handoff task and observe it in NFG.",
      handler: async (args, ctx) => {
        try {
          const parsed = parseNeedsForeverCommand(args);
          if (parsed.mode === "help") {
            ctx.ui.notify(formatHelp(), "info");
            return;
          }
          const request = { ...parsed.request, cwd: ctx.cwd };
          if (parsed.mode === "status") {
            const receipt = await needs.inspect(request);
            ctx.ui.notify(receipt ? formatReceipt(receipt) : `No handoff receipt for ${request.repo || "this repository"}#${request.issue}.`, receipt ? "info" : "warning");
            return;
          }
          if (parsed.mode === "preview") {
            const preview = await needs.preview(request);
            ctx.ui.notify(formatPreview(preview), preview.gaps.length ? "warning" : "info");
            return;
          }
          const result = await needs.start(request);
          ctx.ui.notify(formatStartResult(result), result.kind === "rejected" || result.kind === "conflict" ? "warning" : "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  };
}

export default function registerNeedsForever(pi: PiExtensionApi): void {
  createNeedsForeverExtension(createNeedsForever())(pi);
}

