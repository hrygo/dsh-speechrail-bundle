# ADR-0003 无鉴权回环引擎：显式空凭据引用即不发送 Authorization

- 状态：已接受（2026-10-25）
- 决策者：用户（"修复"）；实施：本次会话
- 关联：[ADR-0001](0001-independent-speechrail-input.md)、[ADR-0002](0002-drop-always-on-dictation.md)、[插件演进路线分析](../roadmap/2026-10-25-plugin-evolution.md) 阶段 2、[设计文档](../superpowers/specs/2026-10-23-speechrail-input-design.md)

## 背景

包 README 的配置表写着 `credentialRef`："a service without an API key needs none configured"。这句话与代码不符：

- **[实测]** `config.ts` 里 `credentialRef: z.string().min(1)` —— 空引用根本无法配置。
- **[实测]** `resolveCredential` 把"解析不到"和"解析出空值"都当 `null`（`service.ts:140-149`）。
- **[实测]** `check()`（`core.ts:396`）与 `transcribe()`（`core.ts:580`）在 `null` 时一律拒绝 `not-configured`。

于是**没有鉴权的本机引擎也用不了**：用户必须先造一个凭据引用和一个任意非空值，才能开始转写。这与"仅对接回环 OpenAI-compatible 文件转写子集"的宣称相反——那一类引擎里，无鉴权是常见形态：

- **[文档]** whisper.cpp 的 server 默认不校验 token（[server.cpp](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/server.cpp)）。
- **[文档]** LocalAI 仅在设置 `LOCALAI_API_KEY` 时才要求；vLLM 的 `--api-key` 可选；speaches 本地默认不要求。
- 汇总见[回环 STT 引擎兼容性调研](../research/2026-10-25-local-stt-engine-contracts.md)（阶段 2 的调研输入；真机验证按用户决定不做）。

## 选项

- **A. 只改文案**：把 README 改成"必须配置凭据引用"。成本一行，但把无鉴权本机引擎永久排除在兼容面之外——而它正是"降低其他人门槛"这条路的第一道坑。
- **B. 显式空引用 = 无鉴权**：`credentialRef: ''` 表示该引擎不需要鉴权，请求不带 `Authorization` 头，也不因此拒绝；非空但解析不到非空值仍拒绝 `not-configured`。
- **C. 解析不到就按无鉴权发送**：不再拒绝。**否**：无法区分"引擎不需要 token"和"引用名写错了"，把配置错误变成静默降级，而这类错误恰恰是回环端点最常见的失败。

## 决定

采用 **B**。

## 理由

1. 无鉴权回环引擎是合规且常见的形态，让它可用不需要放宽任何安全边界：端点仍限回环、仅 http、无凭据不外传，禁用代理的既有约束不变。
2. B 是**纯新增状态**：默认值仍是 `SPEECHRAIL_API_KEY`，非空引用的行为一字不变；空引用此前会被 schema 拒绝，因此不存在"行为被改变"的已存在配置。
3. 保留 `not-configured` 的诊断价值：它继续表示"你配了引用，但它解析不出东西"。
4. 三态报告 `accepted`/`refused`/`unverified` 不需要新词汇：没有凭据被发送时，没有任何东西判定过凭据，报 `unverified` 是它本来准确的含义。

## 代价与约束

- `credentialConfigured` 的含义**刻意保持不变**（"配置的引用是否解析出非空值"）。因此"显式无鉴权"必须由调用方用 `credentialRef === ''` 判断：客户端录音前的预检查、设置页显示、agent 工具摘要各自需要一个分支。宁可让三处各写一个显式分支，也不静默改掉一个已写进契约与文档的字段含义。
- 空引用只能在 Loader 配置（`cordis.patch.yml`）里设置：设置页只写易失字段（语言、请求预算），凭据引用与端点是静态字段。
- 探测在无鉴权下仍会真实请求服务，因此"服务是否声明能转写""限额""语言"这些结论照常可用。

## 复活条件（何时该重新收紧）

- 端点约束放宽到非回环、或出现跨机器/共享账号边界时，无鉴权形态必须重新评估。
- 若出现"请求被拒绝但用户以为已配置凭据"的真实误报，把空引用改为需要显式开关（例如一个布尔字段）而不是空字符串。

## 审批

用户 2026-10-25 在会话中对"改文案，或放宽为『未配置凭据时按无鉴权发送』"回答"修复"，即批准把该能力做成真（选项 B），而非削弱文档宣称。实施范围限本仓库源码、测试与文档；不涉及把插件安装到任何 profile、真实录音或真实引擎验证。
