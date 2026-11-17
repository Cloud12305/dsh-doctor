// dsh-doctor fix actions: rescue queued messages, schedule a safe restart,
// and render per-finding advice. Restart is performed by a detached PowerShell
// script so it survives this process being killed with the app.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { dshHome, fmtTime, loadEvents, loadQueue, analyzeEvents, findSession } from './core.js';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function stateDir() {
  return process.env.DSH_DOCTOR_STATE || path.join(dshHome(), 'dsh-doctor');
}

/**
 * Rescue stranded queued messages of one session into a markdown file so a
 * restart (which clears the queue) does not lose them.
 */
export function rescueQueue(sessionLike, opts = {}) {
  const home = opts.home || dshHome();
  const session = typeof sessionLike === 'string' ? findSession(sessionLike, home) : sessionLike;
  if (!session) throw new Error(`找不到会话：${sessionLike}`);
  const outDir = opts.outDir || path.join(stateDir(), 'rescue');
  fs.mkdirSync(outDir, { recursive: true });

  // Authoritative queue from projcache; log-derived stranded messages as backup.
  let queue = loadQueue(session.projcachePath);
  let analysis = null;
  try {
    analysis = analyzeEvents(loadEvents(session.logPath), { wedgeAfterSec: 0 });
  } catch {
    /* log unreadable: projcache queue still stands */
  }
  const logStranded = (analysis?.wedges || []).filter((w) => w.stillQueued);
  if (!queue.length && logStranded.length) {
    queue = logStranded.map((w) => ({ text: w.text, role: 'user', kind: 'user', id: null }));
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(outDir, `rescued-${session.shortId}-${ts}.md`);
  const lines = [
    `# 队列救援 · session-${session.sessionId}`,
    '',
    `- 导出时间：${fmtTime(Date.now())}（本地）`,
    `- 工作区：${session.workspace}`,
    `- 待发消息 ${queue.length} 条 —— 重启后请把下面内容重新发给该会话（背景任务通知类可忽略，任务结果用 job_output 重新读取）。`,
    '',
  ];
  queue.forEach((m, i) => {
    lines.push(`## ${i + 1}. [${m.kind}]`, '', m.text || '(无文本)', '');
  });
  if (analysis?.openJobs?.length) {
    lines.push('## 尚未结束的后台任务', '');
    for (const j of analysis.openJobs) lines.push(`- ${j.jobId}：${j.label}`);
    lines.push('');
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return { file, messages: queue, session };
}

export function defaultExePath() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local'),
    'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe',
  );
}

/**
 * Schedule a detached restart of the DSH desktop app after a grace period.
 * The restarter re-rescues queues right before killing, so nothing is lost.
 * Returns { scheduled: true, graceSeconds, script, logPath }.
 */
export function scheduleRestart(opts = {}) {
  const graceSeconds = Math.max(5, Number(opts.graceSeconds ?? 20));
  const exePath = opts.exePath || defaultExePath();
  const script = path.join(PKG_DIR, 'bin', 'restart-dsh.ps1');
  if (!fs.existsSync(script)) throw new Error(`找不到重启脚本：${script}`);
  const logPath = path.join(stateDir(), `restart-${Date.now()}.log`);
  fs.mkdirSync(stateDir(), { recursive: true });

  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', script,
    '-GraceSeconds', String(graceSeconds),
    '-ExePath', exePath,
    '-DshHome', dshHome(),
    '-StateDir', stateDir(),
    '-LogFile', logPath,
  ];
  const child = spawn('powershell.exe', args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  fs.appendFileSync(
    path.join(stateDir(), 'actions.log'),
    `${new Date().toISOString()} schedule-restart grace=${graceSeconds}s pid=${child.pid} exe=${exePath}\n`,
    'utf8',
  );
  return { scheduled: true, graceSeconds, pid: child.pid, script, logPath, exePath };
}

/** Per-finding advice rendered from the matched knowledge entry. */
export function advise(finding, matched) {
  const entry = matched?.entry;
  if (!entry) {
    return finding.type === 'B'
      ? '未匹配到经验库：按类型 B 处理——复制队列消息 → 试点停止按钮 → 重启 DSH 桌面应用。'
      : `未匹配到经验库：错误码 ${finding.code}，原始信息 ${finding.message}。先查配额/上下文/网络，再把该错误用 experience learn 沉淀。`;
  }
  const lines = [`【${entry.id}】${entry.title}`, `根因：${entry.rootCause}`];
  if (entry.fix?.length) lines.push(...entry.fix.map((s, i) => `  ${i + 1}. ${s}`));
  if (entry.autoFix) lines.push(`自动修复：${entry.autoFix}`);
  return lines.join('\n');
}

/** Background jobs registered but never settled (possible runaway loops). */
export function findSuspiciousJobs(analysis, olderThanMs = 30 * 60 * 1000, now = Date.now()) {
  return (analysis?.openJobs || []).filter((j) => now - (j.time || 0) > olderThanMs);
}
