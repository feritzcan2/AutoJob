import {unknownScorecard} from './helpers/scorecard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {WebTasks} from '../app/automation/web-template.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {LOGGED_IN_FIELD} from '../app/automation/login-question.mjs';
import {OUTCOME_FIELD} from '../app/automation/question-forms.mjs';
import {directRecordInstructions} from '../app/records/operation-definitions.mjs';
import {automationTaskContext} from '../app/automation/task-context.mjs';
import {automationBrowser} from '../app/browser/automation-browser.mjs';
import {automationTemplate, reusableTemplate} from '../app/templates/catalog.mjs';
import {
  enqueueRecordOperation,
  recordOperationError,
  dispatchRecordOperations,
} from '../app/records/operations.mjs';
import {recordOperationStatus, recordActivityAt} from '../src/record-operation-status.js';
import {symlinkSkip} from './helpers/symlinks.mjs';

const source = 'https://example.test/list',
  settle = () => new Promise((r) => setImmediate(r));
function fixture(t, template = 'job-search', {onRunFinished} = {}) {
  const store = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(store),
    definition = db.template(template);
  const a = db.create(template, {
    goal: 'Find a suitable result',
    criteria: Object.fromEntries(
      definition.fields.filter((f) => f.required).map((f) => [f.id, 'Known criteria']),
    ),
    sources: [source],
  });
  db.review(a.id);
  const trial = db.begin(a.id, 'trial');
  for (const url of a.sources) db.observe(a.id, trial.id, url, 'Observed source');
  db.finish(a.id, trial.id, 'completed', 'Source checked');
  const seed = db.begin(a.id, 'run'),
    item = db.record(a.id, seed.id, {
      key: source + '/1',
      url: source + '/1',
      title: 'Result',
      summary: 'Observed facts',
    });
  db.finish(a.id, seed.id, 'completed', 'Saved');
  const launches = [];
  const runtime = new WebTasks(db, {
    onRunFinished,
    launch: async (run) => {
      launches.push(run);
      return {close: async () => {}};
    },
  });
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  const flow = (run) =>
    automationWorkflow({
      db,
      run,
      signal: {aborted: false},
      browser: {},
      report: (id, runId, status, summary) => runtime.report(id, runId, status, summary),
    });
  const finish = async (run, status = 'completed') => {
    runtime.report(a.id, run.id, status, 'Done');
    await runtime.finish(a.id, status, 'Done', run.workerId);
  };
  const prepare = async () => {
    await runtime.runRecord(a.id, item.id, 'prepare');
    await settle();
    const run = launches.at(-1);
    const saved = db.record(a.id, run.id, {
      key: item.key,
      url: item.url,
      title: item.title,
      summary: item.summary,
      proposal: 'Exact answers and document: documents/cv.pdf',
    });
    await finish(run);
    return saved;
  };
  return {store, db, id: a.id, item, runtime, launches, flow, finish, prepare};
}

// A stopped preparation is retried as a direct execution: there is no draft step.
for (const kind of ['prepare', 'execute', 'verify'])
  test(`retry after a stopped ${kind} offers the follow-up operation and disappears while queued`, async (t) => {
    const f = fixture(t);
    let item = f.item;
    if (kind !== 'prepare') item = await f.prepare();
    await f.runtime.runRecord(
      f.id,
      item.id,
      kind === 'verify' ? 'execute' : kind,
      kind === 'prepare' ? {} : {direct: true},
    );
    await settle();
    const run = f.launches.at(-1);
    if (kind === 'verify') f.db.reserve(f.id, run.id, item.id);
    await f.finish(run, 'failed');
    const retry = f.db.snapshot(f.id).results.find((r) => r.id === item.id)
      .recordAction.retryOperation;
    const expected = kind === 'prepare' ? 'execute' : kind;
    assert.equal(retry.kind, expected);
    assert.equal(retry.direct, expected === 'execute');
    assert.equal(retry.disabled, false);
    assert.equal(retry.review, false);
    await f.runtime.runRecord(f.id, item.id, retry.kind, retry.direct ? {direct: true} : {});
    await settle();
    assert.equal(
      f.db.snapshot(f.id).results.find((r) => r.id === item.id).recordAction.retryOperation,
      null,
    );
  });

test('retry of a blocked execution is a direct execution again and pending answers prevent retry', async (t) => {
  const f = fixture(t),
    item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute');
  await settle();
  await f.finish(f.launches.at(-1), 'blocked');
  const retry = () =>
    f.db.snapshot(f.id).results.find((r) => r.id === item.id).recordAction.retryOperation;
  assert.equal(retry().kind, 'execute');
  assert.equal(retry().review, false);
  assert.equal(retry().direct, true);
  f.db.askQuestion(f.id, {recordId: item.id, text: 'Required answer'});
  assert.equal(retry().disabled, true);
  assert.match(retry().reason, /Answer the pending questions/);
  f.db.putResult({...f.db.result(f.id, item.id), status: 'completed'});
  assert.equal(retry(), null);
});

test('template labels, operation instructions and success criteria round-trip through export/import', () => {
  for (const [id, label] of [
    ['job-search', 'Apply'],
    ['housing', 'Send message'],
    ['appointment', 'Book'],
    ['custom', 'Run'],
  ]) {
    const template = automationTemplate(id),
      copy = reusableTemplate(template);
    assert.equal(copy.recordOperations.execute.label, label);
    assert.equal(copy.recordOperations.prepare.effect, 'prepare');
    assert.equal(copy.recordOperations.verify.effect, 'read');
    assert.deepEqual(copy.recordOperations, template.recordOperations);
    assert.equal(template.workflow[0].effect, 'read');
  }
  const readOnly = reusableTemplate({
    ...automationTemplate('custom'),
    recordOperations: false,
  }).recordOperations;
  for (const kind of ['prepare', 'execute', 'verify']) assert.equal(readOnly[kind], false);
  assert.equal(readOnly.score.kind, 'score', 'scoring stays available without outgoing operations');
  assert.equal(
    reusableTemplate({...automationTemplate('custom'), recordOperations: {execute: false}})
      .recordOperations.execute,
    false,
  );
  assert.throws(
    () =>
      reusableTemplate({
        ...automationTemplate('custom'),
        recordOperations: {erase: {label: 'Erase'}},
      }),
    /Unknown record operation/,
  );
});

for (const mode of ['observe', 'auto'])
  test(`large read-only result sets do not reload source history for each record (${mode})`, async (t) => {
    const f = fixture(t, 'housing');
    f.db.enable(f.id);
    f.db.put({...f.db.get(f.id), mode, sourceSettings: {[source]: {mode: 'observe'}}});
    for (let i = 0; i < 1616; i++)
      f.db.putResult({
        ...f.item,
        id: 'large-' + i,
        key: source + '/large/' + i,
        url: source + '/large/' + i,
      });
    let sourceReads = 0,
      resultReads = 0,
      taskReads = 0;
    for (const [owner, key, count] of [
      [f.db, 'sources', () => sourceReads++],
      [f.db, 'results', () => resultReads++],
      [f.runtime.queue, 'list', () => taskReads++],
    ]) {
      const original = owner[key].bind(owner);
      owner[key] = (...args) => {
        count();
        return original(...args);
      };
    }
    await dispatchRecordOperations(f.runtime, f.id);
    await settle();
    assert.equal(f.launches.length, 0, 'Read-only sources never queue preparation');
    assert.ok(sourceReads <= 1, 'Source UI history must not be reloaded for each result');
    assert.ok(resultReads <= 1, 'Read the results at most once per dispatch');
    assert.ok(taskReads <= 3, 'Read the queue a constant number of times');
  });

test('manual preparation runs on a paused workspace with a blocked source and does not reset the source', async (t) => {
  const f = fixture(t);
  f.db.put({
    ...f.db.get(f.id),
    status: 'paused',
    sourceState: {[source]: {blocked: true, lastResult: 'CAPTCHA', nextRunAt: null}},
  });
  const before = f.db.get(f.id).sourceState;
  const prepared = await f.prepare();
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(f.db.get(f.id).sourceState, before);
  assert.equal(f.db.get(f.id).status, 'paused');
  assert.equal(f.launches[0].recordOperation, 'prepare');
  assert.equal(f.launches[0].recordId, f.item.id);
  assert.equal(f.db.snapshot(f.id).results[0].recordAction.operation.label, 'Apply');
});

test('draft preparation keeps its tab; verified submission closes the completed task tab', async (t) => {
  const calls = [],
    f = fixture(t, 'job-search', {onRunFinished: (id, run, options) => calls.push({run, options})});
  const prepared = await f.prepare();
  assert.equal(calls.at(-1).options.closeTabs, false);
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {digest: prepared.digest});
  await settle();
  const run = f.launches.at(-1);
  f.db.reserve(f.id, run.id, f.item.id);
  f.db.observe(f.id, run.id, f.item.url, 'Submitted');
  f.db.resolve(f.id, run.id, f.item.id, {
    status: 'completed',
    evidence: 'Submitted',
    url: f.item.url,
  });
  await f.finish(run);
  assert.equal(calls.at(-1).run.id, run.id);
  assert.equal(calls.at(-1).options.closeTabs, true);
  // The application is done: the earlier draft turn's tab closes too, even with filled fields.
  assert.equal(calls.at(-1).options.keepForms, false);
  assert.deepEqual(calls.at(-1).options.runIds.toSorted(), [calls[0].run.id, run.id].toSorted());
});

test('an execute run that marks the record closed closes its tabs, including earlier turns', async (t) => {
  const calls = [],
    f = fixture(t, 'job-search', {onRunFinished: (id, run, options) => calls.push({run, options})});
  await f.prepare();
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {manual: true});
  await settle();
  const run = f.launches.at(-1),
    evidence = 'No longer accepting applications';
  f.db.closeRecord(
    f.id,
    run.id,
    f.item.id,
    {evidence, url: f.item.url},
    {url: f.item.url, text: evidence},
  );
  await f.finish(run);
  assert.equal(f.db.result(f.id, f.item.id).status, 'dismissed');
  assert.equal(calls.at(-1).run.id, run.id);
  assert.equal(calls.at(-1).options.closeTabs, true);
  assert.equal(calls.at(-1).options.keepForms, false);
  assert.deepEqual(calls.at(-1).options.runIds.toSorted(), [calls[0].run.id, run.id].toSorted());
});

test('a blocked application closes its tabs only when the user is not eligible', async (t) => {
  for (const [category, closes] of [
    ['not_eligible', true],
    ['needs_login', false],
  ]) {
    const calls = [],
      f = fixture(t, 'job-search', {
        onRunFinished: (id, run, options) => calls.push({run, options}),
      });
    const item = await f.prepare();
    await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
    await settle();
    const run = f.launches.at(-1);
    const flow = automationWorkflow({
      db: f.db,
      run,
      signal: new AbortController().signal,
      browser: {currentUrl: async () => item.url, call: async () => ({content: []})},
      report: (...args) => f.runtime.report(...args),
    });
    await flow.call(f.id, run.id, 'finish_automation_run', {
      status: 'blocked',
      summary: 'Not submitted.',
      blocker: {category, reason: 'The form excludes the user.', userAction: 'Skip this record'},
    });
    await f.runtime.finish(f.id, 'blocked', 'Not submitted.', run.workerId);
    await settle();
    assert.equal(calls.at(-1).run.id, run.id);
    assert.equal(calls.at(-1).options.closeTabs, closes, category);
    if (closes) {
      assert.equal(calls.at(-1).options.keepForms, false);
      assert.deepEqual(
        calls.at(-1).options.runIds.toSorted(),
        [calls[0].run.id, run.id].toSorted(),
      );
    }
  }
});

// Skip and a manual "applied" both end the record for the user: the tabs its
// earlier runs opened close, including filled forms and employer pages.
test('skipping or marking a record applied closes its tabs', async (t) => {
  const calls = [],
    f = fixture(t, 'job-search', {onRunFinished: (id, run, options) => calls.push({run, options})});
  const prepared = await f.prepare(),
    prepareRun = calls.at(-1).run.id;
  await f.runtime.dismissRecord(f.id, prepared.id);
  assert.equal(calls.at(-1).options.closeTabs, true);
  assert.equal(calls.at(-1).options.keepForms, false);
  assert.equal(calls.at(-1).options.closeAll, true);
  assert.deepEqual(calls.at(-1).options.runIds, [prepareRun]);
  f.runtime.restoreRecord(f.id, prepared.id);
  calls.length = 0;
  await f.runtime.markRecordSubmitted(f.id, prepared.id);
  assert.equal(calls.at(-1).options.closeTabs, true);
  assert.deepEqual(calls.at(-1).options.runIds, [prepareRun]);
});

// An uncertain submission the user confirms in the outcome question ends the
// record as "Mark applied" does; "not submitted" keeps the page for a resend.
test('confirming an uncertain submission closes the record tabs', async (t) => {
  const calls = [],
    f = fixture(t, 'job-search', {onRunFinished: (id, run, options) => calls.push({run, options})});
  const prepared = await f.prepare(),
    prepareRun = calls.at(-1).run.id;
  const ask = () => {
    f.db.putResult({...f.db.result(f.id, prepared.id), status: 'uncertain'});
    return f.db.askQuestion(f.id, {
      recordId: prepared.id,
      text: 'Was this record submitted?',
      outcome: true,
      fields: [OUTCOME_FIELD],
    });
  };
  calls.length = 0;
  await f.runtime.answer(f.id, ask().id, {[OUTCOME_FIELD.id]: OUTCOME_FIELD.options[1]});
  assert.equal(calls.length, 0);
  await f.runtime.answer(f.id, ask().id, {[OUTCOME_FIELD.id]: OUTCOME_FIELD.options[0]});
  assert.equal(f.db.result(f.id, prepared.id).status, 'completed');
  assert.equal(calls.at(-1).options.closeTabs, true);
  assert.equal(calls.at(-1).options.closeAll, true);
  assert.deepEqual(calls.at(-1).options.runIds, [prepareRun]);
});

