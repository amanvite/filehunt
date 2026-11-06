const path = require('path');
const os = require('os');
const fs = require('fs');

// detect serverless environment so I never write outside /tmp on Vercel
const IS_VERCEL = Boolean(process.env.VERCEL || process.env.NOW_REGION || process.env.AWS_LAMBDA_FUNCTION_NAME);
const PORT = Number(process.env.PORT) || 3000;

const TEMP_DIR = IS_VERCEL
  ? path.join(os.tmpdir(), 'filehunt_temp')
  : path.join(process.cwd(), 'temp');

try {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
} catch {}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// universal age-verification cookies so adult sites don't block the scraper with an 18+ splash page
const DEFAULT_AGE_COOKIES =
  'age_verified=1; over18=1; splash=1; disclaimer=1; verified=1; consented=1; kt_tcookie=1; platform=pc; accessAgeDisclaimerPH=1; expiredEnterModalShown=1';

// standard video heights I normalize extracted streams into
const STANDARD_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240, 144];

module.exports = {
  IS_VERCEL,
  PORT,
  TEMP_DIR,
  BROWSER_UA,
  DEFAULT_AGE_COOKIES,
  STANDARD_HEIGHTS
};