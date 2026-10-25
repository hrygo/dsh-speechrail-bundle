# 回环 STT 引擎兼容性调研（文档/源码级，未实测）

- 调研日期：2026-10-25
- 方式：只读公开文档与项目源码（web 检索 + 抓取）；**未安装、未启动、未连接任何引擎**，未向任何服务发出请求，未在本机做真机验证
- 证据分级：**[DOC]** 官方文档/README/文档站；**[CODE]** 项目自身源码（附路径或 PR）；**[INFER]** 本次调研的推断
- 用户决定：本机不做其他引擎实测（2026-10-25）。因此下表除注明外都是**文档级结论**，不是实测结论

## 本插件发出的请求（被验证对象）

| 项 | 本插件的实际行为 |
| --- | --- |
| 路由 | `POST <baseUrl>/audio/transcriptions`；`baseUrl` 经校验，必须是 `127.0.0.1`/`[::1]` 的 `http://…/v1` |
| 表单字段 | `file`（16 kHz 单声道 WAV）、`response_format=json`，`model` 与 `language` **仅在配置非空时**发送 |
| 鉴权 | 凭据引用解析成功时 `Authorization: Bearer <secret>`；引用显式清空时不带该头（[ADR-0003](../decisions/0003-unauthenticated-loopback-engines.md)） |
| 期望响应 | HTTP 200，`application/json`，body 带字符串 `text`；`usage` 扩展可选 |

## 兼容性矩阵