test('a manual execute request needs no draft and keeps observe permissions; duplicate submission is rejected', async (t) => {
  const f = fixture(t),
    a = f.db.get(f.id);
  // No approval step: the user's request applies the found record as it is,
  // and a stale or missing digest changes nothing. Automatic execution still
  // needs more than observe mode.
  assert.equal(f.item.status, 'found');
  assert.equal(recordOperationError(a, f.item, 'execute', {manual: true, digest: 'stale'}), null);
  assert.match(recordOperationError(a, f.item, 'execute'), /find-only mode/);
  const task = await f.runtime.runRecord(f.id, f.item.id, 'execute', {digest: 'stale'});
  await settle();
  assert.equal(task.request.direct, true);
  assert.equal(task.request.digest, undefined);
  assert.equal((await f.runtime.runRecord(f.id, f.item.id, 'execute')).id, task.id);
  const run = f.launches.at(-1);
  assert.equal(f.db.get(f.id).mode, 'observe');
  const attemptedAt =
    f.db.reserve(f.id, run.id, f.item.id) && f.db.result(f.id, f.item.id).attemptedAt;
  // A repeated reserve in the same run keeps the one reservation.
  assert.equal(f.db.reserve(f.id, run.id, f.item.id).alreadyReserved, true);
  assert.equal(f.db.result(f.id, f.item.id).attemptedAt, attemptedAt);
  f.db.observe(f.id, run.id, f.item.url, 'Application confirmation');
  f.db.resolve(f.id, run.id, f.item.id, {
    status: 'completed',
    evidence: 'Application confirmation',
    url: f.item.url,
  });
  await f.finish(run);
  assert.equal(f.db.result(f.id, f.item.id).status, 'completed');
  assert.equal(f.db.snapshot(f.id).results[0].recordAction.operation, null);
  await assert.rejects(
    f.runtime.runRecord(f.id, f.item.id, 'execute'),
    /cannot be submitted again/,
  );
});

test('an outcome without a reservation is refused and the record stays sendable', async (t) => {
  const f = fixture(t);
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {manual: true});
  await settle();
  const run = f.launches.at(-1);
  // A listing site can mark a job Applied when it only redirects to the employer.
  f.db.observe(f.id, run.id, f.item.url, 'Applied. Apply on external site');
  assert.throws(
    () =>
      f.db.resolve(f.id, run.id, f.item.id, {
        status: 'completed',
        evidence: 'Applied',
        url: f.item.url,
      }),
    /No submission was reserved.*reserve_automation_action/,
  );
  assert.equal(f.db.result(f.id, f.item.id).status, 'found');
  assert.ok(directRecordInstructions.includes('hands the application over to another site'));
});

test('changed proposals do not invalidate a queued execute; the running execute request covers its own proposal edits', async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  // Hold the only worker with a source task, then enqueue the execution.
  await f.runtime.runOnce(f.id);
  await settle();
  const scan = f.launches.at(-1);
  const task = await f.runtime.runRecord(f.id, f.item.id, 'execute');
  assert.equal(task.state, 'pending');
  // Without a draft approval there is no consent to invalidate: a changed
  // proposal leaves the queued request in place.
  f.db.putResult({...prepared, proposal: 'Changed commitment', digest: 'changed'});
  await f.finish(scan);
  await f.runtime.tick();
  await settle();
  assert.equal(f.store.workspaces.tasks.get(f.id, task.id).state, 'running');
  assert.equal(f.launches.filter((r) => r.recordOperation === 'execute').length, 1);
  const run = f.launches.at(-1);
  assert.equal(run.taskId, task.id);
  f.db.record(f.id, run.id, {
    key: f.item.key,
    url: f.item.url,
    title: f.item.title,
    summary: 'New requirement',
    proposal: 'Another changed proposal',
  });
  assert.equal(f.db.reserve(f.id, run.id, f.item.id).proposal, 'Another changed proposal');
});

test('an interrupted send becomes uncertain; verification is read-only and survives disabled schedules', async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {digest: prepared.digest});
  await settle();
  const run = f.launches.at(-1);
  f.db.reserve(f.id, run.id, f.item.id);
  await f.runtime.finish(f.id, 'interrupted', 'Connection lost', run.workerId);
  assert.equal(f.db.result(f.id, f.item.id).status, 'uncertain');
  assert.equal(f.db.snapshot(f.id).results[0].recordAction.operation.kind, 'verify');
  f.db.put({...f.db.get(f.id), status: 'paused', reviewedRevision: null, trial: null, endAt: 1});
  await f.runtime.runRecord(f.id, f.item.id, 'verify');
  await settle();
  const verify = f.launches.at(-1);
  assert.throws(() => f.db.reserve(f.id, verify.id, f.item.id));
  f.db.observe(f.id, verify.id, f.item.url, 'Already submitted');
  f.db.resolve(f.id, verify.id, f.item.id, {
    status: 'completed',
    evidence: 'Already submitted',
    url: f.item.url,
  });
  await f.finish(verify);
  assert.equal(f.db.result(f.id, f.item.id).status, 'completed');
});

test('preparation sees general answers the user gave for other records', async (t) => {
  const f = fixture(t),
    seed = f.db.begin(f.id, 'run'),
    other = f.db.record(f.id, seed.id, {
      key: source + '/2',
      url: source + '/2',
      title: 'Other',
      summary: 'Observed facts',
    });
  f.db.finish(f.id, seed.id, 'completed', 'Saved');
  const ask = (input) => f.db.askQuestion(f.id, {recordId: other.id, ...input});
  const fact = ask({text: 'Contact email?', fields: [{id: 'email', label: 'Email', type: 'text'}]});
  f.db.answerQuestion(f.id, fact.id, {email: 'me@example.test'});
  const login = ask({
    text: 'Log in',
    fields: [LOGGED_IN_FIELD],
    accessCheck: {kind: 'login', url: 'https://portal.test', evidence: 'Sign in', snapshotId: 's'},
  });
  f.db.answerQuestion(f.id, login.id, {[LOGGED_IN_FIELD.id]: true});
  // Many later answers must not push the old fact out of view; repeats collapse.
  for (let n = 0; n < 25; n++) {
    const later = ask({
      text: 'Form question ' + n,
      fields: [
        {id: 'years', label: 'Years with tool ' + n, type: 'number'},
        {id: 'hours', label: 'Weekly hours', type: 'number'},
      ],
    });
    f.db.answerQuestion(f.id, later.id, {years: n, hours: 40});
  }
  await f.runtime.runRecord(f.id, f.item.id, 'prepare');
  await settle();
  const answers = automationTaskContext(f.db, f.id, f.db.run(f.launches.at(-1).id)).earlierAnswers
    .answers;
  assert.deepEqual(answers.at(-1), {question: 'Email', answer: 'me@example.test'});
  assert.equal(answers.filter((a) => a.question === 'Weekly hours').length, 1);
  assert.equal(answers.length, 27);
});

test('requested changes to a reviewed draft reach the next preparation', async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  assert.equal(prepared.status, 'prepared');
  await assert.rejects(
    f.runtime.runRecord(f.id, f.item.id, 'prepare', {changes: '  '}),
    /Change request/,
  );
  await f.runtime.runRecord(f.id, f.item.id, 'prepare', {changes: 'Use the shorter cover letter'});
  await settle();
  const run = f.launches.at(-1);
  assert.equal(run.recordOperation, 'prepare');
  const context = automationTaskContext(f.db, f.id, f.db.run(run.id));
  assert.equal(context.requestedChanges.text, 'Use the shorter cover letter');
  assert.equal(context.assignedRecord.proposal, prepared.proposal);
});

test('apply anyway reaches the execute context and a retry keeps it', async (t) => {
  const f = fixture(t, 'job-search');
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  let run = f.launches.at(-1);
  assert.equal(automationTaskContext(f.db, f.id, f.db.run(run.id)).applyAnyway, undefined);
  await f.runtime.finish(f.id, 'blocked', 'Not eligible.', run.workerId);
  await settle();
  const task = await f.runtime.runRecord(f.id, item.id, 'execute', {
    direct: true,
    applyAnyway: true,
  });
  assert.equal(task.request.applyAnyway, true);
  await settle();
  run = f.launches.at(-1);
  assert.match(automationTaskContext(f.db, f.id, f.db.run(run.id)).applyAnyway.rule, /truthfully/);
  // A Retry after that run keeps the choice.
  await f.runtime.finish(f.id, 'blocked', 'Cover letter field still empty.', run.workerId);
  await settle();
  const retry = f.db.snapshot(f.id).results.find((r) => r.id === item.id)
    .recordAction.retryOperation;
  assert.equal(retry.applyAnyway, true);
});

test('one sign-in answer releases every open login question for the same site', async (t) => {
  const f = fixture(t),
    seed = f.db.begin(f.id, 'run');
  const records = [2, 3].map((n) =>
    f.db.record(f.id, seed.id, {
      key: `${source}/${n}`,
      url: `${source}/${n}`,
      title: `R${n}`,
      summary: 'Observed facts',
    }),
  );
  f.db.finish(f.id, seed.id, 'completed', 'Saved');
  const login = (item, url) =>
    f.db.askQuestion(f.id, {
      text: 'Log in',
      recordId: item.id,
      fields: [LOGGED_IN_FIELD],
      accessCheck: {kind: 'login', url, evidence: 'Sign in to apply', snapshotId: 's'},
    });
  const first = login(f.item, 'https://www.portal.test/apply/1'),
    same = login(records[0], 'https://portal.test/apply/2'),
    other = login(records[1], 'https://other.test/apply/3');
  await f.runtime.answer(f.id, first.id, {[LOGGED_IN_FIELD.id]: true});
  await settle();
  const answered = (q) => f.db.get(f.id).questions.find((x) => x.id === q.id).answer != null;
  assert.equal(answered(same), true);
  assert.equal(answered(other), false);
});

test('record questions resume the application without pausing other scans or starting setup', async (t) => {
  const f = fixture(t);
  await f.runtime.runRecord(f.id, f.item.id, 'prepare');
  await settle();
  const first = f.launches.at(-1),
    flow = f.flow(first);
  const q = await flow.call(f.id, first.id, 'ask_workspace_question', {
    text: 'Start date?',
    fields: [{id: 'date', label: 'Date', type: 'date'}],
  });
  assert.equal(q.recordId, f.item.id);
  await f.finish(first);
  await f.runtime.answer(f.id, q.id, {date: '2026-10-01'});
  await settle();
  const next = f.launches.at(-1);
  assert.notEqual(next.id, first.id);
  // The answer continues the application itself; there is no draft step.
  assert.equal(next.recordOperation, 'execute');
  assert.equal(next.request.direct, true);
  assert.equal(next.recordId, f.item.id);
  assert.equal(
    f.launches.some((r) => r.kind === 'interview'),
    false,
  );
});

test('dismissing a record closes only its questions and worker, and prevents late writes or retries', async (t) => {
  const f = fixture(t);
  await f.runtime.runRecord(f.id, f.item.id, 'prepare');
  await settle();
  const run = f.launches.at(-1);
  const other = f.db.putResult({
    ...f.item,
    id: 'other-record',
    key: 'other-record',
    url: source + '/other',
  });
  const q = f.db.askQuestion(f.id, {recordId: f.item.id, text: 'Missing information?'}),
    q2 = f.db.askQuestion(f.id, {recordId: f.item.id, text: 'Another question?'}),
    otherQ = f.db.askQuestion(f.id, {recordId: other.id, text: 'Other record?'}),
    general = f.db.askQuestion(f.id, {text: 'Workspace question?'});
  const otherTask = f.runtime.queue.enqueue(f.id, {
    recordId: other.id,
    operation: 'prepare',
    lockKey: 'record:' + other.id,
  });
  const worker = f.runtime.workers.add(f.id);
  f.runtime.queue.claim(f.id, otherTask.id, worker.id);
  let release;
  f.runtime.slots(f.id)[0].worker.close = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const dismissing = f.runtime.dismissRecord(f.id, f.item.id);
  assert.equal(f.db.result(f.id, f.item.id).status, 'dismissed');
  assert.throws(
    () => f.db.askQuestion(f.id, {recordId: f.item.id, text: 'Late question'}),
    /rejected record/,
  );
  assert.equal(
    f.db.record(f.id, run.id, {
      key: f.item.key,
      url: f.item.url,
      title: 'Late draft',
      summary: 'Late',
      proposal: 'Do not save',
    }).status,
    'dismissed',
  );
  await assert.rejects(
    f.runtime.runRecord(f.id, f.item.id, 'prepare'),
    /cannot be submitted again/,
  );
  release();
  await dismissing;
  for (const id of [q.id, q2.id])
    assert.equal(f.db.get(f.id).questions.find((q) => q.id === id).resolution, 'record_dismissed');
  for (const id of [otherQ.id, general.id])
    assert.equal(f.db.get(f.id).questions.find((q) => q.id === id).answer, null);
  assert.equal(f.runtime.queue.get(f.id, otherTask.id).state, 'running');
  assert.equal(f.db.result(f.id, other.id).status, 'found');
  assert.equal(f.runtime.slots(f.id).length, 0);
  await assert.rejects(f.runtime.answer(f.id, q.id, 'Late answer'), /already answered/);
});

