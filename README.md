# dsh-speechrail-bundle

An independent [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) voice-input
bundle that records in the browser and transcribes through a **local** service over the
OpenAI-compatible file-transcription API: the SpeechRail reference implementation, or any other
loopback engine with the same shape. It does not require the official voice bundle to be enabled,
and it never talks to a remote endpoint: loopback only.

[中文说明](README.zh-CN.md) · [Package README](packages/speechrail-input/README.md) · [Design and review record](docs/superpowers/specs/2026-10-23-speechrail-input-design.md)

**Status: implemented, verified, and running in this machine's `desktop` profile.** Every release
is built by `pnpm verify` (baseline check → Typert generation → both type checks → bundles → tests)
and installed through the plugin manager from its own GitHub Release asset, after which the shipped
files are byte-compared against the repository build.

## What it provides

| Face | What it does |
|---|---|
| Host | A SpeechRail service over a Strict Typert Remote surface: loopback-only uploads, credential **by reference**, a single in-flight gate, a non-sensitive pending journal, and stable failure codes. |
| Client | A composer microphone control with waveform, draft-insertion protection, and a settings page; zh/en localisation; a blocked gate can be cleared from either. |
| Agent | One read-only tool, `speechrail_input_status`, so a model can explain *why* voice input is unusable without opening settings: the endpoint, the credential's three-state verdict, whether the endpoint states it can transcribe, the language hint that will actually travel, the limits in force, the gate, and — when the gate is closed — the failure that left the attempt unconfirmed. |

## Two engine profiles, one contract

| | SpeechRail (reference implementation) | Any other loopback OpenAI-shaped engine |
|---|---|---|
| Capability snapshot | `GET /v1/speechrail/capabilities` is read, and the limits and languages it states stay in force | no such endpoint: reported as `capabilities-absent`, the package defaults apply and the settings page labels them as defaults |
| Transcript | `{"text": ...}`; the `usage` duration extension is accepted, validated and never surfaced as inference time | `{"text": ...}`, with or without `usage` |
| Credential | three states, never a guess: `accepted` only after a 200 answered the authenticated request, `refused` after a 401/403 (judged from the status alone), `unverified` when nothing judged it | same |
| Language | sent when the snapshot enumerates it; a service that transcribes without listing languages receives the configured mode as an unverified hint | same |
| Journal, single in-flight gate, acknowledgement | apply | apply — operation ids are client-generated, so the guards do not depend on the service |
| Enforced limits | the service's numbers, clamped to this package's own ceilings | the package defaults (4 MiB / 120 s) |

Both profiles are pinned by `tests/engines-conformance.host.spec.ts`, which drives the real Host core
over real loopback sockets against both kinds of engine and asserts what each one is reported to be.

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
- **Only a refusal opens the gate again.** A status that reached the client settles the pending
  journal only when it proves the service did not process the upload - a 4xx other than 408 - or when
  the service answered 200 and the answer itself was unusable. A 5xx (a gateway may have given up
  while an upstream worker kept transcribing), a 3xx, a 408 and a 202 "accepted" all leave the
  outcome unproven, so the gate keeps asking instead of inviting a second dictation over work that
  may still be running.
- **Advertised limits only change when the service states them.** A limit an unrecognised,
  unreachable, or limit-less capability response omits keeps the value already in force.

## Requirements

- DeepSeek Harness `>= 0.2.1-rc.2` (`engines.dsh`).
- Node `^22.19.0 || >=24.0.0`.
- A local service exposing `POST /v1/audio/transcriptions` in OpenAI's multipart shape and
  answering `{"text": ...}`. SpeechRail is the reference implementation (its `usage` extension and
  `GET /v1/speechrail/capabilities` snapshot are optional); any other loopback engine with the same
  transcription shape works, and a service without the capability endpoint is reported as
  `capabilities-absent` instead of broken.
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
plugin_manager  action: install_bundle  target: https://github.com/hrygo/dsh-speechrail-bundle/releases/download/v0.6.0/dsh-speechrail-bundle.tgz
```

Then set the endpoint and credential reference on its settings page.

## Known limitations

- Two status reads can be in flight at once (a check and a recording start, for example). The client
  ignores one that lands after a newer read has already been applied, but it cannot order two
  responses by their content: `revision` tracks settings writes, not the gate, so a response the
  service produced from an older snapshot can still be shown until the next read corrects it.
- A capability the service does not state is treated as unsupported rather than assumed, and a
  service that does not implement the capability endpoint keeps the last snapshot it ever
  advertised: the enforced limits are then the package defaults, shown as such on the settings page.
  The snapshot never expires; the only re-probe is an explicit check, and re-probing before every
  upload was rejected because it would add a round trip after the user has already spoken.
- Language is the one deliberate exception to that rule, and it follows what the service can *do*:
  an enumerated list decides what is offered, a language the service states no support for is
  reported as not in effect rather than switched silently, and a service that transcribes without
  listing its languages (SpeechRail answers this way) sends the mode you chose as an unverified hint —
  labelled on the settings page, named in the composer while the request is in flight, and reported
  as `languageHint` by the agent tool.
- The ceilings this package enforces are its own, and deliberately stricter than SpeechRail's: a
  live service advertises 512 MiB and 3600 s, this bundle enforces 4 MiB and 120 s, because a whole
  take travels as one base64 JSON carrier through the Remote surface. A take over either ceiling is
  refused by its real reason (`audio-too-long` / `audio-too-large`) rather than as a malformed
  recording.
- The request budget is bounded to 1000–180000 ms, by the settings schema and again on the Remote
  path, because the settings store validates shape rather than `min`/`max`.
- Changing a non-volatile setting (endpoint, model, credential reference) restarts the bundle's
  entry, which releases the journal storage unit and immediately opens it again. The release is
  fire-and-forget, and the backend rejects a second handle for a unit that is still open, so the new
  instance can transiently read the journal as unavailable (an unproven gate with a spurious
  acknowledgement prompt). A retry heals it; awaiting the release would remove the window.
- The erase used by an unreadable-record acknowledgement reads the slot and then writes it, and the
  storage service offers no compare-and-set. An operation recorded between those two steps is
  therefore erased (the gate itself stays correct: the host re-checks who holds it afterwards). The
  window is two awaits wide and only exists while an unreadable slot is being acknowledged.
- The bundle never reads or stores the credential itself: it resolves the configured reference name
  through the Harness credential store on each request.

## Verify

```bash
pnpm install
pnpm verify     # baseline check -> Typert generation -> both type checks -> bundles -> tests
pnpm test       # host and client unit tests (all mock or synthetic audio)
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
- [docs](docs/) — design, implementation plan, and the record of the independent review rounds and
  what each one changed.

## Provenance and licence

The bundle is written against the official voice-input subsystem, snapshotted at upstream commit
`687f282e8625c6b8d11ff58211a90524be2e4317` (`dsh-v0.2.1-rc.2`), and adapts parts of the official
recording helper. MIT; see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md), which retain the upstream
copyright and attribution.
