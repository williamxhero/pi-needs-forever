# pi-nf 深模块设计

状态：draft，用于指导 SPEC 1 的实现和后续 SPEC 的接口 seam。

相关：总 SPEC #5、子 SPEC #1–#4、`MIGRATION.md`。

可视化：[pi-nf 架构示意图](pi-nf-architecture.html)（小白版，HTML 单文件）。

## 1. 背景与约束

pi-nf 是构建在 `@earendil-works/pi-durable` 上的独立宿主，不是 Codex 插件，也不是 Pi coding-agent 的扩展。它的职责是把 Needs Forever 的监督策略放到 pi-durable 的持久化任务图上：

pi-nf 站在两个现成库上：**Pi** 提供 agent loop、messages/tools、prompt/context 和模型调用接口；**Provider** 是独立的模型基础设施层，包含 Models（CPA、OpenAI、OpenCode 等），由 Pi 和 Judge 调用，不属于 A/B/C/V；**Pi-Durable** 提供 Harness、conversation、task/checkpoint、docs、hooks、submission 和存储。pi-nf 只实现合同、证据、C、V、路线和生命周期，不重写这些层。

- 一个 SQLite `Harness` 对应一个受监督任务。
- worker A 是 root conversation，保留正常 coding tools。
- 每轮 run 回答后，`afterRun` 创建 `nf.judge` 任务。
- 裁判 C 是无工具的独立模型调用。
- 验收、C2 路线、生命周期分别由 `nf.verify`、`RoutePolicy` 和 `Supervision` 实现。

本设计使用 **codebase-design** 的词汇：module、interface、implementation、seam、adapter、depth、leverage、locality。这里按“调用方需要知道什么”来划分。

## 2. 唯一的外部 seam：`Supervision`

pi-nf 所有的业务操作都穿过同一个 interface。CLI、loopback、Web 只是这个 seam 外面的 adapter，不拥有状态、不判断 DONE、不操作 pi-durable 文档。

```text
CLI adapter ─┐
loopback ────┼──► Supervision (deep) ──► pi-durable Harness
Web adapter ─┘         │
                       ├─ ContractPolicy
                       ├─ Lifecycle
                       ├─ EvidenceBuilder
                       ├─ Judge (port) ── ModelJudge / FixtureJudge
                       ├─ RoutePolicy
                       └─ CompletionGate ── ExecutionEnv
```

```ts
interface Supervision {
  start(input: StartInput): Promise<StartReceipt>;
  send(input: UserInput): Promise<SendReceipt>;
  pause(reason: PauseReason): Promise<SupervisionStatus>;
  resume(input?: ResumeInput): Promise<SupervisionStatus>;
  inspect(): Promise<SupervisionStatus>;
}
```

`nf.judge`、`nf.verify`、`afterRun`、`nf.direction`、`nf.event` 都是 `Supervision` 的 implementation，不是外部 interface 的组成部分。调用方和测试只认 `Supervision`，不认 phase 名、文档结构或任务 ID 之外的内部标识。

### Interface contract

| 方法 | 调用方必须知道的事实 |
|---|---|
| `start` | 合同先校验、再落盘、再创建 A；初始输入提交后才返回。重复 `start` 同一任务必须失败。SPEC 1 中带 verifier 的合同显式失败，等待 SPEC 2。 |
| `send` | 人类输入通过此方法进入；`input_epoch` 与输入在同一 commit 中递增；返回 `started` / `queued` / `handled`。DONE 或不可恢复状态拒绝。 |
| `pause` | 先持久化 PAUSED，再取消 owned 任务；幂等；返回新的只读状态。迟到结果不能覆盖 PAUSED。 |
| `resume` | 显式恢复，递增 task version，保留合同、产物、受保护基线和累计计数。不重放旧方向；DONE 拒绝恢复。 |
| `inspect` | 只读、无副作用、无 `resume()`；返回 `SupervisionStatus` 读模型，不能用于修改状态。 |

`SupervisionStatus` 是一个数据读模型，不是一堆 setter。它至少包含：语义 status、phase、task version、input epoch、当前 round、最近 decision、最近 route、verification、limits、task graph 摘要。

## 3. 模块地图

| Module | Interface | 隐藏的 implementation | 测试 seam |
|---|---|---|---|
| `Supervision` | 5 个方法 | Harness 生命周期、afterRun 注册、`nf.judge`/`nf.verify` 任务图、submission、epoch、限额、恢复 | 主集成 seam |
| `ContractPolicy` | `prepare` | schema、路径、授权、hash、不可变约束 | 纯函数测试 |
| `Lifecycle` | `reduce` / `limits` | 状态迁移、epoch、PAUSED/INTERRUPTED、累计限额 | 纯 reducer 表测试 |
| `EvidenceBuilder` | `build` | entries→证据、工具结果映射、24k 预算、截断/省略、claim 与证据分离 | 内部 `EntrySource` seam |
| `Judge` | `decide` | 模型选择、prompt、JSON schema、证据 ID 校验、重试/退避、脱敏 | `decide` contract tests |
| `RoutePolicy` | `admit` / `capture` / `project` | catalog、ledger、路线准入、结果捕获、WAIT_EXTERNAL 门禁 | 纯 snapshot 测试 |
| `CompletionGate` | `check` | 保护基线、固定 argv、hash、workspace digest、修复方向 | 临时目录 + 真实子进程 |

