import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'patchright-core';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {WorkspaceDocuments} from '../app/workspaces/documents.mjs';
import {cleanDocumentName} from '../app/workspaces/document-names.mjs';
import {uploadFile} from '../app/jev/upload.mjs';
import {JevBrowser} from '../app/jev/browser.mjs';
import {createBackup} from '../app/system/data-management.mjs';

test('document names are cleaned and keep the stored extension', () => {
  const stored = 'documents/590d53ef-421c-4360-8462-37c660200dd1.pdf';
  assert.equal(cleanDocumentName('Omar Rashad - Resume.pdf', stored), 'Omar Rashad - Resume.pdf');
  assert.equal(cleanDocumentName('Omar Rashad - Resume', stored), 'Omar Rashad - Resume.pdf');
  assert.equal(cleanDocumentName('Resume.PDF', stored), 'Resume.pdf');
  assert.equal(cleanDocumentName('../../etc/passwd', stored), '-..-etc-passwd.pdf');
  assert.equal(cleanDocumentName('a\\b/c.pdf', stored), 'a-b-c.pdf');
  assert.equal(cleanDocumentName('CV\u0000‮fdp.exe\n', stored), 'CVfdp.exe.pdf');
  assert.equal(
    cleanDocumentName('Lebenslauf Müller – Çağrı.pdf', stored),
    'Lebenslauf Müller – Çağrı.pdf',
  );
  assert.equal(cleanDocumentName('  .hidden. ', stored), 'hidden.pdf');
  assert.equal(cleanDocumentName('   ', stored), null);
  assert.equal(cleanDocumentName('.pdf', stored), null);
  const long = cleanDocumentName('x'.repeat(500), stored);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('.pdf'));
  assert.equal(cleanDocumentName('Brief.docx', 'documents/id.pdf'), 'Brief.docx.pdf');
});

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'jobloop-document-names-')),
    root = path.join(base, 'workspace'),
    picked = path.join(base, 'picked');
  await mkdir(root, {recursive: true});
  await mkdir(picked);
  const core = new WorkspaceDatabase(path.join(base, 'jobloop.sqlite')),
    id = randomUUID();
  core.workspaces.save(id, 'job-search', {name: 'Test'});
  const changes = [];
  let next = null;
  const workspaces = {
    store: core.workspaces,
    changing: new Set(),
    assertMutable: () => {},
    changed: (value) => changes.push(value),
    template: () => ({
      directory: () => root,
      documentPurposes: ['attachment', 'cv'],
    }),
  };
  const documents = new WorkspaceDocuments(workspaces, {
    dialog: {showOpenDialog: async () => ({canceled: false, filePaths: [next]})},
    shell: {},
    window: () => null,
  });
  const add = async (name, content, purpose = 'attachment') => {
    next = path.join(picked, name);
    await writeFile(next, content);
    return documents.pick(id, {purpose});
  };
  t.after(async () => {
    core.close();
    await rm(base, {recursive: true, force: true});
  });
  return {base, root, core, id, documents, add, changes};
}

test('an added document keeps its ID name on disk and its original name for uploads', async (t) => {
  const f = await fixture(t);
  const first = await f.add('Omar Rashad - Resume.pdf', 'resume one'),
    second = await f.add('Omar Rashad - Resume.pdf', 'resume two');
  assert.match(path.basename(first), /^[0-9a-f-]{36}\.pdf$/);
  assert.notEqual(first, second, 'two documents with the same name never share a file');
  assert.equal(await readFile(first, 'utf8'), 'resume one');
  assert.equal(await readFile(second, 'utf8'), 'resume two');
  const listed = await f.documents.list(f.id);
  assert.equal(listed.length, 2);
  for (const doc of listed) {
    assert.equal(doc.displayName, 'Omar Rashad - Resume.pdf');
    assert.match(doc.name, /^[0-9a-f-]{36}\.pdf$/);
  }
  assert.equal(await f.documents.displayName(f.id, first), 'Omar Rashad - Resume.pdf');
  const cv = await f.add('my cv (final).pdf', 'cv', 'cv');
  assert.equal(path.basename(cv), 'CV.pdf');
  assert.equal(await f.documents.displayName(f.id, cv), 'my cv (final).pdf');
});

test('a document without a saved name keeps its stored name', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'documents'));
  const legacy = path.join(f.root, 'documents', 'earlier.pdf');
  await writeFile(legacy, 'legacy');
  const [doc] = await f.documents.list(f.id);
  assert.equal(doc.displayName, 'earlier.pdf');
  assert.equal(await f.documents.displayName(f.id, legacy), null);
  assert.equal(
    await f.documents.displayName(f.id, path.join(f.base, 'outside.pdf')).catch(() => null),
    null,
  );
});

