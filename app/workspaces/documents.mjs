import {mkdir, copyFile, chmod, realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {
  listDocuments,
  documentPath,
  readDocument,
  agentDocument,
  documentKey,
} from '../automation/artifacts.mjs';
import {cleanDocumentName, withUploadNames} from './document-names.mjs';

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
  list(id) {
    return listDocuments(this.directory(id)).then((docs) =>
      withUploadNames(docs, this.names.all(id)),
    );
  }
  async rename(id, file, name) {
    this.workspaces.assertMutable(id);
    const root = this.directory(id),
      key = documentKey(path.relative(await realpath(root), await documentPath(root, file)));
    if (agentDocument(key)) throw Error('Only documents you added can be renamed');
    const clean = cleanDocumentName(name, key);
    if (!clean) throw Error('Enter a file name');
    this.names.set(id, key, clean);
    this.workspaces.changed(id);
    return clean;
  }
  // The upload name of a document by its workspace-relative path, or null.
  displayName(id, relative) {
    return this.names.get(id, documentKey(relative));
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
      const key = documentKey(relative),
        name = cleanDocumentName(path.basename(source), key);
      // A reused path (CV.pdf) never keeps the name of the file it replaced.
      if (name) this.names.set(id, key, name);
      else this.names.delete(id, key);
      await driver.documentAdded?.(id, {
        purpose,
        path: target,
        relative,
        name: name ?? path.basename(target),
      });
      this.workspaces.changed(id);
      return target;
    } finally {
      this.workspaces.changing.delete(id);
    }
  }
}
