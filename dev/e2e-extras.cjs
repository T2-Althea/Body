// Mood (picker, note rules, Expressions extension, detection) and clothing
// (items, outfits, shared library, the Wearing line, detection).
// Usage: node dev/e2e-extras.cjs <st-url> <fake-llm-request-log> [screenshot-dir]
const path = require('path');
const { openST, makeChecker, sendMessage } = require('./st-page.cjs');

const url = process.argv[2] || 'http://127.0.0.1:8000/';
const reqLog = process.argv[3];
const shots = process.argv[4] || '.';
const { check, finish } = makeChecker();

(async () => {
    const { browser, page, errors, state } = await openST(url, { viewport: { width: 1600, height: 1200 } });
    check('extension loaded', state.loaded);
    if (process.env.DEBUG) page.on('console', m => { if (/Body HUD|xpression/.test(m.text())) console.log('console:', m.text().slice(0, 160)); });
    const panelText = () => page.locator('#body_hud_panel .bh-content').innerText();
    const note = () => page.locator('.bh-note-text').innerText().catch(() => '');
    const moodLine = () => page.locator('.bh-mood').innerText();
    const clothRows = () => page.locator('.bh-cloth').allInnerTexts();
    const setSetting = (sel, value) => page.evaluate(([s, v]) => {
        const el = document.querySelector(s);
        if (el.type === 'checkbox') el.checked = v; else el.value = String(v);
        el.dispatchEvent(new Event('change'));
    }, [sel, value]);
    const idle = async () => {
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#body_hud_busy')).display === 'none', null, { timeout: 30000 });
        await page.waitForTimeout(500);
    };
    const pickMood = async (intensity, label) => {
        await page.click('.bh-mood');
        await page.click(`.bh-mood-int[data-intensity="${intensity}"]`);
        await page.click(`.bh-mood-opt[data-mood="${label}"]`);
        await page.waitForTimeout(300);
    };
    const addItem = async (slot, item, desc = '') => {
        await page.click('[data-act="wear-new"]');
        await page.selectOption('#bh_w_slot', slot);
        await page.fill('#bh_w_item', item);
        await page.fill('#bh_w_desc', desc);
        await page.click('[data-act="wear-save"]');
        await page.waitForTimeout(300);
    };

    await setSetting('#body_hud_side', 'right');
    await setSetting('#body_hud_detect_mode', 'manual');
    await setSetting('#body_hud_mood_source', 'manual');
    await setSetting('#body_hud_clothes_note', 'recent');
    await page.evaluate(() => {
        const s = SillyTavern.getContext().extensionSettings.body_hud;
        s.notePreviewOpen = true;
        s.clothesOpen = true;
        s.outfitLibrary = [];
        s.moodInNote = true;
    });
    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(1500);
    if (!(await page.locator('#body_hud_panel').isVisible())) await page.click('#body_hud_tab');
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();

    // ---------- mood ----------
    check('mood line shows calm when none is set', (await moodLine()).includes('Mood: calm'));
    await page.click('.bh-mood');
    check('picker has the 28 Expressions labels', await page.locator('.bh-mood-opt').count() === 28);
    await page.click('.bh-mood-int[data-intensity="strong"]');
    await page.mouse.move(0, 0);
    await page.waitForTimeout(600);
    check('intensity toggle marks only the chosen one', (await page.locator('.bh-mood-int.bh-active').allInnerTexts()).join() === 'Strong');
    await page.screenshot({ path: path.join(shots, 'extras-mood-picker.png'), clip: await page.locator('.bh-form').boundingBox() });
    await page.click('.bh-mood-opt[data-mood="fear"]');
    await page.waitForTimeout(300);
    check('strong fear shown', (await moodLine()).includes('Mood: afraid') && (await moodLine()).includes('(strong)'));
    check('strong mood in the note', (await note()).includes('- Mood: very afraid.'));
    await pickMood('mild', 'joy');
    check('mild joy: shown in the HUD, not sent', (await moodLine()).includes('happy') && !(await note()).includes('Mood'));
    await pickMood('mild', 'nervousness');
    check('mild nervousness is sent (changes behaviour)', (await note()).includes('- Mood: nervous.'));

    // From the Expressions extension.
    await setSetting('#body_hud_mood_source', 'expressions');
    await sendMessage(page, reqLog, 'We keep walking.');
    // With no classifier configured, Expressions clears the expression a moment
    // after each reply; set ours after that, as a classifier's result would land.
    await page.waitForTimeout(4000);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/expression-set anger'));
    await page.waitForFunction(() => document.querySelector('.bh-mood')?.innerText.includes('angry'), null, { timeout: 25000 }).catch(() => {});
    check('mood picked up from the Expressions extension', (await moodLine()).includes('angry'));
    const stored = await page.evaluate(() => {
        const chat = SillyTavern.getContext().chat;
        return (chat[chat.length - 1].extra?.body_hud?.ops || []).filter(o => o.t === 'mood').map(o => `${o.label}:${o.src}`);
    });
    check('stored on the reply, as a detected change', stored.join(',') === 'anger:detect', stored.join(','));

    // From detection.
    await setSetting('#body_hud_mood_source', 'detect');
    await setSetting('#body_hud_detect_mode', 'ask');
    await sendMessage(page, reqLog, 'Seraphina laughs at the joke.');
    await idle();
    check('detected mood applied without review', (await moodLine()).includes('amused') && (await moodLine()).includes('(strong)') && await page.locator('.bh-pending').count() === 0);
    check('listed under Recent changes with undo', (await page.locator('.bh-log').textContent()).includes('mood → amusement'));
    await setSetting('#body_hud_mood_source', 'manual');

    // ---------- clothing ----------
    check('clothing section, empty', (await page.locator('.bh-clothing').innerText()).includes('Nothing recorded'));
    await addItem('top', 'White blouse', 'Silk, sleeves rolled up');
    await addItem('shoes', 'Leather boots');
    let rows = await clothRows();
    check('items listed by slot', rows.length === 2 && rows[0].includes('Top') && rows[0].includes('White blouse') && rows[1].includes('Leather boots'), rows.join(' / '));
    check('Wearing line in the note after a change', (await note()).includes('- Wearing: white blouse (silk, sleeves rolled up), leather boots.'));
    await page.click('.bh-cloth:has-text("White blouse") [data-act="wear-edit"]');
    check('edit form prefilled', await page.inputValue('#bh_w_item') === 'White blouse' && await page.inputValue('#bh_w_slot') === 'top');
    await page.fill('#bh_w_item', 'Linen tunic');
    await page.fill('#bh_w_desc', '');
    await page.click('[data-act="wear-save"]');
    await page.waitForTimeout(300);
    check('item edited', (await clothRows()).some(r => r.includes('Linen tunic')) && !(await clothRows()).some(r => r.includes('blouse')));

    // Outfits.
    await page.click('[data-act="outfit-save-form"]');
    await page.fill('#bh_o_name', 'Travelling clothes');
    await page.click('[data-act="outfit-save"]');
    await page.waitForTimeout(300);
    await page.click('[data-act="outfit-clear"]');
    await page.waitForTimeout(300);
    check('take all off', (await clothRows()).length === 0);
    await page.selectOption('#bh_outfit', { label: 'Travelling clothes' });
    await page.click('[data-act="outfit-wear"]');
    await page.waitForTimeout(300);
    check('wearing a saved outfit puts everything back', (await clothRows()).length === 2);
    await addItem('outerwear', 'Silver gown');
    await page.click('[data-act="outfit-save-form"]');
    await page.fill('#bh_o_name', 'Ball gown');
    await page.check('#bh_o_shared');
    await page.click('[data-act="outfit-save"]');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, 'extras-clothing.png'), clip: await page.locator('.bh-clothing').boundingBox() });
    await page.locator('.bh-member', { hasText: 'User' }).click();
    const groups = await page.locator('#bh_outfit optgroup').evaluateAll(gs => gs.map(g => `${g.label}: ${[...g.children].map(o => o.textContent).join(',')}`));
    check('another character sees the shared library only', groups.join(' | ') === 'Shared library: Ball gown', groups.join(' | '));
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();

    // Detection.
    await setSetting('#body_hud_detect_mode', 'ask');
    await sendMessage(page, reqLog, 'Seraphina puts on a red cloak against the cold.');
    await idle();
    const pending = await page.locator('.bh-pending').allInnerTexts();
    check('detection proposes the clothing change', pending.some(p => p.includes('wears Red cloak (outerwear)')), pending.join(' / '));
    await page.click('[data-act="approve-all"]');
    await page.waitForTimeout(400);
    check('approved: replaces the outerwear', (await clothRows()).some(r => r.includes('Red cloak') && r.includes('Wool')) && !(await clothRows()).some(r => r.includes('Silver gown')));
    await setSetting('#body_hud_detect_mode', 'manual');

    // {{outfit}} inside the card's description: replaced when the prompt is built.
    check('{{outfit}} macro gives the current clothes', (await page.evaluate(async () => (await SillyTavern.getContext().executeSlashCommandsWithOptions('/pass {{outfit}}')).pipe)) === 'linen tunic, red cloak (wool), leather boots');
    const original = await page.evaluate(() => {
        const c = SillyTavern.getContext();
        const ch = c.characters[c.characterId];
        const before = ch.description;
        ch.description += '\n[Currently wearing: {{outfit}}]';
        return before;
    });
    await sendMessage(page, reqLog, 'We rest by the fire.');
    const sent = require('fs').readFileSync(reqLog, 'utf8').trim().split('\n').pop();
    check('the description sent to the AI has the clothes', sent.includes('[Currently wearing: linen tunic, red cloak (wool), leather boots]'));
    await page.evaluate(before => { const c = SillyTavern.getContext(); c.characters[c.characterId].description = before; }, original);

    // Old changes drop out of the note in "recent" mode.
    for (let i = 0; i < 6; i++) await sendMessage(page, reqLog, `Walking on, step ${i}.`);
    check('Wearing line gone a while after the last change', !(await note()).includes('Wearing'));
    await setSetting('#body_hud_clothes_note', 'always');
    await page.waitForTimeout(300);
    check('"Always" keeps it in the note', (await note()).includes('- Wearing: linen tunic, red cloak (wool), leather boots.'));
    await setSetting('#body_hud_clothes_note', 'recent');
    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.body_hud.outfitLibrary = []; });

    check('no page errors', !errors.length, errors.join(' | '));
    await browser.close();
    process.exit(finish());
})().catch(e => { console.error(e); process.exit(1); });
