// 画面やFirebaseに依存しない計算・解析処理（Nodeでテスト可能）

export const STATUSES = [
  { key: 'todo', label: '未着手' },
  { key: 'wip', label: '作業中' },
  { key: 'packed', label: '梱包済み' },
  { key: 'shipped', label: '発送済み' },
  { key: 'hold', label: '保留/不具合' },
];
export const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.key, s.label]));
export const isDone = (s) => s === 'packed' || s === 'shipped';

export const DEFAULT_CONFIG = {
  members: ['遠藤', '神谷', '福山', '根本', '橋本'],
  defaultTarget: 30,
  standardMin: 50, // 1台あたり1人の標準作業時間（分）
  minSamples: 3, // この台数以上完了したら実績ペースを使う
  workStart: '07:00',
  workEnd: '19:00',
  overtimeLimit: '22:00',
  projectTotal: 0, // 総台数（0なら計画の最終累計か登録台数）
  plan: [], // 日別計画 [{ d, t, c?, h? }]
  breaks: '12:00-13:00',
  pcMin: 160,
  pcMax: 660,
  // 報告文（メール）
  reportVer: 2,
  reportGroup: 'worker', // worker: 作業者ごと | together: 1つにまとめる（見出し=作業者を/区切り）
  headerTpl: '{worker}',
  lineTpl: '≪{pc}≫　≪{yrl}≫　≪{slip}≫',
  groupFooterTpl: '合計{count}台',
  footerTpl: '', // 梱包実績の総合計（空欄で無し）
  shipInclude: true,
  shipHeaderTpl: 'また、本日の発送台数も報告致します。',
  shipFooterTpl: '合計{count}台',
  shipSort: 'pc', // pc | time（発送登録した順）
  endTpl: '以上',
};

export const YRL_RE = /^\d{2}-\d{7}$/;
export const SLIP_RE = /^\d{4}-\d{4}-\d{4}$/;

// 全角英数字→半角、数字に挟まれたダッシュ類→ハイフン
export function normNum(s) {
  return String(s ?? '')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－ー―‐−–—]/g, '-')
    .replace(/　/g, ' ')
    .trim();
}
function normLine(s) {
  return String(s ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/(\d)\s*[－ー―‐−–—]\s*(?=\d)/g, '$1-');
}

