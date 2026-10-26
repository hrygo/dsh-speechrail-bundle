<!-- Body for the awesome-dsh-plugin listing PR. One file, per contributing.md. -->

- [x] I added **one file** at `data/plugins/hrygo__dsh-speechrail-bundle--packages-voice-input.yml` — that single file is the whole submission. The READMEs are regenerated on `main` after merge: not edited by hand, not committed.
- [x] My repo's `package.json` declares **`dsh.bundle`** — in `packages/voice-input/package.json` (`{"bundle": {"patch": "./cordis.patch.yml"}, "client": {"platform": "web"}}`), with `cordis.patch.yml` beside it. The repository root is a pnpm workspace and declares none, which is why the entry uses the monorepo form.
- [x] My repo is at least **1 day old**
- [x] `category` is `voice`
- [x] Description states what the plugin does, no superlatives
- [x] My repo has the `dsh-plugin` topic

Notes for the reviewer:

- **Not published to npm.** The repository ships prebuilt tarballs on GitHub Releases, so the entry carries a `tarball:` pointing at `releases/latest/download/dsh-voice-input.tgz` — the version-free asset name the guide recommends, so it does not rot as releases are cut.
- **What it actually does**, so the entry can be checked against the code: a browser recording is transcribed by a loopback-only SpeechRail service (or any OpenAI-compatible engine on loopback); the host reads that service's capability snapshot and keeps its upload and duration limits, its language list and its credential verdict; an upload whose outcome cannot be proven keeps a closed gate until it is acknowledged; and one read-only tool reports that state to agents. It never activates profiles, writes credentials or performs recordings on its own.
