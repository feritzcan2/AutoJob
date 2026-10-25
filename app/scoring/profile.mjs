import {readFile, stat, realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {documentPath, agentDocument} from '../automation/artifacts.mjs';
import {workspaceDirectory} from '../workspaces/paths.mjs';
import {candidateFacts, profileView} from '../templates/profile-sections.mjs';
const cache = new Map(),
  MAX_TEXT = 300000;
const source = (text, extra = {}) => ({
  text,
  digest: createHash('sha256').update(text).digest('hex'),
  ...extra,
});
// fields are the template's fields; they place each criterion in its profile section.
export function scoringSources(automation, documents, fields = []) {
  const facts = candidateFacts(automation, fields);
  // Preferences are the workspace goal and its saved criteria, whatever the
  // template, except facts about the user, the rubric and the action settings,
  // which decide what may be done rather than what fits.
  const view = profileView(automation, fields),
    criteria = [...view.search, ...view.rules]
      .filter((f) => f.id !== 'ranking')
      .map((f) => f.value);
  return {
    facts: source(facts),
    preferences: source(
      [automation.goal, ...criteria, automation.instructions].filter(Boolean).join('\n'),
    ),
    ...(documents ? {documents} : {}),
  };
}
async function documentText(file) {
  const info = await stat(file);
  if (info.size > 10 * 1024 * 1024) throw Error('must be at most 10 MB for the text check');
  const key = JSON.stringify([file, info.size, info.mtimeMs]);
  if (cache.has(key)) return cache.get(key);
  let text;
  const extension = path.extname(file).toLowerCase();
  if (['.txt', '.md'].includes(extension)) text = await readFile(file, 'utf8');
  else if (extension === '.pdf') {
    const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({
      data: new Uint8Array(await readFile(file)),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
    });
    try {
      const pdf = await loading.promise;
      if (pdf.numPages > 40) throw Error('must have at most 40 pages');
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i),
          content = await page.getTextContent();
        pages.push(
          content.items
            .map((x) => (typeof x.str === 'string' ? x.str + (x.hasEOL ? '\n' : ' ') : ''))
            .join(''),
        );
        page.cleanup();
      }
      text = pages.join('\n');
    } finally {
      await loading.destroy();
    }
  } else throw Error('no text could be extracted from this format');
  if (cache.size >= 32) cache.delete(cache.keys().next().value);
  cache.set(key, text);
  return text;
}
// The text of every document the user added to this workspace. Files the app
// or agents wrote (generated/) are not user facts. Null without documents.
async function readUserDocuments(db, id) {
  const saved = db.userDocuments(id).filter((file) => file && !agentDocument(file));
  if (!saved.length) return null;
  const root = await realpath(workspaceDirectory(db.store.directory, db.store.workspaces.get(id))),
    files = [...new Set(saved.map((file) => path.resolve(root, file)))];
  const documents = [],
    skipped = [];
  let length = 0;
  for (const file of files) {
    const label = path.relative(root, file).startsWith('..')
      ? path.basename(file)
      : path.relative(root, file).split(path.sep).join('/');
    try {
      const requested = await realpath(file),
        safe = await documentPath(root, path.relative(root, requested)),
        text = (await documentText(safe)).trim();
      if (length + text.length > MAX_TEXT) throw Error('total document text limit exceeded');
      documents.push({path: label, text});
      length += text.length;
    } catch (error) {
      skipped.push(`${label} (${error.code === 'ENOENT' ? 'file not found' : error.message})`);
    }
  }
  return {documents, skipped};
}
// Profile documents are every document the user added to this workspace.
export async function loadScoringDocuments(db, id) {
  const read = await readUserDocuments(db, id);
  if (!read)
    return source('', {
      unavailable: 'No saved documents; leave unverified information as unknown.',
    });
  const {documents, skipped} = read,
    names = db.store.workspaces.documentNames?.all(id) ?? new Map();
  // Upload names stay outside the text, so renaming a document changes no digest.
  const uploadNames = Object.fromEntries(
    documents.filter((d) => names.has(d.path)).map((d) => [d.path, names.get(d.path)]),
  );
  return source(documents.map((d) => `## ${d.path}\n${d.text}`).join('\n\n'), {
    paths: documents.map((d) => d.path),
    ...(Object.keys(uploadNames).length ? {uploadNames} : {}),
    ...(skipped.length
      ? {
          unavailable: `Unreadable documents: ${skipped.join('; ')}. Information from these documents stays unknown.`,
        }
      : {}),
  });
}

// Vocabulary that recognises a cover letter the user wrote: in its file name,
// or a letter's greeting at the top and a closing line.
const LETTER_NAME =
    /cover(?:ing)?\s*letter|motivation(?:al)?\s*letter|letter\s+of\s+motivation|anschreiben|motivationsschreiben|bewerbungsschreiben|lettre\s+de\s+motivation|carta\s+de\s+presentaci[oó]n|lettera\s+di\s+presentazione|sollicitatiebrief|motivatiebrief|list\s+motywacyjny|[oö]n\s*yaz[iı]|personligt\s+brev|f[oø]lgebrev/i,
  LETTER_GREETING =
    /^\s*(?:dear|hello|sehr geehrte|liebe|hallo|guten tag|say[ıi]n|merhaba|madame|monsieur|bonjour|estimad[oa]s?|gentile|geachte|beste|szanown|hej|k[æa]re)\b/im,
  LETTER_CLOSING =
    /^\s*(?:(?:yours\s+)?sincerely|(?:kind|best|warm)\s+regards|regards|yours\s+(?:faithfully|truly)|mit\s+freundlichen\s+gr[üu](?:ß|ss)en|(?:viele|beste)\s+gr[üu](?:ß|ss)e|sayg[ıi]lar[ıi]mla|cordialement|atentamente|cordiali\s+saluti|met\s+vriendelijke\s+groet|z\s+powa[żz]aniem|med\s+v[äa]nliga\s+h[äa]lsningar|med\s+venlig\s+hilsen)\b/im,
  LETTER_CHARACTERS = 8000;
export const userCoverLetter = ({path: file, text}) =>
  LETTER_NAME.test(path.basename(file).replace(/[\s._-]+/g, ' ')) ||
  (text.length <= LETTER_CHARACTERS &&
    LETTER_GREETING.test(text.slice(0, 600)) &&
    LETTER_CLOSING.test(text));

// Cover letters among the user's own documents, the model for the letters the
// app writes. Agent-written letters are never included.
export async function loadUserCoverLetters(db, id, {limit = 3} = {}) {
  const read = await readUserDocuments(db, id);
  return (read?.documents ?? [])
    .filter((d) => d.text && userCoverLetter(d))
    .slice(-limit)
    .map((d) => ({path: d.path, text: d.text.slice(0, LETTER_CHARACTERS)}));
}