test('dismissal cancels queued work and rejects foreign or already attempted records without mutations', async (t) => {
  const f = fixture(t),
    queue = f.runtime.queue,
    task = queue.enqueue(f.id, {
      recordId: f.item.id,
      operation: 'prepare',
      resumeRecordAfterAnswer: true,
    });
  const other = f.db.create('custom');
  await assert.rejects(f.runtime.dismissRecord(other.id, f.item.id), /does not belong/);
  assert.equal(queue.get(f.id, task.id).state, 'pending');
  for (const status of ['executing', 'completed']) {
    f.db.putResult({...f.item, status});
    await assert.rejects(f.runtime.dismissRecord(f.id, f.item.id), /history/);
    assert.equal(f.db.result(f.id, f.item.id).status, status);
    assert.equal(queue.get(f.id, task.id).state, 'pending');
  }
  f.db.putResult(f.item);
  await f.runtime.dismissRecord(f.id, f.item.id);
  assert.equal(queue.get(f.id, task.id).state, 'cancelled');
  assert.equal(queue.get(f.id, task.id).resumeRecordAfterAnswer, false);
  assert.equal(f.db.template('job-search').records.dismissLabel, 'Dismiss application');
  assert.equal(
    reusableTemplate(f.db.template('job-search')).records.dismissLabel,
    'Dismiss application',
  );
  assert.equal(f.db.template('housing').records.dismissLabel, 'Dismiss record');
});

test('working records and question dismissal remain available outside the latest 500 records', async (t) => {
  const f = fixture(t);
  await f.runtime.runRecord(f.id, f.item.id, 'prepare');
  await settle();
  const q = f.db.askQuestion(f.id, {recordId: f.item.id, text: 'Old record details?'});
  for (let i = 0; i < 501; i++)
    f.db.putResult({
      ...f.item,
      id: 'recent-' + i,
      key: 'recent-' + i,
      url: source + '/recent-' + i,
    });
  const snapshot = f.db.snapshot(f.id);
  assert.ok(
    snapshot.results.some(
      (item) => item.id === f.item.id && item.recordAction.task.state === 'running',
    ),
  );
  assert.equal(
    snapshot.automation.questions.find((item) => item.id === q.id).canDismissRecord,
    true,
  );
});

test('preparation and execution cannot claim success without their durable results', async (t) => {
  const f = fixture(t);
  await f.runtime.runRecord(f.id, f.item.id, 'prepare');
  await settle();
  const run = f.launches.at(-1);
  assert.throws(() => f.db.finish(f.id, run.id, 'completed', 'Done'), /draft/);
  assert.throws(() => f.db.reserve(f.id, run.id, f.item.id), /cannot submit/);
  await f.finish(run, 'blocked');
  const prepared = await f.prepare();
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {digest: prepared.digest});
  await settle();
  assert.throws(
    () => f.db.finish(f.id, f.launches.at(-1).id, 'completed', 'Clicked'),
    /application is not finished/,
  );
});

test('automatic execution is independent of source completion, and prepare mode waits for the user request', async (t) => {
  const f = fixture(t, 'housing');
  f.db.put({...f.db.get(f.id), mode: 'prepare'});
  f.db.enable(f.id);
  f.db.put({
    ...f.db.get(f.id),
    sourceState: {[source]: {blocked: true, nextRunAt: null, lastResult: 'Pagination unavailable'}},
  });
  await f.runtime.tick();
  await settle();
  // Prepare mode never applies a record on its own; there is no draft to make.
  assert.equal(f.launches.length, 0);
  assert.match(
    recordOperationError(f.db.get(f.id), f.db.result(f.id, f.item.id), 'execute'),
    /user request/,
  );
  f.db.put({...f.db.get(f.id), mode: 'auto'});
  f.db.enable(f.id);
  f.db.putResult({
    ...f.db.result(f.id, f.item.id),
    assessment: {
      score: 95,
      scoringVersion: 4,
      revision: f.db.get(f.id).revision,
      eligibility: 'verified',
    },
  });
  await f.runtime.tick();
  await settle();
  const run = f.launches.at(-1);
  assert.equal(run.recordOperation, 'execute');
  assert.equal(run.request.manual, false);
  assert.equal(run.request.direct, true);
  assert.equal(f.launches.length, 1);
  assert.equal(f.db.sources(f.id)[0].blocked, true);
});

test('record tasks have an independent retained browser tab key across redirects', async () => {
  const calls = [],
    browser = {
      prepare: () => ({ready: true}),
      call: async (id, name, args, session, options) => {
        calls.push({name, args, options});
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                tabId: 'record-tab',
                url: args.url ?? 'https://employer.test/apply',
              }),
            },
          ],
        };
      },
    };
  const adapter = automationBrowser(browser, {
    mode: 'jev',
    recordId: 'item',
    readTabKey: 'record:item',
    sourceUrls: [source],
  });
  await adapter.call('workspace', 'browser_navigate', {url: source + '/1'}, 'run');
  await adapter.call('workspace', 'browser_navigate', {url: 'https://employer.test/apply'}, 'run');
  for (const call of calls) {
    assert.equal(call.options.automationTabKey, 'record:item');
    assert.equal(call.options.automationSourceUrl, undefined);
  }
});

test('source observations preserve existing drafts and do not overwrite an active record operation', async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  f.store.workspaces.workers.add(f.id);
  await f.runtime.runOnce(f.id);
  await settle();
  const scan = f.launches.at(-1);
  const updated = f.db.record(f.id, scan.id, {
    key: f.item.key,
    url: f.item.url,
    title: f.item.title,
    summary: 'Updated listing facts',
  });
  assert.equal(updated.proposal, prepared.proposal);
  assert.equal(updated.digest, prepared.digest);
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {digest: prepared.digest});
  await settle();
  const repeat = f.db.record(f.id, scan.id, {
    key: f.item.key,
    url: f.item.url,
    title: f.item.title,
    summary: 'Must not overwrite active operation',
  });
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.summary, 'Updated listing facts');
});

for (const mode of ['observe', 'prepare', 'auto'])
  test(`a manual execute request in ${mode} mode covers proposal edits and never relaunches itself`, async (t) => {
    const f = fixture(t),
      prepared = await f.prepare();
    f.db.put({...f.db.get(f.id), mode});
    await f.runtime.runRecord(f.id, f.item.id, 'execute', {digest: prepared.digest});
    await settle();
    const run = f.launches.at(-1);
    f.db.put({...f.db.get(f.id), maxActionsPerDay: 10});
    f.db.record(f.id, run.id, {
      key: f.item.key,
      url: f.item.url,
      title: f.item.title,
      summary: 'Changed requirement',
      proposal: 'Changed document',
    });
    assert.equal(f.db.reserve(f.id, run.id, f.item.id).reserved, true);
    await f.finish(run);
    f.db.put({
      ...f.db.get(f.id),
      status: 'enabled',
      sourceState: {[source]: {blocked: true, nextRunAt: null}},
    });
    await f.runtime.tick();
    await settle();
    assert.equal(f.launches.filter((r) => r.recordOperation === 'execute').length, 1);
  });

test('an answer arriving before the asking worker closes schedules a fresh execution', async (t) => {
  const f = fixture(t);
  await f.runtime.runRecord(f.id, f.item.id, 'prepare');
  await settle();
  const first = f.launches.at(-1);
  const q = await f
    .flow(first)
    .call(f.id, first.id, 'ask_workspace_question', {text: 'When can you start?'});
  await f.runtime.answer(f.id, q.id, 'Next month');
  assert.equal(f.launches.length, 1);
  await f.finish(first);
  await f.runtime.tick();
  await settle();
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches.at(-1).recordOperation, 'execute');
  assert.equal(f.launches.at(-1).request.direct, true);
});

test(
  'document uploads need an execute task, not a reservation or a draft, and a file inside this workspace',
  {skip: symlinkSkip},
  async (t) => {
    const {mkdtemp, writeFile, rm, symlink} = await import('node:fs/promises'),
      os = await import('node:os'),
      path = await import('node:path');
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'record-upload-'));
    t.after(() => rm(workspace, {recursive: true, force: true}));
    await writeFile(path.join(workspace, 'cv.pdf'), 'Fixture CV');
    await writeFile(path.join(workspace, 'private.pdf'), 'Unlisted');
    const {mkdir} = await import('node:fs/promises');
    await mkdir(path.join(workspace, 'documents', 'import'), {recursive: true});
    await writeFile(path.join(workspace, 'documents', 'import', 'cv.pdf'), 'Imported CV');
    const f = fixture(t);
    await f.runtime.runRecord(f.id, f.item.id, 'prepare');
    await settle();
    let run = f.launches.at(-1);
    const calls = [],
      browser = {
        call: async (id, name, args) => {
          calls.push({name, args});
          return {content: [{type: 'text', text: 'Page URL: ' + f.item.url + '\nCV uploaded'}]};
        },
      };
    let flow = automationWorkflow({workspace, db: f.db, run, signal: {aborted: false}, browser});
    await assert.rejects(
      flow.call(f.id, run.id, 'browser_upload_document', {ref: 'file', filePath: 'cv.pdf'}),
      /application task/,
    );
    f.db.record(f.id, run.id, {
      url: f.item.url,
      title: f.item.title,
      summary: f.item.summary,
      proposal: 'Upload cv.pdf',
    });
    await f.finish(run);
    await f.runtime.runRecord(f.id, f.item.id, 'execute');
    await settle();
    run = f.launches.at(-1);
    flow = automationWorkflow({workspace, db: f.db, run, signal: {aborted: false}, browser});
    await symlink(new URL(import.meta.url).pathname, path.join(workspace, 'outside.pdf'));
    await assert.rejects(
      flow.call(f.id, run.id, 'browser_upload_document', {ref: 'file', filePath: 'outside.pdf'}),
      /in this workspace/,
    );
    await flow.call(f.id, run.id, 'browser_upload_document', {ref: 'file', filePath: 'cv.pdf'});
    assert.equal(calls[0].name, 'browser_upload_document');
    assert.equal(calls[0].args.ref, 'file');
    assert.equal(
      calls[0].args.filePath,
      await import('node:fs/promises').then((m) => m.realpath(path.join(workspace, 'cv.pdf'))),
    );
    // The import folder a document was stored in is the app's choice.
    await flow.call(f.id, run.id, 'browser_upload_document', {
      ref: 'file',
      filePath: 'documents/import/cv.pdf',
    });
    // Any document inside the workspace may be uploaded; no draft has to name it.
    await flow.call(f.id, run.id, 'browser_upload_document', {
      ref: 'file',
      filePath: 'private.pdf',
    });
    assert.equal(calls.filter((c) => c.name === 'browser_upload_document').length, 3);
  },
);

test('a verify that ends without portal proof keeps the record uncertain and asks the applicant for the outcome once', async (t) => {
  const f = fixture(t);
  await f.prepare();
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
  await settle();
  const execute = f.launches.at(-1);
  f.db.reserve(f.id, execute.id, f.item.id);
  await f.runtime.finish(f.id, 'blocked', 'Upload rejected', execute.workerId);
  await f.runtime.runRecord(f.id, f.item.id, 'verify');
  await settle();
  const verify = f.launches.at(-1);
  const browser = {
    call: async () => ({
      content: [
        {type: 'text', text: `Page URL: ${f.item.url}\nJob Application\nSubmit application`},
      ],
    }),
  };
  const flow = automationWorkflow({
    db: f.db,
    run: verify,
    signal: {aborted: false},
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  await flow.call(f.id, verify.id, 'browser_read', {});
  await flow.call(f.id, verify.id, 'finish_automation_run', {
    status: 'blocked',
    summary: 'Form boş, onay sayfası yok.',
    blocker: {
      category: 'site_problem',
      reason: 'The portal shows no confirmation for this application.',
      userAction: 'Check your email for a confirmation',
    },
  });
  const launches = f.launches.length;
  await f.runtime.finish(f.id, 'blocked', 'Form boş, onay sayfası yok.', verify.workerId);
  await settle();
  // The app asks the applicant once per record; the record stays uncertain
  // until they answer.
  const open = (f.db.get(f.id).questions ?? []).filter((q) => q.answer == null);
  assert.equal(open.length, 1);
  assert.equal(open[0].outcome, true);
  assert.equal(open[0].recordId, f.item.id);
  assert.deepEqual(open[0].fields, [OUTCOME_FIELD]);
  assert.equal(f.db.result(f.id, f.item.id).status, 'uncertain');
  assert.equal(f.launches.length, launches);
  f.db.answerQuestion(f.id, open[0].id, {[OUTCOME_FIELD.id]: OUTCOME_FIELD.options[1]});
  assert.equal(f.db.result(f.id, f.item.id).status, 'prepared');
  assert.equal(f.db.result(f.id, f.item.id).notSubmitted.kind, 'user');
});

test('Jev document upload uses the current record tab and observed upload ID', async () => {
  const calls = [],
    browser = {
      prepare: () => ({ready: true}),
      call: async (id, name, args) => {
        calls.push({name, args});
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({tabId: 'record-tab', url: 'https://employer.test/apply'}),
            },
          ],
        };
      },
    };
  const adapter = automationBrowser(browser, {
    mode: 'jev',
    recordId: 'item',
    readTabKey: 'record:item',
  });
  await adapter.call('workspace', 'browser_navigate', {url: 'https://employer.test/apply'}, 'run');
  await adapter.call(
    'workspace',
    'browser_upload_document',
    {ref: 'observed-upload', filePath: '/workspace/cv.pdf'},
    'run',
  );
  assert.deepEqual(calls.at(-1), {
    name: 'browser_upload',
    args: {tabId: 'record-tab', uploadId: 'observed-upload', filePath: '/workspace/cv.pdf'},
  });
});

