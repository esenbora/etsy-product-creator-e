const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DEBUG_PIN = process.env.DEBUG_PIN === '1';
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

async function debugShot(page, name) {
  if (!DEBUG_PIN) return;
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const file = path.join(SCREENSHOT_DIR, `pin-cookie-debug-${name}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  [pinterest-cookie][debug] screenshot: ${file}`);
  } catch (e) {
    console.warn(`  [pinterest-cookie][debug] screenshot fail: ${e.message}`);
  }
}

const TITLE_SELECTORS = [
  '[data-test-id="pin-draft-title"] textarea',
  '[data-test-id="pin-draft-title"] input',
  'textarea[placeholder*="title" i]',
  'textarea[placeholder*="baslik" i]',
  '[aria-label*="title" i] textarea',
  '[aria-label*="title" i]',
  'textarea[name*="title"]',
];

const DESC_SELECTORS = [
  '[data-test-id="pin-draft-description"] textarea',
  'textarea[placeholder*="description" i]',
  'textarea[placeholder*="aciklama" i]',
  '[aria-label*="description" i] textarea',
  '[aria-label*="description" i]',
  'textarea[name*="description"]',
];

const LINK_SELECTORS = [
  '[data-test-id="pin-draft-link"] input',
  'input[placeholder*="link" i]',
  'input[placeholder*="url" i]',
  'input[placeholder*="baglanti" i]',
  'input[aria-label*="link" i]',
  'input[type="url"]',
  'input[name*="link"]',
];

const PIN_CREATE_URLS = [
  'https://www.pinterest.com/pin-creation-tool/',
  'https://www.pinterest.com/pin-builder/',
  'https://tr.pinterest.com/pin-creation-tool/',
];

async function findFirstMatch(page, selectors, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) return { el, sel };
      } catch {}
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function pinToPinterestWithCookies({ listingUrl, mockupPath, title, description, pinterestCookies }) {
  if (!pinterestCookies) {
    throw new Error('Pinterest cookie\'leri bulunamadi, Ayarlardan Pinterest hesabini bagla');
  }

  let cookieArray;
  try {
    cookieArray = JSON.parse(pinterestCookies);
  } catch {
    throw new Error('Pinterest cookie format hatali (JSON parse fail)');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const pinterestCookiesFormatted = cookieArray.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '.pinterest.com',
    path: c.path || '/',
    httpOnly: c.httpOnly || false,
    secure: c.secure !== undefined ? c.secure : true,
    sameSite: c.sameSite || 'Lax',
  }));
  await context.addCookies(pinterestCookiesFormatted);

  const page = await context.newPage();

  try {
    console.log(`  [pinterest-cookie] Pin olusturuluyor...`);

    let opened = false;
    for (const url of PIN_CREATE_URLS) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        opened = true;
        break;
      } catch (e) {
        console.warn(`  [pinterest-cookie] URL fail (${url}): ${e.message}`);
      }
    }
    if (!opened) throw new Error('Pinterest pin-creation sayfasi acilamadi');

    await page.waitForTimeout(4000);
    await debugShot(page, 'page-loaded');

    const url = page.url();
    if (url.includes('/login') || url.includes('/signup')) {
      await debugShot(page, 'login-redirect');
      throw new Error('Pinterest oturumu gecersiz, cookie\'leri yenile');
    }

    if (mockupPath && fs.existsSync(mockupPath)) {
      console.log(`  [pinterest-cookie] Gorsel yukleniyor: ${path.basename(mockupPath)}`);
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.setInputFiles(mockupPath);
        await page.waitForTimeout(5000);
        await debugShot(page, 'after-upload');
      } else {
        console.warn('  [pinterest-cookie] Dosya upload input bulunamadi');
        await debugShot(page, 'no-file-input');
      }
    }

    const titleMatch = await findFirstMatch(page, TITLE_SELECTORS, 8000);
    if (titleMatch) {
      try { await titleMatch.el.fill(title || ''); } catch (e) { console.warn(`  [pinterest-cookie] Baslik yazilamadi: ${e.message}`); }
      await page.waitForTimeout(400);
    } else {
      console.warn('  [pinterest-cookie] Baslik alani bulunamadi');
    }

    const descMatch = await findFirstMatch(page, DESC_SELECTORS, 6000);
    if (descMatch) {
      try { await descMatch.el.fill(description || ''); } catch (e) { console.warn(`  [pinterest-cookie] Aciklama yazilamadi: ${e.message}`); }
      await page.waitForTimeout(400);
    } else {
      console.warn('  [pinterest-cookie] Aciklama alani bulunamadi');
    }

    if (listingUrl) {
      const linkMatch = await findFirstMatch(page, LINK_SELECTORS, 6000);
      if (linkMatch) {
        try { await linkMatch.el.fill(listingUrl); } catch (e) { console.warn(`  [pinterest-cookie] Link yazilamadi: ${e.message}`); }
        await page.waitForTimeout(400);
      } else {
        console.warn('  [pinterest-cookie] Link alani bulunamadi');
      }
    }

    await debugShot(page, 'final-state');
    console.log(`  [pinterest-cookie] Pin draft olusturuldu`);
    return { success: true };
  } finally {
    try { await browser.close(); } catch {}
  }
}

module.exports = { pinToPinterestWithCookies };
