const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const TEMPLATE_LISTING_ID = process.env.PINTEREST_TEMPLATE_LISTING_ID || '4484014869';
const DEBUG_PIN = process.env.DEBUG_PIN === '1';
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

async function debugShot(page, name) {
  if (!DEBUG_PIN) return;
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const file = path.join(SCREENSHOT_DIR, `pin-debug-${name}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  [pin][debug] screenshot: ${file}`);
  } catch (e) {
    console.warn(`  [pin][debug] screenshot fail: ${e.message}`);
  }
}

async function connectBrowser(port) {
  for (let i = 0; i < 15; i++) {
    try {
      return await chromium.connectOverCDP(`http://localhost:${port}`);
    } catch (e) {
      if (i < 14) await new Promise(r => setTimeout(r, 2000));
    }
  }
  return null;
}

// Multiple fallback selectors per element — Etsy UI cycles, biri eskirse digerleri devreye girer.
const ETSY_SEARCH_SELECTORS = [
  'input[data-test-id="search-input"]',
  'input[name="listing_search"]',
  'input[placeholder*="Search"]',
  'input[placeholder*="Ara"]',
  'input[aria-label*="Search"]',
  'input[aria-label*="Ara"]',
  'input[type="search"]',
  'input[name*="search"]',
];

const ETSY_LISTING_URLS = [
  'https://www.etsy.com/your/shops/me/tools/listings',
  'https://www.etsy.com/your/shops/me/listings',
  'https://www.etsy.com/your/shops/me/tools/listings/active',
];

async function findSearchInput(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of ETSY_SEARCH_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (el) return el;
      } catch {}
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function findListingBySKU(page, sku) {
  console.log(`  [pin] Listing manager arama: SKU=${sku}`);

  let opened = false;
  for (const url of ETSY_LISTING_URLS) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      opened = true;
      break;
    } catch (e) {
      console.warn(`  [pin] Listing manager URL fail (${url}): ${e.message}`);
    }
  }
  if (!opened) {
    console.error('  [pin] Etsy listing manager hicbir URL ile acilamadi');
    return null;
  }
  await page.waitForTimeout(5000);
  await debugShot(page, 'listing-manager');

  const searchInput = await findSearchInput(page, 8000);
  if (!searchInput) {
    console.error('  [pin] Etsy listing manager search input bulunamadi');
    await debugShot(page, 'no-search');
    return null;
  }

  try {
    await searchInput.scrollIntoViewIfNeeded();
  } catch {}

  await page.evaluate((el, val) => {
    el.focus();
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, searchInput, sku);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);
  await debugShot(page, 'search-results');

  const listingId = await page.evaluate((tmplId) => {
    const links = document.querySelectorAll('a[href*="/listing/"]');
    for (const link of links) {
      const m = link.href.match(/\/listing\/(\d{8,})/);
      if (m && m[1] !== tmplId) return m[1];
    }
    return '';
  }, TEMPLATE_LISTING_ID);

  if (listingId) {
    const url = `https://www.etsy.com/listing/${listingId}`;
    console.log(`  [pin] Listing bulundu: ${url}`);
    return url;
  }

  console.error(`  [pin] SKU ${sku} icin listing bulunamadi`);
  return null;
}

const PIN_SAVE_SELECTORS_FN = `
  function findPinterestShare() {
    const links = document.querySelectorAll('a[href*="pinterest"], button[data-network="pinterest"], a[data-network="pinterest"], a[data-action="share"]');
    for (const el of links) {
      const href = (el.getAttribute('href') || '').toLowerCase();
      const netAttr = (el.getAttribute('data-network') || '').toLowerCase();
      if (netAttr === 'pinterest') return el;
      if (href.includes('pinterest.com') || href.includes('/share?network=_pinterest') || href.includes('pinterest_share')) {
        return el;
      }
    }
    return null;
  }
`;

async function clickPinterestShare(page) {
  const saveClicked = await page.evaluate(`
    ${PIN_SAVE_SELECTORS_FN}
    (function() {
      const el = findPinterestShare();
      if (!el) return null;
      el.click();
      return 'click';
    })()
  `);
  return saveClicked === 'click';
}

const PIN_RED_RGBS = ['rgb(230, 0, 35)', 'rgb(203, 30, 39)', 'rgb(189, 8, 28)', 'rgb(229, 0, 35)'];

