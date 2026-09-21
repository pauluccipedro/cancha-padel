const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // para que detecte https detrás de Render
app.use(express.json());

const PIN = process.env.ADMIN_PIN || '1234';
const FILE = path.join(__dirname, 'data.json');
const MIN_UPCOMING = 6; // mínimo de partidos pendientes que se muestran

const newCourt = (id, name) => ({
  id, name: name || 'Cancha ' + id, players: [], matches: [], nextPlayerId: 1, nextMatchId: 1,
});

let state = { courts: {}, nextCourtId: 1 };
try {
  const loaded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (loaded.courts) state = loaded;
  else if (loaded.matches) { // datos de la versión de una sola cancha
    state = { courts: { 1: Object.assign(newCourt(1), loaded, { id: 1, name: 'Cancha 1' }) }, nextCourtId: 2 };
  }
} catch (e) {}
// Con NUM_COURTS=3 las canchas 1, 2 y 3 siempre existen (aunque el servidor se reinicie),
// así los QR impresos nunca quedan rotos.
const NUM = parseInt(process.env.NUM_COURTS || '0', 10);
for (let i = 1; i <= NUM; i++) if (!state.courts[i]) state.courts[i] = newCourt(i);
state.nextCourtId = Math.max(state.nextCourtId, NUM + 1);

const save = () => fs.writeFile(FILE, JSON.stringify(state), () => {});

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const ref = (p) => ({ id: p.id, name: p.name });
const key = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
const inMatch = (m, id) => [...m.t1, ...m.t2].some((p) => p.id === id);
const donePlayed = (c, id) => c.matches.filter((m) => m.done && inMatch(m, id)).length;

// Cantidad de partidos que hacen falta para que todos hayan jugado lo mismo
const cycleSize = (c) => {
  const n = c.players.length;
  return n >= 4 ? n / gcd(n, 4) : null;
};

const LOOKAHEAD = 4; // cuántos partidos hacia adelante se revisa para no quedar sin salida

const pairKey = (t) => key(t[0].id, t[1].id);
const matchKey = (t1, t2) => [pairKey(t1), pairKey(t2)].sort().join('|');

// Cuenta lo jugado y lo planificado (jugados + pendientes)
function stats(c) {
  const cnt = {}, last = {}, partner = {}, opp = {}, used = {};
  c.players.forEach((p) => { cnt[p.id] = p.credit; last[p.id] = p.since; });
  c.matches.forEach((m, i) => {
    [...m.t1, ...m.t2].forEach((p) => { if (p.id in cnt) { cnt[p.id]++; last[p.id] = i; } });
    [m.t1, m.t2].forEach((t) => { const k = pairKey(t); partner[k] = (partner[k] || 0) + 1; });
    m.t1.forEach((a) => m.t2.forEach((b) => { const k = key(a.id, b.id); opp[k] = (opp[k] || 0) + 1; }));
    const k = matchKey(m.t1, m.t2); used[k] = (used[k] || 0) + 1;
  });
  return { cnt, last, partner, opp, used };
}

// Devuelve los mejores candidatos para el próximo partido, ordenados por prioridad:
//  1) Juegan los que menos partidos llevan (así todos igualan).
//  2) Entre empatados: el que lleva más tiempo esperando y, si sigue el empate, el que llegó primero.
//  3) No se repite un partido exacto (mismas parejas contra mismas parejas) mientras haya otra opción.
//  4) Se evita repetir compañeros y rivales.
function candidates(c, max) {
  const { cnt, last, partner, opp, used } = stats(c);
  const ranked = c.players
    .map((p) => ({ p, cnt: cnt[p.id], last: last[p.id] }))
    .sort((a, b) => a.cnt - b.cnt || a.last - b.last || a.p.id - b.p.id);
  const cutoff = ranked[3].cnt;
  const must = ranked.filter((x) => x.cnt < cutoff).map((x) => x.p); // juegan sí o sí
  const pool = ranked.filter((x) => x.cnt === cutoff).slice(0, 14).map((x) => x.p); // empatados, por prioridad
  const need = 4 - must.length;

  const combos = [];
  (function pick(start, chosen) {
    if (chosen.length === need) return combos.push(chosen.slice());
    for (let i = start; i < pool.length; i++) { chosen.push(i); pick(i + 1, chosen); chosen.pop(); }
  })(0, []);

  const options = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
  const list = [];
  for (const idxs of combos) {
    const four = [...must, ...idxs.map((i) => pool[i])];
    const order = idxs.reduce((sum, i) => sum + i, 0); // más bajo = más prioridad
    for (const [[a, b], [x, y]] of options) {
      const t1 = [four[a], four[b]], t2 = [four[x], four[y]];
      let cost = 10 * ((partner[pairKey(t1)] || 0) + (partner[pairKey(t2)] || 0));
      for (const u of t1) for (const v of t2) cost += opp[key(u.id, v.id)] || 0;
      list.push({ t1, t2, score: [used[matchKey(t1, t2)] || 0, order, cost] });
    }
  }
  list.sort((x, y) => x.score[0] - y.score[0] || x.score[1] - y.score[1] || x.score[2] - y.score[2]);
  return list.slice(0, max);
}

const virtual = (cand) => ({ id: -1, t1: cand.t1.map(ref), t2: cand.t2.map(ref), done: false });

// ¿Existe una continuación de `depth` partidos sin repetir ninguno?
function canContinue(c, depth, budget) {
  if (depth === 0) return true;
  for (const cand of candidates(c, 4)) {
    if (cand.score[0] > 0 || --budget.n < 0) return false;
    c.matches.push(virtual(cand));
    const ok = canContinue(c, depth - 1, budget);
    c.matches.pop();
    if (ok) return true;
  }
  return false;
}

