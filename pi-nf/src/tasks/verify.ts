import type { JsonValue } from "@earendil-works/chord/json";
import { defineTask } from "@earendil-works/pi-durable";
import { NfContract, NfEvent, NfVerify } from "../docs.js";
import { runCompletionGate, type VerificationResult } from "../verify.js";

export type VerifyInput = {
  task_id: string;
  task_version: number;
  round_id: string;
  contract_sha256: string;
};

export type VerifyState = { phase: "run" };

export type VerifyOutcome = {
  passed: boolean;
  result: JsonValue;
};

export const verifyTask = defineTask<VerifyInput, VerifyState, VerifyOutcome, Record<string, never>>({
  name: "nf.verify",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task, runtime, context) => {
      const [contract, verifyDoc] = await Promise.all([
        runtime.snapshot(NfContract, runtime.conversationId, context),
        runtime.snapshot(NfVerify, runtime.conversationId, context),
      ]);
      if (!contract?.task || contract.status !== "ready") {
        throw new Error("nf.verify: task has no ready contract.");
      }
      if (contract.task.task_id !== task.input.task_id || contract.contract_sha256 !== task.input.contract_sha256) {
        throw new Error("nf.verify: stale task or contract identity.");
      }
      if (!contract.task.verify) {
        throw new Error("nf.verify: contract has no verifier.");
      }
      const env = await runtime.env(context);
      let result: VerificationResult | { error: string };
      try {
        if (!env) throw new Error("nf.verify: execution environment is unavailable.");
        result = await runCompletionGate({
          task: contract.task,
          baseline: verifyDoc?.baseline ?? [],
          state_path: verifyDoc?.state_path ?? null,
          env,
          context,
        });
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      const passed = "passed" in result ? result.passed : false;
      await runtime.commit(async (tx) => {
        const current = await tx.doc(NfVerify, runtime.conversationId);
        current.last_result = result as unknown as JsonValue;
        current.updated_at = new Date().toISOString();
        await tx.appendEntry(NfEvent, runtime.conversationId, {
          data: {
            type: "nf.verification",
            at: new Date().toISOString(),
            details: {
              round_id: task.input.round_id,
              passed,
              result: result as unknown as JsonValue,
            },
          },
        });
        return {
          status: "terminal",
          outcome: {
            status: "completed",
            result: { passed, result: result as unknown as JsonValue },
          },
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