// 発送伝票番号：数字12桁（空白・ハイフンの有無は問わない）なら 0000-0000-0000 に整える
export function normSlip(v) {
  const s = normNum(v);
  const d = s.replace(/[\s-]/g, '');
  return /^\d{12}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8)}` : s;
}

export function parsePc(v) {
  const s = normNum(v).replace(/^0+(?=\d)/, '');
  return /^\d{1,6}$/.test(s) ? Number(s) : null;
}

export function parseStatus(v) {
  const s = normNum(v).toLowerCase();
  if (!s) return null;
  for (const st of STATUSES) if (s === st.key) return st.key;
  if (/保留|不具合|ng/.test(s)) return 'hold';
  if (/未着手/.test(s)) return 'todo';
  if (/未発送/.test(s)) return null;
  if (/発送|出荷/.test(s)) return 'shipped';
  if (/梱包|完了/.test(s)) return 'packed';
  if (/作業中|着手/.test(s)) return 'wip';
  if (/^未$/.test(s)) return 'todo';
  return null;
}

// ---------- 日付・時刻 ----------
const pad = (n) => String(n).padStart(2, '0');
export function dateKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function dayBase(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}
export function hm(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDur(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60);
  return h ? `${h}時間${min % 60}分` : `${min}分`;
}
export function parseBreaks(str) {
  return String(str || '')
    .split(/[,、\s]+/)
    .map((p) => p.split(/[-~〜]/).map(hm))
    .filter((p) => p.length === 2 && p[0] != null && p[1] != null && p[1] > p[0])
    .sort((a, b) => a[0] - b[0]);
}

// a〜b の間の実働分（休憩を除く）
export function workMinutes(a, b, base, breaks) {
  if (b <= a) return 0;
  let total = b - a;
  for (const [s, e] of breaks) {
    const bs = base + s * 60000;
    const be = base + e * 60000;
    total -= Math.max(0, Math.min(b, be) - Math.max(a, bs));
  }
  return total / 60000;
}

// start から実働 mins 分進めた時刻（休憩をスキップ）
export function addWorkMinutes(start, mins, base, breaks) {
  let t = start;
  let rest = mins * 60000;
  for (const [s, e] of breaks) {
    const bs = base + s * 60000;
    const be = base + e * 60000;
    if (be <= t) continue;
    if (bs <= t) { t = be; continue; }
    if (rest <= bs - t) return t + rest;
    rest -= bs - t;
    t = be;
  }
  return t + rest;
}

// ---------- 稼働（出勤・退勤） ----------
// att = { 名前: [{ s: ms, e: ms|null }, ...] }
export function activeMembers(att) {
  return Object.entries(att || {})
    .filter(([, ivs]) => ivs?.length && ivs[ivs.length - 1].e == null)
    .map(([n]) => n);
}
export function personMinutes(att, now, base, startMin, breaks) {
  const from = base + startMin * 60000;
  let sum = 0;
  for (const ivs of Object.values(att || {})) {
    for (const iv of ivs || []) {
      const s = Math.max(iv.s, from);
      const e = Math.min(iv.e ?? now, now);
      sum += workMinutes(s, e, base, breaks);
    }
  }
  return sum;
}

// ---------- 予測 ----------
export function forecast({ day, cfg, done, now, date }) {
  const base = dayBase(date);
  const breaks = parseBreaks(cfg.breaks);
  const startMin = hm(cfg.workStart) ?? 420;
  const endMs = base + (hm(cfg.workEnd) ?? 1140) * 60000;
  const limitMs = base + (hm(cfg.overtimeLimit) ?? hm(cfg.workEnd) ?? 1140) * 60000;
  const goal = Number(day?.target || 0) + Number(day?.carry || 0);
  const remaining = Math.max(0, goal - done);
  const active = activeMembers(day?.att).length;
  const pm = personMinutes(day?.att, now, base, startMin, breaks);
  const useActual = done >= (cfg.minSamples || 3) && pm >= 30; // 稼働30分未満は標準値
  const perUnit = useActual ? pm / done : Number(cfg.standardMin) || 50; // 人・分 / 台
  const r = { goal, done, remaining, active, personMin: pm, perUnit, source: useActual ? 'actual' : 'standard', endMs, limitMs };
  r.pacePerHour = active ? (60 * active) / perUnit : 0;
  if (!remaining) return { ...r, state: 'achieved' };
  if (!active) return { ...r, state: 'nomember' };
  const start = Math.max(now, base + startMin * 60000);
  const wallMin = (remaining * perUnit) / active;
  r.etaMs = addWorkMinutes(start, wallMin, base, breaks);
  r.capEnd = Math.floor((workMinutes(start, endMs, base, breaks) * active) / perUnit);
  r.capLimit = Math.floor((workMinutes(start, limitMs, base, breaks) * active) / perUnit);
  if (r.etaMs <= endMs) r.state = 'ontime';
  else if (r.etaMs <= limitMs) r.state = 'overtime';
  else r.state = 'carry';
  r.overtimeMin = r.etaMs > endMs ? workMinutes(Math.max(endMs, start), r.etaMs, base, breaks) : 0;
  r.carryForecast = Math.max(0, remaining - r.capLimit);
  return r;
}

export function doneOn(units, date) {
  return Object.values(units).filter((u) => isDone(u.status) && u.packedDate === date);
}
export function carryFrom(prevDay, prevDone) {
  if (!prevDay) return 0;
  return Math.max(0, Number(prevDay.target || 0) + Number(prevDay.carry || 0) - prevDone);
}

// ---------- 取り込み ----------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findMember(line, members) {
  const hit = [...members].sort((a, b) => b.length - a.length).find((m) => m && line.includes(m));
  return hit || null;
}

// テキスト → 表（行×列）。最後に「見出し作業者」列を付ける
export function textToTable(text, mode, opt = {}, members = []) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  let ctx = '';
  let headers;
  let mapping = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const line = normLine(raw);
    let cells = [];
    if (mode === 'auto') {
      const yrl = (line.match(/\d{2}-\d{7}(?!\d)/) || [''])[0];
      const slipRaw = (line.match(/(?<![\d-])\d{4}-?\d{4}-?\d{4}(?![\d-])/) || [''])[0];
      const slip = slipRaw ? normSlip(slipRaw) : '';
      const rest = line.replace(yrl || '\u0000', ' ').replace(slipRaw || '\u0000', ' ');
      const nums = (rest.match(/(?<![\d-])\d{1,4}(?![\d-])/g) || []).map(Number);
      const inRange = nums.find((n) => n >= (opt.pcMin ?? 0) && n <= (opt.pcMax ?? 99999));
      const pc = inRange ?? '';
      if (pc !== '' || yrl || slip) cells = [String(pc), yrl, slip, findMember(line, members) || ''];
    } else if (mode === 'bracket') {
      const o = opt.open || '≪';
      const c = opt.close || '≫';
      const re = new RegExp(esc(o) + '(.*?)' + esc(c), 'g');
      cells = [...line.matchAll(re)].map((m) => m[1].trim());
    } else if (mode === 'delim') {
      const d = opt.delim === 'tab' ? '\t' : opt.delim === 'comma' ? ',' : opt.delim === 'space' ? /[\s　]+/ : opt.delim || ',';
      cells = (typeof d === 'string' ? line.split(d) : line.trim().split(d)).map((s) => s.trim().replace(/^"(.*)"$/, '$1'));
      if (cells.length < 2) cells = [];
    } else if (mode === 'regex') {
      let re;
      try { re = new RegExp(opt.pattern || '', 'u'); } catch { throw new Error('正規表現が正しくありません'); }
      const m = re.exec(line);
      if (m) {
        cells = m.slice(1).map((s) => (s ?? '').trim());
        if (m.groups && !mapping) {
          const names = Object.keys(m.groups);
          mapping = {};
          names.forEach((n) => { if (['pc', 'yrl', 'slip', 'worker', 'status'].includes(n)) mapping[n] = groupIndex(re.source, n); });
        }
      }
    }
    if (!cells.length) {
      const mem = findMember(raw, members);
      if (mem) ctx = mem;
      continue;
    }
    rows.push([...cells, ctx]);
  }
  const width = Math.max(0, ...rows.map((r) => r.length));
  rows.forEach((r) => { const ctxv = r.pop(); while (r.length < width - 1) r.push(''); r.push(ctxv); });
  if (mode === 'auto') {
    headers = ['PC番号', 'YRL番号', '発送伝票番号', '作業者(行内)', '見出し作業者'];
    mapping = { pc: 0, yrl: 1, slip: 2, worker: rows.some((r) => r[3]) ? 3 : rows.some((r) => r[4]) ? 4 : -1 };
  } else {
    headers = Array.from({ length: width }, (_, i) => (i === width - 1 ? '見出し作業者' : `列${i + 1}`));
  }
  return { headers, rows, mapping };
}

// 名前付きグループが何番目のキャプチャか
function groupIndex(src, name) {
  let idx = 0;
  const re = /\\.|\[(?:\\.|[^\]])*\]|\((\?<([A-Za-z_]\w*)>|\?)?/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[0][0] !== '(') continue;
    if (m[1] === '?') continue;
    if (m[2] === name) return idx;
    idx++;
  }
  return -1;
}

const HEADER_HINTS = {
  pc: /pc|ＰＣ|端末|号機|機番|管理番号/i,
  yrl: /yrl/i,
  slip: /伝票|送り状|追跡|問合せ|問い合わせ/,
  worker: /作業者|担当/,
  status: /ステータス|状態|状況/,
};

// 列の中身・見出しから対応を推測
export function guessMapping(headers, rows, members = [], cfg = DEFAULT_CONFIG) {
  const m = { pc: -1, yrl: -1, slip: -1, worker: -1, status: -1 };
  const used = new Set();
  headers.forEach((h, i) => {
    for (const [k, re] of Object.entries(HEADER_HINTS)) {
      if (m[k] < 0 && !used.has(i) && re.test(String(h || ''))) { m[k] = i; used.add(i); }
    }
  });
  const sample = rows.slice(0, 50);
  const ratio = (i, f) => {
    const vals = sample.map((r) => r[i]).filter((v) => String(v ?? '').trim());
    return vals.length ? vals.filter(f).length / vals.length : 0;
  };
  const width = Math.max(headers.length, ...sample.map((r) => r.length));
  const tests = {
    yrl: (v) => YRL_RE.test(normNum(v)),
    slip: (v) => SLIP_RE.test(normSlip(v)),
    pc: (v) => { const n = parsePc(v); return n != null && n >= cfg.pcMin && n <= cfg.pcMax; },
    worker: (v) => members.includes(String(v).trim()),
    status: (v) => parseStatus(v) != null,
  };
  for (const k of ['yrl', 'slip', 'pc', 'worker', 'status']) {
    if (m[k] >= 0) continue;
    for (let i = 0; i < width; i++) {
      if (used.has(i)) continue;
      if (ratio(i, tests[k]) >= 0.6) { m[k] = i; used.add(i); break; }
    }
  }
  return m;
}

// 先頭行が見出しっぽいか
export function looksLikeHeader(row) {
  if (!row) return false;
  return row.some((c) => Object.values(HEADER_HINTS).some((re) => re.test(String(c || '')))) &&
    !row.some((c) => YRL_RE.test(normNum(c)) || SLIP_RE.test(normNum(c)));
}

export function rowsToRecords(rows, mapping) {
  const get = (r, k) => (mapping[k] >= 0 ? String(r[mapping[k]] ?? '').trim() : undefined);
  return rows.map((r, i) => {
    const rec = { line: i + 1, raw: r };
    const pcRaw = get(r, 'pc');
    rec.pc = pcRaw === undefined ? null : parsePc(pcRaw);
    const yrl = get(r, 'yrl');
    if (yrl !== undefined) rec.yrl = normNum(yrl);
    const slip = get(r, 'slip');
    if (slip !== undefined) rec.slip = normSlip(slip);
    const worker = get(r, 'worker');
    if (worker !== undefined) rec.worker = worker;
    const st = get(r, 'status');
    if (st !== undefined) rec.status = parseStatus(st);
    return rec;
  });
}

// 取り込み計画。opts: { overwrite: bool, setStatus: null|'col'|statusKey, date, me }
export function planImport(records, units, cfg, opts) {
  const out = [];
  const seen = new Map();
  const yrlOwner = new Map();
  const slipOwner = new Map();
  for (const [pc, u] of Object.entries(units)) {
    if (u.yrl) yrlOwner.set(u.yrl, pc);
    if (u.slip) slipOwner.set(u.slip, pc);
  }
  for (const rec of records) {
    const item = { rec, pc: rec.pc, warnings: [], changes: {} };
    if (rec.pc == null) { item.action = 'error'; item.warnings.push('PC番号が読み取れません'); out.push(item); continue; }
    if (rec.pc < cfg.pcMin || rec.pc > cfg.pcMax) item.warnings.push(`PC番号が範囲外(${cfg.pcMin}〜${cfg.pcMax})`);
    if (rec.yrl && !YRL_RE.test(rec.yrl)) item.warnings.push('YRL番号の形式が違います');
    if (rec.slip && !SLIP_RE.test(rec.slip)) item.warnings.push('伝票番号の形式が違います');
    if (seen.has(rec.pc)) { seen.get(rec.pc).action = 'dup'; seen.get(rec.pc).warnings.push('同じPC番号が後にもあり、後の行を採用'); }
    seen.set(rec.pc, item);
    const cur = units[rec.pc];
    const conflicts = [];
    const want = {};
    if (rec.yrl) want.yrl = rec.yrl;
    if (rec.slip) want.slip = rec.slip;
    if (rec.worker) want.worker = rec.worker;
    let st = null;
    if (opts.setStatus === 'col') st = rec.status || null;
    else if (opts.setStatus) st = opts.setStatus;
    if (st) want.status = st;
    for (const [k, v] of Object.entries(want)) {
      const old = cur?.[k];
      if (old === v) continue;
      if (old && k !== 'status' && !opts.overwrite) { conflicts.push(`${k === 'yrl' ? 'YRL' : k === 'slip' ? '伝票' : '作業者'}: 既存「${old}」≠「${v}」`); continue; }
      item.changes[k] = v;
    }
    if (want.yrl && yrlOwner.has(want.yrl) && yrlOwner.get(want.yrl) !== String(rec.pc)) item.warnings.push(`YRL番号がPC${yrlOwner.get(want.yrl)}と重複`);
    if (want.slip && slipOwner.has(want.slip) && slipOwner.get(want.slip) !== String(rec.pc)) item.warnings.push(`伝票番号がPC${slipOwner.get(want.slip)}と重複`);
    if (item.changes.status) Object.assign(item.changes, statusSideEffects(cur, item.changes.status, opts.date, item.changes.worker || cur?.worker || rec.worker || ''));
    item.conflicts = conflicts;
    item.action = !cur ? 'new' : Object.keys(item.changes).length ? (conflicts.length ? 'partial' : 'update') : conflicts.length ? 'conflict' : 'same';
    out.push(item);
  }
  return out;
}

export function buildImportUpdates(plan, now, me, importId) {
  const ups = {};
  for (const it of plan) {
    if (it.action === 'error' || it.action === 'dup' || it.action === 'same' || it.action === 'conflict') continue;
    const base = it.action === 'new' ? { pc: it.pc, yrl: '', slip: '', worker: '', status: 'todo', packedDate: null, note: '', createdAt: now } : {};
    ups[it.pc] = { ...base, ...it.changes, updatedAt: now, updatedBy: me };
    if (importId) ups[it.pc].importId = importId;
  }
  return ups;
}

// 表での一括編集の差分 → 更新内容。edits = { pc: { yrl, slip, worker, status, packedDate, note } }（変えた項目だけ）
export const EDIT_FIELDS = ['yrl', 'slip', 'worker', 'status', 'packedDate', 'note'];
export function buildEditUpdates(edits, units, today, now, me) {
  const ups = {};
  const logs = [];
  for (const [pc, e] of Object.entries(edits)) {
    const cur = units[pc];
    if (!cur) continue;
    const ch = {};
    for (const k of ['yrl', 'slip', 'worker', 'note']) {
      if (k in e && (cur[k] || '') !== (e[k] || '')) ch[k] = e[k] || '';
    }
    if (e.status && e.status !== cur.status) {
      const w = 'worker' in ch ? ch.worker : cur.worker || me;
      Object.assign(ch, { status: e.status }, statusSideEffects(cur, e.status, e.packedDate || today, w));
      if (e.status === 'shipped') ch.shippedDate = today; // 発送日は本日（梱包日の欄とは別）
      if ('worker' in e) ch.worker = e.worker || '';
      logs.push({ pc: Number(pc) || pc, from: cur.status, to: e.status });
    }
    const st = ch.status ?? cur.status;
    if (isDone(st) && e.packedDate && e.packedDate !== (ch.packedDate ?? cur.packedDate)) {
      if (!cur.packedDate || cur.packedDate !== e.packedDate) logs.push({ pc: Number(pc) || pc, msg: `PC${pc}の梱包日を${e.packedDate}に変更` });
      ch.packedDate = e.packedDate;
    }
    if (Object.keys(ch).length) ups[pc] = { ...ch, updatedAt: now, updatedBy: me };
  }
  return { ups, logs };
}

// ステータス変更時に一緒に変える項目
export function statusSideEffects(cur, status, date, worker) {
  const ch = {};
  if (isDone(status)) {
    if (!cur?.packedDate || !isDone(cur?.status)) { ch.packedDate = date; ch.packedAt = Date.now(); }
  } else if (cur?.packedDate) {
    ch.packedDate = null;
    ch.packedAt = null;
  }
  if (status === 'shipped' && cur?.status !== 'shipped') { ch.shippedAt = Date.now(); ch.shippedDate = date; }
  if (status !== 'shipped' && cur?.status === 'shipped') { ch.shippedAt = null; ch.shippedDate = null; }
  if (status !== 'todo' && !cur?.worker && worker) ch.worker = worker;
  return ch;
}

// ---------- 出力 ----------
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
const byPc = (a, b) => Number(a.pc) - Number(b.pc) || String(a.pc).localeCompare(String(b.pc));

export const shipDateOf = (u) => (u.status === 'shipped' ? u.shippedDate || (u.shippedAt ? dateKey(u.shippedAt) : null) : null);
export function shippedOn(units, date) {
  return Object.values(units).filter((u) => shipDateOf(u) === date);
}

// 報告文。opts: { worker, group, ship, names }（未指定は cfg の設定）
export function formatReport(units, date, cfg, opts = {}) {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  const line = (u) => fill(c.lineTpl, { pc: u.pc, yrl: u.yrl || '', slip: u.slip || '', worker: u.worker || '', status: STATUS_LABEL[u.status] });
  const list = doneOn(units, date).filter((u) => !opts.worker || (u.worker || '') === opts.worker);
  const members = c.members || [];
  const groups = new Map();
  for (const u of list) {
    const w = u.worker || '未設定';
    if (!groups.has(w)) groups.set(w, []);
    groups.get(w).push(u);
  }
  const order = [...members, ...[...groups.keys()].filter((k) => !members.includes(k))].filter((w) => groups.has(w));
  const block = (name, g) => {
    g.sort(byPc);
    return [fill(c.headerTpl || '', { worker: name, count: g.length, date }), ...g.map(line), fill(c.groupFooterTpl || '', { count: g.length, worker: name, date })]
      .filter((l) => l.trim()).join('\n');
  };
  const parts = [];
  if (list.length) {
    if ((opts.group ?? c.reportGroup) === 'worker') for (const w of order) parts.push(block(w, groups.get(w)));
    else parts.push(block(opts.names || order.join('/'), [...list]));
    if (c.footerTpl) parts.push(fill(c.footerTpl, { total: list.length, count: list.length, date }));
  }
  if (opts.ship ?? c.shipInclude) {
    const sh = shippedOn(units, date);
    if (sh.length) {
      sh.sort((c.shipSort === 'time') ? (a, b) => (a.shippedAt || 0) - (b.shippedAt || 0) || byPc(a, b) : byPc);
      parts.push([fill(c.shipHeaderTpl || '', { count: sh.length, date }), ...sh.map(line), fill(c.shipFooterTpl || '', { count: sh.length, date })]
        .filter((l) => l.trim()).join('\n'));
    }
  }
  if (parts.length && c.endTpl) parts.push(c.endTpl);
  return parts.join('\n\n');
}

// ---------- 番号照合 ----------
// 貼り付けた文字列の各行から PC/YRL/伝票 を読み取り、登録済みのPCと突き合わせる
export function matchNumbers(text, units, cfg = DEFAULT_CONFIG) {
  const bySlip = new Map();
  const byYrl = new Map();
  for (const u of Object.values(units)) {
    if (u.slip) bySlip.set(u.slip, u);
    if (u.yrl) byYrl.set(u.yrl, u);
  }
  const t = textToTable(text, 'auto', { pcMin: cfg.pcMin, pcMax: cfg.pcMax });
  const seen = new Map();
  return t.rows.map(([pcS, yrl, slip]) => {
    const pc = pcS ? Number(pcS) : null;
    let unit = null;
    let by = null;
    if (slip && bySlip.has(slip)) { unit = bySlip.get(slip); by = 'slip'; }
    else if (yrl && byYrl.has(yrl)) { unit = byYrl.get(yrl); by = 'yrl'; }
    else if (pc != null && units[pc]) { unit = units[pc]; by = 'pc'; }
    const r = { pc, yrl, slip, unit, by, mismatch: [], fill: {}, dup: false };
    if (unit) {
      if (pc != null && Number(unit.pc) !== pc) r.mismatch.push(`PC番号が違います（登録はPC${unit.pc}）`);
      if (yrl && unit.yrl && unit.yrl !== yrl) r.mismatch.push(`YRL番号が違います（登録は${unit.yrl}）`);
      if (slip && unit.slip && unit.slip !== slip) r.mismatch.push(`伝票番号が違います（登録は${unit.slip}）`);
      if (yrl && !unit.yrl) r.fill.yrl = yrl;
      if (slip && !unit.slip) r.fill.slip = slip;
      const k = String(unit.pc);
      if (seen.has(k)) { r.dup = true; seen.get(k).dup = true; } else seen.set(k, r);
    }
    return r;
  });
}

const fmtDT = (ms) => (ms ? `${dateKey(ms)} ${fmtTime(ms)}` : '');
export const EXPORT_COLUMNS = [
  { key: 'pc', label: 'PC番号', w: 8, get: (u) => u.pc },
  { key: 'yrl', label: 'YRL番号', w: 13, get: (u) => u.yrl || '' },
  { key: 'slip', label: '発送伝票番号', w: 17, get: (u) => u.slip || '' },
  { key: 'worker', label: '作業者', w: 10, get: (u) => u.worker || '' },
  { key: 'status', label: 'ステータス', w: 10, get: (u) => STATUS_LABEL[u.status] || '' },
  { key: 'packedDate', label: '梱包日', w: 11, get: (u) => u.packedDate || '' },
  { key: 'packedAt', label: '梱包日時', w: 17, get: (u) => fmtDT(u.packedAt) },
  { key: 'shippedDate', label: '発送日', w: 11, get: (u) => shipDateOf(u) || '' },
  { key: 'shippedAt', label: '発送日時', w: 17, get: (u) => (u.status === 'shipped' ? fmtDT(u.shippedAt) : '') },
  { key: 'updatedAt', label: '更新日時', w: 17, get: (u) => fmtDT(u.updatedAt) },
  { key: 'updatedBy', label: '更新者', w: 10, get: (u) => u.updatedBy || '' },
  { key: 'createdAt', label: '登録日時', w: 17, get: (u) => fmtDT(u.createdAt) },
  { key: 'note', label: '備考', w: 24, get: (u) => u.note || '' },
];
export const DEFAULT_EXPORT = {
  statuses: STATUSES.map((s) => s.key), // 未完了も含めて全ステータス
  worker: 'all', // all | none | 名前
  dateFrom: '', // 梱包日の範囲（梱包済み/発送済みにだけ適用）
  dateTo: '',
  slip: 'all', // all | has | none
  columns: ['pc', 'yrl', 'slip', 'worker', 'status', 'packedDate', 'updatedAt', 'updatedBy', 'note'],
  sort: 'pc', // pc | worker | status | packedDate
  split: 'none', // Excelのシート分け: none | status | worker
  summary: true, // Excelに日別実績シートを付ける
};
const STATUS_ORDER = Object.fromEntries(STATUSES.map((s, i) => [s.key, i]));

export function filterForExport(units, opts = {}) {
  const o = { ...DEFAULT_EXPORT, ...opts };
  const st = new Set(o.statuses);
  const list = Object.values(units).filter((u) => {
    if (!st.has(u.status)) return false;
    if (o.worker === 'none' ? u.worker : o.worker !== 'all' && u.worker !== o.worker) return false;
    if (o.slip === 'has' && !u.slip) return false;
    if (o.slip === 'none' && u.slip) return false;
    if (isDone(u.status) && (o.dateFrom || o.dateTo)) {
      const d = u.packedDate || '';
      if (o.dateFrom && d < o.dateFrom) return false;
      if (o.dateTo && d > o.dateTo) return false;
    }
    return true;
  });
  const cmp = {
    pc: byPc,
    worker: (a, b) => (a.worker || '\uffff').localeCompare(b.worker || '\uffff', 'ja') || byPc(a, b),
    status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byPc(a, b),
    packedDate: (a, b) => (a.packedDate || '9999').localeCompare(b.packedDate || '9999') || byPc(a, b),
  }[o.sort] || byPc;
  return list.sort(cmp);
}

export function exportColumns(opts = {}) {
  const keys = new Set((opts.columns?.length ? opts.columns : DEFAULT_EXPORT.columns));
  return EXPORT_COLUMNS.filter((c) => keys.has(c.key));
}

// [見出し, ...行]
export function exportTable(list, opts = {}) {
  const cols = exportColumns(opts);
  return [cols.map((c) => c.label), ...list.map((u) => cols.map((c) => c.get(u)))];
}

// Excelのシート分け: [{ name, list }]
export function splitForExport(list, split) {
  if (split === 'status') {
    return STATUSES.map((s) => ({ name: s.label.replace(/[\\/?*[\]:]/g, '・'), list: list.filter((u) => u.status === s.key) })).filter((g) => g.list.length);
  }
  if (split === 'worker') {
    const m = new Map();
    for (const u of list) {
      const w = u.worker || '未割当';
      if (!m.has(w)) m.set(w, []);
      m.get(w).push(u);
    }
    return [...m].map(([name, l]) => ({ name: name.replace(/[\\/?*[\]:]/g, '・').slice(0, 31), list: l }));
  }
  return [{ name: '一覧', list }];
}

export function toCSV(rows) {
  return rows.map((r) => r.map((c) => {
    const s = String(c ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}

export function chunkId(pc) {
  const n = Number(pc);
  return Number.isFinite(n) ? 'c' + Math.floor(n / 100) : 'cx';
}

// 日別集計
export function dailySummary(units, days) {
  const dates = new Set(Object.keys(days || {}));
  for (const u of Object.values(units)) if (isDone(u.status) && u.packedDate) dates.add(u.packedDate);
  return [...dates].sort().reverse().map((d) => {
    const list = doneOn(units, d);
    const byW = {};
    for (const u of list) byW[u.worker || '未設定'] = (byW[u.worker || '未設定'] || 0) + 1;
    const day = days?.[d] || {};
    const goal = Number(day.target || 0) + Number(day.carry || 0);
    return { date: d, target: Number(day.target || 0), carry: Number(day.carry || 0), goal, done: list.length, byWorker: byW, day };
  });
}

// ---------- 計画（日別目標・目標累計） ----------
// plan = [{ d: 'YYYY-MM-DD', t: 当日目標, c: 目標累計(任意), h: 祝日なら true }]
const WD = '日月火水木金土';
export function weekdayLabel(key, holiday) {
  const d = new Date(dayBase(key));
  return holiday ? '祝' : WD[d.getDay()];
}

// 「10/7(水) 35 120」「2026-10-08 55 175」などを1行ずつ読む
export function parsePlanText(text, today = dateKey()) {
  const [ty, tm] = today.split('-').map(Number);
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = normNum(raw).replace(/[／]/g, '/');
    const m = /(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})日?/.exec(line);
    if (!m) continue;
    let y = m[1] ? Number(m[1]) : ty;
    const mo = Number(m[2]);
    if (!m[1] && Math.abs(mo - tm) > 6) y += mo < tm ? 1 : -1; // 年またぎ
    const d = `${y}-${String(mo).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
    const rest = line.slice(m.index + m[0].length).replace(/\([^)]*\)|（[^）]*）/g, (p) => (/祝/.test(p) ? ' 祝 ' : ' '));
    const nums = (rest.match(/\d+/g) || []).map(Number);
    if (!nums.length) continue;
    rows.push({ d, t: nums[0], ...(nums[1] != null ? { c: nums[1] } : {}), ...(/祝/.test(rest) ? { h: true } : {}) });
  }
  return normalizePlan(rows);
}