test('manual preparation takes the next free worker ahead of automatic pending work', async (t) => {
  const f = fixture(t);
  await f.runtime.runOnce(f.id);
  await settle();
  const scan = f.launches.at(-1);
  f.db.put({...f.db.get(f.id), mode: 'prepare'});
  f.db.observe(f.id, scan.id, source + '/2', 'Other finding');
  const other = f.db.record(f.id, scan.id, {
    url: source + '/2',
    title: 'Other',
    summary: 'Other finding',
    assessment: {
      status: 'scored',
      scorecard: unknownScorecard(),
      score: 80,
      summary: 'Fits the saved criteria',
      evidenceUrl: source + '/2',
      evidence: 'Other finding',
      strengths: ['Relevant role'],
      gaps: [],
      uncertainties: [],
    },
  });
  const {enqueueRecordOperation} = await import('../app/records/operations.mjs');
  enqueueRecordOperation(f.runtime, f.id, other.id, 'prepare', {manual: false});
  const automatic = enqueueRecordOperation(f.runtime, f.id, f.item.id, 'prepare', {manual: false});
  const manual = await f.runtime.runRecord(f.id, f.item.id, 'prepare');
  assert.equal(manual.id, automatic.id);
  assert.equal(manual.request.manual, true);
  f.db.put({...f.db.get(f.id), status: 'enabled'});
  await f.finish(scan);
  await f.runtime.tick();
  await settle();
  assert.equal(f.launches.at(-1).recordId, f.item.id);
  assert.equal(f.launches.at(-1).request.manual, true);
});

test('table projection exposes queued, running, answered and stopped record activity', async (t) => {
  const {recordOperationStatus, recordActivityAt} =
    await import('../src/record-operation-status.js');
  const f = fixture(t);
  await f.runtime.runOnce(f.id);
  await settle();
  const scan = f.launches.at(-1);
  await f.runtime.runRecord(f.id, f.item.id, 'prepare');
  let row = f.db.snapshot(f.id).results.find((r) => r.id === f.item.id);
  assert.equal(recordOperationStatus(row).label, 'Preparation queued');
  assert.equal(recordOperationStatus(row).active, true);
  assert.ok(recordActivityAt(row) >= row.updatedAt);
  await f.finish(scan);
  await f.runtime.tick();
  await settle();
  row = f.db.snapshot(f.id).results.find((r) => r.id === f.item.id);
  assert.equal(recordOperationStatus(row).label, 'Preparing');
  const q = f.db.askQuestion(f.id, {recordId: f.item.id, text: 'Availability?'});
  row = f.db.snapshot(f.id).results.find((r) => r.id === f.item.id);
  assert.equal(recordOperationStatus(row).label, 'Awaiting answer');
  f.db.answerQuestion(f.id, q.id, 'Next month');
  await f.finish(f.launches.at(-1), 'blocked');
  row = f.db.snapshot(f.id).results.find((r) => r.id === f.item.id);
  assert.equal(recordOperationStatus(row).label, 'Operation blocked');
  assert.equal(recordOperationStatus(row).active, false);
  assert.equal(recordOperationStatus({...row, status: 'completed'}), null);
  const notEligible = {
    ...row,
    recordAction: {
      ...row.recordAction,
      lastTask: {
        ...row.recordAction.lastTask,
        blocker: {category: 'not_eligible', reason: 'US only'},
      },
    },
  };
  assert.equal(recordOperationStatus(notEligible).label, 'Not eligible');
});

test('an explicit record request starts one disabled worker and keeps workspace permissions unchanged', async (t) => {
  const f = fixture(t);
  const second = f.runtime.workers.add(f.id);
  for (const worker of f.runtime.workers.list(f.id))
    f.runtime.workers.setEnabled(f.id, worker.id, false);
  f.db.put({...f.db.get(f.id), status: 'paused'});
  const before = f.db.get(f.id);
  await f.runtime.runRecord(f.id, f.item.id, 'prepare');
  await settle();
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].recordId, f.item.id);
  assert.equal(f.runtime.workers.get(f.id, 'main').enabled, true);
  assert.equal(f.runtime.workers.get(f.id, second.id).enabled, false);
  assert.equal(f.db.get(f.id).status, before.status);
  assert.equal(f.db.get(f.id).mode, before.mode);
  await f.runtime.stopWorker(f.id, 'main');
  await f.runtime.tick();
  assert.equal(f.runtime.workers.get(f.id, 'main').enabled, false);
  assert.equal(f.launches.length, 1);
  await f.runtime.runRecord(f.id, f.item.id, 'prepare');
  await settle();
  assert.equal(f.launches.length, 2);
});

test('repeating a queued request wakes a worker and more preparation work starts another existing worker', async (t) => {
  const f = fixture(t);
  const {enqueueRecordOperation} = await import('../app/records/operations.mjs');
  f.runtime.workers.setEnabled(f.id, 'main', false);
  // A rejected request (verify on a record that is not uncertain) wakes nobody.
  await assert.rejects(f.runtime.runRecord(f.id, f.item.id, 'verify'), /uncertain outcome/);
  assert.equal(f.runtime.workers.get(f.id, 'main').enabled, false);
  const pending = enqueueRecordOperation(f.runtime, f.id, f.item.id, 'prepare');
  f.runtime.workers.setEnabled(f.id, 'main', false);
  await f.runtime.runRecord(f.id, f.item.id, 'prepare');
  await settle();
  assert.equal(f.launches[0].taskId, pending.id);
  const extra = f.runtime.workers.add(f.id);
  f.runtime.workers.setEnabled(f.id, extra.id, false);
  const other = f.db.putResult({
    ...f.item,
    id: 'other-record',
    key: source + '/other',
    url: source + '/other',
  });
  const queued = await f.runtime.runRecord(f.id, other.id, 'prepare');
  await settle();
  assert.equal(queued.state, 'running');
  assert.equal(f.launches.length, 2);
  assert.equal(f.runtime.workers.get(f.id, extra.id).enabled, true);
  await f.runtime.stopWorker(f.id, 'main');
  await f.runtime.tick();
  assert.equal(f.launches.length, 2);
  assert.equal(f.runtime.workers.get(f.id, 'main').enabled, false);
});

test('preparation backlog uses all configured workers and leaves excess work queued', async (t) => {
  const f = fixture(t);
  f.runtime.workers.add(f.id);
  f.runtime.workers.add(f.id);
  for (const worker of f.runtime.workers.list(f.id))
    f.runtime.workers.setEnabled(f.id, worker.id, false);
  const {enqueueRecordOperation} = await import('../app/records/operations.mjs');
  const records = [
    f.item,
    ...Array.from({length: 4}, (_, n) =>
      f.db.putResult({
        ...f.item,
        id: 'parallel-' + n,
        key: source + '/parallel-' + n,
        url: source + '/parallel-' + n,
      }),
    ),
  ];
  // Batch requests before a scheduler tick, as happens when work survives a restart.
  for (const item of records) enqueueRecordOperation(f.runtime, f.id, item.id, 'prepare');
  assert.equal(f.runtime.workers.list(f.id).filter((w) => w.enabled).length, 3);
  await f.runtime.tick();
  await settle();
  assert.equal(f.launches.length, 3);
  assert.equal(new Set(f.launches.map((r) => r.recordId)).size, 3);
  assert.equal(
    f.runtime.queue.list(f.id, {states: ['pending']}).filter((t) => t.recordOperation).length,
    2,
  );
  await f.runtime.stopWorker(f.id, f.launches[0].workerId);
  await f.runtime.tick();
  assert.equal(f.launches.length, 3);
  await f.finish(f.launches[1], 'blocked');
  await f.runtime.tick();
  await settle();
  assert.equal(f.launches.length, 4);
  assert.equal(f.runtime.workers.list(f.id).length, 3);
});

test('record context does not replay another record login blocker from the same source', async (t) => {
  const f = fixture(t);
  const old = f.db.begin(f.id, 'run');
  f.db.putRun({...old, sourceUrl: source, recordId: 'unrelated-record'});
  f.db.finish(f.id, old.id, 'blocked', 'Another record required login');
  await f.runtime.runRecord(f.id, f.item.id, 'prepare');
  await settle();
  const current = f.launches.at(-1);
  const context = await f.flow(current).call(f.id, current.id, 'get_automation_context', {});
  assert.equal(
    context.previousRuns.some((r) => r.id === old.id),
    false,
  );
});

// The whole automation context, joining its parts when it is too large for one response.
const fullContext = async (flow, id, runId) => {
  let page = await flow.call(id, runId, 'get_automation_context', {});
  if (!page.context?.id) return page;
  let text = '';
  while (true) {
    text += page.text;
    if (page.context.nextOffset === null) return JSON.parse(text);
    page = await flow.call(id, runId, 'read_automation_context_part', {
      contextId: page.context.id,
      offset: page.context.nextOffset,
    });
  }
};

for (const template of ['job-search', 'housing', 'appointment', 'custom'])
  test(`direct execution needs no prior preparation, preserves authorization and records a verified outcome (${template})`, async (t) => {
    const f = fixture(t, template),
      originalMode = f.db.get(f.id).mode;
    const initial = f.db.snapshot(f.id).results[0];
    assert.equal(initial.status, 'found');
    // The one record action is the execution itself; there is no separate
    // direct or draft operation.
    assert.equal(initial.recordAction.operation.kind, 'execute');
    assert.equal(initial.recordAction.operation.disabled, false);
    assert.equal(initial.recordAction.directOperation, null);
    const task = await f.runtime.runRecord(f.id, f.item.id, 'execute');
    await settle();
    const run = f.launches.at(-1);
    assert.equal(
      (await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true})).id,
      task.id,
    );
    assert.equal(f.launches.length, 1);
    assert.equal(run.recordOperation, 'execute');
    assert.equal(run.request.direct, true);
    assert.equal(run.request.digest, undefined);
    const context = await fullContext(f.flow(run), f.id, run.id);
    assert.equal(context.recordAuthorization.directExecution, true);
    assert.equal(context.recordAuthorization.explicitUserRequest, true);
    assert.equal(context.recordAuthorization.approvedProposalDigest, undefined);
    assert.equal(context.recordAuthorization.rule, directRecordInstructions);
    f.db.record(f.id, run.id, {
      key: f.item.key,
      url: f.item.url,
      title: f.item.title,
      summary: 'Verified answers',
      proposal: 'Actual form: verified answers, documents/cv.pdf, no additional commitments',
    });
    assert.throws(
      () => f.db.finish(f.id, run.id, 'completed', 'Only filled the form'),
      /application is not finished/,
    );
    f.db.reserve(f.id, run.id, f.item.id);
    assert.equal(f.db.reserve(f.id, run.id, f.item.id).alreadyReserved, true);
    f.db.observe(f.id, run.id, f.item.url, 'Confirmed submitted');
    f.db.resolve(f.id, run.id, f.item.id, {
      status: 'completed',
      url: f.item.url,
      evidence: 'Confirmed submitted',
    });
    await f.finish(run);
    assert.equal(f.db.snapshot(f.id).results[0].recordAction.operation, null);
    assert.equal(f.db.get(f.id).mode, originalMode);
    await assert.rejects(
      f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true}),
      /cannot be submitted again/,
    );
  });

test('direct execution is explicit, record-scoped, and a queued request still requires the current setup revision', async (t) => {
  const f = fixture(t),
    {enqueueRecordOperation} = await import('../app/records/operations.mjs');
  // Below auto mode only the user's own request may apply a record.
  f.db.put({...f.db.get(f.id), mode: 'prepare'});
  assert.throws(
    () =>
      enqueueRecordOperation(f.runtime, f.id, f.item.id, 'execute', {manual: false, direct: true}),
    /user request/,
  );
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  const other = f.db.putResult({
    ...f.item,
    id: 'not-assigned',
    key: 'not-assigned',
    url: source + '/not-assigned',
  });
  assert.throws(() => f.db.reserve(f.id, run.id, other.id), /does not belong/);
  await f.finish(run, 'blocked');
  // Hold the only worker with a source scan, then queue a new request. A setup
  // change while it waits cancels it instead of applying the record.
  await f.runtime.runOnce(f.id);
  await settle();
  const scan = f.launches.at(-1);
  const queued = await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
  assert.equal(queued.state, 'pending');
  f.db.put({...f.db.get(f.id), maxActionsPerDay: 10, revision: f.db.get(f.id).revision + 1});
  await f.finish(scan);
  await f.runtime.tick();
  await settle();
  const cancelled = f.runtime.queue.get(f.id, queued.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.match(cancelled.summary, /setup changed/);
  assert.equal(f.launches.filter((r) => r.recordOperation === 'execute').length, 1);
});

for (const answerBeforeFinish of [false, true])
  test(`direct request continues after record questions without a preparation detour (answer before finish: ${answerBeforeFinish})`, async (t) => {
    const f = fixture(t);
    await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
    await settle();
    const run = f.launches.at(-1);
    const q = await f.flow(run).call(f.id, run.id, 'ask_workspace_question', {
      text: 'Earliest available date?',
      fields: [{id: 'date', label: 'Date', type: 'date'}],
    });
    assert.equal(q.taskId, run.taskId);
    if (!answerBeforeFinish) await f.finish(run);
    await f.runtime.answer(f.id, q.id, {date: '2026-10-15'});
    if (answerBeforeFinish) {
      await f.finish(run);
      await f.runtime.tick();
    }
    await settle();
    const next = f.launches.at(-1);
    assert.notEqual(next.id, run.id);
    assert.equal(next.recordOperation, 'execute');
    assert.equal(next.request.direct, true);
    assert.equal(next.recordId, f.item.id);
  });

test('stopping a direct request ends its task; a later answer starts a fresh direct execution', async (t) => {
  const f = fixture(t);
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  const q = await f.flow(run).call(f.id, run.id, 'ask_workspace_question', {text: 'Missing fact?'});
  await f.runtime.stopWorker(f.id, run.workerId);
  assert.equal(f.db.run(run.id).status, 'interrupted');
  assert.equal(f.launches.length, 1);
  await f.runtime.answer(f.id, q.id, 'Known now');
  await settle();
  // There is no draft fallback: the answer continues the application in a new task.
  const next = f.launches.at(-1);
  assert.notEqual(next.id, run.id);
  assert.notEqual(next.taskId, run.taskId);
  assert.equal(next.recordOperation, 'execute');
  assert.equal(next.request.direct, true);
  assert.equal(next.recordId, f.item.id);
});

test('uncertain direct execution cannot be retried as another submission', async (t) => {
  const f = fixture(t);
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  f.db.record(f.id, run.id, {
    key: f.item.key,
    url: f.item.url,
    title: f.item.title,
    summary: 'Checked',
    proposal: 'Verified form',
  });
  f.db.reserve(f.id, run.id, f.item.id);
  await f.runtime.finish(f.id, 'interrupted', 'Connection lost', run.workerId);
  assert.equal(f.db.result(f.id, f.item.id).status, 'uncertain');
  await assert.rejects(
    f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true}),
    /cannot be submitted again/,
  );
  assert.equal(f.db.snapshot(f.id).results[0].recordAction.directOperation, null);
});

