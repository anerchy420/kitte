import {
  STATUSES, STATUS_LABEL, DEFAULT_CONFIG, YRL_RE, SLIP_RE, isDone, normNum, normSlip, parsePc, parseStatus,
  dateKey, fmtTime, fmtDur, hm, forecast, doneOn, carryFrom, activeMembers,
  textToTable, guessMapping, looksLikeHeader, rowsToRecords, planImport, buildImportUpdates,
  weekdayLabel, parsePlanText, normalizePlan, progressTable, planSummary, planCarry, dayBase,
  buildRestoreUpdates,
  parseScan, SCAN_KIND_LABEL, planRegister,
  statusSideEffects, buildEditUpdates, formatReport, matchNumbers, shippedOn, shipDateOf, EXPORT_COLUMNS, DEFAULT_EXPORT, filterForExport, exportTable, exportColumns, splitForExport, toCSV, dailySummary,
} from './logic.js';
import { createStore, teamIdFromPasscode, isDemo } from './store.js';
import { openScanner } from './scanner.js';

const APP_VERSION = '2026-10-10g';
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* 無視 */ } },
};

const S = {
  store: null,
  me: LS.get('kitte-me') || '',
  cfg: { ...DEFAULT_CONFIG },
  cfgLoaded: false,
  units: {},
  unitsLoaded: false,
  pending: false,
  today: dateKey(),
  day: null,
  dayLoaded: false,
  log: [],
  tab: 'home',
  list: { q: '', status: 'all', worker: 'all', sort: 'pc', select: false, selected: new Set(), limit: 200, imp: '', pdate: '' },
  io: { src: 'text', text: '', mode: 'auto', open: '≪', close: '≫', delim: 'tab', pattern: '', table: null, headerRow: false, mapping: null, overwrite: false, setStatus: '', date: dateKey(), reportDate: dateKey(), reportWorker: '', sheets: null, wb: null },
  history: null,
  unsubs: [],
  dayUnsubs: [],
};

// ================= 共通UI =================
let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
window.addEventListener('store-error', (e) => toast('保存エラー: ' + (e.detail?.message || e.detail), 'err'));

function openSheet(html, mount) {
  // 前回のシートに付けたイベントを残さないよう、要素ごと作り直す
  const old = $('#sheet');
  const sh = old.cloneNode(false);
  old.replaceWith(sh);
  sh.innerHTML = `<div class="sheet-grip"></div>${html}`;
  sh.classList.remove('hidden');
  $('#sheet-backdrop').classList.remove('hidden');
  document.body.classList.add('noscroll');
  mount?.(sh);
}
function closeSheet() {
  $('#sheet').classList.add('hidden');
  $('#sheet-backdrop').classList.add('hidden');
  $('#sheet').innerHTML = '';
  document.body.classList.remove('noscroll');
}
$('#sheet-backdrop').addEventListener('click', closeSheet);

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('コピーしました');
}
async function shareText(text, title) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); } catch { /* キャンセル */ }
  } else copyText(text);
}
let xlsxPromise;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxPromise ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
    s.onload = () => res(window.XLSX);
    s.onerror = () => { xlsxPromise = null; rej(new Error('Excel読み込みライブラリを取得できませんでした')); };
    document.head.appendChild(s);
  });
  return xlsxPromise;
}
const stamp = () => {
  const d = new Date();
  return dateKey().replace(/-/g, '') + '_' + fmtTime(d).replace(':', '');
};
const statusBadge = (s) => `<span class="badge st-${s}">${esc(STATUS_LABEL[s] || s)}</span>`;
const allWorkers = () => {
  const set = new Set(S.cfg.members);
  for (const u of Object.values(S.units)) if (u.worker) set.add(u.worker);
  return [...set];
};

// ================= ログイン =================
async function start() {
  const teamId = LS.get('kitte-team');
  if (!teamId) return showLogin(1);
  try {
    await connect(teamId);
  } catch (e) {
    console.error(e);
    showLogin(1, '接続に失敗しました: ' + e.message);
    return;
  }
  if (!S.me) showLogin(2);
  else enterApp();
}

function showLogin(step, msg = '') {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#login-step1').classList.toggle('hidden', step !== 1);
  $('#login-step2').classList.toggle('hidden', step !== 2);
  $('#login-msg').textContent = msg;
  if (step === 2) renderNameList();
}
function renderNameList() {
  const box = $('#name-list');
  if (!S.cfgLoaded) { box.innerHTML = '<p class="muted">読み込み中…</p>'; return; }
  box.innerHTML = S.cfg.members.length
    ? S.cfg.members.map((m) => `<button class="btn name" data-name="${esc(m)}">${esc(m)}</button>`).join('')
    : '<p class="muted">まだメンバーがいません。下で名前を追加してください。</p>';
}
$('#pass-go').addEventListener('click', async () => {
  const pass = $('#pass').value;
  if (pass.trim().length < 4) { $('#login-msg').textContent = 'パスコードは4文字以上にしてください'; return; }
  $('#pass-go').disabled = true;
  try {
    const id = await teamIdFromPasscode(pass);
    await connect(id);
    LS.set('kitte-team', id);
    showLogin(2);
  } catch (e) {
    $('#login-msg').textContent = '接続に失敗しました: ' + e.message;
  } finally {
    $('#pass-go').disabled = false;
  }
});
$('#pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pass-go').click(); });
$('#name-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-name]');
  if (!b) return;
  S.me = b.dataset.name;
  LS.set('kitte-me', S.me);
  enterApp();
});
$('#new-name-go').addEventListener('click', () => {
  const n = $('#new-name').value.trim();
  if (!n) return;
  if (!S.cfg.members.includes(n)) S.store.setConfig({ members: [...S.cfg.members, n] });
  S.me = n;
  LS.set('kitte-me', n);
  $('#new-name').value = '';
  enterApp();
});

async function connect(teamId) {
  S.unsubs.forEach((f) => f());
  S.dayUnsubs.forEach((f) => f());
  S.unsubs = [];
  S.dayUnsubs = [];
  S.store = await createStore(teamId);
  S.unsubs.push(S.store.onConfig((c, meta) => {
    if (!c && !meta.fromCache) { S.store.setConfig(DEFAULT_CONFIG); return; }
    if (!c) return;
    if (c.reportVer !== 2) {
      // 報告文の書式をメール形式（まとめて見出し・各合計・発送分・以上）へ。手で変えた書式はそのまま
      const mig = { reportVer: 2 };
      if (!c.headerTpl || c.headerTpl === '【{worker}】 {count}台') mig.headerTpl = DEFAULT_CONFIG.headerTpl;
      if (c.footerTpl === undefined || c.footerTpl === '合計 {total}台') mig.footerTpl = DEFAULT_CONFIG.footerTpl;
      Object.assign(c, mig);
      S.store.setConfig(mig);
    }
    S.cfg = { ...DEFAULT_CONFIG, ...c };
    S.cfgLoaded = true;
    if (!$('#login-step2').classList.contains('hidden')) renderNameList();
    maybeEnsureDay();
    rerender('cfg');
  }));
  S.unsubs.push(S.store.onUnits((u, meta) => {
    S.units = u;
    S.pending = !!meta.pending;
    if (!meta.fromCache) S.unitsLoaded = true;
    maybeEnsureDay();
    maybeBackup();
    rerender('units');
  }));
  subscribeDay();
}

function subscribeDay() {
  S.dayUnsubs.forEach((f) => f());
  S.day = null;
  S.dayLoaded = false;
  S.dayFresh = false;
  S.dayUnsubs = [
    S.store.onDay(S.today, (d, meta) => {
      S.day = d;
      S.dayLoaded = true;
      if (!meta.fromCache) S.dayFresh = true;
      maybeEnsureDay();
      rerender('day');
    }),
    S.store.onLog(S.today, (l) => { S.log = l; if (S.tab === 'home') renderHome(); }),
  ];
}

let ensuring = false;
async function maybeEnsureDay() {
  if (ensuring || S.day || !S.dayFresh || !S.unitsLoaded || !S.cfgLoaded) return;
  ensuring = true;
  try {
    const days = await S.store.listDays();
    const prev = Object.keys(days).filter((k) => k < S.today).sort().pop();
    const tp = (S.cfg.plan || []).find((r) => r.d === S.today);
    // 計画がある日は「計画の当日目標＋前日までの遅れ分」、なければ「初期目標＋前日の未達分」
    const carry = tp ? planCarry(S.units, S.cfg.plan, S.today) : prev ? carryFrom(days[prev], doneOn(S.units, prev).length) : 0;
    const target = tp ? tp.t : Number(S.cfg.defaultTarget) || 0;
    await S.store.createDayIfAbsent(S.today, { target, carry, carryFrom: tp ? 'plan' : prev || null, att: {}, createdAt: Date.now() });
  } finally {
    ensuring = false;
  }
}

function enterApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#demo-banner').classList.toggle('hidden', !isDemo);
  if (!S.cfg.members.includes(S.me) && S.cfgLoaded) S.store.setConfig({ members: [...S.cfg.members, S.me] });
  switchTab(S.tab);
}

