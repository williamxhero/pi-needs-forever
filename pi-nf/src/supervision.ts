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
import { ContractPolicy } from "./contract.js";
import { NfContract, NfControl, NfEvent } from "./docs.js";
import type {
  ControlPhase,
  ControlStatus,
  PreparedContract,
  StartInput,
  StartReceipt,
  SupervisionStatus,
  TaskLimits,
} from "./types.js";
import { AlreadyStartedError, NotStartedError } from "./types.js";

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

export const NF_EXTENSIONS: readonly Extension[] = [CodingTools, NfPrompt];

export class Supervision {
  constructor(
    private readonly harness: Harness,
    private readonly model: ModelRef,
    private readonly contracts = new ContractPolicy(),
  ) {}

  async start(input: StartInput, context: Context = BACKGROUND_CONTEXT): Promise<StartReceipt> {
    const prepared = input.prepared;
    const existing = await this.harness.snapshot(NfContract, ROOT_CONVERSATION_ID, context);
    if (existing?.status === "ready") {
      throw new AlreadyStartedError(`task ${prepared.task.task_id} is already started.`);
    }
    const root = await this.harness.root(context, {
      agent: {
        model: this.model,
        cwd: prepared.task.workspace,
        extensions: NF_EXTENSIONS,
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
      control.last_decision = null;
      control.delivery = null;
      control.pause_reason = null;
      control.updated_at = at;

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

  async inspect(context: Context = BACKGROUND_CONTEXT): Promise<SupervisionStatus> {
    const [contract, control, inspection] = await Promise.all([
      this.harness.snapshot(NfContract, ROOT_CONVERSATION_ID, context),
      this.harness.snapshot(NfControl, ROOT_CONVERSATION_ID, context),
      this.harness.inspect(context),
    ]);
    if (!contract || contract.status !== "ready" || !contract.task) {
      throw new NotStartedError("pi-nf task has no ready contract.");
    }
    if (!control) throw new NotStartedError("pi-nf task has no control document.");
    return {
      task_id: contract.task.task_id,
      task_version: control.task_version,
      status: control.status as ControlStatus,
      phase: control.phase as ControlPhase,
      input_epoch: control.input_epoch,
      last_round: control.last_round_id ? { round_id: control.last_round_id } : null,
      last_decision: control.last_decision,
      evidence_count: 0,
      delivery: control.delivery,
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

  prepared(input: unknown): PreparedContract {
    return this.contracts.prepare(input);
  }
}