// A record stuck on an unverified submit can be skipped from its question; the
// skip remembers the uncertainty, so Restore never reopens a new submission.
test('an uncertain record can be skipped and restores as uncertain', async (t) => {
  const f = fixture(t);
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  f.db.record(f.id, run.id, {
    key: f.item.key,
    url: f.item.url,
    title: f.item.title,
    summary: 'Checked',
    proposal: 'Verified form',
  });
  f.db.reserve(f.id, run.id, f.item.id);
  await f.runtime.finish(f.id, 'interrupted', 'Connection lost', run.workerId);
  const q = f.db.askQuestion(f.id, {recordId: f.item.id, text: 'Driving licence?'});
  assert.equal(
    f.db.snapshot(f.id).automation.questions.find((item) => item.id === q.id).canDismissRecord,
    true,
  );
  await f.runtime.dismissRecord(f.id, f.item.id);
  const skipped = f.db.result(f.id, f.item.id);
  assert.equal(skipped.status, 'dismissed');
  assert.equal(skipped.skippedFrom, 'uncertain');
  assert.ok(f.db.get(f.id).questions.find((item) => item.id === q.id).answer);
  const restored = f.runtime.restoreRecord(f.id, f.item.id);
  assert.equal(restored.status, 'uncertain');
  assert.equal(restored.skippedFrom, undefined);
  await assert.rejects(
    f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true}),
    /cannot be submitted again/,
  );
});

for (const template of ['job-search', 'housing', 'appointment', 'custom'])
  test(`${template}: a redirected form updates the assigned ID without changing discovery identity`, async (t) => {
    const f = fixture(t, template),
      form = 'https://forms.test/apply/123';
    await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
    await settle();
    const run = f.launches.at(-1);
    const input = {
      key: f.item.key,
      url: form,
      title: f.item.title,
      summary: 'Form inspected',
      proposal: 'Exact form answers',
    };
    assert.throws(() => f.db.record(f.id, run.id, input), /in this task first/);
    f.db.observe(f.id, run.id, form, 'Application form for the assigned listing');
    const saved = f.db.record(f.id, run.id, input);
    assert.equal(saved.id, f.item.id);
    assert.equal(saved.key, f.item.key);
    assert.equal(saved.url, f.item.url);
    assert.equal(saved.actionUrl, form);
    assert.equal(f.store.workspaces.records.find(f.id, f.item.key).id, f.item.id);
    assert.equal(f.store.workspaces.records.find(f.id, form), null);
    assert.equal(f.db.results(f.id).length, 1);
    // Legacy clients sometimes use the form URL for both key and url.
    assert.equal(f.db.record(f.id, run.id, {...input, key: form}).id, f.item.id);
    assert.equal(f.db.reserve(f.id, run.id, f.item.id).url, form);
  });

test('explicit destination changes invalidate reviewed consent and cannot target another record', async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {digest: prepared.digest});
  await settle();
  const run = f.launches.at(-1);
  const form = 'https://forms.test/apply/changed';
  f.db.observe(f.id, run.id, form, 'Observed form');
  const input = {
    recordId: f.item.id,
    key: f.item.key,
    url: f.item.url,
    actionUrl: form,
    title: f.item.title,
    summary: 'Changed form',
    proposal: prepared.proposal,
  };
  const saved = f.db.record(f.id, run.id, input);
  assert.notEqual(saved.digest, prepared.digest);
  assert.equal(saved.approvedDigest, null);
  const other = f.db.putResult({
    ...f.item,
    id: 'foreign-record',
    key: source + '/other',
    url: source + '/other',
  });
  for (const change of [
    {recordId: other.id},
    {key: other.key},
    {url: other.url},
    {actionUrl: other.url},
  ])
    assert.throws(() => f.db.record(f.id, run.id, {...input, ...change}), /does not belong/);
  assert.equal(f.db.result(f.id, other.id).proposal, '');
  assert.equal(f.db.result(f.id, f.item.id).actionUrl, form);
});

test('rediscovering a listing keeps its form destination and does not create a duplicate', async (t) => {
  const f = fixture(t);
  await f.runtime.runRecord(f.id, f.item.id, 'prepare');
  await settle();
  const run = f.launches.at(-1),
    form = 'https://forms.test/apply/rediscovered';
  f.db.observe(f.id, run.id, form, 'Form');
  const saved = f.db.record(f.id, run.id, {
    recordId: f.item.id,
    key: f.item.key,
    url: f.item.url,
    actionUrl: form,
    title: f.item.title,
    summary: 'Ready',
    proposal: 'Saved answers',
  });
  await f.finish(run);
  const scan = f.db.begin(f.id, 'run'),
    rediscovered = f.db.record(f.id, scan.id, {
      key: f.item.key,
      url: f.item.url,
      title: f.item.title,
      summary: 'Found again',
    });
  assert.equal(rediscovered.id, f.item.id);
  assert.equal(rediscovered.actionUrl, form);
  assert.equal(rediscovered.digest, saved.digest);
  assert.equal(f.db.results(f.id).length, 1);
  f.db.finish(f.id, scan.id, 'completed', 'Done');
});

for (const template of ['job-search', 'housing', 'appointment', 'custom'])
  test(`${template}: legacy action quotas and expiry cannot block authorized execution`, async (t) => {
    const f = fixture(t, template);
    // Simulate a database written by a pre-removal release, bypassing new writes.
    f.db.db
      .prepare(
        "UPDATE automations SET data=json_set(data,'$.maxActionsTotal',0,'$.maxActionsPerDay',0,'$.endAt',1) WHERE id=?",
      )
      .run(f.id);
    assert.equal(f.db.get(f.id).maxActionsTotal, undefined);
    assert.equal(f.db.get(f.id).maxActionsPerDay, undefined);
    assert.equal(f.db.get(f.id).endAt, undefined);
    await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
    await settle();
    const run = f.launches.at(-1);
    const context = await fullContext(f.flow(run), f.id, run.id);
    for (const key of ['maxActionsTotal', 'maxActionsPerDay', 'endAt'])
      assert.equal(key in context.automation, false);
    f.db.record(f.id, run.id, {
      key: f.item.key,
      url: f.item.url,
      title: f.item.title,
      summary: 'Verified',
      proposal: 'Authorized action',
    });
    assert.equal(f.db.reserve(f.id, run.id, f.item.id).reserved, true);
    assert.equal(f.db.reserve(f.id, run.id, f.item.id).alreadyReserved, true);
  });

for (const template of ['job-search', 'housing', 'appointment'])
  test(`${template}: positive not-submitted proof resumes the authorized record in a separate execution`, async (t) => {
    const f = fixture(t, template);
    await f.prepare();
    await f.runtime.runRecord(f.id, f.item.id, 'execute');
    await settle();
    const execute = f.launches.at(-1);
    f.db.reserve(f.id, execute.id, f.item.id);
    await f.runtime.finish(f.id, 'blocked', 'Upload interrupted', execute.workerId);
    await f.runtime.runRecord(f.id, f.item.id, 'verify');
    await settle();
    const verify = f.launches.at(-1);
    const quote = `${f.item.url} — Draft`,
      page = {url: f.item.url, text: quote};
    f.db.observe(f.id, verify.id, page.url, quote);
    const result = f.db.resolve(
      f.id,
      verify.id,
      f.item.id,
      {
        status: 'not_submitted',
        url: page.url,
        evidence: quote,
        notSubmittedProof: {kind: 'draft', quote, recordEvidence: f.item.url},
      },
      page,
    );
    assert.equal(result.status, 'prepared');
    assert.equal(result.notSubmitted.attemptRunId, execute.id);
    assert.equal(f.db.run(verify.id).actionId, null);
    assert.throws(() => f.db.reserve(f.id, verify.id, f.item.id));
    await f.finish(verify);
    await f.runtime.tick();
    await settle();
    const resumed = f.launches.at(-1);
    assert.notEqual(resumed.id, verify.id);
    assert.equal(resumed.recordOperation, 'execute');
    assert.equal(resumed.recordId, f.item.id);
    assert.equal(resumed.request.direct, true);
    assert.equal(resumed.request.digest, undefined);
    assert.equal(f.db.reserve(f.id, resumed.id, f.item.id).reserved, true);
  });

test('absence of confirmation, stale identity and foreign site cannot release uncertainty', async (t) => {
  const f = fixture(t),
    draft = await f.prepare();
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {digest: draft.digest});
  await settle();
  const execute = f.launches.at(-1);
  f.db.reserve(f.id, execute.id, f.item.id);
  await f.runtime.finish(f.id, 'blocked', 'Unknown outcome', execute.workerId);
  await f.runtime.runRecord(f.id, f.item.id, 'verify');
  await settle();
  const verify = f.launches.at(-1);
  for (const [quote, identity, url, loading] of [
    [
      `${f.item.url} My Experience. Upload a file. No success confirmation.`,
      f.item.url,
      f.item.url,
      false,
    ],
    ['https://example.test/other — Draft', 'https://example.test/other', f.item.url, false],
    [`${f.item.url} — Draft`, f.item.url, 'https://foreign.test/', false],
    [`${f.item.url} — Draft`, f.item.url, f.item.url, true],
  ]) {
    f.db.observe(f.id, verify.id, url, quote);
    assert.throws(() =>
      f.db.resolve(
        f.id,
        verify.id,
        f.item.id,
        {
          status: 'not_submitted',
          url,
          evidence: quote,
          notSubmittedProof: {kind: 'draft', quote, recordEvidence: identity},
        },
        {url, text: quote, readiness: {loading}},
      ),
    );
    assert.equal(f.db.result(f.id, f.item.id).status, 'uncertain');
  }
});

for (const change of ['proposal', 'revision', 'stop'])
  test(`not-submitted recovery does not revive authority after ${change}`, async (t) => {
    const f = fixture(t),
      draft = await f.prepare();
    await f.runtime.runRecord(f.id, f.item.id, 'execute', {digest: draft.digest});
    await settle();
    const execute = f.launches.at(-1);
    f.db.reserve(f.id, execute.id, f.item.id);
    await f.runtime.finish(f.id, 'blocked', 'Unknown outcome', execute.workerId);
    await f.runtime.runRecord(f.id, f.item.id, 'verify');
    await settle();
    const verify = f.launches.at(-1),
      quote = `${f.item.url} — Draft`;
    f.db.observe(f.id, verify.id, f.item.url, quote);
    f.db.resolve(
      f.id,
      verify.id,
      f.item.id,
      {
        status: 'not_submitted',
        url: f.item.url,
        evidence: quote,
        notSubmittedProof: {kind: 'draft', quote, recordEvidence: f.item.url},
      },
      {url: f.item.url, text: quote},
    );
    await f.finish(verify);
    const before = f.launches.length;
    if (change === 'proposal')
      f.db.putResult({
        ...f.db.result(f.id, f.item.id),
        digest: 'changed',
        proposal: 'Changed commitment',
      });
    if (change === 'revision') f.db.put({...f.db.get(f.id), revision: f.db.get(f.id).revision + 1});
    if (change === 'stop') await f.runtime.pause(f.id);
    await f.runtime.tick();
    await settle();
    assert.equal(f.launches.length, before);
    assert.equal(f.db.result(f.id, f.item.id).status, 'prepared');
  });

