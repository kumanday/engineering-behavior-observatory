import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: process.env.CHANNEL ?? 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.argv[2]);
  assert.match(await page.title(), /EBO v2 Atlas/);
  const count = await page.locator('#units button').count(); assert.ok(count > 0);
  const first = page.locator('#units button').first(); await first.click();
  await page.locator('#detail').waitFor({ state: 'visible' });
  const detail = await page.locator('#content').innerText();
  assert.match(detail, /sha256:/); assert.match(detail, /nativeReference/); assert.match(detail, /durationMs/);
  await page.locator('#search').fill('a-query-with-no-matches'); assert.equal(await page.locator('#units button').count(), 0);
  await page.locator('#search').fill(''); assert.equal(await page.locator('#units button').count(), count);
  await page.locator('summary').click(); assert.match(await page.locator('#measures').innerText(), /coverage/);
  assert.equal(await page.evaluate(() => window.fixtureXss), undefined); assert.deepEqual(errors, []);
  if (process.argv[3]) await page.screenshot({ path: process.argv[3], fullPage: true });
  console.log(JSON.stringify({ passed: true, units: count, pointerDrilldown: true, searchRoundTrip: true, pageErrors: errors }));
} finally { await browser.close(); }
