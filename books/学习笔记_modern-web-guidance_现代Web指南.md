# 学习笔记：Modern Web Guidance（现代 Web 指南）

> 项目：`github.com/GoogleChrome/modern-web-guidance`（发布仓） / `GoogleChrome/modern-web-guidance-src`（源码仓）
> 版本：npm `modern-web-guidance@1.0.0`，2026-11-10 发布 1.0；发布仓 stars 16,773、源码仓 6,714（本次抓取时）
> 维护方：Google Chrome、Microsoft Edge、Mozilla Firefox、MDN 团队与社区
> 许可：代码 Apache-2.0，`guides/` 文档 CC-BY 4.0；部分内容源自 MDN / W3C / WHATWG / IETF
> 学习方法：GitHub API 抓 README / SKILL.md / 示例指南 + 官方文档检索 + **本机实跑 CLI**（Node 22.22.2、npm 10.9.7）
> 素材归档：`modern-web-guidance/`（两份 README、SKILL.md、两份指南样本、package.json）

---

## 一、一句话结论

**它不是前端规范文档，也不是框架，而是一套「喂给 AI 编程代理的、可检索的 Web 平台知识库 + 一个离线 CLI」**：把浏览器工程师审核过的现代写法、兼容性数据和降级方案，按需塞进代理的上下文窗口，纠正模型凭旧训练数据写出 2018 式代码的问题。

## 二、要解决什么

| 现象 | 根因 | 后果 |
|---|---|---|
| 让代理写弹窗，它掏出一堆 `div` + 绝对定位 + 滚动监听 | 训练语料里海量遗留代码 | 本该原生 HTML/CSS 解决的事写成臃肿 JS |
| 模型知道某个 API 存在，却写不出生产可用实现 | 缺少真实、密集的现代实现范式 | 无障碍、焦点管理、退出动画、降级全靠猜 |
| 不知道某特性现在能不能用 | 兼容性数据随浏览器版本变化 | 要么不敢用，要么直接用却没降级 |

三条产品原则（README 原文归纳）：优先平台级 API（自带无障碍与性能）、给轻量回退而不是重 polyfill、只保留经评测证明「模型本来不会」的内容（token-efficient，主动剪枝模型已知的建议）。

## 三、它由什么组成

| 层 | 内容 |
|---|---|
| 发布仓 | 265 个文件，`skills/` 下 234 个；两个 skill：`modern-web-guidance`（约 205 tokens）与 `chrome-extensions`（约 175 tokens） |
| 源码仓 | 2,400 个文件：`guides/` 1,676、`src/` 603、`features/` 20、`skills-src/` 25，另含评测流水线与仪表板 |
| CLI | npm 包 `modern-web-guidance`，`bin` 指向 `skills/modern-web-guidance/modern-web.mjs`，Node ≥ 22 |
| 指南库 | README 标注 **250 个 Web 特性**：CSS/布局 140、HTML/DOM 36、JS/API 74。发布仓 `guides/` 实有 **209 个 md**，按 17 类分（ui-behaviors 40、performance 26、ui-components 22、visual-design 22、forms 19、css 18、security 17…） |

> 数量口径：另有报道称「203 篇用例指南覆盖 250 个特性」。209 是我按发布仓 tree 统计的 md 文件数（含学科总览类），三者不矛盾，但引用时要说清是哪一口径。

六个核心领域：用户体验（View Transitions、进出场动画、滚动效果）、CSS 布局（容器查询、subgrid、oklch、text-wrap）、性能（预加载、INP、`scheduler.yield`）、表单与 UI（Anchor Positioning、Popover、`:user-invalid`、`field-sizing`）、无障碍、内置 AI（本地翻译/摘要/语言检测）。

## 四、工作流：代理怎么用

`SKILL.md` 把调用写成了强制流程，不是可选建议：

