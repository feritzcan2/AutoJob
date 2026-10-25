// @ts-check
import {randomUUID} from 'node:crypto';
import {sentryTransport} from './diagnostics.mjs';

// Reports source scans that end failed, blocked or timed out to Sentry so they
// can be triaged later. Only the site host, app status codes and scrubbed
// summaries leave the machine: no profile, CV, page content or full URLs.
const REPORTED_STATUSES = new Set(['failed', 'blocked', 'timeout']);

const scanSource = (run) => run.sourceUrl ?? (run.sources?.length === 1 ? run.sources[0] : null);
// A trial that checks several sources at once has no single site.
const scanSite = (run) => (scanSource(run) ? host(scanSource(run)) : 'multiple_sources');

/** A source scan (not record work) that just ended in a reported status. */
export function reportableScanFailure(run, previousStatus) {
  return Boolean(
    run &&
    ['run', 'trial'].includes(run.kind) &&
    (scanSource(run) || run.sources?.length > 1) &&
    !run.recordId &&
    !run.recordOperation &&
    REPORTED_STATUSES.has(run.status) &&
    previousStatus !== run.status,
  );
}

export const host = (value) => {
  try {
    return new URL(value).host;
  } catch {
    return 'unknown';
  }
};

export function scrubText(value, max = 400) {
  return (
    String(value ?? '')
      .replace(/\bhttps?:\/\/([^/\s?#'")]+)[^\s'")]*/gi, '$1/…')
      // Quoted text is usually what the user typed or a page showed: search
      // terms, a location, a field value.
      .replace(/"[^"\n]{1,200}"|[“„][^“”\n]{1,200}[”“]|«[^»\n]{1,200}»/g, '"…"')
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
      .replace(/\b[0-9A-F]{16,}\b/gi, '[id]')
      .replace(/\+?\d[\d\s/-]{6,}\d/g, '[number]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

// The app's own error codes (site_wait, checkbox_not_ready, ...) group issues
// better than agent-written prose.
function failureCode(run) {
  if (run.toolFailure?.tool) return `tool:${run.toolFailure.tool}`;
  const text = `${run.stop?.evidence ?? ''} ${run.summary ?? ''}`;
  return (
    text.match(/\b[a-z]+(?:_[a-z]+)+\b/)?.[0] ??
    // Otherwise the summary's first sentence, without numbers and hosts.
    (scrubText(run.summary)
      .replace(/\S+\/…/g, '')
      .split(/[.;:]/)[0]
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .slice(0, 80) ||
      'none')
  );
}

export function scanFailureEvent(run, {release, environment, installId = null}) {
  const site = scanSite(run),
    stopKind = run.stop?.kind ?? 'none',
    code = failureCode(run),
    stats = run.scanStats ?? {};
  return {
    event_id: randomUUID().replaceAll('-', ''),
    timestamp: (run.finishedAt ?? Date.now()) / 1000,
    platform: 'node',
    level: run.status === 'failed' ? 'error' : 'warning',
    logger: 'jobloop.scan',
    release,
    environment,
    // A run the app ended without a stop reason fails the same way on every
    // site, so those failures group across sites.
    message: {
      formatted:
        stopKind === 'none'
          ? `scan ${run.status}: ${code}`
          : `scan ${run.status} (${stopKind}) ${site}: ${code}`,
    },
    fingerprint:
      stopKind === 'none'
        ? ['jobloop-scan', run.status, stopKind, code]
        : ['jobloop-scan', site, run.status, stopKind, code],
    tags: {
      site,
      status: run.status,
      kind: run.kind,
      stop_kind: stopKind,
      code,
      collector: run.collector ?? run.scan?.collector ?? 'none',
      model: run.conversation?.settings?.model ?? 'unknown',
      provider: run.conversation?.provider ?? 'unknown',
      retry_exhausted: String(Boolean(run.stop?.retryExhausted)),
      recovered_after_crash: String(Boolean(run.recoveredAfterCrash)),
      ...(installId ? {install_id: installId} : {}),
    },
    extra: {
      summary: scrubText(run.summary),
      stopEvidence: scrubText(run.stop?.evidence),
      toolFailure: run.toolFailure
        ? {
            tool: run.toolFailure.tool,
            message: scrubText(run.toolFailure.message),
            count: run.toolFailure.count,
          }
        : null,
      durationMs: run.finishedAt && run.startedAt ? run.finishedAt - run.startedAt : null,
      browserSteps: run.browserSteps ?? 0,
      pageProgress: run.pageProgress
        ? {currentPage: run.pageProgress.currentPage, totalPages: run.pageProgress.totalPages}
        : null,
      scanStats: Object.fromEntries(
        Object.entries(stats).filter(([, value]) => typeof value === 'number'),
      ),
      continuation: run.continuation?.reason ?? null,
      // The last agent terminal lines when the task message was not delivered.
      deliveryFailure: run.deliveryFailure
        ? {
            state: run.deliveryFailure.state,
            screen: String(run.deliveryFailure.screen ?? '')
              .split('\n')
              .map((line) => scrubText(line.replace(/[─━│┃╭╮╰╯┌┐└┘├┤]+/g, ' '), 120))
              .filter(Boolean)
              .slice(-3)
              .join(' | ')
              .slice(0, 200),
          }
        : null,
    },
  };
}

/** Returns a reporter that sends each run at most once and never throws. */
export function createFailureReporter({
  dsn,
  release,
  environment,
  fetch = globalThis.fetch,
  enabled = () => true,
  installId = async () => null,
  buildEvent,
}) {
  const send = sentryTransport({dsn, release, fetch}),
    sent = new Set();
  return async (run) => {
    if (!enabled() || sent.has(run.id)) return;
    sent.add(run.id);
    const install = await installId().catch(() => null),
      event = buildEvent(run, {release, environment, installId: install});
    // Reporting is best effort; a run never fails because Sentry is unreachable.
    await send([{type: 'event', payload: event}], {event_id: event.event_id});
  };
}

export const createScanFailureReporter = (options) =>
  createFailureReporter({...options, buildEvent: scanFailureEvent});
