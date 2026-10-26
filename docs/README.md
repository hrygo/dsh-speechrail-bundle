# 文档地图

按「你想知道什么」索引，而不是按目录结构。每份文档只在一个地方回答一个问题；有重叠时以标「权威」的那份为准。

## 我要用起来

| 想做的事 | 看这里 |
| --- | --- |
| 安装、升级、指向我的引擎 | [packages/voice-input/README.md](../packages/voice-input/README.md)（权威） |
| 它到底做什么、不做什么 | 同上「What it does」与「Known limitations」；仓库根 [README.zh-CN.md](../README.zh-CN.md) 有中文摘要 |
| 1.x 期间哪些契约不会变 | 同上「Stability in 1.x」（权威） |
| 每个版本改了什么 | [CHANGELOG.md](../CHANGELOG.md)（摘要 + 各 release 页链接） |

## 我要理解为什么

| 问题 | 文档 |
| --- | --- |
| 整体设计、席位、契约、被否决的方案 | [specs/2026-10-23-voice-input-design.md](superpowers/specs/2026-10-23-voice-input-design.md)（权威规格，含逐次修订） |
| 为什么要改成「只使用已声明的主题 token」 | [decisions/0005-declared-theme-tokens-only.md](decisions/0005-declared-theme-tokens-only.md) |
| 为什么 `model` 允许在设置页写 | [decisions/0004-model-id-writable-from-settings.md](decisions/0004-model-id-writable-from-settings.md) |
| 为什么插件叫 `dsh-voice-input`、哪些地方故意还叫 speechrail | [decisions/0006-name-the-plugin-dsh-voice-input.md](decisions/0006-name-the-plugin-dsh-voice-input.md) |
| 为什么凭据引用能在设置页改、边界在哪 | [decisions/0007-credential-reference-writable-from-settings.md](decisions/0007-credential-reference-writable-from-settings.md) |
| 为什么回环引擎可以不配凭据 | [decisions/0003-unauthenticated-loopback-engines.md](decisions/0003-unauthenticated-loopback-engines.md) |
| 为什么放弃「常驻听写 + 口令发送」 | [decisions/0002-drop-always-on-dictation.md](decisions/0002-drop-always-on-dictation.md) |
| 为什么不做成独立 App，而是复用现有 composer | [decisions/0001-independent-voice-input.md](decisions/0001-independent-voice-input.md) |
| 本机 STT 引擎各家的契约差异（实测） | [research/2026-10-25-local-stt-engine-contracts.md](research/2026-10-25-local-stt-engine-contracts.md) |
| 排序原则与逐次发布的取舍 | [roadmap/2026-10-25-plugin-evolution.md](roadmap/2026-10-25-plugin-evolution.md)（含授权边界，权威） |
| 独立评审当时发现了什么 | [reviews/2026-10-23-design-review.md](reviews/2026-10-23-design-review.md) |

## 我要改代码

| 问题 | 文档 |
| --- | --- |
| 当初打算怎么实现、哪些没做 | [superpowers/plans/2026-10-23-voice-input-implementation.md](superpowers/plans/2026-10-23-voice-input-implementation.md) |
| 键盘命令那一轮的计划 | [superpowers/plans/2026-10-25-dictation-hotkey.md](superpowers/plans/2026-10-25-dictation-hotkey.md) |
| 怎么构建、怎么验证、验证包含什么 | [packages/voice-input/README.md](../packages/voice-input/README.md)「Build and verification」 |

## 我要上架

| 事项 | 文件 |
| --- | --- |
| 市场条目（已提交的原文与字段取舍） | [market-submission/awesome-dsh-plugin.yml](market-submission/awesome-dsh-plugin.yml) |
| 提交说明（给评审者看的上下文） | [market-submission/pull-request.md](market-submission/pull-request.md) |
| 条目用的 256px 图标 | [market-submission/icon-256.png](market-submission/icon-256.png)（由 `packages/voice-input/icon.svg` 渲染） |

## 约定

- 证据分级写在正文里：**实测**（附日期与命令/数据）、**文档**（附路径或 URL）、**推断**（明说）。
- 版本号只在一处绑定：`packages/voice-input/package.json` 与 README 里的 tag 固定安装 URL 由 `tools/check-release-consistency.mjs` 校验。
- 决策改了不删旧文，在原文后加带日期与版本的「修订」段，见设计文档 §4。
