// Serveur de prise de rendez-vous — aucune dépendance externe.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MODES = ['visio', 'teams', 'presentiel'];

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(5).toString('hex');
  console.log(`\n⚠  ADMIN_PASSWORD non défini. Mot de passe temporaire : ${ADMIN_PASSWORD}\n   (définissez ADMIN_PASSWORD pour le fixer)\n`);
}

// ---------- Stockage (fichier JSON, écriture atomique) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const defaults = () => ({
  settings: { title: 'Prendre rendez-vous', owner: '', intro: 'Choisissez un créneau disponible. Je confirmerai votre demande rapidement.',
              visioLink: '', teamsLink: '', address: '' },
  slots: [],
  closed: {}, // token -> vue figée des demandes refusées / annulées
});
let db = defaults();
try { db = { ...defaults(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { /* premier lancement */ }
const save = () => { const t = DB_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(db, null, 2)); fs.renameSync(t, DB_FILE); };
const uid = () => crypto.randomBytes(8).toString('hex');

// ---------- Utilitaires HTTP ----------
const sessions = new Map(); // token -> expiration
const SESSION_MS = 12 * 3600 * 1000;
const attempts = new Map(); // ip -> {n, t}

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e6) { reject(new Error('trop gros')); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('JSON invalide')); } });
});
const cookie = (req, name) => (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
const isAdmin = (req) => { const t = cookie(req, 'sid'); const e = t && sessions.get(t); if (e && e > Date.now()) return true; if (t) sessions.delete(t); return false; };
const safeEq = (a, b) => { const A = crypto.createHash('sha256').update(String(a)).digest(); const B = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(A, B); };
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const HttpError = (code, msg) => Object.assign(new Error(msg), { code });

const publicSlot = (s) => ({ id: s.id, start: s.start, end: s.end, modes: s.modes });
const bookingView = (s) => ({
  status: s.status, start: s.start, end: s.end, mode: s.booking.mode,
  name: s.booking.name, decisionMessage: s.decision?.message || '',
  link: s.status === 'confirmed' ? s.decision?.link || '' : '',
  address: s.status === 'confirmed' && s.booking.mode === 'presentiel' ? db.settings.address : '',
});
const findByToken = (t) => db.slots.find((s) => s.booking && s.booking.token === t);

// Les demandes refusées sont conservées dans l'historique du créneau puis le créneau est rouvert.
function icsFor(s) {
  const f = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const where = s.booking.mode === 'presentiel' ? db.settings.address : s.decision?.link || '';
  const esc = (x) => String(x).replace(/[\;,]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calendrier RDV//FR', 'BEGIN:VEVENT',
    `UID:${s.id}@calendrier-rdv`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(s.start)}`, `DTEND:${f(s.end)}`,
    `SUMMARY:${esc('Rendez-vous' + (db.settings.owner ? ' avec ' + db.settings.owner : ''))}`,
    `LOCATION:${esc(where)}`, `DESCRIPTION:${esc('Mode : ' + s.booking.mode)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

// ---------- Routes API ----------
async function api(req, res, url) {
  const m = req.method, p = url.pathname;

  // --- Public ---
  if (m === 'GET' && p === '/api/public') {
    const now = Date.now();
    return json(res, 200, {
      settings: { title: db.settings.title, owner: db.settings.owner, intro: db.settings.intro },
      slots: db.slots.filter((s) => s.status === 'open' && new Date(s.start) > now).sort((a, b) => a.start.localeCompare(b.start)).map(publicSlot),
    });
  }
  if (m === 'POST' && p === '/api/book') {
    const b = await readBody(req);
    const s = db.slots.find((x) => x.id === b.slotId);
    if (!s || new Date(s.start) <= Date.now()) throw HttpError(404, 'Ce créneau n’existe plus.');
    if (s.status !== 'open') throw HttpError(409, 'Désolé, ce créneau vient d’être pris. Choisissez-en un autre.');
    const name = str(b.name, 100), email = str(b.email, 150), phone = str(b.phone, 40), mode = str(b.mode, 20);
    if (!name) throw HttpError(400, 'Votre nom est requis.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw HttpError(400, 'Adresse e-mail invalide.');
    if (!s.modes.includes(mode)) throw HttpError(400, 'Mode de rendez-vous non proposé pour ce créneau.');
    const token = crypto.randomBytes(16).toString('hex');
    s.status = 'pending';
    s.booking = { token, name, email, phone, mode, note: str(b.note, 1000), createdAt: new Date().toISOString() };
    s.decision = null;
    save();
    return json(res, 201, { token });
  }
  let r;
  if (m === 'GET' && (r = p.match(/^\/api\/booking\/([a-f0-9]{32})$/))) {
    const s = findByToken(r[1]); if (!s) throw HttpError(404, 'Réservation introuvable.');
    return json(res, 200, bookingView(s));
  }
  if (m === 'GET' && (r = p.match(/^\/api\/booking\/([a-f0-9]{32})\.ics$/))) {
    const s = findByToken(r[1]); if (!s || s.status !== 'confirmed') throw HttpError(404, 'Rendez-vous non confirmé.');
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="rendez-vous.ics"' });
    return res.end(icsFor(s));
  }
  if (m === 'POST' && (r = p.match(/^\/api\/booking\/([a-f0-9]{32})\/cancel$/))) {
    const s = findByToken(r[1]); if (!s || !['pending', 'confirmed'].includes(s.status)) throw HttpError(404, 'Réservation introuvable.');
    archive(s, 'annulé par le client'); save();
    return json(res, 200, { ok: true });
  }

  // --- Admin : connexion ---
  if (m === 'POST' && p === '/api/admin/login') {
    const ip = req.socket.remoteAddress; const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 8) throw HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
    const b = await readBody(req);
    if (!safeEq(b.password ?? '', ADMIN_PASSWORD)) { a.n++; attempts.set(ip, a); throw HttpError(401, 'Mot de passe incorrect.'); }
    attempts.delete(ip);
    const sid = crypto.randomBytes(24).toString('hex'); sessions.set(sid, Date.now() + SESSION_MS);
    return json(res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
  }
  if (!p.startsWith('/api/admin/')) throw HttpError(404, 'Introuvable');
  if (!isAdmin(req)) throw HttpError(401, 'Non connecté');
  if (m === 'POST' && p === '/api/admin/logout') { sessions.delete(cookie(req, 'sid')); return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Max-Age=0; Path=/' }); }

  // --- Admin : données ---
  if (m === 'GET' && p === '/api/admin/state') return json(res, 200, { settings: db.settings, slots: [...db.slots].sort((a, b) => a.start.localeCompare(b.start)) });

  if (m === 'PUT' && p === '/api/admin/settings') {
    const b = await readBody(req);
    for (const k of ['title', 'owner', 'intro', 'visioLink', 'teamsLink', 'address']) if (k in b) db.settings[k] = str(b[k], 500);
    save(); return json(res, 200, db.settings);
  }
  if (m === 'POST' && p === '/api/admin/slots') { // création en lot : { slots:[{start,end}], modes:[] }
    const b = await readBody(req);
    const modes = (b.modes || []).filter((x) => MODES.includes(x)); if (!modes.length) throw HttpError(400, 'Choisissez au moins un mode.');
    if (!Array.isArray(b.slots) || b.slots.length > 500) throw HttpError(400, 'Liste de créneaux invalide.');
    let added = 0, skipped = 0;
    for (const x of b.slots) {
      const st = new Date(x.start), en = new Date(x.end);
      if (isNaN(st) || isNaN(en) || en <= st) { skipped++; continue; }
      const overlap = db.slots.some((s) => s.status !== 'cancelled' && new Date(s.start) < en && new Date(s.end) > st);
      if (overlap) { skipped++; continue; }
      db.slots.push({ id: uid(), start: st.toISOString(), end: en.toISOString(), modes, status: 'open', booking: null, decision: null, history: [] }); added++;
    }
    save(); return json(res, 201, { added, skipped });
  }
  if (m === 'DELETE' && (r = p.match(/^\/api\/admin\/slots\/(\w+)$/))) {
    const i = db.slots.findIndex((s) => s.id === r[1]); if (i < 0) throw HttpError(404, 'Créneau introuvable');
    if (db.slots[i].status === 'pending') throw HttpError(409, 'Une demande est en attente sur ce créneau : acceptez ou refusez-la d’abord.');
    db.slots.splice(i, 1); save(); return json(res, 200, { ok: true });
  }
  if (m === 'POST' && (r = p.match(/^\/api\/admin\/slots\/(\w+)\/decide$/))) {
    const s = db.slots.find((x) => x.id === r[1]); if (!s) throw HttpError(404, 'Créneau introuvable');
    if (s.status !== 'pending') throw HttpError(409, 'Aucune demande en attente sur ce créneau.');
    const b = await readBody(req); const message = str(b.message, 1000);
    if (b.action === 'accept') {
      const mode = MODES.includes(b.mode) ? b.mode : s.booking.mode;
      const link = mode === 'visio' ? db.settings.visioLink : mode === 'teams' ? db.settings.teamsLink : '';
      s.booking.mode = mode; s.status = 'confirmed';
      s.decision = { at: new Date().toISOString(), message, link: str(b.link, 500) || link };
    } else if (b.action === 'refuse') {
      archive(s, 'refusé', message);
    } else throw HttpError(400, 'Action inconnue.');
    save(); return json(res, 200, { ok: true });
  }
  throw HttpError(404, 'Introuvable');
}

// Archive la réservation courante et rouvre le créneau (refus / annulation).
function archive(s, outcome, message = '') {
  s.history = s.history || [];
  s.history.push({ ...s.booking, token: undefined, outcome, message, at: new Date().toISOString() });
  // Le client garde un lien valide pour voir « refusé » / « annulé ».
  db.closed[s.booking.token] = { status: outcome === 'refusé' ? 'refused' : 'cancelled', start: s.start, end: s.end, mode: s.booking.mode, name: s.booking.name, decisionMessage: message, link: '', address: '' };
  s.status = 'open'; s.booking = null; s.decision = null;
}

// ---------- Fichiers statiques ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(req, res, url) {
  let p = url.pathname;
  if (p === '/') p = '/index.html'; else if (p === '/admin') p = '/admin.html'; else if (p === '/reservation') p = '/booking.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Page introuvable'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      // Une réservation refusée n'existe plus côté créneau : on répond depuis le cache figé.
      const mm = url.pathname.match(/^\/api\/booking\/([a-f0-9]{32})$/);
      if (req.method === 'GET' && mm && db.closed[mm[1]] && !findByToken(mm[1])) return json(res, 200, db.closed[mm[1]]);
      return await api(req, res, url);
    }
    serveStatic(req, res, url);
  } catch (e) {
    json(res, e.code || 400, { error: e.code ? e.message : 'Requête invalide' });
    if (!e.code) console.error(e);
  }
});
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`Calendrier RDV prêt :\n  clients → http://localhost:${PORT}/\n  admin   → http://localhost:${PORT}/admin`));
}
export { server };
