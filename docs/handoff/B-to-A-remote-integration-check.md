# B→A：远端集成现状核查（发现基线分叉）

日期：2026-09-22
核查者：B（OpenCode / abah）
远端：`https://github.com/abah661/-.git`

本文件是**事实核查记录**，不是需求声明。所有结论都附 git 命令与可复现输出。

---

## 一、推送结果（先确认已落地）

| 项 | 值 |
| --- | --- |
| 本地 HEAD | `16b186977e6b8d710c5cf136534cc8abfc494b5a` |
| `git ls-remote origin main` | `16b186977e6b8d710c5cf136534cc8abfc494b5a  refs/heads/main` |
| 是否一致 | ✅ 一致，推送真实生效 |

B 端 6 个提交已上 `main`：`5bc8048` → `8c72795` → `a98a47c` → `ec27bda` → `23be27d` → `16b1869`。

---

## 二、远端引用总览

```
$ git ls-remote origin
16b186977e6b8d710c5cf136534cc8abfc494b5a        HEAD
16b186977e6b8d710c5cf136534cc8abfc494b5a        refs/heads/main
67e72dafef9b1777eef3f3037191351fb3c2efa3        refs/heads/task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1
```

A 端的 4 个提交确实在远端，位于任务分支 `task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1`，**未合入 main**。

---

## 三、关键发现：两侧基线已分叉

```
$ git merge-base main refs/remotes/origin/task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1
a577d6688b323afbdbc647b3a1288c0316f7fb1e

$ git merge-base --is-ancestor main <A 分支>   # 退出码
1        # 即 NO —— main 不是 A 分支的祖先

$ git merge-base --is-ancestor <A 分支> main
1        # 也是 NO —— A 分支也不是 main 的祖先
```

### 3.1 共同祖先是冻结锚点，不是冻结记录

`a577d66` 正是《项目书》里的**冻结锚点**提交（当时 `status` 仍为 `draft`）。

冻结**动作**发生在锚点之后的 `00a1acf`，它修改了 `packages/protocol/src/version.ts`，写入：

```ts
status: "frozen",
frozenAt: "a577d6688b323afbdbc647b3a1288c0316f7fb1e",
frozenTreeSha: "f9644c44628d5fe8445bcbbb54ad336d7fbe0abc",
```

**A 的任务分支从 `a577d66` 长出，因此完全没有包含 `00a1acf` 及其后的冻结记录。**

### 3.2 协议版本文件在 A 分支上仍是 draft

```
$ git show <A 分支>:packages/protocol/src/version.ts | Select-String 'status:|frozenAt:|frozenTreeSha:'
status: "draft"
frozenAt: null
（无 frozenTreeSha 字段）

$ git show main:packages/protocol/src/version.ts | Select-String 'status:|frozenAt:|frozenTreeSha:'
status: "frozen"
frozenAt: "a577d6688b323afbdbc647b3a1288c0316f7fb1e"
frozenTreeSha: "f9644c44628d5fe8445bcbbb54ad336d7fbe0abc"
```

`git diff --stat a577d66 <A> -- packages/protocol` 输出为**空**——即 A 没有主动改协议，只是**沿用了冻结点之前的旧快照**。

### 3.3 A 端自己也知道协议未冻结

A 的 `docs/reports/P2-A-coordinator.md` 第 43 行原文：

> P2 A 端第一版代码已完成本地验证，尚未推送。协议远端 `PROTOCOL_META.status` 仍显示 `draft`，因此 P1 的冻结事实仍待 B 端确认和远端记录核实。

A 的 `README.md` 也写着：

> 在远端元数据真正为 `frozen` 前，不宜称协议已冻结。

---

## 四、两侧改动清单（相对共同祖先 `a577d66`）

### A 侧：33 个文件，+1746 / −33

新增：`apps/coordinator/**`（api/index/integration/project-do/storage/worker + wrangler.toml + tsconfig）、
`packages/codex-adapter/**`、`packages/integration/**`、`tools/cli/**`、
`tests/coordinator/**`、`tests/adapters/codex-adapter.test.ts`、
`.github/workflows/ci.yml`、三份 `docs/reports/P2-A-*.md` / `P3-A-*.md`。

### B 侧：38 个文件，+7179 / −21

