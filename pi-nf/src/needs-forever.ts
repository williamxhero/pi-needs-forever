import { execFile, execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditDirectory } from "./audit.js";
import { contractHash, readContractFile } from "./contract.js";
import { Host } from "./host.js";
import {
  findProjectConfig,
  issueReaderFromGh,
  previewExplicit,
  previewFromDraft,
  previewProjectOrIssue,
  resolveGitHubRepo,
} from "./needs-contract.js";
import { atomicJson, recordOf, repoSlug, requestKeyOf, safeJson, splitRequestKey, stringOf } from "./needs-paths.js";
import type { TaskContract } from "./types.js";

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
  /** Whether the NFG projection existed at handshake time; startup alone does not imply visibility. */
  nfgVisible?: boolean;
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
  /** Read-only and side-effect free. */
  preview(request: IssueRequest): Promise<ContractPreview>;
  start(request: IssueRequest): Promise<StartResult>;
  /** Read-only; never starts or repairs anything. */
  inspect(request: string | IssueRequest): Promise<HandoffReceipt | null>;
  /** Read-only receipt inventory, newest first. */
  list(): Promise<HandoffReceipt[]>;
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

export class DetachedCliRuntime implements HandoffRuntime {
  private readonly cliPath: string;
  private readonly command: string;

  constructor(options: { cliPath?: string; command?: string } = {}) {
    this.cliPath = options.cliPath ?? resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
    this.command = options.command ?? process.execPath;
  }

  async launch(input: HandoffLaunch): Promise<{ pid: number | null }> {
    mkdirSync(dirname(input.logPath), { recursive: true });
    const log = openSync(input.logPath, "a");
    try {
      const args = input.mode === "recover"
        ? [this.cliPath, "recover", "--db", input.dbPath]
        : [this.cliPath, "start", "--task", input.contractPath, "--db", input.dbPath];
      const child = spawn(this.command, args, {
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
    if (!Number.isInteger(request.issue) || request.issue <= 0) throw new Error("issue must be a positive integer.");
    return { cwd, repo, requestKey: requestKeyOf(repo, request.issue) };
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
        const draft = recordOf(readContractFile(existing.contractPath));
        if (draft) return previewFromDraft(requestKey, "existing", draft, []);
      } catch {
        // A damaged receipt falls through to a fresh preview that reports the damage.
      }
    }
    if (request.contractPath) return previewExplicit(requestKey, cwd, request.contractPath);
    return previewProjectOrIssue({
      requestKey,
      request,
      cwd,
      config: findProjectConfig(cwd),
      issue: await this.readIssue(repo, request.issue, cwd),
      damagedReceiptPath: existing ? existing.contractPath : null,
    });
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

  private receiptFor(
    requestKey: string,
    contract: TaskContract,
    contractHashValue: string,
    paths: ReturnType<NeedsForeverService["canonicalContract"]>,
    status: HandoffReceipt["status"],
    pid: number | null,
  ): HandoffReceipt {
    return {
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
      status,
      pid,
      nfgVisible: existsSync(paths.nfgPath),
    };
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

    const receipt = this.receiptFor(requestKey, contract, contractHashValue, paths, "running", pid);
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

    const paths = this.canonicalContract(preview.requestKey, preview.contract);
    const orphan = existsSync(paths.stateDb);
    if (!request.yes && !request.contractPath && !(request.restart && orphan)) {
      return { kind: "rejected", preview, reason: "confirmation_required" };
    }
    if (orphan) {
      const orphanReceipt = this.receiptFor(preview.requestKey, preview.contract, preview.contractHash, paths, "exited", null);
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

  async list(): Promise<HandoffReceipt[]> {
    const root = join(this.home, "handoff");
    if (!existsSync(root)) return [];
    const receipts: HandoffReceipt[] = [];
    for (const repo of readdirSync(root, { withFileTypes: true })) {
      if (!repo.isDirectory()) continue;
      for (const file of readdirSync(join(root, repo.name), { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".json")) continue;
        const value = recordOf(safeJson(join(root, repo.name, file.name)));
        if (!value || !stringOf(value.requestKey) || !stringOf(value.taskId)) continue;
        const receipt = value as unknown as HandoffReceipt;
        receipts.push({ ...receipt, status: this.runtime.isAlive(receipt.pid) ? "running" : "exited" });
      }
    }
    return receipts.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
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
