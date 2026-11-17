#!/usr/bin/env node
// dsh-doctor CLI — 会话僵死/报错诊断与修复（独立于 DSH 运行，卡死时也能用）。
// 用法：
//   node bin/dsh-doctor.js scan [--json]                 扫描全部会话
//   node bin/dsh-doctor.js diagnose <sessionId> [--json] 诊断单个会话
//   node bin/dsh-doctor.js rescue <sessionId>            导出队列未发消息（重启前）
//   node bin/dsh-doctor.js restart [--grace 20] [--yes]  安排延时重启 DSH
//   node bin/dsh-doctor.js experience [search <kw>]      经验库检索 / list
//   node bin/dsh-doctor.js learn --title ... --category stuck|error|op ...   沉淀经验
//   node bin/dsh-doctor.js status                       巡检状态与动作记录
//   node bin/dsh-doctor.js watch [--once]               启动/试跑看门狗
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { dshHome, listSessions, findSession, loadEvents, loadQueue, analyzeEvents, buildFindings, fmtTime } from '../lib/core.js';
import { loadKnowledge, matchKnowledge, learn, knowledgeDirs } from '../lib/knowledge.js';
import { rescueQueue, scheduleRestart, advise, stateDir, findSuspiciousJobs } from '../lib/fix.js';
import { Watchdog, WATCHDOG_DEFAULTS } from '../lib/watchdog.js';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'scan';
const flags = {};
const rest = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  } else {
    rest.push(a);
  }
}

function analyzeOne(session) {
  const kb = loadKnowledge();
  const now = Date.now();
  const analysis = analyzeEvents(loadEvents(session.logPath), { wedgeAfterSec: 180, now });
  const queue = loadQueue(session.projcachePath);
  const findings = buildFindings(session.sessionId, analysis, {}).map((f) => {
    const hits = matchKnowledge(kb, f).slice(0, 2);
    return { ...f, kb: hits.map((h) => ({ id: h.entry.id, title: h.entry.title, score: h.score })), advice: advise(f, hits[0]) };
  });
  return {
    session: session.sessionId,
    shortId: session.shortId,
    workspace: session.workspace,
    openTurn: analysis.openTurn,
    lastEvent: fmtTime(analysis.stats.lastEventTime),
    queue,
    wedges: analysis.wedges,
    errors: analysis.errors,
    aborts: analysis.aborts,
    openJobs: analysis.openJobs,
    suspiciousJobs: findSuspiciousJobs(analysis, 30 * 60 * 1000, now),
    findings,
  };
}

function printReport(reports, asJson) {
  if (asJson) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }
  const lines = ['# dsh-doctor 诊断报告', `时间：${fmtTime(Date.now())}`, `DSH 目录：${dshHome()}`, ''];
  for (const r of reports) {
    if (r.error) {
      lines.push(`## ${r.shortId}：读取失败 —— ${r.error}`, '');
      continue;
    }
    const interesting = r.findings.length > 0 || r.queue.length > 0 || r.suspiciousJobs.length > 0;
    lines.push(`## 会话 ${r.shortId}（${r.workspace}）${interesting ? '' : ' —— 正常'}`);
    lines.push(`- 最近事件：${r.lastEvent}；进行中回合：${r.openTurn ? '是' : '否'}；队列待发：${r.queue.length} 条`);
    for (const q of r.queue) lines.push(`  - 队列：${String(q.text).slice(0, 100)}`);
    for (const j of r.suspiciousJobs) lines.push(`  - ⚠ 疑似失控后台任务：${j.jobId}（${j.label}）`);
    for (const f of r.findings) {
      lines.push('', `### [${f.type}] ${f.title}`);
      lines.push(`- 证据：seq=${f.evidence?.seq} 时间=${fmtTime(f.evidence?.time)}${f.evidence?.waitSec ? ` 等待=${f.evidence.waitSec}s` : ''}`);
      if (f.message) lines.push(`- 原文：${String(f.message).slice(0, 160)}`);
      if (f.kb?.length) lines.push(`- 经验库匹配：${f.kb.map((k) => `${k.id}(${k.score})`).join(', ')}`);
      lines.push('```');
      lines.push(f.advice);
      lines.push('```');
    }
    lines.push('');
  }
  console.log(lines.join('\n'));
}

