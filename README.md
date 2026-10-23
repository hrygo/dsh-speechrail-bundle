# dsh-speechrail-bundle

独立的 DeepSeek Harness SpeechRail 语音输入 bundle 项目。

**状态：官方基线与方案阶段。没有 SpeechRail 适配实现，没有可安装的根 package，也未在当前 DSH profile 安装或启用。**

## 当前授权边界

用户于 2026-10-23 要求：创建仓库，建立官方基线，再设计重构与替代方案；方案审查通过后，必须经用户明确批准才实施。

本轮只允许官方源码快照、来源校验、设计文档与方案审查。不得把方案审查通过解释为实施、安装、采集音频、调用推理或写入凭据的授权。

## 官方基线

- 上游：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)。
- 发布 tag：`dsh-v0.2.1-rc.2`。
- 固定 commit：`687f282e8625c6b8d11ff58211a90524be2e4317`。
- [官方快照](upstream/deepseek-harness/)：5 个官方语音包的原始源码、测试、元数据，以及语音子系统文档和 MIT 许可证。
- [来源清单](upstream/baseline.json)：逐文件 SHA-256、Git blob ID 与来源信息。
- 快照是只读参照，不是本项目的运行入口。它保留上游 monorepo 构建引用，不宣称可以脱离上游直接运行。

只校验本地基线（不安装依赖、不访问服务、不运行模型）：

```bash
python3 tools/verify-upstream.py
```

如需同时比对本地已获取的上游 Git 对象：

```bash
python3 tools/verify-upstream.py --git
```

## 目标边界

目标是**可以独立安装、无需开启官方语音 bundle** 的 SpeechRail 专用插件。它使用 OpenAI-compatible 文件转写协议，但不是任意云端识别器目录；默认仅连接 DSH Host 本机回环地址。

官方麦克风采集、草稿插入与生命周期行为作为重构依据。模型下载、服务启停、Realtime、TTS 和自动发送不属于初版目标。

## 仓库结构

- [upstream](upstream/)：不可修改的官方基线与来源清单。
- [tools](tools/)：只用于基线完整性检查的工具。
- [设计目录](docs/superpowers/specs/)：待批准设计。
- [决策目录](docs/decisions/)：架构选项与决定状态。
- [审查目录](docs/reviews/)：独立审查结论和修订记录。

本地 Git 仓库的 `upstream` remote 仅用于读取官方来源；未配置项目 `origin`，未创建远程仓库，未推送任何内容。

## 许可证

官方衍生代码遵循 MIT。保留 [LICENSE](LICENSE) 与 [NOTICE](NOTICE.md)；后续复制到产品源码时继续保留版权声明。
