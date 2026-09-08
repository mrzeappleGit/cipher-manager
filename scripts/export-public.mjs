import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const rootFiles = new Set(['README.md','LICENSE','SECURITY.md','THIRD_PARTY_NOTICES.md','ROADMAP.md','.gitignore','.gitleaks.toml','package.json','package-lock.json','index.html','vite.config.ts','tsconfig.json','tsconfig.node.json']);
const releaseDocs = new Set(['docs/releasing.md','docs/dependencies.md','docs/testing-windows.md','docs/release-notes.md']);

export function publicPath(path) {
  const parts = path.split('/');
  if (isAbsolute(path) || path.includes('\\') || parts.some(p => !p || p === '.' || p === '..')) return false;
  if (parts.some(p => ['.git','.claude','.agents','.codex','node_modules','target','binaries','build','dist','dist-snapshot','.gradle','.idea','gen'].includes(p))) return false;
  if (parts.some(p => p.startsWith('.env')) || /(?:\.pem|\.pfx|\.p12|\.key|\.keystore|\.jks|\.log|\.jsonl|\.exe|\.apk|\.msi)$/i.test(path)) return false;
  if (/(?:^|\/)(?:local\.properties|settings\.local\.json|snapshot-data\.json|snapshot\.html)$/.test(path)) return false;
  return rootFiles.has(path) || releaseDocs.has(path) || /^(?:src|src-tauri|public|scripts|mobile|even-g2|streamdeck)\//.test(path) || /^\.github\//.test(path);
}

export function exportPublic(root, destination, paths) {
  root = resolve(root);
  destination = resolve(destination);
  const relDest = relative(root, destination).replaceAll('\\', '/');
  if (!/^\.release-private\/public-source-[a-zA-Z0-9._-]+$/.test(relDest)) throw new Error('Export destination must be .release-private/public-source-<name> inside this repository');
  if (existsSync(destination)) throw new Error('Export destination already exists; use a new name to avoid stale private files');
  // Refuse linked destination ancestors as well as linked source files.
  const privateDir = join(root, '.release-private');
  if (existsSync(privateDir) && lstatSync(privateDir).isSymbolicLink()) throw new Error('Linked export destination refused');
  mkdirSync(destination, {recursive: true});
  const included = [];
  for (const path of [...new Set(paths)].sort()) {
    if (!publicPath(path)) continue;
    let source = root;
    for (const part of path.split('/')) {
      source = join(source, part);
      if (!existsSync(source) || lstatSync(source).isSymbolicLink()) throw new Error(`Missing or linked source refused: ${path}`);
    }
    if (!lstatSync(source).isFile()) continue;
    const target = join(destination, ...path.split('/'));
    mkdirSync(dirname(target), {recursive: true});
    copyFileSync(source, target);
    included.push(path);
  }
  writeFileSync(join(destination, 'SOURCE_EXPORT.txt'), 'Clean working-tree source export. No Git history, tags, credentials or local agent notes are intentionally included. Review and scan before publication.\n');
  return included;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.cwd();
  const paths = execFileSync('git', ['ls-files','--cached','--others','--exclude-standard','-z'], {encoding:'utf8', maxBuffer:32*1024*1024}).split('\0').filter(Boolean);
  const destination = resolve(root, process.argv[2] || `.release-private/public-source-${new Date().toISOString().replace(/[:]/g,'-')}`);
  const included = exportPublic(root, destination, paths);
  console.log(`Exported ${included.length} files without Git history to ${destination}`);
}
