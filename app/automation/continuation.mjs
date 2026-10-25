// @ts-check
import {taskRecordIds} from '../records/task-scope.mjs';
import {sameScanScope} from '../sources/scan.mjs';

const unfinishedSourceStatuses = ['interrupted', 'partial', 'blocked', 'failed', 'timeout'];

// A worker may handle many records. Answers belong to the conversation that
// asked the question, never to whichever conversation that worker used last.
export function answerContinuation(db, id, task, kind) {
  const a = db.get(id),
    matches = [];
  const sourceScan = kind === 'run' && task.sourceUrl && !task.recordId && !task.recordOperation;
  const sourceContinuation = (origin, continuation) => {
    // The unfinished scan cycle defines continuity, including after an app restart
    // or a long wait for an answer. Live browser evidence is refreshed separately.
    // A collector scan keeps all of its state in the app's checkpoint. Its old
    // conversation only held stale results (an earlier background_read or a
    // failure since fixed) that agents kept obeying, so it starts fresh.
    // An agent that ended two turns in a row without a step is stuck on its own
    // history (2026-10-19: it refused a tool for hours over an old failure
    // count), so it also starts fresh from the checkpoint.
    const resumeConversation =
      !origin.collector &&
      (task.recovery?.attempt ?? 0) < 2 &&
      unfinishedSourceStatuses.includes(origin.status) &&
      Boolean(origin.scanPlan?.id) &&
      origin.scanPlan.id === a.sourceState?.[task.sourceUrl]?.scanState?.active?.id;
    return {...continuation, resumeConversation};
  };
  const sameTask = (origin) =>
    origin &&
    origin.automationId === id &&
    origin.status !== 'running' &&
    origin.kind === kind &&
    origin.revision === a.revision &&
    JSON.stringify(taskRecordIds(origin)) === JSON.stringify(taskRecordIds(task)) &&
    (origin.recordOperation ?? null) === (task.recordOperation ?? null) &&
    (!task.sourceUrl || origin.sourceUrl === task.sourceUrl) &&
    (!sourceScan || sameScanScope(origin.scanPlan?.scopeKey, a, task.sourceUrl));
  const access = !task.recordId && a.sourceState?.[task.sourceUrl]?.accessRecovery;
  if (access) {
    if (access.state !== 'answered') return null;
    const origin = db.run(access.runId);
    if (!sameTask(origin) || origin.taskId !== task.id) return null;
    const continuation = {
      reason: access.automatic ? 'site_access_retry' : 'site_access_response',
      runId: origin.id,
      questionIds: [],
      browserContext: origin.resumeContext ?? origin.continuation?.browserContext ?? null,
      response: access.response,
      resumeConversation: true,
    };
    return sourceScan ? sourceContinuation(origin, continuation) : continuation;
  }
  for (const question of a.questions ?? []) {
    if (question.answer == null || question.resolution || question.continuationRunId) continue;
    if ((question.recordId ?? null) !== (task.recordId ?? null)) continue;
    const scoped = db.questionScope(id, question);
    if (
      !task.recordId &&
      (scoped.sourceUrl ?? null) !==
        (['run', 'trial'].includes(kind) ? (task.sourceUrl ?? null) : null)
    )
      continue;
    let origin;
    const runId = question.runId ?? question.browserContext?.runId;
    if (runId) {
      try {
        origin = db.run(runId);
      } catch {
        continue;
      }
    } else if (question.taskId) {
      const rows = db.db
        .prepare(
          `SELECT data FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.startedAt')<=? AND (json_extract(data,'$.finishedAt') IS NULL OR json_extract(data,'$.finishedAt')>=?) LIMIT 2`,
        )
        .all(id, question.taskId, question.createdAt, question.createdAt);
      if (rows.length === 1) origin = JSON.parse(rows[0].data);
    }
    if (!sameTask(origin)) continue;
    matches.push({question, origin});
  }
  matches.sort((x, y) => y.question.createdAt - x.question.createdAt);
  const latest = matches[0];
  if (!latest) {
    if (sourceScan) {
      // Look only at the latest inserted run. Completed scans start fresh; older
      // history must not return after rotation, repair or a change of scan cycle.
      const row = db.db
        .prepare(
          `SELECT data FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.sourceUrl')=? AND json_extract(data,'$.kind')='run' AND json_extract(data,'$.recordId') IS NULL AND json_extract(data,'$.recordOperation') IS NULL ORDER BY rowid DESC LIMIT 1`,
        )
        .get(id, task.sourceUrl);
      const previous = row ? JSON.parse(row.data) : null;
      if (
        !sameTask(previous) ||
        previous.operation !== task.operation ||
        !previous.conversation ||
        previous.actionId
      )
        return null;
      if (unfinishedSourceStatuses.includes(previous.status))
        return sourceContinuation(previous, {
          reason: previous.taskId === task.id ? 'task_retry' : 'source_retry',
          runId: previous.id,
          questionIds: [],
          browserContext: previous.resumeContext ?? previous.continuation?.browserContext ?? null,
        });
      return null;
    }
    // A retry is the same durable task, not the worker's most recent unrelated
    // conversation. Changed scope and execution→verification stay fresh.
    const row = db.db
      .prepare(
        `SELECT data FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.taskId')=? ORDER BY json_extract(data,'$.startedAt') DESC,rowid DESC LIMIT 1`,
      )
      .get(id, task.id);
    const previous = row ? JSON.parse(row.data) : null;
    if (
      sameTask(previous) &&
      previous.operation === task.operation &&
      ['interrupted', 'partial'].includes(previous.status) &&
      previous.conversation &&
      !previous.stopRequested &&
      !previous.actionId &&
      // User stops are not retried (Turkish summaries come from earlier versions).
      !/Kullanıcı|Worker durduruldu|^Stopped by the user|^The user |^Worker stopped/.test(
        previous.summary ?? '',
      )
    )
      return {
        reason: 'task_retry',
        runId: previous.id,
        questionIds: [],
        browserContext: previous.resumeContext ?? previous.continuation?.browserContext ?? null,
      };
    // A launch interrupted by shutdown can retry the same durable queue task.
    // Changing it to verification must not revive an execution conversation.
    if (task.continuation) {
      try {
        if (sameTask(db.run(task.continuation.runId))) return task.continuation;
      } catch {}
    }
    return null;
  }
  const continuation = {
    runId: latest.origin.id,
    questionIds: matches.map((m) => m.question.id),
    browserContext: latest.question.browserContext ?? latest.origin.resumeContext ?? null,
  };
  return sourceScan ? sourceContinuation(latest.origin, continuation) : continuation;
}

