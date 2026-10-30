const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/publish-image.yml'), 'utf8').replace(/\r\n/g, '\n');
const packageJob = workflow.slice(workflow.indexOf('\n  package:\n'), workflow.indexOf('\n  verify_deployment:\n'));
const deploymentJob = workflow.slice(workflow.indexOf('\n  verify_deployment:\n'));

test('release assets wait for tests and both image architectures, then remain draft and immutable', () => {
  assert.match(workflow, /npm run verify:strict/);
  assert.match(workflow, /npm test 2>&1/);
  assert.match(workflow, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(packageJob, /^    needs: publish$/m);
  assert.doesNotMatch(packageJob, /always\(\)|continue-on-error/);
  assert.match(packageJob, /gh release create[\s\S]*--verify-tag --target "\$REVISION" --draft --prerelease --latest=false/);
  assert.doesNotMatch(workflow, /--clobber|gh release upload|gh release edit|--draft=false/);
  assert.match(packageJob, /scripts\/package\.ps1/);
  assert.doesNotMatch(packageJob, /scripts\/package-docker\.ps1|SHA256SUMS\.txt/);
  assert.match(packageJob, /readdirSync\(release\)\.length, 7/);
});

test('manual validation is isolated from publishing and retains the draft after all four gates', () => {
  assert.match(workflow, /validation_only:\n[\s\S]*type: boolean/);
  for (const input of ['frozen_commit', 'draft_release_id', 'index_digest', 'build_run_id']) assert.match(workflow, new RegExp(`      ${input}:\\n`));
  assert.match(workflow, /^    if: github\.repository == 'HotLL233\/labmg' && !inputs\.validation_only$/m);
  assert.match(deploymentJob, /github\.event_name == 'workflow_dispatch' && inputs\.validation_only/);
  for (const step of ['Gate 1 - anonymous', 'Gate 2 - captured', 'Gate 3 - official offline', 'Gate 4 - real Caddy', 'Verify full runtime backup and empty PostgreSQL restore']) {
    assert.ok(deploymentJob.includes(step), step);
    assert.ok(deploymentJob.indexOf(step) < deploymentJob.indexOf('Upload only verified missing assets'));
  }
  assert.match(deploymentJob, /export-ghcr-offline\.cjs" --validate/);
  assert.match(deploymentJob, /upload-draft-assets\.cjs" --execute-after-gates/);
  assert.doesNotMatch(deploymentJob, /gh release create|gh release edit|docker build|docker\/build-push-action/);
  assert.match(workflow, /LABOS_PUBLISHED_INDEX version=\$\{VERSION\} commit=\$\{REVISION\} digest=\$\{INDEX_DIGEST\}/);
  const scripts = [...workflow.matchAll(/^          node <<'NODE'\n([\s\S]*?)^          NODE$/gm)];
  assert.ok(scripts.length >= 7, 'workflow inline Node blocks must remain inspectable');
  for (const [index, script] of scripts.entries()) new vm.Script(script[1], { filename: `release-workflow-${index}.js` });
});

test('existing releases and failed lookups stop creation instead of overwriting assets', async () => {
  const step = packageJob.slice(packageJob.indexOf('      - name: Create draft prerelease with packaged assets'));
  const script = step.match(/node <<'NODE'\r?\n([\s\S]*?)\r?\n          NODE/);
  assert.ok(script, 'release lookup must run before the draft create command');
  assert.ok(step.indexOf("node <<'NODE'") < step.indexOf('gh release create'));
  assert.match(step, /set -euo pipefail/);
  for (const status of [404, 200, 401, 500]) {
    const errors = [];
    const context = {
      process: { env: { GITHUB_REPOSITORY: 'HotLL233/labmg', RELEASE_TAG: 'v9.8.7', GH_TOKEN: 'fixture-token' }, exitCode: 0 },
      console: { error: message => errors.push(message) },
      fetch: async (url, options) => {
        assert.equal(url, 'https://api.github.com/repos/HotLL233/labmg/releases/tags/v9.8.7');
        assert.equal(options.headers.Authorization, 'Bearer fixture-token');
        assert.equal(options.headers['User-Agent'], 'labmg-release-publisher');
        assert.ok(!options.method || options.method === 'GET');
        return { status, ok: status >= 200 && status < 300 };
      },
    };
    await vm.runInNewContext(script[1], context, { timeout: 2000 });
    assert.equal(context.process.exitCode, status === 404 ? 0 : 1);
    assert.equal(errors.length, status === 404 ? 0 : 1);
    if (status === 200) assert.match(errors[0], /Release already exists/);
    if (status === 401 || status === 500) assert.equal(errors[0], `Release lookup failed: ${status}`);
  }
});
