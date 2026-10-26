# ADR-0005 界面颜色只取自 Harness 已声明的主题 token

- 状态：已接受（2026-10-26）
- 决策者：用户（"提升 ux ui"）；实施：本次会话
- 关联：[ADR-0001](0001-independent-voice-input.md)、[ADR-0002](0002-drop-always-on-dictation.md)、[ADR-0003](0003-unauthenticated-loopback-engines.md)、[ADR-0004](0004-model-id-writable-from-settings.md)、[设计文档](../superpowers/specs/2026-10-23-voice-input-design.md)、[演进路线](../roadmap/2026-10-25-plugin-evolution.md)

## 背景

本 bundle 不带样式表，全部外观都由内联样式给出，因此每个颜色都要自己写变量名与回退值。已发布版本里有三处变量的名字**不在** Harness 声明的 token 集内（2026-10-26 由 live Client `Theme.listTokens` 实测，共 14 个名字，每个都带 light/dark 两个值）：

| 本仓库曾用 | 实测是否声明 | 实际取到的颜色 |
|---|---|---|
| `--dsw-alias-content-secondary` | 否 | 回退值 `#8a8a8e` |
| `--dsw-alias-content-error` | 否 | 回退值 `#c0392b` |
| `--dsw-alias-border-secondary` | 否 | 回退值 `#d0d0d5` |

后果不是"报错"，而是**静默**：名字不存在时浏览器直接采用回退值，于是深色主题下这些位置仍按浅色主题的硬编码色渲染——例如设置页每个 `<input>` 都没有声明背景与文字色，深色主题下会落回浏览器默认的白底黑字。

## 选项

- **A. 保持现状**：改动最小，但每个未声明名字都等于把一个主题钉死成硬编码色，且没有测试会发现。
- **B. 只用已声明的 14 个 token，并保留回退值**（回退只在 token 系统整体缺失时生效，而不再承担"这个名字不存在"的日常路径）。
- **C. 自建一套组件级颜色常量**：**否**。那等于把主题切换排除在外，用户换主题时本插件不变，看起来像坏了。

## 决定

选 **B**。界面里出现的每个 `--dsw-*` 名字必须是 `Theme.listTokens` 声明过的；语义按 token 的描述选取：

- 文字：`--dsw-alias-label-primary` / `--dsw-alias-label-secondary`
- 边界：`--dsw-alias-border-l1`（弱）/ `--dsw-alias-border-l2`（强）
- 面：`--dsw-alias-bg-layer-2`（嵌套面，用于输入框与悬停面）；聚焦环：`--dsw-alias-brand-primary`
- 状态：`--dsw-alias-state-error-primary` / `-warn-` / `-success-`（进度用二级文字色，不算状态）

## 理由

- token 是 Harness 与插件之间**唯一**有承诺的颜色接口；声明集之外的变量名随时可能消失，而消失时是静默降级。
- 状态色承担语义：拒绝、警示、成功、进度此前共用同一个灰色，视觉上把最坏的状态画成了最好的状态。
- 这条约束可以自动化：`tests/theme-tokens.host.spec.ts` 扫描 `src/client/**` 中的每个 `--dsw-*` 名字并与声明集比对（声明集与来源日期写在测试里），漂移即失败。

## 代价与约束

- 声明集只有 14 个名字，表达力低于任意 CSS：例如没有"选择器底色""浮层阴影"这类 token，本插件的控件因此保持无阴影、无填充的克制外观。需要更强表达时应先向 Harness 申请 token，而不是自己造名字。
- 测试断言的是**名字**，不是配色方案；具体颜色仍由主题决定，本插件不保证对比度。
- jsdom 对 `var()` 的处理不一致（实测：`background` 简写与 `color`/`borderColor` 保留，`backgroundColor` 长写被丢弃），因此组件统一用 `background`，测试才能读到实际值。

## 复活条件（何时该重新评估）

- Harness 扩充声明集并覆盖阴影、浮层、选择器底色等表达时，可改用更贴切的 token。
- 若本插件将来接入样式表或官方 UI primitives 组件库，内联变量名不再是唯一接口，这条约束的适用范围应改为"该库的 token 用法"。
- 若某个已声明 token 的实际对比度被实测证明不可读（需要真人在浅色与深色主题下各看一次），则应改用同语义的另一个已声明 token，并把结论写回本 ADR。

## 审批

用户 2026-10-26 的"提升 ux ui"批准了本次范围内的界面改动；本 ADR 记录的是实施中发现的**未声明 token**这一具体缺陷及其处置方式，未扩大授权范围。
