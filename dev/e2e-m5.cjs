// M5 end-to-end check: body state follows swipes, regenerations, edits and branches.
// Usage: node dev/e2e-m5.cjs <st-url> <fake-llm-request-log> [screenshot-dir]
const fs = require('fs');
const { openST, makeChecker, sendMessage, requestCount } = require('./st-page.cjs');

const url = process.argv[2] || 'http://127.0.0.1:8000/';
const reqLog = process.argv[3];
const taskLog = reqLog + '.tasks';
const { check, finish } = makeChecker();
const taskCount = () => (fs.existsSync(taskLog) ? fs.readFileSync(taskLog, 'utf8').trim().split('\n').filter(Boolean).length : 0);
const lastRoleplayRequest = () => JSON.stringify(JSON.parse(fs.readFileSync(reqLog, 'utf8').trim().split('\n').pop()).messages);

(async () => {
    const { browser, page, errors, state } = await openST(url);
    check('extension loaded', state.loaded);
    const panelText = () => page.locator('#body_hud_panel .bh-content').innerText();
    const setSetting = (sel, value) => page.evaluate(([s, v]) => {
        const el = document.querySelector(s);
        if (el.type === 'checkbox') el.checked = v; else el.value = String(v);
        el.dispatchEvent(new Event('change'));
    }, [sel, value]);
    const idle = async () => {
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#body_hud_busy')).display === 'none', null, { timeout: 30000 });
        await page.waitForTimeout(800);
    };
    const send = async text => { await sendMessage(page, reqLog, text); await idle(); };
    const hasArrow = async () => (await panelText()).includes('Left thigh: Arrow wound');
    const lastInfo = () => page.evaluate(() => {
        const m = SillyTavern.getContext().chat.at(-1);
        return { swipe: m.swipe_id ?? 0, swipes: m.swipes?.length ?? 1, mes: m.mes };
    });
    const swipe = async dir => {
        const before = requestCount(reqLog);
        const info = await lastInfo();
        await page.locator(`#chat .last_mes .swipe_${dir}`).first().click();
        const generates = dir === 'right' && info.swipe === info.swipes - 1;
        if (generates) for (let i = 0; i < 100 && requestCount(reqLog) === before; i++) await page.waitForTimeout(200);
        await page.waitForTimeout(1200);
        await idle();
    };

    await setSetting('#body_hud_side', 'right');
    await setSetting('#body_hud_detect_mode', 'auto');
    await setSetting('#body_hud_prefilter', true);
    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(1500);
    if (!(await page.locator('#body_hud_panel').isVisible())) await page.click('#body_hud_tab');
    // A wound on the user, so a note is always sent and we can see what it leaves out.
    await page.locator('.bh-member', { hasText: 'User' }).click();
    await page.click('.bh-actions [data-act="add"]');
    await page.selectOption('#bh_f_part', 'left_palm');
    await page.fill('#bh_f_type', 'Cut');
    await page.click('.bh-form [data-act="save"]');
    await page.waitForTimeout(300);
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();

    // The AI's reply causes a wound.
    await send('Then ARROW_REPLY happens.');
    check('AI reply describes the arrow', (await lastInfo()).mes.includes('arrow'));
    check('detection applied the wound from the AI reply', await hasArrow());

    // Regenerate it with a swipe.
    await swipe('right');
    const regenPrompt = lastRoleplayRequest();
    check('the regenerated reply\'s note leaves out the wound the old reply caused', regenPrompt.includes('Left palm: cut') && !regenPrompt.includes('arrow wound'));
    check('new swipe is a different reply', !(await lastInfo()).mes.includes('arrow'));
    check('wound gone on the new swipe', !(await hasArrow()));
    const inherited = await page.evaluate(() => {
        const m = SillyTavern.getContext().chat.at(-1);
        return (m.extra?.body_hud?.ops || []).filter(o => o.fp).length;
    });
    check('inherited detected data cleared from the new swipe', inherited === 0, String(inherited));

    // Swipe back and forth.
    await swipe('left');
    check('swiping back to the first reply brings the wound back', (await lastInfo()).swipe === 0 && await hasArrow());
    await swipe('right');
    check('and forward to the second removes it again', (await lastInfo()).swipe === 1 && !(await hasArrow()));
    await swipe('left');

    // Manual changes survive regenerations.
    await page.click('.bh-actions [data-act="add"]');
    await page.selectOption('#bh_f_part', 'nose');
    await page.fill('#bh_f_type', 'Bruise');
    await page.click('.bh-form [data-act="save"]');
    await page.waitForTimeout(300);
    await swipe('right');
    await swipe('right');
    const t = await panelText();
    check('manual change survives a new swipe', t.includes('Nose: Bruise') && !t.includes('Arrow wound'), `swipe ${(await lastInfo()).swipe}`);
    // Back to the arrow reply.
    while ((await lastInfo()).swipe !== 0) await swipe('left');
    check('back on the arrow reply', await hasArrow());

    // Editing the message drops what was read from the old text and re-checks it.
    const t0 = taskCount();
    await page.evaluate(() => {
        const c = SillyTavern.getContext();
        const i = c.chat.length - 1;
        const m = c.chat[i];
        m.mes = 'The arrow misses her completely.';
        if (Array.isArray(m.swipes)) m.swipes[m.swipe_id] = m.mes;
        c.eventSource.emit(c.eventTypes.MESSAGE_EDITED, i);
    });
    await page.waitForTimeout(500);
    await idle();
    check('edited message: wound from the old text is gone', !(await hasArrow()));
    check('edited message is checked again', taskCount() > t0);
    check('manual change kept through the edit', (await panelText()).includes('Nose: Bruise'));

    // Pending proposals follow swipes too.
    await setSetting('#body_hud_detect_mode', 'ask');
    await send('And ARROW_REPLY once more.');
    check('proposal waiting for the new reply', await page.locator('.bh-pending').count() === 1);
    await swipe('right');
    check('regenerating the reply removes its proposal', await page.locator('.bh-pending').count() === 0);
    await swipe('left');
    check('swiping back shows the proposal again', await page.locator('.bh-pending').count() === 1);
    await page.locator('.bh-pending [data-act="approve"]').click();
    await page.waitForTimeout(400);
    check('approved on that reply', await hasArrow());

    // Branch from here: the body comes along.
    const chatBefore = await page.evaluate(() => SillyTavern.getContext().getCurrentChatId());
    const lastId = await page.evaluate(() => SillyTavern.getContext().chat.length - 1);
    await page.evaluate(id => SillyTavern.getContext().executeSlashCommandsWithOptions(`/branch-create ${id}`), lastId);
    await page.waitForTimeout(2500);
    const chatAfter = await page.evaluate(() => SillyTavern.getContext().getCurrentChatId());
    check('branch opened', chatAfter && chatAfter !== chatBefore, `${chatBefore} → ${chatAfter}`);
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();
    const bt = await panelText();
    check('branch keeps the body state', bt.includes('Arrow wound') && bt.includes('Nose: Bruise'));

    const ours = errors.filter(e => /body|hud|bh_/i.test(e));
    check('no page errors from the extension', ours.length === 0, ours.join(' | '));
    await browser.close();
    process.exit(finish());
})().catch(e => { console.error(e); process.exit(2); });
