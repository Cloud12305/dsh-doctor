---
name: dsh-doctor
description: DSH 使用问题排查与自动修复。用户说 DSH 会话卡住、不回复、没反应、转圈不出字、消息排队、后台任务僵死、回合报错（配额/413/网络/过滤）、或问 DSH 出过什么问题/怎么解决时使用。提供根因分类（类型A回合报错 vs 类型B调度僵死）、经验库检索、队列救援与自动重启修复。
---

# dsh-doctor：DSH 问题根因定位与自动修复

配套插件已注册工具 `dsh_doctor_diagnose` / `dsh_doctor_fix` / `dsh_doctor_experience` / `dsh_doctor_status`。优先调用工具；工具不可用时用 CLI 等价命令（`node <插件目录>/bin/dsh-doctor.js <命令>`，插件目录通常为 `D:/05_Apps/DeepseekHarness/dsh-doctor`）。

## 排查流程（收到"卡住/不回复/报错"先走这里）

1. **先分类再修**：`dsh_doctor_diagnose`（指定 session 或全扫）。两类根因修法完全不同：
   - **类型 B 调度僵死**：消息入队（agent/inbox/spliced）后无 turn/start、无错误——唤醒逻辑静默失灵。**修复唯一可靠解法是重启 DSH**。
   - **类型 A 回合报错**：turn/end reason.kind=error，按错误码对表（配额/余额/413/网络/过滤/Codex schema）。
2. **别连点重发**：卡死时重发只会堆重复消息，恢复后每条各回一轮。
3. **修复（类型 B）**：
   - `dsh_doctor_fix action=rescue-queue session=<id>` 导出队列未发消息（重启会清队列！）。
   - `dsh_doctor_fix action=schedule-restart confirm=true` 延时 20s 自动重启（会打断所有进行中回合，先向用户说明）。
   - 重启后让用户照救援文件重发；后台任务结果用 `job_output` 重读，不用重跑。
4. **修复（类型 A）**：按工具返回的 advice 执行（换模型/等配额/开新会话/直接重发/换措辞）。
5. **收尾沉淀**：问题解决后调用 `dsh_doctor_experience action=learn`，把症状/根因/修复/预防写成条目（match 里写 errorCode 或 messagePattern 供下次自动命中）。

## 经验库速查（详见 ~/.dsh/dsh-doctor/knowledge/EXPERIENCE.md）

- B-01 调度僵死（通用）→ rescue + 重启；B-02 后台任务完成后僵死；B-03 dream 记忆轮批量注入集体僵死；B-04 停止按钮后僵死；B-05 重发堆积。
- A-01/A-02/A-03 配额·余额·用量 → 换供应商或等重置；A-04 413/上下文超窗 → 写交接开新会话；A-05 网络抖动 → 重发；A-06 content_filter → 换措辞；A-07 Codex+REA schema 不兼容 → 换 mimo；A-08 重试改推理档位 → 发新消息。
- OP-01 重启清队列（先 rescue）；OP-02 后台任务失控（while($true) 类）。

## 预防（转述给用户）

1. 长会话及时写交接开新会话（防 413）。
2. 回合收尾前收掉后台长任务；轮询脚本加超时。
3. 记忆插件 dream 整理轮降频/关禁用（已默认关）。
4. 带 REA 工具的回合别用 Codex 系模型。
5. 发消息 30 秒没动静先诊断，不要反复重发。

## 注意

- `schedule-restart` 会重启整个 DSH 桌面应用：执行前必须 rescue 并明确告知用户；工具要求 confirm=true 才执行。
- 看门狗默认自动修复（wedgeAfter 300s + 全局无回合 + 冷却 30min）；用户不想要自动重启时在插件 config 设 `watchdog.autoRestart: false`。
- 沉淀经验时不写密码、凭据、完整个人消息内容。
