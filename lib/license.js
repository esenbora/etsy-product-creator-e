// flowiqa.com license client.
// Sunucu sözleşmesi: docs/LICENSE-SYSTEM.md
// Cache: data/license.json (ed25519 imzalı, HWID kilitli)

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CACHE_PATH = path.join(ROOT, 'data', 'license.json');
const ACTIVATE_PAGE = path.join(ROOT, 'public', 'activate.html');

// SABIT degerler: env override YOK. Kullanicinin .env veya NODE_ENV ile lisansi
// atlatamamasi icin. Server keypair rotation gerekirse: bu dosyadaki SERVER_PUBLIC_KEY_PEM
// guncellenir + release atilir. Client'lar bir sonraki update'te yeni key'i alir.
const SERVER_URL = 'https://flowiqa-license-server-production.up.railway.app';
const APP_ID = 'etsy-product-creator';
const GRACE_DAYS = 7;                              // Internet kesintisi tolerans suresi
const HEARTBEAT_INTERVAL_MS = 3 * 60 * 60 * 1000;  // 3 saat (revoke gecikme tavani)

const SERVER_PUBLIC_KEY_PEM = `
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEABzmEronci5P9whpXyuQ/5QO6Bwd9ZU0Qf3z77eJwZF4=
-----END PUBLIC KEY-----
`.trim();

// ────────────────────────────────────────────────────────────────────────
// HWID — stabil platform UUID kullanir. Network interface degisikliklerinden
// (Wi-Fi -> Ethernet) etkilenmez. BIOS/SMBIOS UUID kullanici tarafindan
// degistirilemez (root/admin yetkisi gerek), bu nedenle key paylasimina karsi
// daha guclu bir bag.

function tryExec(cmd) {
  try {
    return execSync(cmd, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).toString();
  } catch { return ''; }
}

function getPlatformUuid() {
  // macOS: IOKit IOPlatformUUID (stable boot's arasi)
  if (process.platform === 'darwin') {
    const out = tryExec('ioreg -d2 -c IOPlatformExpertDevice');
    const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
    if (m) return 'mac:' + m[1];
  }
  // Linux: systemd machine-id
  if (process.platform === 'linux') {
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = fs.readFileSync(p, 'utf8').trim();
        if (id && /^[a-f0-9]{32}$/i.test(id)) return 'linux:' + id;
      } catch {}
    }
  }
  // Windows: SMBIOS UUID
  if (process.platform === 'win32') {
    const out = tryExec('wmic csproduct get uuid');
    const m = /([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})/i.exec(out);
    if (m) return 'win:' + m[1];
    // Yedek: PowerShell
    const ps = tryExec('powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"');
    const mp = /([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})/i.exec(ps);
    if (mp) return 'win:' + mp[1];
  }
  return null;
}

