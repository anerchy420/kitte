// カメラでバーコードを読み取る画面
//   Android Chrome などは端末内蔵の BarcodeDetector（角度に強い・高速）を使い、
//   使えない端末（iPhone など）は ZXing（WebAssembly）を読み込んで使う。
import { parseScan } from './logic.js';

const ZXING_VER = '3.1.5';
const ZXING_BASE = `https://cdn.jsdelivr.net/npm/zxing-wasm@${ZXING_VER}/dist`;
const FORMATS_NATIVE = ['codabar', 'code_39', 'code_128'];
const FORMATS_ZXING = ['Codabar', 'Code39', 'Code128'];
const ANGLES = [0, 15, -15, 30, -30, 45, -45]; // ZXing はほぼ水平しか読めないので角度を変えて試す

let zxingP;
function loadZXing() {
  zxingP ||= import(`${ZXING_BASE}/es/reader/index.js`).then((m) => {
    m.prepareZXingModule({
      overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? `${ZXING_BASE}/reader/${path}` : prefix + path) },
      fireImmediately: true,
    });
    return m;
  }).catch((e) => { zxingP = null; throw e; });
  return zxingP;
}

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const sup = await window.BarcodeDetector.getSupportedFormats();
    const f = FORMATS_NATIVE.filter((x) => sup.includes(x));
    return f.includes('codabar') || f.includes('code_39') ? new window.BarcodeDetector({ formats: f }) : null;
  } catch {
    return null;
  }
}

// 回転・切り抜きしてキャンバスに描く
function drawRotated(canvas, src, sx, sy, sw, sh, angle, maxW) {
  const scale = Math.min(1, maxW / sw);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const rad = (angle * Math.PI) / 180;
  const cw = Math.round(Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad)));
  const ch = Math.round(Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)));
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(rad);
  ctx.drawImage(src, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return ctx.getImageData(0, 0, cw, ch);
}

let audioCtx;
function beep(ok) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = ok ? 1400 : 400;
    g.gain.value = 0.08;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + (ok ? 0.08 : 0.25));
  } catch { /* 音が出せない環境 */ }
  try { navigator.vibrate?.(ok ? 60 : [60, 60, 60]); } catch { /* 無視 */ }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.hint]
 * @param {boolean} [o.continuous] 続けて読む（発送登録など）
 * @param {object} [o.cfg] PC番号の範囲など
 * @param {(p:{kind,value,raw})=>({ok:boolean,msg:string,done?:boolean})} o.onScan
 */