function main() {
  const home = dshHome();
  const asJson = flags.json === true;

  if (cmd === 'scan') {
    const reports = listSessions(home).map((s) => {
      try {
        return analyzeOne(s);
      } catch (error) {
        return { shortId: s.shortId, session: s.sessionId, error: String(error?.message || error) };
      }
    });
    printReport(reports, asJson);
    return;
  }

  if (cmd === 'diagnose') {
    const q = rest[0] || flags.session;
    if (!q) throw new Error('用法：diagnose <sessionId>');
    const s = findSession(q, home);
    if (!s) throw new Error(`找不到会话：${q}`);
    printReport([analyzeOne(s)], asJson);
    return;
  }

  if (cmd === 'rescue') {
    const q = rest[0] || flags.session;
    if (!q) throw new Error('用法：rescue <sessionId>');
    const r = rescueQueue(q, { home });
    console.log(`已救援 ${r.messages.length} 条队列消息到：${r.file}`);
    return;
  }

  if (cmd === 'restart') {
    if (flags.yes !== true && flags.y !== true) {
      console.log('确认重启 DSH 桌面应用？会打断所有进行中回合并清空队列（先 rescue）。加 --yes 执行。');
      process.exit(2);
    }
    const r = scheduleRestart({ graceSeconds: flags.grace || 20 });
    console.log(`已安排 ${r.graceSeconds}s 后重启 DSH（detached pid=${r.pid}），日志：${r.logPath}`);
    return;
  }

  if (cmd === 'experience') {
    const kb = loadKnowledge();
    const sub = rest[0] || 'list';
    if (sub === 'learn') {
      // 简易键值学习入口：--title --category --symptom --root-cause --fix(分号) --learned-from
      const entry = {
        title: flags.title,
        category: flags.category || 'op',
        severity: flags.severity || 'medium',
        symptom: flags.symptom || '',
        rootCause: flags['root-cause'] || '',
        fix: String(flags.fix || '').split(';').map((s) => s.trim()).filter(Boolean),
        prevention: String(flags.prevention || '').split(';').map((s) => s.trim()).filter(Boolean),
        learnedFrom: flags['learned-from'] || null,
      };
      if (!entry.title) throw new Error('learn 需要 --title');
      if (flags.match) {
        try {
          entry.match = JSON.parse(flags.match);
        } catch {
          throw new Error('--match 必须是 JSON，例如 {"findingType":"B"}');
        }
      }
      const record = learn(entry);
      console.log(`已沉淀经验 ${record.id}：${record.title}`);
      console.log(`查看：${knowledgeDirs().userDir}\\EXPERIENCE.md`);
      return;
    }
    const kw = rest[1] || flags.query || '';
    const rows = kb.filter((e) => !kw || [e.id, e.title, e.symptom, e.rootCause, e.learnedFrom].join(' ').toLowerCase().includes(String(kw).toLowerCase()));
    if (asJson) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    console.log(`经验库共 ${kb.length} 条，命中 ${rows.length} 条：\n`);
    for (const e of rows) {
      console.log(`【${e.id}】${e.title}（${e.category}/${e.severity}）`);
      if (e.symptom) console.log(`  症状：${e.symptom}`);
      if (e.rootCause) console.log(`  根因：${e.rootCause}`);
      if (e.fix?.length) console.log(`  修复：${e.fix.join(' → ')}`);
      if (e.prevention?.length) console.log(`  预防：${e.prevention.join('；')}`);
      if (e.learnedFrom) console.log(`  来源：${e.learnedFrom}（${e.date}）`);
      console.log('');
    }
    return;
  }

  if (cmd === 'status') {
    const dirs = knowledgeDirs();
    console.log(`# dsh-doctor 状态`);
    console.log(`DSH 目录：${home}`);
    console.log(`经验库：${dirs.bundledDir}（内置） + ${dirs.userDir}（个人）`);
    console.log(`状态/救援/动作日志：${stateDir()}`);
    let status = null;
    try {
      status = JSON.parse(fs.readFileSync(path.join(stateDir(), 'status.json'), 'utf8'));
    } catch {
      /* not scanned yet */
    }
    console.log(status ? `\n最近扫描：${status.at}` : '\n尚未扫描（可运行 scan 或 watch --once）');
    for (const f of status?.findings?.slice(-10) || []) console.log(`- [${f.type}/${f.code}] ${f.title} @${f.session} ${f.kb ? '→ ' + f.kb : ''}`);
    for (const a of status?.actions?.slice(-10) || []) console.log(`- ${a.kind} ${a.sessionId || ''} ${a.file || a.reason || a.error || ''}`);
    return;
  }

  if (cmd === 'watch') {
    const watchdog = new Watchdog({
      home,
      ...WATCHDOG_DEFAULTS,
      intervalSec: Number(flags.interval || WATCHDOG_DEFAULTS.intervalSec),
      autoRestart: flags['no-auto-restart'] !== true,
    });
    if (flags.once === true) {
      const report = watchdog.scanOnce(true);
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    watchdog.start();
    watchdog.scanOnce(true);
    console.log('看门狗已启动（Ctrl+C 退出）');
    setInterval(() => {}, 1 << 30);
    return;
  }

  console.log('未知命令。用法见文件头部注释。');
  process.exit(2);
}

try {
  // status uses top-level await import inside main; wrap in async runner.
  await main();
} catch (error) {
  console.error(`错误：${error?.message || error}`);
  process.exit(1);
}
