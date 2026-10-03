import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('CLI and bundled Action both report one menu-depth warning while completing the build', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-pages-menu-'));
  try {
    const theme = path.join(root, 'theme');
    await fs.cp(new URL('../themes/plain/', import.meta.url), theme, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(theme, 'theme.json')));
    manifest.menu_slots = { primary: { title: 'Primary', max_depth: 1 } };
    await fs.writeFile(path.join(theme, 'theme.json'), JSON.stringify(manifest));
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, 'docs/index.md'), '# Home\n');
    await fs.writeFile(path.join(root, 'docs/other.md'), '# Other\n');
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
      version: '1.0',
      menus: { primary: { name: 'Primary', items: [{ title: 'Parent', url: '/', children: [{ title: 'Child', url: '/other/' }] }] } },
    }));
    const cli = [
      fileURLToPath(new URL('../bin/zeropress-build-pages.js', import.meta.url)),
      '--source', 'docs', '--destination', '_site', '--theme-path', 'theme', '--config', 'config.json', '--skip-link-check',
    ];
    const action = [fileURLToPath(new URL('../dist/action.js', import.meta.url))];
    const outputs = [];
    for (const args of [cli, action]) {
      const result = spawnSync(process.execPath, args, {
        cwd: root, encoding: 'utf8', env: {
          ...process.env, NO_COLOR: '1', FORCE_COLOR: '0',
          INPUT_SOURCE: 'docs', INPUT_CONFIG: 'config.json', 'INPUT_THEME-PATH': 'theme',
          'INPUT_SKIP-LINK-CHECK': 'true',
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal((result.stderr.match(/MENU_MAX_DEPTH_EXCEEDED/g) || []).length, 1, result.stderr);
      assert.match(result.stderr, /depth 2; the theme supports 1\. 1 deeper item/);
      assert.match(result.stdout, /Built ZeroPress Pages site successfully/);
      outputs.push(result.stderr);
    }
    assert.equal(outputs[0], outputs[1]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
