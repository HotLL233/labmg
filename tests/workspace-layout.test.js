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
  timeout: 180000
}, async t => {
  const database = await createTestDatabase(t);
  const cache = path.join(root, 'artifacts/cache', version);
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
  order = (await api('POST', `/api/materials/requests/${order.id}/submit`, { requestVersion: order.version })).data;
  const firstReceipt = (await api('POST', '/api/materials/receipts', { requestId: order.id, itemId: order.items[0].id, requestVersion: order.version,
    version: order.items[0].version, requestIdempotencyKey: crypto.randomUUID(), quantity: '3', amount: '30',
    manufacturer: '合成厂家', batch: 'LAYOUT-BATCH', location: '合成实验室 / 试剂柜第2层', locationVersion: 0 }, 201)).data;
  order = firstReceipt.request;
  await api('POST', '/api/materials/receipts', { requestId: order.id, itemId: order.items[1].id, requestVersion: order.version,
    version: order.items[1].version, requestIdempotencyKey: crypto.randomUUID(), quantity: '2', amount: '20',
    manufacturer: '合成第二厂家', batch: 'LAYOUT-SECOND', location: '合成实验室 / 试剂柜第2层', locationVersion: 0 }, 201);
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
  const navigateMaterial = async target => {
    if (target === 'catalog') await page.locator('.mw-head .mw-actions [data-page="catalog"]').click();
    else if (target === 'settings') {
      if (!(await page.locator('.mw-subnav [data-page="settings"]').count())) await page.locator('.mw-head .mw-actions [data-page="catalog"]').click();
      await page.locator('.mw-subnav [data-page="settings"]').click();
    } else if (['issues', 'openings'].includes(target)) {
      if (!(await page.locator(`.mw-subnav [data-page="${target}"]`).count())) await page.locator('.mw-nav [data-page="inventory"]').click();
      await page.locator(`.mw-subnav [data-page="${target}"]`).click();
    } else await page.locator(`.mw-nav [data-page="${target}"]`).click();
    await page.waitForFunction(() => !document.querySelector('#page .mw-empty')?.textContent.includes('正在加载'));
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
      if (!active) return null;
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
  const checkCards = async (label, selector = '#page .table') => {
    if (page.viewportSize().width >= 768) {
      const layouts = await page.locator(selector).evaluateAll(containers => containers.map(container => {
        const table = container.querySelector('table');
        const expected = table.querySelector('td.cell-act [data-mw="catalog-detail"]') ? 160
          : table.querySelector('td.cell-act [data-mw="issue-detail"]') ? 144
          : table.querySelector('td.cell-act [data-mw="events"]') && table.querySelector('td.cell-act [data-mw="request"]') ? 152 : null;
        const name = table.querySelector('tbody td strong'), headings = [...table.querySelectorAll('th')];
        let stable = true;
        if (name && table.closest('.page')) {
          const original = name.textContent, before = headings.map(th => th.getBoundingClientRect().width);
          name.textContent = '长名称物资'.repeat(6);
          stable = headings.every((th, index) => Math.abs(th.getBoundingClientRect().width - before[index]) < 1);
          name.textContent = original;
        }
        return { fixed: Boolean(table.closest('.page')), stable, layout: getComputedStyle(table).tableLayout, expected, actual: parseFloat(getComputedStyle(table.querySelector('th:last-child')).width) };
      }));
      for (const layout of layouts) {
        if (layout.fixed) check(layout.layout === 'fixed', label + ': the real page table controls column widths', layout);
        if (layout.fixed) check(layout.stable, label + ': a thirty-character name does not move other columns', layout);
        if (layout.fixed && layout.expected) check(Math.abs(layout.actual - layout.expected) < 1, label + ': per-table operation width wins the generic rule', layout);
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
        if (!cell) return [];
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

  let status = 'failed';
  try {
    await page.goto(base);
    await page.locator('.nav button').last().waitFor();
    const me = await api('GET', '/api/auth/me');
    check(me.data.appVersion === version, 'real session API supplies package application version');
    check(me.data.user.display_name === '合成物资管理员', 'the real session API preserves the seeded account display name');
    for (const size of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 900, height: 650 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await navigate('materials');
      await checkShell(`${size.width} materials`, false);
      for (const materialPage of ['catalog', 'requests', 'acceptance', 'inventory', 'issues', 'openings']) {
        await navigateMaterial(materialPage);
        if (materialPage === 'acceptance') {
          // The seeded request is fully received; exercise its full historical order, not an empty open-order list.
          await page.locator('#mw-filters [name="status"]').selectOption('done');
          await page.locator('#mw-filters [type="submit"]').click();
          await page.locator('#mw-order-workspace [data-wf-row]').first().waitFor();
          check(await page.locator('#mw-order-workspace [data-wf-row]').count() === 2, `${size.width}: acceptance retains the complete real request detail`);
        }
        await checkShell(`${size.width} ${materialPage}`);
        await checkCards(`${size.width} ${materialPage}`);
        if (['acceptance', 'inventory', 'issues'].includes(materialPage)) await screenshot(`${size.width}-${materialPage}`);
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
          if (await pager.count()) check(await visibleInViewport(pager), `${size.width} ${materialPage}: record pagination is on the first screen`);
        }
      }
      await navigateMaterial('catalog');
      await page.locator('#page [data-mw="catalog-edit"]').first().waitFor();
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
        await page.locator('#mw-filters [type="submit"]').click();
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
          check(await visibleInViewport(page.locator('#mw-view [data-ws-logout]')), 'logout is reachable at the third level');
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
      await page.locator('#page [data-mw="catalog-edit"]').first().click();
      await page.locator('#mw-dialog').waitFor({ state: 'visible' });
      check(await visibleInViewport(page.locator('#mw-dialog [data-ws-logout]')), `${size.width}: logout remains reachable in a full workspace`);
      check(await visibleInViewport(page.locator('#mw-dialog [data-ws-version]')), `${size.width}: application version remains visible in a full workspace`);
      const name = page.locator('#mw-fields [name="name"]');
      const original = await name.inputValue();
      await name.fill('未保存的合成名称');
      if (size.width === 1366) {
        page.once('dialog', dialog => dialog.dismiss());
        await page.locator('#mw-dialog [data-ws-logout]').click();
        check((await name.inputValue()) === '未保存的合成名称', 'refusing logout preserves the current draft');
        check(Boolean((await api('GET', '/api/auth/me')).data.user), 'refusing logout preserves the real session');
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
        const categories = await page.locator('#page .archive-menu').evaluate(node => ({ height: node.getBoundingClientRect().height, wrap: getComputedStyle(node).flexWrap,
          counts: [...node.querySelectorAll('button:not(.active) small')].map(small => getComputedStyle(small).display), activeCount: getComputedStyle(node.querySelector('button.active small')).display }));
        check(categories.height <= 56 && categories.wrap === 'nowrap' && categories.counts.every(display => display === 'none') && categories.activeCount !== 'none', 'phone archive categories form one compact chip row with the selected count', categories);
        check(await visibleInViewport(page.locator('#page .table tbody tr:not([hidden])').first()), 'phone archive first record fits completely in the initial viewport');
      }
      if (size.width >= 1280) check(await visibleInViewport(page.locator('#page .ws-pagination').first()), `${size.width}: archive pagination remains in the viewport`);
      await screenshot(`${size.width}-archives`);
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
      check(await visibleInViewport(page.locator('#detail [data-ws-logout]')), `${size.width}: asset detail keeps logout reachable`);
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
    await page.locator('#mw-save').scrollIntoViewIfNeeded();
    check(await page.locator('#mw-save').isVisible(), 'low-height edit save remains reachable');
    const finalField = page.locator('#mw-fields input,#mw-fields textarea,#mw-fields select').last();
    await finalField.scrollIntoViewIfNeeded();
    check(await finalField.isVisible(), 'low-height final form field remains reachable');
    await screenshot('1366x480-edit');
    await page.locator('#mw-dialog [data-mw="cancel"]').first().click();
    await page.locator('#logout').click();
    await page.locator('#login').waitFor({ state: 'visible' });
    check((await api('GET', '/api/auth/me')).data.user === null, 'visible logout invalidates the real server session');
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
