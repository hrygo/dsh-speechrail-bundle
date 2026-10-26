# Third-party provenance

## DeepSeek Harness voice input baseline

- Copyright: Copyright (c) 2026 DeepSeek.
- License: MIT; full notice retained at [LICENSE](LICENSE) and [upstream LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE).
- Source: https://github.com/deepseek-ai/deepseek-harness
- Ref: `dsh-v0.2.1-rc.2`.
- Commit: `687f282e8625c6b8d11ff58211a90524be2e4317`.
- Imported paths: see [baseline manifest](upstream/baseline.json).

The archived files are unmodified source material, not a claim of endorsement by DeepSeek. Upstream package names, artwork, and descriptions remain in the archival snapshot only. A future independent release must use its own package identity, localized display metadata, and original or appropriately licensed artwork.

No model weights, recorded audio, third-party installed runtime, production credentials, or user transcripts are included. The original runtime asset *manifest* is retained solely as source evidence; this repository does not download those assets.

## Adapted implementation

`packages/voice-input/src/client/recording.ts` adapts the microphone capture lifecycle of
`upstream/deepseek-harness/packages/experimental/client-ui-voice-input/src/client/audio.ts`
(MIT, same ref and commit as above): a permission grant that settles after cancellation releases
its tracks, device interruption tears the capture down before the caller is notified,
MediaRecorder collects the chunks, and an `OfflineAudioContext` resamples to 16 kHz mono. The WAV
encoder is independently reimplemented in `src/protocol/wave.ts` and shared with the Host
validator instead of being copied. Nothing else is taken from upstream, and the bundle never
imports an upstream speech package at runtime.

## Workspace-only protocol shim

`packages/typert-protocol` is original code written for this repository: a declaration-only type
shim for the published `@deepseek-ai/dsh-typert-protocol`, required by the Typert generator's
package-discovery rules. It is private, unpublished, and never loaded at runtime.
