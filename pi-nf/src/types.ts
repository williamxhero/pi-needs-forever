import type { ModelRef } from "@earendil-works/pi-durable";

export type { ModelRef };

export type C2Mode = "enforce" | "shadow" | "legacy";

export type AcceptanceItem = {
  id: string;
  text: string;
};

export type VerifyConfig = {
  argv: string[];
  timeout_seconds: number;
  protected_files: string[];
};

export type TaskLimits = {
  max_worker_turns: number | null;
  max_minutes: number | null;
};

export type TaskContract = {
  schema_version: 1;
  task_id: string;
  workspace: string;
  goal: string;
  acceptance: AcceptanceItem[];
  authorization: string;
  c2?: { mode: C2Mode };
  verify?: VerifyConfig;
  limits: TaskLimits;
};

export type PreparedContract = {
  task: TaskContract;
  contract_sha256: string;
};

export type ControlStatus =
  | "ACTIVE"
  | "JUDGING"
  | "WAIT_EXTERNAL"
  | "PAUSED"
  | "DONE"
  | "INTERRUPTED";

export type ControlPhase =
  | "IDLE"
  | "WORKER"
  | "JUDGE"
  | "VERIFY"
  | "RECOVERING";

export type DeliveryState = {
  stage: "prepared" | "submitted" | "confirmed";
  submission_id?: string;
  direction_entry_id?: string;
  round_id: string;
};

export type DecisionSummary = {
  action: "CONTINUE" | "DONE" | "WAIT_EXTERNAL";
  reason: string;
};

export type ProtectedBaseline = {
  path: string;
  sha256: string;
  content_base64: string;
};

export type VerificationStatus = {
  configured: boolean;
  baseline_count: number;
  state: "not_configured" | "ready" | "passed" | "failed";
  last_result: unknown;
};

export type SupervisionStatus = {
  task_id: string;
  task_version: number;
  status: ControlStatus;
  phase: ControlPhase;
  input_epoch: number;
  last_round: { round_id: string } | null;
  last_decision: DecisionSummary | null;
  evidence_count: number;
  delivery: DeliveryState | null;
  last_error: string | null;
  judge_usage: {
    provider: string;
    model: string;
    input: number;
    output: number;
    cost: number;
    attempts: number;
  } | null;
  verification: VerificationStatus;
  route: {
    mode: string;
    selected_route_id: string | null;
    candidate_count: number;
    attempts: number;
    last_outcome: string | null;
  };
  limits: TaskLimits;
  task_graph: {
    tasks: { id: string; kind: string; status: string }[];
    submissions: { id: string; status: string; conversation_id: string }[];
  };
};

export type StartReceipt = {
  task_id: string;
  task_version: number;
  conversation_id: string;
  submission_id: string;
  status: ControlStatus;
};

export type StartInput = {
  prepared: PreparedContract;
  initial_message?: string;
};

export type SendReceipt = {
  submission_id: string;
  input_epoch: number;
  disposition: "started" | "queued";
};

export class ContractError extends Error {
  override name = "ContractError";
}

export class LeaseHeldError extends Error {
  override name = "LeaseHeldError";
}

export class AlreadyStartedError extends Error {
  override name = "AlreadyStartedError";
}

export class NotStartedError extends Error {
  override name = "NotStartedError";
}

export class TaskDoneError extends Error {
  override name = "TaskDoneError";
}

export class NotResumableError extends Error {
  override name = "NotResumableError";
}
