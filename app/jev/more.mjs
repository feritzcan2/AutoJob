// @ts-check
// A results page that loads more results on the same page: the site extension
// names the element whose coming into view loads the next batch (dom.more, for
// example the last result card), and it is brought into view as a person
// scrolls. The scan then checks that the extension reads more listings.
import {siteExtensionFor} from '../site-extensions/index.mjs';
import {revealInView} from './rendering.mjs';

/** @param {any} slot */
export async function loadMoreResults(slot) {
  const more = siteExtensionFor(slot.page.url())?.dom?.more;
  if (!more)
    return {
      status: 'unsupported',
      executed: false,
      message: 'No site extension loads more results on this page.',
    };
  const handle = await slot.page.evaluateHandle(more).catch(() => null),
    element = handle?.asElement() ?? null;
  if (!element) {
    await handle?.dispose().catch(() => {});
    return {
      status: 'no_progress',
      executed: false,
      message: 'The site extension found no result to scroll to.',
    };
  }
  try {
    await revealInView(slot, element, {timeoutMs: 5000});
  } finally {
    await element.dispose().catch(() => {});
  }
  return {status: 'ready', executed: true};
}
