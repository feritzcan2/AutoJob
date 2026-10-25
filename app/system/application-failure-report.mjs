// @ts-check
import {randomUUID} from 'node:crypto';
import {createFailureReporter, host, scrubText} from './scan-failure-report.mjs';

// Reports applications (execute tasks) that end failed, blocked or timed out
// for a reason the app might fix: a technical or site problem, or a stop the
// app ended without a reason. Stops that need the user (an answer, a login, a
// CAPTCHA) or that exclude them are only counted in the daily usage report.
// Codes leave the machine, plus the short reason the agent gave for a technical
// or site problem; never the profile, form answers, CV or listing text.
const REPORTED_STATUSES = new Set(['failed', 'blocked', 'timeout']);
const USER_SIDE = new Set([
  'needs_answer',
  'needs_login',
  'needs_code',
  'needs_payment',
  'verification',
  'listing_closed',
  'email_only',
  'not_eligible',
]);

// Applicant tracking systems host forms for many employers, so their domain
// names the system, not the employer. Other form domains are reported as
// employer_site.
const APPLICANT_SYSTEMS = new Set([
  'applytojob.com',
  'ashbyhq.com',
  'avature.net',
  'bamboohr.com',
  'breezy.hr',
  'comeet.com',
  'dayforcehcm.com',
  'dvinci-easy.com',
  'eightfold.ai',
  'factorialhr.com',
  'gem.com',
  'greenhouse.io',
  'hibob.com',
  'homerun.co',
  'icims.com',
  'jobvite.com',
  'jobylon.com',
  'join.com',
  'lever.co',
  'myworkdayjobs.com',
  'onlyfy.jobs',
  'oraclecloud.com',
  'personio.com',
  'personio.de',
  'pinpointhq.com',
  'recruitee.com',
  'rippling.com',
  'smartrecruiters.com',
  'softgarden.io',
  'successfactors.com',
  'successfactors.eu',
  'taleo.net',
  'teamtailor.com',
  'umantis.com',
  'workable.com',
  'workday.com',
  'zohorecruit.com',
]);

/** An application that just ended in a status worth a report. */
export function reportableApplicationFailure(run, previousStatus) {
  return Boolean(
    run &&
    run.recordOperation === 'execute' &&
    REPORTED_STATUSES.has(run.status) &&
    previousStatus !== run.status &&
    !USER_SIDE.has(run.blocker?.category),
  );
}

// The registrable part of a host: jobs.example.co.uk -> example.co.uk.
function domain(value) {
  const name = host(value);
  if (name === 'unknown') return null;
  const labels = name.toLowerCase().split('.'),
    countrySecondLevel =
      labels.length > 2 &&
      labels.at(-1).length === 2 &&
      /^(ac|co|com|edu|gov|net|org)$/.test(labels.at(-2));
  return labels.slice(countrySecondLevel ? -3 : -2).join('.');
}

// Where the run ended: the listing site, a known applicant system or an
// employer's own site.
function formSite(run) {
  const last = run.navigation?.at(-1)?.url ?? run.observations?.at(-1)?.url,
    form = last ? domain(last) : null;
  if (!form) return 'none';
  if ([run.sourceUrl, ...(run.sources ?? [])].some((url) => url && domain(url) === form))
    return 'listing_site';
  return APPLICANT_SYSTEMS.has(form) ? form : 'employer_site';
}

function formStep(run) {
  if (run.submission) return `submitted_${run.submission.outcome ?? 'unknown'}`;
  return run.browserSteps ? 'before_submit' : 'not_opened';
}

export function applicationFailureEvent(run, {release, environment, installId = null}) {
  const category = run.blocker?.category ?? 'none',
    site = host(run.sourceUrl ?? run.sources?.[0]),
    form = formSite(run),
    // Only the app's own codes: the summary holds the employer and the user's facts.
    code = run.toolFailure?.tool
      ? `tool:${run.toolFailure.tool}`
      : (String(run.stop?.evidence ?? '').match(/\b[a-z]+(?:_[a-z]+)+\b/)?.[0] ?? 'none');
  return {
    event_id: randomUUID().replaceAll('-', ''),
    timestamp: (run.finishedAt ?? Date.now()) / 1000,
    platform: 'node',
    level: run.status === 'failed' ? 'error' : 'warning',
    logger: 'jobloop.application',
    release,
    environment,
    message: {formatted: `application ${run.status} (${category}) ${form}: ${code}`},
    fingerprint: ['jobloop-application', run.status, category, form, code],
    tags: {
      site,
      form_site: form,
      status: run.status,
      category,
      step: formStep(run),
      code,
      model: run.conversation?.settings?.model ?? 'unknown',
      provider: run.conversation?.provider ?? 'unknown',
      recovered_after_crash: String(Boolean(run.recoveredAfterCrash)),
      ...(installId ? {install_id: installId} : {}),
    },
    extra: {
      reason: scrubText(run.blocker?.reason, 200),
      // Without a blocker the app ended the run, so the summary is the app's text.
      summary: run.blocker ? '' : scrubText(run.summary, 200),
      toolFailure: run.toolFailure
        ? {
            tool: run.toolFailure.tool,
            message: scrubText(run.toolFailure.message, 200),
            count: run.toolFailure.count,
          }
        : null,
      durationMs: run.finishedAt && run.startedAt ? run.finishedAt - run.startedAt : null,
      browserSteps: run.browserSteps ?? 0,
      agentTokens: run.tokenUsage?.agentTokens ?? null,
    },
  };
}

export const createApplicationFailureReporter = (options) =>
  createFailureReporter({...options, buildEvent: applicationFailureEvent});
