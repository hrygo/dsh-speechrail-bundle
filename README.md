# dsh-speechrail-bundle

An independent [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) voice-input
bundle that records in the browser and transcribes through a **local** SpeechRail service, using
the OpenAI-compatible file-transcription API. It does not require the official voice bundle to be
enabled, and it never talks to a remote endpoint: loopback only.

[中文说明](README.zh-CN.md) · [Package README](packages/speechrail-input/README.md) · [Design and review record](docs/superpowers/specs/2026-10-23-speechrail-input-design.md)

**Status: implemented and verified; not installed or enabled in any profile.**

## What it provides

| Face | What it does |
|---|---|
| Host | A SpeechRail service over a Strict Typert Remote surface: loopback-only uploads, credential **by reference**, a single in-flight gate, a non-sensitive pending journal, and stable failure codes. |
| Client | A composer microphone control with waveform, draft-insertion protection, and a settings page; zh/en localisation; a blocked gate can be cleared from either. |
| Agent | One read-only tool, `speechrail_input_status`, so a model can explain *why* voice input is unusable without opening settings. |

## Safety properties

- **Loopback only.** `http://127.0.0.1:<port>/v1` or `http://[::1]:<port>/v1`; anything else, and
  any URL carrying userinfo, is refused with a stable reason before a request is built.
- **The credential is never stored, logged, or returned.** The plugin resolves a reference through
  DSH credentials or settings and sends it as a bearer header; only the reference name and a
  boolean ever reach a client or the agent tool.
- **No transcript or audio is persisted.** The pending journal holds an operation id, a phase and a
  timestamp — nothing else — so a crash or reload cannot silently lose an upload whose outcome is
  unknown.
- **Nothing is uploaded twice.** The gate admits one operation at a time, and an unknown outcome
  blocks further uploads until it is explicitly acknowledged.
- **Advertised limits only change when the service states them.** A limit an unrecognised,
  unreachable, or limit-less capability response omits keeps the value already in force.

## Requirements

- DeepSeek Harness `>= 0.2.1-rc.2` (`engines.dsh`).
- Node `^22.19.0 || >=24.0.0`.
- A local SpeechRail service exposing `POST /v1/audio/transcriptions` and, optionally,
  `GET /v1/speechrail/capabilities`.
- A credential reference usable by the Host, for example `SPEECHRAIL_API_KEY`.

## Install

No npm package is published. Releases carry the packed bundle as a tarball asset; install it through
the Harness plugin manager, which performs package installation and bundle selection (do not
reproduce those steps by hand):

```
plugin_manager  action: install_bundle  target: https://github.com/hrygo/dsh-speechrail-bundle/releases/latest/download/dsh-speechrail-bundle.tgz
```

A checkout worktree works the same way (`target: <path to packages/speechrail-input>`), and the
local profile here runs this bundle at the latest release.

To upgrade, install the tag-pinned asset rather than the `latest` one: the plugin manager keys a
dependency by its target string, so re-running the command above on an installed bundle reports
`already-installed` instead of fetching the newer bytes.

```
plugin_manager  action: install_bundle  target: https://github.com/hrygo/dsh-speechrail-bundle/releases/download/v0.1.3/dsh-speechrail-bundle.tgz
```

Then set the endpoint and credential reference on its settings page.

## Verify

```bash
pnpm install
pnpm verify     # baseline check -> Typert generation -> both type checks -> bundles -> tests
pnpm test       # host and client unit tests (117; all mock or synthetic audio)
```

`pnpm verify` also re-checks the frozen upstream snapshot against
[upstream/baseline.json](upstream/baseline.json) and the pinned upstream commit. Nothing in this
repository contacts a real service, records audio, or runs inference.

The agent tool's definition is written structurally, so the compiler cannot check it against the
registry; `tools/check-tool-schema.mjs` compares it with `defineTool`'s compiled output and runs the
registry's own `assertSupportedJsonSchema`. Its header documents the temporary install that check
needs.

## Repository layout

- [packages/speechrail-input](packages/speechrail-input/) — the published bundle
  (`@hrygo/dsh-speechrail-bundle`): Host, client and protocol sources, its patch, locales and icon.
- [packages/typert-protocol](packages/typert-protocol/) — a private type shim that lets the Typert
  generator see this bundle's Remote declarations. Never published, never a runtime import.
- [upstream](upstream/) — the frozen, read-only official baseline (5 voice packages, MIT) plus a
  per-file source manifest; it is provenance, not a runtime entry point.
- [tools](tools/) — baseline-integrity and tool-schema checks.
- [docs](docs/) — design, implementation plan, and the record of four independent review rounds.

## Provenance and licence

The bundle is written against the official voice-input subsystem, snapshotted at upstream commit
`687f282e8625c6b8d11ff58211a90524be2e4317` (`dsh-v0.2.1-rc.2`), and adapts parts of the official
recording helper. MIT; see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md), which retain the upstream
copyright and attribution.
