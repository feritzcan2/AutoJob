import {automaticAssessmentError} from '../../src/scoring-state.js';
import {taskRecordIds, taskHasRecord, batchScoring, recordScoredInTask} from './task-scope.mjs';
import {isConversation} from '../workspaces/conversation.mjs';
import {sourceMode} from '../sources/automation-sources.mjs';
import {automationReady} from '../sources/trial.mjs';
import {workerKey} from '../automation/worker-key.mjs';
import {boundedText} from '../templates/catalog.mjs';
import {autoApplyThreshold} from '../scoring/thresholds.mjs';
import {queueAutomaticContacts} from '../automation/contacts.mjs';
import {autoContactsMode} from './operation-definitions.mjs';

const live = ['pending', 'running', 'reported', 'paused'];
const automaticRecordScanInterval = 10_000;
const waitingForAnswer = 'Answer the pending questions for this record first';
// Automatic applications hold while this many records wait for the user's
// answer, and continue on their own once answers bring the count below it.
export const MAX_RECORDS_AWAITING_ANSWER = 5;
// Records with an open question the user owes. A cover letter being written is
// agent work, not an answer the user owes.
function recordsAwaitingAnswer(a) {
  const ids = new Set();
  for (const q of a.questions ?? [])
    if (!q.conversation && q.answer == null && q.recordId && q.coverLetter?.state !== 'writing')
      ids.add(q.recordId);
  return ids.size;
}
export const automaticApplicationsHeld = (a) =>
  recordsAwaitingAnswer(a) >= MAX_RECORDS_AWAITING_ANSWER;
const automaticApplication = (t) => t.recordOperation === 'execute' && !t.request?.manual;
// When the user switched to Find and apply without queueing existing records,
// only records saved after the switch are applied to automatically.
export const savedBeforeAutoApply = (a, item) =>
  Boolean(a.autoApplyAfter) && (item.createdAt ?? 0) < a.autoApplyAfter;
export function recordSource(a, item) {
  if (item.sourceUrl) return item.sourceUrl;
  const sources = a.sources.filter((url) => new URL(url).origin === new URL(item.url).origin);
  return sources.length === 1 ? sources[0] : null;
}
export function pendingRecordQuestion(a, item) {
  return (a.questions ?? []).find(
    (q) =>
      !q.conversation &&
      q.answer == null &&
      (q.recordId ? q.recordId === item.id : !q.sourceUrl || q.sourceUrl === recordSource(a, item)),
  );
}
// The record's own live task. A contact search runs beside it and is not one.
export function recordTask(db, id, itemId) {
  return db.store.workspaces.tasks
    .list(id, {states: live})
    .find((t) => t.recordOperation !== 'contacts' && taskHasRecord(t, itemId));
}
export function recordOperationError(
  a,
  item,
  kind,
  {manual = false, digest, direct = false, now = Date.now(), dryRun = false} = {},
) {
  if (item.trial) return 'No action can run on a research sample';
  // A developer trial score changes nothing, so it also reads closed records;
  // only a record being submitted keeps its tab to itself.
  if (kind === 'score' && dryRun)
    return item.status === 'executing'
      ? 'This record is being submitted; run the trial score after the submission'
      : !automationReady(a)
        ? 'Check and save the setup first'
        : pendingRecordQuestion(a, item)
          ? waitingForAnswer
          : null;
  if (kind === 'verify')
    return item.status === 'uncertain'
      ? null
      : 'Only an action with an uncertain outcome can be verified';
  // The writer answers the record's own cover letter question, so that open
  // question does not hold it back.
  if (kind === 'cover_letter')
    return ['completed', 'executing', 'uncertain', 'dismissed'].includes(item.status)
      ? 'This record is closed'
      : null;
  // Finding or writing to a contact changes nothing about the record itself.
  if (kind === 'contacts') return null;
  if (['completed', 'executing', 'uncertain', 'dismissed'].includes(item.status))
    return 'This record cannot be submitted again';
  if (!automationReady(a)) return 'Check and save the setup first';
  if (pendingRecordQuestion(a, item)) return waitingForAnswer;
  if (kind === 'score') return null;
  if (!manual && item.collectedBy && !Number.isInteger(item.assessment?.score))
    return 'Score the collected listing before acting on it automatically';
  const source = recordSource(a, item),
    mode = source ? sourceMode(a, source) : 'observe';
  if (!manual && mode === 'observe') return 'The source is in find-only mode';
  if (kind === 'prepare') return null;
  if (kind !== 'execute') return 'Unknown record operation';
  // There is no draft approval step: a user's execute request applies the
  // record directly, and auto mode applies scored records on its own.
  if (!manual) {
    if (mode !== 'auto') return 'An application needs a user request';
    // Without a draft review in between, an automatic submission needs a
    // current score; an unscored record is never applied to on its own.
    if (!item.assessment) return 'Score it first for an automatic application';
    if (savedBeforeAutoApply(a, item))
      return 'Saved before Find and apply was turned on; apply it yourself';
    const error = automaticAssessmentError(item.assessment, autoApplyThreshold(a.criteria));
    if (error) return error;
  }
  void digest;
  void direct;
  return null;
}