// ================= タブ =================
document.querySelector('nav.bottom').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) switchTab(b.dataset.tab);
});
function switchTab(tab) {
  S.tab = tab;
  document.querySelectorAll('nav.bottom [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('main .tab').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + tab));
  renderHeader();
  if (tab === 'home') renderHome();
  if (tab === 'list') renderListShell();
  if (tab === 'io') renderIO();
  if (tab === 'history') loadHistory();
  if (tab === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

function rerender(what) {
  if ($('#app').classList.contains('hidden')) return;
  renderHeader();
  if (S.tab === 'home') renderHome();
  if (S.tab === 'list') renderListBody();
  if (S.tab === 'io' && what === 'units' && S.io.table) renderPlan();
  if (S.tab === 'io' && (what === 'units' || what === 'cfg') && !$('#ex-box')?.contains(document.activeElement)) renderExport();
  if (S.tab === 'history' && what === 'units') renderHistory();
  if (S.tab === 'settings' && what === 'cfg' && !$('#tab-settings').contains(document.activeElement)) renderSettings();
}

function renderHeader() {
  const d = new Date();
  $('#today-label').textContent = `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]}) キッティング`;
  $('#me-chip').textContent = '👤 ' + (S.me || '未選択');
  const sync = $('#sync');
  if (!navigator.onLine) { sync.className = 'sync off'; sync.textContent = 'オフライン'; }
  else if (S.pending) { sync.className = 'sync pend'; sync.textContent = '送信中'; }
  else { sync.className = 'sync ok'; sync.textContent = isDemo ? 'デモ' : '同期'; }
}
window.addEventListener('online', renderHeader);
window.addEventListener('offline', renderHeader);
$('#me-chip').addEventListener('click', () => showLogin(2));

// ================= 更新処理 =================
function logEntries(list) {
  return list.map((x) => ({ t: Date.now(), who: S.me, r: Math.random().toString(36).slice(2, 7), ...x }));
}
function changeStatus(pcs, status) {
  const now = Date.now();
  const ups = {};
  const logs = [];
  let noSlip = 0;
  for (const pc of pcs) {
    const cur = S.units[pc];
    if (!cur || cur.status === status) continue;
    if (status === 'shipped' && !cur.slip) noSlip++;
    ups[pc] = { status, ...statusSideEffects(cur, status, S.today, S.me), updatedAt: now, updatedBy: S.me };
    logs.push({ pc: Number(pc) || pc, from: cur.status, to: status });
  }
  if (!logs.length) return;
  S.store.setUnits(ups);
  S.store.addLog(S.today, logEntries(logs));
  toast(`${logs.length}台を「${STATUS_LABEL[status]}」にしました` + (noSlip ? `（伝票番号なし ${noSlip}台）` : ''), noSlip ? 'warn' : '');
}
const NEXT = { todo: ['wip', '作業開始'], wip: ['packed', '梱包済み'], packed: ['shipped', '発送済み'], hold: ['wip', '再開'] };

function setAttendance(name, ivs) {
  S.store.setDay(S.today, { att: { [name]: ivs } });
}
function toggleAttendance(name) {
  const ivs = [...(S.day?.att?.[name] || [])];
  const now = Date.now();
  const last = ivs[ivs.length - 1];
  if (last && last.e == null) ivs[ivs.length - 1] = { ...last, e: now };
  else ivs.push({ s: now, e: null });
  setAttendance(name, ivs);
}

// ================= ホーム =================
function renderHome() {
  const root = $('#tab-home');
  if (!root.querySelector('#home-dyn')) {
    root.innerHTML = `
      <div class="card quick">
        <div class="seg quick-mode"><button type="button" data-qm="open" class="on">PCを開く</button><button type="button" data-qm="reg">新規登録</button><button type="button" data-qm="ship">発送登録</button></div>
        <form id="quick-form" class="row">
          <input id="quick-pc" inputmode="numeric" placeholder="PC番号・YRL・伝票番号で開く" autocomplete="off">
          <button type="button" class="btn cam" id="quick-cam" title="カメラで読み取る">📷</button>
          <button class="btn primary" id="quick-go">開く</button>
        </form>
        <p id="quick-help" class="muted small hidden">伝票番号（またはPC・YRL番号）を入れてEnter／スキャンすると、その台を本日付で発送済みにします。</p>
        <div id="ship-log"></div>
      </div>
      <div id="home-dyn"></div>`;
    let qm = 'open';
    root.querySelector('.quick-mode').addEventListener('click', (e) => {
      const b = e.target.closest('[data-qm]');
      if (!b) return;
      qm = b.dataset.qm;
      root.querySelectorAll('[data-qm]').forEach((x) => x.classList.toggle('on', x === b));
      $('#quick-pc').placeholder = { ship: '伝票番号を入力／スキャン', reg: 'PC番号（あとで入力も可）', open: 'PC番号・YRL・伝票番号で開く' }[qm];
      $('#quick-go').textContent = { ship: '発送', reg: '登録', open: '開く' }[qm];
      $('#quick-help').textContent = qm === 'ship'
        ? '伝票番号（またはPC・YRL番号）を入れてEnter／スキャンすると、その台を本日付で発送済みにします。'
        : '📷 でYRLラベルと伝票を読み取り、PC番号を入れて登録します。続けて次の箱も登録できます。';
      $('#quick-help').classList.toggle('hidden', qm === 'open');
      $('#quick-pc').focus();
    });
    $('#quick-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#quick-pc').value.trim();
      if (!v && qm === 'reg') { openRegister(); return; }
      if (!v) return;
      if (qm === 'reg') {
        $('#quick-pc').value = '';
        openRegister({ pc: v });
        return;
      }
      if (qm === 'ship') {
        quickShip(v);
        $('#quick-pc').value = '';
        $('#quick-pc').focus(); // 続けてスキャンできるように
        return;
      }
      const r = matchNumbers(v, S.units, S.cfg)[0];
      const pc = r?.unit ? r.unit.pc : parsePc(v);
      if (pc == null) return toast('該当するPCがありません', 'warn');
      openUnit(pc);
      $('#quick-pc').value = '';
      $('#quick-pc').blur();
    });
    $('#quick-cam').addEventListener('click', () => {
      if (qm === 'reg') {
        const v = $('#quick-pc').value.trim();
        $('#quick-pc').value = '';
        openRegister(v ? { pc: v } : {});
      } else if (qm === 'ship') {
        openScanner({
          title: '発送登録（連続スキャン）',
          target: 'ヤマト伝票（下に a3912…a と書いてあるバーコード）',
          hint: '1箱ずつ伝票を写すと、その台を発送済みにします。順番は自由です',
          continuous: true,
          cfg: S.cfg,
          onScan: (p) => {
            const r = quickShip(p.value);
            if (!r) return { ok: false, msg: `${p.value} 該当なし` };
            return { ok: r.ok, msg: `${r.pc != null ? `PC${r.pc}` : r.text} ${r.ok ? '発送済みにしました' : r.msg}` };
          },
        });
      } else {
        openScanner({
          title: 'バーコードでPCを開く',
          target: 'YRLラベル（01-0000000）か伝票のどちらか一方',
          cfg: S.cfg,
          onScan: (p) => {
            const r = matchNumbers(p.value, S.units, S.cfg)[0];
            if (!r?.unit) {
              setTimeout(() => openRegister({ [p.kind]: p.value }), 350);
              return { ok: true, msg: `${SCAN_KIND_LABEL[p.kind]} ${p.value} は未登録 → 新規登録へ` };
            }
            setTimeout(() => openUnit(r.unit.pc), 350);
            return { ok: true, msg: `PC${r.unit.pc}` };
          },
        });
      }
    });
    $('#ship-log').addEventListener('click', (e) => {
      const b = e.target.closest('[data-undo]');
      if (!b) return;
      const l = S.shipLog[Number(b.dataset.undo)];
      if (!l || l.undone) return;
      changeStatus([String(l.pc)], l.prev);
      l.undone = true;
      renderShipLog();
    });
    renderShipLog();
    root.addEventListener('click', onHomeClick);
  }
  const dyn = $('#home-dyn');
  if (!S.day) { dyn.innerHTML = `<div class="card"><p class="muted">本日のデータを準備中…</p></div>`; return; }
  const done = doneOn(S.units, S.today);
  const now = Date.now();
  const f = forecast({ day: S.day, cfg: S.cfg, done: done.length, now, date: S.today });
  const pct = f.goal ? Math.min(100, Math.round((f.done / f.goal) * 100)) : 0;

  let fc = '';
  const paceTxt = `${f.perUnit.toFixed(1)}分/台・人（${f.source === 'actual' ? '本日実績' : '標準値'}）`;
  if (f.state === 'achieved') fc = `<div class="verdict ok">🎉 目標達成！</div>`;
  else if (f.state === 'nomember') fc = `<div class="verdict warn">稼働メンバーが0人です。下の「稼働メンバー」で出勤を押してください。</div>`;
  else if (f.state === 'ontime') fc = `<div class="verdict ok">定時（${esc(S.cfg.workEnd)}）内に達成見込み</div>`;
  else if (f.state === 'overtime') fc = `<div class="verdict warn">残業見込み 約${fmtDur(f.overtimeMin)}</div>`;
  else fc = `<div class="verdict bad">延長上限（${esc(S.cfg.overtimeLimit)}）でも約${f.carryForecast}台不足 → 繰越見込み</div>`;

  const active = activeMembers(S.day.att);
  const names = [...new Set([...S.cfg.members, ...Object.keys(S.day.att || {})])];
  const attChips = names.map((n) => {
    const ivs = S.day.att?.[n] || [];
    const on = active.includes(n);
    const since = on ? fmtTime(ivs[ivs.length - 1].s) + '〜' : ivs.length ? '退勤' : '未出勤';
    return `<button class="att ${on ? 'on' : ''}" data-act="att" data-name="${esc(n)}"><b>${esc(n)}</b><small>${since}</small></button>`;
  }).join('');

  const byW = {};
  for (const u of done) byW[u.worker || '未設定'] = (byW[u.worker || '未設定'] || 0) + 1;
  const maxW = Math.max(1, ...Object.values(byW));
  const wRows = Object.entries(byW).sort((a, b) => b[1] - a[1]).map(([w, c]) =>
    `<div class="bar-row"><span class="bar-name">${esc(w)}</span><span class="bar"><i style="width:${(c / maxW) * 100}%"></i></span><b>${c}</b></div>`).join('');

  const all = Object.values(S.units);
  const cnt = Object.fromEntries(STATUSES.map((s) => [s.key, 0]));
  for (const u of all) cnt[u.status] = (cnt[u.status] || 0) + 1;
  const totalDone = cnt.packed + cnt.shipped;

  const logs = [...S.log].sort((a, b) => b.t - a.t).slice(0, 8).map((l) =>
    `<li><span class="muted">${fmtTime(l.t)}</span> ${esc(l.who)}：${l.msg ? esc(l.msg) : `PC${esc(l.pc)} ${esc(STATUS_LABEL[l.from] || '')}→<b>${esc(STATUS_LABEL[l.to])}</b>`}</li>`).join('');

  dyn.innerHTML = `
    <div class="card">
      <div class="card-h"><h2>本日の目標</h2><button class="link" data-act="target">編集</button></div>
      <div class="big-stats">
        <div><small>完了(梱包済み)</small><b class="xl">${f.done}</b></div>
        <div><small>目標</small><b>${f.goal}</b><small class="muted">${S.day.carry ? `(${S.day.target}+${S.day.carryFrom === 'plan' ? '遅れ' : '繰越'}${S.day.carry})` : ''}</small></div>
        <div><small>残り</small><b class="${f.remaining ? 'accent' : 'okc'}">${f.remaining}</b></div>
      </div>
      <div class="progress"><i style="width:${pct}%"></i><span>${pct}%</span></div>
      ${homePlanLine()}
      <div class="muted small ship-today">本日の発送 <b>${shippedOn(S.units, S.today).length}</b>台</div>
    </div>

    <div class="card">
      <div class="card-h"><h2>予測</h2><span class="muted small">${fmtTime(now)}時点</span></div>
      ${fc}
      <dl class="kv">
        <dt>完了予定時刻</dt><dd>${f.etaMs ? `<b>${fmtTime(f.etaMs)}</b>${dateKey(f.etaMs) !== S.today ? '（翌日）' : ''}` : '—'}</dd>
        <dt>残りの所要時間</dt><dd>${f.etaMs ? fmtDur((f.remaining * f.perUnit) / Math.max(1, f.active)) : '—'}</dd>
        <dt>定時までの見込み</dt><dd>${f.capEnd != null ? `あと${f.capEnd}台（計${f.done + f.capEnd}台）` : '—'}</dd>
        <dt>ペース</dt><dd>${paceTxt}</dd>
        <dt>チーム速度</dt><dd>${f.active ? `${f.pacePerHour.toFixed(1)}台/時（${f.active}人）` : '—'}</dd>
        <dt>本日の延べ稼働</dt><dd>${fmtDur(f.personMin)}</dd>
      </dl>
    </div>

    <div class="card">
      <div class="card-h"><h2>稼働メンバー <span class="pill">${active.length}人</span></h2><button class="link" data-act="att-edit">時刻修正</button></div>
      <div class="att-grid">${attChips || '<p class="muted">設定でメンバーを追加してください</p>'}</div>
      <p class="muted small">タップで出勤⇄退勤（休憩時間は自動で除外）</p>
    </div>

    <div class="card">
      <div class="card-h"><h2>本日の作業者別実績</h2></div>
      ${wRows || '<p class="muted">まだありません</p>'}
    </div>

    <div class="card">
      <div class="card-h"><h2>全体の状況</h2><span class="muted small">${totalDone}/${all.length}台 完了</span></div>
      <div class="status-grid">
        ${STATUSES.map((s) => `<button class="st-tile st-${s.key}" data-act="goto-list" data-status="${s.key}"><small>${s.label}</small><b>${cnt[s.key] || 0}</b></button>`).join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h2>最近の更新</h2></div>
      <ul class="log">${logs || '<li class="muted">まだありません</li>'}</ul>
    </div>`;
}

function homePlanLine() {
  const plan = S.cfg.plan || [];
  if (!plan.length) return '';
  const ps = planSummary(S.units, plan, S.today, S.cfg.projectTotal);
  const lag = ps.prevCumActual - ps.prevCumTarget;
  return `<button class="plan-line" data-act="goto-progress">
    <span>累計 <b>${ps.done}</b> / ${ps.total}台</span>
    <span class="diff-chip ${lag >= 0 ? 'ahead' : 'behind'}">前日まで ${lag > 0 ? '+' : ''}${lag}</span>
    <span class="muted">›</span></button>`;
}

function onHomeClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'att') toggleAttendance(b.dataset.name);
  if (act === 'att-edit') openAttendanceEditor();
  if (act === 'target') openTargetEditor();
  if (act === 'goto-progress') switchTab('history');
  if (act === 'goto-list') { S.list.status = b.dataset.status; S.list.worker = 'all'; switchTab('list'); }
}

function openTargetEditor(date = S.today, day = S.day || {}) {
  openSheet(`
    <h3>${date === S.today ? '本日' : esc(date)}の目標（${esc(date)}）</h3>
    <label>目標台数<input id="t-target" type="number" inputmode="numeric" value="${day.target || 0}"></label>
    <label>前日からの繰越<input id="t-carry" type="number" inputmode="numeric" value="${day.carry || 0}"></label>
    <p class="muted small">合計目標 = 目標 + 繰越。繰越は${day.carryFrom === 'plan' ? '計画の目標累計と実績累計の差（遅れ分）' : `前日の未達分${day.carryFrom ? `（${day.carryFrom}分）` : ''}`}から自動計算されます。</p>
    <button id="t-recalc" class="btn">繰越を再計算</button>
    <div class="sheet-actions"><button class="btn" data-close>キャンセル</button><button id="t-save" class="btn primary">保存</button></div>`, (sh) => {
    sh.querySelector('[data-close]').onclick = closeSheet;
    $('#t-recalc').onclick = async () => {
      const days = await S.store.listDays();
      if ((S.cfg.plan || []).some((r) => r.d === date)) {
        $('#t-carry').value = planCarry(S.units, S.cfg.plan, date);
        toast('計画の目標累計と実績累計の差から計算しました');
        return;
      }
      const prev = Object.keys(days).filter((k) => k < date).sort().pop();
      $('#t-carry').value = prev ? carryFrom(days[prev], doneOn(S.units, prev).length) : 0;
      toast(prev ? `${prev}の未達分から計算しました` : '前日のデータがありません');
    };
    $('#t-save').onclick = () => {
      const p = { target: Math.max(0, Number($('#t-target').value) || 0), carry: Math.max(0, Number($('#t-carry').value) || 0) };
      S.store.setDay(date, p);
      if (S.history) { S.history[date] = { ...(S.history[date] || {}), ...p }; if (S.tab === 'history') renderHistory(); }
      closeSheet();
    };
  });
}

function openAttendanceEditor() {
  const names = [...new Set([...S.cfg.members, ...Object.keys(S.day?.att || {})])];
  const toT = (ms) => (ms ? fmtTime(ms) : '');
  const rows = names.map((n) => {
    const ivs = S.day?.att?.[n] || [];
    return `<div class="att-edit" data-name="${esc(n)}"><b>${esc(n)}</b>
      ${ivs.map((iv, i) => `<div class="row iv" data-i="${i}"><input type="time" class="iv-s" value="${toT(iv.s)}"> 〜 <input type="time" class="iv-e" value="${toT(iv.e)}"><button class="btn sm" data-del>✕</button></div>`).join('')}
      <button class="btn sm" data-add>＋ 時間帯を追加</button></div>`;
  }).join('');
  openSheet(`<h3>稼働時間の修正（${S.today}）</h3><p class="muted small">終了を空欄にすると「稼働中」になります。</p>${rows}
    <div class="sheet-actions"><button class="btn" data-close>閉じる</button><button id="att-save" class="btn primary">保存</button></div>`, (sh) => {
    sh.querySelector('[data-close]').onclick = closeSheet;
    sh.addEventListener('click', (e) => {
      if (e.target.matches('[data-del]')) e.target.closest('.iv').remove();
      if (e.target.matches('[data-add]')) {
        const div = document.createElement('div');
        div.className = 'row iv';
        div.innerHTML = `<input type="time" class="iv-s" value="${S.cfg.workStart}"> 〜 <input type="time" class="iv-e" value=""><button class="btn sm" data-del>✕</button>`;
        e.target.before(div);
      }
    });
    $('#att-save').onclick = () => {
      const base = new Date(S.today + 'T00:00:00').getTime();
      const att = {};
      sh.querySelectorAll('.att-edit').forEach((box) => {
        const ivs = [];
        box.querySelectorAll('.iv').forEach((r) => {
          const s = hm(r.querySelector('.iv-s').value);
          const e = hm(r.querySelector('.iv-e').value);
          if (s == null) return;
          ivs.push({ s: base + s * 60000, e: e == null ? null : base + e * 60000 });
        });
        ivs.sort((a, b) => a.s - b.s);
        att[box.dataset.name] = ivs;
      });
      S.store.setDay(S.today, { att });
      closeSheet();
      toast('稼働時間を保存しました');
    };
  });
}

// ================= 一覧 =================
function renderListShell() {
  const root = $('#tab-list');
  const L = S.list;
  const workers = allWorkers();
  root.innerHTML = `
    <div class="list-controls">
      <div class="row">
        <input id="l-q" type="search" placeholder="PC / YRL / 伝票 / 備考で検索" value="${esc(L.q)}">
        <button id="l-add" class="btn primary">＋</button>
      </div>
      <div class="chips" id="l-status"></div>
      <div class="row">
        <select id="l-worker">
          <option value="all">作業者：全員</option>
          <option value="me">自分（${esc(S.me)}）</option>
          <option value="none">未割当</option>
          ${workers.map((w) => `<option value="w:${esc(w)}">${esc(w)}</option>`).join('')}
        </select>
        <select id="l-sort"><option value="pc">PC番号順</option><option value="upd">更新が新しい順</option></select>
        <button id="l-select" class="btn ${L.select ? 'on' : ''}">選択</button>
      </div>
      <select id="l-imp"></select>
      <div class="row">
        <label class="pdate-l">梱包日<input id="l-pdate" type="date" value="${esc(L.pdate)}"></label>
        <button id="l-grid" class="btn">表で編集</button>
      </div>
    </div>
    ${L.pcs ? `<div class="filter-chip">照合結果 ${L.pcs.size}台で絞り込み中 <button class="btn sm" id="l-pcs-clear">解除</button></div>` : ''}
    <div id="l-bulk" class="bulk hidden"></div>
    <div id="l-body"></div>`;
  $('#l-worker').value = L.worker;
  $('#l-sort').value = L.sort;
  $('#l-q').addEventListener('input', (e) => { L.q = e.target.value; L.limit = 200; renderListBody(); });
  $('#l-worker').addEventListener('change', (e) => { L.worker = e.target.value; renderListBody(); });
  $('#l-sort').addEventListener('change', (e) => { L.sort = e.target.value; renderListBody(); });
  $('#l-select').addEventListener('click', () => { L.select = !L.select; L.selected.clear(); $('#l-select').classList.toggle('on', L.select); renderListBody(); });
  $('#l-add').addEventListener('click', () => openUnit(null));
  $('#l-pcs-clear')?.addEventListener('click', () => { L.pcs = null; renderListShell(); });
  $('#l-imp').addEventListener('change', (e) => { L.imp = e.target.value; renderListBody(); });
  $('#l-pdate').addEventListener('change', (e) => { L.pdate = e.target.value; renderListBody(); });
  $('#l-grid').addEventListener('click', () => {
    const list = L.select && L.selected.size ? filteredUnits().list.filter((u) => L.selected.has(String(u.pc))) : filteredUnits().list;
    openGrid(list);
  });
  $('#l-status').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (b) { L.status = b.dataset.status; renderListBody(); }
  });
  $('#l-body').addEventListener('click', onListClick);
  $('#l-bulk').addEventListener('click', onBulkClick);
  renderListBody();
}

