import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG, textToTable, guessMapping, rowsToRecords, planImport, buildImportUpdates,
  formatReport, forecast, dayBase, addWorkMinutes, workMinutes, parseBreaks, parseStatus,
  statusSideEffects, carryFrom, toCSV, normNum, looksLikeHeader,
} from '../js/logic.js';

const MAIL = `
【山田】 3台
≪271≫　≪01-0973136≫　≪3912-1418-9100≫
≪272≫　≪01-0972982≫　≪3912-1418-9111≫
≪299≫　≪01-0972890≫　≪3912-1418-9376≫

【佐藤】
≪310≫　≪０１－０９７３３６３≫　≪3912-1418-9494≫
≪303≫　≪01-0972900≫　≪≫
合計 5台`;
const cfg = { ...DEFAULT_CONFIG, members: ['山田', '佐藤'] };

test('自動判定：メール形式から3項目と見出し作業者を抽出', () => {
  const t = textToTable(MAIL, 'auto', { pcMin: 160, pcMax: 660 }, cfg.members);
  assert.equal(t.rows.length, 5);
  assert.deepEqual(t.rows[0].slice(0, 3), ['271', '01-0973136', '3912-1418-9100']);
  assert.equal(t.rows[3][1], '01-0973363'); // 全角を正規化
  assert.equal(t.rows[4][2], '');
  assert.equal(t.mapping.worker, 4);
  assert.equal(t.rows[0][4], '山田');
  assert.equal(t.rows[3][4], '佐藤');
});

test('括弧モード', () => {
  const t = textToTable(MAIL, 'bracket', { open: '≪', close: '≫' }, cfg.members);
  assert.equal(t.rows.length, 5);
  assert.deepEqual(t.rows[0], ['271', '01-0973136', '3912-1418-9100', '山田']);
  const m = guessMapping(t.headers, t.rows, cfg.members, cfg);
  assert.equal(m.pc, 0);
  assert.equal(m.yrl, 1);
  assert.equal(m.slip, 2);
});

test('区切り（タブ）＋見出し判定', () => {
  const text = 'PC番号\tYRL\t伝票番号\t担当\n160\t01-0000001\t\t山田\n161\t01-0000002\t1234-5678-9012\t佐藤';
  const t = textToTable(text, 'delim', { delim: 'tab' }, cfg.members);
  assert.ok(looksLikeHeader(t.rows[0]));
  const rows = t.rows.slice(1);
  const m = guessMapping(t.rows[0], rows, cfg.members, cfg);
  assert.deepEqual([m.pc, m.yrl, m.slip, m.worker], [0, 1, 2, 3]);
});

test('正規表現（名前付きグループ）', () => {
  const t = textToTable('No.271 / 01-0973136', 'regex', { pattern: 'No\\.(?<pc>\\d+)\\s*/\\s*(?<yrl>\\S+)' });
  assert.deepEqual(t.mapping, { pc: 0, yrl: 1 });
  assert.equal(t.rows[0][1], '01-0973136');
});

test('取り込み計画：新規・空欄のみ・不一致・重複', () => {
  const units = { 271: { pc: 271, yrl: '01-0973136', slip: '', worker: '', status: 'todo' }, 300: { pc: 300, yrl: '01-0973136', status: 'todo' } };
  const t = textToTable(MAIL, 'auto', { pcMin: 160, pcMax: 660 }, cfg.members);
  const recs = rowsToRecords(t.rows, t.mapping);
  const plan = planImport(recs, units, cfg, { overwrite: false, setStatus: 'packed', date: '2026-10-08' });
  const p271 = plan.find((p) => p.pc === 271);
  assert.equal(p271.action, 'update');
  assert.equal(p271.changes.slip, '3912-1418-9100');
  assert.equal(p271.changes.status, 'packed');
  assert.equal(p271.changes.packedDate, '2026-10-08');
  assert.equal(p271.changes.worker, '山田');
  assert.ok(p271.warnings.some((w) => w.includes('PC300')));
  assert.equal(plan.filter((p) => p.action === 'new').length, 4);
  const ups = buildImportUpdates(plan, 1, 'me');
  assert.equal(ups[303].slip, '');
  assert.equal(ups[303].status, 'packed');

  const units2 = { 271: { pc: 271, yrl: '01-9999999', status: 'todo' } };
  const plan2 = planImport(recs.slice(0, 1), units2, cfg, { overwrite: false, setStatus: null, date: 'x' });
  assert.equal(plan2[0].action, 'partial');
  assert.equal(plan2[0].changes.yrl, undefined);
  const plan3 = planImport(recs.slice(0, 1), units2, cfg, { overwrite: true, setStatus: null, date: 'x' });
  assert.equal(plan3[0].changes.yrl, '01-0973136');
});