const MAX_SCORE_BATCH = 100;
// Score requests the user queues one after another share one agent: new
// records join a manual score task that has not started yet.
function joinPendingScore(runtime, id, a, items) {
  const {db, queue} = runtime;
  const target = queue
    .list(id, {states: ['pending']})
    .find(
      (t) =>
        t.recordOperation === 'score' &&
        t.attempts === 0 &&
        !t.stopRequested &&
        !t.retryAt &&
        t.request?.manual === true &&
        !t.request?.dryRun &&
        t.request?.revision === a.revision &&
        taskRecordIds(t).length + items.length <= MAX_SCORE_BATCH,
    );
  if (!target) return null;
  const known = taskRecordIds(target),
    added = items.filter((item) => !known.includes(item.id));
  if (!added.length) return target;
  const {sourceUrl, recordVersion, ...rest} = target;
  void sourceUrl;
  void recordVersion;
  const task = queue.put({
    ...rest,
    recordIds: [...known, ...added.map((item) => item.id)],
    sources: [...(target.sources ?? []), ...added.map((item) => item.url)],
  });
  db.event(id, 'record_operation_queued', {
    itemIds: added.map((item) => item.id),
    kind: 'score',
    taskId: task.id,
    manual: true,
  });
  return task;
}

export function enqueueRecordOperation(
  runtime,
  id,
  itemId,
  kind,
  {
    manual = true,
    digest,
    direct = false,
    changes = undefined,
    dryRun = false,
    applyAnyway = false,
  } = {},
) {
  runtime.assertNotStopping(id);
  // Every execute is direct: the agent fills and submits in one task.
  if (kind === 'execute') direct = true;
  // The user's choice to apply despite an eligibility mismatch covers only
  // their own request to apply.
  applyAnyway = kind === 'execute' && manual && applyAnyway === true;
  // The user's requested changes to a reviewed draft go to a new preparation.
  if (changes !== undefined)
    changes = kind === 'prepare' ? boundedText(changes, 'Change request', 2000) : undefined;
  const {db, queue} = runtime;
  const wake = (task) => {
    // Explicit record requests use the existing worker pool. Background
    // ticks still respect workers the user stopped; no new workers are created.
    if (manual && task.state === 'pending') {
      const workers = runtime.workers.list(id);
      if (['score', 'prepare'].includes(kind) || (kind === 'execute' && direct === true)) {
        const pending = queue
          .list(id, {states: ['pending']})
          .filter(
            (t) =>
              (['score', 'prepare'].includes(t.recordOperation) ||
                (t.recordOperation === 'execute' && t.request?.direct === true)) &&
              (t.request?.manual || db.get(id).status === 'enabled'),
          )
          .filter((t) => {
            try {
              validateRecordTask(db, id, t, runtime.now());
              return true;
            } catch {
              return false;
            }
          });
        let needed =
          pending.length -
          workers.filter((w) => w.enabled !== false && !runtime.active.has(workerKey(id, w.id)))
            .length;
        for (const worker of workers) {
          if (needed <= 0) break;
          if (worker.enabled === false && !runtime.active.has(workerKey(id, worker.id))) {
            runtime.workers.setEnabled(id, worker.id, true);
            needed--;
            runtime.changed(id);
          }
        }
      } else if (!workers.some((w) => w.enabled !== false)) {
        runtime.workers.setEnabled(id, 'main', true);
        runtime.changed(id);
      }
    }
    return task;
  };
  const task = queue.atomic(() => {
    const a = db.get(id),
      item = db.result(id, itemId),
      op = db.template(a.templateId).recordOperations?.[kind];
    if (!op) throw Error('The template does not support this record operation');
    const error = recordOperationError(a, item, kind, {
      manual,
      digest,
      direct,
      now: runtime.now(),
      dryRun,
    });
    if (error) throw Error(error);
    const existing = recordTask(db, id, itemId);
    if (existing) {
      if (
        !batchScoring(existing) &&
        !changes &&
        existing.recordOperation === kind &&
        (existing.request?.direct === true) === (direct === true) &&
        (existing.request?.dryRun === true) === (dryRun === true) &&
        (existing.request?.applyAnyway === true) === applyAnyway &&
        (!digest || existing.request?.digest === digest)
      ) {
        if (manual && existing.state === 'pending' && !existing.request?.manual)
          return queue.put({
            ...existing,
            request: {...existing.request, manual: true, at: runtime.now()},
          });
        return existing;
      }
      throw Error('Another task for this record is already queued or running');
    }
    if (kind === 'score' && manual && !dryRun) {
      const joined = joinPendingScore(runtime, id, a, [item]);
      if (joined) return joined;
    }
    const sourceUrl = recordSource(a, item),
      request = {
        manual,
        revision: a.revision,
        ...(kind === 'execute' ? {direct: true} : {}),
        ...(applyAnyway ? {applyAnyway: true} : {}),
        ...(changes ? {changes} : {}),
        // Development trial score: the record keeps its assessment.
        ...(dryRun && kind === 'score' ? {dryRun: true} : {}),
        at: runtime.now(),
      };
    const task = queue.enqueue(id, {
      recordOperation: kind,
      operation: op.id,
      capability: op.capability,
      recordId: item.id,
      subject: item.id,
      sourceUrl,
      sources: [item.url],
      // Submissions run one at a time: one form is filled at a time, and one
      // employer never gets two parallel attempts.
      lockKey: kind === 'execute' ? 'submit' : 'record:' + item.id,
      request,
      recordVersion: item.digest ?? String(item.updatedAt),
    });
    db.event(id, 'record_operation_queued', {itemId, kind, taskId: task.id, manual});
    return task;
  });
  wake(task);
  runtime.changed(id);
  return task;
}