function filteredUnits() {
  const L = S.list;
  const q = normNum(L.q).toLowerCase();
  let list = Object.values(S.units);
  if (L.worker === 'me') list = list.filter((u) => u.worker === S.me);
  else if (L.worker === 'none') list = list.filter((u) => !u.worker);
  else if (L.worker.startsWith('w:')) list = list.filter((u) => u.worker === L.worker.slice(2));
  if (L.pcs) list = list.filter((u) => L.pcs.has(String(u.pc)));
  if (L.imp) list = list.filter((u) => u.importId === L.imp);
  if (L.pdate) list = list.filter((u) => isDone(u.status) && u.packedDate === L.pdate);
  if (q) list = list.filter((u) => [u.pc, u.yrl, u.slip, u.note, u.worker].some((v) => String(v ?? '').toLowerCase().includes(q)));
  const counts = { all: list.length, nosl: list.filter((u) => !u.slip).length };
  for (const s of STATUSES) counts[s.key] = list.filter((u) => u.status === s.key).length;
  if (L.status === 'nosl') list = list.filter((u) => !u.slip);
  else if (L.status !== 'all') list = list.filter((u) => u.status === L.status);
  list.sort(L.sort === 'upd' ? (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) : (a, b) => Number(a.pc) - Number(b.pc));
  return { list, counts };
}

function renderListBody() {
  if (!$('#l-body')) return;
  const L = S.list;
  const { list, counts } = filteredUnits();
  const imps = importBatches();
  if (L.imp && !imps.some(([id]) => id === L.imp)) imps.unshift([L.imp, 0]);
  $('#l-imp').innerHTML = `<option value="">取り込み：すべて</option>` + imps.map(([id, n]) => `<option value="${esc(id)}" ${L.imp === id ? 'selected' : ''}>取込 ${esc(id)}（${n}台）</option>`).join('');
  $('#l-pdate').value = L.pdate;
  $('#l-grid').textContent = L.select && L.selected.size ? `選択${L.selected.size}台を表で編集` : `表で編集（${list.length}台）`;
  $('#l-status').innerHTML = [['all', 'すべて'], ...STATUSES.map((s) => [s.key, s.label]), ['nosl', '伝票なし']]
    .map(([k, l]) => `<button class="chip ${L.status === k ? 'on' : ''}" data-status="${k}">${l} <b>${counts[k] ?? 0}</b></button>`).join('');
  const body = $('#l-body');
  if (!Object.keys(S.units).length) {
    body.innerHTML = `<div class="card empty"><p>まだPCが登録されていません。</p><p class="muted small">「入出力」タブからExcelや文字列で一括登録するか、右上の＋で1台ずつ追加できます。</p></div>`;
  } else if (!list.length) {
    body.innerHTML = `<p class="muted center">該当なし</p>`;
  } else {
    const shown = list.slice(0, L.limit);
    body.innerHTML = shown.map((u) => {
      const nx = NEXT[u.status];
      const sel = L.selected.has(String(u.pc));
      return `<div class="unit ${sel ? 'sel' : ''} st-b-${u.status}" data-pc="${esc(u.pc)}">
        ${L.select ? `<span class="check">${sel ? '☑' : '☐'}</span>` : ''}
        <div class="u-pc">${esc(u.pc)}</div>
        <div class="u-main">
          <div class="u-l1">${esc(u.yrl || '—')}</div>
          <div class="u-l2 ${u.slip ? '' : 'muted'}">${esc(u.slip || '伝票番号なし')}</div>
          <div class="u-l3">${statusBadge(u.status)} <span class="muted">${esc(u.worker || '未割当')}${u.packedDate ? ' · ' + esc(u.packedDate.slice(5)) : ''}${u.note ? ' · 📝' : ''}</span></div>
        </div>
        ${!L.select && nx ? `<button class="btn sm next" data-next="${nx[0]}">${nx[1]}</button>` : ''}
      </div>`;
    }).join('') + (list.length > L.limit ? `<button class="btn block" data-more>さらに表示（残り${list.length - L.limit}件）</button>` : '');
  }
  const bulk = $('#l-bulk');
  bulk.classList.toggle('hidden', !L.select);
  if (L.select) {
    bulk.innerHTML = `<span><b>${L.selected.size}</b>台選択</span>
      <button class="btn sm" data-bulk="all">表示中を全選択</button>
      <select id="bulk-status"><option value="">ステータス変更…</option>${STATUSES.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}</select>
      <select id="bulk-worker"><option value="">作業者変更…</option>${allWorkers().map((w) => `<option>${esc(w)}</option>`).join('')}<option value="__none">（未割当にする）</option></select>
      <span class="row bulk-date"><input type="date" id="bulk-date" value="${S.today}"><button class="btn sm" id="bulk-date-go">梱包日を変更</button></span>`;
    $('#bulk-date-go').onclick = () => {
      const d = $('#bulk-date').value;
      if (!d || !L.selected.size) return;
      const pcs = [...L.selected].filter((pc) => isDone(S.units[pc]?.status));
      if (!pcs.length) return toast('梱包済み・発送済みのPCが選ばれていません', 'warn');
      if (!confirm(`${pcs.length}台の梱包日を${d}にしますか？（未完了の${L.selected.size - pcs.length}台は対象外）`)) return;
      const edits = Object.fromEntries(pcs.map((pc) => [pc, { packedDate: d }]));
      applyEdits(edits);
      L.selected.clear();
      renderListBody();
    };
    $('#bulk-status').onchange = (e) => {
      if (!e.target.value || !L.selected.size) return;
      if (confirm(`${L.selected.size}台を「${STATUS_LABEL[e.target.value]}」にしますか？`)) { changeStatus([...L.selected], e.target.value); L.selected.clear(); }
      renderListBody();
    };
    $('#bulk-worker').onchange = (e) => {
      const w = e.target.value === '__none' ? '' : e.target.value;
      if (!e.target.value || !L.selected.size) return;
      const now = Date.now();
      const ups = {};
      for (const pc of L.selected) ups[pc] = { worker: w, updatedAt: now, updatedBy: S.me };
      S.store.setUnits(ups);
      toast(`${L.selected.size}台の作業者を変更しました`);
      L.selected.clear();
      renderListBody();
    };
  }
}

function onListClick(e) {
  if (e.target.closest('[data-more]')) { S.list.limit += 300; renderListBody(); return; }
  const card = e.target.closest('.unit');
  if (!card) return;
  const pc = card.dataset.pc;
  const nx = e.target.closest('[data-next]');
  if (nx) {
    const to = nx.dataset.next;
    if (to === 'shipped' && !S.units[pc]?.slip && !confirm(`PC${pc}は伝票番号が未入力です。発送済みにしますか？`)) return;
    changeStatus([pc], to);
    return;
  }
  if (S.list.select) {
    S.list.selected.has(pc) ? S.list.selected.delete(pc) : S.list.selected.add(pc);
    renderListBody();
    return;
  }
  openUnit(pc);
}
function onBulkClick(e) {
  if (e.target.closest('[data-bulk="all"]')) {
    filteredUnits().list.forEach((u) => S.list.selected.add(String(u.pc)));
    renderListBody();
  }
}

// ================= まとめて編集 =================
function importBatches() {
  const m = new Map();
  for (const u of Object.values(S.units)) if (u.importId) m.set(u.importId, (m.get(u.importId) || 0) + 1);
  return [...m].sort((a, b) => b[0].localeCompare(a[0]));
}

function applyEdits(edits) {
  const { ups, logs } = buildEditUpdates(edits, S.units, S.today, Date.now(), S.me);
  const n = Object.keys(ups).length;
  if (!n) { toast('変更はありません'); return 0; }
  S.store.setUnits(ups);
  S.store.addLog(S.today, logEntries([...logs.filter((l) => !l.msg || logs.length <= 5), { msg: `${n}台をまとめて編集` }]));
  toast(`${n}台を更新しました`);
  return n;
}

