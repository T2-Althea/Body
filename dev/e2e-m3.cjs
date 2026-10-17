// M3 end-to-end check: mannequin, zooming into regions, adding from a part,
// states limited to an area.
// Usage: node dev/e2e-m3.cjs <st-url> <fake-llm-request-log> [screenshot-dir]
const path = require('path');
const { openST, makeChecker } = require('./st-page.cjs');

const url = process.argv[2] || 'http://127.0.0.1:8000/';
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
    const region = (view, id) => page.locator(`.bh-m-figure:has(figcaption:text-is("${view}")) path[data-region="${id}"]`);
    const centreX = async (view, id) => {
        const box = await region(view, id).boundingBox();
        const fig = await page.locator(`.bh-m-figure:has(figcaption:text-is("${view}")) svg`).boundingBox();
        return (box.x + box.width / 2) - (fig.x + fig.width / 2);
    };
    const classOf = (view, id) => region(view, id).getAttribute('class');

    await page.evaluate(() => { const s = SillyTavern.getContext().extensionSettings.body_hud; s.notePreviewOpen = true; });
    await setSetting('#body_hud_side', 'right');
    await setSetting('#body_hud_mannequin', true);
    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(1500);
    if (!(await page.locator('#body_hud_panel').isVisible())) await page.click('#body_hud_tab');
    await page.locator('.bh-member', { hasText: 'Seraphina' }).click();

    check('front and back figures drawn', await page.locator('.bh-m-figure svg').count() === 2);
    check('13 regions per figure', await page.locator('.bh-m-figure').first().locator('path').count() === 13);
    check('front view: her left leg is on the viewer\'s right', await centreX('Front', 'left_leg') > 0);
    check('back view: her left leg is on the viewer\'s left', await centreX('Back', 'left_leg') < 0);
    check('chest on front, upper back on back', await region('Front', 'chest').count() === 1 && await region('Back', 'upper_back').count() === 1 && await region('Front', 'upper_back').count() === 0);

    // Zoom into the left leg from the mannequin.
    await region('Front', 'left_leg').click();
    let text = await panelText();
    check('clicking a region zooms into its parts', /Left leg/.test(text) && ['Left thigh', 'Left knee', 'Left shin', 'Left calf', 'Left foot'].every(p => text.includes(p)), text.slice(0, 200));
    check('mannequin replaced by the zoom view', await page.locator('.bh-m-figure').count() === 0);

    // Add from a part's "+".
    await page.locator('.bh-zrow:has(.bh-zname:text-is("Left thigh")) .bh-zadd').click();
    check('form opens with the part preselected', await page.inputValue('#bh_f_part') === 'left_thigh');
    check('kind is "On a body part"', (await page.locator('#bh_f_kind option:checked').innerText()) === 'On a body part');
    await page.fill('#bh_f_type', 'Arrow wound');
    await page.selectOption('#bh_f_sev', 'severe');
    await page.click('[data-act="save"]');
    await page.waitForTimeout(300);
    check('zoom view shows it on the thigh', await page.locator('.bh-zrow:has(.bh-zname:text-is("Left thigh")) .bh-zchip', { hasText: 'Arrow wound' }).count() === 1);
    await page.screenshot({ path: path.join(shots, 'm3-zoom.png') });

    // Nested region link, then add a missing part on the right foot.
    await page.click('.bh-zoom-head [data-act="zoom"]');
    await region('Front', 'right_leg').click();
    await page.click('.bh-zlink:has-text("Right foot")');
    check('nested region link zooms further', (await page.locator('.bh-zoom-head b').innerText()) === 'Right foot');
    await page.locator('.bh-zrow:has(.bh-zname:text-is("Right foot (general)")) .bh-zadd').click();
    await page.selectOption('#bh_f_kind', 'missing');
    await page.click('[data-act="save"]');
    await page.waitForTimeout(300);
    check('missing foot greys out its parts', await page.locator('.bh-zrow.bh-zmissing').count() >= 5);
    await page.click('.bh-zoom-head [data-act="zoom"]');
    check('back arrow goes up to the parent region', (await page.locator('.bh-zoom-head b').innerText()) === 'Right leg');
    await page.click('.bh-zoom-head [data-act="zoom"]');
    check('and then back to the full body', await page.locator('.bh-m-figure').count() === 2);

    // Mannequin colouring and tooltip.
    check('left leg tinted severe on both views', /bh-m-severe/.test(await classOf('Front', 'left_leg')) && /bh-m-severe/.test(await classOf('Back', 'left_leg')));
    check('right leg untinted', !/bh-m-(minor|moderate|severe|critical)/.test(await classOf('Front', 'right_leg')));
    check('right foot shown as missing', /bh-m-missing/.test(await classOf('Front', 'right_foot')));
    const tip = await region('Front', 'left_leg').locator('title').textContent();
    check('hover tooltip lists the condition', tip.includes('Left thigh: Arrow wound (severe)'), tip);

    // Whole-body state narrowed to an area.
    await page.click('.bh-actions [data-act="add"]');
    await page.selectOption('#bh_f_kind', 'state');
    check('state form offers an optional area', await page.locator('.bh-f-part').isVisible() && (await page.locator('.bh-f-part-label').innerText()) === 'Area (optional)');
    await page.fill('#bh_f_type', 'Wet');
    await page.selectOption('#bh_f_part', 'left_foot');
    await page.click('[data-act="save"]');
    await page.waitForTimeout(300);
    text = await panelText();
    check('state chip names the area', text.includes('Wet · Left foot'));
    check('note says where the state applies', (await page.locator('.bh-note-text').innerText()).includes('- States: wet (left foot).'));
    await page.click('.bh-actions [data-act="add"]');
    await page.selectOption('#bh_f_kind', 'state');
    await page.fill('#bh_f_type', 'Exhausted');
    await page.click('[data-act="save"]');
    await page.waitForTimeout(300);
    check('state without an area is whole-body', (await panelText()).includes('Exhausted') && !(await panelText()).includes('Exhausted ·'));
    await page.screenshot({ path: path.join(shots, 'm3-mannequin.png') });

    // Mind conditions don't tint the head.
    await page.click('.bh-actions [data-act="add"]');
    await page.selectOption('#bh_f_kind', 'mind_current');
    await page.fill('#bh_f_type', 'Panicked');
    await page.selectOption('#bh_f_sev', 'critical');
    await page.click('[data-act="save"]');
    await page.waitForTimeout(300);
    check('mind state does not tint the head', !/bh-m-critical/.test(await classOf('Front', 'head')));

    // Setting to hide the mannequin.
    await setSetting('#body_hud_mannequin', false);
    check('mannequin can be hidden', await page.locator('.bh-m-figure').count() === 0);
    await setSetting('#body_hud_mannequin', true);

    const ours = errors.filter(e => /body|hud|bh_/i.test(e));
    check('no page errors from the extension', ours.length === 0, ours.join(' | '));
    await browser.close();
    process.exit(finish());
})().catch(e => { console.error(e); process.exit(2); });
