# @hrygo/dsh-speechrail-bundle

Voice input for DeepSeek Harness, backed by a local [SpeechRail](https://127.0.0.1) service
over its OpenAI-compatible `/v1/audio/transcriptions` endpoint.

The bundle is independent: it reuses no `dsh-experimental-*` speech package at runtime and
talks to one loopback service with one credential. It owns the Host service, the
authenticated Remote surface and the browser face.

## Install

There is no npm package. Install the released tarball through the Harness plugin manager, which
performs package installation and bundle selection (do not reproduce those steps by hand):

```
plugin_manager  action: install_bundle  target: https://github.com/hrygo/dsh-speechrail-bundle/releases/latest/download/dsh-speechrail-bundle.tgz
```

A checkout worktree works the same way (`target: <path to packages/speechrail-input>`).

To upgrade an installed bundle, install the tag-pinned asset: the plugin manager keys a dependency by
its target string, so the `latest` command above answers `already-installed` instead of fetching newer
bytes.

```
plugin_manager  action: install_bundle  target: https://github.com/hrygo/dsh-speechrail-bundle/releases/download/v0.1.9/dsh-speechrail-bundle.tgz
```

Then set the endpoint and the credential reference on the bundle's settings page.

## What it does

- Records through the browser microphone, resamples to canonical 16 kHz mono WAV and uploads
  it exactly once.
- Inserts the transcript into the current composer draft without touching the draft's later
  edits: a captured `TokenSpan` guards the insertion, and a refused insertion is kept for the
  user to apply.
- Probes connectivity and the advertised capability snapshot (`/v1/speechrail/capabilities`)
  to bound upload size and duration, and to offer only the languages the service enumerates.
- Persists language and request budget through the Harness settings page.
- Registers one read-only agent tool, `speechrail_input_status`, that reports the effective
  endpoint, credential and service state, the limits in force, and whether an earlier recording
  still needs acknowledgement. It never uploads audio, never changes the gate, and never carries
  a credential or a transcript.

## Security boundaries

| Boundary | Behaviour |
| --- | --- |
| Endpoint | Loopback only (`http://127.0.0.1:<port>/v1`, `[::1]`); no query, fragment, credentials or non-`/v1` path. Never proxied: the request pins `agent: false`, so Node's opt-in `NODE_USE_ENV_PROXY` / `--use-env-proxy` cannot route the credential or the audio anywhere. |
| Credential | Resolved per operation from the Harness credential store; never persisted, logged, or sent anywhere but the configured loopback origin. |
| Payloads | Bounded JSON carrier text; unknown fields are refused, not dropped. |
| Audio | Validated WAV only, duration derived on the Host from the bytes, absolute ceilings independent of what the service advertises. |
| Unproven outcome | A cancel, timeout or network loss after the body was written marks the outcome `unknown`, holds the gate and forbids replay until the user acknowledges it. If the stored record cannot be read at all, acknowledging asserts that nothing is outstanding and clears the slot; a medium that cannot be written refuses instead. |
| Journal | A durable pending record is written before the upload; if local storage is unavailable the feature refuses to upload at all. |
| Failures | Clients receive a closed code, HTTP status, retryable flag, request id and outcome. No body, message, path, credential or transcript text crosses the boundary. |
| Agent tool | `speechrail_input_status` reads the same status projection as the settings page: booleans and short strings only, no audio and no upload. It contacts the service only when the caller asks for a probe. |

## Configuration

The entry `speechrail-input` (inserted by `cordis.patch.yml`) exposes:

| Field | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8201/v1` | Loopback only; normalized on every operation. |
| `model` | empty | Empty omits the field and lets the service choose; non-empty values are validated by the service per profile. |
| `credentialRef` | `SPEECHRAIL_API_KEY` | Credential reference; a service without an API key needs none configured. |
| `language` | `auto` | `auto` omits the field entirely; `zh`/`en` are only accepted when the snapshot enumerates them. |
| `requestTimeoutMs` | `150000` | One budget covering connect, upload, inference and download (1000–180000). |

## Build and verification

```bash
pnpm install
pnpm verify            # baseline snapshot + generation + typecheck + bundles + tests
pnpm run gen:typert    # regenerate lib/typert.* from the Host surface
pnpm test              # host and client unit tests
```

`pnpm verify` runs, in order: the frozen upstream baseline check, Typert generation,
`tsc -b` over both faces, the host and client bundles, and the unit tests.

The agent tool registers only where the Harness offers its tools service; the definition is
declared structurally rather than through `@deepseek-ai/dsh-tools`, because importing that
package's declarations pulls an unrelated Typert lookup into the analyzed program and fails
generation. The compiler therefore cannot check the schema against the registry, and an
unsupported keyword would leave the tool silently unregistered. `tools/check-tool-schema.mjs`
closes that gap against the registry's own assertion; its header documents the temporary install
that the check needs and that must not be left in place.

### Why `packages/typert-protocol` exists

The Typert generator only recognises `@Remote` and `TypertRemoteService` when those symbols are
declared inside a package registered under `<workspace>/packages` whose manifest name is exactly
`@deepseek-ai/dsh-typert-protocol`. Out-of-monorepo bundles depend on the published npm package
and therefore satisfy neither condition, so generation reports "publishes Remote artifacts but
has no Remote methods".

`packages/typert-protocol` is a private, never-published **declaration-only type shim** that
restores the topology for the generator. `tsconfig.base.json` maps the bare specifier to it, so
type resolution sees the shim while bundling and runtime keep resolving the published package
(`lib/index.js` still imports `@deepseek-ai/dsh-typert-protocol`). Nothing depends on the shim,
so pnpm never links it. `tests/typert-protocol-parity.host.*` proves the published package still
exports the same symbols and that this bundle's decorator and constructor pattern also compiles
against the published declarations.

## Known limitations

- The microphone device picker is not implemented; the system default input device is used.
- The only model-facing entry point is the read-only `speechrail_input_status`; there is no tool
  that starts a recording or an upload.
- A snapshot that reports transcription as unsupported admits no language and refuses an upload
  before it is sent, with the stable `unsupported` code; a null snapshot states nothing, so it is
  never treated as such a refusal.
- The unproven-outcome path requires an explicit acknowledgement in the composer or settings
  page, and the composer offers that control whenever the gate is blocked; there is no automatic reconciliation with the service's own record. An unreadable
  journal is acknowledged by asserting that nothing is outstanding, which cannot be verified
  locally — the alternative would be a permanently blocked feature.
- The capability snapshot is used opportunistically: any body carrying
  `operations.transcription` yields a view. Every limit the snapshot does not state keeps the
  value already in force, so an unreachable service, an unrecognized body, or a recognized
  endpoint that omits its input limits can never widen what this host accepts. A limit the
  snapshot does state is taken, bounded by the package's absolute ceilings. The flip side is
  that a snapshot does not expire: if the service later loosens or tightens its own limits, a
  fresh check is what updates them.
- This repository builds and tests the bundle. It does not activate it in any Harness profile,
  does not write credentials, and never performs a real recording or inference on its own.

## Attribution

The browser capture lifecycle in `src/client/recording.ts` adapts the MIT-licensed capture
implementation of the frozen upstream baseline; see `NOTICE.md`.