export function automationRunHistory(db, run, base, profileId = null, protocol = null) {
  const scoped = profileId ? base.forProfile(profileId) : base;
  const sourceScan = run.kind === 'run' && run.sourceUrl && !run.recordId && !run.recordOperation;
  const read = () => {
    if (!run.continuation || run.continuation.resumeConversation === false) return null;
    const origin = db.run(run.continuation.runId);
    return origin.automationId === run.automationId &&
      origin.conversation?.profileId === profileId &&
      (!protocol || origin.conversation.protocol === protocol)
      ? origin.conversation
      : null;
  };
  const compatible = (provider, nativeId) =>
    !protocol ||
    Boolean(
      nativeId &&
      db
        .runs(run.automationId)
        .some(
          (r) =>
            r.conversation?.provider === provider &&
            r.conversation?.nativeId === nativeId &&
            r.conversation?.profileId === profileId &&
            r.conversation?.protocol === protocol &&
            (!run.evidenceEpoch || r.evidenceEpoch === run.evidenceEpoch),
        ),
    );
  return {
    forProfile: (profile) => automationRunHistory(db, run, base, profile, protocol),
    conversation: (id, provider) =>
      run.continuation || sourceScan
        ? read()?.provider === provider
          ? read().nativeId
          : null
        : compatible(provider, scoped.conversation(id, provider))
          ? scoped.conversation(id, provider)
          : null,
    conversationSettings: (id, provider, nativeId) =>
      run.continuation || sourceScan
        ? read()?.provider === provider && read()?.nativeId === nativeId
          ? read().settings
          : null
        : compatible(provider, nativeId)
          ? scoped.conversationSettings(id, provider, nativeId)
          : null,
    saveConversation: (id, provider, nativeId, settings) => {
      scoped.saveConversation(id, provider, nativeId, settings);
      db.putRun({
        ...db.run(run.id),
        conversation: {provider, nativeId, settings, profileId, ...(protocol ? {protocol} : {})},
      });
    },
    forgetConversation: (id, provider, nativeId) => {
      scoped.forgetConversation(id, provider, nativeId);
      // A source conversation can span many runs. Invalidate every reference so
      // a late answer cannot revive history retired by rotation or resume repair.
      db.db
        .prepare(
          "UPDATE automation_runs SET data=json_set(data,'$.conversation',NULL) WHERE automation_id=? AND json_extract(data,'$.conversation.provider')=? AND json_extract(data,'$.conversation.nativeId')=?",
        )
        .run(run.automationId, provider, nativeId);
    },
  };
}
