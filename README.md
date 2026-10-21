# TreeOfDeductions

[演绎树(Tree of Deductions)](tree-of-deductions.md) 的实现项目。把项目建模为设计节点(文档)与代码节点(源码)构成的 DAG,节点之间用 **rationale 边**连接(边与 artifacts 分离存储)。

本仓库包含:

- `tree-of-deductions.md` — 设计文档,描述整个概念模型(rationale 边锚定的版本)
- `evidence-gated.md` — 前身概念文档(Evidence-Gated Development,英文)
- `.treeofdeductions/rationale.json` — rationale 边库,**知识库的一部分,随 Git 一起版本化**(设计文档与边的演化历史因此可追溯,见设计文档 §5)
- `src/` — VS Code 扩展实现

扩展提供对这些边的**只读反向导航**:在任意被边指向的位置上,像"函数查 references"一样查看"是谁、以什么理由指向了这里"。

## 功能

- **CodeLens 计数**:被边指向的行区间上方显示 `N rationale references`,单击打开 peek 引用列表(按文件分组、带预览)
- **Shift+F12 / 右键"查找引用"**:同一位置的原生引用体验,列出所有指向此处的依据(`from` 端)
- **悬停**:在指向区间内悬停,逐条显示 rationale 及其来源文件与行号
- **推演树**:活动栏两个视图——**Overview** 从无入边的根命题出发,沿 rationale 边逐级展开整条推演链(节点 → 边 → 派生节点):当前文档关联的条目蓝色高亮,光标所在区间的**完整推导路径**(从最上游根命题到该区间)绿色标出;**Current File** 把当前文档参与的边按 From(本文件作为依据)/ To(本文件作为结果)分组列出,光标所在的区间同步高亮。展开状态完全由用户控制,点击任意条目跳转对应位置,rationale 悬停可见

## rationale 边格式

边存放在项目的 `.treeofdeductions/rationale.json`(与设计文档一样是纳入 Git 的知识资产),一个 JSON 文档,`edges` 数组里一条边一个对象:

```json
{
  "edges": [
    {
      "from": { "file": "docs/architecture.md", "lines": [3, 15] },
      "to": { "file": "src/gateway.ts", "lines": [20, 30] },
      "rationale": "这段重试逻辑是可用性要求的落地"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `from` | 依据端:工作区相对路径 + `lines` |
| `to` | 被解释端:同上,导航以此为查询点 |
| `lines` | `[起始行, 结束行]`,**1-based、闭区间** |
| `rationale` | 为什么 `to` 由 `from` 推导而来 |

- 容错分级:单条边字段非法时跳过该边并在控制台(扩展宿主日志)报告 `edges[i]`,其余照常加载;整个文档 JSON 语法错误时保留上次已加载的边,避免编辑中途透镜全部消失
- 文件保存后自动重新加载,无需重启;也可执行命令 **TreeOfDeductions: Reload Rationale Edges** 手动重载
- `.treeofdeductions/rationale.json` 在工作区**任意层级**都会被自动发现(不管打开的是项目本身还是它的上级目录),`file` 路径相对于边文件所在的项目根目录(即 `.treeofdeductions` 的父目录)解析

## 何时建边(指导原则)

边库**按需渐进积累**,不要求一次性全量建模:当一处设计推理实际需要被记录时(有人问起"为什么"、或需要引用依据),再补一条边。这条纪律同时约束**人与 agent**:artifact 承载的是显性知识(结论与现状),而"为什么"是隐性知识,默认只存在于头脑中——边是把它外化的机制,谁持有这段推理,谁就在它被需要时负责落成一条边。目标不是覆盖所有代码,而是覆盖**设计意图的传导路径**——边太少导航失去意义,边太多噪音淹没信号。

建一条边,大致同时满足:

| 判据 | 说明 |
| --- | --- |
| 因果可表述 | 关系能写成"`to` 之所以如此,是因为 `from`" |
| 推理是隐性的 | 推理只存在于头脑中,不外化就会丢;命名自解释、语言惯用法不是隐性推理,不需要边 |
| 设计层面 | "用重试因为可用性要求"是;"用循环因为要遍历"不是 |
| 预期长期成立 | 跨多个变更仍然成立的知识传导;一次性实现细节不建 |
| 依据真实存在 | `from` 指向确实承载该命题的区间;依据还不存在时,先补设计文档再建边 |

下列情形明确**不建**:

- 显而易见的实现(getter、模板代码、语言惯例)
- 设计文档中没有对应命题的纯实现细节
- 回答"是什么"而非"为什么"——描述现状是 artifact 自身的职责(§3)
- 时序/过程信息(谁在何时改的)——那是 Git 的职责(§5)
- 同一推理的碎片化重复:一条边承载一个完整推理,不把一个章节切成多份贴到相邻代码上

**粒度**:`to` 取最小的完整设计单元(一个接口/函数/文档小节),`from` 取承载该命题的最小区间(精确到单行也可以)。

**经验法则**:新工程师指着 target 问"它为什么是这样"——如果答案需要读 target 之外的东西、且答案已存在于设计中,就该有一条边;否则不需要。

## 安装

从 [Releases](https://github.com/YMoose/tree-of-deductions/releases) 页面下载最新的 `.vsix` 文件,然后任选一种方式安装:

- VS Code 内:命令面板(F1)→ **Extensions: Install from VSIX…** → 选择下载的 `.vsix` 文件
- 命令行:

```bash
code --install-extension tree-of-deductions-<version>.vsix
```

## 开发

```bash
pnpm install
pnpm run watch   # 或 F5 直接调试
pnpm test
```

调试时打开 `tree-of-deductions.md` 即可看到效果——仓库自带一份对该文档自身建立的 rationale 链。
