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

// Genera UN partido nuevo a continuación de los que ya existen (jugados + pendientes)
function buildMatch(c) {
  const cnt = {}, last = {}, partner = {}, opp = {};
  c.players.forEach((p) => { cnt[p.id] = p.credit; last[p.id] = p.since; });
  c.matches.forEach((m, i) => {
    [...m.t1, ...m.t2].forEach((p) => { if (p.id in cnt) { cnt[p.id]++; last[p.id] = i; } });
    [m.t1, m.t2].forEach((t) => { const k = key(t[0].id, t[1].id); partner[k] = (partner[k] || 0) + 1; });
    m.t1.forEach((a) => m.t2.forEach((b) => { const k = key(a.id, b.id); opp[k] = (opp[k] || 0) + 1; }));
  });

  const options = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
  let best = null, bestCost = Infinity;
  for (let t = 0; t < 40; t++) {
    // Juegan los que menos jugaron; desempate: quien más esperó, luego azar
    const four = c.players
      .map((p) => ({ p, r: Math.random() }))
      .sort((a, b) => cnt[a.p.id] - cnt[b.p.id] || last[a.p.id] - last[b.p.id] || a.r - b.r)
      .slice(0, 4).map((x) => x.p);
    for (const [[a, b], [x, y]] of options) {
      const t1 = [four[a], four[b]], t2 = [four[x], four[y]];
      let cost = 10 * ((partner[key(t1[0].id, t1[1].id)] || 0) + (partner[key(t2[0].id, t2[1].id)] || 0));
      for (const u of t1) for (const v of t2) cost += opp[key(u.id, v.id)] || 0;
      if (cost < bestCost) { bestCost = cost; best = { t1, t2 }; }
    }
  }
  [...best.t1, ...best.t2].forEach((p) => cnt[p.id]++);
  const vals = c.players.map((p) => cnt[p.id]);
  return {
    id: c.nextMatchId++,
    t1: best.t1.map(ref),
    t2: best.t2.map(ref),
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
