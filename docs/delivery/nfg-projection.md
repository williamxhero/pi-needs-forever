# NFG display projection

## Delivered

- `src/audit.ts` — `readAudit(dbPath)` opens the pi-durable SQLite database read-only and
  projects committed documents (`nf.contract`, `nf.control`, `nf.round`, `nf.verify`,
  `nf.usage`, `nf.route`) and entries (`nf.event`, `nf.direction`) into `NfAudit`.
  `writeAudit(dbPath, { root? })` writes it atomically to
  `<workspace>/.pi-nf/<task_id>/audit.json` (or `<root>/<task_id>/audit.json`).
- CLI:
  - `pi-nf audit --db <db> [--out <directory>] [--json]` rebuilds the projection.
  - `start`/`send`/`pause`/`resume` refresh it while they run (at most once per second,
    best effort) and once at the end. `--no-nfg` disables this and `--out` changes the root.
  - `status` and `web` remain read-only and never write the projection.
- `src/index.ts` exports `readAudit`, `writeAudit`, `auditDirectory` and the audit types.
- README documents the projection, its read-only nature and the NFG display contract.

## Semantics

- Authoritative state remains the SQLite database; the projection is derived state that
  pi-nf never reads back and a write failure never changes a command result.
- Rounds are grouped by `details.round_id` from committed events. The latest `nf.round`
  document fills decisions that are committed without `nf.decision` (a user-limit stop).
- Delivery evidence comes from the durable submission: `placed`/`done` means A received the
  direction; `queued` or a missing submission stays undelivered. The audit never invents a
  delivery confirmation.
- Errors (`nf.judge_retry`, `nf.judge_rejected`, `nf.judge_interrupted`, `nf.snapshot_failed`,
  `nf.verification_*`, `nf.round_superseded`) are preserved on the round for the display.

## Verification

- `npm test`: 70/70 pass (`test/audit.test.ts` adds DONE, CONTINUE/limit, and atomic write
  coverage; each case reads a real SQLite database populated by the host).
- End-to-end: a real pi-nf task with faux worker/judge published the projection; NFG (in
  `needs-forever`) listed it, rendered both rounds with the C2 route audit, and returned
  409 for pause. The temporary workspace was removed.

## Limits

- The projection contains the contract goal, acceptance items, decisions and direction
  messages; it is written inside the task workspace for a local-only display.
- A running host refreshes it only while a CLI writer process is alive. A crashed writer
  leaves the last committed projection; `pi-nf audit` refreshes it.
- NFG does not control pi-nf tasks; pause/resume/delete need the writer lease and the CLI.
