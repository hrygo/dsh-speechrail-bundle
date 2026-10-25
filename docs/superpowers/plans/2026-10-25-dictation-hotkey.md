# 语音输入快捷键（Dictation Hotkey）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 composer 的语音输入加一个可改键的键盘命令，让用户不碰鼠标就能开始 / 结束一次转写。

**Architecture:** 新增一个与 React 无关的"触发器"通道（`createDictationTrigger`）连接两个互不认识的半边：官方 `ctx.shortcuts` 命令在按下时调用它，`VoiceInput` 组件在挂载时订阅它。命令本身由一个纯工厂 `createDictateCommand` 产出，因此可以在没有 Cordis Context 的情况下单测。`shortcuts` 服务按可选依赖注入，缺失或注册冲突时只失去快捷键，不影响录音。

**Tech Stack:** TypeScript、React 18（jsdom + Testing Library）、tsdown、vitest、Cordis 插件（Host + Client）、`@deepseek-ai/dsh-client-shortcuts` 提供的 `ctx.shortcuts`。

**Spec:** [docs/roadmap/2026-10-25-plugin-evolution.md](../roadmap/2026-10-25-plugin-evolution.md) §3「阶段一的规格」。该文件同时给出本计划的上位排序与授权边界。

**Precondition（先决条件，不是任务）:** 只有当 Stage 0 的真实使用结论是"障碍在触发方式，而不是识别质量或延迟"时才执行本计划。若结论相反，回到路线文档改走阶段 2。

## Global Constraints

- 不改动现有按次录音流程的行为：按钮、Escape 取消、blur/visibility 取消、门禁与 journal 语义保持不变。
- 不新增运行时依赖；客户端运行时仍只 `require` `react`、`react/jsx-runtime`、`zod`。
- 默认快捷键必须与既有键位不冲突：Enter 发送、Ctrl/Cmd+Enter 互补投递、Shift+Enter 换行、Escape 停止、Esc Esc 停止序列、Tab 命令菜单。
- 冲突或注册失败**不得**让客户端面挂载失败：捕获后降级为"没有快捷键"，并在日志中说明。
- 一切注册经 `ctx.effect` 随插件卸载释放。
- 新增文案必须中英各一份，键名加进 `src/client/locales.ts`；仓库已有的静态键守卫会扫描 `src/client/*.ts` 里的 `t('…')`。
- 音频与转写正文不进日志、不进 fixture、不进仓库。
- 完成判据：`pnpm verify` 退出码 0。

## Review Focus

1. **默认键与既有命令冲突。** 注册会在默认键重叠时**抛错**（"duplicate ids and overlapping default bindings throw"）。若未捕获，整个客户端面挂载失败、麦克风消失——比没有快捷键严重得多。
2. **没有可用的 composer。** 无 Session 时 `inputActions` 为 `undefined`；此时按快捷键必须返回可本地化的 `blocked`，而不是抛错、也不要静默。
3. **插件卸载后快捷键残留。** 改非易失设置会重启 entry；已释放的注册若仍能触发，会去驱动一个已经卸载的组件。
4. **录制中再次按下。** 第二次按下应当是"停止并转写"（等价于 ■），不是"取消"（等价于 ×，Escape 已有），也不能导致重复上传。
5. **locked 状态。** composer 的麦克风按钮在 `locked` 时是 `disabled`（`VoiceInput.tsx:365`），而 `start()` 自己也拒绝（`VoiceInput.tsx:267`）。快捷键必须与之一致：`locked` 时不可用，而不是"报告已处理但什么都没发生"。

---

### Task 1: 触发器通道

**Files:**
- Create: `packages/speechrail-input/src/client/trigger.ts`
- Test: `packages/speechrail-input/tests/trigger.client.spec.ts`

**Interfaces:**
- Produces:
  - `interface DictationTrigger { available(): boolean; toggle(): void; subscribe(handler: () => void): () => void }`
  - `function createDictationTrigger(): DictationTrigger`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createDictationTrigger } from '../src/client/trigger.ts'

