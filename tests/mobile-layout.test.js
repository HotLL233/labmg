'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');

// Run with the existing browser tooling; the application does not need a browser dependency.
const browserModule = process.env.LABOS_TEST_BROWSER_MODULE;
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'src/public');

test('real browser keeps navigation, module controls and long dialogs usable on narrow screens', {
  skip: !browserModule && 'Set LABOS_TEST_BROWSER_MODULE to an installed playwright-core package for real layout checks',
  timeout: 120000
}, async t => {
  const { chromium } = require(browserModule);
  const executablePath = process.env.LABOS_TEST_BROWSER_PATH;
  const cache = path.join(root, 'artifacts/cache', require('../package.json').version);
  fs.mkdirSync(cache, { recursive: true });
  const screenshots = fs.mkdtempSync(path.join(cache, 'mobile-layout-'));
  t.diagnostic('Layout screenshots: ' + screenshots);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  t.after(() => browser.close());
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(publicDir, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const labels = { dashboard: '工作台', archives: '资料档案', templates: '电子模板', finance: '收支管理', assets: '设备管理',
    materials: '物资管理', quality: '体系文件', contracts: '委托单位与合同', people: '人员管理', management: '管理',
    audit: '审计日志', datahub: '导出与备份', trash: '回收站' };
  const nav = Object.entries(labels).map(([target, label], index) => ({ key: target, target, label, icon: '◇', visible: 1, sort_order: index }));
  const user = { id: 1, username: 'layout-fixture', display_name: '合成人员', role: 'ADMIN', permissions: ['*'] };
  const record = module => ({ id: 1, module, version: 1, title: '用于布局检查的合成记录' + 'X'.repeat(80), code: 'SYNTHETIC-1',
    category: '', owner: '合成人员', due_date: '2026-10-19', created_at: '2026-10-19', updated_at: '2026-10-19',
    status: '草稿', amount: 20, quantity: 2, data: { asset_stage: '建档', quality_section: '质量手册', is_current: '是', access_roles: 'ADMIN' } });
  const roles = [{ role: 'ADMIN', permissions: ['*'] }, { role: 'MATERIAL', permissions: ['materials.read'] }];
  const material = { id: 1, catalogId: 1, name: '布局检查物资' + 'M'.repeat(80), code: 'SYNTHETIC-MATERIAL-1', spec: '500 mL', unit: '瓶',
    categoryId: 1, categoryName: '合成分类', regionId: 1, regionName: '合成区域', warehouse: 'MAIN', trackingMode: 'unit', qtyM: 1000, amountCents: 2000 };
  const materialLists = {
    categories: [{ id: 1, name: '合成分类', profile: 'chemical', version: 1 }], regions: [{ id: 1, name: '合成区域' }], catalog: [{ ...material, active: true, referenced: true, version: 1, casNumber: '7732-18-5', purity: '分析纯', stockQtyM: 1000, localQtyM: 1000 }],
    'storage-places': [{ id: 1, name: '合成房间', parentId: null, path: '合成房间', active: true, effectiveActive: true, version: 1 },
      { id: 2, name: '试剂柜', parentId: 1, path: '合成房间 / 试剂柜', active: true, effectiveActive: true, version: 1 }],
    'numbering-rules': ['catalog', 'request', 'opening', 'supplement'].map(kind => ({ kind, label: { catalog: '物资档案', request: '申报单', opening: '期初单', supplement: '补录单' }[kind], rule: { template: kind.toUpperCase() + '-{SEQ}', padding: 6, version: 1 }, nextSequence: 20, dateBasis: 'UTC' })),
    requests: [{ id: 101, no: 'SYNTHETIC-REQUEST-1', title: '合成申报单' + 'R'.repeat(80), creatorName: '合成人员', itemCount: 1, createdAt: '2026-10-22', status: 'draft', revision: 0 }],
    acceptance: [{ ...material, id: 201, requestId: 101, requestNo: 'SYNTHETIC-REQUEST-1', requestRevision: 1, acceptedQtyM: 0, closedQtyM: 0, remainingQtyM: 1000, receiptStatus: 'pending' }],
    stock: [{ ...material, lastMovementAt: '2026-10-22' }],
    'stock/batches': ['合成厂家甲', '合成厂家乙'].map((manufacturer, index) => ({ ...material, qtyM: (index + 1) * 1000,
      manufacturer, note: '合成批次备注' + 'N'.repeat(80), catalogRemark: '合成档案备注', totalQtyM: 3000,
      firstMovementAt: '2026-10-22T01:02:03Z', batch: 'SYNTHETIC-BATCH', expiryDate: '', location: '合成柜第2层', locationVersion: 1 })),
    'stock/manufacturers': ['合成厂家甲', '合成厂家乙'],
    issues: [{ ...material, id: 301, no: 'SYNTHETIC-ISSUE-1', creatorName: '合成人员', purpose: '合成领用用途' + 'I'.repeat(80), snapshot: material, status: 'pending', createdAt: '2026-10-22', canIssue: true, canReject: true, canCancel: true }],
    openings: [{ id: 401, no: 'SYNTHETIC-OPENING-1', title: '合成期初单' + 'O'.repeat(80), date: '2026-10-22', kind: 'opening', status: 'draft', itemCount: 1, unitCount: 0, creatorName: '合成人员', createdAt: '2026-10-22' }]
  };
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const results = {
      '/api/auth/me': { user, appVersion: require('../package.json').version }, '/api/ui-config/nav': nav,
      '/api/ui-config/dashboard': nav.map(row => ({ ...row, kind: 'module', description: '合成模块说明' })),
      '/api/dashboard': { totals: { archives: 1 }, finance: { income: 0, expense: 0 }, warnings: 0 },
      '/api/permissions': { catalog: ['archives.read'], roles, roleNames: { ADMIN: '系统管理员', MATERIAL: '物资管理员' }, sections: {} },
      '/api/users': [user], '/api/files': [{ id: 1, original_name: '长附件名' + 'Z'.repeat(80) + '.txt', size: 1 }],
      '/api/trash': [{ ...record('archives'), deleted_at: '2026-10-19' }],
      '/api/audit': [{ id: 1, created_at: '2026-10-19', display_name: '合成人员', action: 'VIEW', entity: 'records', detail: '合成日志' }],
      '/api/materials/meta': { capabilities: { createRequest: true, receive: true, createIssue: true, manageCategories: true, manageRegions: true,
        manageCatalog: true, manageLocation: true, viewAmount: true, export: true, initialize: true, adjustStock: true, issueStock: true }, warehouses: [{ code: 'MAIN', name: '默认仓库' }], openingClosed: false }
    };
    let body = results[url.pathname] ?? [];
    if (url.pathname === '/api/records') body = [record(url.searchParams.get('module'))];
    if (url.pathname.startsWith('/api/materials/') && url.pathname !== '/api/materials/meta') {
      const items = materialLists[url.pathname.slice('/api/materials/'.length)] || [];
      body = { items, total: items.length, page: 1, pageSize: Number(url.searchParams.get('pageSize')) || 50 };
      if (url.pathname === '/api/materials/unit-label-rule') body = { rule: { template: 'LAB-{YYYY}{MM}{DD}-{SEQ}', padding: 6, version: 1 }, nextSequence: 31, dateBasis: 'UTC' };
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const checkLayout = async label => {
    const result = await page.evaluate(() => {
      const width = innerWidth;
      const outside = [...document.querySelectorAll('.layout>main>header input,.layout>main>header button,#page button,#page input,#page select')]
        .filter(node => node.getClientRects().length && !node.closest('.table,.mw-table,.asset-flow,.mw-nav,.nav'))
        .filter(node => { const box = node.getBoundingClientRect(); return box.left < -1 || box.right > width + 1; })
        .map(node => ({ text: node.textContent || node.id || node.name, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }));
      // 文字被挤成多行不会触发横向溢出，却会让控件变形（如「菜单」变竖排两字），
      // 所以单独按行盒（Range 逐行矩形）判定页头控件标签是否折行。
      // 只查页头：页内卡片按钮（标题 + 副标题）本就设计为多行，不能纳入。
      const wrapped = [...document.querySelectorAll('.layout>main>header button,.layout>main>header .actions>*')]
        .filter(node => node.getClientRects().length)
        .filter(node => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rows = new Set([...range.getClientRects()]
            .filter(rect => rect.width > 0 && rect.height > 0)
            .map(rect => Math.round(rect.top)));
          return rows.size > 1;
        })
        .map(node => ({ text: (node.textContent || node.id || '').trim().slice(0, 20), id: node.id || null }));
      return { width, pageWidth: document.documentElement.scrollWidth, outside, wrapped };
    });
    assert.ok(result.pageWidth <= result.width + 1, `${label}: page overflow ${JSON.stringify(result)}`);
    assert.deepEqual(result.outside, [], `${label}: controls must remain inside the viewport`);
    assert.deepEqual(result.wrapped, [], `${label}: control labels must stay on one line`);
  };
  const navigate = async module => {
    if (page.viewportSize().width < 768) await page.locator('#menu-toggle').click();
    const button = page.locator(`.nav [data-nav="${module}"]`).first();
    await button.click();
    await page.waitForFunction(module => current === module && ![...document.querySelectorAll('#page .empty,#page .mw-empty')]
      .some(node => node.textContent.includes('正在加载')), module);
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('drawer-open')), false, 'navigation closes the drawer');
    assert.equal(await page.locator('.layout>main').evaluate(node => node.inert), false, 'navigation restores the main controls');
    return button;
  };
  const checkTables = async (label, selector = '#page .table') => {
    const tables = await page.locator(selector).evaluateAll(nodes => nodes.map(container => {
      const table = container.querySelector('table'), headers = [...table.querySelectorAll('thead th')].map(node => node.textContent.trim());
      const rows = [...table.querySelectorAll('tbody tr')].filter(row => !row.querySelector('[colspan]') && getComputedStyle(row).display !== 'none');
      return { containerWidth: container.clientWidth, scrollWidth: container.scrollWidth, tableWidth: table.getBoundingClientRect().width,
        display: getComputedStyle(table).display, headerDisplay: getComputedStyle(table.querySelector('thead')).display,
        rows: rows.map(row => ({ display: getComputedStyle(row).display, fields: [...row.children].map((cell, index) => ({
          expected: headers[index] || (index === 0 ? headers[1] : ''), label: cell.getAttribute('data-label'),
          before: getComputedStyle(cell, '::before').content, selection: cell.classList.contains('cell-select')
        })) })) };
    }));
    for (const table of tables) {
      assert.ok(table.rows.length, `${label}: fixture must exercise nonempty rows`);
      if (page.viewportSize().width < 768) {
        assert.equal(table.display, 'block', `${label}: table becomes a card list`);
        assert.equal(table.headerDisplay, 'none', `${label}: card labels replace the header`);
        assert.ok(table.scrollWidth <= table.containerWidth + 1, `${label}: cards must not scroll horizontally`);
        assert.ok(table.tableWidth <= table.containerWidth + 1, `${label}: card width stays within its container`);
        for (const row of table.rows) {
          assert.equal(row.display, 'grid', `${label}: one DOM row becomes one card`);
          for (const field of row.fields) if (!field.selection && field.expected) {
            assert.equal(field.label, field.expected, `${label}: field label comes from its header`);
            assert.equal(field.before, JSON.stringify(field.expected), `${label}: CSS displays the field label`);
          }
        }
      } else {
        assert.equal(table.display, 'table', `${label}: larger screens retain the original table`);
        assert.equal(table.headerDisplay, 'table-header-group', `${label}: larger screens retain column headings`);
      }
    }
  };
  const checkDrawer = async () => {
    await page.locator('#menu-toggle').click();
    assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#sidebar').getAttribute('aria-modal'), 'true');
    assert.equal(await page.locator('.layout>main').evaluate(node => node.inert), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'drawer-close');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.nav), 'trash', 'reverse Tab wraps to the final navigation item');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'drawer-close', 'Tab wraps to the drawer close control');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#sidebar').getAttribute('aria-modal'), null);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-toggle', 'Escape returns focus to the menu trigger');
    assert.equal(await page.locator('.layout>main').evaluate(node => node.inert), false);
    await page.locator('#menu-toggle').click();
    await page.locator('.scrim').click({ position: { x: 385, y: 300 } });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-toggle', 'scrim click returns focus');
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('drawer-open')), false);
    await page.locator('#menu-toggle').click();
    await page.setViewportSize({ width: 768, height: 844 });
    await page.waitForFunction(() => !document.body.classList.contains('drawer-open'));
    assert.equal(await page.locator('.layout>main').evaluate(node => node.inert), false, 'resizing out of drawer mode restores main interaction');
    await page.setViewportSize({ width: 390, height: 844 });
  };
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(base); await page.locator('.nav button').last().waitFor({ state: 'attached' });
    await page.evaluate(() => setupDateFilters());
    if (width === 390) await checkDrawer();
    if (width >= 768) assert.equal(await page.locator('.side').evaluate(node => node.getBoundingClientRect().width), width === 768 ? 72 : 245, `${width}px sidebar width`);
    for (const module of Object.keys(labels)) {
      const button = await navigate(module);
      await checkLayout(`${width}px ${module}`);
      await checkTables(`${width}px ${module}`);
      const fonts = module === 'finance' ? [['#page th', '13px'], ['#page td', '14px'], ['#page .pill', '13px']]
        : module === 'materials' ? [['#page .mw-badge', '13px'], ['#page .mw-toolbar label', '13px'], ['#page .mw small', '12px']] : [];
      for (const [selector, size] of fonts) assert.equal(await page.locator(selector).first().evaluate(node => getComputedStyle(node).fontSize), size, `${width}px ${selector} uses the T1 font size`);
      if (width < 900 && ['dashboard', 'archives'].includes(module)) await page.screenshot({ path: path.join(screenshots, `${width}-${module}.png`), fullPage: true });
      if (module === 'finance' && width < 900) {
        const table = page.locator('#page .table');
        if (width === 768) assert.ok(await table.evaluate(node => node.scrollWidth > node.clientWidth), 'tablet wide tables scroll inside their own container');
        else assert.ok(await table.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'phone cards do not need horizontal scrolling');
        const edit = table.locator('.ops button').nth(1);
        await edit.click();
        await page.locator('#editor').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#edit-title').textContent(), '编辑记录', 'scrolled table actions remain clickable');
        await page.evaluate(() => editor.close());
      }
      if (width < 768) {
        assert.notEqual(await button.locator('b').evaluate(node => getComputedStyle(node).display), 'none', 'mobile menus retain Chinese labels');
        assert.ok((await button.boundingBox()).height >= 44, 'navigation remains touchable');
      } else if (width === 768) {
        assert.equal(await button.locator('b').evaluate(node => getComputedStyle(node).display), 'none', 'tablet navigation is an icon rail');
        assert.ok((await button.boundingBox()).height >= 44, 'icon rail targets remain touchable');
      }
    }
    await navigate('materials');
    for (const materialPage of ['requests', 'acceptance', 'inventory', 'issues', 'openings']) {
      await page.locator(`.mw-nav [data-page="${materialPage}"]`).click();
      await page.waitForFunction(() => document.querySelector('#mw-filters') && !document.querySelector('#page .mw-empty'));
      await checkLayout(`${width}px materials ${materialPage}`);
      await checkTables(`${width}px materials ${materialPage}`);
      if (materialPage === 'inventory') {
        assert.deepEqual(await page.locator('#page .table thead th').allTextContents(), ['入库时间', '名称', '数量', '规格', '单位', '厂家', '备注']);
        assert.equal(await page.locator('.stock-group-head').count(), 0, 'stock rows retain one record per batch without repeated group headings');
        assert.equal(await page.locator('#page td.num').count(), 2, 'manufacturer detail keeps two numeric quantity rows');
        assert.deepEqual(await page.locator('#page tbody tr:not(.stock-group-head) td:nth-child(6)').allTextContents(), ['合成厂家甲', '合成厂家乙']);
        await page.locator('[data-mw="stock-detail"]').first().click();
        const details = page.locator('#mw-view');
        await details.waitFor({ state: 'visible' });
        assert.match(await details.textContent(), /合成柜第2层/);
        assert.match(await details.textContent(), /合成档案备注/);
        assert.match(await details.textContent(), /全部仓库.*区域.*3 瓶/);
        assert.equal(await details.locator('[data-mw="stock-issue"]').isVisible(), true, 'issue action remains reachable in batch details');
        await checkLayout(`${width}px expanded stock detail`);
        await details.locator('[data-mw="close-view"]').first().click();
      }
      if ([390, 1440].includes(width) && ['acceptance', 'inventory'].includes(materialPage)) await page.screenshot({ path: path.join(screenshots, `${width}-materials-${materialPage}.png`), fullPage: true });
    }
    await page.locator('.mw-nav [data-page="catalog"]').click();
    await page.locator('#page [data-mw="catalog-edit"]').waitFor();
    await checkTables(`${width}px material catalog workspace`);
    assert.ok(await page.locator('#page .table').evaluate(node => node.scrollWidth <= node.clientWidth + 1 || innerWidth >= 768), 'catalog card layout stays inside its workspace');
    assert.match(await page.locator('#page tbody td strong').first().textContent(), /布局检查物资/);
    await page.locator('#page [data-mw="catalog-edit"]').click();
    await page.locator('#mw-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#mw-fields [name="unit"]').getAttribute('readonly'), '', 'referenced catalog keeps its stock unit');
    assert.equal(await page.locator('#mw-laboratory-fields').isVisible(), true, 'chemical-category editing exposes laboratory fields');
    await page.locator('#mw-save').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#mw-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'catalog edit keeps fields inside the dialog');
    if ([390, 1440].includes(width)) await page.screenshot({ path: path.join(screenshots, `${width}-catalog-edit.png`) });
    await page.locator('#mw-dialog [data-mw="cancel"]').first().click();
    await page.locator('.mw-nav [data-page="settings"]').click();
    await page.locator('#page [data-mw="setting"][data-setting="numbering"]').click();
    await page.locator('#page [data-mw="numbering-edit"]').first().waitFor();
    await checkTables(`${width}px numbering rules workspace`);
    await page.locator('#page [data-mw="numbering-edit"]').first().click();
    await page.locator('#mw-fields [name="template"]').fill('MAT-{YYYY}-{SEQ}');
    assert.match(await page.locator('#mw-numbering-preview').textContent(), /MAT-\d{4}-000020/);
    assert.ok(await page.locator('#mw-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'numbering edit keeps preview inside the dialog');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#mw-dialog [data-mw="cancel"]').first().click();
    await page.locator('#page [data-mw="setting"][data-setting="places"]').click();
    await page.locator('#page [data-mw="place-new"]').waitFor();
    await checkTables(`${width}px storage places workspace`);
    if ([390, 1440].includes(width)) await page.screenshot({ path: path.join(screenshots, `${width}-storage-places.png`) });
    await page.locator('#page [data-mw="place-new"]').click();
    assert.match(await page.locator('#mw-fields [name="parentId"]').textContent(), /合成房间 \/ 试剂柜/);
    assert.ok(await page.locator('#mw-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'place edit remains within the dialog');
    await page.locator('#mw-dialog [data-mw="cancel"]').first().click();
    await page.locator('#page [data-mw="setting"][data-setting="numbering"]').click();
    await page.locator('#page [data-mw="label-template"]').click();
    await page.locator('#material-label-designer').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#material-label-designer table').evaluate(node => getComputedStyle(node).display), 'table', 'label design coordinates retain their table layout');
    assert.equal(await page.locator('#material-label-designer thead').evaluate(node => getComputedStyle(node).display), 'table-header-group', 'label designer does not use business card labels');
    await page.locator('#material-label-designer [data-label="close"]').click();
    for (const section of ['accounts', 'roles', 'nav', 'dashboard']) {
      await navigate('management');
      await page.locator(`[data-mcard="${section}"]`).waitFor();
      await page.locator(`[data-mcard="${section}"]`).click();
      await page.waitForFunction(() => !document.querySelector('[data-mcard]'));
      await checkLayout(`${width}px management ${section}`);
      await checkTables(`${width}px management ${section}`);
      if (width < 900 && section === 'accounts') await page.screenshot({ path: path.join(screenshots, `${width}-accounts.png`), fullPage: true });
    }
    await page.evaluate(() => go('assets')); await page.locator('#asset-add').click();
    await page.locator('#editor').waitFor({ state: 'visible' });
    const dialog = page.locator('#editor');
    await dialog.locator('[type="submit"]').scrollIntoViewIfNeeded();
    assert.ok(await dialog.locator('[type="submit"]').isVisible(), 'long form save action remains reachable');
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height + 1, `${width}px long dialog fits viewport`);
    if (width < 900) await page.screenshot({ path: path.join(screenshots, `${width}-long-form.png`) });
    await page.evaluate(() => editor.close());
    await page.evaluate(() => show(1));
    await page.locator('#detail').waitFor({ state: 'visible' });
    assert.ok(await page.locator('#detail').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'detail and long attachment names wrap');
    await page.evaluate(() => detail.close());
    await page.evaluate(() => showAuth({ setupRequired: true }));
    await page.locator('#auth-submit').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#login').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'first setup form stays within the dialog');
    await page.evaluate(() => login.close());
  }
  for (const width of [1024, 1279, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const expected = width < 1280 ? 72 : 245;
    assert.equal(await page.locator('.side').evaluate(node => node.getBoundingClientRect().width), expected, `${width}px sidebar breakpoint`);
    assert.equal(await page.locator('.layout>main').evaluate(node => node.getBoundingClientRect().left), expected, `${width}px main offset matches the sidebar`);
    await checkLayout(`${width}px breakpoint`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate('finance');
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('#editor').evaluate(node => getComputedStyle(node).maxHeight), 'none', 'screen dialog height limits do not truncate printing');
  const printTable = await page.locator('#page .table table').evaluate(table => ({
    table: getComputedStyle(table).display, head: getComputedStyle(table.querySelector('thead')).display,
    body: getComputedStyle(table.querySelector('tbody')).display, row: getComputedStyle(table.querySelector('tbody tr')).display,
    before: getComputedStyle(table.querySelector('tbody td'), '::before').content
  }));
  assert.deepEqual(printTable, { table: 'table', head: 'table-header-group', body: 'table-row-group', row: 'table-row', before: 'none' }, '390px print media retains every original column without phone card labels');
  assert.deepEqual(errors, [], 'actual module scripts run without browser errors');
});
