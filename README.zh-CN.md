# dsh-speechrail-bundle

独立的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 语音输入 bundle：浏览器录音，
经**本机**服务按 OpenAI-compatible 文件转写协议转写——SpeechRail 参考实现，或其他同形状的本机引擎。
无需启用官方语音 bundle，且只连接回环地址。

[English](README.md) · [包说明](packages/speechrail-input/README.md) · [设计与审查记录](docs/superpowers/specs/2026-10-23-speechrail-input-design.md)

**状态：实现已完成并通过验证，且已在本机 `desktop` profile 中运行。** 每个版本都由 `pnpm verify`
（基线校验 → Typert 生成 → 双面类型检查 → 构建 → 测试）产出，并通过插件管理器从该版本自己的 GitHub
Release 资产安装，安装后再与仓库构建逐字节比对。

## 提供什么

| 面 | 内容 |
|---|---|
| Host | 严格 Typert Remote 面上的 SpeechRail 服务：仅回环上传、凭据**按引用**解析、单在途 gate、非敏感未结案 journal、稳定错误码。 |
| Client | 输入框麦克风控件（波形、草稿插入保护）与设置页；中英文本地化；门禁被阻塞时两处都能确认清除。 |
| Agent | 一个只读工具 `speechrail_input_status`，模型无需打开设置页即可解释语音输入为何不可用：端点、凭据三态结论、服务是否声明能转写、**实际会发送**的语言提示、生效限额与门禁；门禁关闭时还会说出**那次未被确认的失败**。 |

## 两种引擎档位，一套契约

| | SpeechRail（参考实现） | 其他回环 OpenAI 形状引擎 |
|---|---|---|
| 能力快照 | 读取 `GET /v1/speechrail/capabilities`，其声明的限额与语言持续生效 | 无该端点：报 `capabilities-absent`，改用包内默认限额并在设置页标注为默认值 |
| 转写响应 | `{"text": ...}`；`usage` 时长扩展可选、会校验、且**不**冒充推理耗时 | `{"text": ...}`，有无 `usage` 均可 |
| 凭据 | 三态、从不猜测：只有 200 才 `accepted`，401/403 判 `refused`（只看状态行），其余 `unverified` | 相同 |
| 语言 | 快照枚举了就发送枚举值；能转写但没列举语言的服务，按你的选择作为未验证提示发送 | 相同 |
| journal / 单在途门禁 / 确认 | 生效 | 同样生效——操作 id 由客户端生成，守卫不依赖服务 |
| 生效限额 | 服务的数值，再按本包自身的上限收紧 | 包内默认值（4 MiB / 120 s） |

两档都由 `tests/engines-conformance.host.spec.ts` 钉住：用真实 Host core 打真实回环套接字，并断言两者
各自被告知了什么。

## 安全属性

- **仅回环。** 只接受 `http://127.0.0.1:<port>/v1` 与 `http://[::1]:<port>/v1`；其他地址以及带 userinfo 的 URL 在构造请求前就以稳定原因拒绝。
- **凭据不落盘、不记录、不回传。** 经 DSH credentials 或设置解析引用后作为 bearer 头发送；跨边界只有引用名与布尔值。
- **不持久化音频与转写文本。** 未结案 journal 只存操作 id、阶段与时间戳，因此崩溃或刷新不会静默丢失结局未知的上传。
- **不会重复上传。** 门禁同一时刻只允许一次操作；结局未知会阻塞后续上传，直到显式确认清除。
- **只有"被拒绝"才会重新开门。** 到达客户端的状态只有在**证明服务没有处理这次上传**时才结算未结案记录：
  4xx（408 除外），或服务回了 200 但该响应本身不可用。5xx（网关可能已放弃，而上游 worker 仍在转写）、3xx、
  408、以及 202 "accepted" 都保持"未证明"，门禁继续询问，而不是在可能仍在运行的工作之上邀请用户再录一遍。
- **服务声明的限额才生效。** 不可识别、不可达或未声明限额的能力响应，其中的缺失字段沿用当前生效值。

## 要求

- DeepSeek Harness `>= 0.2.1-rc.2`（`engines.dsh`）。
- Node `^22.19.0 || >=24.0.0`。
- 本机服务提供 OpenAI 形状的 `POST /v1/audio/transcriptions` 并返回 `{"text": ...}`。SpeechRail 是
  参考实现（它的 `usage` 扩展与 `GET /v1/speechrail/capabilities` 能力快照均可选）；其他同形状的
  本机引擎同样可用，缺少能力端点时按 `capabilities-absent` 报告，而不是当作服务故障。
- Host 可解析的凭据引用，例如 `SPEECHRAIL_API_KEY`。

## 安装

不发布 npm 包。每个 Release 附带打包好的 tarball，通过 Harness 插件管理器安装（它负责包安装与 bundle 选择，
不要手工替代）：

