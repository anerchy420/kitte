import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG, textToTable, guessMapping, rowsToRecords, planImport, buildImportUpdates,
  formatReport, forecast, dayBase, addWorkMinutes, workMinutes, parseBreaks, parseStatus,
  statusSideEffects, carryFrom, toCSV, normNum, looksLikeHeader,
  filterForExport, exportTable, splitForExport, DEFAULT_EXPORT,
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

test('書き出し：未完了を含む全件・条件・列・シート分け', () => {
  const units = {
    160: { pc: 160, yrl: 'Y0', status: 'todo', worker: '' },
    161: { pc: 161, yrl: 'Y1', status: 'wip', worker: '佐藤' },
    162: { pc: 162, yrl: 'Y2', slip: 'S2', status: 'packed', worker: '山田', packedDate: '2026-10-07' },
    163: { pc: 163, yrl: 'Y3', slip: 'S3', status: 'shipped', worker: '山田', packedDate: '2026-10-08' },
    164: { pc: 164, yrl: 'Y4', status: 'hold', worker: '佐藤' },
  };
  assert.equal(filterForExport(units, DEFAULT_EXPORT).length, 5);
  const ranged = filterForExport(units, { dateFrom: '2026-10-08', dateTo: '2026-10-08' });
  assert.deepEqual(ranged.map((u) => u.pc), [160, 161, 163, 164]); // 未完了は残る
  assert.deepEqual(filterForExport(units, { statuses: ['todo', 'wip', 'hold'] }).map((u) => u.pc), [160, 161, 164]);
  assert.deepEqual(filterForExport(units, { worker: 'none' }).map((u) => u.pc), [160]);
  assert.deepEqual(filterForExport(units, { slip: 'has' }).map((u) => u.pc), [162, 163]);
  assert.deepEqual(filterForExport(units, { sort: 'worker' }).map((u) => u.pc), [161, 164, 162, 163, 160]);
  const t = exportTable(filterForExport(units, {}), { columns: ['status', 'pc'] });
  assert.deepEqual(t[0], ['PC番号', 'ステータス']); // 列順は固定
  assert.deepEqual(t[1], [160, '未着手']);
  const sheets = splitForExport(filterForExport(units, {}), 'status');
  assert.deepEqual(sheets.map((g) => g.name), ['未着手', '作業中', '梱包済み', '発送済み', '保留・不具合']);
  assert.deepEqual(splitForExport(filterForExport(units, {}), 'worker').map((g) => g.name), ['未割当', '佐藤', '山田']);
});

test('まとめて編集：差分・梱包日の後編集・ステータス変更', async () => {
  const { buildEditUpdates, buildImportUpdates } = await import('../js/logic.js');
  const units = {
    271: { pc: 271, yrl: 'A', slip: '', worker: '遠藤', status: 'packed', packedDate: '2026-10-08' },
    272: { pc: 272, yrl: 'B', slip: '', worker: '', status: 'todo', packedDate: null },
    273: { pc: 273, yrl: 'C', slip: '', worker: '神谷', status: 'wip', packedDate: null },
  };
  const { ups, logs } = buildEditUpdates({
    271: { packedDate: '2026-10-07', slip: '3912-1418-9100' }, // 実績日の修正
    272: { status: 'packed', worker: '福山', packedDate: '2026-10-06' }, // 過去日付で梱包済み
    273: { yrl: 'C' }, // 変化なし
  }, units, '2026-10-09', 5, '根本');
  assert.equal(ups[271].packedDate, '2026-10-07');
  assert.equal(ups[271].slip, '3912-1418-9100');
  assert.equal(ups[272].status, 'packed');
  assert.equal(ups[272].packedDate, '2026-10-06');
  assert.equal(ups[272].worker, '福山');
  assert.equal(ups[273], undefined);
  assert.ok(logs.some((l) => l.pc === 271 && l.msg));
  assert.ok(logs.some((l) => l.pc === 272 && l.to === 'packed'));
  // 未完了の行に梱包日を入れても無視、梱包済み→作業中で梱包日クリア
  const r2 = buildEditUpdates({ 273: { packedDate: '2026-10-01' }, 271: { status: 'wip' } }, units, 'T', 1, 'x');
  assert.equal(r2.ups[273], undefined);
  assert.equal(r2.ups[271].packedDate, null);
  // 取り込みID
  const ups3 = buildImportUpdates([{ action: 'new', pc: 300, changes: { yrl: 'Y' } }, { action: 'update', pc: 271, changes: { slip: 'S' } }], 1, 'me', '10/09 07:00 me');
  assert.equal(ups3[300].importId, '10/09 07:00 me');
  assert.equal(ups3[271].importId, '10/09 07:00 me');
});

test('伝票番号のハイフン自動挿入', async () => {
  const { normSlip, textToTable, rowsToRecords } = await import('../js/logic.js');
  assert.equal(normSlip('391214189100'), '3912-1418-9100');
  assert.equal(normSlip('３９１２１４１８９１００'), '3912-1418-9100');
  assert.equal(normSlip('3912 1418 9100'), '3912-1418-9100');
  assert.equal(normSlip('3912-14189100'), '3912-1418-9100');
  assert.equal(normSlip('3912-1418-9100'), '3912-1418-9100');
  assert.equal(normSlip('39121418910'), '39121418910'); // 11桁はそのまま（形式エラーで警告）
  assert.equal(normSlip(''), '');
  const t = textToTable('≪271≫　≪01-0973136≫　≪391214189100≫\n272 01-0972982 3912-1418-9111', 'auto', { pcMin: 160, pcMax: 660 });
  assert.deepEqual(t.rows.map((r) => r.slice(0, 3)), [['271', '01-0973136', '3912-1418-9100'], ['272', '01-0972982', '3912-1418-9111']]);
  const b = textToTable('≪271≫　≪01-0973136≫　≪391214189100≫', 'bracket', {});
  assert.equal(rowsToRecords(b.rows, { pc: 0, yrl: 1, slip: 2 })[0].slip, '3912-1418-9100');
});