export function openScanner({ title, hint = '', target = '', continuous = false, cfg, onScan, onClose }) {
  const el = document.createElement('div');
  el.className = 'scanner';
  el.innerHTML = `
    <div class="sc-top"><b>${esc(title)}</b><button class="sc-x" aria-label="閉じる">✕</button></div>
    ${target ? `<div class="sc-target">読むバーコード：<b>${esc(target)}</b></div>` : ''}
    <div class="sc-view"><video playsinline muted autoplay></video><div class="sc-guide"><i></i></div><div class="sc-flash"></div></div>
    <div class="sc-msg">${esc(hint || 'バーコードを枠の中に横向きで写してください')}</div>
    <ul class="sc-log"></ul>
    <div class="sc-bottom">
      <label class="btn">📷 写真で読み取る<input type="file" accept="image/*" capture="environment" hidden></label>
      <button class="btn sc-torch hidden">💡 ライト</button>
      <button class="btn primary sc-done">${continuous ? '完了' : '閉じる'}</button>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add('noscroll');
  const video = el.querySelector('video');
  const msg = el.querySelector('.sc-msg');
  const log = el.querySelector('.sc-log');
  const flash = el.querySelector('.sc-flash');
  const canvas = document.createElement('canvas');
  let stream = null;
  let closed = false;
  let timer = null;
  let busy = false;
  let angleIdx = 0;
  let last = { v: '', t: 0 };
  let detector = null;
  let zx = null;

  const setMsg = (t, cls = '') => { msg.textContent = t; msg.className = 'sc-msg ' + cls; };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    el.remove();
    if (!document.querySelector('.sheet:not(.hidden)')) document.body.classList.remove('noscroll');
    onClose?.();
  };
  el.querySelector('.sc-x').onclick = close;
  el.querySelector('.sc-done').onclick = close;

  // 読み取った値の処理（同じ値の連続読み取りは無視）
  const seenNg = new Map(); // 失敗した値 → 表示行（同じ結果は1行にまとめる）
  const handle = (text) => {
    const p = parseScan(text, cfg);
    const now = Date.now();
    if (p.value === last.v && now - last.t < 2500) return false;
    last = { v: p.value, t: now };
    // 同じ値で失敗し続けている間は、回数だけ増やして音も鳴らさない
    const prevNg = seenNg.get(p.value);
    if (prevNg && now - prevNg.t < 15000) {
      prevNg.t = now;
      prevNg.n++;
      prevNg.li.querySelector('.n').textContent = ` ×${prevNg.n}`;
      return false;
    }
    let r;
    if (!p.kind) r = { ok: false, msg: `対象外のバーコードです（${p.value}）` };
    else r = onScan(p) || { ok: true, msg: p.value };
    beep(r.ok);
    flash.className = 'sc-flash ' + (r.ok ? 'ok' : 'ng');
    setTimeout(() => { flash.className = 'sc-flash'; }, 350);
    const li = document.createElement('li');
    li.className = r.ok ? 'ok' : 'ng';
    li.innerHTML = `${r.ok ? '✅' : '⚠'} ${esc(r.msg)}<span class="n"></span>`;
    if (!r.ok) seenNg.set(p.value, { t: now, n: 1, li });
    log.prepend(li);
    while (log.children.length > 20) log.lastChild.remove();
    if (r.ok && (!continuous || r.done)) setTimeout(close, 300);
    return r.ok;
  };

  async function decodeFrame() {
    if (closed) return;
    if (!busy && video.readyState >= 2 && video.videoWidth) {
      busy = true;
      try {
        if (detector) {
          const res = await detector.detect(video);
          for (const b of res) if (handle(b.rawValue)) break;
        } else if (zx) {
          // 枠（中央）だけを切り出し、角度を変えながら読む
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const sw = vw * 0.9;
          const sh = Math.min(vh, vw * 0.55);
          const img = drawRotated(canvas, video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, ANGLES[angleIdx], 1100);
          angleIdx = (angleIdx + 1) % ANGLES.length;
          const res = await zx.readBarcodes(img, { formats: FORMATS_ZXING, tryHarder: true, maxNumberOfSymbols: 2 });
          for (const b of res) if (b.isValid !== false && handle(b.text)) break;
        }
      } catch (e) {
        console.warn(e);
      }
      busy = false;
    }
    timer = setTimeout(decodeFrame, detector ? 150 : 60);
  }

  // 写真から読む（角度・大きさを変えて何度か試す）
  async function decodeImage(file) {
    setMsg('写真を読み取り中…');
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
      const found = [];
      if (detector) {
        for (const b of await detector.detect(bmp)) found.push(b.rawValue);
      }
      if (!found.length) {
        zx ||= await loadZXing();
        outer: for (const maxW of [2400, 1200]) {
          for (const a of [0, 20, -20, 45, -45, 70, -70, 90]) {
            const img = drawRotated(canvas, bmp, 0, 0, bmp.width, bmp.height, a, maxW);
            const res = await zx.readBarcodes(img, { formats: FORMATS_ZXING, tryHarder: true, maxNumberOfSymbols: 8 });
            for (const b of res) if (!found.includes(b.text)) found.push(b.text);
            if (found.some((t) => parseScan(t, cfg).kind)) break outer;
          }
        }
      }
      const useful = found.filter((t) => parseScan(t, cfg).kind);
      if (!useful.length) {
        setMsg(found.length ? `対象のバーコードがありません（${found.join(', ')}）` : '読み取れませんでした。バーコードに近づいて撮り直してください', 'ng');
        beep(false);
        return;
      }
      setMsg('読み取りました');
      for (const t of useful) { last = { v: '', t: 0 }; handle(t); if (closed) break; }
    } catch (e) {
      setMsg('写真を読めませんでした: ' + e.message, 'ng');
    }
  }
  el.querySelector('input[type=file]').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) decodeImage(f);
  };

  (async () => {
    detector = await nativeDetector();
    if (!detector) {
      setMsg('読み取り機能を準備中…');
      try { zx = await loadZXing(); } catch (e) { setMsg('読み取り機能を読み込めませんでした（電波を確認）: ' + e.message, 'ng'); return; }
    }
    if (closed) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (e) {
      setMsg('カメラを使えません（ブラウザのカメラ許可を確認）。「写真で読み取る」も使えます。', 'ng');
      return;
    }
    if (closed) { stream.getTracks().forEach((t) => t.stop()); return; }
    video.srcObject = stream;
    await video.play().catch(() => {});
    setMsg(hint || 'バーコードを枠の中に横向きで写してください');
    const track = stream.getVideoTracks()[0];
    try {
      const cap = track.getCapabilities?.() || {};
      if (cap.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      if (cap.torch) {
        const tb = el.querySelector('.sc-torch');
        let on = false;
        tb.classList.remove('hidden');
        tb.onclick = () => { on = !on; track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {}); tb.classList.toggle('on', on); };
      }
    } catch { /* 無視 */ }
    decodeFrame();
  })();

  return { close, handle };
}
