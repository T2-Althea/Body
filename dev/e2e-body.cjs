// Body profile (sex / mannequin shape / parts), marks, and approving a proposal
// while its edit form is open.
// Usage: node dev/e2e-body.cjs <st-url> <fake-llm-request-log> [screenshot-dir]
const path = require('path');
const { openST, makeChecker, sendMessage } = require('./st-page.cjs');

const url = process.argv[2] || 'http://127.0.0.1:8000/';
const reqLog = process.argv[3];
const shots = process.argv[4] || '.';
const { check, finish } = makeChecker();

(async () => {
    const { browser, page, errors, state } = await openST(url);
    check('extension loaded', state.loaded);
    const panelText = () => page.locator('#body_hud_panel .bh-content').innerText();
    const setSetting = (sel, value) => page.evaluate(([s, v]) => {
        const el = document.querySelector(s);
        if (el.type === 'checkbox') el.checked = v; else el.value = String(v);
        el.dispatchEvent(new Event('change'));
    }, [sel, value]);
    const partOptions = async () => {
        await page.click('.bh-actions [data-act="add"]');
        const opts = await page.locator('#bh_f_part option').allInnerTexts();
        await page.click('.bh-form [data-act="cancel"]');
        return opts.map(o => o.trim());
    };
    const chestShape = () => page.locator('.bh-m-figure').first().locator('path[data-region="chest"]').getAttribute('d');

    await setSetting('#body_hud_side', 'right');
    await setSetting('#body_hud_sensitive', false);
    await setSetting('#body_hud_detect_mode', 'ask');
    await page.evaluate(() => {
        const s = SillyTavern.getContext().extensionSettings.body_hud;
        s.profiles = {};
        s.notePreviewOpen = true;
    });
    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(1500);
    if (!(await page.locator('#body_hud_panel').isVisible())) await page.click('#body_hud_tab');
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();

    // Guessed from her card.
    check('body guessed Female from the card', await page.inputValue('#bh_p_sex') === 'female' && await page.locator('.bh-guess').count() === 1);
    const femChest = await chestShape();
    let parts = await partOptions();
    check('female body lists female parts, not male', parts.includes('Vulva') && parts.includes('Left ovary') && !parts.includes('Penis'));
    check('nipples listed under breasts', parts.includes('Left nipple') && parts.indexOf('Left nipple') === parts.indexOf('Left breast') + 1);
    await page.screenshot({ path: path.join(shots, 'body-female.png') });

    // Override.
    await page.selectOption('#bh_p_sex', 'male');
    await page.waitForTimeout(300);
    check('choice saved, no longer marked as a guess', await page.locator('.bh-guess').count() === 0
        && await page.evaluate(() => Object.values(SillyTavern.getContext().extensionSettings.body_hud.profiles).some(p => p.sex === 'male')));
    check('mannequin shape changes', (await chestShape()) !== femChest);
    parts = await partOptions();
    check('male body lists male parts', parts.includes('Penis') && parts.includes('Right testicle') && !parts.includes('Vulva'));
    await page.selectOption('#bh_p_sex', 'unspecified');
    parts = await partOptions();
    check('unspecified lists both', parts.includes('Penis') && parts.includes('Vulva'));
    await page.selectOption('#bh_p_sex', 'female');

    // Sensitive parts can be hidden.
    await setSetting('#body_hud_sensitive', true);
    parts = await partOptions();
    check('hiding sensitive parts hides genitals and nipples', !parts.includes('Vulva') && !parts.includes('Genitals') && !parts.includes('Left nipple') && parts.includes('Left breast'));
    await setSetting('#body_hud_sensitive', false);

    // Persona has its own setting.
    await page.locator('.bh-member', { hasText: 'User' }).click();
    check('persona has its own body setting', await page.inputValue('#bh_p_sex') === 'unspecified');
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();

    // Marks.
    await page.click('.bh-actions [data-act="add"]');
    await page.selectOption('#bh_f_kind', 'mark');
    check('mark form: part and duration, no severity', await page.locator('.bh-f-lasts').isVisible() && !(await page.locator('.bh-f-sev').isVisible()) && await page.locator('.bh-f-part').isVisible());
    await page.selectOption('#bh_f_part', 'left_forearm');
    await page.fill('#bh_f_type', 'Dragon tattoo');
    await page.fill('#bh_f_details', 'Black ink');
    await page.click('.bh-form [data-act="save"]');
    await page.waitForTimeout(300);
    const text = await panelText();
    check('mark listed as permanent', /marks/i.test(text) && text.includes('Left forearm: Dragon tattoo') && text.includes('Permanent'));
    check('mark does not tint the mannequin', !/bh-m-(minor|moderate|severe|critical)/.test(await page.locator('.bh-m-figure').first().locator('path[data-region="left_arm"]').getAttribute('class')));
    check('mark in the AI note', (await page.locator('.bh-note-text').innerText()).includes('- Marks: dragon tattoo (black ink) on the left forearm.'));
    await page.screenshot({ path: path.join(shots, 'body-mark.png') });

    // Approving a proposal that's open in the edit form applies it once and closes the form.
    await sendMessage(page, reqLog, 'An arrow hits Seraphina in the left thigh.');
    await page.waitForTimeout(2500);
    await page.locator('.bh-pending [data-act="review-edit"]').click();
    await page.locator('.bh-pending [data-act="approve"]').click();
    await page.waitForTimeout(400);
    check('edit form for that proposal closes', await page.locator('.bh-form').count() === 0);
    const arrows = await page.evaluate(() => {
        const c = SillyTavern.getContext();
        return c.chat.flatMap(m => m.extra?.body_hud?.ops || []).filter(o => o.t === 'add' && o.cond?.type === 'Arrow wound').length;
    });
    check('applied exactly once', arrows === 1, String(arrows));

    const ours = errors.filter(e => /body|hud|bh_/i.test(e));
    check('no page errors from the extension', ours.length === 0, ours.join(' | '));
    await browser.close();
    process.exit(finish());
})().catch(e => { console.error(e); process.exit(2); });
