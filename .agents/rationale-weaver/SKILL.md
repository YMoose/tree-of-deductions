---
name: rationale-weaver
description: 补充、更新或修复 TreeOfDeductions 项目的 rationale 边（.treeofdeductions/rationale.json）——设计的"写侧"维护工具。当用户要求为指定文件补充/建立/更新/检查 rationale、建边、补依据、维护演绎树、修复行号漂移，或提到 rationale edges / tree of deductions / rationale.json 时，务必使用本 skill。Use for proposing and applying rationale-edge additions, updates, removals, and line-anchor drift repair against a .treeofdeductions store.
---

# rationale-weaver：演绎树边的维护

本项目（或目标项目）用 `.treeofdeductions/rationale.json` 存储设计→代码的 rationale 边；VS Code 扩展（tree-of-deductions）只负责**读取**这些边做导航。本 skill 是**写侧**：为用户指定的文件，在项目范围内提出并（经确认后）落盘边的增删改。

## 边的格式

```json
{
  "from": {"file": "docs/design.md", "lines": [11, 15]},
  "to":   {"file": "src/foo.ts", "lines": [40, 63]},
  "rationale": "……为什么 to 能从 from 推导出来……"
}
```

- `lines` 是 **1-based 闭区间** `[start, end]`（[start,end] 两行都含）。
- `file` 是相对项目根（即 `.treeofdeductions/` 的父目录）的路径，用 `/` 分隔。
- `from` 是**依据**（设计命题所在处，多为文档）；`to` 是**结论**（被推导出的设计或实现）。方向永远是 from → to：先有依据，后有结论。

store 可能在工作区的任意一层目录下；脚本会自动向上再向下查找。

## 工作流

按顺序执行。脚本调用中 `<skill>` 指本 skill 目录（含本 SKILL.md 的目录）。

### 1. 盘点

```bash
python3 <skill>/scripts/edges.py list --file <目标文件>
python3 <skill>/scripts/edges.py validate
```

- `list --file` 给出目标文件两侧已有的边（带 `index`，后续 update/remove 以此为准）。
- `validate` 报告 schema 错误和**漂移警告**（文件缺失、行号越界、重复边）——这些通常就是要修的对象。
- 然后读目标文件本身，以及候选 `from` 依据文件的相关段落。判断依据文件可优先看项目内 `*.md`（设计文档），也可看既有实现模式（见下方判据）。

### 2. 找候选设计单元

对目标文件（用户指定的那个；另一侧文件若未指定则由你从项目文档/既有边中寻找依据），找出"承载设计命题"的最小单元：

- `to` 侧：最小**完整**设计单元——一个函数/类型/配置块/一段文档，小到只陈述一件事，大到不把一件事劈成两半。
- `from` 侧：最小**承载该命题依据**的范围——通常是一段文档、一条既有边指向的设计、或一个体现既定模式的实现。

### 3. 用判据过滤（不达标就不建）

逐条对照，全部满足才建：

1. **因果可表述**——能写出"to 之所以如此，是因为 from"这样的完整句子，而非并列描述。
2. **推理是隐性的**——依据不在 to 自身的代码/文字里显式可见；一眼能看出的"显然实现"不需要边。
3. **设计层面**——解释的是为什么这样设计/实现，不是"这里有什么"（what）。
4. **预期长期成立**——临时状态、迁移期标记这类短期事实不建边，那属于 Git 历史。
5. **依据真实存在**——from 指向的文件里确实有那段命题。**若依据还不存在：先向用户提议补充设计文档，不要为了建边而虚构 from。**

另注意：

- **不做碎片化重复**——同一条 rationale 不要在多条边里复述；多个 to 共享同一依据时，各自建边但 rationale 聚焦各自的推导，不复读 from 的内容。
- **经验法则**：一位新工程师看到 to 会问"为什么这么做？"——如果答案在项目别处的文档里且当前看不到，就该有条边；如果答案就在 to 旁边或答案是"没为什么，显然"，就不该有。
- **按需渐进**——只为当前讨论/变更涉及的文件建边，不为覆盖率扫全项目。

### 4. 漂移检测与修复（更新既有边时必做）

对每条待更新的边：读出锚定范围当前的文字，与该边 rationale 陈述的命题比对。

- 范围内文字仍承载该命题，但位置移了 → 在同文件附近重新搜索该命题，更新 `lines` 重新锚定。
- 命题已不在文件中（被删/被重写）→ 如实标记"命题消失"，交用户决定删边还是改写，不要猜。

`validate` 的 `out-of-bounds` / `missing-file` 警告就是漂移的确定信号。

### 5. 提案（默认必须等确认）

把候选变更列成一张表，每组一行，列：**操作**（新增/更新/删除/仅修锚点）、**from**（`文件:起-止`）、**to**（`文件:起-止`）、**理由**（rationale 全文——这是用户审的核心内容，不要截断）。表后附：受影响边数、被你过滤掉的候选及原因（让用户能纠偏）。

**等用户明确同意后才进入第 6 步。** 例外：用户本轮已说"直接改/不用确认"类表述时可跳过确认。

### 6. 落盘

把变更写成 ops 文件再原子应用（任何一条 op 非法则整体不写入）：

```json
{"ops": [
  {"op": "add",    "edge":  {"from": {...}, "to": {...}, "rationale": "..."}},
  {"op": "update", "index": 3, "edge":  {"from": {...}, "to": {...}, "rationale": "..."}},
  {"op": "remove", "index": 7}
]}
```

```bash
python3 <skill>/scripts/edges.py apply /tmp/ops.json   # index 必须来自最近一次 list 的输出
python3 <skill>/scripts/edges.py validate              # 确认 0 schema 错误、警告已清
```

完成后向用户报告：store 路径、增/改/删条数、validate 结果。

## rationale 文本的写法

写成**完整的推理陈述**，不是关键词也不是状态描述。先看 store 里既有边的语言风格并沿用（本项目既有边是中文、"`to` 之所以如此，是因为 `from`……"式陈述）。内容可含：问题/需求、约束、考虑过的替代方案及取舍、决策及其后果。它记录的是**必需的工程推理**，不是思维链，不是 changelog。

## 边界

- **不执行任何 git 提交**（`git add`/`git commit`/`git push`）——store 与代码一起由用户自己提交。
- 不虚构 from 依据；依据缺失时先提议补文档。
- 不为覆盖率而建边；被判据过滤掉的候选要在提案里说明。
- 多个 store 存在时，选项目根包含目标文件的那一个；目标文件不在任何 store 范围内时，向用户提议是否新建 store，不擅自创建。
