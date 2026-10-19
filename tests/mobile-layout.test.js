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
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const results = {
      '/api/auth/me': { user }, '/api/ui-config/nav': nav,
      '/api/ui-config/dashboard': nav.map(row => ({ ...row, kind: 'module', description: '合成模块说明' })),
      '/api/dashboard': { totals: { archives: 1 }, finance: { income: 0, expense: 0 }, warnings: 0 },
      '/api/permissions': { catalog: ['archives.read'], roles, roleNames: { ADMIN: '系统管理员', MATERIAL: '物资管理员' }, sections: {} },
      '/api/users': [user], '/api/files': [{ id: 1, original_name: '长附件名' + 'Z'.repeat(80) + '.txt', size: 1 }],
      '/api/trash': [{ ...record('archives'), deleted_at: '2026-10-19' }],
      '/api/audit': [{ id: 1, created_at: '2026-10-19', display_name: '合成人员', action: 'VIEW', entity: 'records', detail: '合成日志' }],
      '/api/materials/meta': { capabilities: { createRequest: true }, warehouses: [{ code: 'MAIN', name: '默认仓库' }], openingClosed: false }
    };
    let body = results[url.pathname] ?? [];
    if (url.pathname === '/api/records') body = [record(url.searchParams.get('module'))];
    if (url.pathname.startsWith('/api/materials/') && url.pathname !== '/api/materials/meta') body = { items: [], total: 0, page: 1, pageSize: 50 };
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
      return { width, pageWidth: document.documentElement.scrollWidth, outside };
    });
    assert.ok(result.pageWidth <= result.width + 1, `${label}: page overflow ${JSON.stringify(result)}`);
    assert.deepEqual(result.outside, [], `${label}: controls must remain inside the viewport`);
  };
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(base); await page.locator('.nav button').last().waitFor();
    await page.evaluate(() => setupDateFilters());
    for (const module of Object.keys(labels)) {
      const button = page.locator(`[data-nav="${module}"]`).first();
      await button.click();
      await page.waitForFunction(module => current === module && !document.querySelector('#page .empty')?.textContent.includes('正在加载'), module);
      await checkLayout(`${width}px ${module}`);
      if (width < 900 && ['dashboard', 'archives'].includes(module)) await page.screenshot({ path: path.join(screenshots, `${width}-${module}.png`), fullPage: true });
      if (module === 'finance' && width < 900) {
        const table = page.locator('#page .table');
        assert.ok(await table.evaluate(node => node.scrollWidth > node.clientWidth), 'wide tables scroll inside their own container');
        const edit = table.locator('.ops button').nth(1);
        await edit.click();
        await page.locator('#editor').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#edit-title').textContent(), '编辑记录', 'scrolled table actions remain clickable');
        await page.evaluate(() => editor.close());
      }
      if (width <= 900) {
        assert.notEqual(await button.locator('b').evaluate(node => getComputedStyle(node).display), 'none', 'mobile menus retain Chinese labels');
        assert.ok((await button.boundingBox()).height >= 44, 'navigation remains touchable');
      }
    }
    for (const section of ['accounts', 'roles', 'nav', 'dashboard']) {
      await page.locator('[data-nav="management"]').first().click();
      await page.locator(`[data-mcard="${section}"]`).waitFor();
      await page.locator(`[data-mcard="${section}"]`).click();
      await page.waitForFunction(() => !document.querySelector('[data-mcard]'));
      await checkLayout(`${width}px management ${section}`);
      if (width < 900 && section === 'accounts') await page.screenshot({ path: path.join(screenshots, `${width}-accounts.png`), fullPage: true });
    }
    await page.evaluate(() => go('assets')); await page.locator('#asset-add').click();
    await page.locator('#editor').waitFor({ state: 'visible' });
    const dialog = page.locator('#editor');
    await dialog.locator('[type="submit"]').scrollIntoViewIfNeeded();
    assert.ok(await dialog.locator('[type="submit"]').isVisible(), 'long form save action remains reachable');
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.height <= 822, `${width}px long dialog fits viewport`);
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
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('#editor').evaluate(node => getComputedStyle(node).maxHeight), 'none', 'screen dialog height limits do not truncate printing');
  assert.deepEqual(errors, [], 'actual module scripts run without browser errors');
});
