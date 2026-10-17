// M0 end-to-end check against a running SillyTavern + fake backend.
// Verifies: the extension loads, and how message.extra behaves across swipes
// (the injection checks from M0 now live in e2e-m2.cjs).
// Usage: node dev/e2e-m0.cjs <st-url> <fake-llm-request-log>
const fs = require('fs');
const { openST } = require('./st-page.cjs');

const url = process.argv[2] || 'http://127.0.0.1:8000/';
const reqLog = process.argv[3];

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
    const { browser, page, errors, state } = await openST(url);
    const loaded = state.loaded;
    check('extension loaded', loaded);
    check('settings panel rendered', await page.locator('#body_hud_enabled').count() === 1);

    // Open the bundled Seraphina character.
    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(1500);

    const send = async (text) => {
        const before = requestCount();
        await page.fill('#send_textarea', text);
        await page.click('#send_but');
        for (let i = 0; i < 100 && requestCount() === before; i++) await page.waitForTimeout(200);
        await page.waitForFunction(() => !document.querySelector('#send_but')?.classList.contains('displayNone'), null, { timeout: 30000 });
        await page.waitForTimeout(500);
    };
    const lastExtra = () => page.evaluate(() => { const c = SillyTavern.getContext().chat; const m = c[c.length - 1]; return { swipe: m.swipe_id ?? 0, stamp: m.extra?.body_hud_probe ?? null }; });

    // Need an AI reply to swipe.
    await send('Hello there.');

    // 4. message.extra across swipes.
    await page.evaluate(() => {
        const c = SillyTavern.getContext(); const m = c.chat[c.chat.length - 1];
        m.extra = m.extra || {}; m.extra.body_hud_probe = { swipe: m.swipe_id ?? 0, at: Date.now() };
    });
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
