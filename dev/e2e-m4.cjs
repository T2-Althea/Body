// M4 end-to-end check: automatic detection (ask / auto / manual), review queue,
// undo, the ✨ fill buttons, and drafts surviving refreshes.
// Usage: node dev/e2e-m4.cjs <st-url> <fake-llm-request-log> [screenshot-dir]
const fs = require('fs');
const path = require('path');
const { openST, makeChecker, sendMessage } = require('./st-page.cjs');

const url = process.argv[2] || 'http://127.0.0.1:8000/';
const reqLog = process.argv[3];
const shots = process.argv[4] || '.';
const taskLog = reqLog + '.tasks';
const { check, finish } = makeChecker();
const taskCount = () => (fs.existsSync(taskLog) ? fs.readFileSync(taskLog, 'utf8').trim().split('\n').filter(Boolean).length : 0);

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
        await page.waitForFunction(() => !document.querySelector('#body_hud_busy') || getComputedStyle(document.querySelector('#body_hud_busy')).display === 'none', null, { timeout: 30000 });
        await page.waitForTimeout(700);
    };
    const send = async text => { await sendMessage(page, reqLog, text); await idle(); };
    const pendingCount = () => page.locator('.bh-pending').count();

    await setSetting('#body_hud_side', 'right');
    await setSetting('#body_hud_detect_mode', 'ask');
    await setSetting('#body_hud_prefilter', true);
    await setSetting('#body_hud_detect_user', true);
    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(1500);
    if (!(await page.locator('#body_hud_panel').isVisible())) await page.click('#body_hud_tab');
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();
    check('profile picker offers the chat model', (await page.locator('#body_hud_profile option[value=""]').innerText()).includes('Same as the chat'));

    // 1. Prefilter.
    let t0 = taskCount();
    await send('She smiles and pours the tea.');
    check('ordinary message is not sent for checking', taskCount() === t0);

    // 2. Ask mode: proposal, then approve.
    t0 = taskCount();
    await send('An arrow hits Seraphina in the left thigh.');
    check('injury message is checked', taskCount() > t0);
    const detectEntry = JSON.parse(fs.readFileSync(taskLog, 'utf8').trim().split('\n').pop());
    const detectReq = detectEntry.messages;
    check('detection gets a generous reply allowance (reasoning models)', detectEntry.max_tokens === 2000, String(detectEntry.max_tokens));
    check('the check sees only the new message plus one before it', JSON.stringify(detectReq).includes('NEW MESSAGE') && !JSON.stringify(detectReq).includes('She smiles and pours'));
    check('one proposal waits for review', await pendingCount() === 1);
    check('proposal describes the wound', (await page.locator('.bh-pending').first().innerText()).includes('Arrow wound — Left thigh (moderate)'));
    check('nothing applied before approval', !(await panelText()).includes('Left thigh: Arrow wound'));
    await page.screenshot({ path: path.join(shots, 'm4-review.png') });
    await page.locator('.bh-pending [data-act="approve"]').first().click();
    await page.waitForTimeout(300);
    check('approved change applied', (await panelText()).includes('Left thigh: Arrow wound'));
    const stored = await page.evaluate(() => SillyTavern.getContext().chat.map((m, i) => ({ i, ops: (m.extra?.body_hud?.ops || []).map(o => o.src) })).filter(x => x.ops.length));
    const userIdx = await page.evaluate(() => SillyTavern.getContext().chat.findIndex(m => m.mes.includes('An arrow hits')));
    check('stored on the message that caused it, marked reviewed', stored.length === 1 && stored[0].i === userIdx && stored[0].ops[0] === 'review', JSON.stringify(stored));

    // 3. Figurative language: checked, nothing proposed.
    t0 = taskCount();
    await send('My heart broke when I saw the blood.');
    check('figurative message: checked but nothing proposed', taskCount() > t0 && await pendingCount() === 0);

    // 4. Unknown side.
    await send('A wolf bites Seraphina on the leg.');
    check('unknown side asks Left/Right', await page.locator('.bh-pending [data-act="side"]').count() === 2);
    await page.locator('.bh-pending [data-act="side"][data-side="right"]').click();
    await page.waitForTimeout(300);
    check('picked side applied', (await panelText()).includes('Right leg: Bite'));

    // 5. Reject.
    await send('Seraphina is soaked by the rain.');
    check('state proposed', (await page.locator('.bh-pending').innerText()).includes('Wet'));
    await page.locator('.bh-pending [data-act="reject"]').click();
    await page.waitForTimeout(300);
    check('rejected change not applied', await pendingCount() === 0 && !(await page.locator('.bh-chip', { hasText: 'Wet' }).count()));

    // 6. Edit a proposal before applying.
    await send('A second arrow grazes her other thigh.');
    await page.locator('.bh-pending [data-act="review-edit"]').click();
    await page.selectOption('#bh_f_part', 'right_thigh');
    await page.fill('#bh_f_type', 'Graze');
    await page.click('.bh-form [data-act="save"]');
    await page.waitForTimeout(300);
    check('edited proposal applied with my changes', (await panelText()).includes('Right thigh: Graze') && await pendingCount() === 0);

    // 7. Auto mode + undo.
    await setSetting('#body_hud_detect_mode', 'auto');
    await send('Seraphina bandages the wound tightly.');
    check('auto mode applies without asking', (await panelText()).includes('Treated') && await pendingCount() === 0);
    await page.locator('.bh-log summary').click();
    check('change appears in the log', (await page.locator('.bh-log').innerText()).includes('status → treated'));
    await page.locator('.bh-log [data-act="undo"]').first().click();
    await page.waitForTimeout(300);
    const arrowRow = await page.locator('.bh-cond', { hasText: 'Left thigh: Arrow wound' }).innerText();
    check('undo reverts it', arrowRow.includes('Fresh') && !arrowRow.includes('Treated'), arrowRow);

    // 8. Manual mode + Scan.
    await setSetting('#body_hud_detect_mode', 'manual');
    t0 = taskCount();
    await send('She has a fever now.');
    check('manual mode: no automatic check', taskCount() === t0);
    await page.click('[data-act="scan"]');
    await idle();
    check('Scan checks the latest message', taskCount() > t0);
    await setSetting('#body_hud_detect_mode', 'ask');

    // 8b. A reasoning model that runs out of room explains itself.
    await setSetting('#body_hud_detect_mode', 'ask');
    await page.evaluate(() => toastr.clear());
    await send('She will think too long about the wound.');
    await page.waitForTimeout(500);
    const toasts = await page.locator('#toast-container').innerText().catch(() => '');
    check('empty reply: toast says to raise Max reply tokens', toasts.includes('Max reply tokens'), toasts.replace(/\n/g, ' ').slice(0, 160));
    await page.evaluate(() => toastr.clear());

    // 9. Deleting the message removes what it caused.
    await page.evaluate(i => SillyTavern.getContext().executeSlashCommandsWithOptions(`/cut ${i}`), userIdx);
    await page.waitForTimeout(800);
    check('deleting the source message removes its wound', !(await panelText()).includes('Left thigh: Arrow wound'));

    // 10. ✨ fill.
    await page.click('.bh-actions [data-act="add"]');
    await page.selectOption('#bh_f_part', 'left_forearm');
    await page.fill('#bh_f_type', 'Stab wound');
    await page.fill('#bh_f_effect', 'My own effect');
    await page.click('.bh-form .menu_button[data-act="fill"]');
    await idle();
    check('fill empty keeps typed text', await page.inputValue('#bh_f_effect') === 'My own effect');
    check('fill empty fills the rest', await page.inputValue('#bh_f_details') === 'Deep puncture' && await page.inputValue('#bh_f_cause') === 'Ambush on the road');
    await page.click('.bh-fill[data-field="effect"]');
    await idle();
    check('✨ on one field replaces it', await page.inputValue('#bh_f_effect') === "Can't put weight on it");
    const fillReq = JSON.parse(fs.readFileSync(taskLog, 'utf8').trim().split('\n').pop()).messages;
    check('fill request includes the condition and recent story', JSON.stringify(fillReq).includes('Stab wound') && JSON.stringify(fillReq).includes('RECENT STORY'));

    // 11. Typed text survives a background refresh.
    await page.fill('#bh_f_details', 'Typed before refresh');
    await page.evaluate(() => { const c = SillyTavern.getContext(); c.eventSource.emit(c.eventTypes.MESSAGE_EDITED, c.chat.length - 1); });
    await page.waitForTimeout(400);
    check('form keeps typed text across a refresh', await page.inputValue('#bh_f_details') === 'Typed before refresh');
    await page.click('.bh-form [data-act="cancel"]');
    await page.screenshot({ path: path.join(shots, 'm4-panel.png') });

    const ours = errors.filter(e => /body|hud|bh_/i.test(e));
    check('no page errors from the extension', ours.length === 0, ours.join(' | '));
    await browser.close();
    process.exit(finish());
})().catch(e => { console.error(e); process.exit(2); });
