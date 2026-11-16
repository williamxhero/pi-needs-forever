# SPEC 1 delivery record

- SPEC: https://github.com/williamxhero/pi-needs-forever/issues/1
- Parent: https://github.com/williamxhero/pi-needs-forever/issues/5
- Tickets: #6, #7, #8, #9, #10, #11
- Integration branch: `spec/1-durable-supervision`
- Implementation package: `pi-nf/`

## Scope delivered

The first durable pi-nf host is implemented on `@earendil-works/pi-durable`:

- contract validation, normalization, hashing and durable docs;
- single-writer lease with stale-owner recovery;
- root conversation A with coding tools and contract prompt;
- one `nf.judge` child task per answered run;
- evidence snapshot from real transcript/tool entries with a 24k budget and redaction;
- tool-free `ModelJudge` plus deterministic `FixtureJudge`;
- strict CONTINUE/DONE/WAIT_EXTERNAL validation;
- `nf.direction` delivery with deterministic request IDs and atomic decision/submission commits;
- human input epochs and stale-direction supersession;
- crash/reopen recovery at snapshot/judge/delivery;
- read-only `status`/JSON, one-shot `send`, SQLite storage, and package documentation.

Explicitly not implemented (SPEC 2–4): independent verifier/protected baseline, C2 route planning, pause/resume, cumulative limits, crash-loop interruption UI, and the web view. Contracts with `verify` are rejected; only `c2.mode = legacy` is accepted.

## Standards review

Fixed point: `main...spec/1-durable-supervision`. Standards sources found: `AGENTS.md` (write scope and GitHub body rules); no `CODING_STANDARDS.md` or `CONTRIBUTING.md`. The Fowler smell baseline was applied.

Findings fixed during review:

- CRLF/LF churn in edited files was removed; the final tree uses LF.
- `send` previously accepted input in `DONE`/`INTERRUPTED`/`PAUSED`; it now rejects `DONE` and requires an explicit resume for terminal states.
- The judge model could not be configured independently from A on the CLI; `--judge-model` and `HostSqliteOptions.judge_model`/`Host.openExisting` now support it.
- Invalid judge output previously left a dead `ACTIVE/IDLE` state; it now retries up to three times and ends `INTERRUPTED`.
- Snapshot budget/contract-size failures now commit an explicit `INTERRUPTED` state instead of faulting the task without a user-visible reason.
- Failed writable opens close their SQLite storage; dead options/exports were removed.
- `HostOptions.contract` was narrowed from `TaskContract | unknown` to `unknown`.

Judgement calls left as-is: the host/task modules are large but concentrated around one seam; `Host.readContract` and `Host.status` repeat a small read-only open; the local `NodeExecutionEnv` is cooperative, not an OS sandbox. These are documented boundaries, not hidden claims.

## Spec review

Every SPEC 1 acceptance area has a corresponding behavior and test:

| SPEC 1 area | Evidence |
|---|---|
| Contract validation/hash/verifier rejection/C2 legacy | `contract.test.ts` |
| Single-writer lease | `host.test.ts`, `crash.test.ts` |
| Start, conversation, system prompt, status | `host.test.ts` |
| Evidence mapping/claims/redaction/budget | `evidence.test.ts` |
| Decision validation/unknown IDs/WAIT/DONE rules | `judge.test.ts` |
| afterRun → nf.judge → decision audit | `supervision.test.ts` |
| CONTINUE direction/submission/request ID/WAIT/DONE | `delivery.test.ts` |
| Input epoch/supersession | `delivery.test.ts` |
| Model judge, retries, timeout, INTERRUPTED, usage | `model-judge.test.ts` |
| Crash/reopen at snapshot/judge/delivery | `crash.test.ts` |
| CLI status/JSON | `cli.test.ts` |
| End-to-end acceptance and example contract | `acceptance.test.ts` |

Test command and result:

```text
cd pi-nf
npm test
# 41 tests, 41 pass, 0 fail
```

The suite uses a faux worker/judge provider and real local verifier/tool subprocesses. It makes no live model claims. Crash tests spawn a real child host and kill it; they are local simulated-worker acceptance, not a live model acceptance.

## Delivery gates

- [x] Implementation and tests on the SPEC integration branch.
- [x] Standards and Spec review with fixes.
- [x] Integration branch merged into `main` (`40845ee`).
- [x] Temporary worktrees and merged branches removed.
- [x] `main` pushed; local and `origin/main` both resolve to `40845eea7f787d9a16986a74ad4723b827ad152a`.
- [x] Tickets #6–#11 closed with per-ticket delivery comments.
- [x] SPEC #1 closed after this record and the completion comment were read back.

## Process note

The installed `subagent` mechanism failed before starting any agent with:

```text
option '-p, --port <port>' argument '--no-session' is invalid
```

The implementation therefore used the main agent in isolated git worktrees, with manual ticket merges and a two-pass Standards/Spec review in the main context. This is a recorded deviation from the subagent-based `/implement-spec` mechanics; it is not reported as successful subagent execution.
