import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {automationAttention, dismissAutomationAttention} from '../app/automation/attention.mjs';
import {attentionTabs, recordAttention} from '../src/automation-attention.js';

const source = {
  url: 'https://homes.example/list',
  name: 'Homes',
  enabled: true,
  blocked: true,
  lastResult: 'CAPTCHA kaldı. Açık sekmede doğrulamayı tamamla.',
};
const snapshot = () => ({
  automation: {revision: 1, reviewedRevision: 1, trial: {status: 'passed', revision: 1}},
  sources: [source],
  runs: [],
  activeRuns: [],
});

test('collector failures do not ask for browser tabs, including after run history is pruned', () => {
  const s = snapshot();
  s.runs = [{id: 'collector', sourceUrl: source.url, collector: 'synthetic', status: 'failed'}];
  assert.equal(automationAttention(s)[0].browserRequired, false);
  s.runs = [];
  s.sources = [{...source, scan: {collector: 'site-collector-review-v1'}}];
  assert.equal(automationAttention(s)[0].browserRequired, false);
  s.sources = [source];
  assert.equal(automationAttention(s)[0].browserRequired, true);
});

test('a budget or rate-limit wait that resumes by itself asks for no attention', () => {
  const s = snapshot();
  const waiting = (reason, extra = {}) => ({
    ...source,
    siteWait: {site: 'homes.example', reason, waiting: true, retryAt: 5000, ...extra},
  });
  for (const reason of ['budget', 'rate_limit']) {
    s.sources = [waiting(reason)];
    assert.deepEqual(automationAttention(s), [], reason);
  }
  s.sources = [waiting('verification')];
  assert.equal(automationAttention(s).length, 1, 'a check the user can solve still asks');
  s.sources = [waiting('rate_limit', {exhausted: true})];
  assert.equal(automationAttention(s).length, 1, 'retries that ran out still ask');
  // The wait has ended and the source waits for its next turn on the site.
  s.sources = [{...source, lastRunId: 'scan', lastResult: 'shared wait … Resumes automatically'}];
  s.runs = [
    {
      id: 'scan',
      sourceUrl: source.url,
      status: 'blocked',
      siteWait: {site: 'homes.example', reason: 'budget', waiting: true, retryAt: 5000},
    },
  ];
  assert.deepEqual(automationAttention(s), [], 'an ended budget wait resumes on its own');
  s.runs[0].siteWait = {...s.runs[0].siteWait, reason: 'verification'};
  assert.equal(automationAttention(s).length, 1, 'a check the run hit still asks');
});

test('conversation forms stay distinct from source and record questions during concurrent work', () => {
  const s = snapshot();
  s.sources = [];
  s.runs = [
    {id: 'chat', kind: 'interview', startedAt: 100},
    {id: 'scan', kind: 'run', startedAt: 100, sourceUrl: 'https://source.example'},
  ];
  s.automation.questions = [
    {id: 'chat-form', runId: 'chat', text: 'Puanlama tercihleri', createdAt: 200, answer: null},
    {id: 'old-chat-form', conversation: true, text: 'Tercihler', answer: null},
    {
      id: 'source-question',
      runId: 'scan',
      sourceUrl: 'https://source.example',
      text: 'Kaynak sorusu',
      createdAt: 200,
      answer: null,
    },
    {
      id: 'record-question',
      conversation: true,
      recordId: 'record',
      text: 'Kayıt sorusu',
      answer: null,
    },
  ];
  assert.deepEqual(
    automationAttention(s).map((i) => [i.id, i.conversation]),
    [
      ['chat-form', true],
      ['old-chat-form', true],
      ['source-question', false],
      ['record-question', false],
    ],
  );
});

test('question cards keep the exact tab across login redirects and history pruning', () => {
  const s = snapshot();
  s.sources = [];
  s.automation.questions = [
    {
      id: 'question',
      text: 'Log in',
      answer: null,
      recordId: 'record',
      browserContext: {tabId: 'login', url: 'https://homes.example/login'},
    },
  ];
  const [issue] = automationAttention(s);
  const tabs = [
    {tabId: 'another', url: 'https://homes.example/login'},
    {tabId: 'login', url: 'https://homes.example/application'},
  ];
  assert.deepEqual(attentionTabs(issue, tabs, []), [tabs[1]]);
  assert.equal(issue.kind, 'question');
  assert.equal(issue.tabId, 'login');
});

