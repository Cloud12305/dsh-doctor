# dsh-doctor

> DSH（DeepSeek Harness）使用问题「经验库 + 根因诊断 + 自动修复」插件：会话卡死、后台任务僵死、配额/上下文/网络报错，一键定位根因、自动救援修复、持续沉淀经验。

把使用 DSH 过程中反复遇到的问题整理成结构化经验库（症状 → 根因 → 修复 → 预防），提供会话事件日志级的根因诊断（自动区分「回合报错」与「调度僵死」两类根因），并对最常见的「会话僵死」提供队列救援 + 自动重启的全自动修复。附带独立 CLI——**会话卡死时也能在终端直接用**。

## 功能特性

| 能力 | 说明 |
|---|---|
| 📚 **经验库** | 内置 16 条实战经验（卡死 5 类、报错 9 类、运维 2 类），按错误码/原文正则/僵死场景自动匹配；`learn` 随时追加新经验，自动生成人读版 `EXPERIENCE.md` |
| 🔍 **根因诊断** | 解析 `session.v4.jsonl.zstd` 事件日志：区分**类型 A 回合报错**（QUOTA / 余额 / 413 超窗 / 网络断流 / content_filter / Codex schema 等）与**类型 B 调度僵死**（消息入队后回合永不启动），输出证据时间点 + 匹配条目 + 修复步骤 |
| 🔧 **自动修复** | ① 队列消息救援导出（重启不丢话）② 确认僵死且全局无回合时自动延时重启 DSH（重启前二次救援、30 分钟冷却）③ 疑似失控后台任务（无限轮询类）告警 |
| 🩺 **独立 CLI** | `node bin/dsh-doctor.js scan` 全盘扫描 / 诊断 / 救援 / 重启 / 经验检索 / 巡检，不依赖 DSH 进程存活 |

## 快速开始

### 安装（DSH 桌面插件）

```powershell
# 1) 获取插件
git clone https://github.com/Cloud12305/dsh-doctor.git "D:\05_Apps\DeepseekHarness\dsh-doctor"

# 2) 装入 DSH profile
Set-Location "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "file:D:/05_Apps/DeepseekHarness/dsh-doctor"

# 3) 把 "dsh-doctor" 加入 package.json 的 dsh.profile.bundles 数组
# 4) 重启 DSH 桌面应用生效
```

配套技能（可选，推荐）：把 `skills/dsh-doctor/SKILL.md` 复制到 `~/.dsh/skills/dsh-doctor/SKILL.md`，Agent 会自动学会排障流程。

### Agent 工具（装好后自动注册）

| 工具 | 用途 |
|---|---|
| `dsh_doctor_diagnose` | 诊断单个/全部会话，输出根因分类、证据、经验库匹配与修复步骤。用户说"卡住/不回复/没反应/报错"时先调用 |
| `dsh_doctor_fix` | `rescue-queue` 导出队列未发消息 → `schedule-restart`（需 `confirm=true`）延时自动重启 DSH → `advise` 仅建议 |
| `dsh_doctor_experience` | `search`/`list` 检索经验库；`learn` 沉淀新经验 |
| `dsh_doctor_status` | 巡检状态、最近发现与自动修复动作记录 |

### CLI（会话卡死时在终端直接用）

```powershell
node bin\dsh-doctor.js scan                    # 扫描全部会话（卡死/报错清单）
node bin\dsh-doctor.js diagnose <会话id前8位>   # 单会话诊断
node bin\dsh-doctor.js rescue <会话id>          # 重启前导出队列未发消息
node bin\dsh-doctor.js restart --grace 20 --yes # 安排延时重启 DSH
node bin\dsh-doctor.js experience search 卡死   # 检索经验库
node bin\dsh-doctor.js watch --once            # 试跑一次巡检
node bin\dsh-doctor.js experience learn --title "..." --category stuck --symptom "..." --root-cause "..." --fix "步骤1;步骤2"
```

## 两类根因（判读核心）

| | 类型 A：回合报错终止 | 类型 B：调度僵死 |
|---|---|---|
| 用户体感 | 发消息几秒内"没反应"，可能闪过红色错误 | 消息石沉大海，无报错无转圈 |
| 日志特征 | 有 `turn/start`，紧接 `turn/end` 且 `reason.kind=error` | 只有 `agent/inbox/spliced` 入队，**没有 `turn/start`** |
| 本质 | LLM 请求失败（配额/余额/上下文超限/网络/过滤） | 引擎唤醒逻辑静默失灵（相位僵死在内存态），消息永远排队 |
| 修复 | 按错误码对表（换模型/等配额/开新会话/重发） | **重启 DSH 桌面应用**（唯一可靠解法） |

