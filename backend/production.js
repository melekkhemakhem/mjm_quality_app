// backend/production.js
// Saisie machine/article + suivi de production (retard, arrêts, bilan des pertes)
'use strict';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Clés de justification : un arrêt, le retard de démarrage d'un jour, la fin anticipée d'un jour
const REF_RE =
  /^(STOP\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z|START\|\d{4}-\d{2}-\d{2}|END\|\d{4}-\d{2}-\d{2})$/;

module.exports = function registerProduction({ app, db, io, getTarget, cleanMachine, parseTs, emitMachines }) {
  const dbAll = (sql, p = []) =>
    new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));
  const dbGet = (sql, p = []) =>
    new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const dbRun = (sql, p = []) =>
    new Promise((res, rej) => db.run(sql, p, function (e) { return e ? rej(e) : res(this); }));

  // ==========================================
  // TABLES
  // ==========================================
  db.serialize(() => {
    // Une ligne par IP : nom de machine et article en cours (mis à jour indépendamment)
    db.run(`CREATE TABLE IF NOT EXISTS machine_info (
      ip TEXT PRIMARY KEY,
      machine_name TEXT,
      article TEXT,
      updated_at TEXT
    )`);
    // Justifications des arrêts / retards
    db.run(`CREATE TABLE IF NOT EXISTS stop_reasons (
      machine TEXT NOT NULL,
      ref TEXT NOT NULL,
      category TEXT,
      comment TEXT,
      updated_at TEXT,
      PRIMARY KEY (machine, ref)
    )`);
    // Accélère les requêtes par plage de dates (formats de timestamp mixtes -> datetime())
    db.run(`CREATE INDEX IF NOT EXISTS idx_cnc_machine_dt ON cnc(machine, datetime(timestamp))`);
  });

  // ==========================================
  // RÉGLAGES DE POSTE (persistés dans la table settings)
  // ==========================================
  const shift = { shiftStart: '05:00', shiftEnd: '21:00', minorStopSec: 90, majorStopSec: 300 };

  function loadShift() {
    db.all(
      `SELECT key, value FROM settings WHERE key IN ('shiftStart','shiftEnd','minorStopSec','majorStopSec')`,
      [],
      (err, rows) => {
        if (err) return console.error('❌ loadShift :', err.message);
        (rows || []).forEach((r) => {
          shift[r.key] = r.key.endsWith('Sec') ? Number(r.value) : r.value;
        });
        console.log(`⏱ Poste idéal : ${shift.shiftStart} → ${shift.shiftEnd}`);
      }
    );
  }

  app.get('/api/shift-settings', (req, res) => res.json(shift));

  app.post('/api/shift-settings', async (req, res) => {
    const b = req.body || {};
    const next = { ...shift };
    if (b.shiftStart !== undefined) next.shiftStart = String(b.shiftStart);
    if (b.shiftEnd !== undefined) next.shiftEnd = String(b.shiftEnd);
    if (b.minorStopSec !== undefined) next.minorStopSec = Number(b.minorStopSec);
    if (b.majorStopSec !== undefined) next.majorStopSec = Number(b.majorStopSec);

    if (!HHMM.test(next.shiftStart) || !HHMM.test(next.shiftEnd) || next.shiftEnd <= next.shiftStart) {
      return res.status(400).json({ error: 'Horaires invalides (HH:MM, fin après début)' });
    }
    if (!(next.minorStopSec >= 10) || !(next.majorStopSec > next.minorStopSec) || next.majorStopSec > 86400) {
      return res.status(400).json({ error: 'Seuils invalides (arrêt ≥ 10 s, arrêt grave > arrêt)' });
    }
    try {
      for (const [k, v] of Object.entries(next)) {
        await dbRun(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [k, String(v)]
        );
      }
      Object.assign(shift, next);
      io.emit('shiftSettingsUpdate', shift);
      res.json(shift);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==========================================
  // SAISIE : NOM DE MACHINE + ARTICLE (par IP)
  // ==========================================
  const listInfo = () =>
    dbAll(`
      SELECT m.machine AS ip, i.machine_name AS machineName, i.article AS article, i.updated_at AS updatedAt
      FROM machines m LEFT JOIN machine_info i ON i.ip = m.machine
      ORDER BY m.machine`);

  const emitInfo = () =>
    listInfo()
      .then((l) => io.emit('machineInfoUpdate', l))
      .catch((e) => console.error('❌ emitInfo :', e.message));

  app.get('/api/machine-info', async (req, res) => {
    try { res.json(await listInfo()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Mise à jour partielle : seuls les champs PRÉSENTS dans le body sont modifiés
  // ('' ou null = effacer le champ)
  app.put('/api/machine-info/:ip', async (req, res) => {
    try {
      const ip = cleanMachine(req.params.ip);
      const b = req.body || {};
      const hasName = Object.prototype.hasOwnProperty.call(b, 'machineName');
      const hasArticle = Object.prototype.hasOwnProperty.call(b, 'article');
      if (!hasName && !hasArticle) {
        return res.status(400).json({ error: 'machineName et/ou article requis' });
      }
      const clean = (v) => { const s = String(v == null ? '' : v).trim().slice(0, 80); return s || null; };
      const now = new Date().toISOString();

      // La machine est créée si elle n'existe pas encore (pré-enregistrement possible)
      await dbRun(`INSERT OR IGNORE INTO machines (machine, first_seen) VALUES (?, ?)`, [ip, now]);
      await dbRun(
        `INSERT INTO machine_info (ip, machine_name, article, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET
           machine_name = CASE WHEN ? THEN excluded.machine_name ELSE machine_info.machine_name END,
           article      = CASE WHEN ? THEN excluded.article      ELSE machine_info.article      END,
           updated_at   = excluded.updated_at`,
        [ip, clean(b.machineName), clean(b.article), now, hasName ? 1 : 0, hasArticle ? 1 : 0]
      );
      emitInfo();
      emitMachines();
      const row = (await listInfo()).find((r) => r.ip === ip);
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==========================================
  // JUSTIFICATIONS (arrêts, retard de démarrage, fin anticipée)
  // ==========================================
  app.put('/api/stop-reasons', async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.machine) return res.status(400).json({ error: 'machine requise' });
      const machine = cleanMachine(b.machine);
      const ref = String(b.ref || '');
      if (!REF_RE.test(ref)) return res.status(400).json({ error: 'ref invalide' });
      const category = String(b.category || '').trim().slice(0, 60) || null;
      const comment = String(b.comment || '').trim().slice(0, 300) || null;

      if (!category && !comment) {
        await dbRun(`DELETE FROM stop_reasons WHERE machine = ? AND ref = ?`, [machine, ref]);
      } else {
        await dbRun(
          `INSERT INTO stop_reasons (machine, ref, category, comment, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(machine, ref) DO UPDATE SET
             category = excluded.category, comment = excluded.comment, updated_at = excluded.updated_at`,
          [machine, ref, category, comment, new Date().toISOString()]
        );
      }
      io.emit('stopReasonUpdate', { machine });
      res.json({ machine, ref, category, comment });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Appelée quand une machine est supprimée
  function purgeMachine(machine) {
    db.run('DELETE FROM machine_info WHERE ip = ?', [machine]);
    db.run('DELETE FROM stop_reasons WHERE machine = ?', [machine]);
  }

  // ==========================================
  // ANALYSE DE PRODUCTION (réel vs idéal)
  // ==========================================
  // Un « signal » = un tick dont le compteur a augmenté (une production).
  async function analyze(machine, date, from, to, S, E, now) {
    const target = getTarget(machine);
    // Seuils d'arrêt : jamais inférieurs à 2 x l'intervalle normal entre deux pièces
    const minorMs = Math.max(shift.minorStopSec * 1000, (2 * 60000) / target);
    const majorMs = Math.max(shift.majorStopSec * 1000, minorMs * 2);

    const iso = (ms) => new Date(ms).toISOString();
    const toMin = (ms) => ms / 60000;
    const r1 = (x) => Math.round(x * 10) / 10;
    const r2 = (x) => Math.round(x * 100) / 100;

    const before = await dbGet(
      `SELECT compteur FROM cnc
       WHERE machine = ? AND datetime(timestamp) < datetime(?)
       ORDER BY datetime(timestamp) DESC, id DESC LIMIT 1`,
      [machine, iso(from)]
    );
    const rows = await dbAll(
      `SELECT timestamp, compteur FROM cnc
       WHERE machine = ? AND datetime(timestamp) >= datetime(?) AND datetime(timestamp) < datetime(?)
       ORDER BY datetime(timestamp), id`,
      [machine, iso(from), iso(to)]
    );
    const reasonRows = await dbAll(`SELECT ref, category, comment FROM stop_reasons WHERE machine = ?`, [machine]);
    const reasons = new Map(reasonRows.map((r) => [r.ref, r]));

    // --- signaux de production ---
    let prev = before ? before.compteur : null;
    const ev = [];
    for (const r of rows) {
      if (prev !== null && r.compteur > prev) {
        ev.push({ t: parseTs(r.timestamp).getTime(), d: r.compteur - prev });
      }
      prev = r.compteur;
    }
    const first = ev[0];
    const last = ev[ev.length - 1];

    // Fenêtre évaluée : de l'heure idéale de début jusqu'à maintenant (ou la fin idéale)
    const cutoff = Math.min(now, E);
    const dayOver = now >= E;
    const winMin = Math.max(0, toMin(cutoff - S));
    const overlapMin = (a, b) => Math.max(0, toMin(Math.min(b, cutoff) - Math.max(a, S)));

    const events = [];
    const mkEvent = (type, ref, startTs, endTs, durMs, lostMin, ongoing) => {
      const rs = reasons.get(ref);
      return {
        ref, type,
        severity: durMs >= majorMs ? 'MAJOR' : 'MINOR',
        ongoing,
        startTs: iso(startTs),
        endTs: endTs == null ? null : iso(endTs),
        durationMin: toMin(durMs),
        lostMin,
        category: rs ? rs.category : null,
        comment: rs ? rs.comment : null,
        justified: !!(rs && (rs.category || rs.comment))
      };
    };

    // --- démarrage ---
    let lateStartMin = 0;
    let earlyStartMin = 0;
    if (!first) {
      const ms = cutoff - S;
      if (ms >= minorMs) {
        lateStartMin = toMin(ms);
        events.push(mkEvent('START', `START|${date}`, S, dayOver ? E : null, ms, lateStartMin, !dayOver));
      }
    } else if (first.t > S) {
      const ms = Math.min(first.t, cutoff) - S;
      if (ms >= minorMs) {
        lateStartMin = toMin(ms);
        events.push(mkEvent('START', `START|${date}`, S, first.t, first.t - S, lateStartMin, false));
      }
    } else {
      earlyStartMin = toMin(S - first.t);          // démarrage avant l'heure idéale = gain
    }

    // --- arrêts entre deux signaux ---
    for (let i = 1; i < ev.length; i++) {
      const g = ev[i].t - ev[i - 1].t;
      if (g >= minorMs) {
        events.push(mkEvent('STOP', `STOP|${iso(ev[i - 1].t)}`, ev[i - 1].t, ev[i].t, g,
          overlapMin(ev[i - 1].t, ev[i].t), false));
      }
    }

    // --- silence final : arrêt en cours (journée active) ou fin anticipée (journée terminée) ---
    let endEarlyMin = 0;
    let lateEndMin = 0;
    if (last) {
      if (!dayOver) {
        if (now >= S && now - last.t >= minorMs) {
          events.push(mkEvent('STOP', `STOP|${iso(last.t)}`, last.t, null, now - last.t,
            overlapMin(last.t, now), true));
        }
      } else if (last.t < E) {
        const ms = E - last.t;
        if (ms >= minorMs) {
          endEarlyMin = toMin(E - Math.max(last.t, S));
          events.push(mkEvent('END', `END|${date}`, last.t, E, ms, endEarlyMin, false));
        }
      } else {
        lateEndMin = toMin(last.t - E);            // fin après l'heure idéale = gain
      }
    }

    // --- temps ---
    const stopEvents = events.filter((e) => e.type === 'STOP');
    const sumLost = (list) => list.reduce((a, e) => a + e.lostMin, 0);
    const stopsLost = sumLost(stopEvents);
    const minorLost = sumLost(stopEvents.filter((e) => e.severity === 'MINOR'));
    const majorLost = sumLost(stopEvents.filter((e) => e.severity === 'MAJOR'));
    const runMin = Math.max(0, winMin - lateStartMin - stopsLost - endEarlyMin);

    // --- pièces ---
    let real = 0;
    let realInside = 0;
    for (const e of ev) {
      real += e.d;
      if (e.t >= S && e.t <= cutoff) realInside += e.d;
    }
    const idealFull = target * toMin(E - S);
    const idealToDate = target * winMin;
    const speedLoss = target * runMin - realInside;   // > 0 : cadence sous la cible pendant la marche

    // --- bilan des causes ---
    const causeMap = new Map();
    const addCause = (label, kind, minutes, pieces, count) => {
      const c = causeMap.get(label) || { label, kind, minutes: 0, pieces: 0, count: 0 };
      c.minutes += minutes; c.pieces += pieces; c.count += count;
      causeMap.set(label, c);
    };
    const typeLabel = { START: 'retard de démarrage', STOP: 'arrêt', END: 'fin anticipée' };
    for (const e of events) {
      if (e.lostMin > 0) {
        addCause(e.category || `Non justifié (${typeLabel[e.type]})`, 'TIME', e.lostMin, e.lostMin * target, 1);
      }
    }
    if (speedLoss > 0.5) addCause('Ralentissement de cadence', 'SPEED', speedLoss / target, speedLoss, 0);
    const causes = Array.from(causeMap.values())
      .sort((a, b) => b.pieces - a.pieces)
      .map((c) => ({ ...c, minutes: r1(c.minutes), pieces: Math.round(c.pieces) }));

    // --- indicateurs ---
    const nbStops = stopEvents.filter((e) => e.lostMin > 0).length;
    const kpi = {
      availability: winMin > 0 ? runMin / winMin : 0,
      performance: runMin > 0 ? realInside / (target * runMin) : 0,
      trs: idealToDate > 0 ? realInside / idealToDate : 0,
      avgRunPPM: runMin > 0 ? r2(realInside / runMin) : 0,
      nbStops,
      mttrMin: nbStops ? r1(stopsLost / nbStops) : 0,
      longestStopMin: r1(stopEvents.reduce((m, e) => Math.max(m, e.durationMin), 0)),
      projection: null
    };
    if (!dayOver && now >= S) {
      const w = Math.min(30 * 60000, now - S);
      const recent = ev.filter((e) => e.t > now - w).reduce((a, e) => a + e.d, 0);
      const recentPPM = w > 0 ? recent / toMin(w) : 0;
      kpi.projection = Math.round(realInside + recentPPM * toMin(E - now));
    }

    // --- statut ---
    let status;
    if (now < S && !(last && now - last.t < minorMs)) status = 'WAITING';
    else if (dayOver) status = 'FINISHED';
    else {
      const idle = last ? now - last.t : now - S;
      status = idle >= majorMs ? 'STOP_MAJOR' : idle >= minorMs ? 'STOP_MINOR' : 'RUNNING';
    }

    // --- courbe par tranche de 15 min ---
    const B = 15 * 60000;
    const tl0 = Math.floor(Math.min(S, first ? first.t : S) / B) * B;
    const tl1 = Math.ceil(Math.max(E, last ? last.t : E) / B) * B;
    const timeline = [];
    for (let b = tl0; b < tl1; b += B) {
      const overlapFull = Math.max(0, toMin(Math.min(b + B, E) - Math.max(b, S)));
      timeline.push({ t: b, pieces: 0, idealFull: Math.round(target * overlapFull * 10) / 10 });
    }
    for (const e of ev) {
      const idx = Math.floor((e.t - tl0) / B);
      if (idx >= 0 && idx < timeline.length) timeline[idx].pieces += e.d;
    }

    return {
      machine, date, now: iso(now), target,
      thresholds: { minorSec: Math.round(minorMs / 1000), majorSec: Math.round(majorMs / 1000) },
      ideal: { start: iso(S), end: iso(E), minutes: r1(toMin(E - S)), pieces: Math.round(idealFull), piecesToDate: Math.round(idealToDate) },
      real: {
        start: first ? iso(first.t) : null,
        end: last ? iso(last.t) : null,
        pieces: Math.round(real),
        piecesInside: Math.round(realInside),
        piecesOutside: Math.round(real - realInside),
        status
      },
      gap: { pieces: Math.round(real - idealToDate), pct: idealToDate > 0 ? real / idealToDate : 0 },
      start: { lateMin: r1(lateStartMin), earlyMin: r1(earlyStartMin) },
      end: { earlyMin: r1(endEarlyMin), lateMin: r1(lateEndMin) },
      events: events.map((e) => ({ ...e, durationMin: r1(e.durationMin), lostMin: r1(e.lostMin) })),
      totals: {
        winMin: r1(winMin), runMin: r1(runMin), stopsLostMin: r1(stopsLost),
        minorLostMin: r1(minorLost), majorLostMin: r1(majorLost), speedLossPieces: Math.round(speedLoss)
      },
      kpi, causes, timeline
    };
  }

  // GET /api/analysis?machine=&date=YYYY-MM-DD&from=&to=&idealStart=&idealEnd=   (dates ISO UTC)
  // Les bornes sont calculées par le navigateur (heure locale) : le serveur n'a pas à connaître le fuseau.
  app.get('/api/analysis', async (req, res) => {
    try {
      const q = req.query;
      if (!q.machine) return res.status(400).json({ error: 'machine requise' });
      const date = String(q.date || '');
      const from = Date.parse(q.from);
      const to = Date.parse(q.to);
      const S = Date.parse(q.idealStart);
      const E = Date.parse(q.idealEnd);
      if (!DATE_RE.test(date) || [from, to, S, E].some(Number.isNaN) || !(E > S) || !(to > from) ||
          to - from > 48 * 3600 * 1000) {
        return res.status(400).json({ error: 'paramètres invalides' });
      }
      res.json(await analyze(cleanMachine(q.machine), date, from, to, S, E, Date.now()));
    } catch (e) {
      console.error('❌ /api/analysis :', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  io.on('connection', (socket) => {
    listInfo().then((l) => socket.emit('machineInfoUpdate', l)).catch(() => {});
    socket.emit('shiftSettingsUpdate', shift);
  });

  return { loadShift, purgeMachine };
};