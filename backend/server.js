require('dotenv').config();   // charge le fichier .env (doit rester en 1re ligne)
const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

// ==========================================
// CONFIGURATION
// ==========================================
const TCP_HOST = '192.168.100.118';
const TCP_PORT = 9801;
const WEB_PORT = 8080;

// Spécifications exactes RKE
const SPECS = {
  dim1: { name: 'Longueur 16', lsl: 15.799, usl: 16.201, target: 16.000 },
  dim2: { name: 'Longueur 13', lsl: 13.249, usl: 13.551, target: 13.400 },
  dim3: { name: 'Petit Diam 2', lsl: 5.600,  usl: 5.905,  target: 5.752 }
};
// Réglage dynamique (persisté en BDD)
let targetPPM = 4;

// Alertes (secrets via variables d'environnement, jamais en dur)
const ALERT = {
  enabled: process.env.WA_ENABLED !== 'false',
  provider: process.env.WA_PROVIDER || 'telegram',    // 'telegram' | 'callmebot' | 'twilio'

  // --- Telegram ---
  telegramToken: process.env.TELEGRAM_TOKEN || '',     // ex: 123456789:AAH...
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',  // ex: 6298282575

  // --- WhatsApp (CallMeBot / Twilio) ---
  phone: process.env.WA_PHONE || '',                   // ex: +216XXXXXXXX
  callmebotKey: process.env.CALLMEBOT_APIKEY || '',
  twilioSid: process.env.TWILIO_SID || '',
  twilioToken: process.env.TWILIO_TOKEN || '',
  twilioFrom: process.env.TWILIO_FROM || 'whatsapp:+14155238886',

  // --- Seuils ---
  dropRatio: 0.5,          // alerte si cadence < 50 % de la cible
  recoverRatio: 0.8,       // retour à la normale si >= 80 %
  stallFactor: 3,          // arrêt si aucun tick depuis 3 x l'intervalle attendu
  minStallMin: 2,          // ... avec un minimum de 2 min
  repeatCooldownMin: 10    // anti-spam si la chute persiste
};

// ==========================================
// BASE DE DONNÉES SQLITE (ROBUSTE)
// ==========================================
const db = new sqlite3.Database('measures.db', (err) => {
  if (err) {
    console.error('❌ Erreur ouverture BDD :', err.message);
  } else {
    console.log('✔ Base de données ouverte');
  }
});

// Attend jusqu'à 10 secondes au lieu de crasher si le fichier est verrouillé
db.configure('busyTimeout', 10000);

db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA synchronous = NORMAL;');
  db.run('PRAGMA temp_store = MEMORY;');

  // Table 1 : Cotations / Mesures tridimensionnelles (RKE)
  db.run(`CREATE TABLE IF NOT EXISTS measures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    dim1 REAL,
    dim2 REAL,
    dim3 REAL,
    raw TEXT
  )`);

  // Table 2 : Compteurs Machines CNC
  db.run(`CREATE TABLE IF NOT EXISTS cnc (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    machine TEXT,
    compteur INTEGER
  )`);

  // Table 3 : Réglages
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
});

// ==========================================
// EXPRESS + SOCKET.IO
// ==========================================
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ==========================================
// ROUTES API — RKE (MEASURES / SPC)
// ==========================================
// Les anciennes lignes SQLite sont en UTC sans "Z" → on les normalise en ISO
function parseTs(v) {
  if (v instanceof Date) return v;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)
    ? new Date(s.replace(' ', 'T') + 'Z')
    : new Date(s);
}

function loadSettings(cb) {
  db.get(`SELECT value FROM settings WHERE key = 'targetPPM'`, [], (err, row) => {
    if (!err && row) {
      const v = parseFloat(row.value);
      if (v > 0) targetPPM = v;
    }
    console.log(`⚙ Cible PPM chargée : ${targetPPM}`);
    if (cb) cb();
  });
}

app.get('/api/settings', (req, res) => res.json({ targetPPM }));

app.post('/api/settings', (req, res) => {
  const v = parseFloat(req.body && req.body.targetPPM);
  if (!(v > 0) || v > 1000) return res.status(400).json({ error: 'targetPPM invalide' });
  targetPPM = v;
  db.run(
    `INSERT INTO settings (key, value) VALUES ('targetPPM', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(v)],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('settingsUpdate', { targetPPM });   // tous les postes se synchronisent
      res.json({ targetPPM });
    }
  );
});

io.on('connection', (socket) => socket.emit('settingsUpdate', { targetPPM }));

// ==========================================
// ALERTES (TELEGRAM / WHATSAPP)
// ==========================================
async function sendTelegram(text) {
  if (!ALERT.telegramToken || !ALERT.telegramChatId) {
    console.warn('⚠ Telegram non configuré (TELEGRAM_TOKEN / TELEGRAM_CHAT_ID manquant)');
    return false;
  }
  const r = await fetch(
    `https://api.telegram.org/bot${ALERT.telegramToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ALERT.telegramChatId, text })
    }
  );
  if (!r.ok) throw new Error(`Telegram ${r.status} ${await r.text()}`);
  return true;
}