async function findKaydet(pinPage) {
  return pinPage.evaluate((reds) => {
    const els = document.querySelectorAll('button, div, span, a');
    for (const el of els) {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundColor;
      const rect = el.getBoundingClientRect();
      if (reds.includes(bg) && rect.width > 30 && rect.width < 240 && rect.height > 18 && rect.height < 70) {
        const text = (el.innerText || '').toLowerCase().trim();
        if (!text || text.includes('kaydet') || text.includes('save')) {
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
    }
    return null;
  }, PIN_RED_RGBS);
}

async function pinToPinterest({ sku }) {
  if (!sku) throw new Error('SKU verilmedi, pin iptal');

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const port = config.cdpPort || 9333;

  console.log('  [pin] Browser CDP baglanti...');
  const browser = await connectBrowser(port);
  if (!browser) throw new Error('CDP browser baglantisi yapilamadi');

  const context = browser.contexts()[0];

  let page;
  try {
    page = await context.newPage();
  } catch (e) {
    page = context.pages()[0];
    if (!page) throw new Error('Browser page acilamadi');
  }

  page.on('dialog', async dialog => {
    try { await dialog.accept(); } catch {}
  });

  try {
    const listingUrl = await findListingBySKU(page, sku);
    if (!listingUrl) {
      throw new Error(`SKU ${sku} icin Etsy listing bulunamadi, pin iptal`);
    }

    console.log(`  [pin] Listing aciliyor: ${listingUrl}`);
    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    await debugShot(page, 'listing-page');

    console.log(`  [pin] Pinterest Save butonu araniyor...`);
    let clicked = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      clicked = await clickPinterestShare(page);
      if (clicked) break;
      await page.waitForTimeout(2000);
    }
    if (!clicked) {
      await debugShot(page, 'no-pin-button');
      throw new Error('Etsy listing sayfasinda Pinterest Save butonu bulunamadi');
    }
    console.log('  [pin] Pinterest Save tiklandi');

    console.log('  [pin] Pinterest popup bekleniyor...');
    let popup = null;
    try {
      popup = await page.waitForEvent('popup', { timeout: 12000 });
      console.log(`  [pin] Popup acildi: ${popup.url()}`);
      await popup.waitForLoadState('domcontentloaded');
      await popup.waitForTimeout(4000);
    } catch (e) {
      console.log('  [pin] Popup yok, ayni sayfada modal aranacak');
    }

    const pinPage = popup || page;
    await debugShot(pinPage, 'pin-popup');

    console.log('  [pin] Pinterest board ve Kaydet aranacak...');
    await pinPage.waitForTimeout(3000);

    const boardPos = await pinPage.evaluate(() => {
      const items = document.querySelectorAll('[data-test-id="board-row"], [data-test-id="boardWithoutSection"], [data-test-id="board-picker-row"], [role="listitem"]');
      for (const item of items) {
        const rect = item.getBoundingClientRect();
        if (rect.width > 60 && rect.height > 20) {
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
      return null;
    });

    if (boardPos) {
      await pinPage.mouse.move(boardPos.x, boardPos.y);
      await pinPage.waitForTimeout(1200);
    }

    let kaydetPos = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      kaydetPos = await findKaydet(pinPage);
      if (kaydetPos) break;
      if (boardPos) await pinPage.mouse.move(boardPos.x, boardPos.y);
      await pinPage.waitForTimeout(1500);
    }

    if (!kaydetPos) {
      await debugShot(pinPage, 'no-kaydet');
      throw new Error('Pinterest popup icinde Kaydet butonu bulunamadi');
    }

    console.log('  [pin] Kaydet tiklandi');
    await pinPage.mouse.click(kaydetPos.x, kaydetPos.y);

    let confirmed = false;
    for (let wait = 0; wait < 20; wait++) {
      await pinPage.waitForTimeout(1000);
      confirmed = await pinPage.evaluate(() => {
        const text = document.body?.innerText || '';
        return /kaydedildi|kaydettiniz|panosuna|saved to|pinned/i.test(text);
      });
      if (confirmed) break;
    }

    if (confirmed) {
      console.log('  [pin] Pinterest pin kaydedildi');
    } else {
      console.warn('  [pin] Onay mesaji alinamadi, pin durumu belirsiz');
      await debugShot(pinPage, 'no-confirm');
    }

    if (popup) {
      try { await popup.close(); } catch {}
    }

    return { confirmed, listingUrl };
  } finally {
    try { await page.close(); } catch {}
  }
}

module.exports = { pinToPinterest };
