# SPEC 4 delivery record

- SPEC: https://github.com/williamxhero/pi-needs-forever/issues/4
- Parent: https://github.com/williamxhero/pi-needs-forever/issues/5
- Tickets: #19, #20, #21
- Integration branch: `spec/4-lifecycle`
- Implements on top of SPEC 3 (`28d7ea6`).

## Scope delivered

- Semantic lifecycle remains ACTIVE/JUDGING/WAIT_EXTERNAL/PAUSED/DONE/INTERRUPTED; phase is projected separately.
- `pause` commits PAUSED (including accumulated active time, task version bump, cleared delivery) before `root.abort`. Late judge results cannot overwrite PAUSED.
- `resume` is explicit for PAUSED/INTERRUPTED/WAIT_EXTERNAL: increments task and input epochs, preserves contract/artifacts/verifier baseline/counters, clears pending delivery, and submits a fresh resume input without replaying old directions. DONE cannot resume.
- `send` rejects PAUSED/INTERRUPTED/DONE; WAIT_EXTERNAL becomes ACTIVE.
- Cumulative `max_worker_turns`, `max_minutes`, `max_tokens` and `max_cost` are checked before a CONTINUE direction. A hit persists PAUSED/user_limit with a reason and does not deliver. Judge tokens/cost are tracked; worker A conversation usage is not yet included.
- `Host.markInterrupted` and `onReport` handle restart-limit/task-interrupted reports by persisting INTERRUPTED; explicit resume is required.
- CLI adds `pause`, `resume`, and `web`; status/JSON include status, phase, round, decision, verification, route, limits and usage.
- `web` is a local read-only HTTP projection of committed status (`/` and `/api/status`), opening SQLite read-only and never mutating or uploading task content.
- README documents lifecycle, limits, recovery, one-shot writer semantics, web, and remaining limitations.

Not fully delivered: provider authentication/quota-specific RECOVERING classification (judge transport failures currently become INTERRUPTED); limits are enforced for judge tokens/cost but not A conversation usage; the web page is a status projection, not full NFG; `pause`/`resume` CLI are one-shot writers and cannot control a concurrently running host.

## Standards review

Fixed point: `main...spec/4-lifecycle`. Standards sources: `AGENTS.md`; no `CODING_STANDARDS.md`/`CONTRIBUTING.md`. Fowler baseline applied.

Findings fixed during review:

- `TaskLimits` gained `max_tokens`/`max_cost` without forcing existing fixtures to change.
- `limits.max_tokens`/`max_cost` defaulted to null instead of rejecting omitted fields.
- Worker-turn counting was corrected: the current judged turn is counted before the limit comparison, so `max_worker_turns: 1` pauses instead of delivering a second round.
- Pause/limit paths record accumulated active seconds and clear pending delivery.
- Late judge catch paths check control status before writing INTERRUPTED; PAUSED wins.
- CLI `resume` waits for the resumed run/supervision to settle before closing, instead of aborting it immediately.
- `Host.markInterrupted` is idempotent for DONE/PAUSED/INTERRUPTED and used by the onReport restart-limit hook.

Judgement calls: lifecycle state lives in the control document with pi-durable owning task checkpoints; no second task state machine. `pause`/`resume` CLI are intentionally one-shot for this version.

## Spec review

| SPEC 4 area | Evidence |
|---|---|
| Pause ordering/late result | `lifecycle.test.ts` |
| Resume no replay/counters | `lifecycle.test.ts` |
| Input epoch | SPEC 1 `delivery.test.ts` |
| Turn limit | `lifecycle.test.ts` |
| Minute/token/cost limits | same limit path; turn tested, other fields share `limitReason` |
| INTERRUPTED explicit resume | `lifecycle.test.ts` |
| Restart-limit report hook | `Host.markInterrupted` + onReport path |
| Lease safety | SPEC 1/2 tests; stale reclaim |
| CLI status/JSON | `cli.test.ts` |
| Read-only web | `web.test.ts` |
| Packaging/docs | `pi-nf/README.md`, `examples/task.json` |

Test command/result:

```text
cd pi-nf
npm test
# 67 tests, 67 pass, 0 fail
```

The suite uses faux worker/judge models and real local verifier subprocesses. It does not claim live model acceptance.

## Delivery gates

- [x] Implementation and tests on the SPEC integration branch.
- [x] Standards and Spec review with fixes.
- [ ] Integration branch merged into `main`.
- [ ] Temporary worktree and merged branches removed.
- [ ] `main` pushed and local/remote equality verified.
- [ ] Tickets and SPEC #4 closed with this record.

## Process note

The installed `subagent` mechanism still fails before starting any agent with:

```text
option '-p, --port <port>' argument '--no-session' is invalid
```

Implementation used the main agent in an isolated worktree and a manual two-pass review. This is a recorded deviation, not a claim of successful subagent execution.
