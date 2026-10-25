// @ts-check
import path from 'node:path';

const MAX_NAME = 120;

// The name employers see when a document is uploaded. The file on disk keeps
// its unique stored name; this only cleans what the user typed or picked:
// no path separators or control characters, a bounded length and the stored
// file's own extension, so the uploaded file still opens as the same type.
export function cleanDocumentName(name, storedName) {
  const extension = path.extname(storedName).toLowerCase();
  let stem = String(name ?? '')
    .normalize('NFC')
    .replace(/[\\/]/g, '-')
    .replace(/[\p{Cc}\p{Cf}<>:"|?*]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (extension && stem.toLowerCase().endsWith(extension)) stem = stem.slice(0, -extension.length);
  // A trailing dot or space is dropped by some systems; leading dots hide files.
  stem = stem.replace(/^[.\s]+|[.\s]+$/g, '');
  stem = [...stem]
    .slice(0, MAX_NAME - extension.length)
    .join('')
    .trim();
  return stem ? stem + extension : null;
}

// Display names of the documents the user added, keyed by their path
// relative to the workspace folder (forward slashes on every system).
export class WorkspaceDocumentNames {
  constructor(workspaces) {
    this.db = workspaces.db;
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS workspace_document_names(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,path TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(workspace_id,path))',
    );
  }
  get(id, relative) {
    const row = /** @type {{name: string} | undefined} */ (
      this.db
        .prepare('SELECT name FROM workspace_document_names WHERE workspace_id=? AND path=?')
        .get(id, relative)
    );
    return row?.name ?? null;
  }
  all(id) {
    const rows = /** @type {{path: string, name: string}[]} */ (
      this.db.prepare('SELECT path,name FROM workspace_document_names WHERE workspace_id=?').all(id)
    );
    return new Map(rows.map((row) => [row.path, row.name]));
  }
  set(id, relative, name) {
    this.db
      .prepare(
        'INSERT INTO workspace_document_names(workspace_id,path,name) VALUES(?,?,?) ON CONFLICT(workspace_id,path) DO UPDATE SET name=excluded.name',
      )
      .run(id, relative, name);
  }
}
