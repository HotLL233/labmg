'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { createTestDatabase } = require('./helpers/postgres');

const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const browserModule = process.env.LABOS_TEST_BROWSER_MODULE;

test('production workspace keeps identity, records, returns and draft inputs usable with real PostgreSQL', {
  skip: (!browserModule || !process.env.LABOS_TEST_DATABASE_URL) && 'Set LABOS_TEST_BROWSER_MODULE and LABOS_TEST_DATABASE_URL for real workspace checks',
  timeout: 420000
}, async t => {
  const database = await createTestDatabase(t);
  const cache = process.env.LABOS_TEST_CACHE_DIR || path.join(root, 'artifacts/cache', version);
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'workspace-layout-'));
  const runtime = path.join(directory, 'runtime');
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'src/server.js')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: database.url, PORT: String(port), LABOS_RUNTIME_DIR: runtime,
      LABOS_ADMIN_USER: 'workspace-admin', LABOS_ADMIN_PASSWORD: 'synthetic-workspace-password' }
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    assert.equal(path.dirname(path.resolve(runtime)), path.resolve(directory));
    fs.rmSync(runtime, { recursive: true, force: true });
  });
  const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(15000) });
  assert.match(String(output), /LabOS:/, stderr);
  const base = `http://127.0.0.1:${port}`;
  let cookie;
  const api = async (method, endpoint, body, expected = 200) => {
    const response = await fetch(base + endpoint, { method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${endpoint}: ${JSON.stringify(result)}`);
    return { data: result, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  cookie = (await api('POST', '/api/auth/login', { username: 'workspace-admin', password: 'synthetic-workspace-password' })).cookie;
  await api('POST', '/api/users', { username: 'workspace-manager', display_name: '合成物资管理员', roles: ['ADMIN', 'MATERIAL'], password: 'synthetic-manager-password' }, 201);
  cookie = (await api('POST', '/api/auth/login', { username: 'workspace-manager', password: 'synthetic-manager-password' })).cookie;
  const category = (await api('POST', '/api/materials/categories', { name: '合成试剂分类', profile: 'chemical' }, 201)).data;
  const region = (await api('POST', '/api/materials/regions', { name: '合成分析区域' }, 201)).data;
  const room = (await api('POST', '/api/materials/storage-places', { name: '合成实验室' }, 201)).data;
  await api('POST', '/api/materials/storage-places', { name: '试剂柜第2层', parentId: room.id }, 201);
  const catalog = [];
  for (let i = 1; i <= 38; i++) catalog.push((await api('POST', '/api/materials/catalog', {
    name: `布局物资 ${String(i).padStart(2, '0')}` + (i === 1 ? '用于长名称与连续文本检查ABCDEFGHIJKL'.repeat(3) : ''),
    code: `LAYOUT-${String(i).padStart(2, '0')}`, spec: '500 mL', unit: '瓶', categoryId: category.id, trackingMode: 'unit',
    remark: i === 1 ? '合成档案备注。'.repeat(25) : '', ...(i === 1 ? { casNumber: '7732-18-5', purity: '分析纯' } : {})
  }, 201)).data);
  let order = (await api('POST', '/api/materials/requests', { title: '工作区合成申报单', description: '仅用于隔离布局检查' }, 201)).data;
  await api('POST', '/api/materials/openings', { title: '合成期初草稿', date: '2026-10-23' }, 201);
  order = (await api('POST', `/api/materials/requests/${order.id}/items`, { requestVersion: order.version, catalogId: catalog[0].id,
    categoryId: category.id, regionId: region.id, warehouse: 'MAIN', quantity: '3', purpose: '合成布局核对' }, 201)).data;
  order = (await api('POST', `/api/materials/requests/${order.id}/items`, { requestVersion: order.version, catalogId: catalog[8].id,
    categoryId: category.id, regionId: region.id, warehouse: 'MAIN', quantity: '2', purpose: '合成第二页记录核对' }, 201)).data;
  for (const item of catalog.slice(1, 20).filter(item => item.id !== catalog[8].id)) order = (await api('POST', `/api/materials/requests/${order.id}/items`, {
    requestVersion: order.version, catalogId: item.id, categoryId: category.id, regionId: region.id, warehouse: 'MAIN', quantity: '1'
  }, 201)).data;
  order = (await api('POST', `/api/materials/requests/${order.id}/submit`, { requestVersion: order.version })).data;
  const firstReceipt = (await api('POST', '/api/materials/receipts', { requestId: order.id, itemId: order.items[0].id, requestVersion: order.version,
    version: order.items[0].version, requestIdempotencyKey: crypto.randomUUID(), quantity: '3', amount: '30',
    manufacturer: '合成厂家', batch: 'LAYOUT-BATCH', location: '合成实验室 / 试剂柜第2层', locationVersion: 0 }, 201)).data;
  order = firstReceipt.request;
  order = (await api('POST', '/api/materials/receipts', { requestId: order.id, itemId: order.items[1].id, requestVersion: order.version,
    version: order.items[1].version, requestIdempotencyKey: crypto.randomUUID(), quantity: '2', amount: '20',
    manufacturer: '合成第二厂家', batch: 'LAYOUT-SECOND', location: '合成实验室 / 试剂柜第2层', locationVersion: 0 }, 201)).data.request;
  const stockNote = '库存长备注用于列宽检查。'.repeat(12);
  order = (await api('POST', `/api/materials/requests/${order.id}/receipts/batch`, { version: order.version, requestIdempotencyKey: crypto.randomUUID(),
    items: order.items.slice(2).map(item => ({ itemId: item.id, itemVersion: item.version, quantity: '1', amount: '10',
      manufacturer: '合成其他厂家', note: stockNote, location: '合成实验室 / 试剂柜第2层', locationVersion: 0 }))
  }, 201)).data.request;
  await api('POST', '/api/materials/issues', { catalogId: catalog[0].id, regionId: region.id, warehouse: 'MAIN', batch: 'LAYOUT-BATCH', expiryDate: '',
    quantity: '1', purpose: '合成待发放领用', requestIdempotencyKey: crypto.randomUUID() }, 201);
  await api('POST', '/api/materials/requests', { title: '可编辑的合成草稿' }, 201);
  for (let i = 1; i <= 17; i++) await api('POST', '/api/records', { module: 'archives', title: `合成档案 ${i}`, code: `ARCHIVE-${i}`, status: '草稿' }, 201);
  const archiveTotal = (await api('GET', '/api/records?module=archives')).data.length;
  const asset = (await api('POST', '/api/records', { module: 'assets', title: '合成设备档案', data: { asset_stage: '建档', model: '合成型号', location: '合成实验室' } }, 201)).data;
  await api('POST', '/api/records', { module: 'quality', title: '合成质量手册', data: { quality_section: '质量手册', version: '1', is_current: '是' } }, 201);
  await api('POST', '/api/records', { module: 'contracts', title: '合成委托单位', category: '委托单位' }, 201);

  const { chromium } = require(browserModule);
  const browser = await chromium.launch({ headless: true, ...(process.env.LABOS_TEST_BROWSER_PATH ? { executablePath: process.env.LABOS_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const split = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  const checks = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (condition, label, evidence) => { checks.push({ label, passed: Boolean(condition), ...(evidence === undefined ? {} : { evidence }) }); assert.ok(condition, `${label}${evidence === undefined ? '' : ': ' + JSON.stringify(evidence)}`); };
  const screenshot = name => page.screenshot({ path: path.join(directory, name + '.png') });
  const visibleInViewport = async locator => locator.evaluate(node => { const b = node.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.left >= -1 && b.top >= -1 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1; });
  const navigate = async target => {
    if (target === 'datahub' && !(await page.locator('.nav [data-nav="datahub"]').count())) {
      await navigate('management');
      await page.locator('#page [data-mcard="datahub"]').click();
      await page.locator('[data-hub-tab="general"]').waitFor();
      return;
    }
    if (page.viewportSize().width < 768) await page.locator('#menu-toggle').click();
    await page.locator(`.nav [data-nav="${target}"]`).click();
    await page.waitForFunction(target => current === target && !document.querySelector('#page .mw-empty')?.textContent.includes('正在加载'), target);
  };
  const revealControl = async control => {
    for (const owner of await control.locator('xpath=ancestor::details').all()) {
      if (!(await owner.evaluate(node => node.open))) await owner.locator(':scope > summary').click();
    }
    return control;
  };
  const clickControl = async selector => (await revealControl(page.locator(selector).first())).click();
  const navigateMaterial = async target => {
    if (target === 'catalog') await clickControl('.mw-head .mw-actions [data-page="catalog"]');
    else if (target === 'settings') {
      if (!(await page.locator('.mw-subnav [data-page="settings"]').count())) await clickControl('.mw-head .mw-actions [data-page="catalog"]');
      await clickControl('.mw-subnav [data-page="settings"]');
    } else if (['issues', 'openings'].includes(target)) {
      if (!(await page.locator(`.mw-subnav [data-page="${target}"]`).count())) await page.locator('.mw-nav [data-page="inventory"]').click();
      await clickControl(`.mw-subnav [data-page="${target}"]`);
    } else await page.locator(`.mw-nav [data-page="${target}"]`).click();
    await page.waitForFunction(() => !document.querySelector('#page .mw-empty')?.textContent.includes('正在加载'));
  };
  const openOrderHistory = async () => {
    const target = page.locator(`#page [data-mw="request"][data-id="${order.id}"]`);
    while (!(await target.count())) {
      const next = page.locator('#page .mw-pagebar [data-mw="next"]');
      check(!(await next.isDisabled()), 'the submitted request is reachable through real pagination');
      const before = await page.locator('#page .mw-pagebar').textContent();
      await next.click();
      await page.waitForFunction(before => document.querySelector('#page .mw-pagebar')?.textContent !== before && !document.querySelector('#page .mw-empty'), before);
    }
    await target.click();
    await page.locator('#page [data-mw="events"]').first().click();
    await page.locator('#mw-view').waitFor({ state: 'visible' });
  };
  const checkShell = async (label, clickedTabs = true) => {
    check((await page.locator('#app-version').textContent()).includes(version), label + ': backend application version is visible');
    check(await visibleInViewport(page.locator('#app-version')), label + ': version is in the viewport');
    check(await visibleInViewport(page.locator('#session-user')), label + ': current account is in the viewport');
    check((await page.locator('#session-user').textContent()).trim() === '合成物资管理员', label + ': header uses the real account display name');
    check(await visibleInViewport(page.locator('#logout')), label + ': logout is in the viewport');
    check((await page.locator('#logout').textContent()).includes('退出'), label + ': logout has an explicit text label');
    const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    check(geometry.scrollWidth <= geometry.width + 1, label + ': no document-level horizontal overflow', geometry);
    const tabs = await page.locator('#page .mw-nav,#page .mw-subnav').evaluateAll(navs => navs.map(nav => {
      const active = nav.querySelector('[aria-current="page"]') || nav.querySelector('.active');
      if (!active || !nav.getClientRects().length) return null;
      const a = active.getBoundingClientRect(), n = nav.getBoundingClientRect();
      const first = nav.firstElementChild.getBoundingClientRect();
      return { label: active.textContent, left: a.left, right: a.right, navLeft: n.left, navRight: n.right,
        firstLeft: first.left, firstRight: first.right, scrollLeft: nav.scrollLeft, overflow: nav.dataset.overflow,
        expectedOverflow: String(nav.scrollWidth > nav.clientWidth) };
    }).filter(Boolean));
    for (const tab of tabs) {
      check(tab.overflow === tab.expectedOverflow, label + ': navigation overflow metadata matches its current size', tab);
      if (clickedTabs) check(tab.left >= tab.navLeft - 1 && tab.right <= tab.navRight + 1, label + ': clicked navigation tab is fully visible within its scroll container', tab);
      else check(tab.scrollLeft === 0 && tab.firstLeft >= tab.navLeft - 1 && tab.firstRight <= tab.navRight + 1,
        label + ': entering materials starts with the first tab fully visible', tab);
    }
    const heading = await page.locator('#title').evaluate(node => getComputedStyle(node).fontSize);
    check(heading === '22px', label + ': page title uses the page font token at every breakpoint', heading);
  };
  const checkPanel = async (selector, label, compact = false) => {
    await checkShell(label);
    const geometry = await page.locator(selector).evaluate(dialog => {
      const b = dialog.getBoundingClientRect(), h = document.querySelector('.layout>main>header').getBoundingClientRect();
      const side = document.querySelector('.layout>aside')?.getBoundingClientRect();
      return { open: dialog.open, modal: dialog.matches(':modal'), active: dialog.dataset.wsActive,
        left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width,
        headerBottom: h.bottom, headerTop: h.top, sidebarRight: side?.right || 0,
        backgroundInert: document.querySelector('.layout>main>.page').inert,
        backgroundVisibility: getComputedStyle(document.querySelector('.layout>main>.page')).visibility,
        accounts: document.querySelectorAll('#session-user').length, logouts: document.querySelectorAll('#logout').length,
        versions: document.querySelectorAll('#app-version').length, copies: document.querySelectorAll('.ws-context').length };
    });
    check(geometry.open && !geometry.modal && geometry.active === 'true', label + ': the current child workspace is nonmodal and active', geometry);
    check(geometry.accounts === 1 && geometry.logouts === 1 && geometry.versions === 1 && geometry.copies === 0,
      label + ': only the global header supplies account, version and logout', geometry);
    check(geometry.headerTop >= -1 && geometry.top >= geometry.headerBottom + 7 && geometry.bottom <= page.viewportSize().height + 1,
      label + ': the child workspace stays below the stationary global header', geometry);
    check(geometry.left >= 0 && geometry.right <= page.viewportSize().width - 7, label + ': the complete child workspace fits horizontally', geometry);
    check(geometry.backgroundInert && geometry.backgroundVisibility === 'hidden', label + ': underlying business content cannot be used', geometry);
    if (page.viewportSize().width >= 768) check(geometry.left >= geometry.sidebarRight + 8, label + ': the workspace stays to the right of the sidebar', geometry);
    if (compact) {
      const left = page.viewportSize().width >= 1280 ? 257 : page.viewportSize().width >= 768 ? 84 : 8;
      const right = page.viewportSize().width < 768 ? 8 : 12;
      check(geometry.width <= 761 && Math.abs((geometry.left + geometry.right) / 2 - (left + page.viewportSize().width - right) / 2) < 2,
        label + ': the short form is centered within the content area', geometry);
    }
    if (selector === '#mw-view') check(await page.locator('#mw-view [data-mw="close-view"]').count() === 1,
      label + ': material detail keeps exactly one return action');
    if (selector === '#mw-dialog') {
      check(await page.locator('#mw-dialog .mw-dialog-head [data-mw="cancel"]').textContent() === '关闭',
        label + ': the form header uses the close label');
      check(await page.locator('#mw-dialog .mw-dialog-actions [data-mw="cancel"]').textContent() === '取消' &&
        await page.locator('#mw-save').textContent() === '保存', label + ': form cancel and save remain intact');
    }
  };
  const checkCards = async (label, selector = '#page .table') => {
    if (page.viewportSize().width >= 768) {
      const layouts = await page.locator(selector).evaluateAll(containers => containers.map(container => {
        const table = container.querySelector('table');
        const expected = table.matches('.mw-issue-table') ? 144 : null;
        const name = table.querySelector('tbody td strong'), headings = [...table.querySelectorAll('th')];
        const controlled = container.matches('.mw-stock-table,.mw-catalog-table,.mw-request-table,.mw-issue-table') || table.matches('.mw-stock-table,.mw-catalog-table,.mw-request-table,.mw-issue-table') || Boolean(container.closest('.mw-order-panel'));
        let stable = true;
        if (name && controlled) {
          const original = name.textContent, before = headings.map(th => th.getBoundingClientRect().width);
          name.textContent = '长名称物资'.repeat(6);
          stable = headings.every((th, index) => Math.abs(th.getBoundingClientRect().width - before[index]) < 1);
          name.textContent = original;
        }
        const expectedWidths = table.matches('.mw-catalog-table') ? [null,null,128,112,88,96,132] : table.matches('.mw-request-table') ? [null,128,96,150,112,132] : null;
        return { controlled, stable, layout: getComputedStyle(table).tableLayout, expected, actual: parseFloat(getComputedStyle(table.querySelector('th:last-child')).width),
          editorGrid: innerWidth <= 1100 && Boolean(container.closest('.mw-order-panel')),
          expectedWidths, widths: headings.map(th => th.getBoundingClientRect().width), width: table.getBoundingClientRect().width };
      }));
      for (const layout of layouts) {
        if (layout.controlled && !layout.editorGrid) check(layout.layout === 'fixed', label + ': the semantic record table controls column widths', layout);
        if (layout.controlled) check(layout.stable, label + ': a thirty-character name does not move other columns', layout);
        if (layout.expected) check(Math.abs(layout.actual - layout.expected) < 1, label + ': per-table operation width wins the generic rule', layout);
        if (layout.expectedWidths && page.viewportSize().width >= 1280) check(layout.widths.every((width,index) => layout.expectedWidths[index] === null || Math.abs(width - layout.expectedWidths[index]) < 1.5), label + ': short fields use their semantic width instead of percentages', layout);
      }
    }
    const result = await page.locator(selector).evaluateAll(containers => containers.map(container => {
      const table = container.querySelector('table');
      const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    const cells = [...table.querySelectorAll('tbody tr:not([hidden])')].filter(tr => !tr.querySelector('[colspan]')).flatMap(tr => [...tr.children].map((td, i) => ({ label: td.getAttribute('data-label'), expected: headers[i], selection: td.classList.contains('cell-select') })));
      return { display: getComputedStyle(table).display, width: container.clientWidth, scroll: container.scrollWidth, cells };
    }));
    for (const row of result) if (page.viewportSize().width < 768) {
      check(row.display === 'block' && row.scroll <= row.width + 1, label + ': same table DOM becomes cards without horizontal scroll', row);
      for (const cell of row.cells) if (cell.expected && !cell.selection) check(cell.label === cell.expected, label + ': card field names come from the table header', cell);
    }
    if (page.viewportSize().width >= 768 && page.viewportSize().width < 1280) {
      const operations = await page.locator(selector).evaluateAll(containers => containers.flatMap(container => {
        const cell = container.querySelector('tbody tr:not([hidden]) td.cell-act');
        if (!cell || innerWidth <= 1100 && container.closest('.mw-order-panel')) return [];
        const original = container.scrollLeft, snapshots = [];
        for (const position of [0, container.scrollWidth]) {
          container.scrollLeft = position;
          const bounds = container.getBoundingClientRect(), rect = cell.getBoundingClientRect();
          snapshots.push({ left: rect.left, right: rect.right, containerLeft: bounds.left, containerRight: bounds.right, position: getComputedStyle(cell).position });
        }
        container.scrollLeft = original;
        return snapshots;
      }));
      for (const operation of operations) check(operation.position === 'sticky' && operation.left >= operation.containerLeft - 1 && operation.right <= operation.containerRight + 1,
        label + ': real operation cells stay reachable at both horizontal scroll ends', operation);
    }
  };
  const stockContext = () => page.evaluate(() => {
    const table = document.querySelector('#page .mw-stock-table'), scroll = table?.closest('.table');
    return { query: document.querySelector('#mw-filters [name="q"]')?.value,
      region: document.querySelector('#mw-filters [name="regionId"]')?.value,
      warehouse: document.querySelector('#mw-filters [name="warehouse"]')?.value,
      pagination: document.querySelector('#page .mw-pagebar')?.textContent,
      firstCode: document.querySelector('#page .mw-stock-table tbody small')?.textContent,
      documentScroll: window.scrollY, tableScroll: scroll?.scrollTop || 0 };
  });
  const checkStockContext = async (before, label) => {
    const after = await stockContext();
    for (const key of ['query', 'region', 'warehouse', 'pagination', 'firstCode']) check(after[key] === before[key], `${label}: ${key} is preserved`, { before: before[key], after: after[key] });
    for (const key of ['documentScroll', 'tableScroll']) check(Math.abs(after[key] - before[key]) <= 1, `${label}: ${key} is restored`, { before: before[key], after: after[key] });
  };
  const checkStockColumns = async label => {
    check(await page.locator('#page .mw-stock-table').count() === 1, label + ': stock has an explicit semantic column policy');
    if (page.viewportSize().width < 768) return;
    const widths = await page.locator('#page .mw-stock-table').evaluate(node => [...(node.matches('table') ? node : node.querySelector('table')).querySelectorAll('thead th')].map(th => th.getBoundingClientRect().width));
    check(widths.length === 7, label + ': the ledger retains seven columns', widths);
    check(Math.abs(widths[0] - 116) < 1.5 && Math.abs(widths[2] - 96) < 1.5 && Math.abs(widths[4] - 68) < 1.5,
      label + ': time, quantity and unit use bounded content widths', widths);
    check(widths[1] >= widths[2] * 1.8 && widths[1] >= widths[4] * 2 && widths[3] > widths[2] && widths[6] >= 90,
      label + ': material name, specification and notes receive the useful width', widths);
  };
  const checkInlineIssue = async (label, lostResponse = false) => {
    await page.locator('#mw-filters [name="q"]').fill('布局物资');
    await revealControl(page.locator('#mw-filters [name="regionId"]'));
    await page.locator('#mw-filters [name="regionId"]').selectOption(String(region.id));
    await page.locator('#mw-filters [name="warehouse"]').selectOption('MAIN');
    const filtered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/materials/stock/batches' && new URL(response.url()).searchParams.get('q') === '布局物资');
    await page.locator('#mw-filters [type="submit"]').first().click();
    await filtered;
    await page.locator('#page .mw-stock-table [data-mw="stock-issue"]').first().waitFor();
    const next = page.locator('#page .mw-pagebar [data-mw="next"]');
    check(!(await next.isDisabled()), label + ': seeded inventory has a genuine second server page');
    const oldPage = await page.locator('#page .mw-pagebar').textContent();
    await next.click();
    await page.waitForFunction(before => document.querySelector('#page .mw-pagebar')?.textContent !== before && !document.querySelector('#page .mw-empty'), oldPage);
    const noteRow = page.locator('#page .mw-stock-table tbody tr').filter({ hasText: stockNote }).first();
    while (!(await noteRow.count())) {
      check(!(await next.isDisabled()), label + ': the specific long-note stock fixture is reachable by server pagination');
      const before = await page.locator('#page .mw-pagebar').textContent();
      await next.click();
      await page.waitForFunction(before => document.querySelector('#page .mw-pagebar')?.textContent !== before && !document.querySelector('#page .mw-empty'), before);
    }
    const note = await noteRow.locator('td').nth(6).evaluate(cell => {
      const text = cell.querySelector('.mw-cell-text'), style = text && getComputedStyle(text);
      return { full: cell.title, text: text?.textContent, clamp: style?.webkitLineClamp, height: text?.getBoundingClientRect().height, lineHeight: Number.parseFloat(style?.lineHeight) };
    });
    check(note.full === stockNote && note.text === stockNote && note.clamp === 'none',
      label + ': inventory retains the complete readable note without a forced two-line crop', note);
    if (label === '1366-stock') {
      await noteRow.locator('[data-mw="stock-detail"]').click();
      await page.locator('#mw-view').waitFor({ state: 'visible' });
      check((await page.locator('#mw-view-body').textContent()).includes(stockNote), label + ': inventory detail preserves the full long note');
      await page.locator('#mw-view [data-mw="close-view"]').first().click();
      await page.locator('#mw-view').waitFor({ state: 'hidden' });
    }
    if (label === '1366x480-stock') {
      const row = noteRow;
      await row.scrollIntoViewIfNeeded();
      await row.locator('[data-mw="stock-issue"]').scrollIntoViewIfNeeded();
      check(await visibleInViewport(row.locator('[data-mw="stock-issue"]')), label + ': low-height inventory retains its reachable issue action');
    }
    const button = noteRow.locator('[data-mw="stock-issue"]');
    await button.scrollIntoViewIfNeeded();
    const source = await stockContext();
    const purpose = `合成页内领用 ${label}`;
    await button.click();
    await page.locator('#mw-inline-form-slot #mw-dialog').waitFor({ state: 'visible' });
    const inline = await page.locator('#mw-dialog').evaluate(dialog => ({ open: dialog.open, modal: dialog.matches(':modal'),
      inline: dialog.classList.contains('mw-inline-form') && dialog.classList.contains('mw-issue-inline'),
      accountCopies: dialog.querySelectorAll('.ws-context').length,
      visibleAccounts: [...document.querySelectorAll('#session-user,[data-ws-user]')].filter(node => node.getBoundingClientRect().width && node.getBoundingClientRect().height).length,
      detailOpen: document.querySelector('#mw-view')?.open }));
    check(inline.open && inline.inline && !inline.modal && !inline.detailOpen, label + ': issue application lives inside inventory without a modal or stale detail', inline);
    check(inline.accountCopies === 0 && inline.visibleAccounts === 1, label + ': the inline form has exactly one visible account bar', inline);
    const cancellationLoads = [], observeCancellation = request => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === '/api/materials/stock/batches' && url.searchParams.get('q') === source.query) cancellationLoads.push(url.pathname);
    };
    page.on('request', observeCancellation);
    await page.locator('#mw-fields [name="quantity"]').fill('1');
    await page.locator('#mw-fields [name="purpose"]').fill(purpose);
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#mw-dialog [data-mw="cancel"]').first().click();
    check(await page.locator('#mw-inline-form-slot #mw-dialog').isVisible(), label + ': refusing cancellation retains the inline form');
    check(await page.locator('#mw-fields [name="purpose"]').inputValue() === purpose, label + ': refusing cancellation retains the entered purpose');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('.mw-nav [data-page="requests"]').click();
    check(await page.locator('#mw-inline-form-slot #mw-dialog').isVisible() && await page.locator('.mw-nav [data-page="inventory"]').getAttribute('aria-current') === 'page', label + ': refusing navigation retains inventory and the draft');
    check(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), label + ': browser unload protects the unsaved inline input');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#mw-dialog [data-mw="cancel"]').first().click();
    await page.locator('#mw-dialog').waitFor({ state: 'hidden' });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    page.off('request', observeCancellation);
    check(cancellationLoads.length === 0, label + ': cancelling does not reload the inventory list', cancellationLoads);
    await checkStockContext(source, label + ' cancel');
    await button.click();
    await page.locator('#mw-inline-form-slot #mw-dialog').waitFor({ state: 'visible' });
    await page.locator('#mw-fields [name="quantity"]').fill('1');
    await page.locator('#mw-fields [name="purpose"]').fill(purpose);
    await page.locator('#mw-save').scrollIntoViewIfNeeded();
    check(await page.locator('#mw-save').isVisible(), label + ': submit remains reachable');
    await screenshot(label.replace(/[^a-zA-Z0-9-]/g, '-') + '-stock-inline');
    const issueRoute = '**/api/materials/issues';
    let release, interceptedBody;
    if (lostResponse) {
      const held = new Promise(resolve => { release = resolve; });
      let entered;
      const intercepted = new Promise(resolve => { entered = resolve; });
      await page.route(issueRoute, async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        interceptedBody = route.request().postData(); entered(); await held;
        const response = await route.fetch();
        check(response.status() === 201, label + ': held request actually commits through the real API');
        await route.abort('failed');
      });
      try {
        await page.locator('#mw-save').click(); await intercepted;
        check(await page.locator('#mw-save').isDisabled(), label + ': a pending request disables repeated submission');
        await page.locator('#mw-dialog [data-mw="cancel"]').first().click();
        await page.locator('.mw-nav [data-page="requests"]').click();
        await page.locator('#logout').click();
        check(await page.locator('#mw-inline-form-slot #mw-dialog').isVisible(), label + ': pending save blocks cancellation, navigation and logout');
        check(Boolean((await api('GET', '/api/auth/me')).data.user), label + ': blocked busy logout keeps the actual session');
      } finally { release(); }
      await page.waitForFunction(() => document.querySelector('#mw-error')?.textContent.includes('结果待确认'));
      await page.unroute(issueRoute);
      check(await page.locator('#mw-fields [name="quantity"]').isDisabled() && await page.locator('#mw-fields [name="purpose"]').isDisabled(), label + ': lost committed response freezes the original retry body');
      await page.locator('#mw-dialog [data-mw="cancel"]').first().click();
      await page.locator('.mw-nav [data-page="requests"]').click();
      check(await page.locator('#mw-inline-form-slot #mw-dialog').isVisible(), label + ': uncertain result blocks cancellation and navigation');
    }
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/materials/issues' && response.request().method() === 'POST');
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/materials/stock/batches' && new URL(response.url()).searchParams.get('q') === source.query);
    await page.locator('#mw-save').click();
    const response = await saved;
    const expectedStatus = lostResponse ? 200 : 201;
    check(response.status() === expectedStatus, label + ': submit uses the real issue API creation/replay contract', { expectedStatus, actualStatus: response.status() });
    if (lostResponse) check(response.request().postData() === interceptedBody, label + ': retry sends exactly the original committed request');
    await refreshed;
    await page.locator('#mw-dialog').waitFor({ state: 'hidden' });
    await page.locator('#page .mw-stock-table [data-mw="stock-issue"]').first().waitFor();
    await checkStockContext(source, label + ' save');
    check(await page.locator('.mw-nav [data-page="inventory"]').getAttribute('aria-current') === 'page', label + ': success stays on inventory');
    const created = (await api('GET', '/api/materials/issues?q=' + encodeURIComponent(purpose))).data;
    check(created.total === 1 && created.items[0].status === 'pending', label + ': one pending issue exists even after a lost-response retry', { total: created.total, status: created.items[0]?.status });
  };

  let status = 'failed';
  try {
    await page.goto(base);
    await page.locator('.nav button').last().waitFor();
    const me = await api('GET', '/api/auth/me');
    check(me.data.appVersion === version, 'real session API supplies package application version');
    check(me.data.user.display_name === '合成物资管理员', 'the real session API preserves the seeded account display name');
    await page.setViewportSize({ width: 1440, height: 900 });
    await navigate('materials');
    await navigateMaterial('catalog');
    await page.waitForFunction(() => Number(document.querySelector('#page .mw-pagebar')?.textContent.match(/每页 (\d+) 条/)?.[1]) >= 5);
    await navigateMaterial('settings');
    await page.setViewportSize({ width: 1366, height: 650 });
    const scannedPageSizes = [], observeScannedInventory = request => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === '/api/materials/stock/batches' && url.searchParams.get('detail') === '1') scannedPageSizes.push(Number(url.searchParams.get('pageSize')));
    };
    page.on('request', observeScannedInventory);
    // Use manual input in the real scan dialog; this checks the workflow without claiming camera hardware coverage.
    try {
      const resolved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/materials/scan/resolve');
      await clickControl('#page [data-mw="scan-issue"]');
      await page.locator('.ms-manual [name="code"]').fill(firstReceipt.receipt.units[0].code);
      await page.locator('.ms-manual [type="submit"]').click();
      const resolution = await resolved;
      check(resolution.status() === 200 && (await resolution.json()).kind === 'unit', 'manual entry in the real scan dialog resolves through the actual unit-code API');
      await page.locator('#mw-view [data-mw="issue-create"]').first().click();
      await page.locator('#mw-inline-form-slot #mw-dialog').waitFor({ state: 'visible' });
      check(scannedPageSizes.length >= 1 && scannedPageSizes.every(size => size === 10), 'scan from settings uses stable inventory pagination rather than reloading based on row heights', scannedPageSizes);
      check(await page.locator('#mw-fields [name="quantity"]').inputValue() === '1', 'a real unit-code result prefills one item in the inventory inline form');
      check(await page.locator('.mw-nav [data-page="inventory"]').getAttribute('aria-current') === 'page' && !(await page.locator('#mw-view').isVisible()), 'scan batch selection closes its detail and reaches inventory');
      await screenshot('1366-manual-unit-scan-inline');
      await page.locator('#mw-dialog [data-mw="cancel"]').first().click();
      await page.locator('#mw-dialog').waitFor({ state: 'hidden' });
    } finally {
      page.off('request', observeScannedInventory);
    }
    for (const size of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 900, height: 650 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 1920, height: 1080 }, { width: 1536, height: 864 }, { width: 1093, height: 614 }, { width: 360, height: 800 }]) {
      await page.setViewportSize(size);
      await navigate('materials');
      await checkShell(`${size.width} materials`, false);
      for (const materialPage of ['catalog', 'requests', 'acceptance', 'inventory', 'issues', 'openings']) {
        await navigateMaterial(materialPage);
        if (materialPage === 'acceptance') {
          // The seeded request is fully received; exercise its full historical order, not an empty open-order list.
          if (!(await page.locator('#mw-order-picker').isVisible())) await page.locator('#mw-order-picker-toggle').click();
          await revealControl(page.locator('#mw-filters [name="status"]'));
          await page.locator('#mw-filters [name="status"]').selectOption('done');
          await page.locator('#mw-filters [type="submit"]').first().click();
          await page.locator('#mw-order-picker [data-mw="wf-order"]').first().waitFor({ state:'attached' });
          if (await page.locator('#mw-order-picker').isVisible()) await page.locator('#mw-order-picker [data-mw="wf-order"]').first().click();
          await page.locator('#mw-order-workspace [data-wf-row]').first().waitFor();
          check(await page.locator('#mw-order-workspace [data-wf-row]').count() === 20, `${size.width}: acceptance retains the complete real request detail`);
        }
        await checkShell(`${size.width} ${materialPage}`);
        await checkCards(`${size.width} ${materialPage}`);
        if (['catalog', 'requests', 'acceptance', 'inventory', 'issues'].includes(materialPage)) await screenshot(`${size.width}-${materialPage}`);
        if (materialPage === 'requests') {
          await openOrderHistory();
          await checkPanel('#mw-view', `${size.width} acceptance history`);
          await checkCards(`${size.width} acceptance history`, '#mw-view .table');
          if (size.width < 768) {
            const actions = page.locator('#mw-view td.cell-act button');
            check(await actions.count() > 0, 'phone acceptance history retains its real record actions');
            for (const button of await actions.all()) {
              await button.scrollIntoViewIfNeeded();
              check(await visibleInViewport(button), 'each phone acceptance action fits in the viewport after vertical scrolling');
            }
            const historyTitle = await page.locator('#mw-view-title').textContent();
            await page.locator('#mw-view [data-mw="receipt-files"]').first().click();
            await page.waitForFunction(title => document.querySelector('#mw-view-title')?.textContent !== title, historyTitle);
            await checkPanel('#mw-view', 'phone history attachments');
            await page.keyboard.press('Escape');
            check(await page.locator('#mw-view-title').textContent() === historyTitle, 'phone attachment return restores the acceptance history');
          }
          await screenshot(`${size.width}-acceptance-history`);
          await page.keyboard.press('Escape');
          await page.locator('#mw-view').waitFor({ state: 'hidden' });
          check(!(await page.locator('.layout>main>.page').evaluate(node => node.inert)), `${size.width}: leaving history restores business interactions`);
          await page.locator('#page [data-mw="back"]').click();
          await page.locator('#page .mw-request-table').waitFor();
        }
        if (materialPage === 'inventory') {
          await checkStockColumns(`${size.width} stock columns`);
          if (size.width < 768) {
            const reset=page.locator('#mw-filters [data-mw="reset"]');
            if(await reset.count()){
              await reset.click();
              await page.locator('.mw-stock-table tbody tr').first().waitFor();
            }
            await page.locator('.mw-nav').scrollIntoViewIfNeeded();
            const density=await page.locator('.mw-stock-table tbody tr').first().evaluate(row=>{
              const box=selector=>row.querySelector(selector).getBoundingClientRect();
              return {top:row.getBoundingClientRect().top,name:box('.stock-name').top,quantity:box('.stock-quantity').top,
                unit:box('.stock-unit').top,date:box('.stock-date').top,columns:getComputedStyle(row).gridTemplateColumns.split(' ').length};
            });
            check(density.top >= 0 && density.top <= 320, `${size.width}: default stock begins within the compact first-screen target`,density);
            check(density.name < density.quantity && density.quantity === density.unit && density.quantity < density.date && density.columns === 2,
              `${size.width}: stock names and quantity/unit lead the same-DOM two-column phone layout`,density);
            await screenshot(`${size.width}-inventory-default`);
          }
          await checkInlineIssue(`${size.width}-stock`, size.width === 1366);
        }
        if (materialPage === 'inventory' && size.width === 390) {
          await page.emulateMedia({ media: 'print' });
          const printed = await page.locator('#page .table table').evaluate(table => ({
            display: getComputedStyle(table).display, headings: [...table.querySelectorAll('thead th')].map(th => th.textContent.trim()),
            headDisplay: getComputedStyle(table.querySelector('thead')).display,
            clamps: [...table.querySelectorAll('tbody strong')].map(node => getComputedStyle(node).webkitLineClamp)
          }));
          check(printed.display === 'table' && printed.headDisplay === 'table-header-group', 'mobile print media retains the stock table and its header', printed);
          check(JSON.stringify(printed.headings) === JSON.stringify(['入库时间', '名称', '数量', '规格', '单位', '厂家', '备注']), 'mobile print media retains all seven stock columns', printed.headings);
          check(printed.clamps.every(clamp => clamp === 'none'), 'screen-only material name clamping does not crop printed names', printed.clamps);
          await page.emulateMedia({ media: 'screen' });
        }
        if (size.width >= 1280) {
          const pager = page.locator('#page .mw-pagebar,#page .ws-pagination').last();
          if (await pager.count()) {
            const state = await pager.evaluate(node => ({ hidden: node.hidden, derived: node.classList.contains('ws-pagination'),
              current: Number(node.textContent.match(/第 (\d+) \/ /)?.[1]), pages: Number(node.textContent.match(/\/ (\d+) 页/)?.[1]) }));
            check(state.hidden === (state.current <= 1 && state.pages <= 1), `${size.width} ${materialPage}: navigation visibility follows its real page count`, state);
            if (!state.hidden) {
              await pager.scrollIntoViewIfNeeded();
              check(await visibleInViewport(pager), `${size.width} ${materialPage}: stable-count pagination remains reachable`);
              await page.locator('.mw-head').scrollIntoViewIfNeeded();
            }
          }
        }
      }
      await navigateMaterial('catalog');
      await page.locator('#page [data-mw="catalog-edit"]').first().waitFor();
      const grouped = page.locator('#page .mw-panel-top .mw-more');
      check(JSON.stringify(await grouped.locator('button').allTextContents()) === JSON.stringify(['导入 Excel', '导入模板', '导出 Excel']),
        `${size.width}: the real catalog groups secondary commands without changing their capability`);
      check(await page.locator('#mw-filters [type="submit"]').first().evaluate(node => node.classList.contains('ghost')), `${size.width}: catalog query remains an explicit secondary submit`);
      const duplicateTitle = await page.getByRole('heading', { name: '物资信息库', exact: true }).evaluate(node => ({
        accessibleName: node.getAttribute('aria-label') || node.textContent.trim(), clip: getComputedStyle(node).clipPath, width: node.getBoundingClientRect().width }));
      check(duplicateTitle.accessibleName === '物资信息库' && duplicateTitle.clip === 'none' && duplicateTitle.width > 1,
        `${size.width}: the catalog page heading is visible within the module`, duplicateTitle);
      await grouped.locator('summary').click();
      if (size.width === 1366) {
        await grouped.locator('[data-mw="catalog-import"]').click();
        await page.locator('#mw-dialog').waitFor({state:'visible'});
        check(!(await grouped.evaluate(node=>node.open)), 'opening a child form closes its background More menu');
        await page.keyboard.press('Escape');
        await page.locator('#mw-dialog').waitFor({state:'hidden'});
        check(true,'the first Escape reaches the current child workspace instead of a background menu');
        const rowMenu=page.locator('.mw-catalog-table .mw-row-actions .mw-more').first();
        check(await rowMenu.count()===1,'catalog row retains its low-frequency actions');
        await rowMenu.locator('summary').click();
        await page.evaluate(()=>new Promise(requestAnimationFrame));
        const popup=await rowMenu.locator(':scope > div').evaluate(node=>{
          const b=node.getBoundingClientRect(),hit=document.elementFromPoint(b.left+8,b.bottom-8);
          return {fits:b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight,reachable:node.contains(hit)};
        });
        check(popup.fits&&popup.reachable,'row More popup is neither clipped by the table nor outside the viewport',popup);
        await screenshot('1366-catalog-row-menu');
        await page.keyboard.press('Escape');
        check(!(await rowMenu.evaluate(node=>node.open)),'Escape closes the active row menu when no child workspace is open');
        await grouped.locator('summary').click();
      }
      check(await grouped.locator('[data-mw="catalog-export"]').isVisible(), `${size.width}: grouped export remains operable`);
      if (size.width === 390) check((await grouped.locator('summary').boundingBox()).height >= 44, 'the real phone catalog menu retains a 44px touch target');
      await screenshot(`${size.width}-catalog-menu`);
      await grouped.locator('summary').click();
      const firstName = page.locator('#page .table tbody tr').first().locator('td').first();
      check((await firstName.locator('strong').textContent()).includes('布局物资'), `${size.width}: material name is the primary field`);
      check((await firstName.locator('small').first().textContent()).includes('LAYOUT-'), `${size.width}: material code is secondary`);
      const materialDensity = await page.locator('#page .table').first().evaluate(container => {
        const header = getComputedStyle(container.querySelector('th')), cell = getComputedStyle(container.querySelector('tbody td'));
        return { headerFont: header.fontSize, headerPadding: header.padding, cellFont: cell.fontSize, cellPadding: cell.padding, lineHeight: cell.lineHeight, border: cell.borderRightWidth };
      });
      await screenshot(`${size.width}-catalog`);
      if (size.width === 1366) {
        const seen = new Set();
        for (let number = 0; number < 38; number++) {
          for (const value of await page.locator('#page .table tbody tr td:first-child small').allTextContents()) seen.add(value.trim());
          const next = page.locator('#page .mw-pagebar [data-mw="next"]');
          if (await next.isDisabled()) break;
          const before = await page.locator('#page .mw-pagebar').textContent();
          await next.click();
          await page.waitForFunction(before => document.querySelector('#page .mw-pagebar')?.textContent !== before && !document.querySelector('#page .mw-empty'), before);
        }
        check(seen.size === 38, 'all 38 real catalog records are reachable by server pagination', [...seen]);
        while (!(await page.locator('#page .mw-pagebar [data-mw="previous"]').isDisabled())) {
          const before = await page.locator('#page .mw-pagebar').textContent();
          await page.locator('#page .mw-pagebar [data-mw="previous"]').click();
          await page.waitForFunction(before => document.querySelector('#page .mw-pagebar')?.textContent !== before && !document.querySelector('#page .mw-empty'), before);
        }
        await page.locator('#mw-filters [name="q"]').fill('布局物资');
        await page.locator('#mw-filters [type="submit"]').first().click();
        await page.locator('#page [data-mw="catalog-detail"]').first().waitFor();
        const target = page.locator(`#page [data-mw="catalog-detail"][data-catalog="${catalog[8].id}"]`);
        while (!(await target.count())) {
          const next = page.locator('#page .mw-pagebar [data-mw="next"]');
          check(!(await next.isDisabled()), 'stocked second-page material remains reachable');
          const before = await page.locator('#page .mw-pagebar').textContent();
          await next.click();
          await page.waitForFunction(before => document.querySelector('#page .mw-pagebar')?.textContent !== before && !document.querySelector('#page .mw-empty'), before);
        }
        const sourcePage = await page.locator('#page .mw-pagebar').textContent();
        for (let repeat = 0; repeat < 2; repeat++) {
          await target.click();
          await page.locator('#mw-view [data-mw="batches"]').first().click();
          await page.locator('#mw-view [data-mw="batch-units"]').first().waitFor();
          const batchTitle = await page.locator('#mw-view-title').textContent();
          await page.locator('#mw-view [data-mw="batch-units"]').first().click();
          await page.locator('#mw-view').getByText('独立编号', { exact: true }).waitFor();
          check(await page.locator('#mw-view tbody tr').count() > 0, 'third-level real unit records are readable');
          await checkPanel('#mw-view', 'third-level unit records');
          await page.locator('#mw-view [data-mw="close-view"]').first().click();
          check((await page.locator('#mw-view-title').textContent()) === batchTitle, 'third-level return restores the parent batch workspace');
          check(await page.locator('#mw-view .ws-pagination + .ws-pagination').count() === 0, 'restoring a snapshot does not duplicate derived pagination');
          await page.locator('#mw-view [data-mw="close-view"]').first().click();
          await page.locator('#mw-view [data-mw="close-view"]').first().click();
          await page.locator('#mw-view').waitFor({ state: 'hidden' });
          check((await page.locator('#mw-filters [name="q"]').inputValue()) === '布局物资', 'third-level return preserves the catalog filter');
          check((await page.locator('#page .mw-pagebar').textContent()) === sourcePage, 'third-level return preserves the catalog page');
        }
        await screenshot('1366-catalog-returned');
        const before = await page.locator('#page .mw-pagebar').textContent();
        await page.locator('#page .mw-pagebar [data-mw="next"]').click();
        await page.waitForFunction(before => document.querySelector('#page .mw-pagebar')?.textContent !== before && !document.querySelector('#page .mw-empty'), before);
      }
      const catalogContext = { q: await page.locator('#mw-filters [name="q"]').inputValue(), pagination: await page.locator('#page .mw-pagebar').textContent() };
      await page.locator('#page [data-mw="new-catalog"]').click();
      await page.locator('#mw-dialog').waitFor({ state: 'visible' });
      await checkPanel('#mw-dialog', `${size.width} new material`, true);
      await screenshot(`${size.width}-new-material`);
      await page.keyboard.press('Escape');
      await page.locator('#mw-dialog').waitFor({ state: 'hidden' });
      await page.locator('#page [data-mw="catalog-edit"]').first().click();
      await page.locator('#mw-dialog').waitFor({ state: 'visible' });
      await checkPanel('#mw-dialog', `${size.width} edit material`, true);
      check(await visibleInViewport(page.locator('#logout')), `${size.width}: the main logout label remains visible above the short form`);
      check(await visibleInViewport(page.locator('#app-version')), `${size.width}: the main application version remains visible in a short form`);
      check(await page.locator('#mw-dialog .ws-context').count() === 0, `${size.width}: a short form does not duplicate the account bar`);
      const name = page.locator('#mw-fields [name="name"]');
      const original = await name.inputValue();
      await name.fill('未保存的合成名称');
      if (size.width === 1366) {
        page.once('dialog', dialog => dialog.dismiss());
        await page.locator('#logout').click();
        check((await name.inputValue()) === '未保存的合成名称', 'refusing a real global logout click preserves the current draft');
        check(Boolean((await api('GET', '/api/auth/me')).data.user), 'refusing a real global logout click preserves the real session');
        page.once('dialog', dialog => dialog.dismiss());
        await page.keyboard.press('Escape');
        check(await page.locator('#mw-dialog').isVisible() && await name.inputValue() === '未保存的合成名称', 'refusing Escape preserves the dirty external form');
      }
      if (size.width === 390) {
        await page.locator('#menu-toggle').click();
        page.once('dialog', dialog => dialog.dismiss());
        await page.locator('.nav [data-nav="archives"]').click();
        check(await page.locator('#mw-dialog').isVisible() && await name.inputValue() === '未保存的合成名称', 'refusing phone navigation preserves the external draft');
        await page.keyboard.press('Escape');
        check(!(await page.locator('body').evaluate(node => node.classList.contains('drawer-open'))) && await page.locator('#mw-dialog').isVisible(), 'Escape closes the phone menu without closing its child workspace');
      }
      page.once('dialog', dialog => dialog.dismiss());
      await page.locator('#mw-dialog [data-mw="cancel"]').first().click();
      check(await page.locator('#mw-dialog').isVisible(), `${size.width}: refusing leave preserves the edit workspace`);
      check((await name.inputValue()) === '未保存的合成名称', `${size.width}: refusing leave preserves draft input`);
      await name.fill(original);
      await page.locator('#mw-dialog [data-mw="cancel"]').first().click();
      await page.locator('#mw-dialog').waitFor({ state: 'hidden' });
      check((await page.locator('#mw-filters [name="q"]').inputValue()) === catalogContext.q && (await page.locator('#page .mw-pagebar').textContent()) === catalogContext.pagination,
        `${size.width}: returning from edit preserves the catalog filter and page`);
      await navigateMaterial('settings');
      for (const setting of ['categories', 'regions', 'places', 'numbering']) {
        await page.locator(`#page [data-mw="setting"][data-setting="${setting}"]`).click();
        await page.waitForFunction(() => !document.querySelector('#page .mw-empty')?.textContent.includes('正在加载'));
        await checkShell(`${size.width} settings ${setting}`);
        await checkCards(`${size.width} settings ${setting}`);
      }
      await screenshot(`${size.width}-settings-numbering`);
      const settings=await page.locator('.mw-settings').evaluate(node=>({width:node.getBoundingClientRect().width,
        navigation:node.querySelector('.mw-settings-nav').getBoundingClientRect().width}));
      check(settings.width<=1041,`${size.width}: settings preserve a bounded content region`,settings);
      if(size.width>=768)check(Math.abs(settings.navigation-176)<1.5,`${size.width}: settings local navigation uses its semantic width`,settings);
      await navigate('archives');
      await page.locator('#page .ws-pagination').waitFor();
      await checkShell(`${size.width} archives`);
      await checkCards(`${size.width} archives`);
      if (size.width >= 768) {
        const archiveDensity = await page.locator('#page .table').first().evaluate(container => {
          const header = getComputedStyle(container.querySelector('th')), cell = getComputedStyle(container.querySelector('tbody td'));
          return { headerFont: header.fontSize, headerPadding: header.padding, cellFont: cell.fontSize, cellPadding: cell.padding, lineHeight: cell.lineHeight, border: cell.borderRightWidth };
        });
        check(JSON.stringify(materialDensity) === JSON.stringify(archiveDensity), `${size.width}: archives and materials use the same record density`, { materialDensity, archiveDensity });
        check(archiveDensity.headerFont === '13px' && archiveDensity.cellFont === '14px' && archiveDensity.cellPadding === '8px 12px' && archiveDensity.lineHeight === '21px', `${size.width}: record typography matches R0/R1`, archiveDensity);
      } else {
        const categories = await page.locator('#archive-folder-select').evaluate(node => ({ height: node.getBoundingClientRect().height,
          count: node.options.length, label: node.closest('label')?.textContent, value: node.value }));
        check(categories.height >= 44 && categories.count >= 7 && categories.label.includes('档案分区') && categories.value === 'all', 'phone archive classifications use a labelled touch-sized filter', categories);
        check(await visibleInViewport(page.locator('#page .table tbody tr:not([hidden])').first()), 'phone archive first record fits completely in the initial viewport');
      }
      if (size.width >= 1280) {
        const pager=page.locator('#page .ws-pagination').first();await pager.scrollIntoViewIfNeeded();
        check(await visibleInViewport(pager), `${size.width}: archive fixed-count pagination remains reachable`);
        await page.locator('#archive-folder-select').scrollIntoViewIfNeeded();
      }
      await screenshot(`${size.width}-archives`);
      await page.locator('#archive-folder-select').selectOption('体系文件档案');
      await page.waitForFunction(()=>document.querySelector('#archive-result-count')?.textContent.includes('体系文件档案'));
      check(await page.locator('[data-af-clear]').isVisible(),`${size.width}: active archive classification is visibly clearable`);
      await page.locator('[data-af-clear]').click();
      await page.waitForFunction(()=>document.querySelector('#archive-folder-select')?.value==='all');
      if (size.width === 390) {
        await page.emulateMedia({ media: 'print' });
        const printing = await page.locator('#page .table tbody tr').evaluateAll(rows => rows.map(row => getComputedStyle(row).display));
        check(printing.length === archiveTotal && printing.every(display => display === 'table-row'), `print media includes all ${archiveTotal} archive records rather than only the screen page`, printing);
        check(await page.locator('#page .pill').first().evaluate(node => getComputedStyle(node).fontSize) === '13px', 'screen micro badges preserve the original print font size');
        await page.emulateMedia({ media: 'screen' });
      }
    }
    for (const size of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 900, height: 650 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await navigate('datahub');
      for (const tab of ['general', 'materials', 'recovery']) {
        await page.locator(`[data-hub-tab="${tab}"]`).click();
        check(await page.locator('.datahub-panel:visible').count() === 1, `${size.width}: only the selected backup section is visible`);
        check(await page.locator(`[data-hub-section="${tab}"]`).isVisible(), `${size.width}: ${tab} backup section is reachable`);
        await checkShell(`${size.width} backup ${tab}`);
      }
      await screenshot(`${size.width}-backup-recovery`);
      await navigate('assets');
      for (const stage of ['purchase', 'acceptance', 'filed', 'calibration', 'active', 'check', 'maintenance', 'abnormal', 'retired']) {
        await page.locator(`[data-astage="${stage}"]`).click();
        await page.waitForFunction(stage => document.querySelector(`[data-astage="${stage}"]`)?.classList.contains('active'), stage);
        await checkShell(`${size.width} asset ${stage}`);
      }
      await page.locator('[data-astage="filed"]').click();
      await page.locator(`[onclick="showAsset(${asset.id})"]`).click();
      await page.locator('#detail-body').getByText('生命周期记录', { exact: true }).waitFor();
      check(await page.locator('#detail-body .table').count() === 1, `${size.width}: asset lifecycle uses a record table`);
      await checkCards(`${size.width} asset lifecycle`, '#detail-body .table');
      await page.locator('#detail-body .table').scrollIntoViewIfNeeded();
      check(await page.locator('#detail-body .table').isVisible(), `${size.width}: lifecycle records remain reachable after the long asset details`);
      await checkPanel('#detail', `${size.width} asset detail`);
      check(await page.locator('#detail .modal-head .x').count() === 1 && await page.locator('#detail footer .x').count() === 0,
        `${size.width}: generic details keep only their header return`);
      await screenshot(`${size.width}-asset-lifecycle`);
      await page.locator('#detail .x').click();
      for (const [module, attribute, values] of [
        ['quality', 'data-quality-section', ['all', 'manual', 'procedure', 'instruction', 'form', 'standard']],
        ['contracts', 'data-contract-tab', ['all', 'client', 'contract']],
        ['audit', 'data-ak', ['all', 'records', 'files', 'users', 'role_permissions', 'nav_items']]
      ]) {
        await navigate(module);
        for (const value of values) {
          await page.locator(`[${attribute}="${value}"]`).click();
          await page.waitForFunction(({ attribute, value }) => document.querySelector(`[${attribute}="${value}"]`)?.classList.contains('active'), { attribute, value });
          await checkShell(`${size.width} ${module} ${value}`);
          await checkCards(`${size.width} ${module} ${value}`);
          if (value === 'all') await screenshot(`${size.width}-${module}-records`);
        }
        await screenshot(`${size.width}-${module}-sections`);
      }
    }
    await page.setViewportSize({ width: 1366, height: 480 });
    await navigate('materials');
    await navigateMaterial('catalog');
    await page.locator('#page [data-mw="catalog-edit"]').first().click();
    await checkPanel('#mw-dialog', 'low-height edit', true);
    await page.locator('#mw-save').scrollIntoViewIfNeeded();
    check(await page.locator('#mw-save').isVisible(), 'low-height edit save remains reachable');
    const finalField = page.locator('#mw-fields input,#mw-fields textarea,#mw-fields select').last();
    await finalField.scrollIntoViewIfNeeded();
    check(await finalField.isVisible(), 'low-height final form field remains reachable');
    await screenshot('1366x480-edit');
    await page.locator('#mw-dialog [data-mw="cancel"]').first().click();
    await navigateMaterial('inventory');
    await checkStockColumns('1366x480 stock columns');
    await checkInlineIssue('1366x480-stock');
    await navigateMaterial('requests');
    await openOrderHistory();
    await checkPanel('#mw-view', 'low-height history before actual logout');
    await page.locator('#logout').click();
    await page.locator('#login').waitFor({ state: 'visible' });
    check((await api('GET', '/api/auth/me')).data.user === null, 'a real global logout click from the full child workspace invalidates the server session');
    check(errors.length === 0, 'production scripts have no browser exceptions', errors);
    status = 'passed';
  } finally {
    const finalState = await page.evaluate(() => ({ title: document.querySelector('#mw-view-title')?.textContent,
      pagination: document.querySelector('#page .mw-pagebar')?.textContent, body: document.querySelector('#page')?.textContent.slice(0, 3000) })).catch(() => null);
    if (status !== 'passed') await screenshot('failure').catch(() => {});
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ status, applicationVersion: version, actualApi: true, actualSource: true, checks, errors, finalState }, null, 2));
    t.diagnostic(`Workspace report and screenshots: ${directory}`);
  }
});
