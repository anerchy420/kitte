// データ保存層：Firebase Firestore（本番） / localStorage（デモモード）
import { FIREBASE_CONFIG } from './firebase-config.js';
import { chunkId } from './logic.js';

export const isDemo = !FIREBASE_CONFIG || !FIREBASE_CONFIG.apiKey;

export async function teamIdFromPasscode(pass) {
  const data = new TextEncoder().encode('kitte-v1:' + pass.trim());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createStore(teamId) {
  return isDemo ? new LocalStore(teamId) : createFirebaseStore(teamId);
}

// ---------------- Firebase ----------------
const V = '10.12.2';
async function createFirebaseStore(teamId) {
  const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  const fs = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
  const app = initializeApp(FIREBASE_CONFIG);
  let db;
  try {
    db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
  } catch {
    db = fs.getFirestore(app);
  }
  const col = (name) => fs.collection(db, 'teams', teamId, name);
  const ref = (name, id) => fs.doc(db, 'teams', teamId, name, id);
  const err = (e) => { console.error(e); window.dispatchEvent(new CustomEvent('store-error', { detail: e })); };
  const commit = (p) => p.catch(err);

  return {
    kind: 'firebase',
    onUnits(cb) {
      const chunks = {};
      return fs.onSnapshot(col('units'), { includeMetadataChanges: true }, (snap) => {
        snap.docChanges().forEach((ch) => {
          if (ch.type === 'removed') delete chunks[ch.doc.id];
          else chunks[ch.doc.id] = ch.doc.data().u || {};
        });
        const all = {};
        for (const c of Object.values(chunks)) Object.assign(all, c);
        cb(all, { fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites });
      }, err);
    },
    setUnits(updates) {
      const byChunk = {};
      for (const [pc, v] of Object.entries(updates)) {
        (byChunk[chunkId(pc)] ||= {})[pc] = v === null ? fs.deleteField() : v;
      }
      const entries = Object.entries(byChunk);
      const ps = [];
      for (let i = 0; i < entries.length; i += 400) {
        const b = fs.writeBatch(db);
        for (const [c, u] of entries.slice(i, i + 400)) b.set(ref('units', c), { u }, { merge: true });
        ps.push(b.commit());
      }
      return commit(Promise.all(ps));
    },
    onConfig(cb) {
      return fs.onSnapshot(ref('meta', 'config'), (s) => cb(s.exists() ? s.data() : null, { fromCache: s.metadata.fromCache }), err);
    },
    setConfig(p) { return commit(fs.setDoc(ref('meta', 'config'), p, { merge: true })); },
    onDay(date, cb) {
      return fs.onSnapshot(ref('days', date), (s) => cb(s.exists() ? s.data() : null, { fromCache: s.metadata.fromCache }), err);
    },
    setDay(date, p) { return commit(fs.setDoc(ref('days', date), p, { merge: true })); },
    // 既存の上書きを避けるためトランザクションで作成
    createDayIfAbsent(date, data) {
      return commit(fs.runTransaction(db, async (tx) => {
        const s = await tx.get(ref('days', date));
        if (!s.exists()) tx.set(ref('days', date), data);
      }));
    },
    async listDays() {
      const snap = await fs.getDocs(col('days'));
      const out = {};
      snap.forEach((d) => { out[d.id] = d.data(); });
      return out;
    },
    onLog(date, cb) {
      return fs.onSnapshot(ref('logs', date), (s) => cb(s.exists() ? s.data().e || [] : []), err);
    },
    addLog(date, entries) {
      if (!entries.length) return Promise.resolve();
      return commit(fs.setDoc(ref('logs', date), { e: fs.arrayUnion(...entries) }, { merge: true }));
    },
    async deleteAll() {
      for (const name of ['units', 'days', 'logs', 'meta']) {
        const snap = await fs.getDocs(col(name));
        const b = fs.writeBatch(db);
        snap.forEach((d) => b.delete(d.ref));
        await b.commit();
      }
    },
  };
}

// ---------------- デモ（この端末のみ） ----------------
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(t, s) {
  for (const [k, v] of Object.entries(s)) {
    if (isObj(v) && isObj(t[k])) merge(t[k], v);
    else t[k] = isObj(v) ? merge({}, v) : v;
  }
  return t;
}

class LocalStore {
  constructor(teamId) {
    this.kind = 'local';
    this.key = 'kitte-demo-' + teamId.slice(0, 16);
    this.subs = new Set();
    this.load();
    try {
      this.bc = new BroadcastChannel(this.key);
      this.bc.onmessage = () => { this.load(); this.emit(); };
    } catch { /* 古いブラウザ */ }
  }
  load() {
    try { this.s = JSON.parse(localStorage.getItem(this.key)) || {}; } catch { this.s = {}; }
    this.s.units ||= {};
    this.s.days ||= {};
    this.s.logs ||= {};
  }
  save() {
    localStorage.setItem(this.key, JSON.stringify(this.s));
    this.bc?.postMessage(1);
    this.emit();
    return Promise.resolve();
  }
  emit() { for (const f of this.subs) f(); }
  sub(f) { this.subs.add(f); queueMicrotask(f); return () => this.subs.delete(f); }
  onUnits(cb) { return this.sub(() => cb(structuredClone(this.s.units), { fromCache: false })); }
  setUnits(ups) {
    for (const [pc, v] of Object.entries(ups)) {
      if (v === null) delete this.s.units[pc];
      else this.s.units[pc] = merge(this.s.units[pc] || {}, v);
    }
    return this.save();
  }
  onConfig(cb) { return this.sub(() => cb(this.s.config ? structuredClone(this.s.config) : null, { fromCache: false })); }
  setConfig(p) { this.s.config = merge(this.s.config || {}, p); return this.save(); }
  onDay(date, cb) { return this.sub(() => cb(this.s.days[date] ? structuredClone(this.s.days[date]) : null, { fromCache: false })); }
  setDay(date, p) { this.s.days[date] = merge(this.s.days[date] || {}, p); return this.save(); }
  createDayIfAbsent(date, data) { if (!this.s.days[date]) { this.s.days[date] = data; return this.save(); } return Promise.resolve(); }
  async listDays() { return structuredClone(this.s.days); }
  onLog(date, cb) { return this.sub(() => cb([...(this.s.logs[date] || [])])); }
  addLog(date, entries) { (this.s.logs[date] ||= []).push(...entries); return this.save(); }
  async deleteAll() { this.s = { units: {}, days: {}, logs: {} }; return this.save(); }
}
