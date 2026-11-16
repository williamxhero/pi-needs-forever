import type { JsonValue } from "@earendil-works/chord/json";
import {
  GenerationTask,
  defineExtension,
  defineTask,
  hook,
  runEndTask,
} from "@earendil-works/pi-durable";
import type { EntryId, Extension, TaskId } from "@earendil-works/pi-durable";
import { NfContract, NfControl, NfDirection, NfEvent, NfRound, NfUsage, NfVerify, type DirectionData } from "../docs.js";
import { EvidenceBuilder, type EvidenceSnapshot } from "../evidence.js";
import type { ProtectedBaseline } from "../types.js";
import type { VerificationResult } from "../verify.js";
import { verifyTask, type VerifyOutcome } from "./verify.js";
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
  verify_configured: boolean;
};

export type JudgeState =
  | { phase: "snapshot" }
  | { phase: "judge"; snapshot: EvidenceSnapshot; attempt: number }
  | { phase: "verify"; snapshot: EvidenceSnapshot; decision: Decision; verifyTaskId: TaskId<VerifyOutcome> };

export type JudgeResult = {
  action: DecisionAction | null;
  interrupted?: boolean;
};

const MAX_JUDGE_OUTPUT_ATTEMPTS = 3;

export type SupervisionDependencies = {
  judge: Judge;
  evidence?: EvidenceBuilder;
};

const now = (): string => new Date().toISOString();

export function directionRequestId(taskId: string, taskVersion: number, roundId: string): string {
  return `nf:direction:${taskId}:${taskVersion}:${roundId}`;
}

function repairMessage(result: VerificationResult | { error: string }, baseline: readonly ProtectedBaseline[]): string {
  if ("error" in result) {
    return `Independent verification could not run: ${result.error}. Fix the verifier environment or protected baseline, then rerun the fixed command.`;
  }
  const changed = [...result.protected_before, ...result.protected_after];
  const originals = baseline
    .filter((file) => changed.some((entry) => entry.path === file.path))
    .map((file) => ({ path: file.path, content_base64: file.content_base64 }));
  const detail = {
    argv: result.argv,
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    stdout: result.stdout,
    stderr: result.stderr,
    protected_before: result.protected_before,
    protected_after: result.protected_after,
    workspace_changed: result.workspace_changed,
    original_protected: originals,
  };
  const text = `Independent verification failed. Repair the task and restore any changed protected files; keep the fixed argv unchanged, then rerun concise acceptance checks. Evidence: ${JSON.stringify(detail)}`;
  return text.length <= 3_000 ? text : `${text.slice(0, 2_700)}
See the persisted verification result for the complete evidence.`;
}

