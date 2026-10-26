# 独立 SpeechRail bundle 设计审查记录

- 日期：2026-10-23，Asia/Shanghai。
- 对象：[设计 Draft 2](../superpowers/specs/2026-10-23-voice-input-design.md)、[ADR-0001](../decisions/0001-independent-voice-input.md)、本地基线校验工具。
- 状态：Draft 2 独立复核通过；无未关闭架构阻断项，等待用户批准。
- 用户实施批准：**未获得**。审查通过也不得自动实施。

## 1. 审查分工与范围

| 审查者 | 视角 | 边界 |
|---|---|---|
| `a8c11586-3eb9-4b0c-bb95-d8f59a10a795` | 独立架构/安全五维审查 | 正确性、可读性、架构、安全、性能；只读审查 |
| `318908af-60e4-4ef9-9044-93faa5029d97` | Builder Checker，未参与设计 | 找出错误猜测会实质改变实施计划的关键问题；只读审查 |

另有两位只读调研者提供 DSH 复用/构建与 SpeechRail 协议/凭据证据，不把作者或调研者意见替代独立审查。

没有产品构建、插件安装/启用、profile变更、麦克风、真实推理或密钥读取。主代理执行的 Python 测试仅验证官方基线的来源校验工具，不是插件产品测试。

## 2. Draft 1 审查与修订

### R1：reload 不能丢失远端未结案门禁——必须修订

原设计只定义 Host 当前实例的在途 gate，卸载后新实例可能经 check 进入 ready，绕过 outcome-unknown 风险确认。

Draft 2 第7节：POST 前先持久化自有非敏感 pending(operationId/phase/time)，成功后才发送；重载恢复为 outcome-unknown。只有已知终态或当前ID的用户确认才能清理；失败/损坏状态 fail-closed，不保存音频、正文、密钥，不恢复重放。第10节新增在途POST→卸载→重载→检查不能解除门禁的 mock 场景。

复用已核实 DSH Storage 与 json backend 的 single/durable 形式；不增加通用任务框架。该行为尚未实现，必须在批准后的产品测试中证明。

### R2：校验工具没有绑定固定 commit:path——必须修订

原 [校验工具](../../tools/verify-upstream.py) 只按清单自报 blob 查询 Git 对象，不能排除其他合法 blob 被冒充为该路径。

已改为 `git ls-tree -r -z <fixed commit> -- <selected paths>` 获取权威路径清单，再按 path 比对实际内容 hash、清单 blob ID 与 pinned blob ID。清单重复、数量不符、路径集不同也失败。

[回归测试](../../tools/test_verify_upstream.py) 用固定 LICENSE 路径配上另一个真实上游 README 的完整内容，并同步更新所有自报校验值，以验证攻击场景：

- 历史 baseline tag 中的旧工具：正常路径通过，错误路径测试失败，证明旧工具确有缺口。
- 当前工具：2/2 测试通过，错误路径场景被拒绝。
- 完整基线：108 文件 SHA-256 / Git blob ID / 固定commit路径集通过。

此修订只影响本仓库基线校验工具；归档的108个官方文件没有改变。

### N1：默认 normal codec 不等于 Host 严格业务输入——非阻断提醒

Builder Checker 指出 generator 默认 normal codec 可能先strip对象未知键。Draft 2 第8节明确使用有界JSON字符串carrier保留业务键，Host先限长再严格验证；测试必须经Remote入口。其语义只约束插件业务payload，不改DSH传输envelope。

### N2：独立构建未实测——保留批准后门禁

公开 generator API 与 npm 版本元数据已核实，不等于独立 build/pack/mount 通过。保留为批准后的第一门禁；失败停报，不复制整个DSH或退回弱校验。没有因此把未来实验当成当前已完成结果。

## 3. 离线验证命令

```bash
# 重现历史校验缺口：预期其中1个测试失败，不能误报当前失败
BASELINE_VERIFIER_REF=baseline/official-voice-input-0.2.1-rc.2 \
  python3 -m unittest discover -s tools -p 'test_*.py' -v

# 当前工具：2/2通过
python3 -m unittest discover -s tools -p 'test_*.py' -v

# 当前完整官方基线：108文件通过
python3 tools/verify-upstream.py --git
```

上面只访问本地临时测试目录与已经获取的Git对象，不安装依赖、不访问模型服务。

## 4. 复核与审批边界

两位独立审查者已复核Draft 2：

- 架构/安全审查者：确认R1/R2在方案与工具层面关闭，未发现新架构阻断或必须修订项；结论为“方案审查通过（不等于用户批准或产品已验证）”。
- Builder Checker：确认journal与JSON carrier的增量内容足以制定后续计划；结论为“Draft 2 nothing important left，无必须修订项”。

两位复核者均未执行产品测试、安装、服务操作，也未独立重跑主代理的基线回归测试。该复核为静态设计审查，不等于可运行插件验收。

用户尚未选择或批准任何实施范围。只提交方案供批准，不执行产品任务。安装/启用当前profile、凭据新增落盘、真实录音/推理、UI自动化、远程仓库/发布继续分别受用户授权限制。