describe('dictation trigger', () => {
  it('is unavailable until a control subscribes', () => {
    const trigger = createDictationTrigger()
    expect(trigger.available()).toBe(false)
    const off = trigger.subscribe(() => undefined)
    expect(trigger.available()).toBe(true)
    off()
    expect(trigger.available()).toBe(false)
  })

  it('forwards a toggle to every subscriber and survives one that throws', () => {
    const trigger = createDictationTrigger()
    const seen = vi.fn()
    const off = trigger.subscribe(() => { throw new Error('controller died') })
    const off2 = trigger.subscribe(seen)
    expect(() => { trigger.toggle() }).not.toThrow()
    expect(seen).toHaveBeenCalledTimes(1)
    off()
    off2()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/trigger.client.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/client/trigger.ts"`

- [ ] **Step 3: Implement `createDictationTrigger` in `packages/speechrail-input/src/client/trigger.ts`**

A `Set` of handlers plus `available()` = `handlers.size > 0`; `toggle()` iterates a **copy** of the set and swallows per-handler throws (`console.error`), so one broken subscriber cannot block the others.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/trigger.client.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/speechrail-input/src/client/trigger.ts packages/speechrail-input/tests/trigger.client.spec.ts
git commit -m "feat(client): add a dictation trigger channel"
```

---

### Task 2: 命令定义与文案

**Files:**
- Create: `packages/speechrail-input/src/client/command.ts`
- Modify: `packages/speechrail-input/src/client/locales.ts` (add 4 keys: `zh` and `en` each get `shortcut.dictate`, `shortcut.unavailable`)
- Test: `packages/speechrail-input/tests/command.client.spec.ts`

**Interfaces:**
- Consumes: `DictationTrigger` from Task 1.
- Produces:
  - `type Translate = (key: string) => string` —— 本模块自己的最小类型，不依赖 locale 包的类型
  - `const DICTATE_COMMAND_ID: ShortcutCommandId`
  - `function createDictateCommand(t: Translate, trigger: DictationTrigger): ShortcutCommand`
  - `function registerDictateCommand(shortcuts: ShortcutRegistry, t: Translate, trigger: DictationTrigger): () => void`，其中 `type ShortcutRegistry = { register(command: ShortcutCommand): () => void }`；返回注册得到的 disposer，注册抛错时记一条 `console.error` 并返回空 disposer
  - 每个 profile 的默认绑定：`{ code: 'Space', modifiers: ['primary', 'shift'] }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { DICTATE_COMMAND_ID, createDictateCommand, registerDictateCommand } from '../src/client/command.ts'
import { createDictationTrigger } from '../src/client/trigger.ts'

const t = (key: string): string => key

describe('dictate command', () => {
  it('declares one identity, a localizable label and a default for every profile', () => {
    const command = createDictateCommand(t, createDictationTrigger())
    expect(command.id).toBe(DICTATE_COMMAND_ID)
    expect(command.label()).toBe('shortcut.dictate')
    expect(Object.keys(command.defaults).sort()).toEqual([
      'desktop:linux', 'desktop:macos', 'desktop:windows',
      'web:linux', 'web:macos', 'web:windows',
    ])
    expect(command.defaults['desktop:macos']).toEqual({ code: 'Space', modifiers: ['primary', 'shift'] })
    expect(command.regions).toEqual(['page', 'editable'])
  })

  it('blocks with a localized reason while no control is mounted', () => {
    const resolution = createDictateCommand(t, createDictationTrigger()).resolve({ region: 'page', modal: null, target: null })
    expect(resolution).toEqual({ status: 'blocked', reason: 'shortcut.unavailable' })
  })

  it('handles the press by toggling the mounted control once', () => {
    const trigger = createDictationTrigger()
    let toggles = 0
    const off = trigger.subscribe(() => { toggles += 1 })
    const resolution = createDictateCommand(t, trigger).resolve({ region: 'editable', modal: null, target: null })
    expect(resolution.status).toBe('handled')
    if (resolution.status !== 'handled') throw new Error('unreachable')
    resolution.run()
    expect(toggles).toBe(1)
    off()
  })

  it('degrades to no hotkey when the registry refuses the registration', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const refusing = { register: () => { throw new Error('overlapping default bindings') } }
    const dispose = registerDictateCommand(refusing, t, createDictationTrigger())
    expect(typeof dispose).toBe('function')
    expect(() => { dispose() }).not.toThrow()
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })

  it('returns the registry disposer when the registration is accepted', () => {
    const released = vi.fn()
    const accepting = { register: () => released }
    registerDictateCommand(accepting, t, createDictationTrigger())()
    expect(released).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/command.client.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `command.ts`**

Brand the id with the inline one-line helper (precedent: the third-party `dsh-image-gen` bundle in this profile inlines `brandString` instead of depending on `@deepseek-ai/dsh-brand`), and note the alternative import in a comment. `resolve` returns `blocked` + `t('shortcut.unavailable')` when `trigger.available()` is false, otherwise `handled` with `run: () => trigger.toggle()`. Set `aliases: []` and `modals: []`.

- [ ] **Step 4: Add the four locale strings to `src/client/locales.ts`**

`zh`：`shortcut.dictate: '开始或结束语音输入'`、`shortcut.unavailable: '当前没有可用的输入框'`；
`en`：`shortcut.dictate: 'Start or finish voice input'`、`shortcut.unavailable: 'No composer is available right now'`。

- [ ] **Step 5: Run tests and the locale guard**

Run: `pnpm exec vitest run tests/command.client.spec.ts tests/locales.client.spec.ts`
Expected: PASS (the locale guard reports every static key present in both dictionaries)

- [ ] **Step 6: Commit**

```bash
git add packages/speechrail-input/src/client/command.ts packages/speechrail-input/src/client/locales.ts packages/speechrail-input/tests/command.client.spec.ts
git commit -m "feat(client): define the dictation shortcut command"
```

---

### Task 3: 让组件响应触发器

**Files:**
- Modify: `packages/speechrail-input/src/client/VoiceInput.tsx` (extend `SpeechRailInjected` with `dictation: DictationTrigger`; subscribe in the existing mount effect)
- Test: `packages/speechrail-input/tests/voice-input.client.spec.tsx` (add cases; reuse the existing harness in that file)

**Interfaces:**
- Consumes: `DictationTrigger` (Task 1).
- Produces: `SpeechRailInjected` gains `dictation: DictationTrigger`；一次切换在 `idle` 开始采集、在 `recording` 结束并转写；`locked` 时不订阅，因此 `available()` 为 false。

- [ ] **Step 1: Write the failing test**

Add to the existing file (it already imports `render`, `screen`, `waitFor`, `vi` and owns the `props()` helper；把 `act` 加进 `@testing-library/react` 的导入，把 `createDictationTrigger` 与 `type DictationTrigger` 加进源码导入）：

```tsx
/** The same stub shape the neighbouring cases use, plus the injected trigger. */
function harness(dictation: DictationTrigger, overrides: { locked?: boolean } = {}) {
  const transcribe = vi.fn(async () => ({ ok: false, transcript: null, failure: null }))
  const capture = { start: async () => undefined, stop: async () => new Uint8Array([0]), dispose: async () => undefined }
  const element = (
    <VoiceInput
      {...{
        ...props({}, async () => ({ ok: true, pendingOperationId: null, failure: null })),
        ...overrides,
        dictation,
        transcribe,
        createRecording: () => capture,
      }}
    />
  )
  return { element, transcribe }
}

describe('VoiceInput dictation trigger', () => {
  it('starts from idle, finishes while recording, and is unavailable while locked', async () => {
    const dictation = createDictationTrigger()
    const { element, transcribe } = harness(dictation)
    const view = render(element)

    await waitFor(() => { expect(dictation.available()).toBe(true) })
    act(() => { dictation.toggle() })
    // `start()` opened the capture, so the row shows its stop control.
    await screen.findByRole('button', { name: 'stop' })

    act(() => { dictation.toggle() })
    await waitFor(() => { expect(transcribe).toHaveBeenCalledTimes(1) })

    view.rerender(harness(dictation, { locked: true }).element)
    await waitFor(() => { expect(dictation.available()).toBe(false) })
  })
})
```

若 jsdom 没有提供 `crypto.randomUUID`（`start()` 会用到），在该文件顶部用 `vi.stubGlobal('crypto', { randomUUID: () => 'op_test' })` 补上，而不是改产品代码。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/voice-input.client.spec.tsx`
Expected: FAIL — the trigger is ignored and `available()` is false

- [ ] **Step 3: Implement the subscription**

In the existing `useEffect` that installs the window listeners, subscribe to `dictation` **only while `locked` is false**（`if (locked) return`），把最新的 toggle 放进一个 ref（每次渲染更新），并在同一个 cleanup 里连同既有监听一起退订。被订阅的回调按 phase 选择：`idle` → `start()`，`recording` → `finish()`，其余 `checking`/`requesting`/`transcribing`/`feedback` 什么都不做。订阅条件带 `locked` 是刻意的：它让 `available()` 的含义是"此刻有一个已挂载、且会接受切换的控件"，命令据此返回 `blocked`。把 `locked` 加进该 effect 的依赖列表。

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/voice-input.client.spec.tsx`
Expected: PASS, including every pre-existing case in the file

- [ ] **Step 5: Commit**

```bash
git add packages/speechrail-input/src/client/VoiceInput.tsx packages/speechrail-input/tests/voice-input.client.spec.tsx
git commit -m "feat(client): let the dictation trigger drive the composer control"
```

---

### Task 4: 接上 `ctx.shortcuts`、清单与降级

**Files:**
- Modify: `packages/speechrail-input/src/client/mount.ts`
- Modify: `packages/speechrail-input/package.json` (`devDependencies` + `dsh.client.inject`)

**Interfaces:**
- Consumes: `createDictationTrigger` (Task 1)、`registerDictateCommand` (Task 2)、the `dictation` field of `SpeechRailInjected` (Task 3).

- [ ] **Step 1: Extend the manifest**

In `packages/speechrail-input/package.json`: add `"@deepseek-ai/dsh-client-shortcuts": "0.2.1-rc.3"` to `devDependencies` (types only, matching the `dsh-client-ui-renderer` pattern) and append `"@deepseek-ai/dsh-client-shortcuts"` to `dsh.client.inject`. Do **not** add it to `peerDependencies` or `dependencies`.

- [ ] **Step 2: Wire it in `mount.ts`**

Create the trigger once in `mountSpeechRailInput`, pass it into `actions` as `dictation`, and register the command in its own optional injection next to the existing one:

```ts
ctx.inject(['shortcuts'], (shortcutCtx) => {
  const t = shortcutCtx.locale.bind(NS)
  shortcutCtx.effect(() => registerDictateCommand(shortcutCtx.shortcuts, t, trigger))
})
```

Keep `registerUi`'s existing injection list unchanged, so a composition without `shortcuts` still gets a working microphone.

- [ ] **Step 3: Verify the chord is free and the plugin still loads**

Run: `pnpm verify`
Expected: exit code 0 (baseline check → Typert generation → both type checks → bundles → tests)

Then, in the running Harness: open the keyboard-shortcuts settings, confirm a `speechrail-input.dictate` row exists, that it shows `⌘⇧Space` (macOS), that changing it persists, and that **no conflict row** is reported. If the row reports a conflict, change the default in `command.ts` to `{ code: 'KeyM', modifiers: ['primary', 'shift'] }`, re-run `pnpm verify`, and record the change in the commit message.

- [ ] **Step 4: Verify the two dangerous paths by hand**

With the composer focused, press the chord: capture starts; press again: it stops and the transcript is inserted. Then open a workspace with no Session and press the chord: the app must report "no composer is available right now" rather than throwing or doing nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/speechrail-input/src/client/mount.ts packages/speechrail-input/package.json
git commit -m "feat(client): register the dictation shortcut through ctx.shortcuts"
```

---

### Task 5: 记录与交接

**Files:**
- Modify: `packages/speechrail-input/README.md` (the composer row of the feature table)
- Modify: `README.md` and `README.zh-CN.md` (the Client row of "What it provides")
- Modify: `docs/roadmap/2026-10-25-plugin-evolution.md` (§3 status)

- [ ] **Step 1: Document the command**

State the default chord, that it is rebindable in the Harness shortcut settings, that it is toggling rather than hold-to-talk, and that a composition without the shortcuts plugin simply has no hotkey.

- [ ] **Step 2: Verify the release guards still pass**

Run: `pnpm verify`
Expected: exit code 0 — the guards check README install URLs, package contents and locale keys, so a README edit that breaks a pattern fails here.

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh-CN.md packages/speechrail-input/README.md docs/roadmap/2026-10-25-plugin-evolution.md
git commit -m "docs: record the dictation shortcut"
```