async function sendTwilio(text) {
  const auth = Buffer.from(`${ALERT.twilioSid}:${ALERT.twilioToken}`).toString('base64');
  const r = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${ALERT.twilioSid}/Messages.json`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body: new URLSearchParams({
        From: ALERT.twilioFrom,
        To: `whatsapp:${ALERT.phone}`,
        Body: text
      })
    }
  );
  if (!r.ok) throw new Error(`Twilio ${r.status} ${await r.text()}`);
  return true;
}

async function sendCallMeBot(text) {
  const url =
    `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(ALERT.phone)}` +
    `&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(ALERT.callmebotKey)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`CallMeBot ${r.status} ${await r.text()}`);
  return true;
}

// Point d'entrée unique pour toutes les alertes
async function sendAlert(text) {
  if (!ALERT.enabled) return false;

  try {
    if (ALERT.provider === 'telegram') {
      if (!(await sendTelegram(text))) return false;
    } else {
      if (!ALERT.phone) {
        console.warn('⚠ WhatsApp non configuré (WA_PHONE manquant)');
        return false;
      }
      if (ALERT.provider === 'twilio') await sendTwilio(text);
      else await sendCallMeBot(text);
    }
    console.log(`📲 Alerte envoyée (${ALERT.provider})`);
    return true;
  } catch (e) {
    console.error(`❌ Alerte (${ALERT.provider}) :`, e.message);
    return false;
  }
}