export function enqueueScoreBatch(runtime, id, itemIds) {
  runtime.assertNotStopping(id);
  if (
    !Array.isArray(itemIds) ||
    !itemIds.length ||
    itemIds.length > MAX_SCORE_BATCH ||
    itemIds.some((value) => typeof value !== 'string' || !value.trim())
  )
    throw Error('Select 1–100 records to score');
  const recordIds = [...new Set(itemIds)],
    {db, queue} = runtime;
  if (recordIds.length === 1) return enqueueRecordOperation(runtime, id, recordIds[0], 'score');
  const task = queue.atomic(() => {
    const a = db.get(id),
      op = db.template(a.templateId).recordOperations?.score;
    if (!op) throw Error('The template does not support this record operation');
    const items = recordIds.map((itemId) => db.result(id, itemId));
    for (const item of items) {
      const error = recordOperationError(a, item, 'score', {manual: true});
      if (error) throw Error(item.title + ': ' + error);
    }
    const existing = recordTask(db, id, recordIds[0]);
    if (
      batchScoring(existing) &&
      existing.recordIds.length === recordIds.length &&
      recordIds.every((itemId) => existing.recordIds.includes(itemId))
    )
      return existing;
    if (recordIds.some((itemId) => recordTask(db, id, itemId)))
      throw Error('Another task is already queued or running for one of the selected records');
    const joined = joinPendingScore(runtime, id, a, items);
    if (joined) return joined;
    const task = queue.enqueue(id, {
      recordOperation: 'score',
      operation: op.id,
      capability: op.capability,
      recordId: recordIds[0],
      recordIds,
      subject: recordIds[0],
      sources: items.map((item) => item.url),
      lockKey: 'record:' + recordIds[0],
      request: {manual: true, revision: a.revision, at: runtime.now()},
    });
    db.event(id, 'record_operation_queued', {
      itemIds: recordIds,
      kind: 'score',
      taskId: task.id,
      manual: true,
    });
    return task;
  });
  // One batch needs one worker and a separate read-only browser tab.
  if (task.state === 'pending') {
    const workers = runtime.workers.list(id);
    if (!workers.some((w) => w.enabled !== false && !runtime.active.has(workerKey(id, w.id)))) {
      const worker = workers.find(
        (w) => w.enabled === false && !runtime.active.has(workerKey(id, w.id)),
      );
      if (worker) runtime.workers.setEnabled(id, worker.id, true);
    }
  }
  runtime.changed(id);
  return task;
}