test('not-submitted tool rechecks the live page and does not trust an earlier draft snapshot', async (t) => {
  const f = fixture(t),
    draft = await f.prepare();
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
  await settle();
  const execute = f.launches.at(-1);
  f.db.reserve(f.id, execute.id, f.item.id);
  await f.runtime.finish(f.id, 'blocked', 'Unknown outcome', execute.workerId);
  await f.runtime.runRecord(f.id, f.item.id, 'verify');
  await settle();
  const verify = f.launches.at(-1);
  const quote = `${f.item.url} — Draft`;
  let text = quote;
  const browser = {
    call: async () => ({
      content: [{type: 'text', text: `### Page\n- Page URL: ${f.item.url}\n${text}`}],
    }),
  };
  const flow = automationWorkflow({
    db: f.db,
    run: verify,
    signal: {aborted: false},
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  let observed = await flow.call(f.id, verify.id, 'browser_read', {});
  const args = {
    itemId: f.item.id,
    status: 'not_submitted',
    url: f.item.url,
    evidence: quote,
    notSubmittedProof: {
      snapshotId: observed.snapshot.id,
      kind: 'draft',
      quote,
      recordEvidence: f.item.url,
    },
  };
  text = `${f.item.url} — Submitted`;
  const rejected = await flow.call(f.id, verify.id, 'record_automation_outcome', args);
  assert.equal(rejected.status, 'evidence_rejected');
  assert.equal(rejected.saved, false);
  assert.match(rejected.error, /draft/);
  assert.ok(rejected.snapshot.id);
  assert.notEqual(rejected.snapshot.id, observed.snapshot.id);
  assert.equal(f.db.result(f.id, f.item.id).status, 'uncertain');
  text = quote;
  args.notSubmittedProof.snapshotId = rejected.snapshot.id;
  assert.equal(
    (await flow.call(f.id, verify.id, 'record_automation_outcome', args)).status,
    'prepared',
  );
  await f.finish(verify);
  await f.runtime.tick();
  await settle();
  assert.equal(f.launches.at(-1).request.direct, true);
});

test('verify outcome defaults itemId and url to the assigned record and the observed page', async (t) => {
  const f = fixture(t);
  await f.prepare();
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
  await settle();
  const execute = f.launches.at(-1);
  f.db.reserve(f.id, execute.id, f.item.id);
  await f.runtime.finish(f.id, 'blocked', 'Unknown outcome', execute.workerId);
  await f.runtime.runRecord(f.id, f.item.id, 'verify');
  await settle();
  const verify = f.launches.at(-1);
  const browser = {
    call: async () => ({
      content: [
        {type: 'text', text: `Page URL: ${f.item.url}\nYour application has been submitted`},
      ],
    }),
  };
  const flow = automationWorkflow({
    db: f.db,
    run: verify,
    signal: {aborted: false},
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  await assert.rejects(
    flow.call(f.id, verify.id, 'record_automation_outcome', {
      status: 'completed',
      evidence: 'Confirmation shown',
    }),
    /Observe the results page/,
  );
  await flow.call(f.id, verify.id, 'browser_read', {});
  const saved = await flow.call(f.id, verify.id, 'record_automation_outcome', {
    status: 'completed',
    evidence: 'Confirmation shown',
  });
  assert.equal(saved.status, 'completed');
  assert.equal(saved.proofUrl, f.item.url);
});

test('Jev multiline portal status accepts a paraphrased description without another attempt', async (t) => {
  const f = fixture(t);
  await f.prepare();
  const title = 'Sr. Intelligence Software Engineer (Remote, DEU)',
    code = 'R30035';
  f.db.putResult({...f.db.result(f.id, f.item.id), title: `${title} — CrowdStrike ${code}`});
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
  await settle();
  const execute = f.launches.at(-1);
  f.db.reserve(f.id, execute.id, f.item.id);
  await f.runtime.finish(f.id, 'blocked', 'Unknown outcome', execute.workerId);
  await f.runtime.runRecord(f.id, f.item.id, 'verify');
  await settle();
  const verify = f.launches.at(-1);
  const quote = `${title}\n${code}\nNot Submitted`;
  const browser = {
    call: async () => ({
      content: [
        {
          type: 'text',
          text: `Page URL: ${f.item.url}\n${JSON.stringify({browser: 'Jev Chrome', url: f.item.url, text: `My Applications\n${quote}\nCreated on September 30, 2026`})}`,
        },
      ],
    }),
  };
  const flow = automationWorkflow({
    db: f.db,
    run: verify,
    signal: {aborted: false},
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  const observed = await flow.call(f.id, verify.id, 'browser_read', {});
  const args = {
    itemId: f.item.id,
    status: 'not_submitted',
    url: f.item.url,
    evidence: quote,
    notSubmittedProof: {
      snapshotId: observed.snapshot.id,
      kind: 'draft',
      quote: quote.replaceAll('\n', ' — '),
      recordEvidence: code,
    },
  };
  const saved = await flow.call(f.id, verify.id, 'record_automation_outcome', args);
  assert.equal(saved.status, 'prepared');
  assert.equal(saved.notSubmitted.quote, quote.replaceAll('\n', ' — '));
  assert.equal(f.db.run(verify.id).actionId, null);
  await f.finish(verify);
  await f.runtime.tick();
  await settle();
  assert.equal(f.launches.at(-1).recordOperation, 'execute');
  assert.equal(f.launches.at(-1).request.direct, true);
});

test('a high fit score cannot authorize automatic execution with unmet or unknown mandatory conditions', async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  f.db.put({...f.db.get(f.id), mode: 'auto'});
  const a = f.db.get(f.id);
  for (const eligibility of ['mismatch', 'unverified']) {
    const assessment = {score: 95, scoringVersion: 4, revision: a.revision, eligibility};
    const item = f.db.putResult({...prepared, assessment});
    assert.match(recordOperationError(a, item, 'execute'), /required criteri/i);
    assert.equal(recordOperationError(a, item, 'score'), null);
    assert.equal(
      recordOperationError(a, item, 'execute', {manual: true, digest: item.digest}),
      null,
    );
  }
  const verified = {score: 95, scoringVersion: 4, revision: a.revision, eligibility: 'verified'};
  assert.equal(recordOperationError(a, {...prepared, assessment: verified}, 'execute'), null);
  assert.match(
    recordOperationError(a, {...prepared, assessment: {...verified, scoringVersion: 3}}, 'execute'),
    /re-score/i,
  );
  // A profile revision never invalidates a saved score.
  assert.equal(
    recordOperationError(
      a,
      {...prepared, assessment: {...verified, revision: a.revision - 1}},
      'execute',
    ),
    null,
  );
  // Recheck at reservation: eligibility may change after a task was queued.
  f.db.putResult({...prepared, assessment: verified});
  enqueueRecordOperation(f.runtime, f.id, prepared.id, 'execute', {manual: false});
  f.db.enable(f.id);
  await f.runtime.tick();
  await settle();
  const run = f.launches.find((r) => r.recordOperation === 'execute');
  assert.ok(run);
  f.db.putResult({...prepared, assessment: {...verified, eligibility: 'mismatch'}});
  assert.throws(() => f.db.reserve(f.id, run.id, prepared.id), /required criteri/i);
  assert.equal(f.db.result(f.id, prepared.id).status, 'prepared');
  await f.finish(run, 'blocked');
});

test('starting workers cannot recreate a cancelled automatic execution queue; explicit execute remains available', async (t) => {
  const f = fixture(t);
  f.db.put({...f.db.get(f.id), mode: 'auto'});
  f.db.putResult({
    ...f.db.result(f.id, f.item.id),
    assessment: {
      score: 95,
      scoringVersion: 4,
      revision: f.db.get(f.id).revision,
      eligibility: 'verified',
    },
  });
  const task = enqueueRecordOperation(f.runtime, f.id, f.item.id, 'execute', {manual: false});
  assert.equal(task.request.manual, false);
  assert.equal(task.request.direct, true);
  await f.runtime.pause(f.id);
  assert.equal(f.runtime.queue.get(f.id, task.id).state, 'cancelled');
  assert.equal(f.runtime.queue.get(f.id, task.id).stopRequested, true);
  f.db.enable(f.id);
  await dispatchRecordOperations(f.runtime, f.id);
  await settle();
  assert.equal(f.launches.length, 0);
  assert.equal(
    f.runtime.queue.list(f.id, {states: ['pending']}).filter((t) => t.recordOperation).length,
    0,
  );
  f.db.putResult({...f.item, updatedAt: f.item.updatedAt + 1});
  await dispatchRecordOperations(f.runtime, f.id);
  await settle();
  assert.equal(
    f.launches.length,
    0,
    'A later score or cell update cannot revoke the explicit cancellation',
  );
  await f.runtime.runRecord(f.id, f.item.id, 'execute');
  await settle();
  assert.equal(f.launches.at(-1).recordOperation, 'execute');
  assert.equal(f.launches.at(-1).request.manual, true);
});

for (const oldSource of ['https://example.test/list/', 'https://removed.test/jobs'])
  test(`stale source ${oldSource} cannot schedule preparation on worker start`, async (t) => {
    const f = fixture(t);
    f.db.put({...f.db.get(f.id), mode: 'auto', sourceSettings: {[source]: {mode: 'observe'}}});
    f.db.putResult({...f.item, sourceUrl: oldSource});
    f.db.enable(f.id);
    await dispatchRecordOperations(f.runtime, f.id);
    await settle();
    assert.equal(f.launches.length, 0);
    assert.match(
      recordOperationError(f.db.get(f.id), f.db.result(f.id, f.item.id), 'prepare'),
      /find-only/,
    );
    // Explicit manual preparation is still authorized for the selected record.
    assert.equal(
      recordOperationError(f.db.get(f.id), f.db.result(f.id, f.item.id), 'prepare', {manual: true}),
      null,
    );
  });

// The user learns the outcome outside the app (confirmation mail): one action
// completes the record, closes its open questions and blocks any resend.
test('a user can mark a found, prepared or uncertain record as submitted', async (t) => {
  const f = fixture(t);
  const prepared = await f.prepare();
  f.db.askQuestion(f.id, {recordId: prepared.id, text: 'Pending detail'});
  const saved = await f.runtime.markRecordSubmitted(f.id, prepared.id);
  assert.equal(saved.status, 'completed');
  assert.match(saved.evidence, /confirmed the record was submitted/);
  assert.ok(f.db.get(f.id).questions.every((q) => q.recordId !== prepared.id || q.answer != null));
  const state = f.db.snapshot(f.id).results.find((r) => r.id === prepared.id);
  assert.equal(state.status, 'completed');
  assert.equal(state.recordAction?.task ?? null, null);
  assert.throws(() => f.db.markSubmitted(f.id, prepared.id), /cannot be marked/);
  assert.throws(() => f.db.dismiss(f.id, prepared.id), /cannot be changed/);
  // A queued or running operation blocks the manual mark.
  const other = f.db.putResult({...f.item, id: undefined, key: source + '/2', url: source + '/2'});
  await f.runtime.runRecord(f.id, other.id, 'execute', {direct: true});
  await settle();
  assert.throws(() => f.db.markSubmitted(f.id, other.id), /queued or running/);
});

// A skip can be taken back: the record returns to found and can be applied.
test('a user can restore a skipped record and apply it again', async (t) => {
  const f = fixture(t);
  const prepared = await f.prepare();
  await f.runtime.dismissRecord(f.id, prepared.id);
  assert.match(
    recordOperationError(f.db.get(f.id), f.db.result(f.id, prepared.id), 'execute', {manual: true}),
    /cannot be submitted again/,
  );
  const restored = f.runtime.restoreRecord(f.id, prepared.id);
  assert.equal(restored.status, 'found');
  assert.equal(
    recordOperationError(f.db.get(f.id), f.db.result(f.id, prepared.id), 'execute', {manual: true}),
    null,
  );
  assert.throws(() => f.db.restore(f.id, prepared.id), /Only a skipped record/);
});

test('an unconfirmed submit click attaches one viewport image; a confirmed one attaches nothing', async (t) => {
  for (const confirmed of [false, true]) {
    const f = fixture(t);
    const item = await f.prepare();
    await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
    await settle();
    const run = f.launches.at(-1);
    f.db.reserve(f.id, run.id, item.id);
    const image = {type: 'image', mimeType: 'image/jpeg', data: 'aGVsbG8='},
      calls = [];
    let clicked = false;
    const browser = {
      currentUrl: async () => item.url,
      call: async (_id, name) => {
        calls.push(name);
        if (name === 'browser_screenshot') return {content: [image]};
        if (name === 'browser_click') clicked = true;
        const page = clicked
          ? {
              url: item.url,
              text: confirmed ? 'Thank you for applying!' : 'Result\nAbout the company',
              clickTargets: [],
            }
          : {
              url: item.url,
              text: 'Job Application\nResult',
              fillFields: [{fieldId: 'f1'}],
              clickTargets: [{targetId: 'e1', label: 'Submit application'}],
            };
        return {
          content: [{type: 'text', text: `Page URL: ${item.url}\n${JSON.stringify(page)}`}],
          action: {executed: true},
        };
      },
    };
    const flow = automationWorkflow({
      db: f.db,
      run,
      signal: new AbortController().signal,
      submitSettleMs: 0,
      browser,
      report: (...args) => f.runtime.report(...args),
    });
    await flow.call(f.id, run.id, 'browser_open', {url: item.url});
    const result = await flow.call(f.id, run.id, 'browser_interact', {
      operation: 'click',
      ref: 'e1',
    });
    assert.equal(calls.filter((name) => name === 'browser_screenshot').length, confirmed ? 0 : 1);
    // An unconfirmed click is observed twice more before it is judged.
    assert.equal(calls.filter((name) => name === 'browser_snapshot').length, confirmed ? 3 : 5);
    if (confirmed) {
      assert.equal(result.submission.outcome, 'confirmed');
      assert.equal(result.attachments, undefined);
      assert.equal(result.submission.screenshot, undefined);
    } else {
      assert.equal(result.submission.outcome, 'unknown');
      assert.equal(result.submission.formGone, true);
      assert.deepEqual(result.attachments, [image]);
      assert.match(result.submission.screenshot, /attached image/);
    }
    // The stored run keeps the classification only, never the image.
    assert.equal(f.db.run(run.id).submission.screenshot, undefined);
  }
});

test('a confirmation that renders shortly after the submit click is still recognized', async (t) => {
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  f.db.reserve(f.id, run.id, item.id);
  const calls = [];
  let clicked = false,
    afterClick = 0;
  const browser = {
    currentUrl: async () => item.url,
    call: async (_id, name) => {
      calls.push(name);
      if (name === 'browser_click') clicked = true;
      else if (clicked && name === 'browser_snapshot') afterClick++;
      const page = clicked
        ? {
            url: item.url + '?step=done',
            text:
              afterClick < 2
                ? 'Job Application\nSubmitting…'
                : 'Job Application\nYour application was successfully submitted.',
            fillFields: [{fieldId: 'f1'}],
            clickTargets: [],
          }
        : {
            url: item.url + '?step=form',
            text: 'Job Application',
            fillFields: [{fieldId: 'f1'}],
            clickTargets: [{targetId: 'e1', label: 'Submit application'}],
          };
      return {
        content: [{type: 'text', text: `Page URL: ${page.url}\n${JSON.stringify(page)}`}],
        action: {executed: true},
      };
    },
  };
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: new AbortController().signal,
    submitSettleMs: 0,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  await flow.call(f.id, run.id, 'browser_open', {url: item.url + '?step=form'});
  const result = await flow.call(f.id, run.id, 'browser_interact', {operation: 'click', ref: 'e1'});
  assert.equal(result.submission.outcome, 'confirmed');
  assert.match(result.submission.quote, /successfully submitted/);
  assert.equal(result.attachments, undefined);
  assert.equal(f.db.run(run.id).submission.outcome, 'confirmed');
  // The agent may name the confirmation page without its query string.
  const saved = await flow.call(f.id, run.id, 'record_automation_outcome', {
    status: 'completed',
    evidence: 'Your application was successfully submitted.',
    url: item.url,
  });
  assert.equal(saved.status, 'completed');
});

test('autocomplete text alone asks for the option with exactly that label', async (t) => {
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  const calls = [];
  const browser = {
    currentUrl: async () => item.url,
    call: async (_id, name, args) => {
      calls.push([name, args]);
      const page = {url: item.url, text: 'Job Application', fillFields: [], clickTargets: []};
      return {
        content: [{type: 'text', text: `Page URL: ${page.url}\n${JSON.stringify(page)}`}],
        action: {executed: true},
      };
    },
  };
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  await flow.call(f.id, run.id, 'browser_open', {url: item.url});
  await flow.call(f.id, run.id, 'browser_interact', {
    operation: 'autocomplete',
    ref: 'c1',
    text: 'Yes',
  });
  await flow.call(f.id, run.id, 'browser_interact', {operation: 'autocomplete', ref: 'c2'});
  const sent = calls
    .filter(([name]) => name.includes('suggestions') || name.includes('autocomplete'))
    .map(([name, {controlId, text, option}]) => [
      name,
      Object.fromEntries(
        Object.entries({controlId, text, option}).filter(([, v]) => v !== undefined),
      ),
    ]);
  assert.deepEqual(sent, [
    ['browser_autocomplete', {controlId: 'c1', text: 'Yes', option: 'Yes'}],
    ['browser_list_suggestions', {controlId: 'c2'}],
  ]);
});

test('a CAPTCHA after the submit click asks the user to solve it before reporting the outcome', async (t) => {
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  f.db.reserve(f.id, run.id, item.id);
  let clicked = false;
  const browser = {
    currentUrl: async () => item.url,
    call: async (_id, name) => {
      if (name === 'browser_click') clicked = true;
      const page = clicked
        ? {
            url: item.url,
            text: 'Job Application\nPlease verify you are human',
            verification: {state: 'required', evidence: 'hCaptcha challenge is visible.'},
            fillFields: [{fieldId: 'f1'}],
            clickTargets: [{targetId: 'e1', label: 'Submit application'}],
          }
        : {
            url: item.url,
            text: 'Job Application',
            fillFields: [{fieldId: 'f1'}],
            clickTargets: [{targetId: 'e1', label: 'Submit application'}],
          };
      return {
        jevPage: page,
        content: [{type: 'text', text: `Page URL: ${page.url}\n${JSON.stringify(page)}`}],
        action: {executed: true},
      };
    },
  };
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: new AbortController().signal,
    submitSettleMs: 0,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  await flow.call(f.id, run.id, 'browser_open', {url: item.url});
  const result = await flow.call(f.id, run.id, 'browser_interact', {operation: 'click', ref: 'e1'});
  assert.equal(result.submission.verification, 'hCaptcha challenge is visible.');
  assert.match(result.submission.guidance, /CAPTCHA/);
  await flow.call(f.id, run.id, 'record_automation_outcome', {
    status: 'uncertain',
    evidence: 'A CAPTCHA appeared after the click.',
    url: item.url,
  });
  await flow.call(f.id, run.id, 'finish_automation_run', {
    status: 'blocked',
    summary: 'Submitted once; a CAPTCHA is shown.',
    blocker: {
      category: 'verification',
      reason: 'A CAPTCHA appeared after the submit click.',
      userAction: 'Solve the CAPTCHA on the open tab',
    },
  });
  const question = f.db.get(f.id).questions.find((q) => q.recordId === item.id && q.outcome);
  assert.match(question.text, /Solve it/);
  assert.equal(
    question.fields[0].label,
    'After solving the verification: was this record submitted?',
  );
});

test('a code sent by email after the submit click asks the user to enter it', async (t) => {
  const {recordOperationStatus} = await import('../src/record-operation-status.js');
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  f.db.reserve(f.id, run.id, item.id);
  const page = {
    url: item.url,
    text: 'Job Application',
    fillFields: [{fieldId: 'f1'}],
    clickTargets: [{targetId: 'e1', label: 'Submit application'}],
  };
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: new AbortController().signal,
    submitSettleMs: 0,
    browser: {
      currentUrl: async () => item.url,
      call: async () => ({
        jevPage: page,
        content: [{type: 'text', text: `Page URL: ${page.url}\n${JSON.stringify(page)}`}],
        action: {executed: true},
      }),
    },
    report: (...args) => f.runtime.report(...args),
  });
  await flow.call(f.id, run.id, 'browser_open', {url: item.url});
  await flow.call(f.id, run.id, 'record_automation_outcome', {
    status: 'uncertain',
    evidence: 'An 8-box security code step appeared after the click.',
    url: item.url,
  });
  await flow.call(f.id, run.id, 'finish_automation_run', {
    status: 'blocked',
    summary: 'Submitted once; the site asks for a security code sent by email.',
    blocker: {
      category: 'needs_code',
      reason: 'The site sent a security code to the user’s email.',
      userAction: 'Enter the code on the open tab',
    },
  });
  const question = f.db.get(f.id).questions.find((q) => q.recordId === item.id && q.outcome);
  assert.equal(question.code, true);
  assert.match(question.text, /Enter the code/);
  assert.equal(question.fields[0].label, 'After entering the code: was this record submitted?');
  assert.equal(recordOperationStatus({recordAction: {question}}).label, 'Code to enter');
});

test('a CAPTCHA that renders after the submit result still marks the record as a CAPTCHA to solve', async (t) => {
  const {recordOperationStatus} = await import('../src/record-operation-status.js');
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  f.db.reserve(f.id, run.id, item.id);
  let clicked = false,
    late = false;
  const browser = {
    currentUrl: async () => item.url,
    call: async (_id, name) => {
      if (name === 'browser_click') clicked = true;
      const page = {
        url: item.url,
        text: clicked ? 'Job Application\nSending' : 'Job Application',
        ...(late ? {verification: {state: 'required', evidence: 'hCaptcha checkbox'}} : {}),
        fillFields: [{fieldId: 'f1'}],
        clickTargets: [{targetId: 'e1', label: 'Submit application'}],
      };
      return {
        jevPage: page,
        content: [{type: 'text', text: `Page URL: ${page.url}\n${JSON.stringify(page)}`}],
        action: {executed: true},
      };
    },
  };
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: new AbortController().signal,
    submitSettleMs: 0,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  await flow.call(f.id, run.id, 'browser_open', {url: item.url});
  const result = await flow.call(f.id, run.id, 'browser_interact', {operation: 'click', ref: 'e1'});
  assert.equal(result.submission.verification, undefined);
  late = true;
  await flow.call(f.id, run.id, 'browser_read', {});
  await flow.call(f.id, run.id, 'record_automation_outcome', {
    status: 'uncertain',
    evidence: 'A CAPTCHA appeared after the click.',
    url: item.url,
  });
  await flow.call(f.id, run.id, 'finish_automation_run', {
    status: 'blocked',
    summary: 'Submitted once; a CAPTCHA is shown.',
    blocker: {
      category: 'verification',
      reason: 'A CAPTCHA appeared after the submit click.',
      userAction: 'Solve the CAPTCHA on the open tab',
    },
  });
  const question = f.db.get(f.id).questions.find((q) => q.recordId === item.id && q.outcome);
  assert.equal(question.verification, true);
  assert.match(question.text, /Solve it/);
  const row = f.db.snapshot(f.id).results.find((r) => r.id === item.id);
  assert.equal(recordOperationStatus(row).label, 'CAPTCHA to solve');
});

test('a blocked application needs a short blocker, which the record card shows instead of the summary', async (t) => {
  const {recordProblem} = await import('../src/record-operation-status.js');
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: new AbortController().signal,
    browser: {currentUrl: async () => item.url, call: async () => ({content: []})},
    report: (...args) => f.runtime.report(...args),
  });
  const summary =
    'Not submitted. The listing says worldwide, but the Greenhouse form in tab 12AB asks for US work authorization, which the saved facts deny.';
  await assert.rejects(
    flow.call(f.id, run.id, 'finish_automation_run', {status: 'blocked', summary}),
    /Add blocker/,
  );
  await assert.rejects(
    flow.call(f.id, run.id, 'finish_automation_run', {
      status: 'blocked',
      summary,
      blocker: {category: 'other', reason: 'US only.', userAction: 'Skip this record'},
    }),
    /blocker.category must be one of/,
  );
  await flow.call(f.id, run.id, 'finish_automation_run', {
    status: 'blocked',
    summary,
    blocker: {
      category: 'not_eligible',
      reason: 'The form requires US work authorization; the listing said worldwide.',
      userAction: 'Skip this record',
    },
  });
  await f.runtime.finish(f.id, 'blocked', summary, run.workerId);
  await settle();
  const row = f.db.snapshot(f.id).results.find((r) => r.id === item.id);
  assert.equal(row.recordAction.lastTask.summary, summary);
  assert.deepEqual(recordProblem(row), {
    label: 'Not eligible',
    category: 'not_eligible',
    reason: 'The form requires US work authorization; the listing said worldwide.',
    next: 'Skip this record',
  });
  // Without a blocker (older runs) the card falls back to the summary.
  const legacy = structuredClone(row);
  delete legacy.recordAction.lastTask.blocker;
  assert.deepEqual(recordProblem(legacy), {
    label: 'Operation blocked',
    reason: summary,
  });
});

test('an application blocked by a technical problem is reported with its blocker; one that needs the user is not', async (t) => {
  const f = fixture(t);
  const reported = [];
  f.db.applicationFailed = (run) => reported.push(run);
  f.db.scanFailed = () => assert.fail('an application is not a scan failure');
  const item = await f.prepare();
  const finish = async (blocker) => {
    await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
    await settle();
    const run = f.launches.at(-1);
    const flow = automationWorkflow({
      db: f.db,
      run,
      signal: new AbortController().signal,
      browser: {currentUrl: async () => item.url, call: async () => ({content: []})},
      report: (...args) => f.runtime.report(...args),
    });
    await flow.call(f.id, run.id, 'finish_automation_run', {
      status: 'blocked',
      summary: 'Not submitted.',
      blocker,
    });
    await f.runtime.finish(f.id, 'blocked', 'Not submitted.', run.workerId);
    await settle();
    return run;
  };
  const answer = await finish({
    category: 'needs_answer',
    reason: 'The form asks for the start date.',
    userAction: 'Answer the question',
  });
  assert.equal(f.db.run(answer.id).blocker.category, 'needs_answer');
  assert.deepEqual(reported, []);
  const technical = await finish({
    category: 'technical',
    reason: 'The Next button did not respond to clicks.',
    userAction: 'Retry later',
  });
  assert.equal(reported.length, 1);
  assert.equal(reported[0].id, technical.id);
  assert.equal(reported[0].status, 'blocked');
  assert.equal(reported[0].blocker.reason, 'The Next button did not respond to clicks.');
});

test('a click on the submit button the form inspection found is the submission, also labelled Apply', async (t) => {
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  const page = {
    url: item.url,
    text: 'Job Application',
    fillFields: [{fieldId: 'f1'}],
    clickTargets: [{targetId: 'e1', label: 'Apply'}],
  };
  const browser = {
    currentUrl: async () => item.url,
    call: async (_id, name) =>
      name === 'browser_inspect_form'
        ? {
            url: item.url,
            fields: [{label: 'Email', required: true}],
            uploads: [],
            submitControls: [{label: 'Apply', controlId: 'c9'}],
          }
        : {
            jevPage: page,
            content: [{type: 'text', text: `Page URL: ${page.url}\n${JSON.stringify(page)}`}],
            action: {executed: true},
          },
  };
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: new AbortController().signal,
    submitSettleMs: 0,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  await flow.call(f.id, run.id, 'browser_open', {url: item.url});
  // Before an inspection found a form, "Apply" may open the form: no reservation needed.
  const entry = await flow.call(f.id, run.id, 'browser_interact', {operation: 'click', ref: 'e1'});
  assert.equal(entry.submission, undefined);
  await flow.call(f.id, run.id, 'browser_inspect_form', {});
  await assert.rejects(
    flow.call(f.id, run.id, 'browser_interact', {operation: 'click', ref: 'e1'}),
    /reserve_automation_action/,
  );
  f.db.reserve(f.id, run.id, item.id);
  const result = await flow.call(f.id, run.id, 'browser_interact', {operation: 'click', ref: 'e1'});
  assert.equal(result.submission.label, 'Apply');
  assert.equal(result.submission.outcome, 'unknown');
  assert.equal(f.db.run(run.id).submission.attempts, 1);
});

test('an execute run retires a record whose page says it is gone, only with a quote from that page', async (t) => {
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  const gone = 'The job you are looking for is no longer open';
  const browser = {
    currentUrl: async () => item.url,
    call: async () => ({
      content: [
        {
          type: 'text',
          text: `Page URL: ${item.url}\n${JSON.stringify({url: item.url, text: 'Careers\n' + gone})}`,
        },
      ],
    }),
  };
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: {aborted: false},
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  await flow.call(f.id, run.id, 'browser_open', {url: item.url});
  await assert.rejects(
    flow.call(f.id, run.id, 'record_automation_outcome', {
      status: 'closed',
      evidence: 'This position has been filled already',
    }),
    /quote is not in the current page text/,
  );
  assert.equal(f.db.result(f.id, item.id).status, 'prepared');
  const saved = await flow.call(f.id, run.id, 'record_automation_outcome', {
    status: 'closed',
    evidence: gone,
  });
  assert.equal(saved.status, 'dismissed');
  assert.equal(saved.closed.evidence, gone);
  assert.equal(saved.closed.url, item.url);
  // A closed record lets its execute run finish completed.
  await flow.call(f.id, run.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'The listing is closed.',
  });
  // A reserved (possibly submitted) record can never be closed.
  const f2 = fixture(t);
  const item2 = await f2.prepare();
  await f2.runtime.runRecord(f2.id, item2.id, 'execute', {direct: true});
  await settle();
  const run2 = f2.launches.at(-1);
  f2.db.reserve(f2.id, run2.id, item2.id);
  assert.throws(
    () =>
      f2.db.closeRecord(
        f2.id,
        run2.id,
        item2.id,
        {evidence: gone, url: item2.url},
        {url: item2.url, text: gone},
      ),
    /uncertain/,
  );
  // The listing redirected to another host of the same site is still the record
  // page; a page on a different site is not.
  const f3 = fixture(t);
  const item3 = await f3.prepare();
  await f3.runtime.runRecord(f3.id, item3.id, 'execute', {direct: true});
  await settle();
  const run3 = f3.launches.at(-1),
    listing = new URL(item3.url),
    host = listing.hostname.replace(/^www\./, '');
  assert.throws(
    () =>
      f3.db.closeRecord(
        f3.id,
        run3.id,
        item3.id,
        {evidence: gone, url: item3.url},
        {url: `https://elsewhere.test${listing.pathname}`, text: gone},
      ),
    /observe the record page/,
  );
  const redirected = f3.db.closeRecord(
    f3.id,
    run3.id,
    item3.id,
    {evidence: gone, url: item3.url},
    {url: `https://de.${host}${listing.pathname}/`, text: gone},
  );
  assert.equal(redirected.status, 'dismissed');
});