function computeHwid() {
  const platformUuid = getPlatformUuid();
  if (platformUuid) {
    // Pepper ile karistir (App-id) ki ayni makine farkli urunlerde farkli HWID alsin.
    return crypto
      .createHash('sha256')
      .update(`${APP_ID}|${platformUuid}`)
      .digest('hex')
      .slice(0, 32);
  }
  // Fallback: eski yontem (network MAC). VM'lerde veya container'larda gerekli.
  const ifaces = os.networkInterfaces();
  let mac = '';
  for (const name of Object.keys(ifaces).sort()) {
    for (const iface of ifaces[name] || []) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        mac = iface.mac; break;
      }
    }
    if (mac) break;
  }
  const raw = `fallback|${APP_ID}|${os.hostname()}|${os.platform()}|${os.arch()}|${mac}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

const HWID = computeHwid();

// ────────────────────────────────────────────────────────────────────────
// Cache

function ensureCacheDir() {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
  catch { return null; }
}

function writeCache(data) {
  ensureCacheDir();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
}

function clearCache() {
  try { fs.unlinkSync(CACHE_PATH); } catch {}
}

// ────────────────────────────────────────────────────────────────────────
// Signature

function verifySignature(payloadObj, signatureB64) {
  if (!signatureB64) return false;
  try {
    const payloadJson = canonicalJson(payloadObj);
    const ok = crypto.verify(
      null,
      Buffer.from(payloadJson),
      SERVER_PUBLIC_KEY_PEM,
      Buffer.from(signatureB64, 'base64')
    );
    return ok;
  } catch (err) {
    console.error('[license] signature verify error:', err.message);
    return false;
  }
}

// Server ile aynı sıralamayı garanti etmek için key sıralı stringify.
function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

// ────────────────────────────────────────────────────────────────────────
// Server calls

async function postJson(pathname, body) {
  const url = `${SERVER_URL}${pathname}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': `${APP_ID}/1.0` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: resp.ok, status: resp.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function activate(email, key) {
  const r = await postJson('/api/license/activate', {
    app: APP_ID,
    email: (email || '').trim().toLowerCase(),
    key: (key || '').trim(),
    hwid: HWID,
  });
  if (!r.ok) {
    const code = r.json?.error || `http_${r.status}`;
    throw new Error(code);
  }
  if (!r.json || !r.json.payload || !r.json.signature) {
    throw new Error('invalid_server_response');
  }
  if (!verifySignature(r.json.payload, r.json.signature)) {
    throw new Error('invalid_signature');
  }
  if (r.json.payload.hwid !== HWID) {
    throw new Error('hwid_mismatch');
  }
  const cache = {
    payload: r.json.payload,
    signature: r.json.signature,
    lastCheck: new Date().toISOString(),
    lastSuccessfulCheck: new Date().toISOString(),
  };
  writeCache(cache);
  return cache;
}