| 引擎 | 路由（+ 开关） | `model` | 鉴权 | `response_format` / Content-Type | 音频字段 | 缺/错 model 的错误 |
| --- | --- | --- | --- | --- | --- | --- |
| **speaches**（原 faster-whisper-server） | `POST /v1/audio/transcriptions`，硬编码，**不可配**（仅 `UVICORN_HOST`/`UVICORN_PORT`）— [CODE stt.py](https://github.com/speaches-ai/speaches/blob/master/src/speaches/routers/stt.py) | **必需**（`Form()` 无默认）；值是 `ModelId`，如 `Systran/faster-whisper-tiny.en`，经 `model_aliases.json` 解析 — [CODE](https://github.com/speaches-ai/speaches/blob/master/src/speaches/routers/stt.py) | **可选**，默认关闭；设 `API_KEY` 后所有 API 需 `Authorization: Bearer <key>`，缺失/错误 → **403** `{"detail":"API key required..."/"Invalid API key..."}` + `WWW-Authenticate: Bearer` — [CODE dependencies.py](https://github.com/speaches-ai/speaches/blob/master/src/speaches/dependencies.py)、[DOC configuration](https://speaches.ai/configuration/) | **遵守**：`text\|json\|verbose_json\|srt\|vtt`，默认 `json`；json/verbose_json → `application/json`（body 有 `text`），text → `text/plain` — [CODE](https://github.com/speaches-ai/speaches/blob/master/src/speaches/routers/stt.py) | `file`（必需）；可选 language、prompt、response_format、temperature、`timestamp_granularities[]`、stream、hotwords、without_timestamps | 缺 model → **422**（FastAPI 校验；[INFER] 由必需 Form 推得）。模型未安装 → **404** `{"detail":"Model 'X' is not installed locally..."}` — [CODE utils.py](https://github.com/speaches-ai/speaches/blob/master/src/speaches/routers/utils.py) |
| **vLLM** | `POST /v1/audio/transcriptions`；固定，无按路由开关（只有整应用的 `--root-path`）— [DOC openai server](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html) | **必需**；值为 served model name（`--served-model-name` 或模型 id）— [DOC speech_to_text](https://docs.vllm.ai/en/latest/serving/online_serving/speech_to_text/) | **可选** `--api-key`；设置后受护路由需 `Authorization: Bearer <key>`，缺失/错误 → **401** `{"error":"Unauthorized"}` — [DOC authenticate](https://docs.vllm.ai/en/latest/api/vllm/entrypoints/serve/middleware/authenticate/)、[DOC vllm serve](https://docs.vllm.ai/en/latest/cli/serve/) | **遵守**：`json\|text\|srt\|verbose_json\|vtt\|diarized_json`，默认 `json`（`response_format = Field(default='json')`）→ `application/json` `{"text":...}` — [DOC protocol](https://docs.vllm.ai/en/latest/api/vllm/entrypoints/speech_to_text/transcription/protocol/) | `file`（必需）；其他：model、language、prompt、response_format、temperature、hotwords、`vllm_xargs` — [DOC](https://docs.vllm.ai/en/latest/serving/online_serving/speech_to_text/) | 完全缺 model：**未知**。模型未服务 → **404** `{"error":{"message":"The model \`x\` does not exist...","type":"NotFoundError","param":"model","code":404}}` — [CODE PR #59889](https://github.com/vllm-project/vllm/pull/59889) |
| **LocalAI** | `POST /v1/audio/transcriptions`（也支持 `/audio/transcriptions`）；不可配 — [DOC audio-to-text](https://localai.io/features/audio-to-text/) | 文档示例中**必需**；值为 LocalAI 模型名（YAML `name:`）。缺/错时的错误：未知 | **可选**：`LOCALAI_API_KEY=…`（旧版共享 key，亦可 `--api-key`）或完整用户鉴权 `LOCALAI_AUTH=true`；接受 `Authorization: Bearer`、`x-api-key`、`xi-api-key` 与 token cookie；开启后未鉴权 → 401（body 未知）— [DOC authentication](https://localai.io/features/authentication/) | **遵守**：`json\|verbose_json\|text\|srt\|vtt\|lrc`。**文档自相矛盾**：正文说"verbose_json（默认）"，表格说"json（默认，向后兼容）"。`response_format=json` → JSON — [DOC](https://localai.io/features/audio-to-text/) | `file`（必需）+ `model`；language/prompt/temperature 可选 | **未知** |
| **mlx-audio**（Blaizzy） | `POST /v1/audio/transcriptions`，硬编码，无开关 — [CODE server.py](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/server.py) | **必需**：`model: str = Form(...)`；值为 HF repo id 或本地路径 — [CODE](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/server.py) | **无/忽略**：无鉴权依赖，`main()` 无 `--api-key` — [CODE](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/server.py) | **遵守**：`ndjson`（**默认**，`application/x-ndjson`）、`text`（`text/plain`）、`json`（`application/json` `{"text":...}`）、`verbose_json` — [CODE](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/server.py) + [PR #704](https://github.com/Blaizzy/mlx-audio/pull/704)。**默认是 ndjson，因此必须显式请求 `json`** | `file`（必需）；可选 language、verbose、max_tokens、chunk_duration、frame_threshold、stream、context、prefill_step_size、text、prompt、response_format、word_timestamps、`timestamp_granularities` | 缺 model → **422**（[INFER] 由必需 Form 推得）。未知模型 → `_preflight_model_load`；`RepositoryNotFoundError` → 404，其余 → 500（[CODE]/[INFER]） |
| **coro-asr** | `POST /v1/audio/transcriptions`，固定 — [DOC PyPI](https://pypi.org/project/coro-asr/) / [repo](https://github.com/collectiveai-team/coro) | **接受但忽略**：`model="whisper-1"  # accepted but ignored`。省略时是否必需：**未知** | **无/忽略**：SDK 要求 api_key，Coro 忽略 — [DOC](https://github.com/collectiveai-team/coro) | 仅 `json\|verbose_json\|diarized_json`（无 `text`/`srt`/`vtt`）；`stream=true` → OpenAI 形状 SSE。渲染默认文档说 `diarized_json`；端点默认**未知**。json → `application/json`（[INFER]）— [DOC](https://github.com/collectiveai-team/coro) | `file`（+ model、response_format） | **未知**（model 被忽略，可能无模型错误） |
| **whisper.cpp server** | `POST <request_path><inference_path>`；默认 `/inference`，可用 **`--inference-path PATH`**（与 `--request-path PATH`）改 — [DOC README](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md) + [CODE server.cpp](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/server.cpp)。**默认不是** `/v1/audio/transcriptions` | **没有 `model` 表单字段**；模型在启动时用 `-m/--model FNAME`（或 `POST /load`）选定 — DOC/CODE | **无**（选项表无 `--api-key`，未见 Authorization 处理）— [DOC](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md) | **遵守**：`json\|text\|srt\|verbose_json\|vtt`；默认 `json`（`json_format`）→ `application/json` 含 `text`；`text` 是 `text/html; charset=utf-8`（不是 text/plain）— DOC/CODE | `file` — [DOC](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md)；可选 temperature、temperature_inc、prompt、carry_initial_prompt、response_format | N/A（`/inference` 无该字段）。`/load` 错误：**未知** |
| **whisper-asr-webservice**（ahmetoner） | **没有 `/v1/audio/transcriptions`**：只有 `POST /asr` 与 `/detect-language` — [DOC endpoints.md](https://github.com/ahmetoner/whisper-asr-webservice/blob/main/docs/endpoints.md) | 无 `model` 字段；启动时用 `ASR_MODEL`/`ASR_ENGINE` 指定 — [DOC README](https://github.com/ahmetoner/whisper-asr-webservice) | **无** — DOC | 不用 `response_format`；用查询参数 `output=text(默认)\|json\|vtt\|srt\|tsv`；json → `{"text","segments","language"}` — DOC | **`audio_file`**（不是 `file`）— DOC | **未知** |
| **LM Studio** | **无音频转写端点**（官方 OpenAI 兼容列表只有 `/v1/models`、`/v1/responses`、`/v1/decisions`、`/v1/chat/completions`、`/v1/embeddings`、`/v1/completions`）— [DOC openai-compat](https://lmstudio.ai/docs/developer/openai-compat)、[DOC rest](https://lmstudio.ai/docs-md/developer/rest) + 官方 issue [#1715](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1715)（未关闭） | — | — | — | — | — |
| **Ollama** | **无 `/v1/audio/transcriptions`**：OpenAI 兼容覆盖 chat/completions、responses、models、embeddings、completions 与 `/v1/audio/speech`（仅 TTS）— [DOC openai-compatibility](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx) | — | 本机服务"要求一个 key 值但忽略它" — DOC | — | — | — |
| 其他 | `fedirz/faster-whisper-server` 已是 **speaches 同一项目**（仓库跳转）— DOC。没有第二个满足"有可靠官方文档"的引擎，故不猜、不列 | — | — | — | — | — |

## 未能证实的项（保留为未知，不填猜测）

- vLLM：完全缺 `model` 字段时的状态码与 body；未知/多余表单字段是否 4xx。
- LocalAI：缺/错 `model` 的错误码与 body；未知表单字段处理；`response_format` 真实默认值（文档自相矛盾）；text/srt/vtt 的 Content-Type。
- coro-asr：`model` 是否必需；端点默认 `response_format`；确切 Content-Type；缺 model 的错误；未知字段处理。
- whisper.cpp：`/load` 的错误 body；未知表单字段是否 4xx；是否真的完全不校验 Authorization。
- whisper-asr-webservice：错误 body；未知字段处理。
- speaches / mlx-audio：未知/多余表单字段是否被拒（FastAPI 通常忽略，属 [INFER]，未证实）；mlx-audio 未知模型究竟是 404 还是 500。
- LM Studio / Ollama：是否存在未文档化的更新路由（只确认官方文档未列出）。
- 任何引擎都**没有实测**（未启动服务、未发请求）。

## 明确不兼容本插件当前契约的引擎

判定依据：始终 POST 到 `<base>/audio/transcriptions`、音频字段 `file`、请求 `response_format=json`、期望 JSON `{"text"}`。

1. **whisper-asr-webservice** — 路由（`/asr`）、字段（`audio_file`）、格式控制（`output` 查询参数，默认 `text`）三处都不同，且不是 OpenAI 形状。**不支持**，不做特判。
2. **LM Studio** — 无该路由。
3. **Ollama** — 无该路由（根本没有 STT 端点）。
4. **whisper.cpp server** — 默认不兼容（`/inference`，且无 `model` 字段）；用 `--inference-path /v1/audio/transcriptions` 启动后可用，此时 `model` 被它忽略（[INFER]，未证实）。
5. **mlx-audio** — 路由与字段没问题，但默认 `response_format` 是 `ndjson`；**必须**显式请求 `json`（本插件已经显式请求）。

## 对本插件的影响

- **结构兼容**（`<base>` 以 `/v1` 结尾时）：speaches、vLLM、LocalAI、mlx-audio、coro-asr。
- **`model` 必须可配置，且值必须是该引擎已加载/已服务的名字**：speaches、vLLM、mlx-audio 会据此校验，占位符会 404；coro-asr 忽略它；whisper.cpp 没有这个字段。这正是 [ADR-0004](../decisions/0004-model-id-writable-from-settings.md) 把 `model` 变成可从设置页写入的直接原因。
- **`response_format=json` 必须显式发送**：speaches/vLLM/mlx-audio/LocalAI 都遵守它并回 `application/json`；mlx-audio 不显式请求就会回 ndjson。本插件已如此，因此无需改动——但这一条不能回退成"省略格式参数"。
- **鉴权**：默认没有任何引擎要求 Bearer；启用后 speaches 回 403、vLLM 回 401。本插件把 401/403 都映射为 `unauthorized`（"凭据被拒绝"），与上述事实一致。
- **404 的两种成因**：vLLM 与 speaches 用 404 表示"模型未加载"，与"路径不对"同码。本插件因此**不**在 404 上断言"没有该接口"，而是在设置页并列提示两种可能（见 ADR-0004）。
- **不在本插件支持范围内的**：`audio_file` 字段、非 `/v1` 路径的引擎（whisper.cpp 默认、whisper-asr-webservice）。理由是这三处差异叠加会需要"可配路径 + 可配字段名 + 可配格式参数"三个开关，而那已不是 OpenAI 形状；宁可明确说不支持。

## 复核方式（当允许真机验证时）

1. 对每个候选引擎：`curl -sS -o /dev/null -w '%{http_code}'` 打一次真实上传，记录路由/字段/格式是否被接受。
2. 用本插件的设置页写入该引擎的模型名，观察 `speechrail_input_status` 的 `authenticated` 与 `failureCode`。
3. 把实测结果与本表逐行对照；凡有出入的，以实测为准并更新本文件（保留日期与来源）。
