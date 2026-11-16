# SPEC 2 delivery record

- SPEC: https://github.com/williamxhero/pi-needs-forever/issues/2
- Parent: https://github.com/williamxhero/pi-needs-forever/issues/5
- Tickets: #12, #13, #14, #15
- Integration branch: `spec/2-verification`
- Implements on top of SPEC 1 (`edc6fd8`).

## Scope delivered

- Contracts accept a valid `verify` configuration; invalid argv/timeout/protected-file shapes are rejected.
- Protected files are resolved inside the task workspace, hashed with SHA-256, and stored with original content before A's first run.
- `nf.verify` is a durable child task of `nf.judge`; it runs the fixed argv through the conversation's `ExecutionEnv` without a shell.
- The completion gate checks protected files before/after, a workspace digest before/after, timeout, exit code and output shape.
- C DONE with a verifier waits for `nf.verify`; only a pass commits DONE.
- A failed/timeout/workspace-changing gate becomes a repair CONTINUE with actual argv/exit/stdout/stderr, protected changes and original content.
- A missing baseline/partial configuration is an explicit failure, never a pass.
- `nf.verify` and `nf.judge` use task-version/input-epoch fences; stale results cannot set DONE or deliver a repair over newer input.
- `nf.judge` task version is 2 with a migration for SPEC 1 judge checkpoints.
- Status exposes verification configured/baseline count/state/last result; audit entries record `nf.verification`, `nf.verification_started`, `nf.verification_failed`, `nf.verification_interrupted`.

Not in this build: C2 route policy (SPEC 3), pause/resume, cumulative limits, web UI (SPEC 4). Limits remain stored but unenforced.

## Standards review

Fixed point: `main...spec/2-verification`. Standards sources found: `AGENTS.md`; no `CODING_STANDARDS.md`/`CONTRIBUTING.md`. Fowler baseline applied.

Findings fixed during review:

- `ExecutionEnv.exec` timeout is seconds, not milliseconds; the gate now passes the contract's seconds value directly.
- `nf.judge` task state changed shape; version bumped to 2 with a migration for SPEC 1 judge checkpoints.
- Verifier stdout/stderr are redacted and bounded before persistence/repair.
- `VerificationStatus` now maps an error-shaped verifier result to `failed`, not `ready`.
- DONE-with-verify clears the previous delivery/last decision while verifying, so status does not show a final DONE before the gate.
- Raw judge output/usage are recorded on the verify path as well as the non-verify path.
- Stale results are fenced in both the pass and repair commits.
- Removed the dead `VerifierUnsupportedError` and unused `HostSqliteOptions.evidence`.

Judgement calls: `nf.judge` remains a large task definition because its snapshot/judge/verify phases share one decision and delivery fence; splitting it would expose the same state to more modules. `NodeExecutionEnv` remains a cooperative boundary, not an OS sandbox.

## Spec review

| SPEC 2 area | Evidence |
|---|---|
| Verify contract shape/paths | `contract.test.ts`, `host.test.ts` |
| Baseline before A | `host.test.ts` |
| Fixed argv / no shell / timeout | `verify.test.ts` |
| Protected before/after | `verify.test.ts`, `verification.test.ts` |
| Workspace digest / concurrent change | `verify.test.ts` |
| DONE gate pass | `verification.test.ts` |
| Verifier fail → repair | `verification.test.ts` |
| Protected change → repair | `verification.test.ts` |
| No verifier path | SPEC 1 DONE tests |
| Crash during verification | `crash.test.ts` |
| Missing baseline | `verify.test.ts`, judge baseline check |
| Status/audit | `Supervision.inspect`, `NfVerify`, `nf.*` events |

Test command/result:

```text
cd pi-nf
npm test
# 54 tests, 54 pass, 0 fail
```

The suite uses faux worker/judge models and real local verifier subprocesses. It does not claim live model acceptance.

## Delivery gates

- [x] Implementation and tests on the SPEC integration branch.
- [x] Standards and Spec review with fixes.
- [ ] Integration branch merged into `main`.
- [ ] Temporary worktree and merged branches removed.
- [ ] `main` pushed and local/remote equality verified.
- [ ] Tickets and SPEC #2 closed with this record.

## Process note

The installed `subagent` mechanism still fails before starting any agent with:

```text
option '-p, --port <port>' argument '--no-session' is invalid
```

Implementation used the main agent in an isolated worktree and a manual two-pass review. This is a recorded deviation, not a claim of successful subagent execution.
