'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { createTestDatabase } = require('./helpers/postgres');

test('generic record and attachment UI prevent duplicate writes after real committed responses are lost', {
  skip: (!process.env.LABOS_TEST_DATABASE_URL || !process.env.LABOS_TEST_BROWSER_MODULE) && 'Set the dedicated PostgreSQL and browser test environment',
  timeout: 120000,
}, async t => {
  const root = path.resolve(__dirname, '..');
  const database = await createTestDatabase(t);
  const cache = process.env.LABOS_TEST_CACHE_DIR || path.join(root, 'artifacts/cache', require('../package.json').version);
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'network-outcome-'));
  const runtime = path.join(directory, 'runtime');
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'src/server.js')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: database.url, PORT: String(port), LABOS_RUNTIME_DIR: runtime,
      LABOS_ADMIN_USER: 'outcome-admin', LABOS_ADMIN_PASSWORD: 'synthetic-outcome-password' },
  });
  let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill(); await exit;
    }
    assert.equal(path.dirname(path.resolve(runtime)), path.resolve(directory));
    fs.rmSync(runtime, { recursive: true, force: true });
  });
  const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(15000) });
  assert.match(String(output), /LabOS:/, stderr);
  const base = `http://127.0.0.1:${port}`;
  let cookie;
  const api = async (method, endpoint, body, status = 200) => {
    const response = await fetch(base + endpoint, { method, headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
    }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${endpoint}`);
    return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  cookie = (await api('POST', '/api/auth/login', { username: 'outcome-admin', password: 'synthetic-outcome-password' })).cookie;
  const { chromium } = require(process.env.LABOS_TEST_BROWSER_MODULE);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.LABOS_TEST_BROWSER_PATH ? { executablePath: process.env.LABOS_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const errors = [], checks = [];
  const check = (value, name) => { checks.push({ name, passed: Boolean(value) }); assert.ok(value, name); };
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await context.addCookies([{ name: 'labos_session', value: cookie.slice(cookie.indexOf('=') + 1), url: base }]);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('.nav [data-nav="archives"]').click();
    await page.locator('.archive-record-table').waitFor();
    return { context, page };
  };
  let status = 'failed';
  try {
    const first = await open();
    try {
      const page = first.page;
      let posts = 0;
      await page.route('**/api/records', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        posts++;
        const response = await route.fetch();
        check(response.status() === 201, 'the generic creation really commits before the response is lost');
        await route.abort('failed');
      });
      await page.locator('#add').click();
      await page.locator('#fields [name="title"]').fill('合成丢响应档案');
      await page.locator('#record-form [type="submit"]').click();
      await page.waitForFunction(() => document.querySelector('#editor')?.dataset.wsUncertain === 'true');
      check((await page.locator('#record-error').textContent()).includes('可能已保存'), 'generic creation does not claim definite failure');
      check(await page.locator('#record-form [type="submit"]').isDisabled(), 'a second non-idempotent record submission is blocked');
      check(await page.locator('#fields [name="title"]').isDisabled(), 'unknown generic creation freezes its original input');
      check(await page.locator('#fields [name="title"]').inputValue() === '合成丢响应档案', 'the original record input remains intact');
      await page.locator('#editor .modal-head .x').click();
      await page.locator('.nav [data-nav="templates"]').click();
      await page.locator('#logout').click();
      check(await page.locator('#editor').isVisible() && await page.locator('#title').textContent() === '资料档案', 'unknown creation blocks closing, real sidebar navigation and logout');
      check(Boolean((await api('GET', '/api/auth/me')).data.user), 'the server session survives blocked logout');
      const records = (await api('GET', '/api/records?module=archives&q=' + encodeURIComponent('合成丢响应档案'))).data;
      check(records.length === 1 && posts === 1, 'there is exactly one stored generic record and one POST');
      await page.screenshot({ path: path.join(directory, 'record-unknown.png') });
    } finally { await first.context.close(); }

    const record = (await api('POST', '/api/records', {
      module: 'archives', title: '合成附件待确认档案', status: '草稿', data: { access_roles: 'ADMIN' },
    }, 201)).data;
    const second = await open();
    try {
      const page = second.page;
      const row = page.locator('.archive-record-table tbody tr').filter({ hasText: '合成附件待确认档案' });
      await row.getByRole('button', { name: '查看档案', exact: true }).click();
      await page.locator('#detail').waitFor({ state: 'visible' });
      let posts = 0;
      await page.route('**/api/files', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        posts++;
        const response = await route.fetch();
        check(response.status() === 201, 'the attachment really commits before its response is lost');
        await route.abort('failed');
      });
      await page.locator('#file').setInputFiles({
        name: 'synthetic-outcome.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic-outcome-evidence'),
      });
      await page.waitForFunction(() => document.querySelector('#detail')?.dataset.wsUncertain === 'true');
      check((await page.locator('#file-error').textContent()).includes('文件可能已保存'), 'attachment unknown does not ask for blind retransmission');
      check(await page.locator('#file').isDisabled(), 'the pending file cannot be replaced or uploaded twice');
      check(await page.locator('#file').evaluate(node => node.files[0]?.name === 'synthetic-outcome.txt'), 'the selected original file is retained');
      await page.locator('#detail .modal-head .x').click();
      await page.locator('.nav [data-nav="templates"]').click();
      await page.locator('#logout').click();
      check(await page.locator('#detail').isVisible() && await page.locator('#title').textContent() === '资料档案', 'unknown attachment blocks close, sidebar navigation and logout');
      const files = (await api('GET', `/api/files?record_id=${record.id}`)).data;
      check(files.length === 1 && posts === 1, 'exactly one attachment exists after the lost committed response');
      const download = await fetch(base + `/api/files/${files[0].id}/download`, { headers: { Cookie: cookie } });
      check(await download.text() === 'synthetic-outcome-evidence', 'the committed attachment bytes remain downloadable');
      await page.screenshot({ path: path.join(directory, 'attachment-unknown.png') });
    } finally { await second.context.close(); }

    const third = await open();
    try {
      const page = third.page;
      await page.locator('.archive-record-table tbody tr').filter({ hasText: '合成附件待确认档案' }).getByRole('button', { name: '查看档案', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#files')?.textContent.includes('正在加载'));
      await page.route('**/api/files*', async route => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'GET' && url.pathname === '/api/files') return route.abort('failed');
        return route.continue();
      });
      await page.locator('#file').setInputFiles({
        name: 'synthetic-refresh.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic-refresh-evidence'),
      });
      await page.waitForFunction(() => document.querySelector('#file-error')?.textContent.includes('文件已上传成功'));
      check((await page.locator('#file-error').textContent()).includes('勿重复上传'), 'confirmed upload with failed list refresh is not presented as a failed write');
      check(await page.locator('#file').evaluate(node => !node.disabled && node.files.length === 0), 'confirmed upload clears the file and does not leave an unknown lock');
      const files = (await api('GET', `/api/files?record_id=${record.id}`)).data;
      check(files.filter(file => file.original_name === 'synthetic-refresh.txt').length === 1, 'failed refresh leaves exactly one confirmed new attachment');
      await page.locator('#detail .modal-head .x').click();
      const fixture = await database.open();
      await fixture.prepare('DELETE FROM records WHERE module=?').run('templates');
      check((await api('GET', '/api/records?module=templates')).data.length === 0, 'the dedicated fixture explicitly starts with no generic template records');
      await page.locator('.nav [data-nav="templates"]').click();
      await page.locator('#record-empty-add').waitFor();
      await page.locator('#search').fill('synthetic-no-match');
      await page.locator('#record-empty-clear').waitFor();
      await page.locator('#record-empty-clear').click();
      await page.locator('#record-empty-add').waitFor();
      check(await page.locator('#search').inputValue() === '', 'the real empty state clears its query and restores the authorized new-record action');
      await page.screenshot({ path: path.join(directory, 'confirmed-upload-and-empty-state.png') });
    } finally { await third.context.close(); }
    check(errors.length === 0, 'the real unknown-outcome paths have no page script errors');
    status = 'passed';
  } finally {
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ status, checks, errors }, null, 2) + '\n');
    t.diagnostic(`Outcome checks: ${checks.length}; evidence: ${directory}`);
  }
});