async function heartbeat() {
  const cache = readCache();
  if (!cache?.payload?.key) return { skipped: 'no_cache' };

  let updated = { ...cache, lastCheck: new Date().toISOString() };

  try {
    const r = await postJson('/api/license/check', {
      app: APP_ID,
      key: cache.payload.key,
      hwid: HWID,
    });
    if (r.ok && r.json?.payload && r.json?.signature) {
      if (!verifySignature(r.json.payload, r.json.signature)) {
        // Sahte/MITM yanıt — cache değiştirme, online doğrulama başarısız say.
        writeCache(updated);
        return { ok: false, reason: 'invalid_signature' };
      }
      if (r.json.payload.hwid !== HWID) {
        updated.payload = { ...updated.payload, status: 'hwid_mismatch' };
        writeCache(updated);
        return { ok: false, reason: 'hwid_mismatch' };
      }
      updated.payload = r.json.payload;
      updated.signature = r.json.signature;
      updated.lastSuccessfulCheck = new Date().toISOString();
      writeCache(updated);
      return { ok: true, payload: r.json.payload };
    }
    if (r.status === 403 && r.json?.payload && r.json?.signature
        && verifySignature(r.json.payload, r.json.signature)) {
      // Server lisansı revoke etmiş, imzalı kanıt gönderdi -> cache'i revoked olarak güncelle.
      updated.payload = r.json.payload;
      updated.signature = r.json.signature;
      updated.lastSuccessfulCheck = new Date().toISOString();
      writeCache(updated);
      return { ok: false, reason: r.json.payload.status || 'revoked' };
    }
    writeCache(updated);
    return { ok: false, reason: r.json?.error || `http_${r.status}` };
  } catch (err) {
    writeCache(updated);
    return { ok: false, reason: 'network_error', error: err.message };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Validity

function getStatus() {
  const cache = readCache();
  if (!cache) return { valid: false, reason: 'no_license', hwid: HWID };
  const { payload, signature, lastSuccessfulCheck } = cache;
  if (!payload || !signature) return { valid: false, reason: 'corrupt_cache', hwid: HWID };
  if (!verifySignature(payload, signature)) return { valid: false, reason: 'invalid_signature', hwid: HWID };
  if (payload.hwid !== HWID) return { valid: false, reason: 'hwid_mismatch', hwid: HWID };
  if (payload.status !== 'active') return { valid: false, reason: payload.status || 'inactive', hwid: HWID, payload };
  if (payload.expires && Date.parse(payload.expires) < Date.now()) {
    return { valid: false, reason: 'expired', hwid: HWID, payload };
  }
  if (lastSuccessfulCheck) {
    const ageMs = Date.now() - Date.parse(lastSuccessfulCheck);
    if (ageMs > GRACE_DAYS * 24 * 60 * 60 * 1000) {
      return { valid: false, reason: 'grace_expired', hwid: HWID, payload };
    }
  } else {
    return { valid: false, reason: 'never_validated', hwid: HWID, payload };
  }
  return { valid: true, plan: payload.plan, expires: payload.expires, email: payload.email, hwid: HWID };
}

function isLicenseValid() {
  return getStatus().valid;
}

// ────────────────────────────────────────────────────────────────────────
// CLI gate

async function ensureLicenseOrExit() {
  const status = getStatus();
  if (status.valid) {
    // Boot heartbeat başlat (fire-and-forget).
    heartbeat().catch(() => {});
    return;
  }
  console.error('');
  console.error('Lisans dogrulanamadi:', status.reason);
  console.error('Cozum:');
  console.error('  - Web UI:   npm start ve http://localhost:3001/activate');
  console.error('  - Yardim:   https://flowiqa.com/account');
  console.error('');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────
// Express integration

let heartbeatTimer = null;

function startHeartbeatLoop() {
  if (heartbeatTimer) return;
  heartbeat().catch(() => {});
  heartbeatTimer = setInterval(() => { heartbeat().catch(() => {}); }, HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function mountLicense(app) {
  // Aktivasyon sayfası (lisans yokken erişilebilir).
  app.get('/activate', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(ACTIVATE_PAGE);
  });

  // Status endpoint.
  app.get('/api/license/status', (req, res) => {
    const s = getStatus();
    // Sensitive alan göndermiyoruz, sadece UI için gerekli özet.
    const safe = {
      valid: s.valid,
      reason: s.reason || null,
      plan: s.plan || s.payload?.plan || null,
      expires: s.expires || s.payload?.expires || null,
      email: s.email || s.payload?.email || null,
      hwid: s.hwid,
      bypass: !!s.bypass,
    };
    res.json(safe);
  });

  // Aktivasyon endpoint (proxy to flowiqa.com, signature verify).
  app.post('/api/license/activate', async (req, res) => {
    const { email, key } = req.body || {};
    if (!email || !key) return res.status(400).json({ error: 'email_and_key_required' });
    try {
      const cache = await activate(email, key);
      startHeartbeatLoop();
      res.json({ ok: true, plan: cache.payload.plan, expires: cache.payload.expires });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Manual deactivation (kullanıcı kendi makinesinden çıkış).
  app.post('/api/license/deactivate', async (req, res) => {
    const cache = readCache();
    if (cache?.payload?.key) {
      try { await postJson('/api/license/deactivate', { key: cache.payload.key, hwid: HWID }); }
      catch {}
    }
    clearCache();
    res.json({ ok: true });
  });

  // Manuel heartbeat tetikleyici (UI "yeniden doğrula" düğmesi için).
  app.post('/api/license/refresh', async (req, res) => {
    const r = await heartbeat();
    res.json(r);
  });

  // Gate middleware — bu noktadan sonraki tüm route'ları korur.
  app.use((req, res, next) => {
    const p = req.path;
    if (p === '/activate') return next();
    if (p.startsWith('/api/license/')) return next();
    // Aktivasyon sayfasının ihtiyaç duyduğu temel statik kaynaklar (ikon, fontlar) genelde yok;
    // sayfa kendi içinde inline CSS kullanıyor.
    if (isLicenseValid()) return next();
    if (p.startsWith('/api/')) {
      return res.status(403).json({ error: 'license_required', activateUrl: '/activate' });
    }
    return res.redirect('/activate');
  });

  // Server boot anında bir defa heartbeat + interval başlat.
  startHeartbeatLoop();
}

module.exports = {
  mountLicense,
  ensureLicenseOrExit,
  isLicenseValid,
  getStatus,
  activate,
  heartbeat,
  HWID,
  SERVER_URL,
  APP_ID,
};
