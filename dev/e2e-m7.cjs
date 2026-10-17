// M7 end-to-end check: NPC bodies (manual and detected) and race features.
// Usage: node dev/e2e-m7.cjs <st-url> <fake-llm-request-log> [screenshot-dir]
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
    const members = () => page.locator('#body_hud_panel .bh-member:not([data-act])').allInnerTexts();
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
    const partOptions = async () => {
        await page.click('.bh-actions [data-act="add"]');
        const opts = (await page.locator('#bh_f_part option').allInnerTexts()).map(o => o.trim());
        await page.click('.bh-form [data-act="cancel"]');
        return opts;
    };
    // Clicks a point that is really inside an SVG shape (the middle of a curved
    // shape's bounding box can be empty space).
    const clickShape = async locator => {
        const pt = await locator.evaluate(p => {
            const b = p.getBBox();
            const svg = p.ownerSVGElement;
            for (let i = 1; i < 20; i++) for (let j = 1; j < 20; j++) {
                const sp = svg.createSVGPoint();
                sp.x = b.x + (b.width * i) / 20;
                sp.y = b.y + (b.height * j) / 20;
                if (p.isPointInFill(sp)) {
                    const s = sp.matrixTransform(p.getScreenCTM());
                    if (document.elementFromPoint(s.x, s.y) === p) return { x: s.x, y: s.y };
                }
            }
            return null;
        });
        await page.mouse.click(pt.x, pt.y);
    };
    const backRegions = () => page.locator('.bh-m-figure:has(figcaption:text-is("Back")) path').evaluateAll(ps => ps.map(p => p.getAttribute('data-region')));

    await setSetting('#body_hud_side', 'right');
    await setSetting('#body_hud_detect_mode', 'ask');
    await setSetting('#body_hud_detect_npcs', true);
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
    check('character selected by default', (await page.locator('.bh-member.bh-active').innerText()).includes('Seraphina'));

    // ----- Races -----
    check('race defaults to Human', await page.inputValue('#bh_p_race') === 'human');
    let parts = await partOptions();
    check('no horn/tail/wing parts on a human', !parts.some(p => /horn|tail|wing/i.test(p)));
    await page.selectOption('#bh_p_race', 'draconic');
    await page.waitForTimeout(300);
    let regions = await backRegions();
    check('draconic: horns, tail and wings on the mannequin', ['left_horn', 'right_horn', 'tail', 'left_wing', 'right_wing'].every(r => regions.includes(r)));
    check('wings drawn behind the body', regions[0].endsWith('wing'));
    parts = await partOptions();
    check('draconic: their parts can be picked', ['Left horn', 'Tail tip', 'Right wing', 'Wing bone'].some(p => parts.some(x => x.includes(p))) && parts.includes('Tail tip'));
    await page.screenshot({ path: path.join(shots, 'm7-draconic.png') });

    // Fine-tune with a checkbox: drop the wings → Demon preset.
    await page.locator('.bh-feature input[data-feature="wings"]').uncheck();
    await page.waitForTimeout(300);
    check('unchecking wings matches the Demon preset', await page.inputValue('#bh_p_race') === 'demon');
    check('wings gone', !(await backRegions()).some(r => r.endsWith('wing')));
    await page.locator('.bh-feature input[data-feature="pointed_ears"]').check();
    await page.waitForTimeout(300);
    check('unusual mix shows as Custom', await page.inputValue('#bh_p_race') === '');

    // Wound on the tail shows up everywhere.
    await clickShape(page.locator('.bh-m-figure:has(figcaption:text-is("Back")) path[data-region="tail"]'));
    check('tail zooms into its parts', (await panelText()).includes('Tail tip'));
    await page.locator('.bh-zrow:has(.bh-zname:text-is("Tail tip")) .bh-zadd').click();
    await page.fill('#bh_f_type', 'Burn');
    await page.selectOption('#bh_f_sev', 'severe');
    await page.click('.bh-form [data-act="save"]');
    await page.waitForTimeout(300);
    await page.click('.bh-zoom-head [data-act="zoom"]');
    check('back from the tail goes to its parent region, the pelvis', (await page.locator('.bh-zoom-head b').innerText()) === 'Pelvis');
    await page.click('.bh-zoom-head [data-act="zoom"]');
    check('tail tinted', /bh-m-severe/.test(await page.locator('path[data-region="tail"]').first().getAttribute('class')));
    check('tail wound in the note', (await note()).includes('Tail tip: burn, severe'));
    check('race saved per character', await page.evaluate(() => Object.values(SillyTavern.getContext().extensionSettings.body_hud.profiles).some(p => (p.features || []).includes('tail'))));

    // ----- NPCs -----
    await page.click('[data-act="npc-new"]');
    await page.fill('#bh_n_name', 'Grey wolf');
    await page.selectOption('#bh_n_race', 'beastfolk_tail');
    await page.click('[data-act="npc-save"]');
    await page.waitForTimeout(400);
    check('NPC added and selected', (await members()).some(m => m.includes('Grey wolf') && m.includes('NPC')) && (await page.locator('.bh-member.bh-active').innerText()).includes('Grey wolf'));
    check('NPC has its race', await page.inputValue('#bh_p_race') === 'beastfolk_tail');
    await page.click('.bh-actions [data-act="add"]');
    await page.selectOption('#bh_f_part', 'right_leg');
    await page.fill('#bh_f_type', 'Gash');
    await page.click('.bh-form [data-act="save"]');
    await page.waitForTimeout(300);
    check('NPC in the AI note', (await note()).includes('Grey wolf:') && (await note()).includes('Right leg: gash'));
    const stored = await page.evaluate(() => SillyTavern.getContext().chat.flatMap(m => m.extra?.body_hud?.ops || []).some(o => o.t === 'npc_add' && o.who === 'n:grey_wolf'));
    check('NPC stored in the chat', stored);

    await page.click('[data-act="npc-leave"]');
    await page.waitForTimeout(400);
    check('leaving removes them from the scene and the note', !(await members()).some(m => m.includes('Grey wolf')) && !(await note()).includes('Grey wolf'));
    check('listed under "Left the scene"', (await page.locator('.bh-away').innerText()).includes('Grey wolf'));
    await page.click('.bh-away [data-act="npc-return"]');
    await page.waitForTimeout(400);
    check('bringing them back keeps their wound', (await members()).some(m => m.includes('Grey wolf')) && (await panelText()).includes('Right leg: Gash'));

    // Detection proposes a new NPC.
    await sendMessage(page, reqLog, 'Seraphina punches the guard in the face.');
    await idle();
    const prop = await page.locator('.bh-pending').innerText().catch(() => '');
    check('detection proposes a new NPC', prop.includes('New NPC The guard: Broken nose'), prop.replace(/\n/g, ' | '));
    await page.locator('.bh-pending [data-act="approve"]').click();
    await page.waitForTimeout(400);
    check('approving adds the NPC with the injury', (await members()).some(m => m.includes('The guard')) && (await note()).includes('The guard:'));
    await page.screenshot({ path: path.join(shots, 'm7-npcs.png') });

    // Time skips include NPCs.
    await page.click('.bh-actions [data-act="skip"]');
    await page.fill('#bh_s_amount', '7');
    await page.click('[data-act="skip-preview"]');
    await page.waitForTimeout(200);
    check('time skip covers NPCs too', (await page.locator('.bh-skip-preview').innerText()).includes('The guard:'));
    await page.click('.bh-form [data-act="cancel"]');

    const ours = errors.filter(e => /body|hud|bh_/i.test(e));
    check('no page errors from the extension', ours.length === 0, ours.join(' | '));
    await browser.close();
    process.exit(finish());
})().catch(e => { console.error(e); process.exit(2); });
