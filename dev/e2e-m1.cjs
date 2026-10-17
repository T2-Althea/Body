// M1 end-to-end check: side panel, manual editing, storage on messages.
// Usage: node dev/e2e-m1.cjs <st-url> <fake-llm-request-log> [screenshot-dir]
const path = require('path');
const { openST, makeChecker, sendMessage } = require('./st-page.cjs');

const url = process.argv[2] || 'http://127.0.0.1:8000/';
const reqLog = process.argv[3];
const shots = process.argv[4] || '.';
const { check, finish } = makeChecker();

(async () => {
    let { browser, page, errors, state } = await openST(url);
    check('extension loaded', state.loaded);

    const rootHas = cls => page.evaluate(c => document.querySelector('#body_hud_root')?.classList.contains(c), cls);
    const visible = sel => page.locator(sel).isVisible();
    const panelText = () => page.locator('#body_hud_panel .bh-content').innerText();
    const ops = () => page.evaluate(() => SillyTavern.getContext().chat.map((m, i) => ({ i, n: m.extra?.body_hud?.ops?.length || 0 })));

    // Make sure we start closed on the right.
    await page.evaluate(() => { const s = SillyTavern.getContext().extensionSettings.body_hud; s.panelOpen = false; s.side = 'right'; });
    await page.evaluate(() => $('#body_hud_side').val('right').trigger('change'));
    check('tab visible, panel closed', await visible('#body_hud_tab') && !(await visible('#body_hud_panel')));

    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    // Start from a fresh chat so earlier runs don't interfere.
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(1500);

    await page.click('#body_hud_tab');
    check('tab opens the panel', await visible('#body_hud_panel'));
    const members = await page.locator('.bh-member:not([data-act])').allInnerTexts();
    check('scene lists user and character', members.length === 2 && members.some(m => m.includes('Seraphina')), members.join(' | '));
    check('empty body says nothing is sent', (await panelText()).includes('Nothing is sent'));

    // Add an injury to Seraphina.
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();
    await page.click('[data-act="add"]');
    await page.selectOption('#bh_f_kind', 'injury');
    await page.selectOption('#bh_f_part', 'left_thigh');
    await page.fill('#bh_f_type', 'Arrow wound');
    await page.selectOption('#bh_f_sev', 'moderate');
    await page.selectOption('#bh_f_bleed', 'moderate');
    await page.fill('#bh_f_effect', "Can't run; limps");
    await page.fill('#bh_f_details', 'Arrowhead still lodged');
    await page.click('[data-act="save"]');
    await page.waitForTimeout(300);
    let text = await panelText();
    check('injury listed under its region', text.includes('Left leg') && text.includes('Left thigh: Arrow wound') && text.includes("Can't run; limps"));
    check('tab warning dot set', await page.evaluate(() => document.querySelector('#body_hud_tab').classList.contains('bh-alert')));

    const stored = await page.evaluate(() => {
        const m = SillyTavern.getContext().chat.at(-1);
        return { main: m.extra?.body_hud?.ops?.length, swipes: (m.swipe_info || []).map(s => s.extra?.body_hud?.ops?.length || 0) };
    });
    check('record stored on the latest message and all its swipes', stored.main === 1 && stored.swipes.every(n => n === 1), JSON.stringify(stored));

    // Whole-body state, mind, missing part, temperature.
    await page.click('[data-act="add"]');
    await page.selectOption('#bh_f_kind', 'state');
    check('state form offers an optional area instead of a required part', (await page.locator('.bh-f-part-label').innerText()) === 'Area (optional)');
    await page.fill('#bh_f_type', 'Wet');
    await page.selectOption('#bh_f_sev', 'minor');
    await page.click('[data-act="save"]');

    await page.click('[data-act="add"]');
    await page.selectOption('#bh_f_kind', 'missing');
    await page.selectOption('#bh_f_part', 'right_hand');
    await page.fill('#bh_f_effect', 'One-handed only');
    await page.click('[data-act="save"]');

    await page.click('[data-act="add"]');
    await page.selectOption('#bh_f_kind', 'mind_current');
    await page.fill('#bh_f_type', 'Panicked');
    await page.click('[data-act="save"]');

    await page.click('.bh-actions [data-act="temp"]');
    await page.fill('#bh_f_temp', '35.8');
    await page.click('[data-act="save-temp"]');
    await page.waitForTimeout(300);
    text = await panelText();
    check('state chip and temperature shown', text.includes('Wet') && text.includes('35.8'));
    check('missing hand includes the parts below it', text.includes('Right hand') && text.includes('includes 7 parts below it'), text.match(/Right hand[^\n]*\n[^\n]*\n[^\n]*/)?.[0]);
    check('mind state shown', /mind/i.test(text) && text.includes('Panicked'));

    // Edit the wound, then remove the state.
    await page.locator('.bh-cond', { hasText: 'Arrow wound' }).locator('[data-act="edit"]').click();
    check('edit form is prefilled', await page.inputValue('#bh_f_type') === 'Arrow wound');
    await page.selectOption('#bh_f_status', 'treated');
    await page.click('[data-act="save"]');
    await page.waitForTimeout(200);
    check('edit applied', (await panelText()).includes('Treated'));
    await page.click('.bh-chip:has-text("Wet")');
    await page.click('[data-act="cancel"]');

    // A wound added later, on a later message, disappears when that message is deleted.
    await sendMessage(page, reqLog, 'Ouch.');
    await page.click('[data-act="add"]');
    await page.selectOption('#bh_f_kind', 'injury');
    await page.selectOption('#bh_f_part', 'nose');
    await page.fill('#bh_f_type', 'Bruise');
    await page.click('[data-act="save"]');
    await page.waitForTimeout(300);
    check('second wound added', (await panelText()).includes('Nose: Bruise'));
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/del 2'));
    await page.waitForTimeout(800);
    text = await panelText();
    check('deleting its message removes the later wound, keeps earlier ones', !text.includes('Nose: Bruise') && text.includes('Arrow wound'), JSON.stringify(await ops()));

    await page.screenshot({ path: path.join(shots, 'm1-panel-right.png') });

    // Persists across a reload (wait out SillyTavern's debounced settings save first).
    await page.waitForTimeout(2500);
    await page.reload();
    await page.waitForFunction(() => window.SillyTavern?.getContext?.().characters?.length > 0 && document.querySelector('#body_hud_panel'), null, { timeout: 60000 });
    await page.waitForTimeout(2000);
    // Reopen the character; SillyTavern loads its most recent chat (the one above).
    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page.waitForTimeout(1000);
    check('panel open state remembered', await visible('#body_hud_panel'));
    if (!(await visible('#body_hud_panel'))) await page.click('#body_hud_tab');
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();
    text = await panelText();
    check('state survives a page reload', text.includes('Arrow wound') && text.includes('Treated') && text.includes('35.8'));

    // Hides while the character list (right drawer) is open.
    await page.click('#rightNavDrawerIcon');
    await page.waitForTimeout(600);
    check('hidden while character list is open', await rootHas('bh-covered') && !(await visible('#body_hud_panel')));
    await page.click('#rightNavDrawerIcon');
    await page.waitForTimeout(600);
    check('back when character list closes', !(await rootHas('bh-covered')) && await visible('#body_hud_panel'));

    // Left side.
    await page.evaluate(() => $('#body_hud_side').val('left').trigger('change'));
    const box = await page.locator('#body_hud_panel').boundingBox();
    check('left side placement', box && box.x < 5, JSON.stringify(box));
    await page.click('#leftNavDrawerIcon');
    await page.waitForTimeout(600);
    check('hidden while AI config (left drawer) is open', await rootHas('bh-covered'));
    await page.click('#leftNavDrawerIcon');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shots, 'm1-panel-left.png') });

    // Collapse back to the tab.
    await page.click('#body_hud_close');
    check('close collapses to the tab', await visible('#body_hud_tab') && !(await visible('#body_hud_panel')));
    await page.screenshot({ path: path.join(shots, 'm1-tab.png') });
    await page.evaluate(() => $('#body_hud_side').val('right').trigger('change'));
    await page.waitForTimeout(2500);

    // Phone-sized screen: panel overlays the chat instead of breaking layout.
    await browser.close();
    ({ browser, page, errors: errors } = await openST(url, { viewport: { width: 400, height: 800 } }).then(r => ({ ...r, errors: errors.concat(r.errors) })));
    await page.waitForTimeout(1000);
    if (!(await visible('#body_hud_panel'))) await page.click('#body_hud_tab');
    const mbox = await page.locator('#body_hud_panel').boundingBox();
    check('phone: panel fits the screen', mbox && mbox.width <= 400 && mbox.x >= 0, JSON.stringify(mbox));
    await page.screenshot({ path: path.join(shots, 'm1-phone.png') });
    await page.click('#body_hud_close');

    const ours = errors.filter(e => /body|hud|bh_/i.test(e));
    check('no page errors from the extension', ours.length === 0, ours.join(' | '));
    if (errors.length) console.log('      (all page errors:', errors.join(' | '), ')');
    await browser.close();
    process.exit(finish());
})().catch(e => { console.error(e); process.exit(2); });
