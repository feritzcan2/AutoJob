// @ts-check
import {recipeNeedsTerms, searchLearning} from './recipe.mjs';

// Legacy workspace metadata is retained for history; a skip never validates a source.
export const automationTrialReady = (a) =>
  a.trial?.revision === a.revision && ['passed', 'skipped'].includes(a.trial?.status);
export const automationReady = (a) => a.reviewedRevision === a.revision;
// A site extension that knows the results address (siteSearch) leaves the
// trial nothing to learn once the source has a search recipe with its terms:
// the first scan verifies that recipe. A relearn request, a failed trial or a
// broken recipe still sends the source to a trial, and so does a search value
// the source has to learn (searchLearning) or a search without its terms: the
// trial agent chooses them from the profile. The renderer loads this
// module, so the caller looks up the site extension.
export function sourceTrialReady(a, url, {siteSearch = false} = {}) {
  const state = a.sourceState?.[url],
    recipe = a.sourceSettings?.[url]?.recipe;
  if (searchLearning(a, url) || recipeNeedsTerms(recipe)) return false;
  if (state?.trial) return state.trial.status === 'passed';
  return Boolean(
    recipe?.entry.kind === 'url_template' &&
    !recipeNeedsTerms(recipe) &&
    state?.recipeState?.status !== 'stale' &&
    siteSearch,
  );
}