// 日付順・重複除去・累計を補完
export function normalizePlan(rows) {
  const m = new Map();
  for (const r of rows || []) if (r?.d) m.set(r.d, { ...r, t: Math.max(0, Number(r.t) || 0) });
  const out = [...m.values()].sort((a, b) => a.d.localeCompare(b.d));
  let cum = 0;
  for (const r of out) {
    if (r.c != null && r.c !== '' && Number.isFinite(Number(r.c))) cum = Number(r.c);
    else cum += r.t;
    r.cum = cum;
  }
  return out;
}

// 日付 → 完了台数、日付以前の累計
function doneCounts(units) {
  const by = {};
  let undated = 0;
  for (const u of Object.values(units)) {
    if (!isDone(u.status)) continue;
    if (u.packedDate) by[u.packedDate] = (by[u.packedDate] || 0) + 1;
    else undated++;
  }
  return { by, undated };
}

// 進捗表：計画の日＋実績のある日。未来日は実績なし
export function progressTable(units, planRows, today) {
  const plan = normalizePlan(planRows);
  const { by, undated } = doneCounts(units);
  const pmap = new Map(plan.map((r) => [r.d, r]));
  const dates = [...new Set([...plan.map((r) => r.d), ...Object.keys(by)])].sort();
  let cumA = undated;
  let cumT = 0;
  // 計画開始前の実績も累計に含める
  return dates.map((d) => {
    const p = pmap.get(d);
    if (p) cumT = p.cum;
    const actual = by[d] || 0;
    cumA += actual;
    const past = d <= today;
    return {
      date: d, holiday: !!p?.h, target: p ? p.t : null, cumTarget: p || cumT ? cumT : null,
      actual: past ? actual : null, cumActual: past ? cumA : null,
      diff: past && (p || cumT) ? cumA - cumT : null, isToday: d === today, future: !past,
    };
  });
}

