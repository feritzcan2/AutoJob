const running = {
  score: 'Scoring',
  prepare: 'Preparing',
  execute: 'Applying',
  verify: 'Verifying',
  cover_letter: 'Writing cover letter',
  contacts: 'LinkedIn contacts',
};
const queued = {
  score: 'Scoring queued',
  prepare: 'Preparation queued',
  execute: 'Application queued',
  verify: 'Verification queued',
  cover_letter: 'Cover letter queued',
  contacts: 'Contact task queued',
};
// The agent's blocker category, as the card's badge.
const blockerLabels = {
  not_eligible: 'Not eligible',
  needs_answer: 'Needs your answer',
  needs_login: 'Login needed',
  needs_code: 'Code needed',
  needs_payment: 'Payment needed',
  verification: 'Verification needed',
  listing_closed: 'Listing closed',
  email_only: 'Apply by email',
  site_problem: 'Site problem',
  technical: 'Technical error',
};
// A cover letter being written is agent work, not an answer the user owes.
const writingCoverLetter = (record) => record.recordAction?.question?.coverLetter === 'writing';
export function recordOperationStatus(record) {
  const {task, lastTask, question} = record.recordAction ?? {};
  if (writingCoverLetter(record)) {
    const queuedLetter = task?.kind === 'cover_letter' && task.state === 'pending';
    return {
      id: queuedLetter ? 'queued' : 'working',
      label: queuedLetter ? queued.cover_letter : running.cover_letter,
      tone: queuedLetter ? 'queued' : 'running',
      detail: queuedLetter
        ? 'Waiting for an available agent to write the cover letter.'
        : 'An agent is writing the cover letter for this application.',
      active: true,
    };
  }
  if (question?.verification)
    return {
      id: 'verification',
      label: 'CAPTCHA to solve',
      tone: 'blocked',
      detail: question.text,
      active: true,
    };
  if (question?.code)
    return {
      id: 'code',
      label: 'Code to enter',
      tone: 'blocked',
      detail: question.text,
      active: true,
    };
  if (question)
    return {
      id: 'waiting',
      label: 'Awaiting answer',
      tone: 'blocked',
      detail: question.text,
      active: true,
    };
  if (task) {
    if (task.state === 'paused')
      return {
        id: 'paused',
        label: 'Operation paused',
        tone: 'blocked',
        detail: 'Check the agent task.',
        active: true,
      };
    if (task.state === 'pending')
      return {
        id: 'queued',
        label: queued[task.kind] ?? 'Operation queued',
        tone: 'queued',
        detail: task.retryAt
          ? `Waiting for a site access wait; resumes after ${new Date(task.retryAt).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})}.`
          : task.waitingForAnswers
            ? `Automatic applications wait while ${task.waitingForAnswers} or more applications await your answer; this one starts once you answer some.`
            : task.waitingForApplication
              ? 'Waiting for the current application to finish; applications run one at a time.'
              : task.manual
                ? 'The first free agent will take this record.'
                : 'Waiting for an available agent.',
        active: true,
      };
    if (task.state === 'reported')
      return {
        id: 'finishing',
        label: 'Finishing operation',
        tone: 'running',
        detail: 'The agent session is closing.',
        active: true,
      };
    return {
      id: 'working',
      label: running[task.kind] ?? 'Operation in progress',
      tone: 'running',
      detail: 'The agent is working on this record.',
      active: true,
    };
  }
  if (
    lastTask &&
    lastTask.kind !== 'verify' &&
    lastTask.at >= Math.max(record.updatedAt, record.verifiedAt ?? 0) &&
    !['completed', 'uncertain', 'executing', 'dismissed'].includes(record.status)
  ) {
    const label =
      (lastTask.state === 'blocked' && blockerLabels[lastTask.blocker?.category]) ||
      {
        blocked: 'Operation blocked',
        failed: 'Operation failed',
        interrupted: 'Operation interrupted',
        cancelled: 'Operation cancelled',
      }[lastTask.state];
    if (label)
      return {id: 'stopped', label, tone: 'blocked', detail: lastTask.summary, active: false};
  }
  return null;
}
export const recordActivityAt = (record) =>
  Math.max(
    record.updatedAt,
    record.verifiedAt ?? 0,
    record.recordAction?.task?.at ?? 0,
    record.recordAction?.lastTask?.at ?? 0,
  );
export const recordIsWorking = (record) =>
  record.status !== 'dismissed' &&
  (!record.recordAction?.question || writingCoverLetter(record)) &&
  ['running', 'reported'].includes(record.recordAction?.task?.state);

export const recordNeedsAnswer = (record) =>
  record.status !== 'dismissed' &&
  Boolean(record.recordAction?.question) &&
  !writingCoverLetter(record);

export function activeRecordOperations(snapshot) {
  const counts = new Map(),
    seen = new Set();
  for (const slot of snapshot.activeRuns ?? (snapshot.activeRun ? [snapshot.activeRun] : [])) {
    const run = snapshot.runs?.find((r) => r.id === slot.id) ?? slot;
    if (seen.has(run.id) || run.status !== 'running' || !run.recordId || !run.recordOperation)
      continue;
    const worker = snapshot.workers?.find((w) => w.id === (run.workerId ?? 'main'));
    if (!worker?.active || worker.execution?.task?.id !== run.id) continue;
    const records = run.recordIds ?? [run.recordId],
      count = records.filter(
        (id) =>
          !snapshot.results?.find((r) => r.id === id)?.recordAction?.scoringComplete &&
          !snapshot.automation?.questions?.some((q) => q.recordId === id && q.answer == null),
      ).length;
    if (!count) continue;
    seen.add(run.id);
    counts.set(run.recordOperation, (counts.get(run.recordOperation) ?? 0) + count);
  }
  return ['execute', 'prepare', 'score', 'verify']
    .filter((kind) => counts.has(kind))
    .map((kind) => ({
      kind,
      count: counts.get(kind),
      label: (
        snapshot.definition?.recordOperations?.[kind]?.runningLabel ?? running[kind]
      ).toLocaleLowerCase('en'),
    }));
}

// Blockers whose card offers Skip next to the reason.
// A stopped operation or an unverified outcome the user has to look at.
export function recordProblem(record) {
  if (record.status === 'dismissed' || record.trial) return null;
  const progress = recordOperationStatus(record),
    summary = record.recordAction?.lastTask?.summary,
    blocker = record.recordAction?.lastTask?.blocker;
  if (progress?.id === 'stopped' && blocker?.reason)
    return {
      label: progress.label,
      category: blocker.category,
      reason: blocker.reason,
      next: blocker.userAction,
    };
  if (progress?.id === 'stopped')
    return {
      label: progress.label,
      reason: summary || 'The agent did not record a reason.',
    };
  if (!progress && record.status === 'uncertain')
    return {
      label: 'Outcome needs verification',
      reason:
        summary ||
        'It is unclear whether the action was completed. Verify the outcome or mark it yourself.',
    };
  return null;
}

// Blockers only the user can clear; the others (not eligible, closed listing,
// site or tool errors) are shown on the record but ask nothing of the user.
const userBlockers = new Set([
  'needs_answer',
  'needs_login',
  'needs_code',
  'needs_payment',
  'verification',
  'email_only',
]);
// A record problem that waits on the user: one of those blockers, or an outcome to verify.
export function recordWaitsOnUser(record) {
  const problem = recordProblem(record);
  if (!problem) return null;
  return (problem.category ? userBlockers.has(problem.category) : record.status === 'uncertain')
    ? problem
    : null;
}
