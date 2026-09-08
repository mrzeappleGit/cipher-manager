import test from 'node:test';
import assert from 'node:assert/strict';
import { publicPath, exportPublic } from './export-public.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('public source keeps code and release docs, excludes private data and old refs', () => {
  for (const p of ['src/App.tsx','src-tauri/src/main.rs','LICENSE','scripts/export-public.mjs','docs/releasing.md','.github/workflows/release.yml']) assert.equal(publicPath(p), true, p);
  for (const p of ['.git/config','.claude/launch.json','.agents/skills/deploy/SKILL.md','docs/superpowers/plans/private.md','snapshot-data.json','.env','src/.env','src-tauri/target/release/app.exe','mobile/android/local.properties','notes.txt','private.pem','src/../notes.txt']) assert.equal(publicPath(p), false, p);
});

test('export creates a fresh directory and refuses overwrite or outside destinations', () => {
  const root = mkdtempSync(join(tmpdir(), 'cipher-export-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/App.tsx'), 'export default 1;');
  writeFileSync(join(root, '.env'), 'PRIVATE=test');
  const dest = join(root, '.release-private/public-source-test');
  exportPublic(root, dest, ['src/App.tsx','.env']);
  assert.equal(readFileSync(join(dest, 'src/App.tsx'), 'utf8'), 'export default 1;');
  assert.throws(() => exportPublic(root, dest, []), /exists/);
  assert.throws(() => exportPublic(root, join(root, '../outside'), []), /destination/);
});
