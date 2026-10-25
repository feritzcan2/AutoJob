// @ts-check
// Source text and observed URLs only. These rules identify generic site
// chrome, not fit: an unfamiliar listing URL must remain available for Jev to
// classify. No host, path or label specific to one website belongs here.
// Structural shape of an address: origin, parent path and depth. Two
// addresses with the same shape are siblings (/jobs/a and /jobs/b). Root-level
// paths have no shape; they are too broad to compare.
export function urlShape(value) {
  try {
    const url = new URL(value),
      parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    return parts.length >= 2
      ? `${url.origin}/${parts.slice(0, -1).join('/')}#${parts.length}`
      : null;
  } catch {
    return null;
  }
}

// Opaque identifiers inside an address: long tokens with a digit, taken from
// query values and path segments. Session tokens shared by every link on a
// page never identify one listing, so only values unique to one listing count.
const ID_VALUE = /^[A-Za-z0-9_-]{8,}$/;
function urlIds(raw) {
  try {
    const url = new URL(raw);
    return new Set(
      [...url.searchParams.values(), ...url.pathname.split('/')].filter(
        (v) => ID_VALUE.test(v) && /\d/.test(v),
      ),
    );
  } catch {
    return new Set();
  }
}
const decoded = (raw) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};
// An uncertain link that carries the identifier of exactly one confirmed
// listing on the same page is that listing's action (apply, save, share),
// not a separate lead. Returns [{item,into}] pairs to collapse.
export function collapseActionLinks(items) {
  const listings = items.filter((i) => i.discovery?.decision === 'listing'),
    counts = new Map();
  for (const item of listings)
    for (const v of urlIds(item.url)) counts.set(v, (counts.get(v) ?? 0) + 1);
  const owners = new Map();
  for (const item of listings)
    for (const v of urlIds(item.url)) if (counts.get(v) === 1) owners.set(v, item);
  if (!owners.size) return [];
  const collapsed = [];
  for (const item of items) {
    if (item.discovery?.decision !== 'uncertain') continue;
    const text = decoded(item.url),
      into = [...owners].find(([v]) => text.includes(v))?.[1];
    if (into) collapsed.push({item, into});
  }
  return collapsed;
}

