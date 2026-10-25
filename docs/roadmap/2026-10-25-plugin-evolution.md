# 插件演进路线分析（2026-10-25）

> 前置决策：常驻听写模式已放弃，理由与复活条件见 [ADR-0002](../decisions/0002-drop-always-on-dictation.md)。
> 本文只回答两个问题：**还剩哪些方向值得做**，以及**按什么顺序做、每步用什么验证**。

## 0. 基线事实

本节的每一条都在 2026-10-25 被重新核过；标 **[实测]** 的是本机或本仓库代码实测，**[文档]** 的是有来源的公开文档。

| 事实 | 证据 |
|---|---|
| 插件已安装并启用（0.8.1） | [实测] `~/.dsh/profiles/desktop/package.json` 依赖与 `dsh.profile.bundles` 均含 `@hrygo/dsh-speechrail-bundle` |
| 本机 SpeechRail 活着且要求鉴权 | [实测] `127.0.0.1:8201` LISTEN（python）；零推理探测（不带凭据 GET capabilities）返回 `401` + 完整错误信封 `invalid_api_key` |
| 凭据引用存在 | [实测] `~/.dsh/.credentials.yaml` 的 `refs` 含 `SPEECHRAIL_API_KEY`（只读名字，未读值） |
| 门禁干净 | [实测] `~/.dsh/storages/speechrail_input_pending.json` 为空 |
| 无席位竞争 | [实测] profile 内没有官方语音 bundle |
| **用户从未使用过本插件** | 用户陈述（2026-10-25） |
| composer 有程序化提交入口 | [实测] `InputActions` 含 `captureInsertion()` / `insertText()` / `setDraft()` / `submit()`（`dsh-client-ui-conversation/lib/types/client/contract/input.d.ts`） |
| 客户端有官方快捷键服务 | [文档] `@deepseek-ai/dsh-client-shortcuts@0.2.1-rc.3` 提供 `ctx.shortcuts`：`register` / `registerFixed` / `describeBinding` / `catalog` / `edit`（包描述："Application keyboard command registry and physical-key routing"）。注：`cordis_inspect` 的 client Service 目录未列出它，但该目录同样未列出 `remote` 与 `conversation`，**目录不完整，不能据此判定不可用** |
| 凭据缺失即无法工作 | [实测] `resolveCredential` 把空值与解析失败都当 null（`service.ts:140-149`）；`check()` 与 `run()` 均以 `not-configured` 拒绝（`core.ts:396`、`core.ts:580`） |
| 端点路径必须恰为 `/v1` | [实测] `endpoint.ts` 的 `normalizeEndpoint`，拒绝原因含 `wrong-path` |
| 席位占用没有任何处理 | [实测] `mount.ts` 只做 `ctx.slots.register`，无占用检查、无外来占用时撤回；设计文档 §4 曾承诺该机制，README 未承诺。**设计文档与实现不一致** |
| 客户端 mount/withdraw 无自动化测试 | [文档] README "Known limitations" 与设计文档审查记录 |
| VAD 相关事实（供未来复用） | [文档] 浏览器端只有 Silero VAD 站得住（约 2.24 MB + ONNX Runtime Web）；普通 `getUserMedia` 轨道不豁免标签页节流；麦克风权限可能是"仅此一次" |

## 1. 方向深度分析

### A. 触发方式：热键（自用向）