const GRID_COLS = [
  ['yrl', 'YRL番号'], ['slip', '発送伝票番号'], ['worker', '作業者'], ['status', 'ステータス'], ['packedDate', '梱包日'], ['note', '備考'],
];
function gridCell(u, f, workers) {
  const v = f === 'packedDate' ? (u.packedDate || '') : (u[f] || '');
  if (f === 'worker') return `<select data-f="worker"><option value="">—</option>${workers.map((w) => `<option ${w === v ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select>`;
  if (f === 'status') return `<select data-f="status" class="st-${esc(u.status)}">${STATUSES.map((s) => `<option value="${s.key}" ${s.key === u.status ? 'selected' : ''}>${s.label}</option>`).join('')}</select>`;
  if (f === 'packedDate') return `<input data-f="packedDate" type="date" value="${esc(v)}">`;
  return `<input data-f="${f}" value="${esc(v)}" ${f === 'slip' ? 'inputmode="numeric"' : ''} autocomplete="off">`;
}

function openGrid(list) {
  if (!list.length) return toast('対象のPCがありません', 'warn');
  const workers = allWorkers();
  const orig = new Map(list.map((u) => [String(u.pc), u]));
  openSheet(`
    <h3>まとめて編集（${list.length}台）</h3>
    <div class="fill-box">
      <div class="row wrap">
        <select id="g-col">${GRID_COLS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
        <select id="g-mode"><option value="same">全行に同じ値</option><option value="paste">行ごとに貼り付け（上から順）</option><option value="clear">空にする</option></select>
      </div>
      <div id="g-val"></div>
      <button class="btn sm" id="g-fill">表に反映</button>
      <span class="muted small">※「保存」を押すまで確定しません</span>
    </div>
    <div class="table-wrap grid-wrap">
      <table class="grid"><thead><tr><th>PC</th>${GRID_COLS.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead>
      <tbody>${list.map((u) => `<tr data-pc="${esc(u.pc)}"><th>${esc(u.pc)}</th>${GRID_COLS.map(([f]) => `<td>${gridCell(u, f, workers)}</td>`).join('')}</tr>`).join('')}</tbody></table>
    </div>
    <p class="muted small">梱包日は「梱包済み/発送済み」の行だけ反映されます。ステータスを梱包済みにして梱包日が空なら本日になります。</p>
    <div class="sheet-actions"><span id="g-count" class="muted small grow">変更 0台</span><button class="btn" data-close>閉じる</button><button class="btn primary" id="g-save">保存</button></div>`, (sh) => {
    const tbody = sh.querySelector('tbody');
    const valBox = $('#g-val');
    const renderVal = () => {
      const col = $('#g-col').value;
      const mode = $('#g-mode').value;
      if (mode === 'clear') { valBox.innerHTML = ''; return; }
      if (mode === 'paste') { valBox.innerHTML = `<textarea id="g-v" rows="4" placeholder="1行に1つずつ。表の上の行から順に入ります"></textarea>`; return; }
      if (col === 'worker') valBox.innerHTML = `<select id="g-v"><option value="">（未割当）</option>${workers.map((w) => `<option>${esc(w)}</option>`).join('')}</select>`;
      else if (col === 'status') valBox.innerHTML = `<select id="g-v">${STATUSES.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}</select>`;
      else if (col === 'packedDate') valBox.innerHTML = `<input id="g-v" type="date" value="${S.today}">`;
      else valBox.innerHTML = `<input id="g-v" autocomplete="off">`;
    };
    renderVal();
    $('#g-col').onchange = renderVal;
    $('#g-mode').onchange = renderVal;

    const collect = () => {
      const edits = {};
      tbody.querySelectorAll('tr').forEach((tr) => {
        const u = orig.get(tr.dataset.pc);
        const e = {};
        tr.querySelectorAll('[data-f]').forEach((el) => {
          const f = el.dataset.f;
          let v = el.value.trim();
          if (f === 'yrl') v = normNum(v);
          if (f === 'slip') v = normSlip(v);
          const ov = f === 'status' ? u.status : (u[f] || '');
          const changed = v !== ov;
          el.closest('td').classList.toggle('chg', changed);
          if (changed) e[f] = v;
        });
        if (Object.keys(e).length) {
          if (e.packedDate === undefined && tr.querySelector('[data-f=packedDate]').value) e.packedDate = tr.querySelector('[data-f=packedDate]').value;
          edits[tr.dataset.pc] = e;
        }
      });
      $('#g-count').textContent = `変更 ${Object.keys(edits).length}台`;
      return edits;
    };
    tbody.addEventListener('input', collect);
    tbody.addEventListener('focusout', (e) => { if (e.target.dataset.f === 'slip') e.target.value = normSlip(e.target.value); });
    tbody.addEventListener('change', collect);

    $('#g-fill').onclick = () => {
      const col = $('#g-col').value;
      const mode = $('#g-mode').value;
      const els = [...tbody.querySelectorAll(`[data-f=${col}]`)];
      let vals;
      if (mode === 'clear') vals = els.map(() => '');
      else if (mode === 'paste') {
        vals = ($('#g-v').value || '').split(/\r?\n/).map((x) => x.trim()).filter((x, i, a) => x || i < a.length - 1);
        if (!vals.length) return toast('貼り付ける値を入力してください', 'warn');
        if (vals.length !== els.length) toast(`${vals.length}行を上から反映します（表は${els.length}行）`, 'warn');
      } else vals = els.map(() => $('#g-v').value);
      els.forEach((el, i) => {
        if (i >= vals.length) return;
        let v = vals[i];
        if (col === 'status') {
          if (mode === 'clear') return;
          v = STATUSES.some((s) => s.key === v) ? v : parseStatus(v) || el.value;
        }
        if (col === 'packedDate') v = normNum(v).replace(/\//g, '-');
        if (col === 'yrl') v = normNum(v);
        if (col === 'slip') v = normSlip(v);
        if (col === 'worker' && v && !workers.includes(v)) {
          el.insertAdjacentHTML('beforeend', `<option>${esc(v)}</option>`);
        }
        el.value = v;
      });
      collect();
    };

    sh.querySelector('[data-close]').onclick = () => {
      if (Object.keys(collect()).length && !confirm('保存していない変更があります。閉じますか？')) return;
      closeSheet();
    };
    $('#g-save').onclick = () => {
      const edits = collect();
      const n = Object.keys(edits).length;
      if (!n) return toast('変更はありません');
      const bad = Object.entries(edits).filter(([, e]) => (e.yrl && !YRL_RE.test(e.yrl)) || (e.slip && !SLIP_RE.test(e.slip)));
      if (!confirm(`${n}台の変更を保存しますか？${bad.length ? `\n（形式が違う番号が${bad.length}台あります）` : ''}`)) return;
      applyEdits(edits);
      closeSheet();
    };
  });
}

function showListWith(filter) {
  Object.assign(S.list, { q: '', status: 'all', worker: 'all', imp: '', pdate: '', pcs: null, select: false, limit: 200 }, filter);
  S.list.selected.clear();
  switchTab('list');
}
function openImportBatch(id, grid) {
  showListWith({ imp: id });
  if (grid) openGrid(filteredUnits().list);
}

// ================= 番号照合・発送登録 =================
// 発送済みにする（date=発送日）。fills = { pc: { slip, yrl } } 空欄の補完
function shipUnits(pcs, date, fills = {}) {
  const now = Date.now();
  const ups = {};
  const logs = [];
  for (const pc of pcs) {
    const cur = S.units[pc];
    if (!cur) continue;
    const ch = { ...(fills[pc] || {}) };
    if (cur.status !== 'shipped') {
      Object.assign(ch, { status: 'shipped' }, statusSideEffects(cur, 'shipped', date, cur.worker || S.me));
      logs.push({ pc: Number(pc) || pc, from: cur.status, to: 'shipped' });
    }
    if (Object.keys(ch).length) ups[pc] = { ...ch, updatedAt: now, updatedBy: S.me };
  }
  if (!Object.keys(ups).length) return 0;
  S.store.setUnits(ups);
  S.store.addLog(S.today, logEntries(logs.length > 10 ? [{ msg: `${logs.length}台を発送済みに（${date}）` }] : logs));
  return logs.length;
}

const matchLine = (r) => `≪${r.pc ?? ''}≫　≪${r.yrl || ''}≫　≪${r.slip || ''}≫`;
function renderMatch() {
  const box = $('#mt-box');
  if (!box) return;
  const M = (S.match ||= { text: '', date: S.today, fill: true, res: null });
  const res = M.res;
  let body = '';
  if (res) {
    const hit = res.filter((r) => r.unit);
    const miss = res.filter((r) => !r.unit);
    const warn = hit.filter((r) => r.mismatch.length || r.dup);
    const toShip = [...new Set(hit.filter((r) => r.unit.status !== 'shipped').map((r) => String(r.unit.pc)))];
    const already = [...new Set(hit.filter((r) => r.unit.status === 'shipped').map((r) => String(r.unit.pc)))];
    const listed = new Set(hit.map((r) => String(r.unit.pc)));
    const packedLeft = Object.values(S.units).filter((u) => u.status === 'packed' && !listed.has(String(u.pc))).sort((a, b) => a.pc - b.pc);
    const st = (u) => statusBadge(u.status) + (u.status === 'shipped' && shipDateOf(u) ? ` <small class="muted">${esc(shipDateOf(u).slice(5))}</small>` : '');
    body = `
      <div class="chips static">
        <span class="chip a-new">該当 <b>${hit.length}</b></span>
        <span class="chip a-error">非該当 <b>${miss.length}</b></span>
        ${warn.length ? `<span class="chip warn">要確認 <b>${warn.length}</b></span>` : ''}
        <span class="chip">発送済みにできる <b>${toShip.length}</b></span>
        ${already.length ? `<span class="chip">すでに発送済み <b>${already.length}</b></span>` : ''}
      </div>
      <div class="row wrap mt-actions">
        <label class="pdate-l">発送日<input type="date" id="mt-date" value="${M.date}"></label>
        <button class="btn primary" id="mt-ship" ${toShip.length ? '' : 'disabled'}>該当${toShip.length}台を発送済みにする</button>
      </div>
      <label class="check-l"><input type="checkbox" id="mt-fill" ${M.fill ? 'checked' : ''}> 登録が空欄の伝票番号・YRL番号は貼り付けた値で埋める</label>
      ${miss.length ? `<h3 class="sub">非該当（登録なし） ${miss.length}件 <button class="btn sm" data-copy="miss">コピー</button></h3>
        <div class="table-wrap"><table><tr><th>PC</th><th>YRL</th><th>伝票</th></tr>${miss.map((r) => `<tr class="a-error"><td>${esc(r.pc ?? '')}</td><td>${esc(r.yrl)}</td><td>${esc(r.slip)}</td></tr>`).join('')}</table></div>` : ''}
      <h3 class="sub">該当 ${hit.length}件 <button class="btn sm" data-copy="hit">コピー</button> <button class="btn sm" data-showlist>一覧で表示</button></h3>
      ${hit.length ? `<div class="table-wrap"><table class="plan"><tr><th>PC</th><th>状態</th><th>照合</th></tr>${hit.map((r) => `<tr class="${r.mismatch.length || r.dup ? 'a-conflict' : ''}" data-pc="${esc(r.unit.pc)}">
        <td><b>${esc(r.unit.pc)}</b></td><td>${st(r.unit)}</td>
        <td>${{ slip: '伝票', yrl: 'YRL', pc: 'PC' }[r.by]}で一致${Object.keys(r.fill).length ? ' <small class="muted">（空欄を補完）</small>' : ''}${r.mismatch.map((w) => `<div class="w">⚠ ${esc(w)}</div>`).join('')}${r.dup ? '<div class="w">⚠ 同じPCが2回以上あります</div>' : ''}</td></tr>`).join('')}</table></div>` : '<p class="muted">なし</p>'}
      <details><summary>梱包済みで今回のリストにないもの（未発送） ${packedLeft.length}台</summary>
        <div class="row wrap"><button class="btn sm" data-copy="left">コピー</button></div>
        <div class="table-wrap"><table>${packedLeft.map((u) => `<tr><td>${esc(u.pc)}</td><td>${esc(u.yrl || '')}</td><td>${esc(u.slip || '')}</td><td>${esc(u.worker || '')}</td></tr>`).join('')}</table></div>
      </details>`;
    M.view = { hit, miss, toShip, packedLeft };
  }
  box.innerHTML = `
    <div class="card-h"><h2>番号で照合・発送登録</h2>${res ? '<button class="link" id="mt-clear">クリア</button>' : ''}</div>
    <textarea id="mt-text" rows="${res ? 3 : 6}" placeholder="発送する分の報告文や番号を貼り付け（伝票番号・YRL番号・PC番号のどれでも。1行に1台）">${esc(M.text)}</textarea>
    <div class="row"><button class="btn grow" id="mt-cam">📷 スキャンして追加</button><button class="btn primary grow" id="mt-go">照合する</button></div>
    ${body}`;
  $('#mt-text').oninput = (e) => { M.text = e.target.value; };
  $('#mt-go').onclick = () => {
    M.text = $('#mt-text').value;
    if (!M.text.trim()) return toast('番号を貼り付けてください', 'warn');
    M.res = matchNumbers(M.text, S.units, S.cfg);
    if (!M.res.length) toast('番号を読み取れませんでした', 'warn');
    renderMatch();
  };
  $('#mt-clear')?.addEventListener('click', () => { S.match = null; renderMatch(); });
  $('#mt-cam').onclick = () => {
    const have = new Set((M.text.match(/[\d-]{6,}/g) || []).map((x) => parseScan(x, S.cfg).value));
    let added = 0;
    openScanner({
      title: '照合する番号をスキャン',
      target: '伝票かYRLラベル（1台につくどちらか1つ）',
      hint: '続けて読み取れます。順番は自由。終わったら「完了」',
      continuous: true,
      cfg: S.cfg,
      onScan: (p) => {
        if (have.has(p.value)) return { ok: false, msg: `${p.value} はもう追加済みです` };
        have.add(p.value);
        M.text = (M.text.trim() ? M.text.replace(/\s*$/, '\n') : '') + p.value;
        added++;
        const u = matchNumbers(p.value, S.units, S.cfg)[0]?.unit;
        return { ok: true, msg: `${p.value}${u ? `（PC${u.pc}）` : '（未登録）'} を追加（計${added}件）` };
      },
      onClose: () => {
        if (!added) return renderMatch();
        M.res = matchNumbers(M.text, S.units, S.cfg);
        renderMatch();
      },
    });
  };
  if (!res) return;
  $('#mt-date').onchange = (e) => { M.date = e.target.value || S.today; };
  $('#mt-fill').onchange = (e) => { M.fill = e.target.checked; };
  $('#mt-ship').onclick = () => {
    const { toShip, hit } = M.view;
    const warnN = hit.filter((r) => r.mismatch.length).length;
    if (!confirm(`${toShip.length}台を発送済み（発送日 ${M.date}）にしますか？${warnN ? `\n※番号の不一致が${warnN}件あります` : ''}`)) return;
    const fills = {};
    if (M.fill) for (const r of hit) if (Object.keys(r.fill).length) fills[r.unit.pc] = { ...(fills[r.unit.pc] || {}), ...r.fill };
    const pcs = [...new Set([...toShip, ...Object.keys(fills)])];
    const n = shipUnits(pcs, M.date, fills);
    toast(`${n}台を発送済みにしました`);
    M.res = matchNumbers(M.text, S.units, S.cfg);
    setTimeout(renderMatch, 50);
  };
  box.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => {
    const { hit, miss, packedLeft } = M.view;
    const k = b.dataset.copy;
    const text = k === 'miss' ? miss.map(matchLine).join('\n')
      : k === 'hit' ? hit.map((r) => `≪${r.unit.pc}≫　≪${r.unit.yrl || ''}≫　≪${r.unit.slip || ''}≫`).join('\n')
        : packedLeft.map((u) => `≪${u.pc}≫　≪${u.yrl || ''}≫　≪${u.slip || ''}≫`).join('\n');
    copyText(text);
  }));
  box.querySelector('[data-showlist]')?.addEventListener('click', () => {
    showListWith({ pcs: new Set(M.view.hit.map((r) => String(r.unit.pc))) });
  });
  box.querySelector('table.plan')?.addEventListener('click', (e) => {
    const tr = e.target.closest('[data-pc]');
    if (tr) openUnit(tr.dataset.pc);
  });
}

// ホームの「発送登録」：伝票番号などを入れる（スキャンする）たびに発送済みに
function quickShip(raw) {
  const res = matchNumbers(raw, S.units, S.cfg);
  const log = (S.shipLog ||= []);
  let first = null;
  const push = (e) => { log.unshift({ t: Date.now(), ...e }); first ||= e; };
  if (!res.length) push({ text: raw, ok: false, msg: '番号を読み取れません' });
  for (const r of res) {
    if (!r.unit) { push({ text: r.slip || r.yrl || (r.pc != null ? `PC${r.pc}` : raw), ok: false, msg: '該当なし' }); continue; }
    const u = r.unit;
    if (u.status === 'shipped') { push({ pc: u.pc, ok: false, msg: `すでに発送済み（${(shipDateOf(u) || '').slice(5)}）` }); continue; }
    const prev = u.status;
    shipUnits([String(u.pc)], S.today, Object.keys(r.fill).length ? { [u.pc]: r.fill } : {});
    push({ pc: u.pc, ok: true, prev, msg: r.mismatch.join(' / ') });
  }
  log.splice(30);
  renderShipLog();
  return first;
}
// スキャンで新規登録：YRL・伝票を読み（順不同）、PC番号を入れて保存 → 次の箱へ
function openRegister(prefill = {}) {
  const findBy = (k, v) => (v ? Object.values(S.units).find((u) => u[k] === v) : null);
  let api;
  const count = { n: 0 };
  const $r = (id) => api.el.querySelector('#' + id);
  const info = (t, cls = '') => { const e = $r('rg-info'); e.textContent = t; e.className = 'rg-info ' + cls; };
  const refresh = () => {
    const yrl = $r('rg-yrl').value.trim();
    const slip = $r('rg-slip').value.trim();
    const pcEl = $r('rg-pc');
    const byY = findBy('yrl', parseScan(yrl, S.cfg).kind === 'yrl' ? parseScan(yrl, S.cfg).value : yrl);
    if (byY && !pcEl.value) pcEl.value = byY.pc;
    const pc = parsePc(pcEl.value);
    const cur = pc != null ? S.units[pc] : null;
    const bySlip = findBy('slip', normSlip(slip));
    if (bySlip && Number(bySlip.pc) !== pc) info(`⚠ この伝票はPC${bySlip.pc}に登録済みです`, 'ng');
    else if (byY && pc != null && Number(byY.pc) !== pc) info(`⚠ このYRLはPC${byY.pc}に登録済みです`, 'ng');
    else if (cur) info(`PC${pc}は登録済み（${STATUS_LABEL[cur.status]}${cur.yrl ? '・YRLあり' : ''}${cur.slip ? '・伝票あり' : ''}）→ 空欄だけ追加します`);
    else if (pc != null) info(`PC${pc}を新規登録します`);
    else info(yrl || slip ? 'PC番号を入力してください' : 'YRLラベルと伝票を読み取ってください（順番は自由）');
  };
  const clear = () => {
    ['rg-yrl', 'rg-slip', 'rg-pc'].forEach((id) => { $r(id).value = ''; });
    refresh();
  };
  let autoTimer = null;
  const justSaved = new Map(); // 今この画面で登録した番号 → PC番号（カメラに写り続けても再入力しない）
  const save = () => {
    clearTimeout(autoTimer);
    if (!$r('rg-pc').value.trim() && !$r('rg-yrl').value.trim() && !$r('rg-slip').value.trim()) return false;
    const plan = planRegister({ pc: $r('rg-pc').value, yrl: $r('rg-yrl').value.trim(), slip: $r('rg-slip').value.trim() }, S.units, { status: $r('rg-st').value, date: S.today, me: S.me });
    const li = document.createElement('li');
    if (!plan.ok) {
      api.setMsg(plan.msg, 'ng');
      api.beep(false);
      return false;
    }
    if (Object.keys(plan.ups).length) {
      S.store.setUnits(plan.ups);
      S.units = { ...S.units, ...Object.fromEntries(Object.entries(plan.ups).map(([k, v]) => [k, { ...(S.units[k] || {}), ...v }])) };
      S.store.addLog(S.today, logEntries([{ pc: plan.pc, msg: plan.msg }]));
      S.lastRegPc = plan.pc;
      for (const v of [$r('rg-yrl').value.trim(), normSlip($r('rg-slip').value.trim())]) if (v) justSaved.set(parseScan(v, S.cfg).value, plan.pc);
      count.n++;
    }
    li.className = 'ok';
    li.textContent = `✅ ${plan.msg}`;
    api.el.querySelector('.sc-log').prepend(li);
    api.setMsg(`${plan.msg}。次の箱をどうぞ（この画面で${count.n}台）`);
    api.beep(true);
    clear();
    return true;
  };
  const tryAuto = () => {
    if (!$r('rg-auto').checked) return;
    clearTimeout(autoTimer);
    if (parsePc($r('rg-pc').value) != null && $r('rg-yrl').value && $r('rg-slip').value) autoTimer = setTimeout(save, 150);
  };
  openScanner({
    title: 'スキャンで新規登録',
    target: 'YRLラベルと伝票（順番は自由）',
    hint: '読み取った番号が下の欄に入ります。PC番号を入れて保存',
    continuous: true,
    cfg: S.cfg,
    panel: `
      <div class="reg">
        <label>PC番号<span class="row"><input id="rg-pc" inputmode="numeric" autocomplete="off" placeholder="例 314"><button type="button" class="btn sm" id="rg-next">次の番号</button></span></label>
        <label>YRL番号<input id="rg-yrl" autocomplete="off" placeholder="スキャン（手入力も可）"></label>
        <label>発送伝票番号<input id="rg-slip" inputmode="numeric" autocomplete="off" placeholder="スキャン（なければ空欄）"></label>
        <div id="rg-info" class="rg-info"></div>
        <div class="row wrap">
          <select id="rg-st"><option value="packed">梱包済みにする</option><option value="wip">作業中にする</option><option value="">ステータスは変えない</option></select>
          <label class="check-l"><input type="checkbox" id="rg-auto" checked>3つそろったら自動で保存</label>
        </div>
        <div class="row"><button type="button" class="btn" id="rg-clear">クリア</button><button type="button" class="btn primary grow" id="rg-save">保存して次へ</button></div>
      </div>`,
    onReady: (a) => {
      api = a;
      api.el.classList.add('with-panel');
      if (prefill.pc) $r('rg-pc').value = prefill.pc;
      if (prefill.yrl) $r('rg-yrl').value = prefill.yrl;
      if (prefill.slip) $r('rg-slip').value = prefill.slip;
      const panel = api.el.querySelector('.reg');
      panel.addEventListener('input', refresh);
      $r('rg-slip').addEventListener('blur', (e) => { e.target.value = normSlip(e.target.value); refresh(); });
      $r('rg-yrl').addEventListener('blur', (e) => { const p = parseScan(e.target.value, S.cfg); if (p.kind === 'yrl') e.target.value = p.value; refresh(); });
      $r('rg-pc').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); tryAuto(); } });
      $r('rg-next').onclick = () => {
        // 前回登録した番号＋1。なければ登録済みの最大番号＋1
        const maxPc = Math.max(Number(S.cfg.pcMin) - 1, ...Object.keys(S.units).map(Number).filter(Number.isFinite));
        let n = (S.lastRegPc ?? maxPc) + 1;
        while (S.units[n]?.yrl && n <= Number(S.cfg.pcMax)) n++;
        $r('rg-pc').value = n;
        refresh();
        tryAuto();
      };
      $r('rg-clear').onclick = clear;
      $r('rg-save').onclick = save;
      refresh();
    },
    onScan: (p) => {
      if (justSaved.has(p.value)) return { ok: false, msg: `${p.value} は登録済み（PC${justSaved.get(p.value)}）。次の箱を写してください` };
      if (p.kind === 'yrl') $r('rg-yrl').value = p.value;
      else if (p.kind === 'slip') $r('rg-slip').value = p.value;
      else if (p.kind === 'pc') $r('rg-pc').value = p.value;
      refresh();
      tryAuto();
      return { ok: true, msg: `${SCAN_KIND_LABEL[p.kind]} ${p.value} を読み取り` };
    },
  });
}

function renderShipLog() {
  const box = $('#ship-log');
  if (!box) return;
  const log = S.shipLog || [];
  const n = log.filter((l) => l.ok).length;
  box.innerHTML = log.length ? `<div class="muted small">この画面で発送登録 ${n}台</div><ul class="ship-log">${log.map((l, i) => `<li class="${l.ok ? 'ok' : 'ng'}">
    <span>${l.ok ? '✅' : '⚠'} ${l.pc != null ? `PC<b>${esc(l.pc)}</b>` : esc(l.text)} <small>${l.ok ? '発送済みにしました' : esc(l.msg)}</small>${l.ok && l.msg ? `<div class="w">⚠ ${esc(l.msg)}</div>` : ''}</span>
    ${l.ok && !l.undone ? `<button class="btn sm" data-undo="${i}">取消</button>` : l.undone ? '<small class="muted">取消済</small>' : ''}</li>`).join('')}</ul>` : '';
}

// ================= 1台の編集 =================
function openUnit(pc) {
  const isNew = pc == null || !S.units[pc];
  const u = isNew ? { pc: pc ?? '', yrl: '', slip: '', worker: '', status: 'todo', note: '' } : S.units[pc];
  const workers = allWorkers();
  if (u.worker && !workers.includes(u.worker)) workers.push(u.worker);
  openSheet(`
    <h3>${isNew ? (pc != null ? `PC${esc(pc)}（未登録）を追加` : 'PCを追加') : `PC ${esc(u.pc)}`}</h3>
    ${isNew ? `<label>PC番号<input id="u-pc" inputmode="numeric" value="${esc(u.pc)}"></label>` : ''}
    <label>YRL番号<span class="row"><input id="u-yrl" value="${esc(u.yrl)}" placeholder="01-0000000" autocomplete="off"><button type="button" class="btn cam" data-scan="yrl">📷</button></span></label>
    <label>発送伝票番号<span class="row"><input id="u-slip" value="${esc(u.slip)}" inputmode="numeric" placeholder="0000-0000-0000" autocomplete="off"><button type="button" class="btn cam" data-scan="slip">📷</button></span></label>
    <div id="u-warn" class="warnbox hidden"></div>
    <label>作業者<select id="u-worker"><option value="">（未割当）</option>${workers.map((w) => `<option ${w === u.worker ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select></label>
    <div class="lbl">ステータス</div>
    <div class="seg" id="u-status">${STATUSES.map((s) => `<button type="button" class="st-${s.key} ${s.key === u.status ? 'on' : ''}" data-s="${s.key}">${s.label}</button>`).join('')}</div>
    <label id="u-pdate-l" class="${isDone(u.status) ? '' : 'hidden'}">梱包日（実績の日付）<input id="u-pdate" type="date" value="${esc(u.packedDate || S.today)}"></label>
    <label id="u-sdate-l" class="${u.status === 'shipped' ? '' : 'hidden'}">発送日<input id="u-sdate" type="date" value="${esc(shipDateOf(u) || S.today)}"></label>
    <label>備考<textarea id="u-note" rows="2">${esc(u.note)}</textarea></label>
    ${!isNew ? `<p class="muted small">${u.packedDate ? `梱包日 ${esc(u.packedDate)}　` : ''}${u.updatedAt ? `最終更新 ${dateKey(u.updatedAt)} ${fmtTime(u.updatedAt)} ${esc(u.updatedBy || '')}` : ''}</p>` : ''}
    <div class="sheet-actions">
      ${!isNew ? '<button class="btn danger" id="u-del">削除</button>' : ''}
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="u-save">保存</button>
    </div>`, (sh) => {
    let status = u.status;
    sh.querySelector('[data-close]').onclick = closeSheet;
    $('#u-status').addEventListener('click', (e) => {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      status = b.dataset.s;
      $('#u-status').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      if (status !== 'todo' && !$('#u-worker').value && S.me) $('#u-worker').value = S.me;
      $('#u-pdate-l').classList.toggle('hidden', !isDone(status));
      $('#u-sdate-l').classList.toggle('hidden', status !== 'shipped');
    });
    const check = () => {
      const w = [];
      const yrl = normNum($('#u-yrl').value);
      const slip = normSlip($('#u-slip').value);
      const myPc = isNew ? String(parsePc($('#u-pc').value)) : String(u.pc);
      if (yrl && !YRL_RE.test(yrl)) w.push('YRL番号の形式は「01-0000000」です');
      if (slip && !SLIP_RE.test(slip)) w.push('伝票番号の形式は「0000-0000-0000」です');
      for (const o of Object.values(S.units)) {
        if (String(o.pc) === myPc) continue;
        if (yrl && o.yrl === yrl) w.push(`YRL番号がPC${o.pc}と重複しています`);
        if (slip && o.slip === slip) w.push(`伝票番号がPC${o.pc}と重複しています`);
      }
      if (isNew) {
        const p = parsePc($('#u-pc').value);
        if (p != null && S.units[p]) w.push(`PC${p}は既に登録されています（保存すると上書き）`);
        if (p != null && (p < S.cfg.pcMin || p > S.cfg.pcMax)) w.push(`PC番号が範囲外です（${S.cfg.pcMin}〜${S.cfg.pcMax}）`);
      }
      const box = $('#u-warn');
      box.innerHTML = w.map((x) => `<div>⚠ ${esc(x)}</div>`).join('');
      box.classList.toggle('hidden', !w.length);
    };
    sh.addEventListener('input', check);
    $('#u-slip').addEventListener('blur', (e) => { e.target.value = normSlip(e.target.value); });
    sh.querySelectorAll('[data-scan]').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault();
      const kind = b.dataset.scan;
      openScanner({
        title: `${SCAN_KIND_LABEL[kind]}を読み取る`,
        target: kind === 'yrl' ? 'YRLラベル（01-0000000 のシール）' : 'ヤマト伝票（下に a3912…a と書いてあるバーコード）',
        cfg: S.cfg,
        onScan: (p) => {
          if (p.kind !== kind) return { ok: false, msg: `${p.kind ? SCAN_KIND_LABEL[p.kind] : 'ほかのバーコード'}です（${p.value}）。${SCAN_KIND_LABEL[kind]}を読んでください` };
          const inp = $(kind === 'yrl' ? '#u-yrl' : '#u-slip');
          inp.value = p.value;
          check();
          return { ok: true, msg: p.value };
        },
      });
    }));
    check();
    $('#u-save').onclick = () => {
      const p = isNew ? parsePc($('#u-pc').value) : u.pc;
      if (p == null) return toast('PC番号を入力してください', 'warn');
      const cur = S.units[p];
      const now = Date.now();
      const next = { yrl: normNum($('#u-yrl').value), slip: normSlip($('#u-slip').value), worker: $('#u-worker').value, note: $('#u-note').value.trim() };
      if (status === 'shipped' && !next.slip && cur?.status !== 'shipped' && !confirm('伝票番号が未入力です。発送済みにしますか？')) return;
      const ch = {};
      for (const [k, v] of Object.entries(next)) if ((cur?.[k] || '') !== v) ch[k] = v;
      const pdate = $('#u-pdate').value || S.today;
      if (!cur || cur.status !== status) Object.assign(ch, { status }, statusSideEffects(cur, status, pdate, ch.worker ?? cur?.worker ?? S.me));
      if (ch.worker === undefined && !cur && status !== 'todo') ch.worker = next.worker;
      const sdate = $('#u-sdate').value || S.today;
      if (status === 'shipped' && sdate !== (ch.shippedDate ?? (cur ? shipDateOf(cur) : null))) ch.shippedDate = sdate;
      let dateMoved = false;
      if (isDone(status) && pdate !== (ch.packedDate ?? cur?.packedDate)) { ch.packedDate = pdate; dateMoved = !!cur?.packedDate; }
      if (!Object.keys(ch).length) { closeSheet(); return; }
      const base = cur ? {} : { pc: p, yrl: '', slip: '', worker: '', status: 'todo', packedDate: null, note: '', createdAt: now };
      S.store.setUnits({ [p]: { ...base, ...ch, updatedAt: now, updatedBy: S.me } });
      if (cur && ch.status) S.store.addLog(S.today, logEntries([{ pc: p, from: cur.status, to: status }]));
      if (!cur) S.store.addLog(S.today, logEntries([{ pc: p, msg: `PC${p}を追加` }]));
      if (dateMoved) S.store.addLog(S.today, logEntries([{ pc: p, msg: `PC${p}の梱包日を${pdate}に変更` }]));
      closeSheet();
      toast(`PC${p}を保存しました`);
    };
    $('#u-del')?.addEventListener('click', () => {
      if (!confirm(`PC${u.pc}を削除しますか？（元に戻せません）`)) return;
      S.store.setUnits({ [u.pc]: null });
      S.store.addLog(S.today, logEntries([{ pc: u.pc, msg: `PC${u.pc}を削除` }]));
      closeSheet();
      toast(`PC${u.pc}を削除しました`);
    });
  });
}

// ================= 入出力 =================
const MODE_HELP = {
  auto: 'YRL番号(00-0000000)・伝票番号(0000-0000-0000)・PC番号(範囲内の数字)を1行ずつ自動で見つけます。並び順は自由。メンバー名だけの行は「見出し作業者」として下の行に適用されます。',
  bracket: '指定した括弧で囲まれた部分を左から順に列として取り出します（例：≪271≫　≪01-…≫）。',
  delim: '区切り文字で列に分けます（Excelからのコピペはタブ）。',
  regex: '正規表現のキャプチャ ( ) が順に列になります。名前付き (?<pc>…)(?<yrl>…)(?<slip>…)(?<worker>…)(?<status>…) は自動で対応付け。',
};
const FIELDS = [['pc', 'PC番号 *'], ['yrl', 'YRL番号'], ['slip', '発送伝票番号'], ['worker', '作業者'], ['status', 'ステータス']];

function renderIO() {
  const io = S.io;
  const root = $('#tab-io');
  root.innerHTML = `
    <div class="card" id="mt-box"></div>

    <div class="card">
      <div class="card-h"><h2>報告文（メール用）</h2></div>
      <div class="row">
        <label class="grow">日付<input id="rp-date" type="date" value="${io.reportDate}"></label>
        <label class="grow">作業者<select id="rp-worker"><option value="">全員</option>${allWorkers().map((w) => `<option ${w === io.reportWorker ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select></label>
      </div>
      <div class="row wrap">
        <label class="grow">梱包実績のまとめ方<select id="rp-group"><option value="worker">作業者ごと</option><option value="together">1つにまとめる</option></select></label>
        <label class="grow" id="rp-names-l">見出しの名前<input id="rp-names" placeholder="自動（例：橋本/遠藤）" value="${esc(io.reportNames || '')}"></label>
      </div>
      <label class="check-l"><input type="checkbox" id="rp-ship" ${(io.reportShip ?? S.cfg.shipInclude) ? 'checked' : ''}> 本日の発送分も入れる</label>
      <div id="rp-count" class="muted small"></div>
      <textarea id="rp-text" rows="12"></textarea>
      <div class="row wrap">
        <button class="btn primary" id="rp-copy">コピー</button>
        <button class="btn" id="rp-share">共有/メール</button>
        <button class="btn" id="rp-dl">.txt保存</button>
      </div>
      <p class="muted small">梱包実績＝その日に梱包済み（発送済み含む）になったPC、発送分＝その日に発送済みにしたPC。どちらもPC番号順。送る前にこの欄で直接書き換えられます。書式は設定で変更できます。</p>
    </div>

    <div class="card">
      <div class="card-h"><h2>取り込み</h2></div>
      <div class="seg two" id="io-src">
        <button data-src="text" class="${io.src === 'text' ? 'on' : ''}">文字列を貼り付け</button>
        <button data-src="file" class="${io.src === 'file' ? 'on' : ''}">ファイル (Excel/CSV)</button>
      </div>
      ${io.src === 'text' ? `
        <textarea id="io-text" rows="6" placeholder="ここにメール本文やExcelからコピーした内容を貼り付け">${esc(io.text)}</textarea>
        <label>抽出方法
          <select id="io-mode">
            <option value="auto">自動判定（おすすめ）</option>
            <option value="bracket">括弧で囲まれた部分</option>
            <option value="delim">区切り文字</option>
            <option value="regex">正規表現（上級）</option>
          </select>
        </label>
        <div id="io-modeopt">${modeOptions()}</div>
        <p class="muted small">${MODE_HELP[io.mode]}</p>
        <button id="io-parse" class="btn primary block">解析する</button>
      ` : `
        <input id="io-file" type="file" accept=".xlsx,.xls,.xlsm,.csv,.txt,.tsv">
        ${io.sheets && io.sheets.length > 1 ? `<label>シート<select id="io-sheet">${io.sheets.map((s) => `<option ${s === io.sheet ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>` : ''}
        <p class="muted small">Excel (.xlsx/.xls) と CSV（UTF-8 / Shift_JIS）に対応。</p>
      `}
      ${io.lastImport ? `<div class="after-imp">✅ ${io.lastImport.n}件を取り込みました（${esc(io.lastImport.id)}）
        <div class="row wrap"><button class="btn sm primary" data-imp-grid>この${io.lastImport.n}件を表で一括編集</button><button class="btn sm" data-imp-list>一覧で見る</button></div></div>` : ''}
      <div id="io-map"></div>
      <div id="io-plan"></div>
    </div>

    <div class="card" id="ex-box"></div>
`;

  const sel = $('#io-mode');
  if (sel) sel.value = io.mode;
  root.querySelector('#io-src').addEventListener('click', (e) => {
    const b = e.target.closest('[data-src]');
    if (b) { io.src = b.dataset.src; io.table = null; renderIO(); }
  });
  $('#io-text')?.addEventListener('input', (e) => { io.text = e.target.value; });
  sel?.addEventListener('change', (e) => { io.mode = e.target.value; renderIO(); });
  $('#io-modeopt')?.addEventListener('input', (e) => { if (e.target.dataset.k) io[e.target.dataset.k] = e.target.value; });
  $('#io-modeopt')?.addEventListener('change', (e) => { if (e.target.dataset.k) io[e.target.dataset.k] = e.target.value; });
  $('#io-parse')?.addEventListener('click', parseText);
  root.querySelector('[data-imp-grid]')?.addEventListener('click', () => openImportBatch(io.lastImport.id, true));
  root.querySelector('[data-imp-list]')?.addEventListener('click', () => openImportBatch(io.lastImport.id, false));
  $('#io-file')?.addEventListener('change', (e) => readFile(e.target.files[0]));
  $('#io-sheet')?.addEventListener('change', (e) => { io.sheet = e.target.value; loadSheet(); });

  $('#rp-group').value = io.reportGroup || S.cfg.reportGroup || 'together';
  const upd = () => {
    io.reportDate = $('#rp-date').value || S.today;
    io.reportWorker = $('#rp-worker').value;
    io.reportGroup = $('#rp-group').value;
    io.reportNames = $('#rp-names').value.trim();
    io.reportShip = $('#rp-ship').checked;
    $('#rp-names-l').classList.toggle('hidden', io.reportGroup !== 'together');
    $('#rp-text').value = reportText();
    const pk = doneOn(S.units, io.reportDate).filter((u) => !io.reportWorker || u.worker === io.reportWorker).length;
    $('#rp-count').textContent = `梱包実績 ${pk}台 ／ 発送 ${shippedOn(S.units, io.reportDate).length}台`;
  };
  ['rp-date', 'rp-worker', 'rp-group', 'rp-ship'].forEach((id) => $('#' + id).addEventListener('change', upd));
  $('#rp-names').addEventListener('input', upd);
  upd();
  renderMatch();
  $('#rp-copy').onclick = () => copyText($('#rp-text').value);
  $('#rp-share').onclick = () => shareText($('#rp-text').value, `キッティング実績 ${io.reportDate}`);
  $('#rp-dl').onclick = () => download(`実績_${io.reportDate}${io.reportWorker ? '_' + io.reportWorker : ''}.txt`, $('#rp-text').value, 'text/plain');
  renderExport();
  if (io.table) { renderMapping(); renderPlan(); }
}
function reportText() {
  const io = S.io;
  const t = formatReport(S.units, io.reportDate, S.cfg, { worker: io.reportWorker, group: io.reportGroup, names: io.reportNames || undefined, ship: io.reportShip });
  return t || '（この日の梱包済み・発送の実績はありません）';
}

function modeOptions() {
  const io = S.io;
  if (io.mode === 'bracket') return `<div class="row"><label class="grow">開き<input data-k="open" value="${esc(io.open)}"></label><label class="grow">閉じ<input data-k="close" value="${esc(io.close)}"></label></div>`;
  if (io.mode === 'delim') return `<label>区切り文字<select data-k="delim">${[['tab', 'タブ（Excelコピペ）'], ['comma', 'カンマ'], ['space', '空白']].map(([v, l]) => `<option value="${v}" ${io.delim === v ? 'selected' : ''}>${l}</option>`).join('')}${!['tab', 'comma', 'space'].includes(io.delim) ? `<option selected>${esc(io.delim)}</option>` : ''}</select></label>
    <label>その他の区切り文字（入力すると優先）<input data-k="delim" value="${['tab', 'comma', 'space'].includes(io.delim) ? '' : esc(io.delim)}" placeholder="例: / や |"></label>`;
  if (io.mode === 'regex') return `<label>正規表現<input data-k="pattern" value="${esc(io.pattern)}" placeholder="(?<pc>\\d{3}).*?(?<yrl>\\d{2}-\\d{7})" autocapitalize="off" spellcheck="false"></label>`;
  return '';
}

function setTable(headers, rows, presetMapping) {
  const io = S.io;
  io.headerRow = !presetMapping && looksLikeHeader(rows[0]);
  io.setStatus = '';
  io.rawHeaders = headers;
  io.rawRows = rows;
  applyHeaderRow();
  io.mapping = presetMapping && Object.values(presetMapping).some((v) => v >= 0)
    ? { pc: -1, yrl: -1, slip: -1, worker: -1, status: -1, ...presetMapping }
    : guessMapping(io.table.headers, io.table.rows, allWorkers(), S.cfg);
  const ctxCol = io.table.headers.length - 1;
  if (io.mapping.worker < 0 && io.table.headers[ctxCol] === '見出し作業者' && io.table.rows.some((r) => r[ctxCol])) io.mapping.worker = ctxCol;
  if (io.mapping.status >= 0) io.setStatus = 'col';
  renderMapping();
  renderPlan();
}
function applyHeaderRow() {
  const io = S.io;
  if (io.headerRow && io.rawRows.length) io.table = { headers: io.rawRows[0].map((h, i) => String(h || `列${i + 1}`)), rows: io.rawRows.slice(1) };
  else io.table = { headers: io.rawHeaders, rows: io.rawRows };
}

function parseText() {
  const io = S.io;
  io.text = $('#io-text').value;
  if (!io.text.trim()) return toast('文字列を貼り付けてください', 'warn');
  try {
    const t = textToTable(io.text, io.mode, { open: io.open, close: io.close, delim: io.delim, pattern: io.pattern, pcMin: S.cfg.pcMin, pcMax: S.cfg.pcMax }, allWorkers());
    if (!t.rows.length) { toast('抽出できる行がありませんでした。抽出方法を変えてみてください', 'warn'); io.table = null; $('#io-map').innerHTML = ''; $('#io-plan').innerHTML = ''; return; }
    setTable(t.headers, t.rows, t.mapping);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('shift_jis').decode(buf); }
}
async function readFile(file) {
  if (!file) return;
  const io = S.io;
  const buf = await file.arrayBuffer();
  try {
    if (/\.(csv|txt|tsv)$/i.test(file.name)) {
      const text = decodeText(buf);
      const delim = /\.tsv$/i.test(file.name) || (text.split('\t').length > text.split(',').length) ? '\t' : ',';
      const rows = parseCSV(text, delim);
      io.sheets = null;
      const w = Math.max(...rows.map((r) => r.length));
      setTable(Array.from({ length: w }, (_, i) => `列${i + 1}`), rows);
    } else {
      const XLSX = await loadXLSX();
      io.wb = XLSX.read(buf, { type: 'array', cellDates: true });
      io.sheets = io.wb.SheetNames;
      io.sheet = io.sheets[0];
      if (io.sheets.length > 1) renderIO();
      loadSheet();
    }
  } catch (e) {
    toast('読み込み失敗: ' + e.message, 'err');
  }
}
function loadSheet() {
  const io = S.io;
  const ws = io.wb.Sheets[io.sheet];
  // 表示文字(raw:false)だと12桁の伝票番号が「3.91214E+11」になるため、値で読んで文字にする
  const cellText = (c) => {
    if (c instanceof Date) return dateKey(c.getTime());
    if (typeof c === 'number') return Number.isInteger(c) ? String(c) : String(+c.toFixed(6));
    return String(c ?? '').trim();
  };
  const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })
    .map((r) => r.map(cellText))
    .filter((r) => r.some((c) => c));
  const w = Math.max(0, ...rows.map((r) => r.length));
  rows.forEach((r) => { while (r.length < w) r.push(''); });
  setTable(Array.from({ length: w }, (_, i) => `${colName(i)}列`), rows);
}
const colName = (i) => (i >= 26 ? colName(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));

function parseCSV(text, d) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(cell.trim()); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some((x) => x)) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some((x) => x)) rows.push(row);
  return rows;
}

