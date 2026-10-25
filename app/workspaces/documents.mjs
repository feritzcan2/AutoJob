import {mkdir, copyFile, chmod, realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {
  listDocuments,
  documentPath,
  readDocument,
  agentDocument,
} from '../automation/artifacts.mjs';
import {cleanDocumentName} from './document-names.mjs';

const extensions = {
  attachment: ['pdf', 'docx', 'txt', 'md', 'png', 'jpg', 'jpeg'],
  cv: ['pdf', 'docx', 'txt'],
};

export class WorkspaceDocuments {
  constructor(workspaces, {dialog, shell, window}) {
    Object.assign(this, {workspaces, dialog, shell, window});
  }
  directory(id) {
    return this.workspaces.template(id).directory(id);
  }
  get names() {
    return this.workspaces.store.documentNames;
  }
  // Each document carries the name employers receive when it is uploaded:
  // the user's chosen name, else the name it is stored under.
  list(id) {
    const root = this.directory(id),
      names = this.names.all(id);
    return listDocuments(root).then((docs) =>
      docs.map((doc) => ({...doc, displayName: names.get(doc.path) ?? doc.name})),
    );
  }
  async rename(id, file, name) {
    this.workspaces.assertMutable(id);
    const root = this.directory(id),
      relative = path.relative(await realpath(root), await documentPath(root, file));
    const key = relative.split(path.sep).join('/');
    if (agentDocument(key)) throw Error('Only documents you added can be renamed');
    const clean = cleanDocumentName(name, key);
    if (!clean) throw Error('Enter a file name');
    this.names.set(id, key, clean);
    this.workspaces.changed(id);
    return clean;
  }
  // The upload name of an absolute workspace file, or null when it has none.
  async displayName(id, file) {
    const base = await realpath(this.directory(id)),
      relative = path.relative(base, await realpath(file));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      return null;
    return this.names.get(id, relative.split(path.sep).join('/'));
  }
  read(id, file) {
    return readDocument(this.directory(id), file);
  }
  async open(id, file) {
    const error = await this.shell.openPath(await documentPath(this.directory(id), file));
    if (error) throw Error(error);
  }
  async pick(id, {purpose = 'attachment'} = {}) {
    const driver = this.workspaces.template(id);
    const validate = () => {
      this.workspaces.assertMutable(id);
      if (!extensions[purpose] || !driver.documentPurposes.includes(purpose))
        throw Error('This document type is not supported in the workspace');
      driver.beforeDocument?.(id, purpose);
    };
    validate();
    const picked = await this.dialog.showOpenDialog(this.window(), {
      properties: ['openFile'],
      filters: [{name: purpose === 'cv' ? 'CV' : 'Documents', extensions: extensions[purpose]}],
    });
    if (picked.canceled) return null;
    validate();
    const source = picked.filePaths[0],
      extension = path.extname(source).slice(1).toLowerCase();
    if (!extensions[purpose].includes(extension)) throw Error('Unsupported document type');
    this.workspaces.changing.add(id);
    try {
      const root = this.directory(id),
        relative =
          purpose === 'cv'
            ? `CV.${extension}`
            : path.join('documents', `${randomUUID()}.${extension}`),
        target = path.join(root, relative);
      await mkdir(path.dirname(target), {recursive: true, mode: 0o700});
      await copyFile(source, target);
      await chmod(target, 0o600);
      const key = relative.split(path.sep).join('/'),
        name = cleanDocumentName(path.basename(source), key);
      if (name) this.names.set(id, key, name);
      await driver.documentAdded?.(id, {
        purpose,
        path: target,
        relative,
        name: path.basename(source),
      });
      this.workspaces.changed(id);
      return target;
    } finally {
      this.workspaces.changing.delete(id);
    }
  }
}