test('questions save their observed tab and old questions recover it from durable runs', (t) => {
  const store = new WorkspaceDatabase(':memory:');
  t.after(() => store.close());
  let now = 1000;
  const db = new AutomationStore(store, {now: () => now});
  const a = db.create('custom', {goal: 'Find records'}),
    run = db.begin(a.id, 'interview');
  db.observe(a.id, run.id, 'https://homes.example/login', 'Sign in', [], {tabId: 'login'});
  const q = db.askQuestion(a.id, {text: 'Did you sign in?'}, {runId: run.id});
  assert.equal(q.browserContext.tabId, 'login');
  now = 2000;
  db.finish(a.id, run.id, 'completed', 'Waiting');
  db.put({...db.get(a.id), questions: [{...q, browserContext: undefined}]});
  const old = db.questionContext(a.id, db.get(a.id).questions[0]);
  assert.equal(old.browserContext.tabId, 'login');
  const [issue] = automationAttention({...db.snapshot(a.id), runs: []});
  assert.equal(issue.tabId, 'login');
});

test('skipping a failed trial clears its prompt while source blockers remain actionable', () => {
  const s = snapshot();
  s.automation.trial.status = 'skipped';
  assert.equal(automationAttention(s)[0].retry, 'source');
  s.sources = [];
  s.runs = [
    {id: 'trial', kind: 'trial', status: 'blocked', revision: 1, summary: 'Access unavailable'},
  ];
  assert.deepEqual(automationAttention(s), []);
  s.automation.trial.revision = 0;
  assert.equal(automationAttention(s)[0].retry, 'trial');
});

test('blocked trials retain the worker that should receive the reply', () => {
  const s = snapshot();
  s.sources = [];
  s.runs = [
    {
      id: 'trial',
      kind: 'trial',
      status: 'blocked',
      revision: 1,
      summary: 'Doğrulama gerekiyor',
      workerId: 'second',
    },
  ];
  const [issue] = automationAttention(s);
  assert.equal(issue.retry, 'trial');
  assert.equal(issue.workerId, 'second');
});

test('a blocked source stays visible beside working sources, and disappears only after retry or disable', () => {
  const s = snapshot();
  s.sources.push({...source, url: 'https://other.example', blocked: false, scanning: true});
  s.activeRuns = [{id: 'other-run'}];
  const [issue] = automationAttention(s);
  assert.equal(issue.retry, 'source');
  assert.equal(issue.sourceUrl, source.url);
  assert.equal(automationAttention(s).length, 1);
  for (const patch of [{enabled: false}, {blocked: false}, {scanning: true}])
    assert.equal(automationAttention({...s, sources: [{...source, ...patch}]}).length, 0);
  assert.equal(automationAttention(s)[0].browserRequired, true);
  s.sources[0] = {...source, extension: {kind: 'http'}};
  assert.equal(
    automationAttention(s)[0].browserRequired,
    false,
    'A source read by its HTTP reader has no tab to show',
  );
  s.sources[0] = {...source, extension: {kind: 'http'}, blocker: {tabId: 'tab'}};
  assert.equal(automationAttention(s)[0].browserRequired, true);
  s.sources[0] = source;
  s.results = [{id: 'r', sourceUrl: source.url, status: 'uncertain'}];
  assert.equal(
    automationAttention(s)[0].retry,
    'source',
    'A record with an unclear outcome does not stop a new scan of its source',
  );
  s.sources[0] = {...source, blocker: {recordId: 'record'}};
  assert.equal(
    automationAttention(s)[0].retry,
    null,
    'Do not offer to resend an uncertain record action',
  );
});