function renderMapping() {
  const io = S.io;
  const { headers, rows } = io.table;
  const sample = (i) => rows.find((r) => String(r[i] ?? '').trim())?.[i] ?? '';
  const opts = (k) => `<option value="-1">—使わない—</option>` + headers.map((h, i) => `<option value="${i}" ${io.mapping[k] === i ? 'selected' : ''}>${esc(h)}：${esc(String(sample(i)).slice(0, 18))}</option>`).join('');
  $('#io-map').innerHTML = `
    <h3 class="sub">列の対応（${rows.length}行を検出）</h3>
    ${io.rawRows !== undefined && io.src === 'file' || io.mode === 'delim' ? `<label class="check-l"><input type="checkbox" id="io-hdr" ${io.headerRow ? 'checked' : ''}> 1行目は見出し</label>` : ''}
    <div class="map-grid">${FIELDS.map(([k, l]) => `<label>${l}<select data-map="${k}">${opts(k)}</select></label>`).join('')}</div>
    <details class="preview"><summary>抽出結果を表示（先頭20行）</summary>
      <div class="table-wrap"><table><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>
      ${rows.slice(0, 20).map((r) => `<tr>${headers.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</table></div>
    </details>
    <div class="map-grid">
      <label>既存データとの関係<select id="io-ow"><option value="0">空欄だけ埋める（安全）</option><option value="1" ${io.overwrite ? 'selected' : ''}>取り込む値で上書き</option></select></label>
      <label>ステータス<select id="io-st">
        <option value="">変更しない</option>
        ${io.mapping.status >= 0 ? `<option value="col" ${io.setStatus === 'col' ? 'selected' : ''}>ステータス列の値を使う</option>` : ''}
        ${STATUSES.map((s) => `<option value="${s.key}" ${io.setStatus === s.key ? 'selected' : ''}>すべて「${s.label}」にする</option>`).join('')}
      </select></label>
      <label>梱包日（梱包済み/発送済みにする場合）<input type="date" id="io-date" value="${io.date}"></label>
    </div>`;
  $('#io-map').onchange = (e) => {
    const t = e.target;
    if (t.dataset.map) io.mapping[t.dataset.map] = Number(t.value);
    if (t.id === 'io-ow') io.overwrite = t.value === '1';
    if (t.id === 'io-st') io.setStatus = t.value;
    if (t.id === 'io-date') io.date = t.value || S.today;
    if (t.id === 'io-hdr') {
      io.headerRow = t.checked;
      applyHeaderRow();
      io.mapping = guessMapping(io.table.headers, io.table.rows, allWorkers(), S.cfg);
      renderMapping();
    }
    renderPlan();
  };
}

const ACTION_LABEL = { new: '新規', update: '更新', partial: '一部更新', same: '変更なし', conflict: '不一致', error: 'エラー', dup: '重複' };
function computePlan() {
  const io = S.io;
  const recs = rowsToRecords(io.table.rows, io.mapping);
  return planImport(recs, S.units, S.cfg, { overwrite: io.overwrite, setStatus: io.setStatus || null, date: io.date || S.today });
}
function renderPlan() {
  const io = S.io;
  if (!io.table || !$('#io-plan')) return;
  if (io.mapping.pc < 0) { $('#io-plan').innerHTML = '<p class="error">PC番号の列を選んでください</p>'; return; }
  const plan = computePlan();
  const c = {};
  for (const p of plan) c[p.action] = (c[p.action] || 0) + 1;
  const applicable = (c.new || 0) + (c.update || 0) + (c.partial || 0);
  const warnN = plan.filter((p) => p.warnings.length || p.conflicts?.length).length;
  const rows = plan.filter((p) => p.action !== 'same').slice(0, 300).map((p) => {
    const ch = Object.entries(p.changes).filter(([k]) => ['yrl', 'slip', 'worker', 'status'].includes(k))
      .map(([k, v]) => (k === 'status' ? STATUS_LABEL[v] : v)).join(' / ');
    const notes = [...p.warnings, ...(p.conflicts || [])].map((w) => `<div class="w">⚠ ${esc(w)}</div>`).join('');
    return `<tr class="a-${p.action}"><td>${esc(p.pc ?? '?')}</td><td>${ACTION_LABEL[p.action]}</td><td>${esc(ch)}${notes}</td></tr>`;
  }).join('');
  $('#io-plan').innerHTML = `
    <h3 class="sub">取り込みプレビュー</h3>
    <div class="chips static">${Object.entries(c).map(([k, v]) => `<span class="chip a-${k}">${ACTION_LABEL[k]} <b>${v}</b></span>`).join('')}${warnN ? `<span class="chip warn">要確認 <b>${warnN}</b></span>` : ''}</div>
    ${rows ? `<div class="table-wrap"><table class="plan"><tr><th>PC</th><th>処理</th><th>内容</th></tr>${rows}</table></div>` : '<p class="muted">変更はありません</p>'}
    <button id="io-apply" class="btn primary block" ${applicable ? '' : 'disabled'}>${applicable}件を取り込む</button>`;
  $('#io-apply').onclick = () => {
    const now = Date.now();
    const p2 = computePlan();
    const importId = `${dateKey(now).slice(5).replace('-', '/')} ${fmtTime(now)} ${S.me}`;
    const ups = buildImportUpdates(p2, now, S.me, importId);
    const n = Object.keys(ups).length;
    if (!n) return;
    if (!confirm(`${n}件を取り込みます。よろしいですか？`)) return;
    S.store.setUnits(ups);
    S.store.addLog(S.today, logEntries([{ msg: `${n}件を取り込み（${importId}）` }]));
    toast(`${n}件を取り込みました`);
    io.table = null;
    io.text = '';
    io.lastImport = { id: importId, n };
    renderIO();
  };
}

// ---- 書き出し ----
const BOM = String.fromCharCode(0xfeff);
const exportOpts = () => ({ ...DEFAULT_EXPORT, ...(S.cfg.exportOpts || {}) });
let exSaveTimer;
function saveExportOpts(o) {
  S.cfg.exportOpts = o;
  clearTimeout(exSaveTimer);
  exSaveTimer = setTimeout(() => S.store.setConfig({ exportOpts: o }), 500);
}
const EX_PRESETS = {
  all: { label: '全件（未完了含む）', p: () => ({ statuses: DEFAULT_EXPORT.statuses, worker: 'all', dateFrom: '', dateTo: '', slip: 'all' }) },
  todo: { label: '未完了のみ', p: () => ({ statuses: ['todo', 'wip', 'hold'], worker: 'all', dateFrom: '', dateTo: '', slip: 'all' }) },
  today: { label: '本日の実績', p: () => ({ statuses: ['packed', 'shipped'], worker: 'all', dateFrom: S.today, dateTo: S.today, slip: 'all' }) },
  unshipped: { label: '未発送（梱包済み）', p: () => ({ statuses: ['packed'], worker: 'all', dateFrom: '', dateTo: '', slip: 'all' }) },
};
const opt = (v, l, cur) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`;

function renderExport() {
  const box = $('#ex-box');
  if (!box) return;
  const o = exportOpts();
  const n = filterForExport(S.units, o).length;
  const cols = exportColumns(o);
  const opened = box.querySelector('details')?.open ?? false;
  box.innerHTML = `
    <div class="card-h"><h2>書き出し（Excel / CSV）</h2></div>
    <div class="chips static">${Object.entries(EX_PRESETS).map(([k, v]) => `<button class="chip" data-preset="${k}">${v.label}</button>`).join('')}</div>
    <p class="ex-sum">対象 <b>${n}</b>件 / 全${Object.keys(S.units).length}件　列 ${cols.length}個</p>
    <details ${opened ? 'open' : ''}><summary>出力設定</summary>
      <div class="lbl">ステータス（未完了も選べます）</div>
      <div class="checks">${STATUSES.map((st) => `<label class="ck"><input type="checkbox" data-st="${st.key}" ${o.statuses.includes(st.key) ? 'checked' : ''}>${st.label}</label>`).join('')}</div>
      <div class="map-grid">
        <label>作業者<select data-o="worker">${opt('all', '全員', o.worker)}${opt('none', '未割当のみ', o.worker)}${allWorkers().map((w) => opt(w, w, o.worker)).join('')}</select></label>
        <label>伝票番号<select data-o="slip">${opt('all', 'すべて', o.slip)}${opt('has', 'ありのみ', o.slip)}${opt('none', 'なしのみ', o.slip)}</select></label>
        <label>梱包日（から）<input type="date" data-o="dateFrom" value="${esc(o.dateFrom)}"></label>
        <label>梱包日（まで）<input type="date" data-o="dateTo" value="${esc(o.dateTo)}"></label>
      </div>
      <p class="muted small">梱包日の範囲は梱包済み・発送済みのPCにだけ適用されます（未完了のPCはステータスの指定どおり出力）。</p>
      <div class="lbl">出力する列</div>
      <div class="checks">${EXPORT_COLUMNS.map((c) => `<label class="ck"><input type="checkbox" data-col="${c.key}" ${o.columns.includes(c.key) ? 'checked' : ''}>${c.label}</label>`).join('')}</div>
      <div class="map-grid">
        <label>並び順<select data-o="sort">${opt('pc', 'PC番号順', o.sort)}${opt('worker', '作業者→PC番号', o.sort)}${opt('status', 'ステータス→PC番号', o.sort)}${opt('packedDate', '梱包日→PC番号', o.sort)}</select></label>
        <label>Excelのシート分け<select data-o="split">${opt('none', '1シートにまとめる', o.split)}${opt('status', 'ステータスごと', o.split)}${opt('worker', '作業者ごと', o.split)}</select></label>
      </div>
      <label class="check-l"><input type="checkbox" data-o="summary" ${o.summary ? 'checked' : ''}> Excelに「日別実績」シートを付ける</label>
      <button class="link" data-reset>設定を初期値に戻す</button>
    </details>
    <div class="row wrap">
      <button class="btn primary" id="ex-xlsx" ${n ? '' : 'disabled'}>Excel (.xlsx)</button>
      <button class="btn" id="ex-csv" ${n ? '' : 'disabled'}>CSV</button>
    </div>
    <p class="muted small">出力設定はチームで共有されます。CSVはExcelで文字化けしないBOM付きUTF-8です。</p>`;
  box.onchange = (e) => {
    const t = e.target;
    const cur = exportOpts();
    if (t.dataset.st) cur.statuses = STATUSES.map((x) => x.key).filter((k) => (k === t.dataset.st ? t.checked : cur.statuses.includes(k)));
    else if (t.dataset.col) cur.columns = EXPORT_COLUMNS.map((c) => c.key).filter((k) => (k === t.dataset.col ? t.checked : cur.columns.includes(k)));
    else if (t.dataset.o === 'summary') cur.summary = t.checked;
    else if (t.dataset.o) cur[t.dataset.o] = t.value;
    else return;
    if (!cur.columns.length) { toast('列を1つ以上選んでください', 'warn'); renderExport(); return; }
    saveExportOpts(cur);
    renderExport();
  };
  box.onclick = (e) => {
    const pr = e.target.closest('[data-preset]');
    if (pr) {
      const ps = EX_PRESETS[pr.dataset.preset];
      saveExportOpts({ ...exportOpts(), ...ps.p() });
      renderExport();
      toast(`「${ps.label}」に設定しました`);
    }
    if (e.target.closest('[data-reset]')) { saveExportOpts({ ...DEFAULT_EXPORT }); renderExport(); }
  };
  $('#ex-csv').onclick = () => {
    const o2 = exportOpts();
    download(`kitting_${stamp()}.csv`, BOM + toCSV(exportTable(filterForExport(S.units, o2), o2)), 'text/csv');
  };
  $('#ex-xlsx').onclick = exportXLSX;
}

async function exportXLSX() {
  try {
    const XLSX = await loadXLSX();
    const o = exportOpts();
    const list = filterForExport(S.units, o);
    const widths = exportColumns(o).map((c) => ({ wch: c.w }));
    const wb = XLSX.utils.book_new();
    for (const g of splitForExport(list, o.split)) {
      const ws = XLSX.utils.aoa_to_sheet(exportTable(g.list, o));
      ws['!cols'] = widths;
      ws['!autofilter'] = { ref: ws['!ref'] };
      XLSX.utils.book_append_sheet(wb, ws, g.name);
    }
    if (o.summary) {
      const days = await S.store.listDays();
      const sum = dailySummary(S.units, days);
      const workers = allWorkers();
      const ws2 = XLSX.utils.aoa_to_sheet([
        ['日付', '目標', '繰越', '合計目標', '完了(梱包済み)', '差', ...workers],
        ...sum.map((d) => [d.date, d.target, d.carry, d.goal, d.done, d.done - d.goal, ...workers.map((w) => d.byWorker[w] || 0)]),
      ]);
      XLSX.utils.book_append_sheet(wb, ws2, '日別実績');
    }
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    download(`kitting_${stamp()}.xlsx`, new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ================= 進捗 =================
async function loadHistory() {
  $('#tab-history').innerHTML = '<div class="card"><p class="muted">読み込み中…</p></div>';
  try {
    S.history = await S.store.listDays();
  } catch (e) {
    S.history = {};
    toast('履歴の取得に失敗: ' + e.message, 'err');
  }
  renderHistory();
}
const mdw = (d, h) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}(${weekdayLabel(d, h)})`;
const signed = (n) => (n > 0 ? `+${n}` : String(n));

function renderHistory() {
  if (!S.history) return;
  const plan = S.cfg.plan || [];
  const ps = planSummary(S.units, plan, S.today, S.cfg.projectTotal);
  const days = { ...S.history };
  if (S.day) days[S.today] = S.day;
  const pct = ps.total ? Math.min(100, (ps.done / ps.total) * 100) : 0;
  const planPct = ps.total ? Math.min(100, (ps.cumTargetToday / ps.total) * 100) : 0;
  const lag = ps.prevCumActual - ps.prevCumTarget; // 前日終了時点の計画比
  const diffCls = lag >= 0 ? 'ahead' : 'behind';
  const todayRow = ps.rows.find((r) => r.isToday);
  const late = ps.planEnd && ps.forecastEnd && ps.forecastEnd > ps.planEnd;

  const rowsHtml = ps.rows.map((r) => {
    const dc = r.diff == null ? '' : r.diff >= 0 ? 'ahead' : 'behind';
    return `<tr class="${r.isToday ? 'today' : ''} ${r.future ? 'future' : ''}" data-day="${r.date}">
      <td class="d">${mdw(r.date, r.holiday)}${r.isToday ? '<span class="today-tag">本日</span>' : ''}</td>
      <td>${r.target ?? '—'}</td>
      <td><b>${r.actual ?? ''}</b></td>
      <td>${r.cumTarget ?? '—'}</td>
      <td><b>${r.cumActual ?? ''}</b></td>
      <td class="diff ${r.isToday && r.diff < 0 ? 'pending' : dc}">${r.diff == null ? '' : r.isToday && r.diff < 0 ? `あと${-r.diff}` : signed(r.diff)}</td>
    </tr>`;
  }).join('');

  $('#tab-history').innerHTML = `
    <div class="card">
      <div class="card-h"><h2>全体の進捗</h2><span><button class="link" id="h-plan">計画を編集</button><button class="link" id="h-reload">更新</button></span></div>
      <div class="hero">
        <div><b class="hero-n">${ps.done}</b><span class="hero-d"> / ${ps.total}台</span></div>
        ${plan.length ? `<span class="diff-chip ${diffCls}">前日まで ${signed(lag)}台</span>` : ''}
      </div>
      <div class="progress plan-bar" title="実績${Math.round(pct)}%">
        <i style="width:${pct}%"></i>
        ${plan.length ? `<em style="left:${planPct}%" title="本日までの目標累計 ${ps.cumTargetToday}"></em>` : ''}
        <span>${Math.round(pct)}%</span>
      </div>
      <dl class="kv">
        <dt>残り</dt><dd><b>${ps.remaining}</b>台</dd>
        ${plan.length ? `${ps.todayPlan ? `<dt>本日</dt><dd><b>${todayRow?.actual ?? 0}</b> / ${ps.todayPlan.t}台${lag < 0 ? `<small class="muted">（＋遅れ${-lag}）</small>` : ''}</dd>` : ''}
        <dt>本日終了時の目標累計</dt><dd>${ps.cumTargetToday}台（あと${Math.max(0, ps.cumTargetToday - ps.done)}）</dd>
        <dt>計画の完了日</dt><dd>${ps.planEnd ? mdw(ps.planEnd) : '—'}</dd>` : ''}
        <dt>今のペースだと</dt><dd>${ps.forecastEnd ? `<b class="${late ? 'behind' : 'ahead'}">${mdw(ps.forecastEnd)}</b> 完了見込み` : '—'}<br><small class="muted">直近の平均 ${ps.avg.toFixed(1)}台/日</small></dd>
      </dl>
      ${!plan.length ? `<p class="muted small">「計画を編集」で日別の目標（当日目標・目標累計）を入れると、計画との差がわかります。</p>` : ''}
    </div>

    ${ps.rows.length ? `<div class="card">
      <div class="card-h"><h2>累計の推移</h2></div>
      <div id="burn" class="burn"></div>
    </div>` : ''}

    <div class="card">
      <div class="card-h"><h2>日別</h2><span class="muted small">行をタップで詳細</span></div>
      ${ps.rows.length ? `<div class="table-wrap prog-wrap"><table class="prog">
        <thead><tr><th>日付</th><th>当日<br>目標</th><th>実績</th><th>目標<br>累計</th><th>実績<br>累計</th><th>差</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>` : '<p class="muted">まだ計画も実績もありません</p>'}
    </div>`;

  $('#h-reload').onclick = loadHistory;
  $('#h-plan').onclick = openPlanEditor;
  $('#tab-history').querySelector('tbody')?.addEventListener('click', (e) => {
    const tr = e.target.closest('[data-day]');
    if (tr) openDaySheet(tr.dataset.day, days);
  });
  if (ps.rows.length) drawBurn($('#burn'), ps);
}

// 累計の計画（破線）と実績（実線）。軸は1本
function drawBurn(box, ps) {
  const rows = ps.rows;
  const W = 340, H = 190, L = 34, R = 44, T = 10, B = 24;
  const n = rows.length;
  const maxY = Math.max(ps.total, ...rows.map((r) => Math.max(r.cumTarget || 0, r.cumActual || 0)), 1);
  const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = (v) => T + (H - T - B) * (1 - v / maxY);
  const step = maxY > 400 ? 100 : maxY > 200 ? 50 : maxY > 80 ? 20 : 10;
  const ticks = [];
  for (let v = 0; v <= maxY; v += step) ticks.push(v);
  const pts = (key) => rows.map((r, i) => (r[key] == null ? null : [x(i), y(r[key])])).filter(Boolean);
  const path = (p) => p.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join('');
  const planP = pts('cumTarget');
  const actP = pts('cumActual');
  const ti = rows.findIndex((r) => r.isToday);
  const labelEvery = Math.ceil(n / 6);
  const lastA = actP.at(-1);
  const lastP = planP.at(-1);
  box.innerHTML = `
    <div class="legend"><span><i class="lg-act"></i>実績累計</span><span><i class="lg-plan"></i>目標累計</span></div>
    <div class="burn-in">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="累計の推移グラフ">
      ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${v}</text>`).join('')}
      ${ps.total ? `<line class="goal" x1="${L}" x2="${W - R}" y1="${y(ps.total)}" y2="${y(ps.total)}"/>` : ''}
      ${rows.map((r, i) => (i % labelEvery === 0 || i === n - 1 ? `<text class="ax" x="${x(i)}" y="${H - 6}" text-anchor="middle">${Number(r.date.slice(5, 7))}/${Number(r.date.slice(8))}</text>` : '')).join('')}
      ${ti >= 0 ? `<line class="today" x1="${x(ti)}" x2="${x(ti)}" y1="${T}" y2="${H - B}"/>` : ''}
      ${planP.length ? `<path class="plan" d="${path(planP)}"/>` : ''}
      ${actP.length ? `<path class="act" d="${path(actP)}"/>` : ''}
      ${lastA ? `<circle class="act-pt" cx="${lastA[0]}" cy="${lastA[1]}" r="4"/><text class="lbl" x="${lastA[0] + 6}" y="${lastA[1] + 4}">${rows.filter((r) => r.cumActual != null).at(-1).cumActual}</text>` : ''}
      ${lastP ? `<text class="lbl muted" x="${Math.min(lastP[0] + 6, W - R + 6)}" y="${lastP[1] + 4}">${rows.filter((r) => r.cumTarget != null).at(-1).cumTarget}</text>` : ''}
      <line class="hair hidden" y1="${T}" y2="${H - B}"/>
      <rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>
    </svg>
    <div class="tip hidden"></div>
    </div>`;
  const svg = box.querySelector('svg');
  const hair = box.querySelector('.hair');
  const tip = box.querySelector('.tip');
  const show = (ev) => {
    const r0 = svg.getBoundingClientRect();
    const px = ((ev.clientX - r0.left) / r0.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1))));
    const r = rows[i];
    hair.setAttribute('x1', x(i));
    hair.setAttribute('x2', x(i));
    hair.classList.remove('hidden');
    tip.innerHTML = `<b>${mdw(r.date, r.holiday)}</b><br>目標累計 ${r.cumTarget ?? '—'}<br>実績累計 ${r.cumActual ?? '—'}${r.diff != null ? `<br>差 <b class="${r.diff >= 0 ? 'ahead' : 'behind'}">${signed(r.diff)}</b>` : ''}`;
    tip.classList.remove('hidden');
    const left = (x(i) / W) * r0.width;
    tip.style.left = `${Math.min(Math.max(left - 60, 0), r0.width - 124)}px`;
  };
  const hide = () => { hair.classList.add('hidden'); tip.classList.add('hidden'); };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', hide);
}

