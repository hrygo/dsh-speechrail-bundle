# dsh-voice-input

An independent voice-input plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It records in the browser and transcribes through a **local** service over the
OpenAI-compatible file-transcription API: the SpeechRail reference implementation, or any other
loopback engine with the same shape. It does not require the official voice bundle to be enabled,
and it never talks to a remote endpoint: loopback only.

[中文说明](README.zh-CN.md) · [Package README](packages/voice-input/README.md) · [Design record](docs/superpowers/specs/2026-10-23-voice-input-design.md) · [Changelog](CHANGELOG.md)

**Status: package 2.0.0, installed in this machine's `desktop` profile.** Every release is built by
`pnpm verify` (baseline check → Typert generation → both type checks → bundles → tests), published as
its own GitHub Release asset, and installed through the plugin manager at a tag-pinned URL; the
shipped bytes were compared against the repository build (sha256 `3be91316…`, 2026-10-26), and the
live Harness then reported `voice_input_status` as a tool and `voice-input-panel` as an active occupant
of `conversation.input.right`.

**Not verified by me:** what it looks like. Spacing, colours, motion and the dark-theme contrast are
claims about the styles that produce them, not about a screen I have seen. Real-microphone capture and
real-engine inference are also unverified here — this machine's runs are synthetic.

The plugin name and settings-page key are `dsh-voice-input`; its source directory is
`packages/voice-input`. SpeechRail names remain only where they identify engine or wire contracts
and the existing journal. See [the naming decision](docs/decisions/0006-name-the-plugin-dsh-voice-input.md).

## What it provides

| Face | What it does |
|---|---|
| Host | A local transcription service over the Strict Typert Remote namespace `speechrailInput`: loopback-only uploads, credential **by reference**, a single in-flight gate, a non-sensitive pending journal, and stable failure codes. |
| Client | One control in two seats: the microphone/waveform button in `conversation.input.activity` to the model selector's **right**; the timer, phase text, cancel, messages, insert-draft action and unproven-outcome acknowledgement in `conversation.input.right` to its **left** (cell id `voice-input-panel`). Transcripts enter the draft and are **never sent**. Settings use `plugins.bundle.config` with key `dsh-voice-input`; the rebindable command is `voice-input.dictate` (default `primary+shift+Space`). Includes zh/en localisation and acknowledgement in the composer and settings. |
| Agent | One read-only tool, `voice_input_status`, so a model can explain *why* voice input is unusable without opening settings: the endpoint, the credential's three-state verdict, whether the endpoint states it can transcribe, the language hint that will actually travel, the limits in force, the gate, and — when the gate is closed — the failure that left the attempt unconfirmed. |

