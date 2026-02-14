const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

const regionCache = new Map();
const CACHE_DURATION = 3600000; // 1 hour

async function scrapeOmarThing(username) {
  let browser;
  try {
    console.log(`[Puppeteer] Scraping omar-thing.site for: ${username}`);

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-software-rasterizer', '--disable-extensions',
        '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding', '--single-process', '--no-zygote'
      ],
      executablePath: (() => {
        if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
        if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
        // Auto-detect Render.com Puppeteer cache path
        const fs = require('fs');
        const path = require('path');
        const cacheDir = '/opt/render/.cache/puppeteer/chrome';
        if (fs.existsSync(cacheDir)) {
          const versions = fs.readdirSync(cacheDir);
          for (const ver of versions) {
            const p = path.join(cacheDir, ver, 'chrome-linux64', 'chrome');
            if (fs.existsSync(p)) { console.log('[Puppeteer] Chrome at:', p); return p; }
          }
        }
        return undefined;
      })()
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Block images/fonts to speed things up
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto('https://omar-thing.site/', { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('[Puppeteer] Page loaded');

    await page.waitForSelector('#usernameInput', { timeout: 10000 });
    await page.click('#usernameInput', { clickCount: 3 });
    await page.type('#usernameInput', username, { delay: 40 });
    console.log(`[Puppeteer] Typed username: ${username}`);

    await page.waitForSelector('#fetchButton', { timeout: 5000 });
    await page.click('#fetchButton');
    console.log('[Puppeteer] Clicked Fetch Data');

    // Poll up to 20s for results to appear
    let found = false;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      found = await page.evaluate(() => {
        const body = document.body.innerText;
        // Results have appeared if we see Region: with a real value
        if (/Region:\s*[A-Z]/.test(body)) return true;
        // Or if any nickname element has non-dash content
        const nick = document.querySelector('#resultNickname, .result-nickname');
        if (nick && nick.textContent.trim() && nick.textContent.trim() !== '-') return true;
        return false;
      });
      if (found) { console.log(`[Puppeteer] Results found after ${i+1}s`); break; }
      console.log(`[Puppeteer] Waiting... ${i+1}/20`);
    }

    await page.waitForTimeout(1000); // let dynamic content settle

    const data = await page.evaluate(() => {
      const bodyText = document.body.innerText;

      const getEl = (...sels) => {
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (el) { const t = el.textContent.trim(); if (t && t !== '-') return t; }
        }
        return null;
      };

      const reMatch = (pattern) => {
        const m = bodyText.match(pattern);
        return m ? m[1].trim() : null;
      };

      const nickname  = getEl('#resultNickname', '.result-nickname')   || reMatch(/Nickname[:\s]+([^\n]+)/i);
      const region    = getEl('#resultRegion',   '.result-region')     || reMatch(/Region:\s*([^\n]+)/i);
      const language  = getEl('#resultLanguage', '.result-language')   || reMatch(/Language:\s*([^\n]+)/i);
      const followers = getEl('#resultFollowers','.result-followers')  || reMatch(/Followers[:\s]+([0-9,KMB.]+)/i);
      const following = getEl('#resultFollowing','.result-following')  || reMatch(/Following[:\s]+([0-9,KMB.]+)/i);
      const likes     = getEl('#resultHearts','#resultLikes','.result-hearts') || reMatch(/(?:Hearts|Likes)[:\s]+([0-9,KMB.]+)/i);
      const userId    = getEl('#resultUserId','#resultID','.result-userid')    || reMatch(/User\s*ID[:\s]+([0-9]+)/i);

      // Parse "United States (US)" → { country, countryCode }
      let country = null, countryCode = null;
      if (region) {
        const m1 = region.match(/^(.+?)\s*\(([A-Z]{2})\)\s*$/);
        const m2 = region.match(/^([A-Z]{2})$/);
        if (m1) { country = m1[1].trim(); countryCode = m1[2]; }
        else if (m2) { countryCode = m2[1]; country = m2[1]; }
        else { country = region; }
      }

      return { nickname, region, country, countryCode, language, followers, following, likes, userId,
               hasData: !!(nickname && nickname !== '-') };
    });

    console.log('[Puppeteer] Extracted:', data);

    if (!data.hasData) {
      return { success: false, error: 'User not found or site returned no results', username, timestamp: new Date().toISOString() };
    }

    return {
      success: true, username,
      data: {
        nickname:    data.nickname    || 'N/A',
        country:     data.country     || 'Not available',
        countryCode: data.countryCode || '',
        region:      data.region      || 'Not available',
        language:    data.language    || 'Unknown',
        followers:   data.followers   || 'N/A',
        following:   data.following   || 'N/A',
        likes:       data.likes       || 'N/A',
        userId:      data.userId      || 'N/A'
      },
      timestamp: new Date().toISOString()
    };

  } catch (err) {
    console.error('[Puppeteer] Error:', err.message);
    return { success: false, error: err.message, username, timestamp: new Date().toISOString() };
  } finally {
    if (browser) { await browser.close(); console.log('[Puppeteer] Browser closed'); }
  }
}

// GET /api/user-region?username=USERNAME
app.get('/api/user-region', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ success: false, error: 'username parameter is required' });

  const clean = username.replace('@', '').trim();
  const cacheKey = `region_${clean}`;
  const cached = regionCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log(`[Cache] Hit for ${clean}`);
    return res.json(cached.data);
  }

  const result = await scrapeOmarThing(clean);
  if (result.success) regionCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return res.status(result.success ? 200 : 500).json(result);
});

// POST /api/batch-region  { usernames: ["a","b",...] }
app.post('/api/batch-region', async (req, res) => {
  const { usernames } = req.body;
  if (!usernames || !Array.isArray(usernames))
    return res.status(400).json({ success: false, error: 'usernames array is required' });
  if (usernames.length > 5)
    return res.status(400).json({ success: false, error: 'Maximum 5 usernames per batch' });

  const results = [];
  for (const u of usernames) results.push(await scrapeOmarThing(u.replace('@','').trim()));
  return res.json({ success: true, results });
});

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/', (_, res) => res.json({
  name: 'TikTok Analytics API', version: '2.0.0', source: 'omar-thing.site',
  endpoints: {
    'GET /api/user-region?username=USERNAME': 'Get region & profile data',
    'POST /api/batch-region': 'Batch lookup (max 5)',
    'GET /health': 'Health check'
  }
}));

app.listen(PORT, () => {
  console.log(`🚀 TikTok Analytics API running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
  console.log(`📊 API:    http://localhost:${PORT}/api/user-region?username=USERNAME`);
  console.log(`🌐 Source: omar-thing.site`);
});

process.on('SIGTERM', () => { console.log('SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { console.log('SIGINT');  process.exit(0); });
