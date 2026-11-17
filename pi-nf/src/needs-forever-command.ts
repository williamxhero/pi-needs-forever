import { createNeedsForever } from "./needs-forever.js";
import type {
  ContractGap,
  ContractPreview,
  HandoffReceipt,
  IssueRequest,
  NeedsForever,
  StartResult,
} from "./needs-forever.js";

export type ParsedNeedsForeverCommand = {
  mode: "help" | "preview" | "start" | "status";
  request: IssueRequest;
};

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
    `NFG visible: ${receipt.nfgVisible === undefined ? "unknown" : receipt.nfgVisible ? "yes" : "not yet"}`,
    `pid: ${receipt.pid ?? "-"}`,
  ].join("\n");
}

export function formatReceiptList(receipts: HandoffReceipt[]): string {
  if (!receipts.length) return "No handoff receipts yet.";
  const lines = receipts.map((receipt) => `- ${receipt.requestKey} · ${receipt.taskId} · ${receipt.status} · ${receipt.startedAt}`);
  return ["Handoff receipts", ...lines].join("\n");
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

export function parseNeedsForeverCommand(input: string): ParsedNeedsForeverCommand {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens[0] === "help") {
    return { mode: "help", request: { repo: "", issue: 0 } };
  }
  let mode: ParsedNeedsForeverCommand["mode"] = "preview";
  let index = 0;
  if (tokens[0] === "status") {
    mode = "status";
    index = 1;
  }
  const request: IssueRequest = { repo: "", issue: 0 };
  let issue: number | null = null;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const value = (): string => {
      const next = tokens[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${token} requires a value.`);
      index += 1;
      return next;
    };
    if (token === "--yes") {
      request.yes = true;
      if (mode === "preview") mode = "start";
    } else if (token === "--restart") {
      request.restart = true;
    } else if (token === "--dry-run") {
      mode = "preview";
    } else if (token === "--contract") {
      request.contractPath = value();
      if (mode === "preview") mode = "start";
    } else if (token === "--repo") {
      request.repo = value();
    } else if (token === "--workspace") {
      request.workspace = value();
    } else if (token.startsWith("--")) {
      throw new Error(`unknown option: ${token}`);
    } else if (/^\d+$/.test(token)) {
      if (issue !== null) throw new Error(`multiple issue numbers: ${issue} and ${token}`);
      issue = Number(token);
    }
    // Anything else is human prose such as "完成总需求"; it carries no meaning.
  }
  if (issue === null && mode !== "status") {
    throw new Error("an issue number is required, for example: /needs-forever 454");
  }
  request.issue = issue ?? 0;
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
            if (!request.issue) {
              ctx.ui.notify(formatReceiptList(await needs.list()), "info");
              return;
            }
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

