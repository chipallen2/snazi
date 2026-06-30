// Screenshot harness for snazi UX review loop.
// Usage: node ux/shoot.mjs [outdir]
// Signs up a throwaway account, then screenshots public + authed pages.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { setTimeout as sleep } from 'timers/promises';

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.argv[2] || 'ux/shots';
mkdirSync(OUT, { recursive: true });

const stamp = Date.now();
const email = `uxtest+${stamp}@example.com`;
const password = 'TestPass123!';

const WIDTHS = [{ w: 1280, h: 900, tag: 'desktop' }, { w: 390, h: 844, tag: 'mobile' }];

async function shoot(page, name) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(400);
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log('shot', path);
}

const browser = await chromium.launch();
try {
  for (const vp of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();

    // Public pages
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await shoot(page, `home-${vp.tag}`);
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await shoot(page, `login-${vp.tag}`);
    await page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
    await shoot(page, `signup-${vp.tag}`);

    // Sign up (only once, on desktop ctx, to create the account)
    if (vp.tag === 'desktop') {
      await page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' });
      await page.fill('input[type=email], input[name=email]', email);
      await page.fill('input[type=password], input[name=password]', password);
      await page.click('button[type=submit]');
      await page.waitForLoadState('networkidle').catch(() => {});
      await sleep(800);
    } else {
      // log in on mobile ctx
      await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
      await page.fill('input[type=email], input[name=email]', email);
      await page.fill('input[type=password], input[name=password]', password);
      await page.click('button[type=submit]');
      await page.waitForLoadState('networkidle').catch(() => {});
      await sleep(800);
    }

    // Authed pages
    for (const [route, name] of [['/', 'dashboard'], ['/account', 'account'], ['/channels', 'channels']]) {
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
      await shoot(page, `${name}-${vp.tag}`);
    }
    await ctx.close();
  }
  console.log('DONE account:', email);
} finally {
  await browser.close();
}
