# dsh-voice-input

Voice input for DeepSeek Harness, backed by a local service over its OpenAI-compatible
`/v1/audio/transcriptions` endpoint: [SpeechRail](https://github.com/hrygo/speechrail) as the
reference implementation, or any other loopback engine with the same shape.

The bundle is independent: it reuses no `dsh-experimental-*` speech package at runtime and
talks to one loopback service with one credential. It owns the Host service, the
authenticated Remote surface and the browser face.

## Install

There is no npm package. Install the released tarball through the Harness plugin manager, which
performs package installation and bundle selection (do not reproduce those steps by hand):

```
plugin_manager  action: install_bundle  target: https://github.com/hrygo/dsh-speechrail-bundle/releases/latest/download/dsh-voice-input.tgz
```

A checkout worktree works the same way (`target: <path to packages/voice-input>`).

For a later release under the same package name, install its tag-pinned asset: the plugin manager
keys a dependency by its target string, so the `latest` command above answers `already-installed`
instead of fetching newer bytes.

```
plugin_manager  action: install_bundle  target: https://github.com/hrygo/dsh-speechrail-bundle/releases/download/v2.0.1/dsh-voice-input.tgz
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
[naming decision](../../docs/decisions/0006-name-the-plugin-dsh-voice-input.md) explains the rationale
and migration cost.

## Configure your engine

Point the entry at your engine. The endpoint and the credential reference are entry config, so
they are set by patching the `voice-input` entry in the profile's `cordis.patch.yml`; the model id
is editable on the bundle's settings page together with the language and the request budget. A patch
replaces that row's `config` wholesale rather than merging it, so restate every field the entry relies
on; anything omitted falls back to the schema defaults in the
[configuration table](#configuration).

```yaml
- id: voice-input
  name: 'dsh-voice-input'
  config:
    baseUrl: http://127.0.0.1:8201/v1   # loopback only; the path must be /v1
    credentialRef: ''                   # empty: this engine authenticates nobody
```

The settings page is not a config editor for the first two fields: it **shows** the endpoint and the
credential reference and **persists** the model, the language and the request budget. Changing the
endpoint or the credential reference means editing the entry (and restarting the app if the change does
not appear).

## What it does

- Draws one control in two seats. The round microphone/waveform button registers in
  `conversation.input.activity`, to the model selector's **right**; everything a press produces -
  the running-time counter, phase text, cancel, messages, insert-draft action and unproven-outcome
  acknowledgement - registers in `conversation.input.right` (cell id `voice-input-panel`, order 20),
  to the model selector's **left**. A live take never moves the button out from under the click.
  One state machine
  ([`src/client/control.ts`](src/client/control.ts)) backs both halves, and it is disposed with the
  plugin rather than with a component, so a composer remount cannot drop a take.
- Records through the browser microphone, resamples to canonical 16 kHz mono WAV and uploads
  it in one attempt, with no silent retry or cloud fallback.
- Inserts the transcript into the current composer draft without touching the draft's later
  edits: a captured `TokenSpan` guards the insertion, and a refused insertion is kept for the
  user to apply with “Insert into draft”. It **never sends** the draft.
- Probes connectivity and, when the service offers it, the advertised capability snapshot
  (`/v1/speechrail/capabilities`) to bound upload size and duration and to determine language options.
  Enumerated languages constrain the selector; no snapshot or an unknown language domain permits
  `zh`/`en` as unverified hints. `auto` always omits the field. A service that does not implement
  that endpoint is used as a plain transcription endpoint instead (see [Other engines](#other-engines)).
- Persists language, model and request budget through `plugins.bundle.config`, keyed by
  `dsh-voice-input`; these volatile fields apply without restarting the entry.
- Registers one rebindable keyboard command, `voice-input.dictate` (default
  <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Space</kbd>, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd>
  elsewhere), so a dictation can be started and finished without the mouse: one press starts from
  idle, the next ends the capture and transcribes it. Cancelling stays on <kbd>Esc</kbd> and on the
  row's own control, so a mis-press never discards a take. The chord is editable in the Harness
  keyboard shortcut settings and is arbitrated by that registry: a composition without it simply has
  no command, and a rejected registration (a duplicate id or an overlapping default) costs the
  shortcut rather than the microphone.
- Registers one read-only agent tool, `voice_input_status`, that reports the effective
  endpoint, credential and service state, the limits in force, and whether an earlier recording
  still needs acknowledgement, and, while the gate is closed because of one, the failure that left
  that attempt unconfirmed. It never uploads audio, never changes the gate, and never carries a
  credential or a transcript.

## Stability in 2.x

2.0.0 is the same product under the name the ecosystem expects (`dsh-voice-input`), so the frozen
contract restarts here with the new identifiers. Through 2.x, without a major version:

- **Seats and keys.** The button stays in `conversation.input.activity` and the report stays in
  `conversation.input.right` with cell id `voice-input-panel`; the settings page stays on
  `plugins.bundle.config` under `dsh-voice-input`; the keyboard command id stays
  `voice-input.dictate`; the agent tool stays `voice_input_status`. A name change here breaks
  someone's composition file, so it needs a major version.
- **Settings fields.** `baseUrl`, `credentialRef`, `language`, `model` and `requestTimeoutMs` keep their
  names and meanings, and `model` stays the one writable field that the service may validate against the
  weights it has loaded ([ADR-0004](../../docs/decisions/0004-model-id-writable-from-settings.md)).
- **Insertion.** A transcript is inserted into the draft through a captured `TokenSpan` and is never
  submitted; a refused insertion keeps the text for the user to apply.
- **The wire.** One OpenAI-shaped `POST /v1/audio/transcriptions` per take, one attempt, no silent
  retry, no cloud fallback; loopback endpoints only
  ([ADR-0003](../../docs/decisions/0003-unauthenticated-loopback-engines.md)).
- **Theme.** Only colours the Harness declares ([ADR-0005](../../docs/decisions/0005-declared-theme-tokens-only.md)).

What 2.x does **not** promise: a fixed DSH version. This package declares `engines.dsh >= 0.2.1-rc.2`,
and the release that verified the harness against 0.2.1-rc.3 was 0.8.0; a harness change that removes a
service this plugin injects is a compatibility break to report, not a promise this README can make.
Visual presentation (spacing, colours, motion) is deliberately not frozen.

## Other engines

The transcription call is OpenAI-shaped, so an engine that is not SpeechRail works as long as it
speaks the same shape on loopback:

| Expectation | Detail |
| --- | --- |
| Upload | `POST <base>/audio/transcriptions`, `multipart/form-data` with `file` (16 kHz mono WAV), `response_format=json`, plus `model` only when non-empty and `language` only when the configured `zh`/`en` hint is admitted by the snapshot rules below (`auto` omits it). `Authorization: Bearer <credential>`, or no `Authorization` header at all when the credential reference is cleared for an engine that authenticates nobody. Engines that require a `model` field are the common reason to configure one. |
| Transcript | A 200 whose JSON body carries a string `text`. The optional SpeechRail `usage` extension is ignored, even when malformed; it cannot discard usable text and is never reported as inference time. |
| Capabilities | Optional. When `GET <base>/speechrail/capabilities` answers 404 or 405 the probe reports `capabilities-absent`: the service stays reachable and usable, and the limits already in force keep applying (the package's absolute ceilings are never exceeded). 401/403 stay `unauthorized`, every 5xx (including 501) stays `server-error` with its retryable hint, and an unreachable service stays `unreachable`. |
| Credential state | Reported in three states, never as a boolean guess: `accepted` only after a 200 answered the authenticated request, `refused` after a 401/403 (from the status alone, even when the body that followed was unusable), and `unverified` whenever nothing judged it (no response, a missing endpoint, a server error, a refused endpoint, or a request that carried no credential at all). The `voice_input_status` tool returns the same three strings, plus whether this endpoint was configured to present a credential in the first place. |
| Agent report | The tool reports the language hint that will **actually travel** (not the configured mode), the endpoint's own statement about transcription (`supported` / `unsupported` / `unknown`), and the language modes the snapshot admits. A service that says it cannot transcribe is named as such instead of reading as usable. |

What varies between engines is configuration here, never code. Engines confirmed against their own docs
and source, with unknown rows left unknown, are in
[回环 STT 引擎兼容性调研](../../docs/research/2026-10-25-local-stt-engine-contracts.md) (documentation
and source level, **not measured on this machine**, by decision):

- **Route.** The call is always `<base>/audio/transcriptions`. **speaches, vLLM, LocalAI, mlx-audio and
  coro-asr** serve exactly that; an engine that serves something else (`/inference`, `/asr`, …) is
  normally started with a flag that moves it onto the `/v1` shape, and this plugin has no per-engine
  path special case and does not guess.
- **`model`.** **Required** by speaches, vLLM and mlx-audio (validated against the weights that engine
  has loaded, so a placeholder 404s), required in LocalAI's documented usage, ignored by coro-asr, and
  not a field at all in whisper.cpp. Set it on the settings page to whatever the engine calls its
  loaded weights; leaving it empty is only right for an engine that picks its own.
- **Response shape.** `response_format=json` is honoured by speaches, vLLM, mlx-audio and LocalAI.
  mlx-audio's *default* is `application/x-ndjson`, so it depends on that parameter being sent — this
  plugin always sends it. whisper.cpp answers `text/html` for its `text` format; this plugin never asks
  for it and refuses a non-JSON body rather than guessing.
- **Credential.** No engine requires a bearer token by default. speaches answers **403** and vLLM
  **401** when the key it was started with is missing or wrong, which this plugin reports as
  `unauthorized`. A cleared `credentialRef` sends no `Authorization` header at all.
- **404 has two causes.** vLLM and speaches answer 404 for a model that is not loaded, not only for a
  wrong route, so a 404 is never reported as "no such endpoint" on its own.
- **Not supported on purpose.** whisper-asr-webservice (`/asr`, field `audio_file`, `output` query
  parameter instead of `response_format`) is a different API shape, not a variation of this one; making
  it fit would take three configuration knobs and stop being the OpenAI contract.

What changes on a non-SpeechRail engine, and what does not:

- The journal, the single in-flight gate and the acknowledgement control all still apply. They are
  driven by locally generated operation ids, not by anything the service returns: an upload that is
  accepted and never answered still ends as an unproven outcome, still holds the gate and still
  needs the acknowledgement before another recording may start.
- The capability snapshot is the only thing that disappears. With none in force the enforced limits
  are the package defaults (4 MiB / 120 s) rather than anything the service stated, and the settings
  page labels them as such.
- Language follows what the service can actually do, in three cases: a snapshot that enumerated
  languages offers exactly those and sends the admitted mode; a service that **can transcribe but
  never listed its languages** (no snapshot at all, or `languages.status: unknown` — SpeechRail's own
  answer, whose transcription endpoint documents `language` as a hint) offers every known mode and
  sends the one you chose as an unverified hint, labelled as such on the settings page; and a service
  that reports transcription as unsupported offers `auto` alone. Nothing is ever switched silently —
  a language the service states no support for is shown as "not in effect".
- Discovery is fixed: only `/v1/speechrail/capabilities` is consulted, never `/v1/models`, so an
  engine without that endpoint is permanently "unstated" by construction. `usage` is likewise no
  longer evidence that the response came from SpeechRail — its absence is accepted on purpose.
- A take that is refused for its length or size is named as such: `audio-too-long` and
  `audio-too-large` distinguish "speak for less time" and "send less audio" from a malformed
  recording, including a take too large to fit the transport that carries it. When the service states
  a reason of its own, that reason is used rather than the status code alone (a declared
  `audio_decode_failed` is an audio problem, and a declared 429 is throttling worth retrying).
- `model` is sent only when configured. Configure the engine's own model id (or leave it empty for
  engines that ignore the field). A wrong id is reported according to the response: HTTP 404 is
  `not-found`; HTTP 400 with `error.code: model_not_found` is `model-not-found`; other ordinary
  400/422 refusals are `bad-request`. The plugin does not infer a missing route from 404 alone.
- A snapshot that already said `transcriptionSupported: false` stays in force through a
  `capabilities-absent` probe (a snapshot never expires), so an endpoint that used to advertise an
  unsupported operation keeps refusing uploads until a later probe replaces it.
- The unproven-outcome message follows the same rule: while a snapshot is in force it tells the user
  to check the service's record, and with none in force it says the attempt is in the local journal,
  because on an engine with no operation ids there is no service record to look for.
- A snapshot that reports transcription as unsupported refuses **before the microphone opens** rather
  than after a full dictation (the host would refuse the upload anyway, before the audio leaves the
  machine). A service without a snapshot is never blocked at that point.

## Security boundaries

| Boundary | Behaviour |
| --- | --- |
| Endpoint | Loopback only (`http://127.0.0.1:<port>/v1`, `[::1]`); no query, fragment, credentials or non-`/v1` path, and no DNS. Never proxied: the request pins `agent: false`, so Node's opt-in `NODE_USE_ENV_PROXY` / `--use-env-proxy` cannot route the credential or the audio anywhere (measured on Node 26.11.1: the same call through the default agent did reach the proxy). A redirect answer is refused with the stable `redirected` code and the target never sees the request. |
| Credential | Resolved per operation from the Harness credential store; never persisted, logged, or sent anywhere but the configured loopback origin. An empty reference omits the header entirely, and the probe then reports the credential as `unverified` — a 200 with no credential on the wire judged no credential. |
| Payloads | Bounded JSON carrier text; unknown fields are refused, not dropped. |
| Audio | Validated WAV only, duration derived on the Host from the bytes, absolute ceilings independent of what the service advertises. |
| Unproven outcome | A cancel, timeout or network loss after the body was written marks `outcome: unknown` and `gate: unknown`. 3xx, 408, 5xx and non-200 2xx replies also stay unproven. A usable 200 settles; an unusable 200 settles only with `Content-Length` framing (unusable chunked or close-delimited replies stay unproven). A 4xx other than 408 proves refusal. Journal-clear failure keeps the gate closed too. A probe cannot clear an unproven gate: explicit acknowledgement in the left composer panel or settings accepts the risk, without proving backend completion or replaying audio. |
| Journal | A durable pending record is written in `speechrail_input_pending` before the upload; it contains only an operation id, phase and timestamp, never audio, text or credentials. An unavailable journal blocks uploads. Acknowledging an unreadable record asserts that nothing is outstanding; corrupt bytes can be cleared, but a medium that cannot be read or written refuses instead. |
| Failures | Clients receive a closed code, HTTP status, retryable flag, request id and outcome. No body, message, path, credential or transcript text crosses the boundary. |
| Agent tool | `voice_input_status` reads the same status projection as the settings page: booleans and short strings only, no audio and no upload. It contacts the service only when the caller asks for a probe. |

## Configuration

The entry `voice-input` (inserted by `cordis.patch.yml`) exposes the following fields. Endpoint
and credential-reference changes restart the entry; model, language and request budget are volatile.
The settings-page key is the package name, `dsh-voice-input`.

| Field | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8201/v1` | Loopback only; normalized on every operation. |
| `model` | empty | Empty omits the field and lets the service choose; most OpenAI-shaped engines **require** it and validate the value against the weights they have loaded (so a placeholder 404s). Editable on the settings page ([ADR-0004](../../docs/decisions/0004-model-id-writable-from-settings.md)), bounded at 200 characters. |
| `credentialRef` | `SPEECHRAIL_API_KEY` | Credential reference, resolved per operation. **Cleared means this endpoint needs no credential**: requests then carry no `Authorization` header at all. A non-empty reference that resolves to nothing is refused with `not-configured` rather than sent unauthenticated, so a typo in a reference name stays visible ([ADR-0003](../../docs/decisions/0003-unauthenticated-loopback-engines.md)). |
| `language` | `auto` | `auto` omits the field. An enumerated language domain admits only listed `zh`/`en`; with no snapshot or an unknown language domain they are unverified hints. Unsupported languages admit only `auto`; unsupported transcription also blocks recording. |
| `requestTimeoutMs` | `150000` | One budget covering connect, upload, inference and download (1000–180000). |

## Build and verification

```bash
pnpm install
pnpm verify            # baseline snapshot + generation + typecheck + bundles + tests
pnpm run gen:typert    # regenerate lib/typert.* from the Host surface
pnpm test              # host and client unit tests
```

`pnpm verify` runs, in order: the frozen upstream baseline check, Typert generation,
`tsc -b` over both faces, the Host and client bundles, journal-unit, release-URL, package-content
and optional tool-schema checks, then the unit tests. For this README-only update, run
`node tools/check-release-consistency.mjs` to check the version against all three documented tag URLs;
that check does not verify release-asset availability, installation or runtime behaviour.

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

**Display metadata.** The plugin manager builds the card from files in this package, not from
the registry: `locale/en.json` (plus the locale files beside it) supplies `meta.title` and
`meta.description`, `package.json` supplies `name`/`description` as fallbacks, and `package.json`
`icon` is inlined as a data URI (SVG/PNG/JPEG/WebP, up to 256 KiB). When none of it lands the card
still renders - as the bare install spec, which for this plugin is a release URL. That is why
`tests/metadata.host.spec.ts` treats those two files as release-critical rather than cosmetic.

## Known limitations

- The activity seat is single-occupant, so coexistence with other microphone plugins is not
  guaranteed. This plugin never reports expansion; another activity occupant expanding hides the
  composer's standard controls, including this plugin's left report. Its shared controller survives
  component remounts, but cannot prevent the composer from hiding that seat.
- Visual placement, colours, motion, live microphone capture and real-engine inference have not been
  verified in this documentation update. The theme-token guard checks declared names, not rendered
  appearance or contrast.
- The microphone device picker is not implemented; the system default input device is used.
- The only model-facing entry point is the read-only `voice_input_status`; there is no tool
  that starts a recording or an upload.
- A snapshot that reports transcription as unsupported admits no language and refuses an upload
  before it is sent, with the stable `unsupported` code; a null snapshot states nothing, so it is
  never treated as such a refusal. A service without the capability endpoint keeps the last
  snapshot it ever advertised in force, exactly like any other failed probe.
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
