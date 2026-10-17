// Races & features editor: make a feature and a race, use them, validation, share text.
// Usage: node dev/e2e-editor.cjs <st-url> <fake-llm-request-log> [screenshot-dir]
const path = require('path');
const { openST, makeChecker } = require('./st-page.cjs');

const url = process.argv[2] || 'http://127.0.0.1:8000/';
const shots = process.argv[4] || '.';
const { check, finish } = makeChecker();

(async () => {
    const { browser, page, errors, state } = await openST(url);
    check('extension loaded', state.loaded);
    const popup = () => page.locator('.popup:visible .bh-editor');
    const ok = () => page.click('.popup:visible .popup-button-ok');

    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.body_hud.customFeatures = { features: [], presets: [] }; });
    await page.evaluate(() => SillyTavern.getContext().selectCharacterById(0));
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(1500);
    if (!(await page.locator('#body_hud_panel').isVisible())) await page.click('#body_hud_tab');

    // Open from the race row.
    await page.click('[data-act="edit-features"]');
    await popup().waitFor();
    check('editor lists the built-in races', (await popup().innerText()).includes('Draconic'));

    // A sided feature with parts and a borrowed drawing.
    await page.click('.bh-editor [data-e="add-feature"]');
    let row = page.locator('.bh-editor [data-feature="0"]');
    await row.locator('.bh-e-fname').fill('Antenna');
    await row.locator('.bh-e-fparent').selectOption('head');
    await row.locator('.bh-e-fsided').check();
    await row.locator('.bh-e-fparts').fill('Antenna base, Antenna tip');
    await row.locator('.bh-e-fdrawing').selectOption('horns');
    // A listed-only feature.
    await page.click('.bh-editor [data-e="add-feature"]');
    row = page.locator('.bh-editor [data-feature="1"]');
    check('earlier rows keep their values after adding another', await page.locator('.bh-editor [data-feature="0"] .bh-e-fname').inputValue() === 'Antenna');
    await row.locator('.bh-e-fname').fill('Gills');
    await row.locator('.bh-e-fparent').selectOption('neck');
    await row.locator('.bh-e-fsided').check();

    // A race using it; first try saving with an empty race name.
    await page.click('.bh-editor [data-e="add-preset"]');
    await ok();
    await page.waitForTimeout(300);
    check('empty race name is refused and the editor stays open', await popup().count() === 1);
    const prow = page.locator('.bh-editor [data-preset="0"]');
    await prow.locator('.bh-e-pname').fill('Insectoid');
    await prow.locator('[data-pfeature="tail"]').check();
    const antennaId = await page.evaluate(() => document.querySelector('.bh-editor [data-feature="0"]') && [...document.querySelectorAll('.bh-editor [data-preset="0"] [data-pfeature]')].find(b => b.parentElement.textContent.includes('Antenna'))?.getAttribute('data-pfeature'));
    await prow.locator(`[data-pfeature="${antennaId}"]`).check();
    await page.screenshot({ path: path.join(shots, 'editor.png') });
    await ok();
    await page.waitForTimeout(500);
    check('saved and closed', await popup().count() === 0);

    // Use it.
    check('new race offered', (await page.locator('#bh_p_race option').allInnerTexts()).includes('Insectoid'));
    await page.selectOption('#bh_p_race', { label: 'Insectoid' });
    await page.waitForTimeout(300);
    const regions = await page.locator('.bh-m-figure').first().locator('path').evaluateAll(ps => ps.map(p => p.getAttribute('data-region')));
    check('borrowed drawing appears for the antennae', regions.includes(`left_${antennaId}`) && regions.includes(`right_${antennaId}`));
    await page.click('.bh-actions [data-act="add"]');
    const parts = (await page.locator('#bh_f_part option').allInnerTexts()).map(o => o.trim());
    await page.click('.bh-form [data-act="cancel"]');
    check('its parts can be picked', parts.includes('Left antenna tip') && parts.includes('Tail tip'));
    check('features not in the race stay hidden', !parts.includes('Left gills'));
    const gillsBox = page.locator('.bh-race .bh-feature', { hasText: 'Gills' }).locator('input');
    await gillsBox.check();
    await page.waitForTimeout(300);
    check('a race can be fine-tuned with your features too', await page.inputValue('#bh_p_race') === '');

    // Share text and import errors.
    await page.click('[data-act="edit-features"]');
    await popup().waitFor();
    check('share text contains your features', (await page.locator('.bh-e-json').inputValue()).includes('Antenna'));
    await page.fill('.bh-e-json', 'not json');
    await page.click('.bh-editor [data-e="import"]');
    await page.waitForTimeout(300);
    check('bad share text is refused', await page.locator('.bh-editor [data-feature="0"] .bh-e-fname').inputValue() === 'Antenna');
    await page.click('.popup:visible .popup-button-cancel');
    await page.waitForTimeout(300);

    const ours = errors.filter(e => /body|hud|bh_/i.test(e));
    check('no page errors from the extension', ours.length === 0, ours.join(' | '));
    await browser.close();
    process.exit(finish());
})().catch(e => { console.error(e); process.exit(2); });