// Genera UN partido nuevo a continuación de los que ya existen (jugados + pendientes)
function buildMatch(c) {
  const cands = candidates(c, 6);
  let pick = cands[0];
  const budget = { n: 150 };
  for (const cand of cands) {
    if (cand.score[0] > 0) break; // ya se jugó exactamente igual
    c.matches.push(virtual(cand));
    const ok = canContinue(c, LOOKAHEAD - 1, budget);
    c.matches.pop();
    if (ok) { pick = cand; break; }
  }
  const { cnt } = stats(c);
  [...pick.t1, ...pick.t2].forEach((p) => cnt[p.id]++);
  const vals = c.players.map((p) => cnt[p.id]);
  return {
    id: c.nextMatchId++,
    t1: pick.t1.map(ref),
    t2: pick.t2.map(ref),
    done: false,
    eq: vals.every((v) => v === vals[0]), // ¿después de este partido todos igualan?
  };
}

// Completa la lista con partidos pendientes hasta cubrir ciclos completos
function fill(c) {
  const k = cycleSize(c);
  if (!k) return;
  const target = Math.ceil(Math.max(k, MIN_UPCOMING) / k) * k;
  let pending = c.matches.filter((m) => !m.done).length;
  while (pending++ < target) c.matches.push(buildMatch(c));
}

// El partido en curso es el primer pendiente. Al rearmar se conserva tal cual
// (salvo que se haya quitado a alguno de sus jugadores) y solo cambian los siguientes.
const trim = (c) => {
  const current = c.matches.find((m) => !m.done);
  const valid = current && [...current.t1, ...current.t2].every((p) => c.players.some((x) => x.id === p.id));
  c.matches = c.matches.filter((m) => m.done || (valid && m === current));
};

const rebuild = (c) => {
  trim(c);
  fill(c);
  save();
};

const admin = (req, res, next) =>
  req.get('x-pin') === PIN ? next() : res.status(401).json({ error: 'PIN incorrecto' });

// Busca la cancha de la URL (:cid) en todas las rutas /api/.../:cid/...
app.param('cid', (req, res, next, cid) => {
  req.court = state.courts[cid];
  return req.court ? next() : res.status(404).json({ error: 'Cancha no encontrada' });
});

// ---------- Páginas ----------
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/c/:id', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------- API de una cancha ----------
app.get('/api/courts/:cid/state', (req, res) => {
  const c = req.court;
  res.json({
    name: c.name,
    players: c.players.map((p) => ({ id: p.id, name: p.name, played: donePlayed(c, p.id) })),
    matches: c.matches.map((m, i) => ({ n: i + 1, id: m.id, t1: m.t1, t2: m.t2, done: m.done, eq: m.eq })),
    cycle: cycleSize(c),
  });
});

app.post('/api/courts/:cid/join', (req, res) => {
  const c = req.court;
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: 'Escribí tu nombre' });
  if (c.players.some((p) => p.name.toLowerCase() === name.toLowerCase()))
    return res.status(400).json({ error: 'Ese nombre ya está anotado' });
  trim(c);
  // Quien llega tarde arranca "parejo" con el que menos jugó
  const min = c.players.length ? Math.min(...c.players.map((p) => p.credit + donePlayed(c, p.id))) : 0;
  c.players.push({ id: c.nextPlayerId++, name, credit: min, since: c.matches.length });
  rebuild(c);
  res.json({ ok: true });
});

// Cualquier jugador puede marcar (o desmarcar) un partido como jugado
app.post('/api/courts/:cid/matches/:id/done', (req, res) => {
  const c = req.court;
  const m = c.matches.find((x) => x.id === Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Ese partido ya no existe. Actualizá la pantalla' });
  m.done = req.body.done !== false;
  fill(c);
  save();
  res.json({ ok: true });
});

app.delete('/api/courts/:cid/players/:id', admin, (req, res) => {
  req.court.players = req.court.players.filter((p) => p.id !== Number(req.params.id));
  rebuild(req.court);
  res.json({ ok: true });
});

app.post('/api/courts/:cid/regenerate', admin, (req, res) => { rebuild(req.court); res.json({ ok: true }); });

app.post('/api/courts/:cid/reset', admin, (req, res) => {
  const c = req.court;
  Object.assign(c, newCourt(c.id, c.name));
  save();
  res.json({ ok: true });
});

// ---------- API del organizador: crear canchas y QR ----------
const baseUrl = (req) => (process.env.PUBLIC_URL || req.protocol + '://' + req.get('host')).replace(/\/$/, '');

app.get('/api/admin/courts', admin, async (req, res) => {
  const list = await Promise.all(Object.values(state.courts).map(async (c) => {
    const url = baseUrl(req) + '/c/' + c.id;
    const qr = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240 });
    return { id: c.id, name: c.name, url, qr, players: c.players.length };
  }));
  res.json(list);
});

app.post('/api/admin/courts', admin, (req, res) => {
  const id = state.nextCourtId++;
  state.courts[id] = newCourt(id, String(req.body.name || '').trim().slice(0, 40));
  save();
  res.json({ ok: true });
});

app.delete('/api/admin/courts/:cid', admin, (req, res) => {
  delete state.courts[req.court.id];
  save();
  res.json({ ok: true });
});

module.exports = { app, state: () => state, newCourt };

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Cancha abierta en http://localhost:' + port));
}
