# ADR-0001：独立 SpeechRail 语音输入的复用边界

- 日期：2026-10-23
- 状态：Proposed；待用户批准设计，不代表实施授权。
- 关联：[设计文档](../superpowers/specs/2026-10-23-speechrail-input-design.md)。

## 背景

用户要求建立在官方语音 bundle 基线上的独立插件，专用于 SpeechRail OpenAI-compatible 文件转写，而非依赖官方 bundle 开启的覆盖层。

官方基线固定为 `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`；所有官方归档文件保持原样。

## 选项

| 维度 | A 官方 bundle 覆盖层 | B 独立组合官方 Service/API，有限 fork Client | C 独立专用薄切片（推荐） |
|---|---|---|---|
| 无需开启官方 bundle | 否 | 是 | 是 |
| 初始复制范围 | 最小 | 客户端 | 采集/草稿行为、校验行为；自有服务/Remote |
| 多 provider / 模型准备概念 | 留存 | 留存 | 删除 |
| 真实耗时语义 | 受上游必填 inferenceSeconds 限制 | 同左 | requestSeconds 与未知 inferenceSeconds 分离 |
| 结构化错误到 UI | 上游压成普通 message | 同左；需另加绕行 | 自有稳定错误契约 |
| 官方更新耦合 | 整 bundle 与 patch 顺序 | STT/API/Client 接缝 | DSH 扩展点与有限行为基线 |
| 独立构建成本 | Host provider | Client 构建与官方 Remote | Client 构建与自有 Typert 产物 |
| 是否纳入初版 | 不满足独立要求 | 成本较低的备选 | 建议批准 |

## 拟决定

采用 C：单一发布包 `@hrygo/dsh-speechrail-bundle`，包含专用 Host 服务 `speechrailInput`、同名 Remote namespace、有限 fork 的 Client 与一个薄管理工具入口。保留官方录音和草稿安全机制，不保留通用识别器注册表、SenseVoice、下载/准备状态机或任意 OpenAI 云提供商选择。

“基于官方”指可追溯的行为与代码派生，不要求把所有官方语音运行包设为依赖。派生文件必须保留官方版权与上游路径记录。

## 选择原因

[官方 Transcript 类型](../../upstream/deepseek-harness/packages/experimental/speech-to-text/src/types.ts#L107-L124) 强制 measured inferenceSeconds。SpeechRail 标准 JSON 不提供纯推理耗时，不能以 0、null 强行塞进该契约，也不能悄悄用 HTTP 总耗时替代。

[官方 Remote](../../upstream/deepseek-harness/packages/experimental/api-speech-to-text/src/index.ts#L89-L109) 把失败压成 `speech/transcription-failed` 与普通 reason，无法无损承载专用结构化错误。

[官方 Client 绑定](../../upstream/deepseek-harness/packages/experimental/client-ui-voice-input/src/client/mount.ts#L20-L53) 指向原 bundle；直接重用无法获得独立设置身份。第三方插件还须移除对内置 UI primitives、client-store 的运行时依赖。

## 代价与约束

- 必须维护一组有限派生行为测试，不能只复制界面外观。
- Typert 生成器有公开 build-time API，但独立工作区构建尚未实测。批准后先验证产物门禁；失败不得静默退回非严格 Remote。
- 独立 namespace 消除协议身份碰撞，但不消除 composer 单席位 UI 冲突。初版仍要求与官方麦克风贡献互斥；不自动改另一 bundle 的开关。
- 不修改 DSH 或 SpeechRail 上游契约来凑功能。

## 备选与重新决策条件

若 C 的独立构建不能通过，先报告阻断证据。B 只在用户另批“放宽耗时语义/错误投影”或上游提供可表达未知计时的契约后考虑；不得把 B 作为静默 fallback。

Realtime、远端 SpeechRail、严格服务端请求取消、官方与专用麦克风共存，均为独立需求，不随本 ADR 获批自动纳入。

## 审批

尚无用户批准记录。独立审查的结论记录在 [审查目录](../reviews/)，不把审查状态改写成 Accepted。