// 全体のまとめ。total: 総台数
export function planSummary(units, planRows, today, total) {
  const rows = progressTable(units, planRows, today);
  const plan = normalizePlan(planRows);
  const done = Object.values(units).filter((u) => isDone(u.status)).length;
  const tot = Number(total) || plan.at(-1)?.cum || Object.keys(units).length;
  const upto = rows.filter((r) => !r.future);
  const todayRow = rows.find((r) => r.isToday);
  const prevRow = [...upto].reverse().find((r) => r.date < today);
  const cumTargetToday = todayRow?.cumTarget ?? prevRow?.cumTarget ?? 0;
  const planEnd = plan.find((r) => r.cum >= tot)?.d || null;
  // 直近の稼働日（実績>0）最大5日の平均ペース（本日は途中なので除く）
  const recent = upto.filter((r) => r.date < today && r.actual > 0).slice(-5);
  const avg = recent.length ? recent.reduce((a, r) => a + r.actual, 0) / recent.length : 0;
  const remaining = Math.max(0, tot - done);
  let forecastEnd = null;
  if (!remaining) forecastEnd = today;
  else if (avg) {
    const doneToday = todayRow?.actual || 0;
    const left = Math.max(0, remaining - Math.max(0, avg - doneToday)); // 本日分の残り見込みを差し引く
    const days = Math.ceil(left / avg);
    forecastEnd = dateKey(dayBase(today) + days * 86400000 + 3600000);
  }
  return {
    total: tot, done, remaining, cumTargetToday, diff: done - cumTargetToday,
    planEnd, avg, forecastEnd, rows,
    todayPlan: plan.find((r) => r.d === today) || null,
    prevCumTarget: prevRow?.cumTarget ?? 0, prevCumActual: prevRow?.cumActual ?? 0,
  };
}

