// Provider switch wrapper.
// Default: fal.ai. Env IMAGE_PROVIDER=openrouter ile geri don.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const provider = (process.env.IMAGE_PROVIDER || 'fal').toLowerCase();

let impl;
if (provider === 'openrouter') {
  const { generateDesignOpenRouter } = require('./generate-design-openrouter');
  impl = generateDesignOpenRouter;
} else {
  const { generateDesignFal } = require('./generate-design-fal');
  impl = generateDesignFal;
}

async function generateDesign(refImagePath, sku, prompt, overrideApiKey) {
  return impl(refImagePath, sku, prompt, overrideApiKey);
}

module.exports = { generateDesign, provider };
