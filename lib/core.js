// dsh-doctor core: session discovery, event-log reading, root-cause analysis.
// Zero external dependencies; Node >= 22.15 (zlib.zstdDecompressSync).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

/** Resolve the DSH home directory (override with DSH_HOME for tests). */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** All session log files under <home>/sessions/<workspace>/<session-id>/. */
export function listSessions(home = dshHome()) {
  const root = path.join(home, 'sessions');
  const out = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    let entries;
    try {
      entries = fs.readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const logPath = path.join(wsDir, e.name, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(logPath)) continue;
      const sid = e.name.replace(/^session-/, '');
      out.push({
        sessionId: sid,
        shortId: sid.slice(0, 8),
        workspace: ws.name,
        dir: path.join(wsDir, e.name),
        logPath,
        projcachePath: path.join(home, 'storages', 'session_projcache', 'sessions', `session-${sid}.json`),
      });
    }
  }
  return out;
}

/** Find one session by id or unique prefix. */
export function findSession(query, home = dshHome()) {
  const all = listSessions(home);
  const q = String(query || '').replace(/^session-/, '');
  const exact = all.filter((s) => s.sessionId === q);
  if (exact.length === 1) return exact[0];
  const prefix = all.filter((s) => s.sessionId.startsWith(q) || s.shortId === q);
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    throw new Error(`会话 id "${query}" 不唯一，匹配到 ${prefix.length} 个：${prefix.map((s) => s.shortId).join(', ')}`);
  }
  return null;
}

/** Decompress a session event log (zstd JSONL) into event objects. */
export function loadEvents(logPath) {
  const buf = fs.readFileSync(logPath);
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('zstd-unsupported: 当前 Node 不支持 zlib.zstdDecompressSync，需要 Node >= 22.15');
  }
  const text = zlib.zstdDecompressSync(buf).toString('utf8');
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip malformed line */
    }
  }
  return events;
}

/** Read the authoritative queued-message snapshot from the projcache. */
export function loadQueue(projcachePath) {
  try {
    const j = JSON.parse(fs.readFileSync(projcachePath, 'utf8'));
    const val = j?.record?.inbox?.val;
    const rows = val?.['next-turn'];
    if (!Array.isArray(rows)) return [];
    return rows.map((m) => ({
      text: extractText(m),
      role: m.role || m.source?.kind || 'unknown',
      kind: m.source?.kind || m.role || 'unknown',
      id: m.id || null,
    }));
  } catch {
    return [];
  }
}

function extractText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  const content = msg.content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n').trim();
  }
  return '';
}

export function fmtTime(ms) {
  if (!ms) return '??';
  return new Date(ms).toISOString().slice(5, 19).replace('T', ' ');
}

/**
 * Analyze one session's event stream.
 * Returns { sessionId, stats, openTurn, queued, wedges, errors, jobs, aborts }.
 * A "wedge" (type B) is a user message enqueued while idle that never got a
 * turn/start; an "error" (type A) is turn/end with reason.kind === 'error'.
 */