test('renaming changes only the upload name, never the stored file', async (t) => {
  const f = await fixture(t);
  const file = await f.add('scan_0042.pdf', 'resume'),
    relative = path.relative(f.root, file).split(path.sep).join('/'),
    before = await stat(file);
  assert.equal(
    await f.documents.rename(f.id, relative, '  Omar Rashad / Resume  '),
    'Omar Rashad - Resume.pdf',
  );
  assert.equal(await f.documents.displayName(f.id, file), 'Omar Rashad - Resume.pdf');
  assert.deepEqual(await readdir(path.join(f.root, 'documents')), [path.basename(file)]);
  assert.equal(await readFile(file, 'utf8'), 'resume');
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  assert.ok(f.changes.includes(f.id));
  await assert.rejects(f.documents.rename(f.id, relative, '   '), /Enter a file name/);
  await writeFile(path.join(f.base, 'outside.pdf'), 'outside');
  await assert.rejects(f.documents.rename(f.id, '../outside.pdf', 'x'), /cannot be displayed/);
  await mkdir(path.join(f.root, 'generated', 'cover-letters'), {recursive: true});
  await writeFile(path.join(f.root, 'generated', 'cover-letters', 'letter.pdf'), 'letter');
  await assert.rejects(
    f.documents.rename(f.id, 'generated/cover-letters/letter.pdf', 'Letter'),
    /Only documents you added/,
  );
});

test('document names are part of backups and are removed with their workspace', async (t) => {
  const f = await fixture(t);
  const file = await f.add('Omar Rashad - Resume.pdf', 'resume');
  const exports = await mkdtemp(path.join(tmpdir(), 'jobloop-document-names-export-')),
    destination = path.join(exports, 'export');
  t.after(() => rm(exports, {recursive: true, force: true}));
  await createBackup({
    dataDirectory: f.base,
    db: f.core.db,
    destination,
    appVersion: '0.1.0',
  });
  const backup = new DatabaseSync(path.join(destination, 'jobloop.sqlite'), {readOnly: true});
  try {
    assert.deepEqual(
      {...backup.prepare('SELECT path,name FROM workspace_document_names').get()},
      {
        path: path.relative(f.root, file).split(path.sep).join('/'),
        name: 'Omar Rashad - Resume.pdf',
      },
    );
  } finally {
    backup.close();
  }
  f.core.workspaces.remove(f.id);
  assert.equal(f.core.db.prepare('SELECT count(*) AS n FROM workspace_document_names').get().n, 0);
});

test('data saved before document names opens with stored names as upload names', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'jobloop-document-names-upgrade-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const file = path.join(base, 'jobloop.sqlite'),
    id = randomUUID();
  const old = new DatabaseSync(file);
  old.exec(
    'CREATE TABLE workspaces(id TEXT PRIMARY KEY,template_id TEXT NOT NULL,data TEXT NOT NULL); PRAGMA user_version=45',
  );
  old
    .prepare('INSERT INTO workspaces VALUES(?,?,?)')
    .run(id, 'job-search', JSON.stringify({id, templateId: 'job-search', title: 'Old'}));
  old.close();
  const core = new WorkspaceDatabase(file);
  try {
    assert.equal(core.workspaces.documentNames.get(id, 'documents/a.pdf'), null);
    assert.equal(core.workspaces.documentNames.all(id).size, 0);
    core.workspaces.documentNames.set(id, 'documents/a.pdf', 'Resume.pdf');
    assert.equal(core.workspaces.documentNames.get(id, 'documents/a.pdf'), 'Resume.pdf');
  } finally {
    core.close();
  }
});

test('the upload name is checked against the field purpose and falls back to the stored name', async () => {
  const name = (resolved) =>
    JevBrowser.prototype.uploadName.bind({documentName: async () => resolved});
  assert.equal(
    await name('Omar - Resume.pdf')('/w/documents/id.pdf', 'Resume'),
    'Omar - Resume.pdf',
  );
  assert.equal(await name(null)('/w/documents/id.pdf', 'Resume'), 'id.pdf');
  const failing = JevBrowser.prototype.uploadName.bind({
    documentName: async () => {
      throw Error('database closed');
    },
  });
  assert.equal(await failing('/w/documents/id.pdf', 'Resume'), 'id.pdf');
  await assert.rejects(
    name('CV - Omar.pdf')('/w/documents/id.pdf', 'Cover letter'),
    /cover letter field/,
  );
});

test('the page receives the display name with the original bytes; unnamed files go by path', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'jobloop-upload-name-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const file = path.join(base, '590d53ef-421c-4360-8462-37c660200dd1.pdf');
  await writeFile(file, '%PDF-1.4 synthetic resume');
  assert.equal(await uploadFile(file, null), file);
  assert.equal(await uploadFile(file, path.basename(file)), file);
  const browser = await chromium.launch({channel: 'chrome', headless: true}).catch(() => null);
  if (!browser) return t.skip('Chrome is not available');
  t.after(() => browser.close());
  const page = await browser.newPage();
  const received = () =>
    page.evaluate(async () => {
      const f = document.querySelector('input').files[0];
      return {name: f.name, type: f.type, text: await f.text()};
    });
  await page.setContent('<input type=file>');
  const input = await page.$('input');
  await input.setInputFiles(await uploadFile(file, 'Omar Rashad - Resume.pdf'));
  assert.deepEqual(await received(), {
    name: 'Omar Rashad - Resume.pdf',
    type: 'application/pdf',
    text: '%PDF-1.4 synthetic resume',
  });
  await input.setInputFiles(await uploadFile(file, null));
  assert.equal((await received()).name, path.basename(file));
  // A button that opens the file chooser receives the same name.
  await page.setContent(
    '<button onclick="document.querySelector(\'input\').click()">Upload</button><input type=file hidden>',
  );
  const chooser = page.waitForEvent('filechooser');
  await page.click('button');
  await (await chooser).setFiles(await uploadFile(file, 'Omar Rashad - Resume.pdf'));
  assert.equal((await received()).name, 'Omar Rashad - Resume.pdf');
});