export function validateRecordTask(db, id, task, now) {
  if (!task.recordOperation) return;
  const a = db.get(id),
    request = task.request ?? {};
  if (request.revision !== a.revision && !['verify', 'contacts'].includes(task.recordOperation))
    throw Error('The setup changed while the task was queued; prepare the action again');
  for (const itemId of taskRecordIds(task)) {
    const item = db.result(id, itemId);
    if (
      task.recordOperation === 'score' &&
      task.attempts > 0 &&
      ['found', 'prepared'].includes(item.status) &&
      (recordScoredInTask(db, task, item) || pendingRecordQuestion(a, item))
    )
      continue;
    const error = recordOperationError(a, item, task.recordOperation, {
      manual: request.manual,
      digest: request.digest,
      direct: request.direct,
      now,
      dryRun: request.dryRun === true,
    });
    if (error)
      throw Object.assign(
        Error(error),
        error === waitingForAnswer ? {code: 'RECORD_QUESTION_PENDING'} : {},
      );
  }
}

// An answer supplies missing facts; only the original direct request can carry
// submission authority forward. Stops, cancellation and setup edits revoke it.
export function resumeRecordOperation(runtime, id, item, task) {
  if (batchScoring(task)) {
    const ids = taskRecordIds(task).filter((itemId) => {
      const record = runtime.db.result(id, itemId);
      if (
        !['found', 'prepared'].includes(record.status) ||
        recordTask(runtime.db, id, itemId) ||
        pendingRecordQuestion(runtime.db.get(id), record)
      )
        return false;
      if (record.assessment?.runId) {
        try {
          if (runtime.db.run(record.assessment.runId).taskId === task.id) return false;
        } catch {}
      }
      return true;
    });
    return ids.length ? enqueueScoreBatch(runtime, id, ids) : null;
  }
  // An answered question continues the same application; there is no draft
  // step to fall back to.
  return enqueueRecordOperation(
    runtime,
    id,
    item.id,
    item.status === 'uncertain'
      ? 'verify'
      : task?.recordOperation === 'score'
        ? 'score'
        : 'execute',
    {direct: true, applyAnyway: task?.request?.applyAnyway === true},
  );
}

