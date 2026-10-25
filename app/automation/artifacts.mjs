// @ts-check
import {readdir, realpath, stat, readFile} from 'node:fs/promises';
import path from 'node:path';
const extensions = new Set(['.pdf', '.docx', '.txt', '.md', '.png', '.jpg', '.jpeg']);
const excluded = new Set(['runtime', 'node_modules', 'AGENTS.md', 'CLAUDE.md']);
// Files the app or an agent wrote, such as cover letters, live under generated/;
// documents/ holds only what the user added. Letters saved before the split
// stay in documents/cover-letters/. Agent-written files are never user facts.
export const AGENT_DIRECTORY = 'generated';
// A workspace-relative path with forward slashes on every system: the key of
// the saved document list and of the documents' upload names.
export const documentKey = (relative) => relative.split(path.sep).join('/');
export const agentDocument = (relative) =>
  [AGENT_DIRECTORY + '/', 'documents/cover-letters/'].some((prefix) =>
    documentKey(relative).startsWith(prefix),
  );
export async function documentPath(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw Error('Invalid file');
  const base = await realpath(root),
    file = await realpath(path.resolve(base, relative));
  if (
    !file.startsWith(base + path.sep) ||
    relative.split(/[\\/]/).some((p) => p.startsWith('.') || excluded.has(p)) ||
    !extensions.has(path.extname(file).toLowerCase()) ||
    !(await stat(file)).isFile()
  )
    throw Error('This file cannot be displayed');
  return file;
}
export async function listDocuments(root) {
  const result = [];
  async function walk(dir, depth = 0) {
    if (depth > 5) return;
    let entries;
    try {
      entries = await readdir(dir, {withFileTypes: true});
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || excluded.has(entry.name) || entry.isSymbolicLink())
        continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(file, depth + 1);
        continue;
      }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const relative = documentKey(path.relative(root, file)),
          safe = await documentPath(root, relative),
          info = await stat(safe);
        result.push({
          path: relative,
          name: entry.name,
          size: info.size,
          updatedAt: info.mtime.toISOString(),
          // File systems without a birth time report 0; the change time stands in.
          createdAt: (info.birthtimeMs > 0 ? info.birthtime : info.mtime).toISOString(),
          generated: agentDocument(relative),
          preview: ['.txt', '.md'].includes(path.extname(entry.name).toLowerCase()),
        });
      } catch {}
    }
  }
  await walk(root);
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function readDocument(root, relative) {
  const file = await documentPath(root, relative);
  if (!['.txt', '.md'].includes(path.extname(file).toLowerCase()))
    throw Error('Text preview is not supported');
  if ((await stat(file)).size > 1024 * 1024)
    throw Error('The file is too large to preview; you can open the file.');
  return readFile(file, 'utf8');
}