test('closing an intervention persists across restart without changing work and a new failure appears again', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'loop-attention-')),
    file = path.join(directory, 'db.sqlite');
  let store = new WorkspaceDatabase(file),
    db = new AutomationStore(store);
  t.after(async () => {
    store.close();
    await rm(directory, {recursive: true, force: true});
  });
  const other = 'https://other.example/list',
    a = db.create('custom', {goal: 'Find records', sources: [source.url, other]});
  const state = {
    blocked: true,
    lastRunId: 'first',
    lastRunAt: 100,
    lastStatus: 'blocked',
    lastResult: source.lastResult,
    nextRunAt: null,
    blocker: {recordId: 'uncertain', tabId: 'tab'},
  };
  db.put({
    ...db.get(a.id),
    sourceState: {[source.url]: state, [other]: {...state, lastRunId: 'other'}},
  });
  const before = db.get(a.id),
    [issue] = automationAttention(db.snapshot(a.id));
  assert.equal(issue.retry, null);
  assert.deepEqual(dismissAutomationAttention(db, a.id, issue.id, issue.dismissKey), {
    dismissed: true,
  });
  assert.deepEqual(db.get(a.id).sourceState, before.sourceState);
  assert.equal(db.get(a.id).status, before.status);
  assert.deepEqual(
    automationAttention(db.snapshot(a.id)).map((i) => i.id),
    [other],
  );
  store.close();
  store = new WorkspaceDatabase(file);
  db = new AutomationStore(store);
  assert.deepEqual(
    automationAttention(db.snapshot(a.id)).map((i) => i.id),
    [other],
  );
  db.put({
    ...db.get(a.id),
    sourceState: {
      ...before.sourceState,
      [source.url]: {...state, lastRunId: 'second', lastRunAt: 200},
    },
  });
  assert.deepEqual(
    automationAttention(db.snapshot(a.id)).map((i) => i.id),
    [source.url, other],
  );
  assert.throws(() => dismissAutomationAttention(db, a.id, issue.id, issue.dismissKey), /changed/);
});

test('closing a card cannot dismiss a question, a scheduled retry, or another workspace incident', (t) => {
  const store = new WorkspaceDatabase(':memory:');
  t.after(() => store.close());
  const db = new AutomationStore(store);
  const a = db.create('custom', {goal: 'Find records', sources: [source.url]}),
    other = db.create('custom');
  db.put({
    ...db.get(a.id),
    sourceState: {[source.url]: {blocked: true, lastResult: source.lastResult}},
  });
  const [issue] = automationAttention(db.snapshot(a.id));
  assert.throws(
    () => dismissAutomationAttention(db, other.id, issue.id, issue.dismissKey),
    /can no longer be dismissed/,
  );
  const question = db.askQuestion(a.id, {text: 'Choose a location'});
  assert.throws(
    () => dismissAutomationAttention(db, a.id, question.id, undefined),
    /can no longer be dismissed/,
  );
  db.put({...db.get(a.id), retryPlan: {[source.url]: {at: Date.now() + 7200000}}});
  assert.throws(
    () => dismissAutomationAttention(db, a.id, issue.id, issue.dismissKey),
    /can no longer be dismissed/,
  );
  assert.equal(db.get(a.id).dismissedAttention, undefined);
  assert.equal(db.get(a.id).questions[0].answer, null);
});

test('tab focus prefers the saved current URL and never guesses among multiple source tabs', () => {
  const s = snapshot(),
    issue = {
      ...automationAttention(s)[0],
      tabId: 'retained',
      url: 'https://homes.example/detail/2',
    };
  const retained = {tabId: 'retained', url: issue.url, sourceUrl: source.url},
    other = {tabId: 'other', url: 'https://homes.example/detail/3', sourceUrl: source.url};
  assert.deepEqual(attentionTabs(issue, [other, retained], s.sources), [retained]);
  assert.deepEqual(
    attentionTabs(issue, [{...retained, url: 'https://foreign.example'}], s.sources),
    [{...retained, url: 'https://foreign.example'}],
    'Saved source can redirect to an auth page',
  );
  assert.deepEqual(
    attentionTabs({...issue, tabId: null, url: null}, [other, retained], s.sources),
    [other, retained],
  );
  assert.deepEqual(
    attentionTabs(issue, [{tabId: 'foreign', url: 'https://foreign.example'}], s.sources),
    [],
  );
});

test('browser checkpoint survives a blocked report and recent run history pruning', async (t) => {
  const store = new WorkspaceDatabase(':memory:');
  t.after(() => store.close());
  const db = new AutomationStore(store);
  const a = db.create('housing', {
    goal: 'Find homes',
    criteria: {location: 'Berlin', budget: '2000', requirements: '2 rooms'},
    sources: [source.url],
  });
  db.review(a.id);
  let run = db.begin(a.id, 'trial');
  db.observe(a.id, run.id, source.url, 'Actual listings');
  db.finish(a.id, run.id, 'completed', 'Ready');
  db.enable(a.id);
  const task = store.workspaces.tasks.enqueue(a.id, {
    operation: 'scan',
    capability: 'browser.observe',
    sources: [source.url],
    sourceUrl: source.url,
    lockKey: 'source:' + source.url,
  });
  run = db.begin(a.id, {kind: 'run', taskId: task.id});
  const url = 'https://homes.example/detail/2',
    flow = automationWorkflow({
      db,
      run,
      signal: new AbortController().signal,
      browser: {
        async call() {
          return {
            pageContext: {tabId: 'captcha-tab', url},
            content: [{type: 'text', text: `Page URL: ${url}\nHuman verification required`}],
          };
        },
      },
      report: (id, runId, status, summary) => db.finish(id, runId, status, summary),
    });
  await flow.call(a.id, run.id, 'browser_read', {});
  await flow.call(a.id, run.id, 'finish_automation_run', {
    status: 'blocked',
    summary: source.lastResult,
    stop: {kind: 'access', evidence: 'Human verification required'},
  });
  const s = db.snapshot(a.id),
    [issue] = automationAttention({...s, runs: []});
  assert.equal(issue.tabId, 'captcha-tab');
  assert.equal(issue.url, url);
  assert.equal(issue.workerId, 'main');
  assert.equal(issue.retry, 'source');
  assert.equal(db.get(a.id).status, 'enabled', 'Other sources keep running');
});