function openDaySheet(date, days) {
  const list = doneOn(S.units, date);
  const byW = {};
  for (const u of list) byW[u.worker || '未設定'] = (byW[u.worker || '未設定'] || 0) + 1;
  const p = (S.cfg.plan || []).find((r) => r.d === date);
  openSheet(`
    <h3>${mdw(date, p?.h)} ${date === S.today ? '（本日）' : ''}</h3>
    <dl class="kv">
      <dt>当日目標（計画）</dt><dd>${p ? p.t : '—'}</dd>
      <dt>実績（梱包済み）</dt><dd><b>${list.length}</b>台</dd>
    </dl>
    <div class="muted small" style="margin:8px 0">${Object.entries(byW).map(([w, c]) => `${esc(w)} ${c}台`).join('　') || '実績なし'}</div>
    <div class="row wrap">
      ${list.length ? '<button class="btn" data-a="report">報告文</button><button class="btn" data-a="grid">実績を編集</button>' : ''}
      <button class="btn" data-a="target">この日の目標・繰越</button>
    </div>
    <div class="sheet-actions"><button class="btn" data-close>閉じる</button></div>`, (sh) => {
    sh.querySelector('[data-close]').onclick = closeSheet;
    sh.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'grid') { closeSheet(); showListWith({ pdate: date }); openGrid(filteredUnits().list); }
      if (a === 'target') openTargetEditor(date, date === S.today ? S.day || {} : days[date] || {});
      if (a === 'report') {
        const text = formatReport(S.units, date, S.cfg);
        openSheet(`<h3>${esc(date)} の報告文</h3><textarea rows="14" readonly>${esc(text)}</textarea>
          <div class="sheet-actions"><button class="btn" data-close>閉じる</button><button class="btn" id="hs-share">共有</button><button class="btn primary" id="hs-copy">コピー</button></div>`, (s2) => {
          s2.querySelector('[data-close]').onclick = closeSheet;
          $('#hs-copy').onclick = () => copyText(text);
          $('#hs-share').onclick = () => shareText(text, `キッティング実績 ${date}`);
        });
      }
    });
  });
}