- **触发**：所有 HTML/CSS 与客户端 JS 任务「MANDATORY: Execute FIRST」；明确列出弹窗、暗色模式、容器查询、表单校验、CWV、passkeys、WebAssembly 等。
- **不触发**：后端（SQL/ORM/API 路由）、基础设施（CI/Docker/Python/Go/Git）、工具链杂活（Vite/tsconfig/测试/复制改名）。
- **Step 1 `search`**：2～5 个词的动作型查询，只描述用户可见能力，去掉框架名和业务名词（写 `light dismiss dialog`，不写 `close React settings modal on outside click`）；多特性任务拆成多次 search。返回 `[{id, description}]`。
- **Step 2 `retrieve`**：按 id 取全文，可逗号分隔多个 id；同时取一条学科总览（`html`/`css`/`forms`/`accessibility`/`performance`/`security`）。输出超过 9.5 KB 会落临时文件并要求完整读取。
- **Step 3 合规自检**：写完后回头核对指南里的现代模式、必要降级、约束，且不得强行塞入未要求的特性。
- **Step 4 披露**：交付回复末尾要写 `### Modern Web Guidance`，逐条说明用了哪个 id、避免了什么坑，并附指南原文短引；一条都没用也要写明查过什么、为什么没用。Skill 还特别禁止在上下文压缩后凭记忆编造 id 和引文。

⚠️ 明确写了一条容易混淆的边界：**`legacy-scan` 不属于常规开发流程**，只在用户要求「开放式整库现代化 / 遗留写法扫描」时才用。

## 五、CLI 命令全表（本机 `--help` 实测）

| 命令 | 作用 |
|---|---|
| `search <query>` | 按用例语义检索，返回 id + 描述 |
| `list` | 列出全部用例 |
| `retrieve <ids>` | 取一条或多条指南全文，逗号分隔 |
| `legacy-scan [path] --json` | 静态扫描遗留写法 |
| `install [--choose]` | 交互式安装向导；`--choose` 选 skill 包 |
| `uninstall` / `update` | 卸载 / 更新 |
| `set-allow-origin-trials` | 解锁 Origin Trial 实验特性指南 |
| `set-allow-volatile-features` | 解锁「近 3 个月单引擎 / 仍在稳定中」特性指南 |
| `--skill-version` / `-v` / `-h` | 内部版本标记 / 版本号 / 帮助 |

原理三步：代理因相关任务激活 skill → 本地语义检索（**离线 embedding + BM25，零依赖、无网络调用、无 API Key**）→ 取回指南注入上下文。npm 包自包含，`npx @latest` 只为防内容过期；检索本身完全本地且私密。

安装方式（除 `install` 向导外）：`npx skills add GoogleChrome/modern-web-guidance`、`gh skill install …`、Claude Code / Codex / Copilot CLI 的 `/plugin marketplace add GoogleChrome/modern-web-guidance`，以及 Antigravity、Grok Build、Kimi Code、Cursor、WebStorm、Gemini 扩展等。源码仓 README 还提示：Anthropic 内置的 `claude-plugins-official` 市场自 10-12 起停止更新第三方插件（停在 v0.0.194），要换到 `googlechrome` 市场才能拿到更新。

## 六、一份指南长什么样（实取 `animate-to-from-top-layer`）

不是「介绍某个 API」，而是可直接落地的工程文档，10.7 KB / 244 行：

| 段落 | 内容 |
|---|---|
| Implementation | 拆成 4 步：`transition-behavior: allow-discrete`、`overlay` 属性、`@starting-style` 进场、`::backdrop` 动画 |
| Example | 完整 CSS，含 `prefers-reduced-motion` 分支；`@starting-style` 必须放在 open 状态选择器之后 |
| Constraints & Accessibility | `MANDATORY` / `DO NOT` 清单：过渡列表必须含 `overlay`；`allow-discrete` **不能写进 `transition` 简写**（会让旧浏览器丢掉整条声明）；`@starting-style` 不能用于退场动画 |
| Fallback strategies | Baseline 状态 + 具体版本：`@starting-style` Newly available（2024-08-06，Chrome/Edge 117、FF 129、Safari 17.5）；`overlay` Limited availability（仅 Chrome/Edge 117，FF/Safari 不支持） |
| 坑 | 记录 **Firefox bug 1882408**：FF 129+ 的 `CSS.supports('transition-behavior','allow-discrete')` 返回 true 但实际不过渡 `display`，元素退场会瞬间消失；给出「探针元素 computed display 检测」代码 |

