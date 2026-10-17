// Condition form redesign: four categories, per-category fields, the progress
// block, natural states by sex, status effects, pain, ✨ for What and pain,
// durations in replies and in time, and old records still opening correctly.
// Usage: node dev/e2e-form.cjs <st-url> <fake-llm-request-log> [screenshot-dir]
const fs = require('fs');
const path = require('path');
const { openST, makeChecker, sendMessage } = require('./st-page.cjs');

const url = process.argv[2] || 'http://127.0.0.1:8000/';
const reqLog = process.argv[3];
const shots = process.argv[4] || '.';
const { check, finish } = makeChecker();

(async () => {
    const { browser, page, errors, state } = await openST(url, { viewport: { width: 1600, height: 1100 } });
    check('extension loaded', state.loaded);
    const panelText = () => page.locator('#body_hud_panel .bh-content').innerText();
    const note = () => page.locator('.bh-note-text').innerText().catch(() => '');
    const visible = sel => page.locator(sel).first().isVisible();
    const setSetting = (sel, value) => page.evaluate(([s, v]) => {
        const el = document.querySelector(s);
        if (el.type === 'checkbox') el.checked = v; else el.value = String(v);
        el.dispatchEvent(new Event('change'));
    }, [sel, value]);
    const idle = async () => {
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#body_hud_busy')).display === 'none', null, { timeout: 30000 });
        await page.waitForTimeout(300);
    };
    const datalist = sel => page.locator(`${sel} option`).evaluateAll(os => os.map(o => o.value));
    const open = async () => { await page.click('.bh-actions [data-act="add"]'); await page.waitForTimeout(150); };
    const cat = async (c, sub) => {
        await page.click(`.bh-cat[data-cat="${c}"]`);
        if (sub) await page.click(`.bh-sub[data-sub="${sub}"]`);
    };
    const save = async () => { await page.click('.bh-form [data-act="save"]'); await page.waitForTimeout(300); };
    const lastKinds = () => page.evaluate(() => {
        const chat = SillyTavern.getContext().chat;
        return (chat[chat.length - 1].extra?.body_hud?.ops || []).filter(o => o.t === 'add').map(o => `${o.cond.type}:${o.cond.kind}`);
    });

    await setSetting('#body_hud_side', 'right');
    await setSetting('#body_hud_detect_mode', 'manual');
    await setSetting('#body_hud_realism', 'grounded');
    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.body_hud.notePreviewOpen = true; });
    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(1500);
    if (!(await page.locator('#body_hud_panel').isVisible())) await page.click('#body_hud_tab');
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();
    await page.selectOption('#bh_p_sex', 'female');
    await page.waitForTimeout(200);

    // 1. Categories and what each one shows.
    await open();
    check('four category buttons', (await page.locator('.bh-cat').allInnerTexts()).join('|') === 'Body|Mind|Status effect|Mark');
    check('opens on Body → On the body', (await page.locator('.bh-cat.bh-active').innerText()) === 'Body' && (await page.locator('.bh-sub.bh-active').innerText()) === 'On the body');
    check('whole body: no bleeding or status, has severity, pain, ends', !(await visible('.bh-f-bleed')) && !(await visible('.bh-f-status'))
        && await visible('.bh-f-sev') && await visible('.bh-f-pain') && await visible('.bh-f-ends'));
    await page.selectOption('#bh_f_part', 'left_thigh');
    check('on a part: bleeding and status appear in the progress block', await visible('.bh-progress .bh-f-bleed') && await visible('.bh-progress .bh-f-status'));
    check('a wound can\'t end "after a time" (time skips heal it)', !(await page.locator('#bh_f_ends option[value="time"]').isVisible().catch(() => false))
        && await page.locator('#bh_f_ends option[value="time"]').evaluate(o => o.style.display === 'none'));
    await page.selectOption('#bh_f_ends', 'replies');
    check('reply duration on a wound: "replies from Seraphina" and heal-or-clear', await visible('.bh-f-endwho') && (await page.locator('.bh-f-endwho-text').innerText()) === 'replies from Seraphina' && await visible('.bh-f-endthen'));
    await page.screenshot({ path: path.join(shots, 'form-body.png'), clip: await page.locator('.bh-form').boundingBox() });

    await cat('body', 'missing');
    check('missing part: part and status, no What, no duration', await visible('.bh-f-part') && await visible('.bh-f-status') && !(await visible('.bh-f-type')) && !(await visible('.bh-f-ends')));

    await cat('body', 'natural');
    check('natural: What and Stage, no severity/bleeding/status', await visible('.bh-f-type') && await visible('.bh-f-stage')
        && !(await visible('.bh-f-sev')) && !(await visible('.bh-f-bleed')) && !(await visible('.bh-f-status')) && !(await visible('.bh-f-part')));
    let names = await datalist('#bh_types');
    check('female body: female and shared natural states, no male ones', names.includes('Pregnancy') && names.includes('Period') && names.includes('Heat') && !names.includes('Andropause'), names.join(', '));
    await page.fill('#bh_f_type', 'Pregnancy');
    await page.dispatchEvent('#bh_f_type', 'change');
    check('pregnancy offers trimester stages', (await datalist('#bh_stages')).includes('Second trimester'));

    await cat('mind');
    check('mind: Current / Lasting toggle, no part, no pain', (await page.locator('.bh-subs[data-for="mind"] .bh-sub').allInnerTexts()).join('|') === 'Current (passes)|Lasting'
        && !(await visible('.bh-f-part')) && !(await visible('.bh-f-pain')) && await visible('.bh-f-sev'));

    await cat('effect');
    const sevLabels = await page.locator('#bh_f_sev option').allInnerTexts();
    check('status effect: Intensity (Mild…Overwhelming), pain, no part', (await page.locator('.bh-f-sev-label').innerText()) === 'Intensity'
        && sevLabels.join('|') === 'Mild|Moderate|Strong|Overwhelming' && await visible('.bh-f-pain') && !(await visible('.bh-f-part')));

    await cat('mark');
    check('mark: part and Lasts, no progress block', await visible('.bh-f-part') && await visible('.bh-f-lasts') && !(await visible('.bh-progress')));
    await page.click('.bh-form [data-act="cancel"]');

    // Male body: different natural states.
    await page.selectOption('#bh_p_sex', 'male');
    await page.waitForTimeout(200);
    await open();
    await cat('body', 'natural');
    names = await datalist('#bh_types');
    check('male body: andropause and rut, no pregnancy', names.includes('Andropause') && names.includes('Rut') && !names.includes('Pregnancy'), names.join(', '));
    await page.click('.bh-form [data-act="cancel"]');
    await page.selectOption('#bh_p_sex', 'female');
    await page.waitForTimeout(200);

    // 2. A status effect that ends after 2 of Seraphina's replies.
    await open();
    await cat('effect');
    await page.fill('#bh_f_type', 'Poisoned');
    await page.selectOption('#bh_f_sev', 'severe');
    await page.selectOption('#bh_f_pain', 'moderate');
    await page.selectOption('#bh_f_ends', 'replies');
    await page.fill('#bh_f_endn', '2');
    await page.fill('#bh_f_effect', 'Dizzy and sweating');
    await page.screenshot({ path: path.join(shots, 'form-effect.png'), clip: await page.locator('.bh-form').boundingBox() });
    await save();
    let text = await panelText();
    check('effect listed under Status effects with intensity, pain and countdown', /Status effects/i.test(text) && text.includes('Poisoned')
        && text.includes('Strong') && text.includes('pain: moderate') && text.includes('ends in 2 replies from Seraphina'), text.slice(0, 300));
    check('effect in the AI note', (await note()).includes('- Effect: poisoned, strong, moderate pain. Dizzy and sweating.'));

    // 3. Natural state with a stage.
    await open();
    await cat('body', 'natural');
    await page.fill('#bh_f_type', 'Pregnancy');
    await page.fill('#bh_f_stage', 'Second trimester');
    await save();
    text = await panelText();
    check('natural state listed with its stage', /Natural/.test(text) && text.includes('Pregnancy (second trimester)'));
    check('natural state in the note', (await note()).includes('- Natural: pregnancy, second trimester.'));

    // 4. Body: a state on an area stays a state, a cut becomes a wound.
    await open();
    await page.selectOption('#bh_f_part', 'left_arm');
    await page.fill('#bh_f_type', 'Muddy');
    await save();
    await open();
    await page.selectOption('#bh_f_part', 'left_forearm');
    await page.fill('#bh_f_type', 'Cut');
    await page.selectOption('#bh_f_pain', 'mild');
    await save();
    const kinds = await lastKinds();
    check('body state on an area is stored as a state, a cut as a wound', kinds.includes('Muddy:state') && kinds.includes('Cut:injury'), kinds.join(', '));
    check('pain shows in the wound\'s note line', /Left forearm: cut, moderate, mild pain\./.test(await note()));

    // 5. ✨ for What and pain.
    await open();
    await page.selectOption('#bh_f_part', 'right_hand');
    await page.click('.bh-fill[data-field="type"]');
    await idle();
    check('✨ suggests What even when it is empty', await page.inputValue('#bh_f_type') === 'Sprained wrist');
    await page.click('.bh-fill[data-field="pain"]');
    await idle();
    check('✨ picks a pain level', await page.inputValue('#bh_f_pain') === 'moderate');
    const tasks = fs.readFileSync(reqLog + '.tasks', 'utf8').trim().split('\n').slice(-2).map(l => JSON.stringify(JSON.parse(l).messages));
    check('What request asks only for a type, with the part', tasks[0].includes('\\"type\\": \\"\\"') && !tasks[0].includes('\\"effect\\": \\"\\"') && tasks[0].includes('part: Right hand'));
    check('pain request includes the suggested condition', tasks[1].includes('Sprained wrist') && tasks[1].includes('\\"pain\\": \\"\\"'));
    await page.click('.bh-form [data-act="cancel"]');

    // 6. A time duration, worn off by a time skip.
    await open();
    await cat('effect');
    await page.fill('#bh_f_type', 'Blessed');
    await page.selectOption('#bh_f_sev', 'minor');
    await page.selectOption('#bh_f_ends', 'time');
    await page.fill('#bh_f_endn', '2');
    await page.selectOption('#bh_f_endunit', 'days');
    await save();
    check('time duration shows as days left', (await panelText()).includes('~2 days left'));
    await page.click('.bh-actions [data-act="skip"]');
    await page.fill('#bh_s_amount', '3');
    await page.selectOption('#bh_s_unit', 'days');
    await page.click('[data-act="skip-preview"]');
    await page.waitForTimeout(200);
    const preview = await page.locator('.bh-skip-preview').innerText();
    check('time skip wears the effect off; the reply-counted one isn\'t touched', preview.includes('Blessed has worn off') && !preview.includes('Poisoned'), preview);
    await page.click('.bh-form [data-act="cancel"]');
    await page.screenshot({ path: path.join(shots, 'form-list.png') });

    // 7. Old records still open in the right category.
    await page.evaluate(() => {
        const c = SillyTavern.getContext();
        const msg = c.chat[c.chat.length - 1];
        const who = 'c:' + c.characters[c.characterId].avatar;
        msg.extra.body_hud.ops.push({ t: 'add', who, src: 'manual', oid: 'old1', cond: { id: 'old1', kind: 'mind_lasting', part: 'brain', type: 'Fear of fire', severity: 'moderate', status: null, effect: '', details: '', cause: '', hidden: false } });
    });
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();
    await page.click('[data-act="edit"][data-id="old1"]');
    check('old lasting-mind record opens as Mind → Lasting', (await page.locator('.bh-cat.bh-active').innerText()) === 'Mind' && (await page.locator('.bh-sub.bh-active').innerText()) === 'Lasting'
        && await page.inputValue('#bh_f_type') === 'Fear of fire');
    await page.click('.bh-form [data-act="cancel"]');
    await page.click('.bh-chip:has-text("Muddy")');
    check('old-style area state opens as Body with its area', (await page.locator('.bh-cat.bh-active').innerText()) === 'Body' && await page.inputValue('#bh_f_part') === 'left_arm');
    await save();
    check('saving it keeps it a state', (await lastKinds()).includes('Muddy:state'));

    // Temperature always visible; whole-body chips and the edit form can remove.
    check('temperature always shown, "normal" when not set', /🌡 .* · normal/.test(await page.locator('.bh-chip.bh-temp').innerText()));
    await page.screenshot({ path: path.join(shots, 'form-chips.png'), clip: await page.locator('.bh-chips').boundingBox() });
    await page.click('.bh-chip:has-text("Muddy") .bh-chip-x');
    await page.waitForTimeout(300);
    check('× on a whole-body chip removes it', !(await panelText()).includes('Muddy'));
    await page.click('[data-act="edit"][data-id="old1"]');
    await page.click('.bh-form [data-act="remove"]');
    await page.waitForTimeout(300);
    check('Remove button in the edit form', !(await panelText()).includes('Fear of fire') && !(await page.locator('.bh-form').count()));

    // 8. Reply countdown follows the chat.
    await sendMessage(page, reqLog, 'We walk on in silence.');
    check('one of her replies counted', (await panelText()).includes('ends in 1 reply from Seraphina'));
    await sendMessage(page, reqLog, 'Still walking.');
    text = await panelText();
    check('poison gone after her second reply', !text.includes('Poisoned') && !(await note()).includes('poisoned'));
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/del 1'));
    await page.waitForTimeout(800);
    check('deleting her last reply brings it back (derived from the chat)', (await panelText()).includes('ends in 1 reply from Seraphina'));

    check('no page errors', !errors.length, errors.join(' | '));
    await browser.close();
    process.exit(finish());
})().catch(e => { console.error(e); process.exit(1); });