function openPlanEditor() {
  let rows = normalizePlan(S.cfg.plan || []);
  const renderRows = () => rows.map((r, i) => `<tr data-i="${i}">
      <td><input type="date" data-k="d" value="${r.d}"></td>
      <td><input type="number" inputmode="numeric" data-k="t" value="${r.t}"></td>
      <td><input type="number" inputmode="numeric" data-k="c" value="${r.c ?? ''}" placeholder="${r.cum}"></td>
      <td><label class="ck"><input type="checkbox" data-k="h" ${r.h ? 'checked' : ''}>祝</label></td>
      <td><button class="btn sm" data-del>✕</button></td></tr>`).join('');
  openSheet(`
    <h3>計画（日別の目標）</h3>
    <label>総台数<input id="pl-total" type="number" inputmode="numeric" value="${S.cfg.projectTotal || ''}" placeholder="${rows.at(-1)?.cum || Object.keys(S.units).length}"></label>
    <details ${rows.length ? '' : 'open'}><summary>表を貼り付けて読み込む</summary>
      <textarea id="pl-text" rows="6" placeholder="10/7(水) 35 120&#10;10/8(木) 55 175&#10;10/12(祝) 33 329&#10;…（日付 当日目標 目標累計）"></textarea>
      <button class="btn sm" id="pl-parse">読み込む（今の計画を置き換え）</button>
    </details>
    <p class="muted small">目標累計を空欄にすると、前の日の累計＋当日目標で自動計算します。</p>
    <div class="table-wrap"><table class="plan-edit"><thead><tr><th>日付</th><th>当日目標</th><th>目標累計</th><th></th><th></th></tr></thead><tbody id="pl-rows">${renderRows()}</tbody></table></div>
    <div class="row wrap"><button class="btn sm" id="pl-add">＋ 1日追加</button><button class="btn sm" id="pl-recalc">累計を目標から再計算</button></div>
    <div class="sheet-actions"><button class="btn danger" id="pl-clear">計画を削除</button><button class="btn" data-close>キャンセル</button><button class="btn primary" id="pl-save">保存</button></div>`, (sh) => {
    const body = $('#pl-rows');
    const read = () => {
      rows = [...body.querySelectorAll('tr')].map((tr) => {
        const g = (k) => tr.querySelector(`[data-k=${k}]`);
        const c = g('c').value.trim();
        return { d: g('d').value, t: Number(g('t').value) || 0, ...(c !== '' ? { c: Number(c) } : {}), ...(g('h').checked ? { h: true } : {}) };
      }).filter((r) => r.d);
    };
    const redraw = () => { rows = normalizePlan(rows); body.innerHTML = renderRows(); };
    body.addEventListener('click', (e) => { if (e.target.matches('[data-del]')) { read(); rows.splice(Number(e.target.closest('tr').dataset.i), 1); redraw(); } });
    body.addEventListener('change', () => { read(); redraw(); });
    $('#pl-parse').onclick = () => {
      const p = parsePlanText($('#pl-text').value, S.today);
      if (!p.length) return toast('日付と数字の行が見つかりませんでした', 'warn');
      rows = p;
      redraw();
      if (!$('#pl-total').value && p.at(-1)?.cum) $('#pl-total').value = p.at(-1).cum;
      toast(`${p.length}日分を読み込みました（保存で確定）`);
    };
    $('#pl-add').onclick = () => {
      read();
      const last = rows.at(-1)?.d || S.today;
      rows.push({ d: dateKey(dayBase(last) + 86400000 + 3600000), t: Number(S.cfg.defaultTarget) || 0 });
      redraw();
    };
    $('#pl-recalc').onclick = () => { read(); rows = rows.map(({ c, ...r }) => r); redraw(); };
    $('#pl-clear').onclick = () => { if (confirm('計画をすべて削除しますか？')) { rows = []; redraw(); } };
    sh.querySelector('[data-close]').onclick = closeSheet;
    $('#pl-save').onclick = () => {
      read();
      const plan = normalizePlan(rows).map(({ cum, ...r }) => r);
      const total = Number($('#pl-total').value) || 0;
      S.store.setConfig({ plan, projectTotal: total });
      S.cfg.plan = plan;
      // 本日の目標・繰越にも反映
      const tp = plan.find((r) => r.d === S.today);
      if (tp) S.store.setDay(S.today, { target: tp.t, carry: planCarry(S.units, plan, S.today), carryFrom: 'plan' });
      closeSheet();
      toast('計画を保存しました');
      renderHistory();
    };
  });
}

