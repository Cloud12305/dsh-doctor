// dsh-doctor watchdog: periodic session scan with optional auto-fix.
// Detects type-B wedges and type-A error bursts; when a wedge is confirmed and
// no turn is running anywhere, it rescues queued messages and schedules a
// detached restart of the DSH desktop app (the only reliable wedge cure).
import fs from 'node:fs';
import path from 'node:path';
import { dshHome, listSessions, loadEvents, loadQueue, analyzeEvents, buildFindings, fmtTime } from './core.js';
import { matchKnowledge, loadKnowledge } from './knowledge.js';
import { rescueQueue, scheduleRestart, stateDir, findSuspiciousJobs } from './fix.js';

export const WATCHDOG_DEFAULTS = {
  enabled: true,
  intervalSec: 120,
  wedgeAfterSec: 300, // a message waiting > 5 min with no turn is a confirmed wedge
  autoRestart: true, // rescue + scheduled restart when no turn is active anywhere
  cooldownSec: 1800, // at most one auto-restart per 30 min
};

export class Watchdog {
  constructor(opts = {}) {
    this.opts = { ...WATCHDOG_DEFAULTS, ...opts };
    this.home = opts.home || dshHome();
    this.logger = opts.logger || console;
    this.mtimes = new Map(); // logPath -> last seen mtime
    this.turnState = new Map(); // logPath -> last known openTurn (retained across passes)
    this.lastRestartAt = 0;
    this.timer = null;
    this.lastReport = null;
    this.statusFile = path.join(stateDir(), 'status.json');
  }

  start() {
    if (this.timer) return;
    const ms = Math.max(30, this.opts.intervalSec) * 1000;
    this.timer = setInterval(() => {
      try {
        this.scanOnce();
      } catch (error) {
        this.logger.warn?.(`[dsh-doctor] watchdog scan failed: ${error?.message || error}`);
      }
    }, ms);
    this.logger.info?.(`[dsh-doctor] watchdog started: interval=${this.opts.intervalSec}s wedgeAfter=${this.opts.wedgeAfterSec}s autoRestart=${this.opts.autoRestart}`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scan pass. Phase 1 collects facts, phase 2 decides fixes globally. */
  scanOnce(force = false) {
    const now = Date.now();
    const kb = loadKnowledge();
    const report = { at: now, sessions: [], findings: [], actions: [] };
    const rows = [];

    for (const session of listSessions(this.home)) {
      let mtime = 0;
      try {
        mtime = fs.statSync(session.logPath).mtimeMs;
      } catch {
        continue;
      }
      const changed = force || this.mtimes.get(session.logPath) !== mtime;
      if (!changed) {
        rows.push({ session, analysis: null, queue: null, findings: [] });
        continue;
      }
      this.mtimes.set(session.logPath, mtime);

      let analysis;
      try {
        analysis = analyzeEvents(loadEvents(session.logPath), { wedgeAfterSec: this.opts.wedgeAfterSec, now });
      } catch (error) {
        this.logger.warn?.(`[dsh-doctor] cannot read ${session.shortId}: ${error?.message || error}`);
        continue;
      }
      this.turnState.set(session.logPath, analysis.openTurn);
      const queue = loadQueue(session.projcachePath);
      const findings = buildFindings(session.sessionId, analysis, {});
      for (const f of findings) {
        f.kb = matchKnowledge(kb, f).slice(0, 2).map((h) => ({ id: h.entry.id, title: h.entry.title, score: h.score }));
      }
      rows.push({ session, analysis, queue, findings });
      if (findings.length) {
        report.sessions.push({ sessionId: session.sessionId, shortId: session.shortId, queue: queue.length, openTurn: analysis.openTurn, findings: findings.length });
        report.findings.push(...findings);
      }
      const suspicious = findSuspiciousJobs(analysis, 30 * 60 * 1000, now);
      if (suspicious.length) {
        report.actions.push({ kind: 'warn-runaway-jobs', sessionId: session.shortId, jobs: suspicious.map((j) => j.jobId) });
      }
    }

    // Phase 2: auto-fix is global — only when no session has an open turn.
    const anyOpenTurn = [...this.turnState.values()].some(Boolean);
    for (const row of rows) {
      const wedged = row.findings.filter((f) => f.type === 'B');
      if (!wedged.length || !row.queue?.length || row.analysis?.openTurn) continue;
      if (this.opts.autoRestart && !anyOpenTurn) {
        report.actions.push(...this.maybeAutoFix(row.session, wedged, now));
      } else if (wedged.length) {
        report.actions.push({ kind: 'wedge-detected-no-autofix', sessionId: row.session.shortId, reason: anyOpenTurn ? 'other session busy' : 'autoRestart disabled' });
      }
    }

    this.lastReport = report;
    this.writeStatus(report);
    return report;
  }

  maybeAutoFix(session, wedgedFindings, now) {
    const actions = [];
    if (now - this.lastRestartAt < this.opts.cooldownSec * 1000) {
      return [{ kind: 'restart-skipped-cooldown', sessionId: session.shortId }];
    }
    try {
      const rescued = rescueQueue(session, { home: this.home });
      actions.push({ kind: 'queue-rescued', sessionId: session.shortId, file: rescued.file, messages: rescued.messages.length });
      const restart = scheduleRestart({ graceSeconds: 20 });
      this.lastRestartAt = now;
      actions.push({ kind: 'restart-scheduled', sessionId: session.shortId, graceSeconds: restart.graceSeconds, pid: restart.pid, reason: wedgedFindings[0]?.title });
      fs.appendFileSync(
        path.join(stateDir(), 'actions.log'),
        `${new Date().toISOString()} auto-fix session=${session.shortId} rescued=${rescued.messages.length} -> restart pid=${restart.pid}\n`,
        'utf8',
      );
      this.logger.warn?.(`[dsh-doctor] 检测到会话僵死（${session.shortId}），已救援 ${rescued.messages.length} 条队列消息并安排 ${restart.graceSeconds}s 后自动重启 DSH。救援文件：${rescued.file}`);
    } catch (error) {
      actions.push({ kind: 'auto-fix-failed', sessionId: session.shortId, error: String(error?.message || error) });
      this.logger.warn?.(`[dsh-doctor] auto-fix failed for ${session.shortId}: ${error?.message || error}`);
    }
    return actions;
  }

  writeStatus(report) {
    try {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(
        this.statusFile,
        JSON.stringify(
          {
            at: fmtTime(report.at),
            atMs: report.at,
            findings: report.findings.map((f) => ({ type: f.type, code: f.code, title: f.title, session: f.sessionId?.slice(0, 8), kb: f.kb?.[0]?.id || null })),
            actions: report.actions,
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      /* status is best-effort */
    }
  }
}