export function navigationLink(link, source) {
  try {
    const url = new URL(link.url),
      page = new URL(source ?? link.url),
      label = (link.text ?? '').trim();
    const path = url.pathname.replace(/\/$/, '');
    if (
      /^(?:privacy(?: policy)?|security|terms(?: of (?:service|use))?|cookie(?: policy)?|learn more about .+)$/i.test(
        label,
      ) &&
      /^(?:|\/(?:privacy(?:-policy)?|security|terms(?:-of-(?:service|use))?|cookies?))$/i.test(path)
    )
      return true;
    // An account call to action (sign up / log in / register) whose address is
    // an account route leads to a form, not to an opportunity, on any site.
    if (
      /^(?:sign\s*up|sign\s*in|log\s*in|register|create (?:an? |your )?(?:free )?account|anmelden|registrieren|einloggen|giriş yap|kayıt ol|üye ol)\b/i.test(
        label,
      ) &&
      /(?:^|\/)(?:sign-?up|sign-?in|log-?in|register|registration|auth|account|anmelden|registrieren|kayit|giris)(?:$|[\/?#.])/i.test(
        path + url.search,
      )
    )
      return true;
    if (url.origin !== page.origin) return false;
    if (
      (url.href.endsWith('#') || page.href.endsWith('#')) &&
      url.href.replace(/#$/, '') === page.href.replace(/#$/, '')
    )
      return true;
    if (
      /^(?:|\/[a-z]{2}(?:-[a-z]{2})?)$/i.test(path) &&
      /(?:^|[-_\s])logo$|^(?:home|homepage|startseite|ana sayfa)$/i.test(label)
    )
      return true;
    return false;
  } catch {
    return false;
  }
}

export function resultLinkContext(page, link) {
  const range = link.contextRange;
  // The exact URL is already a separate field. Long tracking addresses must
  // not consume the card's entire text budget and hide its qualifications.
  if (
    Number.isSafeInteger(range?.offset) &&
    range.offset >= 0 &&
    Number.isSafeInteger(range.length) &&
    range.length > 0 &&
    range.offset + range.length <= (page.text ?? '').length
  )
    return page.text
      .slice(range.offset, range.offset + range.length)
      .replace(/^(Link: .*?)(?: — )?https?:\/\/\S+$/gm, '$1')
      .slice(0, 900);
  // Fallback for older observations: this is adjacent source text, not a claim
  // that all those words belong to the same card. Keep that distinction explicit.
  const marker = `Link: ${link.text ? link.text + ' — ' : ''}${link.url}`,
    start = (page.text ?? '').indexOf(marker);
  if (start < 0) return '';
  const text = page.text.slice(start + marker.length),
    end = text.indexOf('\nLink:');
  return text.slice(0, end < 0 ? 900 : Math.min(end, 900)).trim();
}

const pageLabel = (text) =>
  String(text ?? '')
    .trim()
    .match(/^(?:page\s+|seite\s+|sayfa\s+)?(\d+)(?:\s*(?:out of|of|von|\/|sur)\s*(\d+))?$/i);
export function observedPagePosition(page) {
  const positions = [];
  for (const p of page.pagination ?? []) {
    const text = String(p.text ?? '').trim();
    const number = pageLabel(text);
    if (number && Number(number[1]) > 0 && (!number[2] || Number(number[2]) >= Number(number[1])))
      positions.push({
        current: !!p.current,
        atUrl: !!page.url && p.url === page.url,
        counter: !p.url && p.kind !== 'button' && !p.targetId && !p.controlId,
        currentPage: Number(number[1]),
        totalPages: number[2] ? Number(number[2]) : null,
        evidence: text,
      });
  }
  // A row of "1 of 12", "2 of 12", ... labels describes destinations.
  // Prefer the marked current page; a standalone counter is also usable.
  const marked = positions.filter((p) => p.current),
    atUrl = positions.filter((p) => p.atUrl);
  const first = (page.pagination ?? []).some(
    (p) =>
      p.disabled &&
      (/\bprev\b/i.test(p.rel ?? '') ||
        /^(?:previous|prev|vorherige|zurück|önceki|vorige)$/i.test(String(p.text ?? '').trim())),
  )
    ? positions.filter((p) => p.currentPage === 1)
    : [];
  const selectedPositions = marked.length ? marked : atUrl.length ? atUrl : first;
  const candidates = selectedPositions.length ? selectedPositions : positions;
  if (
    candidates.length &&
    new Set(candidates.map((p) => p.currentPage)).size === 1 &&
    (selectedPositions.length || candidates.every((p) => p.counter && p.totalPages !== null))
  ) {
    const totals = [...new Set(positions.map((p) => p.totalPages).filter((n) => n !== null))],
      selected = candidates[0];
    return {
      currentPage: selected.currentPage,
      totalPages: totals.length === 1 && totals[0] >= selected.currentPage ? totals[0] : null,
      evidence: selected.evidence,
    };
  }
  if (selectedPositions.length) return null;
  const title = String(page.title ?? '').trim(),
    number = title.match(/\b(?:page|seite|sayfa)\s+(\d+)\b/i);
  if (number && Number(number[1]) > 0 && title.length <= 500)
    return {currentPage: Number(number[1]), totalPages: null, evidence: title};
  return null;
}

export function observedNextPage(page, position) {
  if (!position) return null;
  if (position.totalPages !== null && position.currentPage >= position.totalPages) return null;
  const named = (page.pagination ?? []).filter(namedNextPage);
  if (named.length && named.every((p) => p.disabled)) return null;
  const actionable = (page.pagination ?? []).filter(
    (p) => !p.current && !p.disabled && (p.url || p.targetId || p.controlId),
  );
  const numeric = actionable.filter(
    (p) => Number(pageLabel(p.text)?.[1]) === position.currentPage + 1,
  );
  const next = numeric.length ? numeric : actionable.filter(namedNextPage);
  // Duplicate desktop/mobile links are fine only when they have the same URL.
  const destinations = new Set(next.map((p) => p.url ?? p.targetId ?? p.controlId));
  return destinations.size === 1 ? next[0] : null;
}

const namedNextPage = (p) =>
  /\bnext\b/i.test(p.rel ?? '') ||
  /^(?:next(?: page)?|sonraki(?: sayfa(?:yı görüntüle)?)?|nächste(?: seite)?|weiter|volgende(?: pagina)?)$/i.test(
    String(p.text ?? '').trim(),
  );
export function paginationScrollTarget(page, position) {
  if (!position || (position.totalPages !== null && position.currentPage >= position.totalPages))
    return null;
  const next = (page.pagination ?? []).filter(
    (p) => !p.current && !p.disabled && !p.url && !p.targetId && !p.controlId && namedNextPage(p),
  );
  const ids = new Set(next.map((p) => p.scrollControlId));
  if (ids.size !== 1 || ids.has(undefined)) return null;
  return (page.scrollTargets ?? []).find((t) => ids.has(t.controlId) && scrollsDown(t)) ?? null;
}

// Jev observations give a scroll target's position (top, height, viewport), not
// the room left below it.
export function scrollsDown(target) {
  if (typeof target.atBottom === 'boolean') return !target.atBottom;
  return target.height - target.viewport - target.top > 2;
}

// Dropdowns of a results page (sort order, region, date range) with the names
// they offer; an agent that delegates the scan still sees a newest-first option.
export function resultPageControls(page) {
  return (page.controls ?? [])
    .filter((c) => c.nativeSelect || c.role === 'combobox')
    .filter((c) => c.options?.length || c.suggestions?.length)
    .slice(0, 8)
    .map((c) => ({
      label: c.label ?? '',
      ...(c.selectedLabel ? {selected: c.selectedLabel} : {}),
      options: (c.options ?? c.suggestions).slice(0, 12),
      ...(c.nativeSelect ? {nativeSelect: true} : {}),
    }));
}
export function resultPageSummary(
  page,
  evidence,
  items,
  {excluded = 0, rejected = 0, known = 0} = {},
) {
  const controls = resultPageControls(page);
  const pagination = (page.pagination ?? []).map((p) => ({
    text: p.text,
    url: p.url ?? null,
    current: !!p.current,
    disabled: !!p.disabled,
    ...(p.targetId ? {targetId: p.targetId} : {}),
    ...(p.controlId ? {controlId: p.controlId} : {}),
    ...(p.scrollControlId ? {scrollControlId: p.scrollControlId} : {}),
    ...(p.rel ? {rel: p.rel} : {}),
  }));
  return {
    url: page.url,
    title: page.title ?? '',
    evidenceId: evidence.id,
    at: evidence.at,
    position: observedPagePosition(page),
    pagination: pagination.slice(0, 12),
    paginationCount: pagination.length,
    ...(controls.length ? {controls} : {}),
    candidates: items.length,
    confirmedListings: items.filter((i) => i.discovery?.decision === 'listing').length,
    uncertainLinks: items.filter((i) => i.discovery?.decision !== 'listing').length,
    excludedNavigation: excluded,
    rejectedListings: rejected,
    knownListings: known,
    chronology: {
      status: 'unverified',
      next: 'No date cutoff is certified. Follow the full scan to the observed end; do not reread the board just to infer ordering or dates.',
    },
    checkpointSaved: false,
  };
}

export const listingFirst = (items) =>
  items
    .slice()
    .sort(
      (a, b) =>
        Number(b.discovery?.decision === 'listing') - Number(a.discovery?.decision === 'listing'),
    );