// ================= 設定 =================
const CFG_FIELDS = [
  ['defaultTarget', '1日の目標台数（初期値）', 'number'],
  ['standardMin', '標準作業時間（分/台・1人）', 'number'],
  ['minSamples', '実績ペースに切り替える完了台数', 'number'],
  ['workStart', '始業', 'time'],
  ['workEnd', '定時（終業）', 'time'],
  ['overtimeLimit', '残業の上限（これを超えると繰越見込み）', 'time'],
  ['breaks', '休憩（例: 10:00-10:10, 12:00-13:00）', 'text'],
  ['pcMin', 'PC番号の最小', 'number'],
  ['pcMax', 'PC番号の最大', 'number'],
  ['headerTpl', '報告：見出し {worker}=作業者名 {count}=台数', 'text'],
  ['lineTpl', '報告：1行の書式 {pc} {yrl} {slip}', 'text'],
  ['groupFooterTpl', '報告：見出しごとの合計 {count}（空欄で無し）', 'text'],
  ['footerTpl', '報告：梱包実績の総合計 {total}（空欄で無し）', 'text'],
  ['shipHeaderTpl', '報告：発送分の前置き', 'text'],
  ['shipFooterTpl', '報告：発送分の合計 {count}', 'text'],
  ['endTpl', '報告：最後の行（例：以上）', 'text'],
];
function renderSettings() {
  const c = S.cfg;
  $('#tab-settings').innerHTML = `
    <div class="card">
      <div class="card-h"><h2>メンバー</h2></div>
      <ul class="members">${c.members.map((m, i) => `<li><span>${esc(m)}${m === S.me ? ' <small class="pill">自分</small>' : ''}</span>
        <span><button class="btn sm" data-up="${i}" ${i ? '' : 'disabled'}>↑</button><button class="btn sm danger" data-rm="${i}">削除</button></span></li>`).join('')}</ul>
      <div class="row"><input id="s-new" placeholder="名前を追加"><button id="s-add" class="btn">追加</button></div>
    </div>
    <div class="card">
      <div class="card-h"><h2>計算・表示の設定</h2></div>
      <form id="s-form">
        ${CFG_FIELDS.map(([k, l, t]) => `<label>${l}<input name="${k}" type="${t}" value="${esc(c[k])}" ${t === 'number' ? 'inputmode="numeric" min="0"' : ''}></label>`).join('')}
        <button class="btn primary block">保存</button>
      </form>
    </div>
    <div class="card">
      <div class="card-h"><h2>この端末</h2></div>
      <p>ログイン中：<b>${esc(S.me)}</b>　${isDemo ? '<span class="pill">デモモード</span>' : ''}</p>
      <p class="muted small">バージョン ${APP_VERSION}</p>
      <div class="row wrap">
        <button class="btn" id="s-name">名前を変更</button>
        <button class="btn" id="s-logout">ログアウト</button>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h2>データの保護</h2></div>
      <p class="small">入力したデータはクラウド（Firebase）に保存されています。アプリを更新しても消えません。さらに、毎日自動でバックアップを取っています（${BACKUP_KEEP}日分）。</p>
      <div class="row wrap">
        <button class="btn" id="s-bk-list">バックアップから復元</button>
        <button class="btn" id="s-bk-now">今すぐバックアップ</button>
      </div>
      <div class="row wrap" style="margin-top:8px">
        <button class="btn" id="s-json">全データをファイルに保存</button>
        <label class="btn" style="margin:0">ファイルから復元<input type="file" id="s-json-in" accept=".json,application/json" hidden></label>
      </div>
      <p class="muted small">ファイル（.json）は、PC・実績・目標・設定のすべてを含みます。スマホやPCに保存しておくと、万一のときに戻せます。</p>
    </div>
    <div class="card danger-zone">
      <div class="card-h"><h2>危険な操作</h2></div>
      <button class="btn danger" id="s-wipe">全データを削除</button>
      <p class="muted small">案件終了時などに。削除の前に、全データのファイルが自動で保存されます。自動バックアップは削除されません。</p>
    </div>`;
  const root = $('#tab-settings');
  root.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => {
    const m = c.members[Number(b.dataset.rm)];
    if (!confirm(`${m} をメンバーから外しますか？（実績データは残ります）`)) return;
    S.store.setConfig({ members: c.members.filter((x) => x !== m) });
  }));
  root.querySelectorAll('[data-up]').forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.up);
    const arr = [...c.members];
    [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
    S.store.setConfig({ members: arr });
  }));
  $('#s-add').onclick = () => {
    const n = $('#s-new').value.trim();
    if (!n || c.members.includes(n)) return;
    S.store.setConfig({ members: [...c.members, n] });
  };
  $('#s-form').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const p = {};
    for (const [k, , t] of CFG_FIELDS) {
      const v = String(fd.get(k) ?? '').trim();
      p[k] = t === 'number' ? Math.max(0, Number(v) || 0) : v;
    }
    for (const k of ['workStart', 'workEnd', 'overtimeLimit']) if (hm(p[k]) == null) return toast(`時刻の形式が正しくありません（${k}）`, 'warn');
    if (!p.lineTpl) return toast('1行の書式は空にできません', 'warn');
    S.store.setConfig(p);
    toast('設定を保存しました');
  };
  $('#s-bk-list').onclick = openBackupList;
  $('#s-bk-now').onclick = async () => {
    try {
      await S.store.putMeta(bkId(S.today), await snapshotAll());
      toast('バックアップしました');
    } catch (e) { toast('バックアップに失敗: ' + e.message, 'err'); }
  };
  $('#s-json').onclick = () => saveJSONFile();
  $('#s-json-in').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      await restoreFrom(data, `ファイル ${f.name}`);
    } catch (err) { toast('ファイルを読めませんでした: ' + err.message, 'err'); }
    e.target.value = '';
  };
  $('#s-name').onclick = () => showLogin(2);
  $('#s-logout').onclick = () => {
    if (!confirm('ログアウトしますか？（再度パスコードが必要です）')) return;
    LS.set('kitte-team', null);
    LS.set('kitte-me', null);
    location.reload();
  };
  $('#s-wipe').onclick = async () => {
    if (prompt('全データ（PC・目標・稼働・履歴・設定）を削除します。実行するには「削除」と入力してください') !== '削除') return;
    await saveJSONFile('kitting_before_delete');
    await S.store.putMeta('backup-before-restore', await snapshotAll()).catch(() => {});
    await S.store.deleteAll();
    toast('削除しました');
    setTimeout(() => location.reload(), 800);
  };
}

// ================= バックアップ =================
const BACKUP_KEEP = 14; // 日数
const bkId = (date) => `backup-${date}`;
async function snapshotAll() {
  const days = await S.store.listDays().catch(() => ({}));
  return { app: 'kitte', ver: 1, at: Date.now(), by: S.me, units: S.units, days, config: S.cfg };
}
// 1日1回、その日最初に開いた端末がクラウドにバックアップを作る
let backupTried = false;
async function maybeBackup() {
  if (backupTried || !S.unitsLoaded || !S.cfgLoaded || !Object.keys(S.units).length) return;
  backupTried = true;
  try {
    if (await S.store.getMeta(bkId(S.today))) return;
    await S.store.putMeta(bkId(S.today), await snapshotAll());
    // 古いバックアップを削除
    for (let i = BACKUP_KEEP; i < BACKUP_KEEP + 7; i++) S.store.delMeta(bkId(dateKey(dayBase(S.today) - i * 86400000 + 3600000)));
  } catch (e) {
    console.warn('backup failed', e);
  }
}
function downloadJSON(data, name) {
  download(name, JSON.stringify(data), 'application/json');
}
async function saveJSONFile(prefix = 'kitting_backup') {
  downloadJSON(await snapshotAll(), `${prefix}_${stamp()}.json`);
}

async function restoreFrom(data, label) {
  if (!data?.units) return toast('バックアップの形式が正しくありません', 'err');
  const keepNew = true;
  const { ups, changed } = buildRestoreUpdates(data.units, S.units, { keepNew });
  const at = data.at ? `${dateKey(data.at)} ${fmtTime(data.at)}` : '';
  if (!changed && !data.days) return toast('現在の内容と同じです');
  if (!confirm(`${label}（${at}）の内容に戻します。\n・PC ${changed}台の内容を戻す（その後に追加したPCは残します）\n・日別の目標・稼働も戻します\n\n念のため、今の内容をファイルに保存してから実行します。よろしいですか？`)) return;
  await saveJSONFile('kitting_before_restore');
  await S.store.putMeta('backup-before-restore', await snapshotAll()).catch(() => {});
  if (changed) await S.store.setUnits(ups);
  for (const [d, v] of Object.entries(data.days || {})) await S.store.setDay(d, v);
  S.store.addLog(S.today, logEntries([{ msg: `${label}から復元（PC ${changed}台）` }]));
  toast('復元しました');
}

async function openBackupList() {
  openSheet('<h3>バックアップから復元</h3><p class="muted">読み込み中…</p>', () => {});
  const list = [];
  const ids = [...Array(BACKUP_KEEP).keys()].map((i) => bkId(dateKey(dayBase(S.today) - i * 86400000 + 3600000)));
  ids.push('backup-before-restore');
  for (const id of ids) {
    const d = await S.store.getMeta(id).catch(() => null);
    if (d) list.push([id, d]);
  }
  openSheet(`
    <h3>バックアップから復元</h3>
    <p class="muted small">毎日その日最初にアプリを開いたときに自動で保存されます（${BACKUP_KEEP}日分）。</p>
    ${list.length ? `<ul class="members">${list.map(([id, d], i) => `<li><span>${id === 'backup-before-restore' ? '復元する直前の状態' : esc(id.slice(7))}<br><small class="muted">${d.at ? `${dateKey(d.at)} ${fmtTime(d.at)}` : ''} ${esc(d.by || '')}・PC ${Object.keys(d.units || {}).length}台・完了 ${Object.values(d.units || {}).filter((u) => isDone(u.status)).length}台</small></span>
      <button class="btn sm" data-i="${i}">この状態に戻す</button></li>`).join('')}</ul>` : '<p class="muted">まだバックアップがありません</p>'}
    <div class="sheet-actions"><button class="btn" data-close>閉じる</button></div>`, (sh) => {
    sh.querySelector('[data-close]').onclick = closeSheet;
    sh.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const [id, d] = list[Number(b.dataset.i)];
      closeSheet();
      await restoreFrom(d, id === 'backup-before-restore' ? '復元前の状態' : `バックアップ ${id.slice(7)}`);
    });
  });
}

// ================= 定期処理 =================
setInterval(() => {
  const k = dateKey();
  if (S.store && k !== S.today) {
    S.today = k;
    S.io.reportDate = k;
    S.io.date = k;
    subscribeDay();
  }
  if (S.tab === 'home' && !$('#app').classList.contains('hidden') && !$('#tab-home').contains(document.activeElement)) renderHome();
}, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.tab === 'home') renderHome(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
}

start();
