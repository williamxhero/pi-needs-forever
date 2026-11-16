import { existsSync } from "node:fs";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Models } from "@earendil-works/pi-ai";
import {
  Harness,
  ROOT_CONVERSATION_ID,
  createRegistry,
  type ModelRef,
  type Report,
  type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ContractPolicy, readContractFile } from "./contract.js";
import { Lease } from "./lease.js";
import { createDefaultModels, resolveModelRef } from "./models.js";
import { NF_BASE_EXTENSIONS, Supervision } from "./supervision.js";
import { createSupervisionExtension } from "./tasks/judge.js";
import type { Judge } from "./judge.js";
import type { PreparedContract, SendReceipt, StartReceipt, SupervisionStatus, TaskContract } from "./types.js";

export type HostOptions = {
  storage: Storage;
  models: Models;
  model: ModelRef;
  contract: TaskContract | unknown;
  db_path?: string;
  context?: Context;
  judge?: Judge;
};

export type HostSqliteOptions = {
  db_path: string;
  contract_path: string;
  models?: Models;
  model?: ModelRef;
  context?: Context;
  judge?: Judge;
};

export class Host {
  readonly reports: Report[];

  private constructor(
    readonly harness: Harness,
    readonly supervision: Supervision,
    private readonly prepared: PreparedContract,
    private readonly lease: Lease,
    private readonly context: Context,
    reports: Report[],
  ) {
    this.reports = reports;
  }

  static async open(options: HostOptions): Promise<Host> {
    const context = options.context ?? BACKGROUND_CONTEXT;
    const prepared = new ContractPolicy().prepare(options.contract);
    const lease = Lease.acquire(prepared.task, options.db_path ?? `memory:${prepared.task.task_id}`);
    let harness: Harness;
    const reports: Report[] = [];
    try {
      const extensions = options.judge
        ? [...NF_BASE_EXTENSIONS, createSupervisionExtension({ judge: options.judge })]
        : [...NF_BASE_EXTENSIONS];
      const registry = createRegistry();
      for (const extension of extensions) registry.install(extension);
      harness = await Harness.open(
        options.storage,
        {
          models: options.models,
          registry,
          settings: { extensions },
          env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? prepared.task.workspace }),
          onReport: (report) => reports.push(report),
        },
        context,
      );
      return new Host(
        harness,
        new Supervision(harness, options.model, extensions),
        prepared,
        lease,
        context,
        reports,
      );
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  static async openSqlite(options: HostSqliteOptions): Promise<Host> {
    const models = options.models ?? createDefaultModels();
    const model = options.model ?? resolveModelRef();
    const contract = readContractFile(options.contract_path);
    const storage = await openNodeSqliteStorage(options.db_path);
    return Host.open({
      storage,
      models,
      model,
      contract,
      db_path: options.db_path,
      context: options.context,
      ...(options.judge ? { judge: options.judge } : {}),
    });
  }

  async start(initialMessage?: string): Promise<StartReceipt> {
    return this.supervision.start({ prepared: this.prepared, initial_message: initialMessage }, this.context);
  }

  async send(content: string, requestId?: string): Promise<SendReceipt> {
    return this.supervision.send(content, this.context, requestId);
  }

  async inspect(): Promise<SupervisionStatus> {
    return this.supervision.inspect(this.context);
  }

  async waitForIdle(): Promise<void> {
    const conversation = await this.harness.conversation(ROOT_CONVERSATION_ID, this.context);
    if (!conversation) return;
    await conversation.waitForIdle(this.context);
  }

  async close(): Promise<void> {
    try {
      await this.harness.close(this.context);
    } finally {
      this.lease.release();
    }
  }

  static async status(dbPath: string, context: Context = BACKGROUND_CONTEXT): Promise<SupervisionStatus> {
    if (!existsSync(dbPath)) throw new Error(`pi-nf database does not exist: ${dbPath}`);
    const storage = await openNodeSqliteStorage(dbPath);
    const harness = await Harness.open(
      storage,
      {
        models: createModels(),
        registry: createRegistry(),
        readOnly: true,
      },
      context,
    );
    try {
      return await new Supervision(harness, { provider: "readonly", modelId: "readonly" }).inspect(context);
    } finally {
      await harness.close(context);
    }
  }
}