test('an execute run completes a record whose page says the user already applied, only with a quote from that page', async (t) => {
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  const applied = 'Application submitted 2 weeks ago';
  const browser = {
    currentUrl: async () => item.url,
    call: async () => ({
      content: [
        {
          type: 'text',
          text: `Page URL: ${item.url}\n${JSON.stringify({
            url: item.url,
            text: 'Senior Engineer\nApplication status\nApplication submitted\n2 weeks ago\nNo longer accepting applications',
          })}`,
        },
      ],
    }),
  };
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: {aborted: false},
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  await flow.call(f.id, run.id, 'browser_open', {url: item.url});
  await assert.rejects(
    flow.call(f.id, run.id, 'record_automation_outcome', {
      status: 'applied',
      evidence: 'You applied to this job',
    }),
    /you already applied, copied word for word/,
  );
  // A note around quoted parts needs every quoted part on the page.
  await assert.rejects(
    flow.call(f.id, run.id, 'record_automation_outcome', {
      status: 'applied',
      evidence: 'The page shows "Application submitted" and "You applied on LinkedIn".',
    }),
    /quote is not in the current page text/,
  );
  assert.equal(f.db.result(f.id, item.id).status, 'prepared');
  // Page lines joined with dashes, and a note with quoted page parts, are accepted.
  const note =
    'Application status: "Application status — Application submitted — 2 weeks ago" (job page); page also says "No longer accepting applications".';
  const saved = await flow.call(f.id, run.id, 'record_automation_outcome', {
    status: 'applied',
    evidence: note,
  });
  assert.equal(saved.status, 'completed');
  assert.equal(saved.alreadyApplied.evidence, note);
  await flow.call(f.id, run.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'The user already applied to this listing.',
  });
  // A reserved (possibly submitted) record is never marked applied from the page.
  const f2 = fixture(t);
  const item2 = await f2.prepare();
  await f2.runtime.runRecord(f2.id, item2.id, 'execute', {direct: true});
  await settle();
  const run2 = f2.launches.at(-1);
  f2.db.reserve(f2.id, run2.id, item2.id);
  assert.throws(
    () =>
      f2.db.closeRecord(
        f2.id,
        run2.id,
        item2.id,
        {status: 'applied', evidence: applied, url: item2.url},
        {url: item2.url, text: applied},
      ),
    /uncertain/,
  );
});