新增：`apps/executor/**`（core 九个模块 + transport 三个文件 + adapters + result + index）、
`tests/executor/**`（7 个文件）、`tests/protocol/freeze.test.ts`、
`docs/handoff/**`、`docs/proposals/CP-0001-*.md`、`docs/protocol-v1-freeze-and-handoff.md`、
`docs/reports/P2-B-executor-core.md`，并修改了 `packages/protocol/src/version.ts`、
`tools/validate-protocol/src/validate.ts`、`tsconfig.json`、`docs/protocol-changes.md`、`README.md`、`.gitignore`。

### 结论：**无文件级冲突**

两侧文件集几乎不相交（A 动 `apps/coordinator`、`packages/codex-adapter`、`packages/integration`、`tools/cli`；B 动 `apps/executor`、`tests/executor`、`docs/handoff`、`docs/proposals`）。

唯一真正重叠的是 `packages/protocol/src/version.ts`、`README.md`、`tsconfig.json`、`docs/protocol-changes.md`、`package.json` / `package-lock.json`——且 `version.ts` 的差异**不是冲突，是 A 整侧落后**。

---

## 五、影响评估

| 影响项 | 说明 |
| --- | --- |
| 协议冻结校验 | A 分支上 `freeze.test.ts` 不存在（该文件是 B 新增），A 无法本地跑冻结校验 |
| 冻结守卫 | B 修过的 `validate-protocol` 自引用缺陷（`bbd57fd`）不在 A 分支上——A 若直接跑旧版校验会误报 |
| 协调器返回的协议元数据 | A 的 `project-do.ts` 会把 `PROTOCOL_META` 直接回给客户端；由于它是 `draft`，B 的客户端若做冻结断言会失败 |
| `package.json` / lock | 两侧都新增了 workspace 包，`package-lock.json` 冲突几乎必然，需以 main 为准重生成 |
| CI | A 新增 `.github/workflows/ci.yml`；B 未动 CI，但 B 的 `apps/executor` 需要被纳入 CI 构建矩阵 |

---

## 六、需要 A 决策的问题

**Q1（最重要）**：A 的 4 个提交，是**在 `a577d66` 上 rebase 到当前 main**，还是在任务分支上先 merge main、再合回 main？

依据 `AGENTS.md` 的目录归属（`apps/coordinator/**`、`packages/protocol/**`、`tools/validate-protocol/**`、`.github/workflows/**` 属 A），`version.ts` 与 `validate-protocol` 的最新内容以 main 为准。若 A rebase，这两个文件会自动取到 main 的冻结版本；若 A merge，需要留意 `version.ts` 的合并方向不能反向覆盖。

**Q2**：A 是否已知自己的分支基线是 `a577d66`（冻结点之前）？A 的报告里写"待 B 端确认和远端记录核实"，说明 A 预期 B 来推进冻结落地。**B 端这边冻结记录已经在 main 上（`00a1acf`、`bbd57fd`）**，A 只需 rebase/merge 即可获得。

**Q3**：`package-lock.json` 由哪一侧负责重新生成？建议 A 在 rebase 后于 main 侧统一 `npm install` 重生成，避免 merge 冲突残留。

**Q4**：A 的 `.github/workflows/ci.yml` 是否已包含 `apps/executor` 的 typecheck/test？若否，B 可以补一个 PR 或由 A 直接加。

---

## 七、B 端现在的状态

| 检查 | 结果 |
| --- | --- |
| `git status` | 干净，无未提交改动 |
| `tsc -b` | EXIT=0 |
| `vitest run` | **248/248 通过**（11 个文件） |
| `validate:protocol` | EXIT=0，5/5 样例 |
| 本地 HEAD vs `origin/main` | 完全一致 |

B 端**没有**在本次核查中修改任何项目文件——只做了只读分析。上表"B 侧改动清单"指的是历史提交的累计内容，不是本轮新增。

---

## 八、复现命令

```bash
git fetch --all --prune
git ls-remote origin
git merge-base main refs/remotes/origin/task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1
git merge-base --is-ancestor main refs/remotes/origin/task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1; echo $?
git diff --stat a577d66 refs/remotes/origin/task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1 -- packages/protocol
git show 'refs/remotes/origin/task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1:packages/protocol/src/version.ts'
```
