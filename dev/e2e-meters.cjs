// Meters: bars next to the temperature, per-character choice, the quick level
// picker, the AI note (words only), time-skip recovery, detection proposals,
// and the meter editor.
// Usage: node dev/e2e-meters.cjs <st-url> <fake-llm-request-log> [screenshot-dir]
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
    const meterNames = () => page.locator('.bh-meter .bh-meter-name').allInnerTexts();
    const levelOf = name => page.locator('.bh-meter', { has: page.locator('.bh-meter-name', { hasText: name }) }).locator('.bh-meter-level').innerText();
    const setLevel = async (name, level) => {
        await page.locator('.bh-meter', { has: page.locator('.bh-meter-name', { hasText: name }) }).click();
        await page.locator('.bh-level', { has: page.locator('b', { hasText: level }) }).first().click();
        await page.waitForTimeout(300);
    };
    const setSetting = (sel, value) => page.evaluate(([s, v]) => {
        const el = document.querySelector(s);
        if (el.type === 'checkbox') el.checked = v; else el.value = String(v);
        el.dispatchEvent(new Event('change'));
    }, [sel, value]);
    const idle = async () => {
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#body_hud_busy')).display === 'none', null, { timeout: 30000 });
        await page.waitForTimeout(500);
    };

    await setSetting('#body_hud_side', 'right');
    await setSetting('#body_hud_detect_mode', 'manual');
    await setSetting('#body_hud_realism', 'grounded');
    await page.evaluate(() => {
        const s = SillyTavern.getContext().extensionSettings.body_hud;
        s.notePreviewOpen = true;
        s.customMeters = null;
    });
    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(1500);
    if (!(await page.locator('#body_hud_panel').isVisible())) await page.click('#body_hud_tab');
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();

    // 1. Default meters, mana off.
    check('default meters shown next to the temperature', (await meterNames()).join('|') === 'Hunger|Thirst|Sleep|Stamina' && await page.locator('.bh-chips .bh-temp').count() === 1);
    check('all comfortable: nothing in the note, no alert', (await levelOf('Hunger')) === 'Fed' && !(await note()) && !(await page.locator('#body_hud_tab.bh-alert').count()));

    // 2. Mana only for casters.
    await page.locator('.bh-meter-pick', { hasText: 'Mana saturation' }).locator('input').check();
    await page.locator('.bh-meter-pick', { hasText: /^\s*Mana\s*$/ }).locator('input').check();
    await page.waitForTimeout(300);
    check('turning Mana on adds its bar', (await meterNames()).includes('Mana') && (await meterNames()).includes('Mana saturation'));
    await page.locator('.bh-meter-pick', { hasText: 'Mana saturation' }).locator('input').uncheck();
    await page.waitForTimeout(300);
    check('choice saved for the character', await page.evaluate(() => Object.values(SillyTavern.getContext().extensionSettings.body_hud.profiles).some(p => p.meters?.includes('mana') && !p.meters.includes('mana_saturation'))));
    await page.locator('.bh-member', { hasText: 'User' }).click();
    check('the persona keeps the defaults', !(await meterNames()).includes('Mana'));
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();

    // 3. Quick picker.
    await page.locator('.bh-meter', { has: page.locator('.bh-meter-name', { hasText: 'Hunger' }) }).click();
    check('picker lists every level with its effect', (await page.locator('.bh-level b').allInnerTexts()).join('|') === 'Fed|Peckish|Hungry|Starving'
        && (await page.locator('.bh-level').nth(2).innerText()).includes('Stomach growls'));
    await page.screenshot({ path: path.join(shots, 'meters-picker.png'), clip: await page.locator('.bh-form').boundingBox() });
    await page.locator('.bh-level', { has: page.locator('b', { hasText: 'Hungry' }) }).click();
    await page.waitForTimeout(300);
    check('bar shows the new level', (await levelOf('Hunger')) === 'Hungry' && await page.locator('.bh-meter.bh-tone-moderate').count() === 1);
    check('note says it in words', (await note()).includes('- Hunger: hungry. Stomach growls; harder to focus.'));
    check('tab shows the alert dot', await page.locator('#body_hud_tab.bh-alert').count() === 1);
    await setLevel('Mana', 'The ring');
    await setLevel('Sleep', 'Tired');
    const text = await note();
    check('mana warning in the note, no figures', text.includes('- Mana: the ring. Muffled hearing') && !/\d/.test(text.split('\n').filter(l => /Mana|Hunger|Sleep/.test(l)).join(' ')));
    const stored = await page.evaluate(() => {
        const chat = SillyTavern.getContext().chat;
        return (chat[chat.length - 1].extra?.body_hud?.ops || []).filter(o => o.t === 'meter').map(o => `${o.id}=${o.level}`);
    });
    check('levels are stored in the chat', stored.join(',') === 'hunger=2,mana=3,sleep=1', stored.join(','));
    await page.screenshot({ path: path.join(shots, 'meters-bars.png'), clip: await page.locator('.bh-chips').locator('..').boundingBox() });

    // 4. Time skip: six hours.
    await page.click('.bh-actions [data-act="skip"]');
    await page.fill('#bh_s_amount', '6');
    await page.selectOption('#bh_s_unit', 'hours');
    await page.click('[data-act="skip-preview"]');
    await page.waitForTimeout(200);
    const preview = await page.locator('.bh-skip-preview').innerText();
    check('preview: meters recover', preview.includes('hunger hungry → peckish') && preview.includes('mana the ring → full') && preview.includes('sleep tired → rested'), preview);
    await page.click('[data-act="skip-apply"]');
    await page.waitForTimeout(400);
    check('applied', (await levelOf('Hunger')) === 'Peckish' && (await levelOf('Mana')) === 'Full');

    // 5. Detection proposes meter changes.
    await setSetting('#body_hud_detect_mode', 'ask');
    await sendMessage(page, reqLog, 'Seraphina eats the bread, then casts a spell.');
    await idle();
    const pending = await page.locator('.bh-pending').allInnerTexts();
    check('detection proposes hunger and mana changes', pending.some(p => p.includes('hunger → fed')) && pending.some(p => p.includes('mana → the ring')), pending.join(' / '));
    await page.click('[data-act="approve-all"]');
    await page.waitForTimeout(400);
    check('approved', (await levelOf('Hunger')) === 'Fed' && (await levelOf('Mana')) === 'The ring');
    await setSetting('#body_hud_detect_mode', 'manual');

    // 6. The meter editor.
    await page.evaluate(() => $('#body_hud_edit_meters').trigger('click'));
    await page.waitForSelector('.bh-meter-editor textarea');
    const original = await page.inputValue('.bh-meter-editor textarea');
    check('editor shows the meters as JSON', original.includes('"Starving"'));
    await page.fill('.bh-meter-editor textarea', '{ not json');
    await page.click('.popup:has(.bh-meter-editor) .popup-button-ok');
    await page.waitForTimeout(300);
    check('invalid JSON is refused and the editor stays open', await page.locator('.bh-meter-editor').isVisible());
    const edited = JSON.parse(original);
    edited.meters.push({ id: 'blood_thirst', name: 'Blood thirst', default: false, recoverHours: 6, levels: [{ name: 'Sated', effect: '' }, { name: 'Craving', effect: 'Stares at throats' }] });
    await page.fill('.bh-meter-editor textarea', JSON.stringify(edited, null, 2));
    await page.screenshot({ path: path.join(shots, 'meters-editor.png') });
    await page.click('.popup:has(.bh-meter-editor) .popup-button-ok');
    await page.waitForTimeout(500);
    check('a new meter can be added', (await page.locator('.bh-meter-pick').allInnerTexts()).some(t => t.includes('Blood thirst')) && !(await meterNames()).includes('Blood thirst'));
    await page.locator('.bh-meter-pick', { hasText: 'Blood thirst' }).locator('input').check();
    await page.waitForTimeout(300);
    await setLevel('Blood thirst', 'Craving');
    check('custom meter works in the note', (await note()).includes('- Blood thirst: craving. Stares at throats.'));
    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.body_hud.customMeters = null; });

    check('no page errors', !errors.length, errors.join(' | '));
    await browser.close();
    process.exit(finish());
})().catch(e => { console.error(e); process.exit(1); });