test('報告文：作業者ごと・番号順・梱包済みのみ', () => {
  const units = {
    275: { pc: 275, yrl: 'A', slip: 'S5', worker: '山田', status: 'packed', packedDate: 'D' },
    271: { pc: 271, yrl: 'B', slip: 'S1', worker: '山田', status: 'shipped', packedDate: 'D' },
    300: { pc: 300, yrl: 'C', slip: '', worker: '佐藤', status: 'packed', packedDate: 'D' },
    301: { pc: 301, yrl: 'E', slip: '', worker: '佐藤', status: 'wip', packedDate: null },
    302: { pc: 302, yrl: 'F', slip: '', worker: '佐藤', status: 'packed', packedDate: 'other' },
  };
  const txt = formatReport(units, 'D', cfg);
  assert.equal(txt, '【山田】 2台\n≪271≫　≪B≫　≪S1≫\n≪275≫　≪A≫　≪S5≫\n\n【佐藤】 1台\n≪300≫　≪C≫　≪≫\n\n合計 3台');
});

test('休憩をまたぐ時間計算', () => {
  const base = dayBase('2026-10-08');
  const br = parseBreaks('12:00-13:00');
  const at = (h, m = 0) => base + (h * 60 + m) * 60000;
  assert.equal(workMinutes(at(11), at(14), base, br), 120);
  assert.equal(addWorkMinutes(at(11, 30), 60, base, br), at(13, 30));
  assert.equal(addWorkMinutes(at(12, 30), 30, base, br), at(13, 30));
});

test('予測：標準値→実績、残業・繰越判定', () => {
  const date = '2026-10-08';
  const base = dayBase(date);
  const at = (h, m = 0) => base + (h * 60 + m) * 60000;
  const c = { ...cfg, breaks: '12:00-13:00', standardMin: 20, workEnd: '19:00', overtimeLimit: '21:00' };
  const att = { 山田: [{ s: at(7), e: null }], 佐藤: [{ s: at(7), e: null }] };
  // 朝：実績なし→標準20分。2人で残り60台 → 600分 → 7:00+10h+休憩1h = 18:00
  let f = forecast({ day: { target: 60, carry: 0, att }, cfg: c, done: 0, now: at(7), date });
  assert.equal(f.source, 'standard');
  assert.equal(f.state, 'ontime');
  assert.equal(f.etaMs, at(18));
  // 9:00に6台完了：延べ240分/6台 = 40分/台・人 → 残り54台*40/2 = 1080分 → 残業
  f = forecast({ day: { target: 60, carry: 0, att }, cfg: c, done: 6, now: at(9), date });
  assert.equal(f.source, 'actual');
  assert.equal(f.perUnit, 40);
  assert.equal(f.state, 'carry');
  assert.equal(f.capEnd, 27); // 9:00-19:00 実働540分*2/40
  assert.equal(f.carryForecast, 54 - 33);
  f = forecast({ day: { target: 38, carry: 0, att }, cfg: c, done: 6, now: at(9), date });
  assert.equal(f.state, 'overtime');
  assert.equal(Math.round(f.overtimeMin), 100);
  f = forecast({ day: { target: 6, carry: 0, att }, cfg: c, done: 6, now: at(9), date });
  assert.equal(f.state, 'achieved');
});

test('その他', () => {
  assert.equal(carryFrom({ target: 30, carry: 5 }, 28), 7);
  assert.equal(carryFrom({ target: 30, carry: 0 }, 35), 0);
  assert.equal(parseStatus('発送済み'), 'shipped');
  assert.equal(parseStatus('未発送'), null);
  assert.equal(parseStatus('梱包済'), 'packed');
  assert.equal(parseStatus('不具合'), 'hold');
  assert.equal(normNum('３９１２ー１４１８'), '3912-1418');
  const se = statusSideEffects({ status: 'packed', packedDate: 'D' }, 'wip', 'E', 'me');
  assert.equal(se.packedDate, null);
  const se2 = statusSideEffects({ status: 'packed', packedDate: 'D', worker: 'x' }, 'shipped', 'E', 'me');
  assert.equal(se2.packedDate, undefined); // 梱包日は維持
  assert.equal(toCSV([['a', 'b,c'], ['"q"', '']]), 'a,"b,c"\r\n"""q""",');
});