export function analyzeEvents(events, opts = {}) {
  const wedgeAfterSec = opts.wedgeAfterSec ?? 180;
  const now = opts.now ?? Date.now();
  let turnOpen = false;
  let lastTurnStart = null;
  let lastTurnEnd = null;
  let lastTurnEndReason = null;
  const errors = [];
  const aborts = [];
  const wedges = [];
  const jobs = [];
  const openJobs = new Map();
  const queued = []; // stranded user messages (log-derived)
  const recentContext = []; // rolling window of notable event types for wedge context
  let firstEventTime = null;

  for (const e of events) {
    if (!firstEventTime) firstEventTime = e.time;
    const t = e.type;
    if (t === 'turn/start') {
      // Turn begins; the engine's inbox removal below is the authoritative
      // dequeue signal (a turn consumes exactly one queued message).
      turnOpen = true;
      lastTurnStart = e.time;
    } else if (t === 'turn/end') {
      turnOpen = false;
      lastTurnEnd = e.time;
      const reason = e.data?.reason || {};
      lastTurnEndReason = reason.kind || null;
      if (reason.kind === 'error') {
        errors.push({
          seq: e.seq,
          time: e.time,
          turn: e.data?.turn,
          code: reason.error?.code || 'UNKNOWN',
          message: String(reason.error?.message || '').slice(0, 300),
        });
      } else if (reason.kind === 'aborted') {
        aborts.push({ seq: e.seq, time: e.time, turn: e.data?.turn, by: reason.reason?.kind || 'user' });
      }
    } else if (t === 'agent/inbox/spliced') {
      const d = e.data || {};
      const ins = Array.isArray(d.inserted) ? d.inserted : [];
      const rem = d.removedCount || 0;
      // Removals first (head-first dequeue): a message that waited too long
      // before being consumed or cleaned up IS a wedge in hindsight.
      for (let i = 0; i < rem && queued.length > 0; i++) {
        const msg = queued.shift();
        const waitMs = e.time - msg.time;
        if (wedgeAfterSec > 0 && waitMs > wedgeAfterSec * 1000) {
          wedges.push({ ...msg, consumedAt: e.time, waitSec: Math.round(waitMs / 1000), context: msg.context, removed: true });
        }
      }
      for (const m of ins) {
        const text = extractText(m);
        const isUser = m.role === 'user' || m.source?.kind === 'user';
        if (isUser && text) {
          queued.push({
            time: e.time,
            seq: e.seq,
            text,
            context: wedgeContext(recentContext, lastTurnEndReason),
          });
        }
      }
    } else if (t === 'job/registered') {
      openJobs.set(e.data?.jobId, { jobId: e.data?.jobId, label: String(e.data?.label || '').slice(0, 120), time: e.time, seq: e.seq });
    } else if (t === 'job/settled') {
      const started = openJobs.get(e.data?.jobId);
      openJobs.delete(e.data?.jobId);
      jobs.push({ jobId: e.data?.jobId, label: String(e.data?.label || '').slice(0, 120), start: started?.time || null, end: e.time, durationMs: started ? e.time - started.time : null, status: e.data?.status || null });
    }
    if (t === 'turn/end' || t === 'job/settled' || t === 'turn/start') {
      recentContext.push({ type: t, time: e.time });
      if (recentContext.length > 8) recentContext.shift();
    }
  }

  // Messages still waiting at the end of the log are wedged if idle too long.
  for (const msg of queued) {
    if (now - msg.time > wedgeAfterSec * 1000) {
      wedges.push({ ...msg, consumedAt: null, waitSec: Math.round((now - msg.time) / 1000), context: msg.context, stillQueued: true });
    }
  }

  return {
    stats: {
      events: events.length,
      firstEventTime,
      lastEventTime: events.length ? events[events.length - 1].time : null,
      turns: errors.length + aborts.length,
    },
    openTurn: turnOpen,
    lastTurnStart,
    lastTurnEnd,
    lastTurnEndReason,
    queued,
    wedges,
    errors,
    aborts,
    jobs,
    openJobs: [...openJobs.values()],
  };
}

/** Classify what happened just before a stranded message, for KB matching. */
function wedgeContext(recentContext, lastTurnEndReason) {
  const last = recentContext[recentContext.length - 1];
  if (last?.type === 'job/settled') return 'after-job-notify';
  if (lastTurnEndReason === 'aborted') return 'after-abort';
  if (lastTurnEndReason === 'error') return 'after-error';
  return 'plain';
}

/**
 * Build findings for one session: type A (errors) and type B (wedges),
 * each ready for knowledge-base matching.
 */
export function buildFindings(sessionId, analysis, opts = {}) {
  const findings = [];
  for (const w of analysis.wedges) {
    findings.push({
      type: 'B',
      code: 'WEDGE',
      title: `消息入队 ${w.waitSec}s 无回合启动（调度僵死）`,
      message: w.text.slice(0, 120),
      wedgeKind: w.context,
      evidence: { seq: w.seq, time: w.time, waitSec: w.waitSec, stillQueued: !!w.stillQueued },
      sessionId,
    });
  }
  for (const err of analysis.errors) {
    findings.push({
      type: 'A',
      code: err.code,
      title: `回合报错终止：${err.code}`,
      message: err.message,
      evidence: { seq: err.seq, time: err.time, turn: err.turn },
      sessionId,
    });
  }
  return findings;
}
