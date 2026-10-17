// M2 end-to-end check: the status note in real outgoing requests.
// Usage: node dev/e2e-m2.cjs <st-url> <fake-llm-request-log> [screenshot-dir]
const fs = require('fs');
const path = require('path');
const { openST, makeChecker, sendMessage, requestCount } = require('./st-page.cjs');

const url = process.argv[2] || 'http://127.0.0.1:8000/';
const reqLog = process.argv[3];
const shots = process.argv[4] || '.';
const HEADER = '[Body status — in effect right now]';
const { check, finish } = makeChecker();

const lastMessages = () => {
    const lines = fs.readFileSync(reqLog, 'utf8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]).messages;
};
const noteCount = msgs => JSON.stringify(msgs).split('Body status').length - 1;
const noteIndex = msgs => msgs.findIndex(m => String(m.content).startsWith(HEADER));

(async () => {
    const { browser, page, errors, state } = await openST(url);
    check('extension loaded', state.loaded);
    const panelText = () => page.locator('#body_hud_panel .bh-content').innerText();
    const setSetting = (sel, value) => page.evaluate(([s, v]) => {
        const el = document.querySelector(s);
        if (el.type === 'checkbox') el.checked = v; else el.value = String(v);
        el.dispatchEvent(new Event('change'));
    }, [sel, value]);
    const send = text => sendMessage(page, reqLog, text);

    await page.evaluate(() => { const s = SillyTavern.getContext().extensionSettings.body_hud; s.notePreviewOpen = true; });
    await setSetting('#body_hud_side', 'right');
    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(1500);
    if (!(await page.locator('#body_hud_panel').isVisible())) await page.click('#body_hud_tab');

    // Healthy: nothing sent.
    await send('Hello.');
    check('healthy scene sends no note', noteCount(lastMessages()) === 0);
    check('preview says nothing is sent', (await panelText()).includes('no note is sent'));

    // Add a wound.
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();
    await page.click('[data-act="add"]');
    await page.click('.bh-cat[data-cat="body"]');
    await page.selectOption('#bh_f_part', 'left_thigh');
    await page.fill('#bh_f_type', 'Arrow wound');
    await page.selectOption('#bh_f_sev', 'moderate');
    await page.selectOption('#bh_f_bleed', 'moderate');
    await page.fill('#bh_f_details', 'Arrowhead still in');
    await page.fill('#bh_f_effect', "Can't run; limps");
    await page.click('[data-act="save"]');
    await page.waitForTimeout(300);
    const preview = await page.locator('.bh-note-text').innerText();
    check('preview shows the note', preview.includes(HEADER) && preview.includes("Left thigh: arrow wound, moderate, arrowhead still in, moderate bleeding, untreated. Can't run; limps."), preview);

    await send('Are you hurt?');
    let msgs = lastMessages();
    check('note is sent once', noteCount(msgs) === 1);
    const ni = noteIndex(msgs);
    check('note sits just above the newest message, as system', ni === msgs.length - 2 && msgs[ni].role === 'system' && msgs[msgs.length - 1].content.includes('Are you hurt?'),
        msgs.slice(-3).map(m => m.role + ': ' + String(m.content).slice(0, 40)).join(' | '));
    check('sent text matches the preview exactly', msgs[ni]?.content === preview);

    await send('Let me look.');
    check('no pile-up on the next reply', noteCount(lastMessages()) === 1);

    // Regenerating (swipe) also carries the note.
    const before = requestCount(reqLog);
    await page.locator('#chat .last_mes .swipe_right').first().click();
    for (let i = 0; i < 100 && requestCount(reqLog) === before; i++) await page.waitForTimeout(200);
    await page.waitForTimeout(1000);
    check('regenerated reply also gets the note', noteCount(lastMessages()) === 1);

    // Hidden flag, temperature, user's body.
    await page.click('.bh-actions [data-act="temp"]');
    await page.fill('#bh_f_temp', '35.2');
    await page.click('[data-act="save-temp"]');
    await page.locator('.bh-member', { hasText: 'User' }).click();
    await page.click('[data-act="add"]');
    await page.click('.bh-cat[data-cat="body"]');
    await page.selectOption('#bh_f_part', 'abdomen');
    await page.fill('#bh_f_type', 'Stab wound');
    await page.selectOption('#bh_f_sev', 'severe');
    await page.check('#bh_f_hidden');
    await page.click('[data-act="save"]');
    await send('I am fine, really.');
    const text = lastMessages()[noteIndex(lastMessages())].content;
    check('user listed with (user) and hidden wound marked', /User \(user\):\n- Abdomen: stab wound, severe\. Hidden: others don't know/.test(text), text);
    check('abnormal temperature included', text.includes('Whole body: temperature 35.2 °C (low).'));
    await page.screenshot({ path: path.join(shots, 'm2-preview.png') });

    // Depth 0 puts it after the newest message.
    await setSetting('#body_hud_depth', 0);
    await send('Depth test.');
    msgs = lastMessages();
    check('depth 0 places it after the newest message', noteIndex(msgs) === msgs.length - 1);
    await setSetting('#body_hud_depth', 1);

    // Length limit.
    await setSetting('#body_hud_budget', 40);
    await page.waitForTimeout(200);
    check('tight length limit reports left-out lines', (await panelText()).includes('left out to stay within the length limit'));
    await setSetting('#body_hud_budget', 200);

    // Turning sending off.
    await setSetting('#body_hud_inject', false);
    await send('Off test.');
    check('sending off: no note', noteCount(lastMessages()) === 0);
    await setSetting('#body_hud_inject', true);

    // Removing everything: note disappears.
    for (const who of ['User', 'Seraphina']) {
        await page.locator('.bh-member', { hasText: who }).click();
        while (await page.locator('.bh-cond [data-act="remove"]').count()) {
            await page.locator('.bh-cond [data-act="remove"]').first().click();
            await page.waitForTimeout(150);
        }
        if (await page.locator('.bh-chip[data-act="temp"]').count()) {
            await page.click('.bh-actions [data-act="temp"]');
            await page.click('[data-act="clear-temp"]');
        }
    }
    await send('All better.');
    check('healed scene sends no note again', noteCount(lastMessages()) === 0);

    const ours = errors.filter(e => /body|hud|bh_/i.test(e));
    check('no page errors from the extension', ours.length === 0, ours.join(' | '));
    await browser.close();
    process.exit(finish());
})().catch(e => { console.error(e); process.exit(2); });
