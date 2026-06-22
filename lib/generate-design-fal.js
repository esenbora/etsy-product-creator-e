// fal.ai image-to-image design generator.
// Default: fal-ai/flux/dev/image-to-image. Env: FAL_MODEL override.
// Akis: ref image -> data URL -> POST fal.run -> result URL -> download -> save.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { fetchWithRetry } = require('./fetch-retry');

const DESIGNS_DIR = path.join(__dirname, '..', 'designs');
const DEFAULT_MODEL = process.env.FAL_MODEL || 'fal-ai/flux/dev/image-to-image';
const FAL_BASE = 'https://fal.run';

async function generateDesignFal(refImagePath, sku, prompt, overrideApiKey) {
  const apiKey = overrideApiKey || process.env.FAL_API_KEY;
  if (!apiKey || apiKey === 'your_key_here') {
    throw new Error('FAL_API_KEY not set');
  }

  const refAbsPath = path.resolve(refImagePath);
  if (!fs.existsSync(refAbsPath)) {
    throw new Error(`Reference image not found: ${refAbsPath}`);
  }
  const imageData = fs.readFileSync(refAbsPath);
  const base64Image = imageData.toString('base64');
  const ext = path.extname(refAbsPath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const dataUrl = `data:${mimeType};base64,${base64Image}`;

  const defaultPrompt = 'Recreate the same design style, colors, and composition as the reference image. Make it unique enough to be a new product but visually consistent. Output only the design image.';
  const finalPrompt = prompt || defaultPrompt;

  console.log(`  [fal.ai] Generating design for SKU: ${sku} (model: ${DEFAULT_MODEL})...`);

  const url = `${FAL_BASE}/${DEFAULT_MODEL}`;
  const body = {
    image_url: dataUrl,
    prompt: finalPrompt,
    strength: 0.6,
    num_images: 1,
    enable_safety_checker: false,
  };

  // fal image-to-image yogun kuyrukta 20-50sn surebilir -> 120sn timeout (default 30sn yetersiz, abort+retry dongu fail)
  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, 3, 120000);

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`fal.ai HTTP ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await response.json();

  const images = Array.isArray(data.images) ? data.images : (data.image ? [data.image] : []);
  if (!images.length) {
    throw new Error('fal.ai response: no images. ' + JSON.stringify(data).slice(0, 300));
  }

  const first = images[0];
  const imgUrl = first.url || first;
  if (!imgUrl) {
    throw new Error('fal.ai response: image URL eksik. ' + JSON.stringify(first).slice(0, 200));
  }

  // CDN yavassa/yanitsizsa sonsuz asili kalmasin -> 60sn AbortController
  const dlCtrl = new AbortController();
  const dlTimer = setTimeout(() => dlCtrl.abort(), 60000);
  let imgResp;
  try {
    imgResp = await fetch(imgUrl, { signal: dlCtrl.signal });
  } catch (err) {
    throw new Error(`fal.ai image download fail: ${err.name === 'AbortError' ? 'timeout (60sn)' : err.message}`);
  } finally {
    clearTimeout(dlTimer);
  }
  if (!imgResp.ok) {
    throw new Error(`fal.ai image download HTTP ${imgResp.status}`);
  }
  const imgBuffer = Buffer.from(await imgResp.arrayBuffer());

  fs.mkdirSync(DESIGNS_DIR, { recursive: true });
  const outputPath = path.join(DESIGNS_DIR, `${sku}_design.png`);
  fs.writeFileSync(outputPath, imgBuffer);
  console.log(`  [fal.ai] Design saved: ${outputPath}`);
  return outputPath;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const refIdx = args.indexOf('--ref');
  const skuIdx = args.indexOf('--sku');
  const promptIdx = args.indexOf('--prompt');

  if (refIdx === -1) {
    console.error('Usage: node generate-design-fal.js --ref <image> [--sku <sku>] [--prompt <text>]');
    process.exit(1);
  }

  const ref = args[refIdx + 1];
  const sku = skuIdx !== -1 ? args[skuIdx + 1] : 'test';
  const prompt = promptIdx !== -1 ? args[promptIdx + 1] : undefined;

  generateDesignFal(ref, sku, prompt).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

module.exports = { generateDesignFal };
