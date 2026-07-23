import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import test from 'node:test';

const serverRoot = resolve('dist/server');

async function assertLocalImportsStayInServer(file, visited = new Set()) {
  const absoluteFile = resolve(file);
  if (visited.has(absoluteFile)) return;
  visited.add(absoluteFile);

  const source = await readFile(absoluteFile, 'utf8');
  const imports = [
    ...source.matchAll(/(?:from\s+|import\s*\()\s*["'](\.[^"']+)["']/g),
  ].map((match) => match[1]);

  for (const specifier of imports) {
    const dependency = resolve(dirname(absoluteFile), specifier);
    assert.ok(
      dependency.startsWith(serverRoot + sep),
      `${specifier} escapes dist/server from ${absoluteFile}`,
    );
    await stat(dependency);
    await assertLocalImportsStayInServer(dependency, visited);
  }
}

test('Sites 服务入口的本地模块全部打包在 dist/server 内', async () => {
  execFileSync(process.execPath, ['scripts/build-worker.mjs']);
  await assertLocalImportsStayInServer(resolve(serverRoot, 'index.js'));
});
