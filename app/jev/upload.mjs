import path from 'node:path';
import {readFile} from 'node:fs/promises';
// A hidden native file input is usable only through a rendered associated UI.
export function uploadDetails(e) {
  const rendered = (n) =>
    n?.isConnected &&
    !n.closest('[inert],[aria-hidden="true"]') &&
    n.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) &&
    n.getBoundingClientRect().width > 1 &&
    n.getBoundingClientRect().height > 1;
  if (!e.isConnected || e.disabled) return null;
  if (e.closest('[inert],[aria-hidden="true"]')) return null;
  const root = e.getRootNode();
  for (let h = root.host; h; h = h.getRootNode().host) if (!rendered(h)) return null;
  const labels = [...(e.labels ?? [])];
  const refs = (e.getAttribute('aria-labelledby') || '')
    .split(/\s+/)
    .map((id) => root.getElementById?.(id))
    .filter(Boolean);
  const linked = e.id
    ? [...root.querySelectorAll('[aria-controls]')].filter((n) =>
        n.getAttribute('aria-controls').split(/\s+/).includes(e.id),
      )
    : [];
  let localTrigger = false;
  for (
    let p = e.parentElement, depth = 0;
    p && depth < 4 && !p.matches('form,body');
    p = p.parentElement, depth++
  ) {
    if (p.querySelectorAll('input[type=file]').length !== 1) break;
    // A drop zone: the focusable or clickable box around a hidden input.
    localTrigger ||= rendered(p) && (p.tabIndex >= 0 || p.matches('label,[role=button]'));
    localTrigger ||= [...p.querySelectorAll('button,[role=button],a,[role=link]')].some(
      (n) =>
        rendered(n) &&
        /upload|attach|browse|select files?|choose files?|resume|cv|hochladen|anhängen|anfügen|datei auswählen|yükle|add file|datei hinzufügen|dosya ekle/i.test(
          n.textContent || n.getAttribute('aria-label') || '',
        ),
    );
  }
  if (!rendered(e) && ![...labels, ...refs, ...linked].some(rendered) && !localTrigger) return null;
  const explicit =
    e.getAttribute('aria-label') ||
    refs.map((n) => n.textContent.trim()).join(' ') ||
    labels.map((l) => l.innerText).join(' ') ||
    e.name ||
    'File upload';
  // Short text around the input (its group's name, often a few levels up)
  // tells a CV field from a cover-letter field.
  let context = '';
  for (
    let p = e.parentElement, depth = 0;
    p && depth < 6 && !p.matches('form,body');
    p = p.parentElement, depth++
  ) {
    const text = (p.innerText || '').replace(/\s+/g, ' ').trim();
    if (text.length > 200) continue;
    const cv = /\b(?:resume|résumé|curriculum vitae|cv)\b/i.test(text),
      letter = /cover\s*letter|anschreiben|ön\s*yazı/i.test(text);
    if (cv !== letter) {
      context = cv ? 'Resume/CV' : 'Cover Letter';
      break;
    }
  }
  return {
    label:
      context &&
      !/\b(?:resume|résumé|curriculum vitae|cv)\b|cover\s*letter|anschreiben|ön\s*yazı/i.test(
        explicit,
      )
        ? `${context} — ${explicit}`
        : explicit,
    accept: e.accept,
    multiple: e.multiple,
  };
}

// Resolve only a known native file input and its rendered local trigger.
// An ordinary button elsewhere in a large form must never be intercepted.
export function isUploadTrigger({input, node}) {
  const target = window.__jevFast?.nodes.get(node);
  if (!target || !input.isConnected) return false;
  if (input === target || [...(input.labels ?? [])].some((label) => label.contains(target)))
    return true;
  if (
    !/^(select files?|choose files?|browse|upload(?: file)?|attach(?: file)?|dosya seç|datei auswählen)$/i.test(
      (target.innerText || target.getAttribute('aria-label') || '').trim(),
    )
  )
    return false;
  for (
    let p = input.parentElement, depth = 0;
    p && depth < 4 && !p.matches('form,body');
    p = p.parentElement, depth++
  ) {
    if (p.querySelectorAll('input[type=file]').length !== 1) return false;
    if (p.contains(target)) return true;
  }
  return false;
}

export function validateUploadPurpose(label, filename) {
  const name = filename.replace(/\.[^.]+$/, '');
  if (
    /cover\s*letter|anschreiben|ön\s*yazı/i.test(label) &&
    /^(?:cv|resume|résumé)(?:[\s._-]|$)/i.test(name)
  )
    throw Error(
      'A CV file cannot be uploaded to the cover letter field; choose the correct cover letter document.',
    );
  if (
    /\b(?:resume|résumé|curriculum vitae|cv)\b/i.test(label) &&
    /^(?:cover[\s._-]*letter|anschreiben|ön[\s._-]*yazı)(?:[\s._-]|$)/i.test(name)
  )
    throw Error(
      'A cover letter file cannot be uploaded to the CV field; choose the correct CV document.',
    );
}

// What to hand to setInputFiles / FileChooser.setFiles so the page receives
// the file under its upload name. A file whose stored name is already that
// name is passed by path, unchanged; otherwise its bytes go under the new name
// (no temporary copy is written).
export async function uploadFile(file, name) {
  if (!name || name === path.basename(file)) return file;
  return {name, buffer: await readFile(file)};
}