另一份 `navigation-drawer`（20.8 KB）同理：用顶层 `<dialog>` / `popover`、`scroll-snap` 两档 + 滚动驱动动画实现侧滑抽屉，附 4 组降级（无 `animation-timeline`、无 `scroll-initial-target`、无 `@property`、无 Popover API），每条都标 Baseline 日期。

**这就是项目真正的价值密度**：浏览器版本、已知引擎 bug、特性探测代码、无障碍约束、降级边界，模型训练语料里最缺的恰是这些。

## 七、兼容性策略（最值得学的设计）

- 默认目标 **Baseline Widely available**：广泛可用的特性直接用、不写降级；非广泛可用必须按指南给降级，除非用户声明自定义浏览器支持策略。
- 自定义策略建议写进 `AGENTS.md` / `CLAUDE.md`，例如「允许 Newly available，但降级代码 ≤20 行且无外部依赖」；判断规则是特性的 Baseline since 日期 ≤ 目标年份。
- 区分**纯增强**（如推测性预加载，旧浏览器静默忽略即可）与**关键行为**（对话框控制、网络信标，必须写低开销回退）。
- 降级优先「少于 50 行的定制实现」或按需加载的 polyfill，而不是重型第三方包。
- 实验性指南**门控**：Origin Trial 和 volatile 特性可以 `search` 到，但 `retrieve` 默认锁住；要显式跑 `set-allow-origin-trials` / `set-allow-volatile-features`，或在项目根 `.mwgrc`（也可用 `~/.mwgrc`）写 `"allowOriginTrials": true` / `"allowVolatileFeatures": true`，可提交进仓库与团队共享。

## 八、现代化流程（1.0 新增）

`legacy-scan` 四步：扫描 → 用每条发现的 `keepWhen` / `dropWhen` 判据排除误报（回退代码、跨文件 helper、vendor 代码、形似写法）→ 报告并明确说明只覆盖确定性规则子集 → 若要改，逐条 `retrieve` 后替换、重跑扫描确认。

**本机实测**：对一个含手写固定定位弹窗 + `window.addEventListener('scroll', …)` 的最小 HTML 跑 `legacy-scan . --json`，返回

```json
{"totalFindings": 0, "activeRuleCount": 35, "activeGuideCount": 33,
 "note": "No legacy patterns found across 33 guides (35 rules; ~20% of the guidance corpus)."}
```

结论：静态规则目前是 **35 条 / 33 篇指南，约占语料 20%**，且依赖确定性模式匹配；样例里明显的旧写法没命中，说明它不能替代人工或代理审计。官方也说明首个版本刻意收窄范围以保证结果可预测，后续才扩展「代理直接推理代码」的审计。

## 九、怎么证明有效（评测闭环）

| 环节 | 做法 |
|---|---|
| 任务 | 在完整示例应用（`daily-grind`、`devtools-times`）上给真实开发指令，故意不点名 API（如「让图片加载更快」） |
| 判分 | Playwright graders 查源码模式、计算样式、运行时 DOM 行为、无障碍状态 |
| 校准 | 金标准方案必须 100% 通过，未改动的基线应用必须 0% 通过；多代理（Claude/Codex/AGY）交叉校准 |
| 对比 | 同一任务跑 guided vs unguided；`opportunity = 100% - 无引导通过率`，`uplift = 有引导 - 无引导`；模型本来就会的建议**剪枝**，卡住的地方才改指南 |

README 快照（2026-11-08，约 215 个任务 / 1,800 条断言）：

| 代理 + 模型 | 无引导 → 有引导 | 提升 |
|---|---|---|
| claude_code (opus-5-5) | 57% → 88% | +31pp |
| codex_cli (gpt-6.1-sol) | 54% → 82% | +28pp |
| antigravity_cli (gemini-4-argon) | 58% → 94% | +36pp |

官方/合作方公布的生产案例（**属项目方自报，非独立验证**）：MetaMask 在开源扩展的每个 PR 上跑审查机器人，5 周约 480 个 PR、推动修复 43 项发现（多为无障碍与 HTML 语义）；note inc. 在 180 次生产代码库评测中从 61% → 94%；腾讯 WeTV 配合 Chrome DevTools for agents 自动解决 90% 失败的性能检查；Policybazaar / Pensionbazaar 页面交付从约 4 天缩到数小时。

## 十、1.0 的变化

