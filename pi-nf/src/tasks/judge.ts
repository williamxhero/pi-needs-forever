import type { JsonValue } from "@earendil-works/chord/json";
import {
  GenerationTask,
  defineExtension,
  defineTask,
  hook,
  runEndTask,
} from "@earendil-works/pi-durable";
import type { EntryId, Extension } from "@earendil-works/pi-durable";
import { NfContract, NfControl, NfEvent, NfRound } from "../docs.js";
import { EvidenceBuilder, type EvidenceSnapshot } from "../evidence.js";
import {
  type Decision,
  type DecisionAction,
  type Judge,
  JudgeOutputError,
  decisionSummary,
  validateDecision,
} from "../judge.js";

export type JudgeInput = {
  task_id: string;
  task_version: number;
  round_id: string;
  run: { first: EntryId; answer: EntryId; last: EntryId };
  input_epoch: number;
  contract_sha256: string;
};

export type JudgeState =
  | { phase: "snapshot" }
  | { phase: "judge"; snapshot: EvidenceSnapshot };

export type JudgeResult = {
  action: DecisionAction | null;
  rejected?: boolean;
};

export type SupervisionDependencies = {
  judge: Judge;
  evidence?: EvidenceBuilder;
};

const now = (): string => new Date().toISOString();

function rejectionResult(): JudgeResult {
  return { action: null, rejected: true };
}

export function createSupervisionExtension(dependencies: SupervisionDependencies): Extension {
  const evidence = dependencies.evidence ?? new EvidenceBuilder();
  const judgeTask = defineTask<JudgeInput, JudgeState, JudgeResult, Record<string, never>>({
    name: "nf.judge",
    version: 1,
    initial: () => ({ phase: "snapshot" }),
    phases: {
      snapshot: async (task, runtime, context) => {
        const [contract, control] = await Promise.all([
          runtime.snapshot(NfContract, runtime.conversationId, context),
          runtime.snapshot(NfControl, runtime.conversationId, context),
        ]);
        if (!contract || contract.status !== "ready" || !contract.task) {
          throw new Error("nf.judge: task has no ready contract.");
        }
        if (contract.task.task_id !== task.input.task_id || contract.contract_sha256 !== task.input.contract_sha256) {
          throw new Error("nf.judge: stale task or contract identity.");
        }
        const snapshot = await evidence.build({
          reader: runtime,
          conversationId: String(runtime.conversationId),
          task: contract.task,
          taskVersion: task.input.task_version,
          roundId: task.input.round_id,
          run: task.input.run,
          ...(control ? { control } : {}),
          context,
        });
        await runtime.commit(async (tx) => {
          const round = await tx.doc(NfRound, runtime.conversationId);
          round.round_id = task.input.round_id;
          round.run = task.input.run;
          round.status = "open";
          round.decision = null;
          round.snapshot_id = snapshot.snapshot_id;
          round.evidence_count = snapshot.evidence.length;
          round.created_at = now();
          round.updated_at = now();
          await tx.appendEntry(NfEvent, runtime.conversationId, {
            data: {
              type: "nf.judge_started",
              at: now(),
              details: {
                round_id: task.input.round_id,
                snapshot_id: snapshot.snapshot_id,
                evidence_count: snapshot.evidence.length,
                evidence_complete: snapshot.evidence_complete,
              },
            },
          });
          const next: JudgeState = { phase: "judge", snapshot };
          return { status: "running", checkpoint: next };
        }, context);
      },
      judge: async (task, runtime, context) => {
        let decision: Decision;
        try {
          const checkpoint = task.state.checkpoint;
          decision = validateDecision(await dependencies.judge.decide(checkpoint.snapshot, runtime.signal), checkpoint.snapshot);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await runtime.commit(async (tx) => {
            const control = await tx.doc(NfControl, runtime.conversationId);
            const round = await tx.doc(NfRound, runtime.conversationId);
            control.status = "ACTIVE";
            control.phase = "IDLE";
            control.last_error = message;
            control.updated_at = now();
            round.status = "interrupted";
            round.updated_at = now();
            await tx.appendEntry(NfEvent, runtime.conversationId, {
              data: {
                type: "nf.judge_rejected",
                at: now(),
                details: { round_id: task.input.round_id, error: message },
              },
            });
            return {
              status: "terminal",
              outcome: { status: "completed", result: rejectionResult() },
            };
          }, context);
          return;
        }

        await runtime.commit(async (tx) => {
          const control = await tx.doc(NfControl, runtime.conversationId);
          const round = await tx.doc(NfRound, runtime.conversationId);
          control.last_round_id = task.input.round_id;
          control.last_decision = decisionSummary(decision);
          control.last_error = null;
          control.phase = "IDLE";
          control.status =
            decision.action === "DONE" ? "DONE" : decision.action === "WAIT_EXTERNAL" ? "WAIT_EXTERNAL" : "ACTIVE";
          control.updated_at = now();
          round.status = "decided";
          round.decision = decision as unknown as JsonValue;
          round.updated_at = now();
          await tx.appendEntry(NfEvent, runtime.conversationId, {
            data: {
              type: "nf.decision",
              at: now(),
              details: {
                round_id: task.input.round_id,
                snapshot_id: task.state.checkpoint.snapshot.snapshot_id,
                decision: decision as unknown as JsonValue,
              },
            },
          });
          return {
            status: "terminal",
            outcome: { status: "completed", result: { action: decision.action } },
          };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });

  return defineExtension({
    name: "nf-supervision",
    tasks: [judgeTask],
    hooks: [
      hook(GenerationTask, {
        afterRun: async (run, api, context) => {
          const [contract, control] = await Promise.all([
            api.snapshot(NfContract, api.conversationId, context),
            api.snapshot(NfControl, api.conversationId, context),
          ]);
          if (!contract?.task || contract.status !== "ready") return undefined;
          if (!control || control.status !== "ACTIVE") return undefined;
          return {
            tasks: [
              runEndTask(judgeTask, {
                task_id: contract.task.task_id,
                task_version: control.task_version,
                round_id: String(run.answer),
                run: {
                  first: run.first,
                  answer: run.answer,
                  last: run.last,
                },
                input_epoch: control.input_epoch,
                contract_sha256: contract.contract_sha256,
              }),
            ],
          };
        },
      }),
    ],
  });
}