// 計画がある日の「繰越」= 前日までの目標累計 − 前日までの実績累計（遅れ分）
export function planCarry(units, planRows, date) {
  const rows = progressTable(units, planRows, date).filter((r) => r.date < date);
  const last = rows.at(-1);
  if (!last || last.cumTarget == null) return 0;
  return Math.max(0, last.cumTarget - last.cumActual);
}

// ---------- バックアップ・復元 ----------
export const UNIT_FIELDS = ['pc', 'yrl', 'slip', 'worker', 'status', 'packedDate', 'packedAt', 'shippedAt', 'shippedDate', 'note', 'importId', 'createdAt', 'updatedAt', 'updatedBy'];
// バックアップの内容に戻す更新。バックアップ後に追加されたPCは残す（keepNew=false で削除）
export function buildRestoreUpdates(backupUnits, currentUnits, { keepNew = true } = {}) {
  const ups = {};
  let changed = 0;
  for (const [pc, bu] of Object.entries(backupUnits || {})) {
    const full = Object.fromEntries(UNIT_FIELDS.map((k) => [k, bu[k] ?? null]));
    full.pc = bu.pc ?? Number(pc);
    full.status = bu.status || 'todo';
    const cur = currentUnits[pc];
    if (!cur || UNIT_FIELDS.some((k) => (cur[k] ?? null) !== full[k])) { ups[pc] = full; changed++; }
  }
  let removed = 0;
  if (!keepNew) for (const pc of Object.keys(currentUnits)) if (!backupUnits?.[pc]) { ups[pc] = null; removed++; }
  return { ups, changed, removed };
}

