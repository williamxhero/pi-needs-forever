import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Extension,
  type Harness,
  ROOT_CONVERSATION_ID,
  type ModelRef,
  defineExtension,
  section,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NfContract, NfControl, NfEvent, NfRound, NfRoute, NfUsage, NfVerify } from "./docs.js";
import type {
  ControlPhase,
  ControlStatus,
  SendReceipt,
  StartInput,
  StartReceipt,
  SupervisionStatus,
  TaskLimits,
} from "./types.js";
import { AlreadyStartedError, NotResumableError, NotStartedError, TaskDoneError } from "./types.js";
import { recordProtectedBaseline } from "./verify.js";
import { discoverLocalRoutes } from "./routes.js";

export const START_REQUEST_PREFIX = "nf:start";

const DEFAULT_INITIAL_MESSAGE =
  "Begin the task now. Work through the acceptance items with real tools. Do not stop to ask whether to continue; gather evidence and keep going while authorized work remains.";

const NfPrompt = defineExtension({
  name: "nf-prompt",
  sections: [
    section("nf-contract", async (input, context) => {
      const contract = await input.read.snapshot(NfContract, input.conversationId, context);
      if (!contract || contract.status !== "ready" || !contract.task) return undefined;
      const task = contract.task;
      const acceptance = task.acceptance.map((item) => `- ${item.id}: ${item.text}`).join("\n");
      return [
        "You are worker A under the Needs Forever supervisor.",
        `Goal: ${task.goal}`,
        "Acceptance items:",
        acceptance,
        `Authorization: ${task.authorization}`,
        "Rules:",
        "- Keep working while authorized, verifiable work remains.",
        "- Do not stop merely to ask whether to continue.",
        "- A final claim is not evidence: use tools, run checks, and report concrete results.",
        "- The original goal, acceptance items and authorization outrank any later suggestion.",
      ].join("\n");
    }, { tag: false }),
  ],
});

export const NF_BASE_EXTENSIONS: readonly Extension[] = [CodingTools, NfPrompt];

export class Supervision {
  constructor(
    private readonly harness: Harness,
    private readonly model: ModelRef,
    private readonly extensions: readonly Extension[] = NF_BASE_EXTENSIONS,
    private readonly statePath: string | null = null,
  ) {}

  async start(input: StartInput, context: Context = BACKGROUND_CONTEXT): Promise<StartReceipt> {
    const prepared = input.prepared;
    const existing = await this.harness.snapshot(NfContract, ROOT_CONVERSATION_ID, context);
    if (existing?.status === "ready") {
      throw new AlreadyStartedError(`task ${prepared.task.task_id} is already started.`);
    }
    const baseline = recordProtectedBaseline(prepared.task);
    const catalog = discoverLocalRoutes(prepared.task.workspace);
    const root = await this.harness.root(context, {
      agent: {
        model: this.model,
        cwd: prepared.task.workspace,
        extensions: this.extensions,
      },
    });
    const at = new Date().toISOString();
    await root.commit(async (tx) => {
      const contract = await tx.doc(NfContract, root.id);
      contract.status = "ready";
      contract.task = prepared.task;
      contract.contract_sha256 = prepared.contract_sha256;
      contract.prepared_at = at;

      const control = await tx.doc(NfControl, root.id);
      control.status = "ACTIVE";
      control.phase = "WORKER";
      control.task_version = 1;
      control.input_epoch = 0;
      control.worker_turns = 0;
      control.active_seconds = 0;
      control.last_round_id = null;
      control.last_route_id = null;
      control.last_plan_id = null;
      control.last_decision = null;
      control.delivery = null;
      control.pause_reason = null;
      control.updated_at = at;

      const verify = await tx.doc(NfVerify, root.id);
      verify.baseline = baseline;
      verify.state_path = this.statePath;
      verify.last_result = null;
      verify.updated_at = at;

      const route = await tx.doc(NfRoute, root.id);
      route.catalog = catalog;
      route.ledger = [];
      route.execution = null;
      route.updated_at = at;

      await tx.appendEntry(NfEvent, root.id, {
        data: {
          type: "nf.start",
          at,
          details: {
            task_id: prepared.task.task_id,
            task_version: 1,
            contract_sha256: prepared.contract_sha256,
          },
        },
      });
    }, context);

    this.harness.resume();
    const submission = await root.submit(
      {
        type: "input",
        content: input.initial_message?.trim() || DEFAULT_INITIAL_MESSAGE,
        requestId: `${START_REQUEST_PREFIX}:${prepared.task.task_id}:1`,
      },
      context,
    );
    return {
      task_id: prepared.task.task_id,
      task_version: 1,
      conversation_id: String(root.id),
      submission_id: String(submission.id),
      status: "ACTIVE",
    };
  }