test('an application stopped by a shared site wait resumes after the wait, at most twice', async (t) => {
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const wait = (run) =>
    f.db.putRun({
      ...f.db.run(run.id),
      siteWait: {site: 'example.com', retryAt: f.db.now() + 60000, exhausted: false},
      siteWaitBlocked: true,
    });
  let run = f.launches.at(-1);
  const taskId = run.taskId,
    task = () => f.db.store.workspaces.tasks.get(f.id, taskId);
  for (let attempt = 1; attempt <= 2; attempt++) {
    wait(run);
    await f.runtime.finish(f.id, 'blocked', 'Rate limited', run.workerId);
    assert.equal(task().state, 'pending', 'requeued after wait ' + attempt);
    assert.ok(task().retryAt > f.db.now() + 50000);
    assert.equal(task().recordRecovery.siteWaits, attempt);
    // The scheduler starts it again once the wait is over.
    f.db.store.workspaces.tasks.put({...task(), retryAt: f.db.now() - 1});
    await f.runtime.tick();
    await settle();
    run = f.launches.at(-1);
    assert.equal(run.taskId, taskId);
  }
  wait(run);
  await f.runtime.finish(f.id, 'blocked', 'Rate limited', run.workerId);
  assert.equal(task().state, 'blocked');
  assert.equal(f.db.result(f.id, item.id).status, 'prepared');
});

test('a record retry retires the exhausted site wait its last run stopped on, not a newer one', async (t) => {
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const access = f.db.siteAccess,
    url = 'https://example.com/jobs/1',
    exhausted = (blockedAt) =>
      access.save({
        site: 'example.com',
        reason: 'rate_limit',
        attempts: 3,
        blockedAt,
        retryAt: null,
        token: null,
        leaseUntil: 0,
      });
  exhausted(1000);
  let run = f.launches.at(-1);
  f.db.putRun({...f.db.run(run.id), siteWait: access.status(url)});
  await f.runtime.finish(f.id, 'blocked', 'Rate limited', run.workerId);
  // The site failed again after that run: the user's retry is not about this incident.
  exhausted(2000);
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  assert.equal(access.status(url).blockedAt, 2000);
  run = f.launches.at(-1);
  f.db.putRun({...f.db.run(run.id), siteWait: access.status(url)});
  await f.runtime.finish(f.id, 'blocked', 'Rate limited', run.workerId);
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  assert.equal(access.status(url), null);
});

test('a run that read the page after a site wait and stopped for another reason is not requeued', async (t) => {
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  f.db.putRun({
    ...f.db.run(run.id),
    siteWait: {site: 'example.com', retryAt: f.db.now() + 60000, exhausted: false},
    siteWaitBlocked: false,
  });
  await f.runtime.finish(
    f.id,
    'blocked',
    'The listing conflicts with a hard constraint',
    run.workerId,
  );
  const task = f.db.store.workspaces.tasks.get(f.id, run.taskId);
  assert.equal(task.state, 'blocked');
  assert.equal(task.recordRecovery?.siteWaits, undefined);
});

test('a reserved application is never requeued by a site wait', async (t) => {
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1);
  f.db.reserve(f.id, run.id, item.id);
  f.db.putRun({
    ...f.db.run(run.id),
    siteWait: {site: 'example.com', retryAt: f.db.now() + 60000, exhausted: false},
  });
  await f.runtime.finish(f.id, 'blocked', 'Rate limited', run.workerId);
  const task = f.db.store.workspaces.tasks.get(f.id, run.taskId);
  assert.notEqual(task.state, 'pending');
  assert.equal(task.recordRecovery?.siteWaits, undefined);
  assert.equal(f.db.result(f.id, item.id).status, 'uncertain');
});

test('a click that opens a new tab continues the run in that tab', async (t) => {
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1),
    calls = [];
  const page = (url, text) => ({
    content: [{type: 'text', text: `Page URL: ${url}\n${JSON.stringify({url, text})}`}],
    pageContext: {url, tabId: url.endsWith('/apply') ? 'child' : 'main'},
  });
  const browser = {
    currentUrl: async () => item.url,
    call: async (_id, name, args) => {
      calls.push({name, args});
      if (name === 'browser_click')
        return {
          ...page(item.url, 'Listing'),
          action: {status: 'uncertain', executed: true, openedTab: {tabId: 'child'}},
        };
      if (name === 'browser_use_tab') return page(item.url + '/apply', 'Employer form');
      return page(item.url, 'Listing');
    },
  };
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: {aborted: false},
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  await flow.call(f.id, run.id, 'browser_open', {url: item.url});
  const result = await flow.call(f.id, run.id, 'browser_interact', {
    operation: 'click',
    ref: 'e1',
  });
  assert.deepEqual(calls.find((c) => c.name === 'browser_use_tab').args, {tabId: 'child'});
  assert.equal(result.url, item.url + '/apply');
  assert.match(result.action.message, /new tab/);
});

test('a click stopped by a site wait stays the run’s last step after the app reads the page', async (t) => {
  const f = fixture(t);
  const item = await f.prepare();
  await f.runtime.runRecord(f.id, item.id, 'execute', {direct: true});
  await settle();
  const run = f.launches.at(-1),
    siteWait = {site: 'example.test', retryAt: f.db.now() + 60000, exhausted: false};
  const page = (text) => ({
    content: [{type: 'text', text: `Page URL: ${item.url}\n${JSON.stringify({text})}`}],
    pageContext: {url: item.url, tabId: 'main'},
  });
  const browser = {
    currentUrl: async () => item.url,
    call: async (_id, name) =>
      name === 'browser_click'
        ? {...page('Listing'), siteWait, action: {status: 'site_wait', executed: false}}
        : page('Listing'),
  };
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: {aborted: false},
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  await flow.call(f.id, run.id, 'browser_open', {url: item.url});
  const result = await flow.call(f.id, run.id, 'browser_interact', {operation: 'click', ref: 'e1'});
  assert.match(result.siteWaitGuidance, /slow down/);
  assert.equal(f.db.run(run.id).siteWaitBlocked, true);
  // A later read by the agent is a new step that was not stopped.
  await flow.call(f.id, run.id, 'browser_read', {});
  assert.equal(f.db.run(run.id).siteWaitBlocked, false);
});

test('automatic applying needs the minimum score and skips records kept out when switching to Find and apply', async (t) => {
  const f = fixture(t),
    prepared = await f.prepare();
  f.db.put({...f.db.get(f.id), mode: 'auto'});
  const a = {...f.db.get(f.id), criteria: {...f.db.get(f.id).criteria, score_threshold: '80'}},
    assessment = (score) => ({
      score,
      scoringVersion: 4,
      revision: a.revision,
      eligibility: 'verified',
    });
  assert.match(
    recordOperationError(a, {...prepared, assessment: assessment(79)}, 'execute'),
    /below the minimum score/,
  );
  assert.equal(recordOperationError(a, {...prepared, assessment: assessment(80)}, 'execute'), null);
  const kept = {...a, autoApplyAfter: (prepared.createdAt ?? 0) + 1},
    item = {...prepared, assessment: assessment(95)};
  assert.match(recordOperationError(kept, item, 'execute'), /apply it yourself/);
  assert.equal(
    recordOperationError(kept, item, 'execute', {manual: true, digest: item.digest}),
    null,
  );
  assert.equal(
    recordOperationError({...kept, autoApplyAfter: prepared.createdAt}, item, 'execute'),
    null,
  );
});