- 从 Chrome 内部项目变成 Chrome/Edge/Firefox/MDN 共同维护的跨浏览器项目（早期预览在 2026 年 I/O，2026-11-10 发 1.0）。
- 新增现代化工作流（静态分析 HTML/CSS/JS/package.json + 引导代理改造）。
- 指南经更深的人工专家审核，各领域技术负责人签字，面向用户的指南另过无障碍评审。
- 公开评测仪表板（`googlechrome.github.io/modern-web-guidance-src/`）。
- 建议与 **Chrome DevTools for agents** 配对：前者负责「写之前给知识」，后者负责「跑起来验证」（性能 trace、动画录屏、内存泄漏、`prefers-reduced-motion`）。

## 十一、本机实测记录

| 项 | 结果 |
|---|---|
| Node / npm | v22.22.2 / 10.9.7（满足 `engines.node >= 22.0.0`） |
| `npx -y modern-web-guidance@latest search "animate a dialog modal backdrop"` | ✅ 返回 10 条 id + 描述，首条 `animate-to-from-top-layer`，另有 `light-dismiss-a-dialog`、`declarative-dialog-popover-control` 等 |
| `retrieve "animate-to-from-top-layer"` | ✅ 10.7 KB / 244 行，因超阈值写入临时 md 文件并要求完整读取（机制与 SKILL.md 一致） |
| `legacy-scan . --json` | ✅ 0 命中，自报 35 规则 / 33 指南 / 约 20% 语料 |
| `--help` | ✅ 命令全表见第五节 |

## 十二、边界与风险（确认 / 待验证分栏）

| 项 | 定性 |
|---|---|
| 检索完全离线、无 API Key，但 `npx @latest` 首次取包需联网 | ✅ README + 实测 |
| 遥测默认开启：采集安装计数、代理名、取用指南 id、CLI 查询词；不采原始用户 prompt | ✅ README 明确；`DISABLE_TELEMETRY=1` 可关 |
| 评测提升数据来自项目方与合作方自报 | ✅ 需按此口径引用，不是第三方独立验证 |
| `legacy-scan` 仅覆盖约 20% 语料、确定性规则 | ✅ 源码文档 + 实测 |
| 默认 Baseline Widely available，未必适合必须兼容老浏览器的项目 | ✅ 需自己在 `AGENTS.md` 声明策略 |
| 指南基于原生 HTML/CSS/JS，框架项目需适配（新属性要 spread/cast、SSR 守卫 `window`、`useId()` 生成 per-instance id 等） | ✅ SKILL.md |
| 中文资料多为二手转述，部分数字（如 stars、指南数）随时间变化 | ⚠️ 引用以官方仓库 README 为准 |
| 在 WorkBuddy / 其他代理里实际启用后对生成质量的影响 | 【需补充】本次仅学习与 CLI 实测，未安装到代理、未做 A/B 对比 |

## 十三、和我们自己场景的关联

- **AItab 新标签页（原生 JS/CSS + Go）**：完全在触发范围内（弹窗、暗色模式、滚动、表单、动画、无障碍）。建议先在前端目录跑 `legacy-scan <前端目录> --json` 看静态命中，再对具体改造点用 `search` + `retrieve` 取指南；Go 后端不在触发范围，不必挂。
- **WorkBuddy 生成的 HTML 页面 / 内联可视化**：若以后要写前端页面，可把「先 search 再写」作为固定前置动作；注意它给的是原生写法，别与现有框架约束冲突。
- **CI 与安全**：SKILL.md 建议权限白名单只放行 `npx -y modern-web-guidance@latest *`，不要放行裸 `npx *`；沙箱里可设 `NPM_CONFIG_CACHE` 或用 `npx --offline`；生产环境建议 `DISABLE_TELEMETRY=1`。
- **知识沉淀方式值得借鉴**：「专家写的短指南 + 兼容数据 + 可检索索引 + 自动评测剪枝」这套结构，和 `chai_pub` 把踩坑反哺进 skill 的做法是同一个思路，只是多了 Baseline 数据与 grader 闭环。

---

*学习时间：2026-11-15｜方法：GitHub API 抓取 + 官方文档检索 + 本机 CLI 实跑｜未安装到代理、未做生成质量 A/B 对比*