  async send(content: string, context: Context = BACKGROUND_CONTEXT, requestId?: string): Promise<SendReceipt> {
    if (!content.trim()) throw new Error("message must be nonempty.");
    const root = await this.harness.conversation(ROOT_CONVERSATION_ID, context);
    if (!root) throw new NotStartedError("pi-nf task has not started.");
    const result = await root.commit(async (tx) => {
      const control = await tx.doc(NfControl, root.id);
      if (control.status === "DONE") throw new TaskDoneError("DONE cannot accept new input.");
      if (control.status === "INTERRUPTED" || control.status === "PAUSED") {
        throw new NotResumableError(`${control.status} requires an explicit resume before new input.`);
      }
      control.input_epoch += 1;
      control.updated_at = new Date().toISOString();
      if (control.status === "WAIT_EXTERNAL") control.status = "ACTIVE";
      control.phase = "WORKER";
      const submissionId = await root.submit(tx, {
        type: "input",
        content,
        requestId: requestId ?? `nf:user:${control.task_version}:${control.input_epoch}:${randomUUID()}`,
      });
      return { submissionId, input_epoch: control.input_epoch };
    }, context);
    this.harness.resume();
    return {
      submission_id: String(result.submissionId),
      input_epoch: result.input_epoch,
      disposition: "started",
    };
  }

  async inspect(context: Context = BACKGROUND_CONTEXT): Promise<SupervisionStatus> {
    const [contract, control, round, usage, verifyDoc, routeDoc, inspection] = await Promise.all([
      this.harness.snapshot(NfContract, ROOT_CONVERSATION_ID, context),
      this.harness.snapshot(NfControl, ROOT_CONVERSATION_ID, context),
      this.harness.snapshot(NfRound, ROOT_CONVERSATION_ID, context),
      this.harness.snapshot(NfUsage, ROOT_CONVERSATION_ID, context),
      this.harness.snapshot(NfVerify, ROOT_CONVERSATION_ID, context),
      this.harness.snapshot(NfRoute, ROOT_CONVERSATION_ID, context),
      this.harness.inspect(context),
    ]);
    if (!contract || contract.status !== "ready" || !contract.task) {
      throw new NotStartedError("pi-nf task has no ready contract.");
    }
    if (!control) throw new NotStartedError("pi-nf task has no control document.");
    const configured = Boolean(contract.task.verify);
    const lastResult = (verifyDoc?.last_result ?? null) as { passed?: unknown } | null;
    const decisionPlan = (round?.decision as { route_plan?: { candidates?: unknown[] } } | null)?.route_plan;
    const candidates = Array.isArray(decisionPlan?.candidates) ? decisionPlan.candidates.length : 0;
    return {
      task_id: contract.task.task_id,
      task_version: control.task_version,
      status: control.status as ControlStatus,
      phase: control.phase as ControlPhase,
      input_epoch: control.input_epoch,
      last_round: control.last_round_id ? { round_id: control.last_round_id } : null,
      last_decision: control.last_decision,
      evidence_count: round?.evidence_count ?? 0,
      delivery: control.delivery,
      last_error: control.last_error,
      judge_usage: usage?.judge ?? null,
      verification: {
        configured,
        baseline_count: verifyDoc?.baseline?.length ?? 0,
        state: !configured
          ? "not_configured"
          : verifyDoc?.baseline === null || verifyDoc?.baseline === undefined
            ? "failed"
            : lastResult && typeof lastResult === "object" && "error" in lastResult
              ? "failed"
              : lastResult?.passed === true
                ? "passed"
                : lastResult?.passed === false
                  ? "failed"
                  : "ready",
        last_result: verifyDoc?.last_result ?? null,
      },
      route: {
        mode: contract.task.c2?.mode ?? "enforce",
        selected_route_id: control.last_route_id ?? routeDoc?.execution?.route_id ?? null,
        candidate_count: candidates,
        attempts: routeDoc?.ledger.length ?? 0,
        last_outcome: routeDoc?.ledger.at(-1)?.outcome ?? null,
      },
      limits: contract.task.limits as TaskLimits,
      task_graph: {
        tasks: inspection.tasks.map((task) => ({
          id: String(task.record.id),
          kind: task.record.kind,
          status: String(task.record.state.status),
        })),
        submissions: inspection.submissions.map((submission) => ({
          id: String(submission.id),
          status: submission.status,
          conversation_id: String(submission.conversationId),
        })),
      },
    };
  }
}