// ---------- バーコード ----------
// 読み取った値 → { kind: 'slip'|'yrl'|'pc'|null, value, raw }
//   ヤマト伝票(Codabar)「a391214190942a」→ 伝票 3912-1419-0942
//   YRLラベル(Code39)「010973381」→ YRL 01-0973381
export function parseScan(raw, cfg = DEFAULT_CONFIG) {
  let s = normNum(raw).replace(/\s+/g, '');
  // Codabar のスタート/ストップ文字（A〜D）を外す
  const cb = /^[A-Da-d](\d[\d-]*)[A-Da-d]$/.exec(s);
  if (cb) s = cb[1];
  const d = s.replace(/-/g, '');
  if (/^\d{12}$/.test(d)) return { kind: 'slip', value: normSlip(d), raw };
  if (/^\d{9}$/.test(d) && (/^\d{2}-\d{7}$/.test(s) || !s.includes('-'))) return { kind: 'yrl', value: `${d.slice(0, 2)}-${d.slice(2)}`, raw };
  if (/^\d{1,4}$/.test(s)) {
    const n = Number(s);
    if (n >= (cfg.pcMin ?? 0) && n <= (cfg.pcMax ?? 99999)) return { kind: 'pc', value: String(n), raw };
  }
  return { kind: null, value: s, raw };
}
export const SCAN_KIND_LABEL = { slip: '伝票番号', yrl: 'YRL番号', pc: 'PC番号' };

