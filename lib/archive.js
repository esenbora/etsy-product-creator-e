const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const ARCHIVE_ROOT = path.join(ROOT, 'archive');
const MANIFEST_PATH = path.join(ARCHIVE_ROOT, 'index.json');
const LOCK_PATH = path.join(ARCHIVE_ROOT, 'index.lock');
function ensureArchiveRoot() {
  try {
    fs.mkdirSync(ARCHIVE_ROOT, { recursive: true });
    return ARCHIVE_ROOT;
  } catch {
    throw new Error('Arsiv klasor olusturulamadi');
  }
}
function readManifest() {
  ensureArchiveRoot();
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function writeManifest(entries) {
  if (!Array.isArray(entries)) throw new Error('Manifest verisi gecersiz');
  ensureArchiveRoot();
  const tmpPath = `${MANIFEST_PATH}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2));
    fs.renameSync(tmpPath, MANIFEST_PATH);
  } catch {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    throw new Error('Manifest yazilamadi');
  }
}
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function withManifestLock(fn) {
  ensureArchiveRoot();
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      try { return fn(); }
      finally {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(LOCK_PATH); } catch {}
      }
    } catch (err) {
      if (err.code !== 'EEXIST' || Date.now() - start > 5000) {
        throw err.code === 'EEXIST' ? new Error('Manifest kilidi alinamadi') : err;
      }
      sleepSync(25);
    }
  }
}
function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0'); return [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join('-');
}
function sanitizeSegment(value, fallback) {
  const raw = String(value || '').trim();
  const safe = path.basename(raw).replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || fallback;
}
function assertSafeSegment(value) {
  const safe = sanitizeSegment(value, '');
  if (!safe || safe !== String(value || '').trim()) {
    throw new Error('Arsiv yolu gecersiz');
  }
  return safe;
}
function isInside(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  return target === base || target.startsWith(base + path.sep);
}
function resolveSourcePath(sourcePath) {
  if (!sourcePath || typeof sourcePath !== 'string') return null;
  if (path.isAbsolute(sourcePath)) return path.resolve(sourcePath);
  const cleaned = sourcePath.replace(/^\/+/, '');
  return path.resolve(ROOT, cleaned);
}
function sourceKey(absPath) { return crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16); }
function normalizeMeta(meta) {
  const src = meta && typeof meta === 'object' ? meta : {};
  return {
    title: typeof src.title === 'string' ? src.title : '',
    tags: Array.isArray(src.tags) ? src.tags.filter(t => typeof t === 'string') : [],
    etsyListingId: src.etsyListingId || src.listingUrl || null,
    pinterestPinId: src.pinterestPinId || null,
    productType: src.productType || null,
  };
}
function fileRecord(archivePath, name, key) {
  let size = 0; try { size = fs.statSync(archivePath).size; } catch {}
  return { name, path: path.relative(ARCHIVE_ROOT, archivePath), size, sourceKey: key };
}
function archiveJob({ sku, sourcePaths, meta }) {
  return withManifestLock(() => {
    const now = new Date();
    const date = localDate(now);
    const safeSku = sanitizeSegment(sku, `SKU${Date.now()}`);
    const targetDir = path.join(ARCHIVE_ROOT, date, safeSku);
    try { fs.mkdirSync(targetDir, { recursive: true }); }
    catch { throw new Error('Arsiv hedefi olusturulamadi'); }
    const manifest = readManifest();
    const id = `${date}/${safeSku}`;
    const existingIndex = manifest.findIndex(entry => entry && entry.id === id);
    const existing = existingIndex >= 0 ? manifest[existingIndex] : null;
    const records = new Map((existing?.files || []).map(f => [f.name, f]));
    const sources = Array.isArray(sourcePaths) ? sourcePaths : [];
    for (const source of sources) {
      const absSource = resolveSourcePath(source);
      if (!absSource || !fs.existsSync(absSource)) continue;
      const key = sourceKey(absSource);
      const baseName = sanitizeSegment(path.basename(absSource), `file-${records.size + 1}`);
      const existingRecord = Array.from(records.values()).find(f => f.sourceKey === key);
      let name = existingRecord ? existingRecord.name : baseName;
      if (!existingRecord && records.has(name) && records.get(name).sourceKey !== key) {
        const ext = path.extname(baseName);
        const stem = path.basename(baseName, ext);
        let i = 2;
        while (records.has(`${stem}-${i}${ext}`)) i++;
        name = `${stem}-${i}${ext}`;
      }
      const dest = path.join(targetDir, name);
      if (!isInside(targetDir, dest)) throw new Error('Arsiv yolu gecersiz');
      try {
        fs.copyFileSync(absSource, dest);
        records.set(name, fileRecord(dest, name, key));
      } catch {
        throw new Error('Dosya arsive kopyalanamadi');
      }
    }
    if (records.size === 0) throw new Error('Arsivlenecek dosya bulunamadi');
    const entry = {
      id,
      date,
      sku: safeSku,
      originalSku: String(sku || safeSku),
      createdAt: existing?.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
      meta: normalizeMeta({ ...(existing?.meta || {}), ...(meta || {}) }),
      files: Array.from(records.values()).sort((a, b) => a.name.localeCompare(b.name)),
    };
    if (existingIndex >= 0) manifest[existingIndex] = entry;
    else manifest.push(entry);
    writeManifest(manifest);
    return entry;
  });
}
function entryMatches(entry, search) {
  if (!search) return true;
  const q = String(search).toLowerCase();
  const haystack = [entry.sku, entry.originalSku, entry.meta?.title, entry.meta?.productType, ...(entry.meta?.tags || [])]
    .filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q);
}
async function listArchive({ limit, offset, dateFrom, dateTo, search } = {}) {
  const max = Math.max(1, Math.min(parseInt(limit || '50', 10) || 50, 200));
  const start = Math.max(0, parseInt(offset || '0', 10) || 0);
  const rows = readManifest()
    .filter(entry => !dateFrom || entry.date >= dateFrom)
    .filter(entry => !dateTo || entry.date <= dateTo)
    .filter(entry => entryMatches(entry, search))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return { total: rows.length, length: rows.length, limit: max, offset: start, items: rows.slice(start, start + max) };
}
function listEntryFiles(date, sku, files) {
  const safeDate = assertSafeSegment(date);
  const safeSku = assertSafeSegment(sku);
  const dir = path.join(ARCHIVE_ROOT, safeDate, safeSku);
  if (!isInside(ARCHIVE_ROOT, dir) || !fs.existsSync(dir)) return [];
  return (Array.isArray(files) ? files : [])
    .map(file => path.resolve(ARCHIVE_ROOT, file.path || path.join(safeDate, safeSku, file.name || '')))
    .filter(abs => isInside(dir, abs));
}
function getArchiveEntry(date, sku) {
  ensureArchiveRoot();
  const safeDate = assertSafeSegment(date);
  const safeSku = assertSafeSegment(sku);
  const entry = readManifest().find(item => item && item.date === safeDate && item.sku === safeSku);
  if (!entry) return null;
  return { ...entry, files: listEntryFiles(safeDate, safeSku, entry.files) };
}
function deleteArchiveEntry(date, sku) {
  return withManifestLock(() => {
    const safeDate = assertSafeSegment(date);
    const safeSku = assertSafeSegment(sku);
    const dir = path.join(ARCHIVE_ROOT, safeDate, safeSku);
    if (!isInside(ARCHIVE_ROOT, dir)) throw new Error('Arsiv yolu gecersiz');
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch { throw new Error('Arsiv silinemedi'); }
    const next = readManifest().filter(entry => !(entry && entry.date === safeDate && entry.sku === safeSku));
    writeManifest(next);
    return { ok: true };
  });
}
module.exports = { ensureArchiveRoot, archiveJob, readManifest, writeManifest, listArchive, getArchiveEntry, deleteArchiveEntry, ARCHIVE_ROOT };
