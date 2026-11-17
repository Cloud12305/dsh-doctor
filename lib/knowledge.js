// dsh-doctor knowledge base: known issues, matching, and learning.
// Bundled knowledge lives in <pkg>/knowledge/issues.json; user additions go to
// <home>/dsh-doctor/knowledge/user-issues.json (merged at load time).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshHome } from './core.js';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function knowledgeDirs() {
  const state = process.env.DSH_DOCTOR_STATE || path.join(dshHome(), 'dsh-doctor');
  return {
    bundledDir: path.join(PKG_DIR, 'knowledge'),
    userDir: path.join(state, 'knowledge'),
    stateDir: state,
  };
}

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Load bundled + user issues into one array. */
export function loadKnowledge() {
  const { bundledDir, userDir } = knowledgeDirs();
  const bundled = readJsonSafe(path.join(bundledDir, 'issues.json'), []);
  const user = readJsonSafe(path.join(userDir, 'user-issues.json'), []);
  return [...bundled, ...user];
}

/**
 * Match a finding against the knowledge base.
 * Scoring: exact error code > message regex > finding type + wedge kind.
 */
export function matchKnowledge(kb, finding) {
  const hits = [];
  for (const entry of kb) {
    const m = entry.match || {};
    let score = 0;
    const reasons = [];
    if (m.errorCode && finding.code && m.errorCode === finding.code) {
      score += 100;
      reasons.push(`errorCode=${finding.code}`);
    }
    if (m.messagePattern && finding.message) {
      try {
        if (new RegExp(m.messagePattern, 'i').test(finding.message)) {
          score += 60;
          reasons.push('messagePattern');
        }
      } catch {
        /* invalid pattern in KB: ignore */
      }
    }
    if (m.findingType && finding.type && m.findingType === finding.type) {
      score += 20;
      reasons.push(`type=${finding.type}`);
    }
    if (m.wedgeKinds && finding.wedgeKind && m.wedgeKinds.includes(finding.wedgeKind)) {
      score += 30;
      reasons.push(`wedgeKind=${finding.wedgeKind}`);
    }
    if (score > 0) hits.push({ entry, score, reasons });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * Record a new lesson (agent- or user-driven).
 * entry: { title, category, symptom, rootCause, evidence?, match?, fix[], autoFix?, prevention?, learnedFrom? }
 */
export function learn(entry, opts = {}) {
  const { userDir } = knowledgeDirs();
  fs.mkdirSync(userDir, { recursive: true });
  const file = path.join(userDir, 'user-issues.json');
  const list = readJsonSafe(file, []);
  const prefix = entry.category === 'error' ? 'A-U' : entry.category === 'stuck' ? 'B-U' : 'OP-U';
  const id = entry.id || `${prefix}-${String(list.length + 1).padStart(2, '0')}`;
  const record = {
    id,
    title: String(entry.title || '未命名经验').slice(0, 200),
    category: entry.category || 'op',
    severity: entry.severity || 'medium',
    symptom: String(entry.symptom || ''),
    rootCause: String(entry.rootCause || ''),
    evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
    match: entry.match || {},
    fix: Array.isArray(entry.fix) ? entry.fix : [],
    autoFix: entry.autoFix || null,
    prevention: Array.isArray(entry.prevention) ? entry.prevention : [],
    learnedFrom: entry.learnedFrom || opts.learnedFrom || null,
    date: entry.date || new Date().toISOString().slice(0, 10),
  };
  list.push(record);
  fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
  writeExperienceMarkdown([...loadBundledForMd(), ...list]);
  return record;
}

function loadBundledForMd() {
  const { bundledDir } = knowledgeDirs();
  return readJsonSafe(path.join(bundledDir, 'issues.json'), []);
}

/** Render the human-readable experience catalog (EXPERIENCE.md). */
export function writeExperienceMarkdown(entries) {
  const { userDir } = knowledgeDirs();
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'EXPERIENCE.md'), renderExperienceMarkdown(entries), 'utf8');
}

export function renderExperienceMarkdown(entries) {
  const groups = { stuck: [], error: [], op: [] };
  for (const e of entries) (groups[e.category] || groups.op).push(e);
  const lines = [
    '# DSH 使用经验库（dsh-doctor）',
    '',
    '> 由 `dsh-doctor experience learn` 追加；本文件自动生成，可在 `~/.dsh/dsh-doctor/knowledge/` 查看。',
    '',
  ];
  const section = (title, list) => {
    if (!list.length) return;
    lines.push(`## ${title}`, '');
    for (const e of list) {
      lines.push(`### ${e.id} · ${e.title}`);
      lines.push('');
      if (e.symptom) lines.push(`**症状**：${e.symptom}`);
      if (e.rootCause) lines.push(`**根因**：${e.rootCause}`);
      if (e.fix?.length) lines.push(`**修复**：${e.fix.map((s, i) => `${i + 1}. ${s}`).join(' ')}`);
      if (e.prevention?.length) lines.push(`**预防**：${e.prevention.join('；')}`);
      if (e.learnedFrom) lines.push(`**来源**：${e.learnedFrom}（${e.date}）`);
      lines.push('');
    }
  };
  section('一、会话卡死 / 调度僵死（类型 B）', groups.stuck);
  section('二、回合报错终止（类型 A）', groups.error);
  section('三、使用习惯与运维（OP）', groups.op);
  return lines.join('\n');
}