export function createSupervisionExtension(dependencies: SupervisionDependencies): Extension {
  const evidence = dependencies.evidence ?? new EvidenceBuilder();
  const judgeTask = defineTask<JudgeInput, JudgeState, JudgeResult, Record<string, never>>({
    name: "nf.judge",
    version: 2,
    initial: () => ({ phase: "snapshot" }),
    migrate(input, checkpoint, fromVersion) {
      if (
        fromVersion < 2 &&
        checkpoint &&
        typeof checkpoint === "object" &&
        !Array.isArray(checkpoint) &&
        (checkpoint as Record<string, unknown>).phase === "judge" &&
        !("attempt" in checkpoint)
      ) {
        return { input: input as JudgeInput, checkpoint: { ...checkpoint, attempt: 1 } as JudgeState };
      }
      return { input: input as JudgeInput, checkpoint: checkpoint as JudgeState };
    },
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
        let snapshot: EvidenceSnapshot;
        try {
          snapshot = await evidence.build({
            reader: runtime,
            conversationId: String(runtime.conversationId),
            task: contract.task,
            taskVersion: task.input.task_version,
            roundId: task.input.round_id,
            run: task.input.run,
            ...(control ? { control } : {}),
            context,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await runtime.commit(async (tx) => {
            const current = await tx.doc(NfControl, runtime.conversationId);
            const round = await tx.doc(NfRound, runtime.conversationId);
            current.status = "INTERRUPTED";
            current.phase = "IDLE";
            current.last_error = message;
            current.updated_at = now();
            round.round_id = task.input.round_id;
            round.run = task.input.run;
            round.status = "interrupted";
            round.evidence_count = 0;
            round.updated_at = now();
            await tx.appendEntry(NfEvent, runtime.conversationId, {
              data: {
                type: "nf.snapshot_failed",
                at: now(),
                details: { round_id: task.input.round_id, error: message },
              },
            });
            return {
              status: "terminal",
              outcome: { status: "completed", result: { action: null, interrupted: true } },
            };
          }, context);
          return;
        }
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
          const next: JudgeState = { phase: "judge", snapshot, attempt: 1 };
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
          const rejected = error instanceof JudgeOutputError;
          const checkpoint = task.state.checkpoint;
          const usage = dependencies.judge.lastUsage;
          const raw = dependencies.judge.lastRawOutput;
          if (rejected && checkpoint.attempt < MAX_JUDGE_OUTPUT_ATTEMPTS) {
            await runtime.commit(async (tx) => {
              const control = await tx.doc(NfControl, runtime.conversationId);
              const round = await tx.doc(NfRound, runtime.conversationId);
              control.phase = "JUDGE";
              control.last_error = message;
              control.updated_at = now();
              round.status = "open";
              round.updated_at = now();
              await tx.appendEntry(NfEvent, runtime.conversationId, {
                data: {
                  type: "nf.judge_retry",
                  at: now(),
                  details: {
                    round_id: task.input.round_id,
                    attempt: checkpoint.attempt,
                    next_attempt: checkpoint.attempt + 1,
                    error: message,
                  },
                },
              });
              return {
                status: "running",
                checkpoint: {
                  phase: "judge",
                  snapshot: checkpoint.snapshot,
                  attempt: checkpoint.attempt + 1,
                } satisfies JudgeState,
              };
            }, context);
            return;
          }
          await runtime.commit(async (tx) => {
            const control = await tx.doc(NfControl, runtime.conversationId);
            const round = await tx.doc(NfRound, runtime.conversationId);
            const usageDoc = await tx.doc(NfUsage, runtime.conversationId);
            if (usage) usageDoc.judge = { ...usage, updated_at: now() };
            control.status = "INTERRUPTED";
            control.phase = "IDLE";
            control.last_error = message;
            control.updated_at = now();
            round.status = "interrupted";
            round.updated_at = now();
            await tx.appendEntry(NfEvent, runtime.conversationId, {
              data: {
                type: rejected ? "nf.judge_rejected" : "nf.judge_interrupted",
                at: now(),
                details: {
                  round_id: task.input.round_id,
                  error: message,
                  raw_output: raw?.slice(0, 4_000) ?? null,
                  usage: usage ?? null,
                },
              },
            });
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result: { action: null, interrupted: true },
              },
            };
          }, context);
          return;
        }

        const checkpoint = task.state.checkpoint;
        const snapshotId = checkpoint.snapshot.snapshot_id;
        const usage = dependencies.judge.lastUsage;
        const raw = dependencies.judge.lastRawOutput;

        if (decision.action === "DONE" && task.input.verify_configured) {
          await runtime.commit(async (tx) => {
            const control = await tx.doc(NfControl, runtime.conversationId);
            const round = await tx.doc(NfRound, runtime.conversationId);
            const verifyDoc = await tx.doc(NfVerify, runtime.conversationId);
            const usageDoc = await tx.doc(NfUsage, runtime.conversationId);
            if (usage) usageDoc.judge = { ...usage, updated_at: now() };
            if (
              control.task_version !== task.input.task_version ||
              control.input_epoch !== task.input.input_epoch
            ) {
              round.status = "superseded";
              round.updated_at = now();
              control.phase = "IDLE";
              control.updated_at = now();
              await tx.appendEntry(NfEvent, runtime.conversationId, {
                data: {
                  type: "nf.round_superseded",
                  at: now(),
                  details: { round_id: task.input.round_id, phase: "before-verification" },
                },
              });
              return {
                status: "terminal",
                outcome: { status: "completed", result: { action: null, superseded: true } },
              };
            }
            if (!verifyDoc.baseline) {
              control.status = "INTERRUPTED";
              control.phase = "IDLE";
              control.last_error = "Verifier is configured but the protected baseline is missing.";
              control.updated_at = now();
              round.status = "interrupted";
              round.updated_at = now();
              await tx.appendEntry(NfEvent, runtime.conversationId, {
                data: {
                  type: "nf.verification_missing_baseline",
                  at: now(),
                  details: { round_id: task.input.round_id },
                },
              });
              return {
                status: "terminal",
                outcome: { status: "completed", result: { action: null, interrupted: true } },
              };
            }
            const verifyTaskId = await tx.createTask(
              verifyTask,
              {
                task_id: task.input.task_id,
                task_version: task.input.task_version,
                round_id: task.input.round_id,
                contract_sha256: task.input.contract_sha256,
              },
              { ownership: { kind: "task", taskId: runtime.taskId } },
            );
            control.status = "ACTIVE";
            control.phase = "VERIFY";
            control.delivery = null;
            control.last_decision = null;
            control.last_error = null;
            control.updated_at = now();
            round.status = "open";
            round.decision = null;
            round.updated_at = now();
            await tx.appendEntry(NfEvent, runtime.conversationId, {
              data: {
                type: "nf.judge_output",
                at: now(),
                details: {
                  round_id: task.input.round_id,
                  raw_output: raw?.slice(0, 4_000) ?? null,
                  usage: usage ?? null,
                },
              },
            });
            await tx.appendEntry(NfEvent, runtime.conversationId, {
              data: {
                type: "nf.verification_started",
                at: now(),
                details: {
                  round_id: task.input.round_id,
                  verify_task_id: String(verifyTaskId),
                  decision: decision as unknown as JsonValue,
                },
              },
            });
            const next: JudgeState = {
              phase: "verify",
              snapshot: checkpoint.snapshot,
              decision,
              verifyTaskId,
            };
            return {
              status: "waiting",
              checkpoint: next,
              on: [verifyTaskId],
              policy: "allSettled",
            };
          }, context);
          return;
        }

        const handle = decision.action === "CONTINUE"
          ? await runtime.conversation(runtime.conversationId, context)
          : undefined;
        if (decision.action === "CONTINUE" && !handle) {
          throw new Error("nf.judge: cannot create a direction submission without the root conversation.");
        }
        const requestId = directionRequestId(task.input.task_id, task.input.task_version, task.input.round_id);
        const direction: DirectionData = {
          schema_version: 1,
          round_id: task.input.round_id,
          task_id: task.input.task_id,
          task_version: task.input.task_version,
          contract_sha256: task.input.contract_sha256,
          snapshot_id: snapshotId,
          request_id: requestId,
          decision: decision as unknown as JsonValue,
          created_at: now(),
        };

        await runtime.commit(async (tx) => {
          const control = await tx.doc(NfControl, runtime.conversationId);
          const round = await tx.doc(NfRound, runtime.conversationId);
          const usageDoc = await tx.doc(NfUsage, runtime.conversationId);
          if (usage) usageDoc.judge = { ...usage, updated_at: now() };

          if (
            control.task_version !== task.input.task_version ||
            control.input_epoch !== task.input.input_epoch
          ) {
            round.status = "superseded";
            round.updated_at = now();
            control.phase = "IDLE";
            control.updated_at = now();
            await tx.appendEntry(NfEvent, runtime.conversationId, {
              data: {
                type: "nf.round_superseded",
                at: now(),
                details: {
                  round_id: task.input.round_id,
                  task_version: task.input.task_version,
                  input_epoch: task.input.input_epoch,
                  current_task_version: control.task_version,
                  current_input_epoch: control.input_epoch,
                },
              },
            });
            return {
              status: "terminal",
              outcome: { status: "completed", result: { action: null, superseded: true } },
            };
          }

          control.last_round_id = task.input.round_id;
          control.last_decision = decisionSummary(decision);
          control.last_error = null;
          control.updated_at = now();
          round.status = "decided";
          round.decision = decision as unknown as JsonValue;
          round.updated_at = now();

          if (decision.action === "CONTINUE") {
            const submissionId = await handle!.submit(tx, {
              type: "input",
              content: decision.next_message,
              entry: { kind: NfDirection.kind, data: direction },
              requestId,
            });
            control.delivery = {
              stage: "submitted",
              submission_id: String(submissionId),
              round_id: task.input.round_id,
            };
            control.status = "ACTIVE";
            control.phase = "WORKER";
          } else {
            control.delivery = null;
            control.status = decision.action === "DONE" ? "DONE" : "WAIT_EXTERNAL";
            control.phase = "IDLE";
          }

          await tx.appendEntry(NfEvent, runtime.conversationId, {
            data: {
              type: "nf.judge_output",
              at: now(),
              details: {
                round_id: task.input.round_id,
                raw_output: raw?.slice(0, 4_000) ?? null,
                usage: usage ?? null,
              },
            },
          });
          await tx.appendEntry(NfEvent, runtime.conversationId, {
            data: {
              type: "nf.decision",
              at: now(),
              details: {
                round_id: task.input.round_id,
                snapshot_id: snapshotId,
                decision: decision as unknown as JsonValue,
                delivery: control.delivery,
              },
            },
          });
          return {
            status: "terminal",
            outcome: { status: "completed", result: { action: decision.action } },
          };
        }, context);
      },
      verify: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const [outcome] = await runtime.outcomes([checkpoint.verifyTaskId], context);
        if (!outcome || outcome.status !== "completed") {
          await runtime.commit(async (tx) => {
            const control = await tx.doc(NfControl, runtime.conversationId);
            const round = await tx.doc(NfRound, runtime.conversationId);
            control.status = "INTERRUPTED";
            control.phase = "IDLE";
            control.last_error = "The verification task did not complete.";
            control.updated_at = now();
            round.status = "interrupted";
            round.updated_at = now();
            await tx.appendEntry(NfEvent, runtime.conversationId, {
              data: {
                type: "nf.verification_interrupted",
                at: now(),
                details: {
                  round_id: task.input.round_id,
                  status: outcome?.status ?? "missing",
                },
              },
            });
            return {
              status: "terminal",
              outcome: { status: "completed", result: { action: null, interrupted: true } },
            };
          }, context);
          return;
        }

        const verified = outcome.result as VerifyOutcome;
        if (verified.passed) {
          await runtime.commit(async (tx) => {
            const control = await tx.doc(NfControl, runtime.conversationId);
            const round = await tx.doc(NfRound, runtime.conversationId);
            if (
              control.task_version !== task.input.task_version ||
              control.input_epoch !== task.input.input_epoch ||
              control.status !== "ACTIVE"
            ) {
              round.status = "superseded";
              round.updated_at = now();
              control.phase = "IDLE";
              control.updated_at = now();
              await tx.appendEntry(NfEvent, runtime.conversationId, {
                data: {
                  type: "nf.round_superseded",
                  at: now(),
                  details: { round_id: task.input.round_id, phase: "after-verification" },
                },
              });
              return {
                status: "terminal",
                outcome: { status: "completed", result: { action: null, superseded: true } },
              };
            }
            control.last_round_id = task.input.round_id;
            control.last_decision = { action: "DONE", reason: "Independent verification passed." };
            control.last_error = null;
            control.status = "DONE";
            control.phase = "IDLE";
            control.delivery = null;
            control.updated_at = now();
            round.status = "decided";
            round.decision = checkpoint.decision as unknown as JsonValue;
            round.updated_at = now();
            await tx.appendEntry(NfEvent, runtime.conversationId, {
              data: {
                type: "nf.decision",
                at: now(),
                details: {
                  round_id: task.input.round_id,
                  snapshot_id: checkpoint.snapshot.snapshot_id,
                  decision: checkpoint.decision as unknown as JsonValue,
                  verification: verified.result,
                },
              },
            });
            return {
              status: "terminal",
              outcome: { status: "completed", result: { action: "DONE" } },
            };
          }, context);
          return;
        }

        const verifyDoc = await runtime.snapshot(NfVerify, runtime.conversationId, context);
        const result = verified.result as unknown as VerificationResult | { error: string };
        const repair = validateDecision(
          {
            action: "CONTINUE",
            reason: "Independent verification failed; repair the task and restore protected files.",
            evidence_ids: [],
            next_message: repairMessage(result, verifyDoc?.baseline ?? []),
            external: null,
          },
          checkpoint.snapshot,
        );
        const handle = await runtime.conversation(runtime.conversationId, context);
        if (!handle) throw new Error("nf.judge: cannot deliver a verification repair without the root conversation.");
        const requestId = directionRequestId(task.input.task_id, task.input.task_version, task.input.round_id);
        const direction: DirectionData = {
          schema_version: 1,
          round_id: task.input.round_id,
          task_id: task.input.task_id,
          task_version: task.input.task_version,
          contract_sha256: task.input.contract_sha256,
          snapshot_id: checkpoint.snapshot.snapshot_id,
          request_id: requestId,
          decision: repair as unknown as JsonValue,
          created_at: now(),
        };

        await runtime.commit(async (tx) => {
          const control = await tx.doc(NfControl, runtime.conversationId);
          const round = await tx.doc(NfRound, runtime.conversationId);
          if (
            control.task_version !== task.input.task_version ||
            control.input_epoch !== task.input.input_epoch
          ) {
            round.status = "superseded";
            round.updated_at = now();
            control.phase = "IDLE";
            control.updated_at = now();
            return {
              status: "terminal",
              outcome: { status: "completed", result: { action: null, superseded: true } },
            };
          }
          const submissionId = await handle.submit(tx, {
            type: "input",
            content: repair.next_message,
            entry: { kind: NfDirection.kind, data: direction },
            requestId,
          });
          control.last_round_id = task.input.round_id;
          control.last_decision = decisionSummary(repair);
          control.last_error = null;
          control.status = "ACTIVE";
          control.phase = "WORKER";
          control.delivery = {
            stage: "submitted",
            submission_id: String(submissionId),
            round_id: task.input.round_id,
          };
          control.updated_at = now();
          round.status = "decided";
          round.decision = repair as unknown as JsonValue;
          round.updated_at = now();
          await tx.appendEntry(NfEvent, runtime.conversationId, {
            data: {
              type: "nf.verification_failed",
              at: now(),
              details: {
                round_id: task.input.round_id,
                result: verified.result,
                decision: repair as unknown as JsonValue,
              },
            },
          });
          await tx.appendEntry(NfEvent, runtime.conversationId, {
            data: {
              type: "nf.decision",
              at: now(),
              details: {
                round_id: task.input.round_id,
                snapshot_id: checkpoint.snapshot.snapshot_id,
                decision: repair as unknown as JsonValue,
                delivery: control.delivery,
              },
            },
          });
          return {
            status: "terminal",
            outcome: { status: "completed", result: { action: "CONTINUE" } },
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
    tasks: [judgeTask, verifyTask],
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
                verify_configured: Boolean(contract.task.verify),
              }),
            ],
          };
        },
      }),
    ],
  });
}
