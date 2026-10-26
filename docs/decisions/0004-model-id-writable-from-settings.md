# ADR-0004 `model` 可从设置页写入：凭据与端点仍为静态

- 状态：已接受（2026-10-25）
- 决策者：用户（"你先做深做实"）；实施：本次会话
- 关联：[ADR-0001](0001-independent-voice-input.md)、[ADR-0002](0002-drop-always-on-dictation.md)、[ADR-0003](0003-unauthenticated-loopback-engines.md)、[回环 STT 引擎兼容性调研](../research/2026-10-25-local-stt-engine-contracts.md)、[设计文档](../superpowers/specs/2026-10-23-voice-input-design.md)

## 背景

设置页此前只**展示**端点、模型与凭据引用，**可写**的只有语言与请求预算；`baseUrl`/`model`/`credentialRef` 三个静态字段只能改 composition（`cordis.patch.yml`）并等重新加载。

调研（[兼容性调研](../research/2026-10-25-local-stt-engine-contracts.md)，2026-10-25）显示这条边界正好切在最常被挡住的地方：

- **[文档/源码]** speaches（`model: ModelId = Form(...)`）、vLLM（served model name）、mlx-audio（`model: str = Form(...)`）**强制要求** `model` 字段；LocalAI 在其文档示例中同样总是携带 `model`；OpenAI 本身的 `/v1/audio/transcriptions` 也要求它。
- **[源码]** 这些引擎把 `model` 与**已加载/已服务**的名字比对：vLLM 与 speaches 在不匹配时回 **404**，speaches/mlx-audio 在缺字段时回 **422**。因此不能用一个占位符（如 `whisper-1`）糊过去，值必须是操作者自己那台引擎的权重名。
- 也就是说：让第二个引擎跑起来最常需要改的那个值，恰好是设置页唯一改不了的值。

## 选项

- **A. 维持静态，只把 composition 写法写进文档**：零代码风险，但首次接入最常见的失败（未设/设错 `model`）仍需改文件 + 重载，且无法在页面上迭代。
- **B. `model` 改为易失字段、可在设置页写入；`baseUrl`/`credentialRef` 保持静态**。
- **C. 三者都改为可写**：**否**。设置写入来自浏览器面（Remote `configure`），把 `baseUrl`/`credentialRef` 变成可写就等于让一次设置写入能够重新指定"本机密钥发往哪个地址"——这正是它们保持静态的理由。

## 决定

采用 **B**。

## 理由

1. 模型名不参与"密钥发往哪里"这个决定：它命名的是**已经在使用的那个端点**上的权重。静态字段那条安全理由对它不成立，注释此前把它与两个字段并列是笼统归类。
2. 它是引擎强校验的值，且必须等于操作者自己加载的权重名，因此必须能在不重载的前提下输入与试错。
3. 易失即既有机制（语言、请求预算走同一条 `settings.update` 路径，带 revision 冲突检测），不需要新协议。
4. 页面保留**一个**保存动作覆盖三个可写字段，比"其中两个能改、一个要改文件"更一致。

## 代价与约束

- Remote 配置契约新增**必填**字段 `model`。客户端与 Host 同包同版本（浏览器面由本包构建产物提供），属锁步变更；缺字段按 `bad-request` 拒绝，而不是"保持原值"——后者会让一个丢掉该字段的客户端静默把旧模型继续发出去。
- schema 与写入路径共享同一个上界 `MAX_MODEL_LENGTH`（200），避免"页面接受、加载失败"的不一致；两侧都有测试。
- `baseUrl` 与 `credentialRef` 仍**只能**在 composition 里改，设置页只展示：这一条是刻意的，不是遗漏。
- 配置因此有两个来源：composition 的值是初始默认，设置页写入的值（易失）优先并在每次操作前重新读取。页面上模型留空 = 由服务选择，请求不带 `model` 字段。
- 一个 404 有两种成因（路径不对 / 模型未加载），状态码本身无法区分，因此页面只并列提示两者，不臆断是哪一种。

## 复活条件（何时该重新评估）

- 若 composition 编辑被 UI 取代、设置页成为唯一配置入口，应重新评估三者是否统一为易失。
- 若出现"页面写入的模型名与引擎实际权重不一致、且难以诊断"的真实反馈，可考虑让 Host 从引擎自身发现模型名。当前**刻意不做**：设计只读 `/v1/speechrail/capabilities`，绝不枚举 `/v1/models`（见设计文档）。
- 若某引擎要求非字符串或超长 `model` 值（例如整个本地路径），上界与类型假设需要重新评估。

## 审批

用户 2026-10-25 在会话中以"你先做深做实"授权把该项做透，包含上述 Remote 契约变更。实施范围限本仓库源码、测试与文档；不涉及把插件安装到任何 profile、真实录音、真实推理，也没有做任何真机引擎验证。

## 补记（2026-10-26）

本 ADR 把 `baseUrl` 与 `credentialRef` 一起冻结，只放出 `model`。实际使用推翻了后半条：设置页把引用渲染成只读文本，引用未解析时只能报告「未配置」，没有任何修复入口——用户报告的正是这一点。`credentialRef` 已改为可写，见 [ADR-0007](0007-credential-reference-writable-from-settings.md)；**`baseUrl` 保持冻结**，因为只有它会移动密钥的去向。
