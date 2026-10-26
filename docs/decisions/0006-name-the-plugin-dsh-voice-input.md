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
