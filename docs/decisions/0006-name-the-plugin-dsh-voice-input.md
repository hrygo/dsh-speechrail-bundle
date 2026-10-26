# ADR-0006 插件命名为 `dsh-voice-input`

## 背景

用户 2026-10-26 提出：「感觉不像一个标准的三方插件的名字」。旧名是 `@hrygo/dsh-speechrail-bundle`，包目录 `packages/speechrail-input`。

## 实测依据

同一台机器（`/Users/hrygo/.dsh/profiles/desktop/node_modules`，2026-10-26 读取）里已装的三方插件包名：

| 包名 | 形态 |
| --- | --- |
| `dsh-better-sidebar` | 无 scope，`dsh-` 前缀 |
| `dsh-context` | 同上 |
| `dsh-image-gen` | 同上 |
| `dsh-lsp-actions` | 同上 |
| `@local/dsh-ptc-tool-search` | scope 表示「本机私有」，不是作者个人 |
| `@hrygo/dsh-speechrail-bundle` | 个人 scope + `-bundle` 后缀 + 引擎名（旧） |

即：对外发布的插件用无 scope 的 `dsh-<用途>`；`@scope/` 留给官方（`@deepseek-ai/`）与本地私有（`@local/`）。旧名三项都不合。

## 决定

`dsh-voice-input`，包目录 `packages/voice-input`。同时改掉把引擎名写进插件标识的部分：快捷键 id、agent 工具名、席位 id、locale 命名空间、DOM 钩子、Host entry id、发布资产名。

## 理由

- 生态惯例是可观察的事实（上表），不是偏好；插件名与安装形态一致，别人在 composition 里引用时不必解释 `-bundle` 是什么。
- 插件与引擎无关：任何 OpenAI 兼容回环引擎都能用（README「Other engines」）。名字里的 `speechrail` 会让「我不用 SpeechRail 能不能装」变成一个问题。
- 版本语义：改标识是破坏性变更，走 2.0.0，不假装是 1.x 的补丁。

## 故意保留 `speechrail` 的地方

- Remote namespace `speechrailInput` 与 `SpeechRail*` 内部类型名：它们描述 SpeechRail 的 wire 契约（能力快照、失败码、传输），不是插件品牌。
- `SPEECHRAIL_API_KEY` 默认凭据引用、`/v1/speechrail/capabilities` 路径：属于引擎契约。
- 持久化单元 `speechrail_input_pending`：这是**磁盘上的数据**，不是标签。改名的后果是一次「结局未知」上传的门禁记录无人再读——恰好是这套 fail-closed 机制存在的理由；安全重命名需要迁移，而丢记录比重命名更重要。
- GitHub 仓库名 `hrygo/dsh-speechrail-bundle`：本次未授权改仓库（用户只选了「包名 + 用户可见标识」），GitHub 的重定向会让旧链接继续工作，留待后续单独决定。

## 代价

- 配置键随包名变化：旧安装的端点、凭据引用、语言、模型不会带过来，需要重填一次。
- 旧包仍在 profile 里时不装新版即可避免「两个麦克风同屏」，发布流程里包含卸载旧包一步。
- 已有安装需要重新安装（新包名 = 新依赖），不是升级。

## 复活条件

若 DSH 官方给出自己的插件命名规范且与此不同，按官方规范再改一次（同样是 major）。若插件将来真的只支持 SpeechRail，再把引擎名放回名字里是有理由的——但那时它是「限定引擎」，需要重新评估 `Other engines` 段落。

## 补记（2026-10-26，改名之后）

### 名字不是唯一的，用户选择保留

市场索引（`https://awesome-dsh-plugin.com/plugins.json`，本机 `dshmarket` 1.66.42 读取的那份，6,896 条）里，`dsh-voice-input` 这一格已被两项占用：

| 条目 | 实现 |
|---|---|
| `0nt-one/dsh-voice-input` | 浏览器 Web Speech API（Chrome/Edge） |
| `NewDaNew/dsh-voice-input` | 浏览器 Web Speech API |

改名时我只查了 npm 与 `node_modules` 里的包名，没查市场索引，因此这是一次**事实核查遗漏**，不是口味分歧。用户看过选项后明确决定**保留 `dsh-voice-input`**，不进入第三次改名。

代价（保留，不掩盖）：

- 索引与搜索里会有三条同名条目，读者要靠 `owner` 与简介区分；索引侧的重名条目本身也不稀有（6,896 条里有 336 组，`dsh-session-delete` 有 15 个）。
- 索引侧按名字匹配的兜底匹配对重名条目**会拒绝猜测**（`dshmarket/lib/catalog-local-match.js`：同名的分叉在没有身份线索时不匹配），所以避免把别人的简介贴到我们卡上。
- 撤销条件不变：若市场上同名条目的困惑度真的影响使用，改名仍是可选项，成本是一次 major 版本与一次卸载重装。

### 卡片文案不来自市场索引，来自包内 locale

`dsh-app-boot` 的 `readPluginMeta(specifier, parentURL)` 读的是包内文件：`locale/en.json`（及同目录其它语言文件）的 `meta.title` / `meta.description`，`package.json` 的 `name` / `description` 作兜底，`package.json` 的 `icon` 内联为 data URI（SVG/PNG/JPEG/WebP，≤256 KiB）。插件管理器对已装 bundle 始终调用它，因此**第三方插件不需要进市场索引也能在卡片上显示标题、简介与图标**。

这条事实把一个「要不要等市场」的问题变成了「包内文件对不对」的问题：2.0.0 的卡片只显示安装 URL，是因为 `locale/*.json` 里写的是旧品牌且该路径当时未生效；改正 locale 后刷新即生效（实测）。2.0.1 起由 `tests/metadata.host.spec.ts` 钉住。