export async function dispatchRecordOperations(runtime, id, {manualOnly = false} = {}) {
  if (runtime.closed || runtime.pausing.has(id) || runtime.restarting.has(id)) return;
  const {db, queue} = runtime,
    a = db.get(id),
    ops = db.template(a.templateId).recordOperations;
  if (
    !ops ||
    a.profileUpdate ||
    runtime
      .slots(id)
      .some(
        (s) =>
          !isConversation(s.run) &&
          (s.run.kind === 'interview' || (s.run.kind === 'trial' && !s.run.sourceUrl)),
      )
  )
    return;
  const savedTasks = queue.resumptions(id);
  for (const task of savedTasks.filter(
    (t) => t.resumeRecordAfterVerification && !live.includes(t.state),
  )) {
    queue.put({...task, resumeRecordAfterVerification: false});
    const item = db.result(id, task.recordId),
      proof = item.notSubmitted;
    if (
      task.state !== 'completed' ||
      task.stopRequested ||
      !task.request?.manual ||
      !proof ||
      proof.digest !== item.digest ||
      recordTask(db, id, item.id)
    )
      continue;
    let origin;
    try {
      if (db.run(proof.runId).taskId !== task.id) continue;
      origin = db.run(proof.attemptRunId);
    } catch {
      continue;
    }
    const request = origin.request;
    if (
      origin.automationId !== id ||
      origin.recordId !== item.id ||
      origin.recordOperation !== 'execute' ||
      origin.stopRequested ||
      !request?.manual ||
      request.revision !== a.revision ||
      item.revision !== a.revision
    )
      continue;
    const originTask = origin.taskId && queue.get(id, origin.taskId);
    if (
      originTask?.stopRequested ||
      // The Turkish alternatives match summaries stored by earlier versions.
      /Kullanıcı|Worker durduruldu|^Stopped by the user|^The user |^Worker stopped/.test(
        origin.summary ?? '',
      ) ||
      (request.direct !== true && request.digest !== item.digest)
    )
      continue;
    try {
      enqueueRecordOperation(runtime, id, item.id, 'execute', {
        manual: true,
        direct: request.direct === true,
        digest: request.direct === true ? undefined : request.digest,
        applyAnyway: request.applyAnyway === true,
      });
    } catch (error) {
      db.message(
        id,
        'system',
        'Verified as not submitted. Check the record operation to continue: ' + error.message,
      );
    }
  }
  // Old templates with explicit record workflow steps keep their own scheduler.
  for (const task of savedTasks.filter(
    (t) => t.resumeRecordAfterAnswer && !live.includes(t.state),
  )) {
    queue.put({...task, resumeRecordAfterAnswer: false});
    const item = db.result(id, task.recordId);
    if (
      !recordTask(db, id, item.id) &&
      !['completed', 'executing', 'dismissed'].includes(item.status)
    ) {
      try {
        resumeRecordOperation(runtime, id, item, task);
      } catch (error) {
        db.message(id, 'system', 'Answer saved. Record operation: ' + error.message);
      }
    }
  }
  const holdApplications = automaticApplicationsHeld(a);
  const customRecordWorkflow = db.template(a.templateId).workflow.some((s) => s.scope === 'record');
  // Automatic scheduling reads every record and record task. A few seconds of
  // delay does not matter, so it runs at most once per interval per workspace,
  // or at once after the setup changes.
  const scans = (runtime.automaticRecordScans ??= new Map()),
    scanKey = JSON.stringify([a.revision, a.mode, a.status]),
    lastScan = scans.get(id);
  const autoApply = a.mode !== 'observe' && !customRecordWorkflow;
  if (
    !manualOnly &&
    a.status === 'enabled' &&
    (autoApply || autoContactsMode(a.criteria)) &&
    (lastScan?.key !== scanKey || lastScan.next <= runtime.now())
  ) {
    scans.set(id, {key: scanKey, next: runtime.now() + automaticRecordScanInterval});
    const previous = queue.list(id, {summary: true}),
      activeRecords = new Set(
        previous
          .filter((t) => live.includes(t.state) && t.recordOperation !== 'contacts')
          .flatMap(taskRecordIds),
      );
    for (const item of autoApply && !holdApplications ? db.results(id) : []) {
      // Scheduling needs source permissions, not the UI projection that loads
      // every result and run. Read those settings once with the workspace.
      if (
        a.sourceSettings?.[recordSource(a, item)]?.enabled === false ||
        activeRecords.has(item.id)
      )
        continue;
      const kind = ['found', 'prepared'].includes(item.status) ? 'execute' : null;
      if (!kind || !ops[kind] || recordOperationError(a, item, kind, {now: runtime.now()}))
        continue;
      // Interrupted preparation may resume. Explicit cancellation requires a new
      // user request; starting a worker must not recreate a cleared queue.
      if (
        previous.some(
          (t) =>
            taskHasRecord(t, item.id) &&
            t.recordOperation === kind &&
            (t.stopRequested ||
              (t.request?.revision === a.revision &&
                t.recordVersion === (item.digest ?? String(item.updatedAt)) &&
                !(kind === 'prepare' && t.state === 'interrupted'))),
        )
      )
        continue;
      enqueueRecordOperation(runtime, id, item.id, kind, {manual: false});
      activeRecords.add(item.id);
    }
    // A contact search runs beside the record's application.
    if (queueAutomaticContacts(db, id, a, previous)) runtime.changed(id);
  }
  const pending = queue
    .list(id, {states: ['pending']})
    .filter(
      (t) =>
        t.recordOperation &&
        (!t.retryAt || t.retryAt <= runtime.now()) &&
        (t.request?.manual || (!manualOnly && a.status === 'enabled')) &&
        !(holdApplications && automaticApplication(t)),
    )
    .sort((x, y) => Number(Boolean(y.request?.manual)) - Number(Boolean(x.request?.manual)));
  for (const worker of runtime.workers.list(id)) {
    if (
      worker.enabled === false ||
      runtime.active.has(workerKey(id, worker.id)) ||
      runtime.capacityUsed >= runtime.concurrency
    )
      continue;
    let task;
    while (pending.length) {
      task = pending.shift();
      try {
        validateRecordTask(db, id, task, runtime.now());
        break;
      } catch (error) {
        if (error.code !== 'RECORD_QUESTION_PENDING') {
          queue.finish(id, task.id, 'cancelled', error.message);
          runtime.changed(id);
        }
        task = null;
      }
    }
    if (!task) continue;
    void runtime.start(id, {kind: 'run', taskId: task.id}, worker.id).catch(() => {});
  }
}

