# 变更日志

按版本倒序。「行为」列是用户能感知的变化，细节见对应 release 页（每一条的完整说明、证据与未核实项都在那里）。

安装方式与版本号无关：`plugin_manager install_bundle` 指向 tag 固定的 URL（见各 README）。本文件与
[`packages/speechrail-input/package.json`](packages/speechrail-input/package.json) 的版本号由
`tools/check-release-consistency.mjs` 与 README 里的安装 URL 一处绑定。

## 1.0.0 — 稳定契约，按钮与报告分居模型选择器两侧

- **界面布局**：麦克风按钮移到模型选择器**右侧**（composer 的 activity 席位），按动后产生的计时、阶段文字、取消、消息与「插入草稿」留在模型选择器**左侧**（`conversation.input.right` list 席位）。一次录音由两个席位共同绘制，状态因此移出组件、放进插件生命周期的 `SpeechRailControl`（[control.ts](packages/speechrail-input/src/client/control.ts)）。
- **精修**：悬停面与聚焦环带 120ms 过渡；系统开启「减少动态效果」时过渡与旋转一并关闭（等待阶段改为静止环）；旋转指示器与麦克风同为 16px；取消字形居中排版；设置页输入框聚焦时边框变色且不夺走原生焦点环；语言注意事项移到选项组之外；转写能力那一行不再把状态说两遍。
- **图标与对比度**：插件图标改为自带底板的成品图标——原先用 `currentColor` 描边，被当作图片加载时（市场条目的形态）会被画成近黑，深色底上不可见；底板与字形对比 5.6:1，底板对白底 5.6:1、对近黑底 3.4:1，由 `tests/icon.host.spec.ts` 计算守卫，并在白底/深底上渲染核验。composer 圆按钮与操作胶囊改用较重的 `border-l2`（`border-l1` 是分隔线轻重），等待阶段的光标不再降到 55% 透明度——那时它是唯一的进度信息，保持全对比。
- **稳定承诺**：见 [README 的 Stability 一节](packages/speechrail-input/README.md#stability-in-1x)。测试 319 个用例，23 个文件。

## 0.12.0 — 控件与设置页一眼可读

- composer：录音计时 `m:ss`；等待阶段用旋转指示器取代半透明静态麦克风，控件可访问名随阶段变化；消息按语义着色（进度/警示/拒绝/确认）；所有控件有悬停面与焦点环。
- 设置页：三组具名区域；`model` 与请求超时补上 `<label>` 关联，语言行为 `radiogroup`；输入框显式声明背景与文字色（深色主题此前回退成白底）；提示按结果着色。
- 修掉一处**静默缺陷**：三个 token 名不在 Harness 声明集内（实测 14 个名字），名字不存在时浏览器采用硬编码回退值，深色主题下仍是浅色配色。[ADR-0005](docs/decisions/0005-declared-theme-tokens-only.md)

## 0.11.0 — 麦克风移到模型选择器左侧

- 席位从 `conversation.input.activity` 改为 `conversation.input.right`（`order: 20`，紧贴模型选择器之前）。原因：activity 是 single 席位且展开时 composer 会隐藏普通配件控件，正是「点击后声波跑到左侧」的机制。
- 副作用如实记录：与占用 activity 的官方 bundle 不再争同一格；两个麦克风可同屏；官方 bundle 录制时本包控件消失；该席位不提供 `locked`，权威判定仍是插入时刻的 `insertText`。

## 0.10.0 — 麦克风原位变成波形

- 点击后控件在自己位置上变成实时波形（不再要求 composer 展开），取消键移到控件之后，停止并入波形按钮；转写结果自动插入草稿且**从不提交**。

## 0.9.0 — 从键盘开始，模型名可在设置页填写

- 注册可重绑、带冲突检查的快捷键命令（`primary+shift+Space`）；`model` 改为设置页可写（[ADR-0004](docs/decisions/0004-model-id-writable-from-settings.md)）；补上引擎契约调研与 fixture。

## 0.8.1 — 卡片文案与上架准备

- 只改文案与上架材料，无代码变化（246 个用例仍是那一套）。

## 0.8.0 — 支持 DSH 0.2.1-rc.3

- 兼容性响应，运行时行为未变：请求形状、gate、journal 与能力快照与 0.7.1 同一份代码。

## 0.7.1 — 对运行中的服务做过实证

- 请求形状在运行中的服务上得到验证；CI 真正跑 registry 检查；移除两个死导出。运行时行为未变。

## 0.7.0 — 原因属于持有 gate 的那个操作

- 两个原本靠人眼检查的面现在有守卫；不可用的分块应答保持 unproven 并把原因告诉用户。

## 0.6.0 — 框定规则有守卫，原因有出处

- 两个面现在能说「为什么 gate 是关的」；release 自身有守卫，版本、tag 与文档里的安装 URL 不会再悄悄漂移。

## 0.5.0 — 词汇表封闭，gate 关闭的原因说出来

- 修复 0.4.0 评审的三项（其中一项是本轮自己引入的缺陷）。

## 0.4.0 — 说出真正的拒绝，实测运行时范围

- 处理 0.3.0 对抗性评审的九项发现；声明的 Node 版本改为实测。

## 0.3.0 — 证明完成的应答，保留可用的转写

- 修掉长录音导致的请求解析崩溃；转写在解析失败时仍可用。
