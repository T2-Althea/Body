// Shared Playwright setup for the e2e scripts: opens SillyTavern, gets past the
// first-run persona prompt and connects to the fake backend.
const fs = require('fs');
const { chromium } = require('playwright');

async function openST(url, { viewport = { width: 1600, height: 900 } } = {}) {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport });
    const errors = [];
    const state = { loaded: false };
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.text().includes('[Body HUD] loaded')) state.loaded = true; });
    await page.goto(url);
    await page.waitForFunction(() => window.SillyTavern?.getContext?.(), null, { timeout: 60000 });
    await page.waitForTimeout(3000);
    const onboarding = page.locator('.popup:visible .popup-button-ok');
    if (await onboarding.count()) await onboarding.first().click();
    await page.waitForFunction(() => SillyTavern.getContext().characters.length > 0, null, { timeout: 30000 });
    await page.evaluate(() => $('#api_button_openai').trigger('click'));
    await page.waitForFunction(() => SillyTavern.getContext().onlineStatus !== 'no_connection', null, { timeout: 30000 });
    return { browser, page, errors, state };
}

function makeChecker() {
    const results = [];
    const check = (name, ok, detail = '') => {
        results.push({ name, ok: !!ok });
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    };
    const finish = () => {
        const failed = results.filter(r => !r.ok).length;
        console.log(`\n${results.length - failed}/${results.length} passed`);
        return failed ? 1 : 0;
    };
    return { check, finish };
}

const requestCount = log => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0);

async function sendMessage(page, log, text) {
    const before = requestCount(log);
    await page.fill('#send_textarea', text);
    await page.click('#send_but');
    for (let i = 0; i < 100 && requestCount(log) === before; i++) await page.waitForTimeout(200);
    await page.waitForFunction(() => !document.querySelector('#send_but')?.classList.contains('displayNone'), null, { timeout: 30000 });
    await page.waitForTimeout(500);
}

module.exports = { openST, makeChecker, requestCount, sendMessage };
