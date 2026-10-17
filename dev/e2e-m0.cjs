// M0 end-to-end check against a running SillyTavern + fake backend.
// Verifies: the extension loads; the probe note reaches the outgoing prompt and
// disappears when turned off; and how message.extra behaves across swipes.
// Usage: node dev/e2e-m0.cjs <st-url> <fake-llm-request-log>
const fs = require('fs');
const { chromium } = require('playwright');

const url = process.argv[2] || 'http://127.0.0.1:8000/';
const reqLog = process.argv[3];
const PROBE = 'Body HUD probe';

const lastRequest = () => {
    const lines = fs.readFileSync(reqLog, 'utf8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
};
const requestCount = () => (fs.existsSync(reqLog) ? fs.readFileSync(reqLog, 'utf8').trim().split('\n').filter(Boolean).length : 0);
const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    let loaded = false;
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.text().includes('[Body HUD] loaded')) loaded = true; });

    await page.goto(url);
    await page.waitForFunction(() => window.SillyTavern?.getContext?.(), null, { timeout: 60000 });
    await page.waitForTimeout(3000);
    // Fresh installs show a first-run persona prompt; accept the default name.
    const onboarding = page.locator('.popup:visible .popup-button-ok');
    if (await onboarding.count()) await onboarding.first().click();
    await page.waitForFunction(() => SillyTavern.getContext().characters.length > 0, null, { timeout: 30000 });
    // Connect to the fake backend configured by dev/configure-st.cjs.
    await page.evaluate(() => $('#api_button_openai').trigger('click'));
    await page.waitForFunction(() => SillyTavern.getContext().onlineStatus !== 'no_connection', null, { timeout: 30000 });
    check('extension loaded', loaded);
    check('settings panel rendered', await page.locator('#body_hud_enabled').count() === 1);

    // Open the bundled Seraphina character.
    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);

    const send = async (text) => {
        const before = requestCount();
        await page.fill('#send_textarea', text);
        await page.click('#send_but');
        for (let i = 0; i < 100 && requestCount() === before; i++) await page.waitForTimeout(200);
        await page.waitForFunction(() => !document.querySelector('#send_but')?.classList.contains('displayNone'), null, { timeout: 30000 });
        await page.waitForTimeout(500);
    };
    const setProbe = on => page.evaluate(v => { const el = document.querySelector('#body_hud_probe'); el.checked = v; el.dispatchEvent(new Event('change')); }, on);
    const slash = cmd => page.evaluate(c => SillyTavern.getContext().executeSlashCommandsWithOptions(c), cmd);
    const lastExtra = () => page.evaluate(() => { const c = SillyTavern.getContext().chat; const m = c[c.length - 1]; return { swipe: m.swipe_id ?? 0, stamp: m.extra?.body_hud_probe ?? null }; });

    // 1. Injection on.
    await setProbe(true);
    await send('Hello there.');
    const withProbe = JSON.stringify(lastRequest().messages);
    check('probe note is in the prompt when enabled', withProbe.includes(PROBE));
    check('probe note appears exactly once', withProbe.split(PROBE).length - 1 === 1);

    // 2. Second message: still exactly one copy (no pile-up).
    await send('How are you?');
    const second = JSON.stringify(lastRequest().messages);
    check('no pile-up after another reply', second.split(PROBE).length - 1 === 1);

    // 3. Injection off.
    await setProbe(false);
    await send('Okay.');
    check('probe note gone when disabled', !JSON.stringify(lastRequest().messages).includes(PROBE));

    // 4. message.extra across swipes.
    await slash('/bodyhud-stamp');
    const stamped = await lastExtra();
    check('stamp stored on last message', stamped.stamp !== null, JSON.stringify(stamped));

    const before = requestCount();
    await page.locator('#chat .last_mes .swipe_right').first().click();
    for (let i = 0; i < 100 && requestCount() === before; i++) await page.waitForTimeout(200);
    await page.waitForTimeout(1500);
    const afterRegen = await lastExtra();
    console.log('      after regenerating a new swipe:', JSON.stringify(afterRegen));
    check('regenerated swipe INHERITS the old stamp (SillyTavern does not clear extension data)', afterRegen.swipe === 1 && afterRegen.stamp !== null);

    await page.locator('#chat .last_mes .swipe_left').first().click();
    await page.waitForTimeout(1000);
    const back = await lastExtra();
    check('swiping back restores swipe 0 with its stamp', back.swipe === 0 && back.stamp?.swipe === 0, JSON.stringify(back));

    const ours = errors.filter(e => /body|hud/i.test(e));
    check('no page errors from the extension', ours.length === 0, ours.join(' | '));
    if (errors.length) console.log('      (all page errors:', errors.join(' | '), ')');

    await page.screenshot({ path: process.env.SHOT || 'e2e-m0.png' });
    await browser.close();
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