// スキャンで新規登録：{pc, yrl, slip} を登録できるか判定し、更新内容を作る
// 既存の値は上書きしない（違う値なら止める）。空欄だけ埋める。
export function planRegister({ pc, yrl, slip }, units, { status = 'packed', date, me = '', now = Date.now() } = {}) {
  const n = parsePc(pc);
  if (n == null) return { ok: false, msg: 'PC番号を入力してください' };
  yrl = yrl ? (parseScan(yrl).kind === 'yrl' ? parseScan(yrl).value : normNum(yrl)) : '';
  slip = slip ? normSlip(slip) : '';
  if (yrl && !YRL_RE.test(yrl)) return { ok: false, msg: `YRL番号の形式が違います（${yrl}）` };
  if (slip && !SLIP_RE.test(slip)) return { ok: false, msg: `伝票番号の形式が違います（${slip}）` };
  for (const u of Object.values(units)) {
    if (Number(u.pc) === n) continue;
    if (yrl && u.yrl === yrl) return { ok: false, msg: `YRL番号 ${yrl} はPC${u.pc}に登録済みです` };
    if (slip && u.slip === slip) return { ok: false, msg: `伝票番号 ${slip} はPC${u.pc}に登録済みです` };
  }
  const cur = units[n];
  if (cur?.yrl && yrl && cur.yrl !== yrl) return { ok: false, msg: `PC${n}のYRL番号はすでに ${cur.yrl} です` };
  if (cur?.slip && slip && cur.slip !== slip) return { ok: false, msg: `PC${n}の伝票番号はすでに ${cur.slip} です` };
  const ch = {};
  if (yrl && !cur?.yrl) ch.yrl = yrl;
  if (slip && !cur?.slip) ch.slip = slip;
  if (!cur?.worker && me) ch.worker = me;
  const st = cur?.status || 'todo';
  if (status && status !== st && !(status === 'packed' && st === 'shipped')) Object.assign(ch, { status }, statusSideEffects(cur, status, date, cur?.worker || me));
  const isNew = !cur;
  if (!isNew && !Object.keys(ch).length) return { ok: true, isNew, ups: {}, msg: `PC${n}は登録済みです（変更なし）` };
  const base = isNew ? { pc: n, yrl: '', slip: '', worker: '', status: 'todo', packedDate: null, note: '', createdAt: now } : {};
  return { ok: true, isNew, pc: n, ups: { [n]: { ...base, ...ch, updatedAt: now, updatedBy: me } }, msg: `PC${n}を${isNew ? '新規登録' : '更新'}しました` };
}