⚠️ 卡死时**不要连点重发**：队列按序消费，重复 N 条排成 N 轮各回一次。重启会清空队列——**先 `rescue` 再重启**。

## 自动修复（看门狗）

随 DSH 启动，默认每 120s 扫描一次变化的会话：

- 某消息入队 **> 5 分钟**无回合启动、且**全局无进行中回合** → 救援队列到 `~/.dsh/dsh-doctor/rescue/` → 安排 **20s 后自动重启** DSH（重启前二次救援，防宽限期内新消息丢失；30 分钟冷却一次）。
- 重启脚本 `bin/restart-dsh.ps1` 独立于 DSH 进程运行，按进程名精确匹配、只杀 DSH 自己。

配置（插件 config 的 `watchdog` 节）：

```yaml
watchdog:
  enabled: true        # 巡检开关
  intervalSec: 120     # 扫描间隔
  wedgeAfterSec: 300   # 僵死判定阈值
  autoRestart: true    # 不想要自动重启设为 false（只报告不重启）
  cooldownSec: 1800    # 自动重启冷却
```

## 经验库

- **内置** [`knowledge/issues.json`](knowledge/issues.json)：B-01 调度僵死（通用）/ B-02 后台任务完成后僵死 / B-03 记忆插件批量注入集体僵死 / B-04 停止按钮后僵死 / B-05 重发堆积；A-01~A-03 配额·余额·用量 / A-04 413 超窗 / A-05 网络抖动 / A-06 content_filter / A-07 Codex+REA schema 不兼容 / A-08 重试改推理档位 / A-09 服务端偶发；OP-01 重启清队列 / OP-02 后台任务失控。
- **个人追加**：`~/.dsh/dsh-doctor/knowledge/user-issues.json`（`learn` 写入），自动重生成 `EXPERIENCE.md` 人读版。
- **匹配打分**：错误码精确命中 100 > 原文正则 60 > 类型/僵死场景 20~30。
- **条目格式**：

```json
{
  "id": "B-01", "title": "...", "category": "stuck|error|op", "severity": "low|medium|high|critical",
  "symptom": "用户看到什么", "rootCause": "根因",
  "evidence": ["日志判据"],
  "match": { "errorCode": "QUOTA", "messagePattern": "regex", "findingType": "B", "wedgeKinds": ["after-job-notify"] },
  "fix": ["步骤1", "步骤2"], "autoFix": "rescue-queue + schedule-restart",
  "prevention": ["预防1"], "learnedFrom": "来源", "date": "YYYY-MM-DD"
}
```

## 目录结构

```
dsh-doctor/
├─ lib/
│  ├─ core.js        # 会话发现、事件日志解析（zstd）、僵死/报错分类
│  ├─ knowledge.js   # 经验库加载/匹配/沉淀
│  ├─ fix.js         # 队列救援、延时重启调度、修复建议
│  ├─ watchdog.js    # 巡检看门狗（自动发现 + 自动修复）
│  └─ index.js       # Cordis 插件入口（注册 4 个 Agent 工具）
├─ bin/
│  ├─ dsh-doctor.js  # 独立 CLI（scan/diagnose/rescue/restart/experience/watch）
│  └─ restart-dsh.ps1# 分离式延时重启脚本（重启前二次救援队列）
├─ knowledge/issues.json   # 内置经验库
├─ skills/dsh-doctor/SKILL.md  # 配套 Agent 技能
├─ cordis.patch.yml  # DSH bundle 注册
└─ dsh.plugin.json   # 插件清单
```

## 环境要求与排错

- Node ≥ 22.15（`zlib.zstdDecompressSync` 解压会话日志）；插件宿主随 DSH 自带。
- 工具没出现：重启 DSH 后查日志有无 `[dsh-doctor] loaded`；`node bin/dsh-doctor.js scan` 可独立验证核心。
- 自动重启没触发：检查是否有其它会话在进行回合（会顺延）、30 分钟冷却期、`autoRestart` 开关。
- 状态/救援/动作日志：`~/.dsh/dsh-doctor/`（`status.json`、`rescue/`、`actions.log`、`restart-*.log`）。

## License

MIT