**问题。** 行业里"低摩擦语音输入"的主流答案只有一个：热键或按住说话——Wispr Flow 是 Fn+Space（[docs](https://docs.wisprflow.ai/articles/6391241694-use-flow-hands-free)），superwhisper、Aqua Voice、MacWhisper 都是快捷键或按住说（[superwhisper](https://superwhisper.com/docs/modes/switching-modes)、[Aqua](https://aquavoice.com/use-cases/cursor)、[MacWhisper](https://docs.macwhisper.com/article/14-how-to-use-the-dictation-feature)）；调研里**没有一家把"常开麦克风"当默认**。本插件今天只有鼠标点击，而且 `start()` 之前还有一次状态检查往返（`VoiceInput.tsx` 的 `checking → requesting → recording`）。

**价值。** 把"移动鼠标→点麦克风→说→点停止"塌缩成一次动作。这是本插件唯一还没试过、且行业一致认可的"自用"改动。

**可行性（已定）。** 走正门：`ctx.shortcuts.register({ id, label, defaults, regions, modals, resolve })`，注册出来的命令**用户可改键、有冲突检查**（`describeBinding` 返回 `conflicts`），并出现在 Harness 的快捷键设置里。代价是包清单要加 peer 依赖与 `dsh.client.inject`。相比自己挂 `window` keydown（本仓库已有先例：`VoiceInput.tsx:173` 的 Escape），这是可升级、可仲裁的路径。

**未定项。** `ShortcutGesture` / `ShortcutFixedInput` 只有 `keydown` 与 `reset`，**没有 keyup**，所以"按住说话"能不能表达需要先验证；默认方案是**切换式**（按一下开始、再按一下停止，Escape 仍可取消）。

**证伪实验。** Stage 0：先真用一次。若障碍是"不信它听得准"或"延迟难受"，热键无效，应改走 B。

**成本。** 小。一个命令 id、一个双语 label、三个 profile 的默认键、一个把 `start`/`cancel` 暴露给非 React 调用者的触发器；外加冲突检查与"无会话时 blocked"。

### B. 引擎兼容面与首次成功（他人门槛向）

**问题（实测 + 文档）。** README 说"任何回环 OpenAI 兼容引擎都可以"，实际有三层阻塞：

1. **凭据是硬性前置**：引用解析不出非空值，`check()` 与 `transcribe()` 都直接 `not-configured`。**无鉴权的本机引擎也用不了**，除非用户先造一个假凭据引用。
2. **`model` 字段**：今天默认空、空则不发（`config.ts`：`model: z.string().default('')`）。而 speaches、vLLM、LocalAI、mlx-audio、coro-asr 等**要求**该字段，缺失即 422/404。这一条按引擎数算解锁最多。
3. **路径形状**：端点必须恰为 `/v1`；whisper.cpp 的 server 默认在 `/inference`（可用 `--inference-path` 改成 `/v1/audio/transcriptions` 而无需改代码），whisper-asr-webservice 走 `/asr` + `audio_file` + query 参数，形状完全不同。

另有反例要先说清楚：**LM Studio 与 Ollama 根本没有 `/v1/audio/transcriptions` 路由**，它们不在兼容面内，不要为了让文档好看而把它们算进来。

**价值。** 把一句营销话变成一张可核验的表，并把"装上就能判断行不行"补上。这是市场装机的前提。

**成本。** 小到中，且**主要不是协议变更**：错误可读性（缺 `model`、`model` 不存在——已有 `model-not-found` 码）、端点路径可配置、无凭据引擎的选择、以及一份带命令行的接入指引。

**证伪实验。** 用 `tests/engines-conformance.host.spec.ts` 的手法为 2–3 个真实引擎（speaches、whisper.cpp、LocalAI）写真线格式 fixture，跑通即证明兼容表成立。

**风险。** 放宽路径会扩大可配置面（仍严格限回环、仅 http）；`openai-whisper-asr-webservice` 需要"字段名 + query 参数"两个额外旋钮，为一个引擎加两个旋钮性价比低；不要接受 `text/plain` 当成功响应。

### C. 共存可解释（诚实向）

**问题。** 设计文档 §4 承诺：注册前检查 single 声明与全部占用者，被占用时只回滚自己的麦克风并在设置页显示冲突。**代码里没有这段**，README 也没承诺。今天若用户同时启用官方语音 bundle，两边抢同一个单席位槽，结果取决于注册顺序/优先级，而**用户只会看到"麦克风没出现"**。

**价值。** 中等：只有同时用官方语音 bundle 的人会碰到，但碰到的人会以为插件坏了。

**成本。** 分两半：文档说明几乎零成本；真正实现要先弄清框架的单席位语义（谁赢、输家看到什么），验证需要在一个**临时 profile 里启用官方语音 bundle**——这越出当前授权（仓库约定：把插件安装或激活到任何 DSH profile 未授权）。

### D. 工程债（可信度向）

**问题（来源：README Known limitations + 设计文档各轮审查）。** 客户端 mount/withdraw 无自动化测试；`remote-entry` 测试只覆盖生成产物的元数据与 Host 解析器，**未覆盖真实 Remote 派发**（编解码、错误信封、`requestId` 提取、能力探测的 5xx/404 映射）；改非易失设置会重启 entry，journal 释放是 fire-and-forget，新实例可能瞬态读到"不可用"并弹一次多余确认；未读记录的确认 erase 是"读后写"且无 CAS，两个 await 宽的窗口内可能抹掉一条新记录；能力快照永不过期（只靠显式检查刷新）；两次 status 读取无法按内容排序。

**价值。** 不涨用户数，但这是本仓库的立身之本，也是它能被独立审查通过的原因。

**成本。** 中；其中"真实 Remote 派发"那条要搭一个能驱动生成产物的测试台。

### E. 基座化（对外契约 + agent 工具）

**问题。** Host 服务 `ctx.speechrailInput` 已存在但无对外契约文档；agent 只有一个只读的 `speechrail_input_status`。

**价值。** 高杠杆，但**需求未证**：目前没有任何第二个插件或第二个场景要用它。

**成本。** 中到高：给 agent"转写这个本地音频文件"的能力要引入文件读取与授权边界，与"不自动录音、不越权"的既有约定冲突，必须单独设计。

## 2. 排序与决策闸门

| 阶段 | 内容 | 前置 | 完成判据 | 需要的授权 |
|---|---|---|---|---|
| **0** | 真实使用一次并记录：启动耗时、识别质量、延迟、失败路径 | 人在机器前 | 一份主观结论：障碍是"触发"还是"质量/延迟" | **明确授权一次真实录音**（仓库约定：未授权不做真实录音） |
| **1** | 热键（切换式），走 `ctx.shortcuts` | 阶段 0 结论＝触发是障碍 | 命令出现在快捷键设置里、可改键、冲突可查；按一下开始、再按停止；无会话时给出理由而不是静默 | 无需额外授权（仓库内源码 + 测试） |
| **2** | 引擎兼容面与首次成功 | 无（可与 1 并行） | 兼容表有 fixture 证据；无 `model` / 无凭据 / 路径不符三类情况都有可读原因；接入指引可复现 | 无需额外授权（改源码 + 文档）；**用户已决定本机不做其他引擎实测（2026-10-25）**，因此真机验证不在范围内 |
| **3** | 共存可解释 | 需先弄清框架单席位语义 | README 明确写清互斥与后果；若能验证则实现可解释的让位 | **激活官方语音 bundle 到临时 profile 需单独批准** |
| **4** | 工程债（按风险排序） | 无 | 每条债有具名测试或明确的"刻意不改"记录 | 无需额外授权 |
| **5** | 基座化 | 出现真实需求 | 有其他消费者 | 需单独设计授权边界 |

**为什么 1 在 2 前面。** 你给的优先级是"先自己用得爽，再留住其他人"。阶段 1 是唯一能回答"你用不用它"的改动，且成本小；阶段 2 有确定的市场价值，但它**不会**改变你自己的使用率——你家的门槛已经跨过了（见 §0）。两者互不依赖，如果你想先要市场价值，把 2 提到 1 前面也不会破坏任何东西。

## 3. 阶段一的规格（实施计划据此编写）

- **目标**：不改动现有按次录音流程的前提下，增加一个可改键的键盘命令，让用户不碰鼠标即可开始/停止一次转写。
- **非目标**：常驻麦克风；VAD 分段；口令提交；按住说话（能否表达待验证，见 §4）；不改 composer 既有键位。
- **约束**：默认键必须与 DSH 既有键位不冲突（已知：Enter 发送、Ctrl/Cmd+Enter 互补投递、Shift+Enter 换行、Escape 停止、Esc Esc 停止序列、Tab 菜单）；必须能查出冲突而不是静默覆盖；无会话或无 `inputActions` 时返回 `blocked` 并给出本地化理由；一切经 `ctx.effect` 随插件卸载释放。
- **界面语言**：命令 label 走本包 locale 命名空间，中英各一份。
- **验证**：单测覆盖"命令注册与释放""无可用输入框时 blocked""触发时进入 recording、第二次触发结束并转写（取消仍归 Escape）""composer 处于 `locked` 时快捷键与按钮的 disabled 一致"；手工验证命令出现在快捷键设置、可改键、与既有命令无冲突。
- **实施计划**：[2026-10-25-dictation-hotkey.md](../superpowers/plans/2026-10-25-dictation-hotkey.md)。

### 阶段一实施状态（2026-10-25）

用户采纳方案后按计划实施完毕，`pnpm verify` 退出码 0（18 个测试文件 / 256 个用例，含基线校验、构建与打包清单检查）。

**已验证 [实测]**：命令的 id、默认键、两个 resolve 分支与"注册被拒时降级为无快捷键"都有单测；组件在 `locked` 时不订阅、因此命令报告 `blocked`；构建后的 `lib/client.js` 里能查到 `speechrail-input.dictate`，且客户端运行时的 `require` 仍然只有 `react`、`react/jsx-runtime`、`zod`——**没有新增运行时依赖**。

**未验证（不足以声称可用）**：

1. `ctx.shortcuts` 在本机运行实例里是否真的可注入。npm 包、类型与 `Context` 增补都已确认，但客户端 Service 目录不完整，本运行实例上未验证。
2. 默认键 `primary+shift+Space` 在真实注册表里是否与既有命令冲突。注册表在冲突时抛错，代码里已按"降级为无快捷键"处理，但冲突与否要装进 profile 才能看到。
3. 真实按键与真实录音（未授权）。

这三条都需要把新构建安装到某个 DSH profile，而那一步仍未授权。

**一处刻意的偏离**：计划原本要在 `dsh.client.inject` 里加 `@deepseek-ai/dsh-client-shortcuts`。实施时改为不加，只保留 `devDependencies`（类型来源）与 `ctx.inject(['shortcuts'], …)`（可选服务）。理由：manifest 的 `inject` 是硬依赖顺序，写进去会让缺少快捷键服务的组合永远等不到挂载，与"缺它就只是没有快捷键"的设计相反；`ctx.inject` 与仓库里 `tools` 服务的既有写法一致。

### 阶段二进展（2026-10-25）

用户对本文档 §1B 的第 1 条（凭据硬性前置）回答"修复"，已交付 [ADR-0003](../decisions/0003-unauthenticated-loopback-engines.md)：**显式清空凭据引用 ⇒ 该引擎不需要鉴权，请求不带 `Authorization` 头**；配了引用却解析不出值仍拒绝 `not-configured`，所以"引用名写错"依然可见。这是纯新增状态，默认值与非空引用的行为一字未变。

阶段 2 因此只剩：

- `model` 字段："总是发送配置好的 model"按引擎数解锁最多（speaches / vLLM / LocalAI / mlx-audio / coro-asr ≈ 6–7 个都要求它），缺字段时的原因也要可读；
- 端点路径形状：whisper.cpp 用 `--inference-path /v1/audio/transcriptions` 就能规避，属于文档而非代码；
- 兼容表的 fixture 级证据（真机验证按用户决定不做）。

**2026-10-25 补记（"首次成功"这一块）**：文档原先写着"随后在设置页填写地址与凭据引用"，而设置页只写语言与请求预算——端点、模型、凭据引用都是条目配置。这是错误指引，已替换为可复制的 `cordis.patch.yml` 补丁写法（含"整段替换、不深度合并"的提醒），并把"路径 / `model` / 凭据"三处引擎差异写成检查清单；设置页补上此前完全不可见的 `model` 行，并在"没配 model 却被拒绝"时给出提示（只说该检查什么，不臆断原因）。`model` 的取值落在哪个引擎上仍是文档级结论，未实测。

**未做（等用户决定）**：让 `model` 从设置页写入。它是三个静态字段中唯一不涉及"把凭据送到哪个地址"的一个，技术上可以改成 volatile 并由设置页持久化；但只让三者之一可编辑会让界面更不一致，且要改 Remote 配置契约。

## 4. 未核实项

- `ctx.shortcuts` 在**本机这个 profile** 里是否真的可注入（npm 包与类型已确认，客户端 Service 目录不完整，因此尚未在本运行实例上验证）。
- `ShortcutCommand.modals` 的合法取值：类型注释说"Allowed modal identifiers"，但未给出枚举与空数组语义。
- 是否存在 keyup 通道；若没有，"按住说话"只能用 `observeFixedInput` 或退回点击。
- 阶段 2 中 whisper.cpp 究竟读取哪些表单字段（抓到的源码被截断），以及它是否真的忽略未知的 `model`。
- ADR-0003 的"空引用＝无鉴权"只在 mock 传输层验证过（请求确实不带 `Authorization` 头）；用户已决定不做真机引擎实测，所以没有任何真实无鉴权引擎的端到端结论。
- 共存问题在真实双插件下的表现（需要激活官方语音 bundle，当前未授权）。
- 阶段 0 的结论只能由用户产出一一我自己不能录音，也不应替用户判断识别质量。

## 5. 授权边界

本文件是分析，不是授权。仓库当前允许：编写产品运行源码、安装仓库内 devDependencies、生成 Typert 工件、构建、运行 mock 测试与打包清单检查。**仍需单独批准**：真实录音（阶段 0）、把插件或官方 bundle 安装/激活到任何 profile（阶段 1 的真机验证与阶段 3 验证）、发布。

真实引擎的安装与真机转写验证已由用户决定**不做**（2026-10-25："本机不做其他引擎实测"）：阶段 2 因此只能交付契约改动、fixture 级证据与文档，兼容表的真机结论保持未验证，并如实标注。