const machineState = new Map(); // machine -> { lastTs, lastCounter, state: 'OK'|'DROP'|'STALL', lastAlertAt }
const hhmmss = (ms) =>
  new Date(ms).toLocaleTimeString('fr-FR', {
    timeZone: 'Africa/Tunis', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

function evaluateTick(machine, compteur, ts) {
  const st = machineState.get(machine) ||
    { lastTs: null, lastCounter: null, state: 'OK', lastAlertAt: 0 };
  machineState.set(machine, st);

  if (st.state === 'STALL') {
    // Un tick arrive après un arrêt → reprise
    st.state = 'OK';
    st.lastAlertAt = Date.now();
    sendAlert(`✅ REPRISE CNC\nMachine : ${machine}\nHeure : ${hhmmss(ts)}\nCompteur : ${compteur}`);
  } else if (st.lastTs && targetPPM > 0) {
    const dtMin = (ts - st.lastTs) / 60000;
    const delta = compteur - st.lastCounter;
    if (dtMin > 0.05 && delta >= 0) {
      const ppm = delta / dtMin;
      const ratio = ppm / targetPPM;
      const now = Date.now();

      if (ratio < ALERT.dropRatio) {
        const firstTime = st.state !== 'DROP';
        if (firstTime || now - st.lastAlertAt > ALERT.repeatCooldownMin * 60000) {
          st.state = 'DROP';
          st.lastAlertAt = now;
          sendAlert(
            `🚨 CHUTE DE CADENCE CNC\n` +
            `Machine : ${machine}\n` +
            `Cadence : ${ppm.toFixed(2)} PPM (cible ${targetPPM}) → ${Math.round(ratio * 100)} %\n` +
            `Intervalle : ${dtMin.toFixed(1)} min pour +${delta} pcs\n` +
            `Heure : ${hhmmss(ts)}\nCompteur : ${compteur}`
          );
        }
      } else if (ratio >= ALERT.recoverRatio && st.state === 'DROP') {
        st.state = 'OK';
        sendAlert(`✅ Cadence rétablie\nMachine : ${machine}\n${ppm.toFixed(2)} PPM (cible ${targetPPM})\nHeure : ${hhmmss(ts)}`);
      }
    }
  }
  st.lastTs = ts;
  st.lastCounter = compteur;
}

// Watchdog : détecte l'arrêt SANS attendre le prochain tick
setInterval(() => {
  if (!(targetPPM > 0)) return;
  const limitMin = Math.max(ALERT.minStallMin, (1 / targetPPM) * ALERT.stallFactor);
  for (const [machine, st] of machineState) {
    if (!st.lastTs || st.state === 'STALL') continue;
    const idleMin = (Date.now() - st.lastTs) / 60000;
    if (idleMin > limitMin) {
      st.state = 'STALL';
      st.lastAlertAt = Date.now();
      sendAlert(
        `🛑 ARRÊT CNC DÉTECTÉ\nMachine : ${machine}\n` +
        `Aucun signal depuis ${idleMin.toFixed(1)} min (cible ${targetPPM} PPM)\n` +
        `Dernier signal : ${hhmmss(st.lastTs)}`
      );
    }
  }
}, 15000);

// Test rapide de la config d'alerte
app.post('/api/alerts/test', async (req, res) => {
  const ok = await sendAlert('🧪 Test : alertes CNC opérationnelles');
  res.json({ sent: ok, provider: ALERT.provider });
});

// Dernières mesures brutes
app.get('/api/measures/latest', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  db.all(
    'SELECT * FROM (SELECT * FROM measures ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// Statistiques cumulées + fenêtre Cpk
app.get('/api/stats', (req, res) => {
  const windowSize = parseInt(req.query.window) || 100;

  // 1) Stats GLOBALES (tout le lot)
  db.get(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN
        dim1 >= ${SPECS.dim1.lsl} AND dim1 <= ${SPECS.dim1.usl} AND
        dim2 >= ${SPECS.dim2.lsl} AND dim2 <= ${SPECS.dim2.usl} AND
        dim3 >= ${SPECS.dim3.lsl} AND dim3 <= ${SPECS.dim3.usl}
      THEN 1 ELSE 0 END) as ok
    FROM measures
  `, [], (err, globalRow) => {
    if (err || !globalRow) return res.json({});

    const total = globalRow.total || 0;
    const ok = globalRow.ok || 0;
    const ng = total - ok;

    // 2) Stats sur la FENÊTRE (ex: 100 dernières pcs)
    const limitQuery = windowSize > 0 ? `LIMIT ${windowSize}` : '';
    db.all(
      `SELECT dim1, dim2, dim3 FROM measures ORDER BY id DESC ${limitQuery}`,
      [],
      (err2, rows) => {
        if (err2 || !rows || rows.length === 0) {
          return res.json({
            global: {
              total,
              ok,
              ng,
              yield: total > 0 ? (ok / total) * 100 : 0,
              ngRate: total > 0 ? (ng / total) * 100 : 0,
              windowSize: 0
            }
          });
        }

        res.json({
          dim1: computeStats(rows.map(r => r.dim1), SPECS.dim1),
          dim2: computeStats(rows.map(r => r.dim2), SPECS.dim2),
          dim3: computeStats(rows.map(r => r.dim3), SPECS.dim3),
          global: {
            total,
            ok,
            ng,
            yield: total > 0 ? (ok / total) * 100 : 0,
            ngRate: total > 0 ? (ng / total) * 100 : 0,
            windowSize: rows.length
          }
        });
      }
    );
  });
});

// Remise à zéro du lot RKE
app.post('/api/reset', (req, res) => {
  db.run('DELETE FROM measures', [], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    console.log('🔄 Lot RKE remis à zéro');
    res.json({ success: true });
  });
});

// ==========================================
// ROUTES API — CNC (COMPTEURS)
// ==========================================

// Réception d'un tick compteur (depuis PowerShell / machine usine)
app.post('/api/measure', (req, res) => {
  const { machine, compteur, date } = req.body || {};
  const machineName = machine || 'Inconnue';
  const numCompteur = parseInt(compteur, 10) || 0;
  const nowIso = new Date().toISOString();
  console.log(`\n📥 [${date || new Date().toISOString()}] CNC (${machineName}) → ${numCompteur}`);

  db.run(
    `INSERT INTO cnc (timestamp, machine, compteur) VALUES (?, ?, ?)`,
    [nowIso, machineName, numCompteur],
    function (err) {
      if (err) {
        console.error('❌ Erreur SQLite CNC :', err.message);
        return res.status(500).json({ error: err.message });
      }

      const newCncRecord = {
        id: this.lastID,
        timestamp: new Date(nowIso),
        machine: machineName,
        compteur: numCompteur
      };

      io.emit('cncUpdate', newCncRecord);
      evaluateTick(machineName, numCompteur, new Date(nowIso).getTime()); // ← alerte

      console.log(`✅ CNC enregistré (ID: ${this.lastID}) et diffusé`);
      res.json({ status: 'success', id: this.lastID });
    }
  );
});

// Historique des compteurs CNC
app.get('/api/cnc', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  db.all(
    'SELECT * FROM cnc ORDER BY id DESC LIMIT ?',
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json((rows || []).map(r => ({ ...r, timestamp: parseTs(r.timestamp).toISOString() })));
    }
  );
});

// Dernier compteur par machine
app.get('/api/cnc/latest', (req, res) => {
  db.all(`
    SELECT c.*
    FROM cnc c
    INNER JOIN (
      SELECT machine, MAX(id) AS max_id
      FROM cnc
      GROUP BY machine
    ) t ON c.id = t.max_id
    ORDER BY c.machine
  `, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json((rows || []).map(r => ({ ...r, timestamp: parseTs(r.timestamp).toISOString() })));
  });
});

// Remise à zéro des compteurs CNC
app.post('/api/cnc/reset', (req, res) => {
  db.run('DELETE FROM cnc', [], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    machineState.clear();
    console.log('🔄 Compteurs CNC remis à zéro');
    res.json({ success: true });
  });
});

// ==========================================
// CALCUL SPC (Cp / Cpk)
// ==========================================
function computeStats(values, spec) {
  const n = values.length;
  if (n < 2) return null;

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance) || 0.0001;

  const cp  = (spec.usl - spec.lsl) / (6 * std);
  const cpu = (spec.usl - mean) / (3 * std);
  const cpl = (mean - spec.lsl) / (3 * std);
  const cpk = Math.min(cpu, cpl);

  const below = values.filter(v => v < spec.lsl).length;
  const above = values.filter(v => v > spec.usl).length;
  const inTol = n - below - above;

  return {
    name: spec.name,
    n,
    mean,
    std,
    min: Math.min(...values),
    max: Math.max(...values),
    cp,
    cpk,
    cpu,
    cpl,
    lsl: spec.lsl,
    usl: spec.usl,
    target: spec.target,
    bias: mean - spec.target,
    below,
    above,
    inTol,
    yield: (inTol / n) * 100
  };
}

// ==========================================
// CLIENT TCP → MACHINE RKE (192.168.100.118:9801)
// ==========================================
function connectTCP() {
  console.log(`📡 Connexion TCP vers ${TCP_HOST}:${TCP_PORT}...`);
  const client = new net.Socket();

  // Évite que le process crashe sur ECONNRESET
  client.setKeepAlive(true, 10000);

  client.connect(TCP_PORT, TCP_HOST, () => {
    console.log(`✔ CONNECTÉ AU FLUX TCP (${TCP_HOST}:${TCP_PORT})`);
  });

  client.on('data', (data) => {
    const raw = data.toString().trim();
    if (!raw) return;

    raw.split(/\r?\n/).forEach(line => {
      if (!line) return;
      const parts = line.split(';').map(p => parseFloat(String(p).trim()));
      if (parts.length >= 3 && parts.every(v => !isNaN(v))) {
        const [dim1, dim2, dim3] = parts;

        db.run(
          'INSERT INTO measures (dim1, dim2, dim3, raw) VALUES (?, ?, ?, ?)',
          [dim1, dim2, dim3, line],
          (err) => {
            if (err) {
              // Ne pas crasher le serveur si un insert échoue
              console.error('❌ Insert measures :', err.message);
              return;
            }
            // Diffusion temps réel vers Angular
            io.emit('newMeasure', {
              timestamp: new Date(),
              dim1,
              dim2,
              dim3
            });
          }
        );
      }
    });
  });

  client.on('close', () => {
    console.log('⚠ Connexion TCP fermée. Reconnexion dans 3s...');
    setTimeout(connectTCP, 3000);
  });

  client.on('error', (err) => {
    console.error('❌ Erreur TCP :', err.message);
    // close déclenchera la reconnexion
    try { client.destroy(); } catch (_) {}
  });
}

// ==========================================
// DÉMARRAGE
// ==========================================
loadSettings();
connectTCP();

server.listen(WEB_PORT, () => {
  console.log(`🌐 API démarrée sur http://localhost:${WEB_PORT}`);
  console.log(`   • RKE  : GET  /api/stats  |  GET /api/measures/latest  |  POST /api/reset`);
  console.log(`   • CNC  : POST /api/measure  |  GET /api/cnc  |  GET /api/cnc/latest  |  POST /api/cnc/reset`);
  console.log(`   • Alertes : ${ALERT.enabled ? ALERT.provider : 'désactivées'}  |  POST /api/alerts/test`);
});

// Fermeture propre
process.on('SIGINT', () => {
  console.log('\n🛑 Arrêt du serveur...');
  db.close();
  process.exit(0);
});