test('a repeated scan tool error is technical even when the run was reported blocked', () => {
  const s = snapshot();
  s.sources = [{...source, lastRunId: 'failed-tool'}];
  s.runs = [
    {
      id: 'failed-tool',
      sourceUrl: source.url,
      status: 'blocked',
      toolFailure: {tool: 'report_scan_page', message: 'arguments.evidence: too long'},
    },
  ];
  assert.equal(automationAttention(s)[0].kind, 'technical');
  assert.equal(automationAttention(s)[0].retry, 'source');
  s.sources[0] = {...s.sources[0], blocker: {stop: {kind: 'technical', evidence: 'Too long'}}};
  s.runs = [];
  assert.equal(
    automationAttention(s)[0].kind,
    'technical',
    'persisted technical stop survives pruned run history',
  );
  s.sources[0].accessRecovery = {state: 'waiting', runId: 'access', retryAt: 123};
  assert.equal(
    automationAttention(s)[0].kind,
    'site_access',
    'real access recovery retains its distinct controls',
  );
});

test('records waiting on the user reach a sidebar page; other stopped records do not', () => {
  const blocker = {
    category: 'needs_login',
    reason: 'The form needs an account.',
    userAction: 'Log in',
  };
  const record = (id, extra) => ({id, title: id, status: 'prepared', updatedAt: 1, ...extra});
  const results = [
    record('stopped', {
      recordAction: {lastTask: {kind: 'execute', state: 'blocked', at: 2, blocker}},
    }),
    record('unclear', {
      status: 'uncertain',
      recordAction: {
        lastTask: {kind: 'execute', state: 'completed', at: 2, summary: 'No confirmation.'},
      },
    }),
    record('ineligible', {
      recordAction: {
        lastTask: {
          kind: 'execute',
          state: 'blocked',
          at: 2,
          blocker: {...blocker, category: 'not_eligible'},
        },
      },
    }),
    record('failed', {
      recordAction: {lastTask: {kind: 'execute', state: 'failed', at: 2, summary: 'Form error'}},
    }),
    record('asked', {
      recordAction: {
        question: {text: 'Salary?'},
        lastTask: {kind: 'execute', state: 'blocked', at: 2},
      },
    }),
    record('repeated', {
      recordAction: {
        lastTask: {
          kind: 'execute',
          state: 'failed',
          at: 2,
          summary: 'Tool failed',
          toolFailure: {runId: 'r'},
        },
      },
    }),
    record('skipped', {
      status: 'dismissed',
      recordAction: {lastTask: {kind: 'execute', state: 'blocked', at: 2}},
    }),
    record('trial', {
      trial: true,
      recordAction: {lastTask: {kind: 'execute', state: 'blocked', at: 2}},
    }),
  ];
  const issues = automationAttention({
    automation: {},
    sources: [],
    runs: [],
    activeRuns: [],
    results,
  });
  assert.deepEqual(
    issues.map((i) => i.recordId),
    ['repeated'],
    'a repeated tool error already has its own card',
  );
  assert.deepEqual(recordAttention({results}, issues), [
    {
      id: 'record-problem:stopped',
      kind: 'record_problem',
      recordId: 'stopped',
      name: 'stopped',
      label: 'Login needed',
      message: 'The form needs an account.',
      next: 'Log in',
      canDismissRecord: true,
    },
    {
      id: 'record-problem:unclear',
      kind: 'record_problem',
      recordId: 'unclear',
      name: 'unclear',
      label: 'Outcome needs verification',
      message: 'No confirmation.',
      next: undefined,
      canDismissRecord: true,
    },
  ]);
});