### Interface 草图

```ts
interface ContractPolicy {
  prepare(input: TaskInput, workspace: string): PreparedContract;
}

interface Lifecycle {
  reduce(state: ControlState, event: LifecycleEvent): ControlState;
  limits(state: ControlState, usage: Usage): LimitDecision;
}

interface EvidenceBuilder {
  build(run: RunSummary, state: ControlState): Promise<EvidenceSnapshot>;
}

interface Judge {
  decide(snapshot: EvidenceSnapshot, signal?: AbortSignal): Promise<Decision>;
}

interface RoutePolicy {
  admit(
    decision: Decision,
    snapshot: EvidenceSnapshot,
    state: RouteState,
  ): AdmittedDecision;
  capture(
    previous: PreparedRoute | null,
    snapshot: EvidenceSnapshot,
    state: RouteState,
  ): RouteOutcome | null;
  project(
    snapshot: EvidenceSnapshot,
    state: RouteState,
  ): RouteContext;
}

interface CompletionGate {
  check(input: GateInput): Promise<GateResult>;
}
```

`Supervision` 的构造函数接受依赖，不自己创建：

```ts
new Supervision({
  harness,          // pi-durable Harness
  contractPolicy,
  lifecycle,
  evidenceBuilder,
  judge,
  routePolicy,
  completionGate,
})
```

`Storage`、`ExecutionEnv` 继续使用 pi-durable 自己的 interface；`Harness` 自带 clock。`Storage` 的 Memory/SQLite adapter 已经存在；`ExecutionEnv` 的 local/container adapter 也已经存在。pi-nf 不再包一层 repository。

## 4. 深度与删除测试（deletion test）

- **`Supervision`**：5 个方法的 interface，背后是完整任务图、hook 注册、submission、epoch、限额和恢复。删除它，hook、CLI、任务定义、测试都会重新知道 docs/submission/epoch，复杂度回到 N 个调用方。保留。
- **`ContractPolicy`**：一个 `prepare`，背后是校验、规范化、路径约束、hash 和不可变规则。删除它，每个入口都要重新校验合同。保留。
- **`Lifecycle`**：两个纯方法，背后是状态迁移和预算语义。删除它，status/limits/epoch 检查散落到 CLI 和 task。保留。
- **`EvidenceBuilder`**：一个 `build`，背后是 entries 到证据的映射、预算裁剪、省略收据、claim 与证据分离。删除它，每个 hook/test 都要重新拼 snapshot。保留。
- **`Judge`**：一个 `decide`，背后是模型、prompt、schema、证据校验、重试和脱敏。删除它，这些逻辑会散落到任务和测试。保留。
- **`RoutePolicy`**：三个方法，背后是 catalog、ledger、准入、结果捕获和 WAIT 门禁。删除它，路线规则会散落到 judge/delivery/tests。保留。
- **`CompletionGate`**：一个 `check`，背后是基线、固定 argv、前后 hash、workspace digest 和修复方向。删除它，验收逻辑会散落到 judge 和 CLI。保留。
- **`Host` adapters**：CLI/loopback/Web 是薄 adapter。删除它们，`Supervision` 仍然完整；它们不承担深度，只承担入口和展示。

## 5. Seam 与 adapter

### 真正的 seam（两个以上 adapter）

- **`Judge`**：`ModelJudge` 用于生产，`FixtureJudge` 用于测试。两者共享 `decide` 的 interface 和验证规则。
- **`ExecutionEnv`**：pi-durable 的 local/container adapter；`CompletionGate` 只依赖这个 interface，不依赖具体容器。
- **`Storage`**：pi-durable 的 Memory/SQLite adapter；`Supervision` 直接使用 `Harness`，不造仓库 port。
- **`Host`**：CLI、loopback、Web adapter，围绕 `Supervision`。

### Internal seam（不暴露到外部 interface）

- `EvidenceBuilder` 内部的 `EntrySource`：生产用 pi-durable entries，测试用 fixture entries。它只用于 `EvidenceBuilder` 的测试。
- `RoutePolicy` 内部的 catalog、ledger、execution：这些不是公开 module；它们是 `RoutePolicy` 的 implementation。现有 Needs Forever 的 `route-catalog`/`route-ledger`/`route-execution` 不应作为三个公开 interface 移植。
- `Supervision` 内部的 `nf.judge`/`nf.verify` task phases：pi-durable 已经拥有 checkpoint/retry；不要再包一个 `PhaseRunner`。

### 不要造的 seam（一个 adapter 只是 indirection）