export function recordOperationState(
  db,
  id,
  item,
  {
    a = db.get(id),
    definition = db.template(a.templateId),
    // The summary leaves out scan bodies, which this state never reads.
    tasks = db.store.workspaces.tasks.list(id, {summary: true}),
    // A caller rendering many records passes each record's tasks, in list order.
    recordTasks = tasks.filter((t) => taskHasRecord(t, item.id)),
  } = {},
) {
  const liveTasks = recordTasks.filter(
      (t) => live.includes(t.state) && t.recordOperation !== 'contacts',
    ),
    // A letter being written is the record's work, also while its application waits.
    task = liveTasks.find((t) => t.recordOperation === 'cover_letter') ?? liveTasks[0],
    // A contact task has its own state in the Contacts tab, not on the record.
    last = recordTasks.findLast((t) => t.recordOperation && t.recordOperation !== 'contacts');
  // One action per record: verify an uncertain outcome, otherwise apply
  // directly. There is no separate draft or approval step.
  const kind =
    item.status === 'uncertain'
      ? 'verify'
      : ['found', 'prepared'].includes(item.status)
        ? 'execute'
        : null;
  const operation = kind && definition.recordOperations?.[kind];
  const error = operation
    ? recordOperationError(a, item, kind, {manual: true, direct: true, now: db.now()})
    : null;
  const question = (a.questions ?? []).find((q) => q.recordId === item.id && q.answer == null);
  const scoreOp = ['found', 'prepared'].includes(item.status) && definition.recordOperations?.score;
  const scoreError = scoreOp ? recordOperationError(a, item, 'score', {manual: true}) : null;
  const scoringComplete = recordScoredInTask(db, task ?? last, item);
  const scoreOperation = scoreOp
    ? {
        kind: 'score',
        label: item.assessment ? 'Rescore' : scoreOp.label,
        disabled: Boolean(scoreError || task),
        reason: scoreError,
      }
    : null;
  let retryOperation = null;
  if (
    !scoringComplete &&
    !task &&
    last &&
    (last.recordOperation !== 'verify' || item.status === 'uncertain') &&
    ['blocked', 'failed', 'interrupted'].includes(last.state) &&
    !item.trial &&
    !['completed', 'executing', 'dismissed'].includes(item.status)
  ) {
    const retryKind =
        item.status === 'uncertain'
          ? 'verify'
          : last.recordOperation === 'prepare'
            ? 'execute'
            : last.recordOperation,
      direct = retryKind === 'execute';
    if (definition.recordOperations?.[retryKind]) {
      const reason = recordOperationError(a, item, retryKind, {
        manual: true,
        direct,
        digest: item.digest,
        now: db.now(),
      });
      retryOperation = {
        kind: retryKind,
        direct,
        // A retry keeps the user's choice to apply despite an eligibility mismatch.
        ...(retryKind === 'execute' && last.request?.applyAnyway === true
          ? {applyAnyway: true}
          : {}),
        review: retryKind === 'execute' && !direct,
        disabled: Boolean(reason),
        reason,
      };
    }
  }
  return {
    scoringComplete,
    scoreOperation,
    retryOperation,
    // "Apply" is the record's own operation now; no separate direct button.
    directOperation: null,
    question: question
      ? {
          id: question.id,
          text: question.text,
          ...(question.verification ? {verification: true} : {}),
          ...(question.coverLetter ? {coverLetter: question.coverLetter.state} : {}),
        }
      : null,
    lastTask:
      last && !scoringComplete
        ? {
            kind: last.recordOperation,
            state: last.state,
            summary: last.summary,
            at: last.finishedAt ?? last.startedAt ?? last.createdAt,
            ...(last.toolFailure ? {toolFailure: last.toolFailure} : {}),
            ...(last.blocker && ['blocked', 'failed'].includes(last.state)
              ? {blocker: last.blocker}
              : {}),
          }
        : null,
    task:
      task && !scoringComplete
        ? {
            id: task.id,
            kind: task.recordOperation,
            state: task.state,
            workerId: task.workerId,
            at: task.startedAt ?? task.createdAt,
            manual: task.request?.manual === true,
            ...(task.retryAt > db.now() ? {retryAt: task.retryAt} : {}),
            // Applications run one at a time; name the wait instead of a free agent.
            ...(task.state === 'pending' &&
            task.lockKey === 'submit' &&
            tasks.some(
              (t) =>
                t.id !== task.id &&
                t.lockKey === 'submit' &&
                ['running', 'reported', 'paused'].includes(t.state),
            )
              ? {waitingForApplication: true}
              : {}),
            ...(task.state === 'pending' &&
            automaticApplication(task) &&
            automaticApplicationsHeld(a)
              ? {waitingForAnswers: MAX_RECORDS_AWAITING_ANSWER}
              : {}),
          }
        : null,
    operation: operation
      ? {
          kind,
          label: operation.label,
          disabled: Boolean(error || task),
          reason: error,
        }
      : null,
  };
}