The [2.x stability contract](packages/voice-input/README.md#stability-in-2x) freezes these identifiers,
seats, settings fields, draft insertion, wire behaviour and declared-token policy until a major version.

## Two engine profiles, one contract

| | SpeechRail (reference implementation) | Any other loopback OpenAI-shaped engine |
|---|---|---|
| Capability snapshot | `GET /v1/speechrail/capabilities` is read, and the limits and languages it states stay in force | 404/405: reported as `capabilities-absent`; the last snapshot stays in force, or the package defaults apply if there is none |
| Transcript | `{"text": ...}`; `usage` is ignored, including malformed values, and never surfaced as inference time | `{"text": ...}`, with or without `usage` |
| Credential | three states, never a guess: `accepted` only after a 200 answered the authenticated request, `refused` after a 401/403 (judged from the status alone), `unverified` when nothing judged it | same |
| Language | `auto` sends no hint; an enumerated domain admits only listed `zh`/`en` values; with no snapshot or an unknown language domain, `zh`/`en` travel as unverified hints. Explicitly unsupported transcription or languages admits only `auto`; unsupported transcription blocks recording. | same |
| Journal, single in-flight gate, acknowledgement | apply | apply — operation ids are client-generated, so the guards do not depend on the service |
| Enforced limits | stated limits clamped to the package ceilings; omitted limits keep their previous values | the last snapshot's limits, or package defaults (4 MiB / 120 s) if none is in force |

The synthetic servers in [`engines-conformance.host.spec.ts`](packages/voice-input/tests/engines-conformance.host.spec.ts)
exercise the Host core over loopback sockets for both profiles. They do not establish compatibility
with a running third-party engine.

## Safety properties

- **Loopback only.** `http://127.0.0.1:<port>/v1` or `http://[::1]:<port>/v1`; anything else, and
  any URL carrying userinfo, is refused with a stable reason before a request is built.
- **The credential is never stored, logged, or returned.** The plugin resolves a reference through
  the DSH credential store for each operation and sends it as a bearer header. The settings page
  receives the reference name and whether it resolved; the agent tool receives credential-presence
  booleans and the probe's `accepted` / `refused` / `unverified` verdict, never the reference name or
  key. A local engine that authenticates nobody is configured by clearing the reference, and the
  request then carries no `Authorization` header.
- **No transcript or audio is persisted.** The pending journal holds an operation id, a phase and a
  timestamp — nothing else — so a crash or reload cannot silently lose an upload whose outcome is
  unknown.
- **One attempt, no replay.** The gate admits one operation at a time. A cancel, timeout or network
  loss after the body was written leaves an unproven outcome (`outcome: unknown`, `gate: unknown`)
  and blocks another upload until explicit acknowledgement. A successful probe cannot clear it;
  acknowledgement accepts the risk and does not prove the engine stopped.
- **Settlement needs evidence.** A usable 200 response settles the operation. For failures, a 4xx
  other than 408 proves refusal; an unusable 200 body settles only with `Content-Length` framing.
  An unusable chunked or close-delimited 200 remains unproven. So do 5xx, 3xx, 408 and non-200 2xx
  replies (including 202), even if their bodies arrive. A journal that cannot be cleared also keeps
  the gate closed.
- **Advertised limits only change when the service states them.** A limit an unrecognised,
  unreachable, or limit-less capability response omits keeps the value already in force.
- **Declared theme tokens only.** Client theme colours use only declared Harness token names, guarded by
  [`theme-tokens.host.spec.ts`](packages/voice-input/tests/theme-tokens.host.spec.ts), with fallbacks
  for an absent token system. This is a source-level constraint, not visual verification; see
  [ADR-0005](docs/decisions/0005-declared-theme-tokens-only.md).

## Requirements

- DeepSeek Harness `>= 0.2.1-rc.2` (`engines.dsh`).
- Node `^22.19.0 || >=24.0.0`.
- A local service exposing `POST /v1/audio/transcriptions` in OpenAI's multipart shape and
  answering `{"text": ...}`. SpeechRail is the reference implementation (its `usage` extension and
  `GET /v1/speechrail/capabilities` snapshot are optional); any other loopback engine with the same
  transcription shape works, and a service without the capability endpoint is reported as
  `capabilities-absent` instead of broken.
- A credential reference usable by the Host, for example `SPEECHRAIL_API_KEY`. A local engine that
  needs no key is configured by clearing this reference instead: requests then carry no
  `Authorization` header at all. See [ADR-0003](docs/decisions/0003-unauthenticated-loopback-engines.md).

## Install

No npm package is published. Releases carry the packed bundle as a tarball asset; install it through
the Harness plugin manager, which performs package installation and bundle selection (do not
reproduce those steps by hand):

```
plugin_manager  action: install_bundle  target: https://github.com/hrygo/dsh-speechrail-bundle/releases/latest/download/dsh-voice-input.tgz
```

A checkout worktree works the same way (`target: <path to packages/voice-input>`).

For a later release under the same package name, install its tag-pinned asset rather than the
`latest` one: the plugin manager keys a dependency by its target string, so re-running the command
above on an installed bundle reports `already-installed` instead of fetching the newer bytes.

```
plugin_manager  action: install_bundle  target: https://github.com/hrygo/dsh-speechrail-bundle/releases/download/v2.0.0/dsh-voice-input.tgz
```

## Migrating from 1.x

The package name changed: **2.0.0 is a new dependency, not an upgrade of the 1.x dependency**.
Uninstall the old 1.x package through the Harness plugin manager before installing `dsh-voice-input`,
so both microphone controls are not left in the same profile. Use the 2.0.0 install command above.

Configuration is keyed by the package name. Re-enter the endpoint (`baseUrl`), credential reference
(`credentialRef`), language and model for the new entry; they do not carry over automatically.
The endpoint and credential reference belong in the entry config; language and model are writable
on the settings page, whose key is now `dsh-voice-input`. Restate a custom request budget too.

Unconfirmed-upload gate records remain readable: the journal unit deliberately keeps the name
`speechrail_input_pending`. Renaming the plugin does not erase an unproven upload or release its gate.
The Remote namespace `speechrailInput`, default reference `SPEECHRAIL_API_KEY`, engine path
`/v1/speechrail/capabilities` and GitHub repository name also stay unchanged. The
[naming decision](docs/decisions/0006-name-the-plugin-dsh-voice-input.md) explains the rationale
and migration cost.

## Configure your engine

Point the entry at your engine. The endpoint and the credential reference are entry config, so they
are changed by patching the entry in the profile's `cordis.patch.yml`; the model id is edited on the
bundle's settings page, together with the language and the request budget:

```yaml
- id: voice-input
  name: 'dsh-voice-input'
  config:
    baseUrl: http://127.0.0.1:8201/v1   # loopback only; the path must be /v1
    credentialRef: ''                   # empty: this engine authenticates nobody
```

A patch replaces the row's `config` wholesale instead of merging it, so restate every field the entry
relies on; anything omitted falls back to the schema defaults in the package README's configuration
table. If the change does not appear, restart the app.

## Other engines

Three things vary between engines, and all three are configuration here rather than code (engine by
engine, with sources: [回环 STT 引擎兼容性调研](docs/research/2026-10-25-local-stt-engine-contracts.md) —
documentation level, not measured on this machine):

- **The path.** Some engines serve a different route (`/inference`, `/asr`, …); those are normally
  pointed at the `/v1` shape with a start-up flag rather than handled specially here.
- **The `model` field.** Most OpenAI-shaped servers reject an upload that names no model, and validate
  the value against the weights they have loaded, so it has to name those exactly (a placeholder 404s).
  Set it on the settings page.
- **The credential.** A service that authenticates nobody is configured by clearing the reference (see
  ADR-0003 above); one that wants a bearer token needs a reference the Host can resolve.

## Known limitations

- Two status reads can be in flight at once (a check and a recording start, for example). The client
  ignores one that lands after a newer read has already been applied, but it cannot order two
  responses by their content: `revision` tracks settings writes, not the gate, so a response the
  service produced from an older snapshot can still be shown until the next read corrects it.
- The capability snapshot never expires. A failed or absent capability endpoint keeps the last
  snapshot and its limits in force; defaults (4 MiB / 120 s) apply only when there is no snapshot.
  No snapshot means transcription support is unknown and does not itself block recording; a
  recognized snapshot that does not state transcription as supported blocks it. Probing is explicit,
  not repeated before every upload.
- Language follows the snapshot in force:
  an enumerated list decides what is offered, a language the service states no support for is
  reported as not in effect rather than switched silently, and a service with no snapshot or an unknown
  language domain sends the mode you chose as an unverified hint —
  labelled on the settings page, named in the composer while the request is in flight, and reported
  as `languageHint` by the agent tool.
- The ceilings this package enforces are its own, and deliberately stricter than SpeechRail's: a
  historical SpeechRail service advertised 512 MiB and 3600 s. This bundle enforces 4 MiB and 120 s
  because a whole take travels as one base64 JSON carrier through the Remote surface. A take over either ceiling is
  refused by its real reason (`audio-too-long` / `audio-too-large`) rather than as a malformed
  recording.
- The request budget is bounded to 1000–180000 ms, by the settings schema and again on the Remote
  path, because the settings store validates shape rather than `min`/`max`.
- Changing a non-volatile setting (endpoint or credential reference) restarts the bundle's
  entry, which releases the journal storage unit and immediately opens it again. The release is
  fire-and-forget, and the backend rejects a second handle for a unit that is still open, so the new
  instance can transiently read the journal as unavailable (an unproven gate with a spurious
  acknowledgement prompt). Retrying the journal read can heal it; this is not an upload retry.
  Model, language and request budget are volatile and do not restart the entry.
- The erase used by an unreadable-record acknowledgement reads the slot and then writes it, and the
  storage service offers no compare-and-set. An operation recorded between those two steps is
  therefore erased (the gate itself stays correct: the host re-checks who holds it afterwards). The
  window is two awaits wide and only exists while an unreadable slot is being acknowledged.
- The Host resolves the configured reference through the Harness credential store on each request;
  the secret is held only for that request, never persisted or returned by this plugin.
- The activity seat is single-occupant. This plugin never reports expansion; if another activity
  occupant expands, the composer hides the standard controls, including this plugin's left report.
  Slot registration does not promise conflict-free coexistence with other microphone plugins.
  Visual placement and coexistence in a live Harness have not been verified in this update.

## Verify

```bash
pnpm install
pnpm verify     # baseline check -> Typert generation -> both type checks -> bundles -> tests
pnpm test       # host and client unit tests (all mock or synthetic audio)
node tools/check-release-consistency.mjs  # version and documented tag URLs
```

`pnpm verify` runs the baseline check, Typert generation, both type checks, Host and client bundles,
journal-unit, release-URL, package-content and optional tool-schema checks, then the tests.
It also re-checks the frozen upstream snapshot against
[upstream/baseline.json](upstream/baseline.json) and the pinned upstream commit. Nothing in this
verification sequence requires a real engine, microphone recording, or inference; transport tests
use synthetic loopback servers. Running the installed plugin is a separate runtime action.

The agent tool's definition is written structurally, so the compiler cannot check it against the
registry; `tools/check-tool-schema.mjs` compares it with `defineTool`'s compiled output and runs the
registry's own `assertSupportedJsonSchema`. Its header documents the temporary install that check
needs.

## Repository layout

- [packages/voice-input](packages/voice-input/) — the published bundle
  (`dsh-voice-input`): Host, client and protocol sources, its patch, locales and icon.
- [packages/typert-protocol](packages/typert-protocol/) — a private type shim that lets the Typert
  generator see this bundle's Remote declarations. Never published, never a runtime import.
- [upstream](upstream/) — the frozen, read-only official baseline (5 voice packages, MIT) plus a
  per-file source manifest; it is provenance, not a runtime entry point.
- [tools](tools/) — baseline-integrity and tool-schema checks.
- [docs](docs/) — design, implementation plan, and the record of the independent review rounds and
  what each one changed.

## Provenance and licence

The bundle is written against the official voice-input subsystem, snapshotted at upstream commit
`687f282e8625c6b8d11ff58211a90524be2e4317` (`dsh-v0.2.1-rc.2`), and adapts parts of the official
recording helper. MIT; see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md), which retain the upstream
copyright and attribution.