```
plugin_manager  action: install_bundle  target: https://github.com/hrygo/dsh-speechrail-bundle/releases/latest/download/dsh-speechrail-bundle.tgz
```

用本地 checkout 也可以（`target: <packages/speechrail-input 的路径>`）；本机 profile 已在运行本 bundle 的最新 Release。

升级时请安装带标签的资产，而不是 `latest`：插件管理器按 target 字符串去重，对已安装的 bundle 重跑上面的
命令只会报 `already-installed`，不会拉取新的字节。

```
plugin_manager  action: install_bundle  target: https://github.com/hrygo/dsh-speechrail-bundle/releases/download/v0.8.1/dsh-speechrail-bundle.tgz
```

随后在设置页填写地址与凭据引用。

## 已知限制

- 可能同时存在两次状态读取（例如"检测服务"与开始录音）。客户端会忽略比已应用结果更晚到达的**旧**
  读取，但无法按内容排序两次响应：`revision` 跟踪的是设置写入，不是门禁；因此服务用更旧快照生成的
  响应仍可能被短暂显示，直到下一次读取纠正。
- 服务未声明某项能力时按"不支持"处理，而不是假定可用；未实现能力端点的服务沿用最后一次声明过的快照，
  此时生效的限额是包内默认值，设置页会标注这一点。快照**不会过期**：唯一的重新探测是显式"检测连接"，
  而"每次上传前重检"被否决——那会在用户已经说完话之后才插入一次往返。
- 语言是上述规则唯一的有意例外，且按服务**能做什么**处理：服务枚举了语言就只开放这些；服务声明不支持
  该语言则写明"未生效"，绝不静默改选；服务能转写但没列举语言（SpeechRail 自己就是这种）时按你选的语言作为
  未验证提示发送——设置页标注、composer 在请求进行中显示、agent 工具报为 `languageHint`。只有当检测真的
  到达服务时，设置页才会写"服务未给出"；宿主本地拒绝的检测（无凭据、端点不合规）显示为"尚未检测"。
- 生效的限额是**本包自己的**，且刻意严于 SpeechRail：线上服务声明 512 MiB / 3600 s，本 bundle 强制
  4 MiB / 120 s，因为整段录音要作为一个 base64 JSON 载体通过 Remote 面传输。超过任一上限时按真实原因拒绝
  （`audio-too-long` / `audio-too-large`），而不是报成"录音格式不对"。
- 请求预算被限制在 1000–180000 毫秒：设置 schema 限制一次，Remote 写入路径再校验一次，因为设置存储
  只校验形状而不校验 `min`/`max`。
- 修改非易失设置（端点、模型、凭据引用）会重启 bundle 条目：释放 journal 存储单元后立即重新打开。释放
  是"发射后不管"的，而存储后端会拒绝同名单元的第二个句柄，因此新实例可能短暂地把 journal 读成不可用
  （出现"结果未确认"门禁与多余的确认提示）。重试即恢复；等待释放完成可消除该窗口。
- 记录不可读的确认所走的擦除是先读后写，而存储服务没有 compare-and-set：若某次操作恰好在该窗口内
  写入记录，它会被覆盖（门禁本身仍然正确——宿主在擦除后会复核占用者）。该窗口仅两个 await 宽，且只在
  确认一个不可读槽位时存在。
- bundle 本身从不读取或保存凭据：每次请求都按配置的凭据名称向 Harness 凭据库解析。

## 验证

```bash
pnpm install
pnpm verify     # 基线校验 → Typert 生成 → 双面类型检查 → 构建 → 测试
pnpm test       # host 与 client 单元测试（全部 mock 或合成音频）
```

`pnpm verify` 还会按 [baseline.json](upstream/baseline.json) 与固定上游 commit 复核快照。仓库内任何命令都不
访问真实服务、不录音、不发起推理。

## 仓库结构

- [packages/speechrail-input](packages/speechrail-input/)：发布包 `@hrygo/dsh-speechrail-bundle`（Host、Client、协议源码、patch、语言资源与图标）。
- [packages/typert-protocol](packages/typert-protocol/)：私有类型垫片，让 Typert 生成器看到本包的 Remote 声明；永不发布、运行时从不 import。
- [upstream](upstream/)：冻结的官方只读基线（5 个语音包，MIT）与逐文件来源清单；是来源证据，不是运行入口。
- [tools](tools/)：基线完整性与工具 schema 校验脚本。
- [docs](docs/)：设计、实施计划，以及各轮独立审查与其处置记录。

## 来源与许可

实现针对官方语音子系统编写，快照固定在上游 commit `687f282e8625c6b8d11ff58211a90524be2e4317`
（`dsh-v0.2.1-rc.2`），并改编了官方录音辅助代码的部分实现。MIT；见 [LICENSE](LICENSE) 与
[NOTICE.md](NOTICE.md)，其中保留了上游版权与归属。
