// M6 end-to-end check: time skips (preview, apply, undo, from the story) and realism levels.
// Usage: node dev/e2e-m6.cjs <st-url> <fake-llm-request-log> [screenshot-dir]
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
    const note = () => page.locator('.bh-note-text').innerText().catch(() => '');
    const setSetting = (sel, value) => page.evaluate(([s, v]) => {
        const el = document.querySelector(s);
        if (el.type === 'checkbox') el.checked = v; else el.value = String(v);
        el.dispatchEvent(new Event('change'));
    }, [sel, value]);
    const idle = async () => {
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#body_hud_busy')).display === 'none', null, { timeout: 30000 });
        await page.waitForTimeout(800);
    };
    const addCond = async (fields) => {
        await page.click('.bh-actions [data-act="add"]');
        await page.click(`.bh-cat[data-cat="${String(fields.kind || '').startsWith('mind') ? 'mind' : 'body'}"]`);
        if (fields.part) await page.selectOption('#bh_f_part', fields.part);
        if (fields.type) await page.fill('#bh_f_type', fields.type);
        if (fields.sev) await page.selectOption('#bh_f_sev', fields.sev);
        if (fields.bleed) await page.selectOption('#bh_f_bleed', fields.bleed);
        if (fields.status) await page.selectOption('#bh_f_status', fields.status);
        if (fields.effect) await page.fill('#bh_f_effect', fields.effect);
        await page.click('.bh-form [data-act="save"]');
        await page.waitForTimeout(250);
    };
    const skip = async (amount, unit, { uncheck = [] } = {}) => {
        await page.click('.bh-actions [data-act="skip"]');
        await page.fill('#bh_s_amount', String(amount));
        await page.selectOption('#bh_s_unit', unit);
        await page.click('[data-act="skip-preview"]');
        await page.waitForTimeout(200);
        const preview = await page.locator('.bh-skip-preview').innerText();
        for (const text of uncheck) await page.locator('.bh-skip-item', { hasText: text }).locator('input').uncheck();
        return preview;
    };

    await setSetting('#body_hud_side', 'right');
    await setSetting('#body_hud_realism', 'grounded');
    await setSetting('#body_hud_detect_mode', 'ask');
    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.body_hud.notePreviewOpen = true; });
    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(1500);
    if (!(await page.locator('#body_hud_panel').isVisible())) await page.click('#body_hud_tab');
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();

    await addCond({ part: 'left_thigh', type: 'Arrow wound', sev: 'moderate', status: 'treated', effect: "Can't run" });
    await addCond({ kind: 'state', type: 'Wet', sev: 'minor' });
    await addCond({ kind: 'mind_current', type: 'Panicked' });
    await page.click('.bh-chip[data-act="temp"]');
    await page.fill('#bh_f_temp', '35.5');
    await page.click('[data-act="save-temp"]');
    await page.waitForTimeout(250);
    check('wound shows time until it starts healing', (await panelText()).includes('~3 days until it starts healing'));

    // 3 days, leaving "wet" unchecked.
    let preview = await skip(3, 'days', { uncheck: ['no longer wet'] });
    check('preview lists healing and what wears off', ['Left thigh arrow wound is healing', 'no longer wet', 'panicked has passed', 'body temperature back to normal'].every(t => preview.includes(t)), preview.replace(/\n/g, ' | '));
    await page.screenshot({ path: path.join(shots, 'm6-preview.png') });
    await page.click('[data-act="skip-apply"]');
    await page.waitForTimeout(400);
    let text = await panelText();
    check('applied: wound healing, panic and temperature gone', text.includes('Healing') && !text.includes('Panicked') && !text.includes('35.5'));
    check('unchecked change was left out', text.includes('Wet'));
    check('healing hint updates', text.includes('~3 weeks until healed'));
    await page.locator('.bh-log summary').click();
    check('time skip in the log', (await page.locator('.bh-log').innerText()).includes('Time skip: 3 days (3 changes)'));

    // Undo the whole skip.
    await page.click('[data-act="undo-skip"]');
    await page.waitForTimeout(400);
    text = await panelText();
    check('undo restores everything', text.includes('Treated') && text.includes('Panicked') && text.includes('35.5'));

    // A long skip: healed with a scar; progress across two skips.
    await skip(2, 'days');
    await page.click('[data-act="skip-apply"]');
    await page.waitForTimeout(300);
    check('2 days: not healing yet, 1 day to go', (await panelText()).includes('~1 day until it starts healing'));
    preview = await skip(4, 'weeks');
    check('4 weeks more: healed, leaving a scar', preview.includes('healed, leaving a scar'));
    await page.click('[data-act="skip-apply"]');
    await page.waitForTimeout(300);
    text = await panelText();
    check('scarred and minor', text.includes('Scarred') && text.includes('Minor'));
    check('scar without effect drops out of the AI note', !(await note()).includes('Arrow wound') && !(await note()).toLowerCase().includes('arrow'));

    // Time skip from the story.
    await addCond({ kind: 'state', type: 'Muddy', sev: 'minor' });
    await sendMessage(page, reqLog, 'Three days later, they reach the city.');
    await idle();
    check('story time skip proposed', (await page.locator('.bh-pending').innerText()).includes('Time passes: 3 days'));
    await page.click('.bh-review [data-act="approve-all"]');
    await page.waitForTimeout(300);
    check('"Apply all" leaves time skips for you to preview', await page.locator('.bh-pending').count() === 1);
    await page.click('.bh-pending [data-act="skip-from"]');
    check('preview opens with the story\'s amount', await page.inputValue('#bh_s_amount') === '3' && /from the story/i.test(await page.locator('.bh-form .bh-section-title').innerText()));
    check('story preview lists what changes', (await page.locator('.bh-skip-preview').innerText()).includes('no longer muddy'));
    await page.click('[data-act="skip-apply"]');
    await page.waitForTimeout(400);
    const where = await page.evaluate(() => SillyTavern.getContext().chat.map((m, i) => ({ i, srcs: (m.extra?.body_hud?.ops || []).filter(o => o.skip).map(o => o.src) })).filter(x => x.srcs.length && x.srcs.includes('review')));
    const msgIdx = await page.evaluate(() => SillyTavern.getContext().chat.findIndex(m => m.mes.includes('Three days later')));
    check('story skip stored on its message', where.length === 1 && where[0].i === msgIdx, JSON.stringify(where));
    check('proposal resolved', await page.locator('.bh-pending').count() === 0);

    // A story time skip with nothing left to change can be dismissed.
    await sendMessage(page, reqLog, 'Three days later, nothing much has happened.');
    await idle();
    await page.click('.bh-pending [data-act="skip-from"]');
    check('nothing to change: says so and offers OK', (await page.locator('.bh-form').innerText()).includes('Nothing would change') && await page.locator('[data-act="skip-dismiss"]').count() === 1);
    await page.click('[data-act="skip-dismiss"]');
    await page.waitForTimeout(300);
    check('OK clears the proposal', await page.locator('.bh-pending').count() === 0);

    // Realism: simulation.
    await setSetting('#body_hud_realism', 'simulation');
    await addCond({ part: 'abdomen', type: 'Stab wound', sev: 'moderate', bleed: 'heavy', status: 'fresh' });
    check('note flags untreated bleeding', (await note()).includes('stab wound, moderate, heavy bleeding, untreated.'));
    preview = await skip(4, 'days');
    check('simulation: untreated wound festers, blood loss, fever', ['gets infected and worse (severe)', 'weak from blood loss', 'fever (38.9 °C)'].every(t => preview.includes(t)), preview.replace(/\n/g, ' | '));
    await page.click('.bh-form [data-act="cancel"]');
    await setSetting('#body_hud_realism', 'cinematic');
    check('cinematic: no untreated flag', !(await note()).includes('untreated'));
    preview = await skip(4, 'days');
    check('cinematic: the same wound just heals', preview.includes('Abdomen stab wound is healing') && !preview.includes('infected'));
    await page.click('.bh-form [data-act="cancel"]');
    await setSetting('#body_hud_realism', 'grounded');

    const ours = errors.filter(e => /body|hud|bh_/i.test(e));
    check('no page errors from the extension', ours.length === 0, ours.join(' | '));
    await browser.close();
    process.exit(finish());
})().catch(e => { console.error(e); process.exit(2); });
