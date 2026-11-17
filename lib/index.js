// dsh-doctor — DSH 使用问题经验库 + 根因诊断 + 自动修复（Cordis 插件入口）。
// 工具注册采用原始 JSON Schema 形状（与 modlens 相同的预览期注册约定）。
import { dshHome, listSessions, findSession, loadEvents, loadQueue, analyzeEvents, buildFindings, fmtTime } from './core.js';
import { loadKnowledge, matchKnowledge, learn, knowledgeDirs } from './knowledge.js';
import { rescueQueue, scheduleRestart, advise, stateDir, findSuspiciousJobs, defaultExePath } from './fix.js';
import { Watchdog, WATCHDOG_DEFAULTS } from './watchdog.js';

export const name = 'dsh-doctor';
export const inject = ['tools'];

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
  },
  required: ['text'],
};
const renderText = (_args, value) => [{ type: 'text', text: value?.text ?? String(value) }];

function analyzeSessionForTool(query) {
  const home = dshHome();
  const session = query ? findSession(query, home) : null;
  const targets = session ? [session] : listSessions(home);
  const kb = loadKnowledge();
  const out = [];
  const now = Date.now();
  for (const s of targets) {
    let analysis;
    try {
      analysis = analyzeEvents(loadEvents(s.logPath), { wedgeAfterSec: 180, now });
    } catch (error) {
      out.push({ session: s.sessionId, error: String(error?.message || error) });
      continue;
    }
    const queue = loadQueue(s.projcachePath);
    const findings = buildFindings(s.sessionId, analysis, {});
    const matched = findings.map((f) => {
      const hits = matchKnowledge(kb, f).slice(0, 2);
      return {
        ...f,
        kb: hits.map((h) => ({ id: h.entry.id, title: h.entry.title, score: h.score })),
        advice: advise(f, hits[0]),
      };
    });
    const suspicious = findSuspiciousJobs(analysis, 30 * 60 * 1000, now);
    out.push({
      session: s.sessionId,
      shortId: s.shortId,
      workspace: s.workspace,
      openTurn: analysis.openTurn,
      lastEvent: fmtTime(analysis.stats.lastEventTime),
      queue: queue.map((m) => m.text.slice(0, 100)),
      wedges: analysis.wedges.length,
      errors: analysis.errors.length,
      suspiciousJobs: suspicious.map((j) => ({ jobId: j.jobId, label: j.label })),
      findings: matched,
    });
  }
  return out;
}

