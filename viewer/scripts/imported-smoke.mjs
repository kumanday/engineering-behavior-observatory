// Browser regression for an imported Atlas with an unavailable task identity and partial outcomes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: process.env.CHANNEL ?? 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:13013/');
  await page.waitForFunction(() => document.body.dataset.eboReady === '1', null, { timeout: 60_000 }).catch(async (error) => { console.error(JSON.stringify({ pageErrors: errors, body: (await page.locator('body').innerText()).slice(0,4000) })); throw error; });
  await page.evaluate(() => window.ebo.run('openTab', { tab: 'lanes' }));
  await page.evaluate(() => window.ebo.run('setLaneTask', { task: null }));
  const lanes = await page.evaluate(async () => (await window.ebo.describe()).lanes.data);
  assert.ok(lanes.lanes.length); assert.equal(lanes.task, null);
  await page.evaluate(() => window.ebo.run('setLaneMode', { mode: 'totals' }));
  const totals = await page.locator('.totals').innerText();
  assert.match(totals, /Imported evidence/); assert.match(totals, /unavailable/);
  assert.doesNotMatch(totals, /No failed tool calls on this task/);
  await page.evaluate((attemptId) => window.ebo.run('openAudit', { attemptId }), lanes.lanes[0].attemptId);
  assert.match(await page.locator('body').innerText(), /freshness is unavailable|coverage unavailable/);
  const state = await page.evaluate(() => window.ebo.encodeState(window.ebo.getState()));
  await page.goto(`${(process.argv[2] ?? 'http://127.0.0.1:13013/').replace(/#.*$/, '')}#state=${state}`);
  await page.reload(); await page.waitForFunction(() => document.body.dataset.eboReady === '1', null, { timeout: 60_000 });
  assert.equal(await page.evaluate(() => window.ebo.getState().lanes.task), null);
  assert.deepEqual(errors, []);
  if (process.argv[3]) await page.screenshot({ path: process.argv[3], fullPage: true });
  console.log(JSON.stringify({ passed: true, importedAttempts: lanes.lanes.length, pageErrors: errors }));
} finally { await browser.close(); }