- `NfRepository` 包住 pi-durable docs/entries：pass-through，删除测试会失败。
- `Clock`、`Logger`、`Notifier` 的 port：没有第二个 adapter；用 pi-durable 的 clock 和 append-only entries。
- `DeliveryLedger`：pi-durable submission 的 `requestId` 加 `nf.direction` entry 已经足够；再包一层会制造第二套状态。
- `StatusService` 的一堆 setter：一个 `inspect` 读模型即可。
- 每个 prompt 字段一个 builder module：一个内部 section 渲染函数即可。

## 6. 测试策略

**Interface 就是测试面。**

- 主集成测试穿过 `Supervision`：`start → send → pause/resume → inspect`，配 `FixtureJudge`、pi-durable `MemoryStorage`/SQLite 和临时 workspace。断言 docs、entries、submissions、status 和 task graph，不断言 `nf.judge` 的 phase 名。
- `Judge` 在自己的 `decide` interface 上做 contract tests：`ModelJudge` 用 faux provider，`FixtureJudge` 用脚本化 JSON；两者都验证未知 evidence ID、非法 action、缺失 evidence、超时/重试等行为。
- `RoutePolicy` 是纯 module：输入 snapshot/state fixture，输出 `AdmittedDecision`、`RouteOutcome`、`RouteContext`。不需要 pi-durable，也不需要模型。
- `CompletionGate` 在 `check` 上做红/绿测试：临时目录、真实本地子进程、真实 hash/digest；不 mock 退出码和文件系统。
- `EvidenceBuilder` 通过内部 `EntrySource` seam 测试：生产 adapter 用 MemoryStorage，测试 adapter 用 fixture entries；断言 24k 预算、省略收据、claim 不作为独立证据。
- `Lifecycle` 是纯 reducer：表驱动测试状态迁移、input epoch、limits 和 PAUSED/INTERRUPTED。
- `Supervision` 的 crash 测试：子进程在 snapshot/judge/delivery/verification 四个点被 kill，重开后断言没有重复 submission/verification。
- 旧的 Needs Forever 细粒度 module 测试（route-catalog、route-ledger、route-execution 的内部行为）在 `RoutePolicy` interface 测试覆盖后删除；不要保留测试内部实现细节的测试。

## 7. 从 Needs Forever 迁移的映射

| 来源 | 处理 |
|---|---|
| `judge` 的 decision schema、judge instructions、验证 | 保留语义，放进 `Judge` 的 implementation |
| `planning` / `route-*` / `route-observations` / `http-route-probe` | 收敛进 `RoutePolicy`；catalog/ledger 作为 internal seam |
| `completion-gate` 的 hash/protected/digest/continueWith | 保留语义，重写执行层为 `CompletionGate` |
| `snapshot` / `main-supervision` | 重写为 `EvidenceBuilder`，数据源改为 pi-durable entries |
| `recovery` 的 error classification/backoff | 放进 `Judge` 和 `Lifecycle` 的实现 |
| `recovery-episode` / `recovery-coordinator` / leases | 删除；pi-durable task resume + `restartLimit` 取代 |
| `supervisor` / `transport` / `main-session*` / `main-controller` / `codex-app-control-transport` | 删除；Codex app-server 专用 |
| `daemon` | 替换为 Host adapter + pi-durable Harness |
| `web` | 二期 Web adapter；从 committed docs/entries/task graph 渲染 |
| `runtime-packaging` | 删除；pi-nf 是 npm 包 |
| `redact` | 保留为内部函数 |

原则：迁移语义，不迁移模块形状。`State`、`pending_action`、`supervision_round`、`delivery ledger` 不需要 1:1 翻译；pi-durable 的 task/submission/docs 已经拥有这些职责。

## 8. 未定问题

- `Judge` 使用同一 provider 还是默认不同 provider：interface 不暴露，配置决定；实现上支持独立 model/provider。
- `ExecutionEnv` 的默认隔离级别：local `NodeExecutionEnv` 是协作约束，不是 OS sandbox；生产容器化是部署决策。
- Web 的首期范围：只读 round/decision/route/verification/task graph，还是包含完整 NFG 交互；先做只读。
- 多任务 catalog：当前一个 Harness 一个任务；多任务留到后续设计。
- Task definition migration：`nf.judge`/`nf.verify` 的 version 与 `migrate` 策略需要在 SPEC 4 前定稿。

## 9. 下一步

SPEC 1 的实现 ticket 应按以下顺序切，而不是按“每个文件一个 ticket”：

1. `ContractPolicy` + `Lifecycle` + `Supervision.start` 的合同/状态/lease 骨架。
2. `EvidenceBuilder` + `Judge`（fixture 优先，再接 `ModelJudge`）。
3. `afterRun` → `nf.judge` → `nf.direction` 的投递闭环。
4. crash/resume 测试和 `Supervision.inspect` 状态投影。
5. SPEC 2 的 `CompletionGate` 只通过 `Supervision`/`nf.verify` 接入，不改变外部 seam。

任何新 module 在加入前先过删除测试：如果删掉它复杂度会回到多个调用方，它才值得存在；否则它就是 pass-through。