function diagnoseText(report) {
  const lines = ['# dsh-doctor 诊断报告', `时间：${fmtTime(Date.now())}`, ''];
  for (const s of report) {
    if (s.error) {
      lines.push(`## ${s.session}：读取失败 —— ${s.error}`, '');
      continue;
    }
    const interesting = s.findings.length > 0 || s.queue.length > 0 || s.suspiciousJobs.length > 0;
    if (!interesting) {
      lines.push(`## ${s.shortId}：正常（最近事件 ${s.lastEvent}）`, '');
      continue;
    }
    lines.push(`## 会话 ${s.shortId}（${s.workspace}）`);
    lines.push(`- 最近事件：${s.lastEvent}；进行中回合：${s.openTurn ? '是' : '否'}；队列待发：${s.queue.length} 条`);
    for (const q of s.queue) lines.push(`  - 队列：${q}`);
    for (const j of s.suspiciousJobs) lines.push(`  - ⚠ 疑似失控后台任务：${j.jobId}（${j.label}）`);
    for (const f of s.findings) {
      lines.push('');
      lines.push(`### [${f.type}] ${f.title}`);
      lines.push(`- 证据：seq=${f.evidence?.seq} 时间=${fmtTime(f.evidence?.time)}${f.evidence?.waitSec ? ` 等待=${f.evidence.waitSec}s` : ''}`);
      if (f.message) lines.push(`- 原文：${f.message.slice(0, 160)}`);
      if (f.kb?.length) lines.push(`- 经验库匹配：${f.kb.map((k) => `${k.id}(${k.score})`).join(', ')}`);
      lines.push('');
      lines.push('```');
      lines.push(f.advice);
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n');
}

function experienceTool(args) {
  const action = args?.action || 'search';
  const kb = loadKnowledge();
  if (action === 'search' || action === 'list') {
    const q = String(args?.query || '').toLowerCase();
    const rows = kb.filter(
      (e) =>
        !q ||
        [e.id, e.title, e.symptom, e.rootCause, e.learnedFrom].join(' ').toLowerCase().includes(q),
    );
    const lines = [`经验库共 ${kb.length} 条，命中 ${rows.length} 条：`, ''];
    for (const e of rows) {
      lines.push(`【${e.id}】${e.title}（${e.category}/${e.severity}）`);
      if (e.symptom) lines.push(`  症状：${e.symptom}`);
      if (e.rootCause) lines.push(`  根因：${e.rootCause}`);
      if (e.fix?.length) lines.push(`  修复：${e.fix.join(' → ')}`);
      if (e.prevention?.length) lines.push(`  预防：${e.prevention.join('；')}`);
      lines.push('');
    }
    return lines.join('\n');
  }
  if (action === 'learn') {
    const entry = args?.entry;
    if (!entry || typeof entry !== 'object' || !entry.title) {
      throw new Error('learn 需要 entry 对象：{title, category, symptom, rootCause, fix[], match?, prevention?, learnedFrom?}');
    }
    const record = learn(entry);
    return `已沉淀为经验条目 ${record.id}：${record.title}\n查看：~/.dsh/dsh-doctor/knowledge/EXPERIENCE.md`;
  }
  throw new Error(`未知 action：${action}（支持 search | list | learn）`);
}

export function apply(ctx, config = {}) {
  const home = dshHome();
  const cfg = {
    watchdog: { ...WATCHDOG_DEFAULTS, ...(config.watchdog || {}) },
  };

  const doctorTool = {
    name: 'dsh_doctor_diagnose',
    description:
      '诊断 DSH 会话问题的根因：扫描会话事件日志，区分「类型B 调度僵死（消息入队无回合）」与「类型A 回合报错（配额/413/网络/过滤等）」，匹配经验库并给出修复步骤。不带 session 参数则扫描全部会话。当用户说会话卡住、不回复、没反应、报错、转圈时先调用它。',
    parameters: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: '会话 id（完整或前 8 位唯一前缀）；省略则扫描全部会话',
        },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const report = analyzeSessionForTool(args?.session);
      return { text: diagnoseText(report) };
    },
  };

  const fixTool = {
    name: 'dsh_doctor_fix',
    description:
      '对诊断出的 DSH 问题执行修复。action=rescue-queue：把会话队列里没发出去的消息导出到救援文件（重启前必做，重启会清队列）；action=schedule-restart：延时 20s 自动重启 DSH 桌面应用（调度僵死的唯一可靠解法，重启会打断所有进行中回合，务必先 rescue-queue 并提醒用户）；action=advise：仅输出建议不动手。类型B僵死流程：先 rescue-queue，再 schedule-restart，重启后让用户重发救援文件里的消息。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['rescue-queue', 'schedule-restart', 'advise'], description: '修复动作' },
        session: { type: 'string', description: '会话 id（rescue-queue 必填）' },
        graceSeconds: { type: 'number', description: 'schedule-restart 的宽限秒数，默认 20' },
        confirm: { type: 'boolean', description: 'schedule-restart 必须显式传 true（会重启整个 DSH 应用）' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = args?.action;
      if (action === 'rescue-queue') {
        if (!args?.session) throw new Error('rescue-queue 需要 session 参数');
        const r = rescueQueue(args.session, { home });
        return { text: `已救援 ${r.messages.length} 条队列消息到：${r.file}\n重启后请按文件内容重发。` };
      }
      if (action === 'schedule-restart') {
        if (args?.confirm !== true) {
          throw new Error('schedule-restart 会重启整个 DSH 应用（打断所有进行中回合）：确认后传 confirm=true。先用 rescue-queue 导出队列消息。');
        }
        const r = scheduleRestart({ graceSeconds: args.graceSeconds ?? 20 });
        return { text: `已安排 ${r.graceSeconds}s 后重启 DSH（detached pid=${r.pid}）。重启会打断所有进行中回合并清空队列；日志：${r.logPath}` };
      }
      if (action === 'advise') {
        const report = analyzeSessionForTool(args?.session);
        return { text: diagnoseText(report) };
      }
      throw new Error(`未知 action：${action}`);
    },
  };

  const experienceToolDef = {
    name: 'dsh_doctor_experience',
    description:
      'DSH 使用经验库：search/list 检索已沉淀的问题-根因-修复条目；learn 沉淀新经验（把刚排查解决的问题整理成条目，持续积累）。当用户问「遇到过什么问题/怎么解决」或刚完成一次排障时使用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'list', 'learn'], description: '操作' },
        query: { type: 'string', description: 'search 的关键词（匹配标题/症状/根因）' },
        entry: {
          type: 'object',
          description: 'learn 的条目：{title, category: stuck|error|op, severity, symptom, rootCause, evidence[], match{}, fix[], autoFix, prevention[], learnedFrom}',
        },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return { text: experienceTool(args) };
    },
  };

  const statusTool = {
    name: 'dsh_doctor_status',
    description:
      '查看 dsh-doctor 巡检状态：最近一次扫描发现的问题、自动修复动作记录（救援/重启/冷却跳过）、经验库位置与看门狗配置。',
    parameters: { type: 'object', properties: {} },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute() {
      const dirs = knowledgeDirs();
      let status = null;
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        status = JSON.parse(fs.readFileSync(path.join(stateDir(), 'status.json'), 'utf8'));
      } catch {
        /* no scan yet */
      }
      const lines = [
        `# dsh-doctor 状态`,
        `看门狗：interval=${cfg.watchdog.intervalSec}s wedgeAfter=${cfg.watchdog.wedgeAfterSec}s autoRestart=${cfg.watchdog.autoRestart} cooldown=${cfg.watchdog.cooldownSec}s`,
        `经验库：${dirs.bundledDir}（内置） + ${dirs.userDir}（个人）`,
        `状态/救援文件：${stateDir()}`,
        '',
        status ? `最近扫描：${status.at}` : '尚未扫描（巡检按间隔自动执行，或调用 dsh_doctor_diagnose）',
      ];
      if (status?.findings?.length) {
        lines.push('', '最近发现：');
        for (const f of status.findings.slice(-10)) lines.push(`- [${f.type}/${f.code}] ${f.title} @${f.session} ${f.kb ? `→ ${f.kb}` : ''}`);
      }
      if (status?.actions?.length) {
        lines.push('', '最近动作：');
        for (const a of status.actions.slice(-10)) lines.push(`- ${a.kind} ${a.sessionId || ''} ${a.file || a.reason || a.error || ''}`);
      }
      return { text: lines.join('\n') };
    },
  };

  for (const tool of [doctorTool, fixTool, experienceToolDef, statusTool]) {
    try {
      ctx.tools.register(tool);
    } catch (error) {
      console.error(`[dsh-doctor] ${tool.name} registration skipped: ${error}`);
    }
  }

  if (cfg.watchdog.enabled !== false) {
    const watchdog = new Watchdog({ ...cfg.watchdog, home, logger: console });
    if (typeof ctx.setInterval === 'function') {
      // Cordis-managed timer: disposed automatically on plugin teardown.
      ctx.setInterval(() => {
        try {
          watchdog.scanOnce();
        } catch (error) {
          console.warn(`[dsh-doctor] watchdog scan failed: ${error?.message || error}`);
        }
      }, Math.max(30, cfg.watchdog.intervalSec) * 1000);
    } else {
      watchdog.start();
    }
    console.log(`[dsh-doctor] loaded: tools=dsh_doctor_{diagnose,fix,experience,status} watchdog=${cfg.watchdog.enabled} autoRestart=${cfg.watchdog.autoRestart}`);
  } else {
    console.log('[dsh-doctor] loaded: tools registered, watchdog disabled');
  }
}
