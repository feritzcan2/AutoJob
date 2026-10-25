import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {runJevTask, jevDetailItems} from '../app/jev/tasks.mjs';
import {jevTaskSummary, jevTaskReceipt, jevContextTasks} from '../app/jev/task-summary.mjs';

test('continuation receipts keep progress and errors without replaying collected listings', () => {
  const summary = {
    taskId: 'task',
    operation: 'collect_details',
    status: 'continue',
    total: 20,
    classified: 6,
    usage: {calls: 10},
    items: Array.from({length: 10}, (_, n) => ({
      url: 'https://example.test/' + n,
      evidenceId: 'e' + n,
    })),
    offset: 0,
    nextOffset: 10,
    issue: null,
    next: 'Continue with taskId.',
  };
  const receipt = jevTaskReceipt(summary);
  assert.equal(receipt.items, undefined);
  assert.equal(receipt.index.total, 20);
  assert.equal(receipt.classified, 6);
  assert.deepEqual(receipt.usage, summary.usage);
  assert.equal(summary.items.length, 10);
  const partial = {...summary, status: 'needs_agent', issue: {reason: 'detail_unavailable'}};
  assert.deepEqual(
    jevTaskReceipt(partial),
    partial,
    'partial successes remain reviewable at a handoff',
  );
  const barrier = jevTaskReceipt({...partial, issue: {reason: 'access_barrier'}});
  assert.equal(barrier.items, undefined);
  assert.equal(barrier.total, 20);
  assert.equal(barrier.issue.reason, 'access_barrier');
});
test('oversized index requests remain bounded and keep their next offset', () => {
  const task = {
    id: 'task',
    input: {operation: 'collect_details'},
    status: 'continue',
    items: Array.from({length: 40}, (_, n) => ({url: 'https://example.test/' + n})),
    answers: {},
  };
  const page = jevTaskSummary(task, {limit: 100});
  assert.equal(page.items.length, 20);
  assert.equal(page.nextOffset, 20);
  assert.throws(() => jevTaskSummary(task, {limit: -1}), /Invalid/);
});
import {askJev, jevProvider} from '../app/jev/policy.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {jevDetailKey} from '../app/jev/detail-urls.mjs';

const url = 'https://example.test/list';
// A card is asked what it opens (listing/other/uncertain) and whether it fits
// (keep or an exclusion). One-answer mocks map onto whichever question it is.
const pick = (choice, criteria) =>
  Object.hasOwn(criteria, choice)
    ? choice
    : Object.hasOwn(criteria, 'keep')
      ? 'keep'
      : Object.hasOwn(criteria, 'listing') &&
          ['hard_constraint', 'qualification', 'unrelated_role'].includes(choice)
        ? 'listing'
        : choice;
const answer = (choice, criteria, confidence = 1) => (
  (choice = pick(choice, criteria)),
  {
    choice,
    confidence,
    probabilities: Object.fromEntries(Object.keys(criteria).map((k) => [k, k === choice ? 1 : 0])),
  }
);
function fixture(t) {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('housing', {
    goal: 'Berlin homes',
    criteria: {location: 'Berlin', budget: '2000', requirements: '2 rooms'},
    sources: [url],
    agentSettings: {provider: 'codex', decisions: 'jev'},
  });
  db.save(a.id, {browserMode: 'jev'});
  db.review(a.id);
  const controller = new AbortController(),
    calls = [],
    ports = {
      authorize: async () => {},
      assertActive: () => {},
      searchId: 'default',
      browser: async (name, args) => {
        calls.push({name, args});
        return {
          url: args.url ?? url,
          title: 'Homes',
          text: 'Final page',
          links: [],
          pagination: [],
        };
      },
      evaluate: async (state, questions) => ({
        answers: Object.fromEntries(
          Object.entries(questions).map(([key, q]) => [
            key,
            answer(key === 'next' ? 'end' : key === 'fit' ? 'possible' : 'listing', q.criteria),
          ]),
        ),
        usage: {input_tokens: 100, output_tokens: 10},
      }),
    };
  const run = (input, extras = {}) =>
    runJevTask({
      store: db.jevTasks,
      owner: a.id,
      taskId: 'assigned',
      input,
      ports,
      criteria: a.criteria,
      signal: controller.signal,
      ...extras,
    });
  return {core, db, a, ports, calls, run, controller};
}

test('source detail recovery observes once, then reopens once, without classifying loading pages', async (t) => {
  for (const successfulAttempt of [2, 3]) {
    const f = fixture(t),
      actions = [];
    f.ports.recoverDetails = true;
    f.ports.resolveDetails = () => [{url}];
    f.ports.browser = async (action) => {
      actions.push(action);
      return {
        url,
        text: actions.length === successfulAttempt ? 'Complete listing' : '',
        status: actions.length === successfulAttempt ? 'ready' : 'loading',
      };
    };
    const result = await f.run({operation: 'collect_details'});
    assert.equal(result.status, 'completed');
    assert.equal(result.usage.calls, 1);
    assert.deepEqual(actions, ['open', 'observe', 'reopen'].slice(0, successfulAttempt));
  }
});

test('bounded detail failures defer in RAM while good details continue and fresh helpers respect the wait', async (t) => {
  const f = fixture(t),
    bad = url + '/loading',
    good = url + '/ready',
    actions = [];
  f.ports.recoverDetails = true;
  f.ports.resolveDetails = () => [{url: bad}, {url: good}];
  f.ports.browser = async (action, args) => {
    actions.push([action, args.url]);
    return {
      url: args.url,
      text: args.url === good ? 'Complete listing' : '',
      status: args.url === good ? 'ready' : 'loading',
    };
  };
  let result = await f.run({operation: 'collect_details'});
  assert.equal(result.issue.reason, 'detail_unavailable');
  assert.equal(result.usage.calls, 1);
  assert.equal(actions.length, 4);
  assert.ok(result.items[0].retryAt > Date.now());
  assert.ok(result.items[1].evidenceId);
  f.ports.resolveDetails = () => [{url: bad}];
  result = await f.run({operation: 'collect_details'});
  assert.equal(result.issue.reason, 'detail_unavailable');
  assert.equal(result.usage.calls, 0);
  assert.equal(actions.length, 4);
  assert.equal(f.db.jevTasks.detailWait(f.a.id, 'other', bad), null);
  assert.equal(f.db.jevTasks.detailWait('other', 'assigned', bad), null);
  assert.ok(f.db.jevTasks.detailWait(f.a.id, 'assigned', bad + '?utm_source=alias'));
  f.db.jevTasks.now = () => Date.now() + 300001;
  assert.equal(f.db.jevTasks.detailWait(f.a.id, 'assigned', bad), null);
});

test('recovery never captures another page if the read tab moved before observation', async (t) => {
  const f = fixture(t),
    actions = [];
  f.ports.recoverDetails = true;
  f.ports.resolveDetails = () => [{url}];
  f.ports.browser = async (action) => {
    actions.push(action);
    return action === 'open'
      ? {url, text: '', status: 'loading'}
      : action === 'observe'
        ? {url: 'https://foreign.test/role', text: 'Wrong listing'}
        : {url, text: 'Correct listing'};
  };
  const result = await f.run({operation: 'collect_details'});
  assert.deepEqual(actions, ['open', 'observe', 'reopen']);
  assert.equal(result.usage.calls, 1);
  assert.equal(
    f.db.jevTasks.fullEvidence(f.a.id, 'assigned', result.items[0].evidenceId).text,
    'Correct listing',
  );
});

test('a barrier skips its host and final small groups still require review before handoff', async (t) => {
  const f = fixture(t),
    blocked = ['https://blocked.test/1', 'https://blocked.test/2'],
    good = 'https://good.test/role',
    opened = [];
  f.ports.recoverDetails = true;
  f.ports.reviewFinalBatch = true;
  f.ports.resolveDetails = () => [...blocked, good].map((url) => ({url}));
  f.ports.browser = async (action, args) => {
    opened.push(args.url);
    return args.url === good
      ? {url: good, text: 'Complete listing'}
      : {
          url: args.url,
          status: 'site_wait',
          siteWait: {site: 'blocked.test', retryAt: Date.now() + 300000},
        };
  };
  f.ports.reviewBatch = async () => {};
  const result = await f.run({operation: 'collect_details'});
  assert.equal(result.issue.reason, 'batch_ready');
  assert.equal(result.batch.total, 1);
  assert.equal(result.usage.calls, 1);
  assert.deepEqual(opened, [blocked[0], good]);
  assert.equal(result.batch.id.length, 8, 'a short id a weak agent copies correctly');
  await assert.rejects(
    f.run({taskId: result.taskId, reviewedBatchId: 'wrong-id', review: []}),
    (e) => e.message.includes(`reviewedBatchId: ${result.batch.id}`),
  );
  const next = await f.run({
    taskId: result.taskId,
    reviewedBatchId: result.batch.id,
    review: [{url: good, decision: 'reject', reason: 'Unrelated role'}],
  });
  assert.equal(next.issue.reason, 'access_barrier');
  assert.deepEqual(next.issue.sites, ['blocked.test']);
  f.ports.resolveDetails = () => [{url: 'https://blocked.test/new'}];
  const retry = await f.run({operation: 'collect_details'});
  assert.equal(retry.issue.reason, 'access_barrier');
  assert.equal(opened.length, 2);
  f.db.jevTasks.release(f.a.id, 'assigned');
  assert.equal(f.db.jevTasks.detailWait(f.a.id, 'assigned', blocked[0]), null);
});

test('highlight and tracking variants share a read while job parameters and SPA routes remain distinct', async (t) => {
  const f = fixture(t),
    original = url + '/role?job=1',
    alias = original + '&utm_source=search#:~:text=Responsibilities';
  const urls = [original, alias, url + '/role?job=2', url + '#/jobs/1', url + '#/jobs/2'];
  f.ports.resolveDetails = () => urls.map((url) => ({url}));
  let result = await f.run({operation: 'collect_details'});
  while (result.status === 'continue') result = await f.run({taskId: result.taskId});
  assert.equal(result.total, 4);
  assert.equal(result.usage.calls, 4);
  assert.deepEqual(
    f.calls.map((c) => c.args.url),
    [original, ...urls.slice(2)],
  );
  assert.equal(jevDetailKey(original), jevDetailKey(alias));
  assert.notEqual(jevDetailKey(url + '#/jobs/1'), jevDetailKey(url + '#/jobs/2'));
  const task = f.db.jevTasks.get(f.a.id, 'assigned', result.taskId);
  assert.deepEqual(task.items[0].aliases, [original, alias]);
  assert.throws(
    () => jevDetailItems({urls: [alias]}, {observedUrls: [original]}),
    /observed/,
    'Deduplication never authorizes an unobserved navigation URL',
  );
});

test('discovery evaluates a highlighted link once and retains its observed navigation address', async (t) => {
  const f = fixture(t),
    job = url + '/job',
    alias = job + '#:~:text=Original';
  f.ports.browser = async () => ({
    url,
    text: 'Last page',
    links: [
      {url: job, text: 'Job'},
      {url: alias, text: 'Job highlight'},
    ],
  });
  let links = 0;
  f.ports.evaluate = async (state, questions) => {
    links += Object.keys(state.links ?? {}).length;
    return {
      answers: Object.fromEntries(
        Object.entries(questions).map(([key, q]) => [
          key,
          answer(key === 'next' ? 'end' : 'listing', q.criteria),
        ]),
      ),
    };
  };
  const result = await f.run({operation: 'scan_results', url});
  assert.equal(result.total, 1);
  assert.equal(links, 1);
  assert.equal(result.items[0].url, job);
});

test('results boards classified by Jev never enter listing review batches', async (t) => {
  const f = fixture(t),
    boards = [
      'https://search.example/results?q=Berlin',
      'https://boards.example/company-a?department=EMEA',
      'https://boards.example/company-b?location=Berlin',
    ];
  f.ports.resolveDetails = () => [...boards, url + '/listing'].map((url) => ({url}));
  f.ports.evaluate = async (state, questions) => ({
    answers: Object.fromEntries(
      Object.entries(questions).map(([key, q]) => [
        key,
        answer(
          key === 'fit' && boards.includes(state.listing?.url)
            ? 'results'
            : key === 'fit'
              ? 'possible'
              : 'listing',
          q.criteria,
        ),
      ]),
    ),
    usage: {input_tokens: 1, output_tokens: 1},
  });
  const result = await f.run({operation: 'collect_details'});
  assert.equal(result.status, 'needs_agent');
  assert.equal(result.issue.reason, 'discovery_required');
  assert.equal(result.classified, 1);
  assert.equal(result.resultsPages, 3);
  assert.deepEqual(result.issue.urls, boards);
  assert.deepEqual(
    f.calls.map((call) => call.args.url),
    [...boards, url + '/listing'],
  );
  assert.equal(result.usage.calls, 4);
});

test('a listing redirect to a results board is deferred by classification, not by its address', async (t) => {
  const f = fixture(t);
  f.ports.resolveDetails = () => [{url: url + '/closed-role'}];
  f.ports.browser = async () => ({
    url: 'https://boards.example/company',
    text: 'Multiple jobs',
    title: 'Company careers',
  });
  f.ports.evaluate = async (state, questions) => ({
    answers: Object.fromEntries(
      Object.entries(questions).map(([key, q]) => [
        key,
        answer(key === 'fit' ? 'results' : 'listing', q.criteria),
      ]),
    ),
    usage: {input_tokens: 1, output_tokens: 1},
  });
  const result = await f.run({operation: 'collect_details'});
  assert.equal(result.resultsPages, 1);
  assert.equal(result.classified, 0);
  assert.equal(result.usage.calls, 1);
  assert.equal(result.issue.reason, 'discovery_required');
});

test('scan -> details -> preliminary classification retains originals and uncertain links', async (t) => {
  const f = fixture(t);
  let current = url;
  f.ports.browser = async (name, args) => {
    if (args.url) current = args.url;
    return current === url
      ? {
          url,
          title: 'Homes',
          text: 'Last page',
          links: [
            {url: url + '/1', text: 'One'},
            {url: url + '/2', text: 'Two'},
          ],
        }
      : {url: current, title: 'Home', text: 'Berlin, two rooms, rent 1500. '.repeat(300)};
  };
  const scan = await f.run({operation: 'scan_results', url});
  assert.equal(scan.status, 'completed');
  assert.equal(scan.total, 2);
  const details = await f.run({operation: 'collect_details', fromTaskId: scan.taskId});
  assert.equal(details.status, 'completed');
  assert.equal(details.usage.calls, 2);
  const classified = await f.run({operation: 'classify_results', fromTaskId: details.taskId});
  assert.equal(classified.status, 'completed');
  assert.equal(classified.items[0].assessment.decision, 'possible');
  const evidence = f.db.jevTasks.readEvidence(f.a.id, 'assigned', details.items[0].evidenceId);
  assert.equal(evidence.text.length, 6000);
  assert.equal(evidence.nextOffset, 6000);
  assert.ok(!JSON.stringify(details).includes('rent 1500'));
  assert.ok(JSON.stringify(details).length < 2000);
  assert.throws(
    () => f.db.jevTasks.readEvidence(f.a.id, 'foreign', evidence.id),
    /belong to this task/,
  );
  assert.throws(
    () => f.db.jevTasks.get('foreign', 'assigned', scan.taskId),
    /was not found for this workspace task/,
  );
});

test('large pages checkpoint link batches and resume without restarting or losing items', async (t) => {
  const f = fixture(t),
    links = Array.from({length: 400}, (_, i) => ({url: url + '/' + i, text: 'Home ' + i}));
  f.ports.browser = async () => ({url, title: 'Homes', text: 'Last page', links});
  const first = await f.run({operation: 'scan_results', url});
  assert.equal(first.status, 'continue');
  assert.equal(first.total, 360);
  const saved = f.db.jevTasks.get(f.a.id, 'assigned', first.taskId);
  assert.equal(saved.pageWork.offset, 360);
  const second = await f.run({taskId: first.taskId});
  assert.equal(second.status, 'completed');
  assert.equal(second.total, 400);
  assert.equal(second.usage.calls, 15);
  const calls = second.usage.calls;
  assert.equal((await f.run({taskId: first.taskId})).usage.calls, calls);
  f.ports.searchId = 'other';
  await assert.rejects(f.run({taskId: first.taskId}), /another saved search/);
});

test('repeated page or uncertain pagination hands off without certifying completion', async (t) => {
  const f = fixture(t);
  f.ports.browser = async () => ({
    url,
    text: 'Same page',
    links: [],
    pagination: [{url: url + '?p=2', text: 'Next'}],
  });
  f.ports.evaluate = async (state, questions) => ({
    answers: {next: answer('0', questions.next.criteria)},
  });
  const result = await f.run({operation: 'scan_results', url});
  assert.equal(result.status, 'needs_agent');
  assert.equal(result.issue.reason, 'no_progress');
});

test('malformed decisions cannot navigate and aborted decisions cannot mutate', async (t) => {
  const f = fixture(t);
  f.ports.browser = async (name, args) => {
    f.calls.push({name, args});
    return {
      url: args.url ?? url,
      title: 'Homes',
      text: 'Final page',
      links: [{url: url + '/1', text: 'One'}],
      pagination: [],
    };
  };
  f.ports.evaluate = async () => ({answers: {next: {choice: 'https://evil.test', confidence: 1}}});
  let result = await f.run({operation: 'scan_results', url});
  assert.equal(result.status, 'needs_agent');
  assert.equal(result.issue.reason, 'task_error');
  assert.equal(f.calls.length, 1);
  f.ports.evaluate = async () => {
    f.controller.abort();
    return {};
  };
  await assert.rejects(f.run({operation: 'scan_results', url}), /abort/i);
  assert.equal(f.calls.length, 2);
});

test('a session stopped mid-slice leaves the task resumable for the next session', async (t) => {
  const f = fixture(t);
  f.ports.browser = async () => {
    f.controller.abort();
    throw f.controller.signal.reason;
  };
  await assert.rejects(f.run({operation: 'scan_results', url}), /abort/i);
  const [task] = f.db.jevTasks.list(f.a.id, 'assigned');
  assert.equal(task.status, 'continue', 'not left "running" with nobody driving it');
  assert.match(jevTaskSummary(task).next, /Continue browser_run_task with this taskId/);
});

test('form batches exact values and never clicks; changed earlier fields prevent success', async (t) => {
  for (const clearFirst of [false, true]) {
    const f = fixture(t);
    let filled = false;
    f.ports.browser = async (name, args) => {
      f.calls.push({name, args});
      if (name === 'fill') filled = true;
      return {
        url,
        title: 'Form',
        fillFields: [
          {fieldId: 'f1', label: 'Name', type: 'text', value: filled && !clearFirst ? 'Ada' : ''},
          {fieldId: 'f2', label: 'City', type: 'text', value: filled ? 'Berlin' : ''},
        ],
        results:
          name === 'fill'
            ? args.fields.map((f) => ({fieldId: f.fieldId, status: 'filled'}))
            : undefined,
      };
    };
    f.ports.evaluate = async (state, questions) => ({
      answers: Object.fromEntries(
        Object.entries(questions).map(([k, q], i) => [k, answer('f' + (i + 1), q.criteria)]),
      ),
    });
    const result = await f.run({
      operation: 'fill_form',
      url,
      answers: [
        {key: 'name', label: 'Name', value: 'Ada'},
        {key: 'city', label: 'City', value: 'Berlin'},
      ],
    });
    assert.equal(result.status, clearFirst ? 'needs_agent' : 'completed');
    if (clearFirst) assert.equal(result.issue.reason, 'filled_values_changed');
    assert.deepEqual(f.calls.filter((c) => c.name === 'fill')[0].args.fields, [
      {fieldId: 'f1', text: 'Ada'},
      {fieldId: 'f2', text: 'Berlin'},
    ]);
    assert.ok(!f.calls.some((c) => c.name === 'click'));
    assert.equal(result.answers.name.actual, undefined);
  }
});

test('search preparation verifies applied results after its observed search button', async (t) => {
  const f = fixture(t);
  let clicked = false;
  f.ports.browser = async (name, args) => {
    f.calls.push({name, args});
    if (name === 'click') clicked = true;
    return {
      url,
      text: clicked ? 'Berlin homes' : 'Search homes',
      clickTargets: [
        {targetId: 'search', label: 'Search'},
        {targetId: 'send', label: 'Send application'},
      ],
    };
  };
  f.ports.evaluate = async (state, questions) => {
    const k = Object.keys(questions)[0];
    return {answers: {[k]: answer(k === 'target' ? 'search' : 'ready', questions[k].criteria)}};
  };
  const result = await f.run({operation: 'prepare_search', url, goal: 'Berlin homes'});
  assert.equal(result.status, 'completed');
  assert.deepEqual(
    f.calls.filter((c) => c.name === 'click').map((c) => c.args.targetId),
    ['search'],
  );
});

test('unknown detail text stays uncertain, and low-confidence mismatch cannot reject', async (t) => {
  const f = fixture(t),
    source = f.db.jevTasks.create(f.a.id, 'assigned', {operation: 'collect_details'});
  const evidence = f.db.jevTasks.evidence(source, {url, text: 'Missing salary', title: 'Home'});
  source.items = [{url, evidenceId: evidence.id}, {url: url + '/missing'}];
  f.db.jevTasks.save(source);
  // The weak mismatch is rechecked once on the brief; an unsupported exclusion keeps it uncertain.
  f.ports.evaluate = async (state, questions) => ({
    answers: questions.fit
      ? {fit: answer('mismatch', questions.fit.criteria, 0.8)}
      : {
          support: answer('uncertain', questions.support.criteria, 0.9),
          exclusion: answer('none', questions.exclusion.criteria, 0.9),
        },
  });
  const result = await f.run({operation: 'classify_results', fromTaskId: source.id});
  assert.deepEqual(
    result.items.map((i) => i.assessment.decision),
    ['uncertain', 'uncertain'],
  );
  assert.equal(result.items[0].assessment.reason, 'exclusion_unverified');
  assert.equal(result.items[0].assessment.exclusion, undefined);
});

test('85 percent page and link classification excludes navigation but retains weaker decisions', async (t) => {
  for (const confidence of [0.85, 0.849]) {
    const f = fixture(t);
    f.ports.browser = async () => ({
      url,
      text: 'Listings and account menu',
      links: [{url: url + '/profile', text: 'Account'}],
    });
    f.ports.evaluate = async (_, q) => ({
      answers: Object.fromEntries(
        Object.entries(q).map(([key, question]) => [
          key,
          answer(key === 'next' ? 'end' : 'other', question.criteria, confidence),
        ]),
      ),
    });
    const scan = await f.run({operation: 'scan_results', url});
    assert.equal(scan.total, confidence >= 0.85 ? 0 : 1);
    f.ports.resolveDetails = () => [{url: url + '/directory'}];
    f.ports.evaluate = async (_, q) => ({
      answers: {fit: answer('results', q.fit.criteria, confidence)},
    });
    const detail = await f.run({operation: 'collect_details'});
    assert.equal(detail.resultsPages, confidence >= 0.85 ? 1 : 0);
    assert.ok(detail.items[0].evidenceId);
  }
});

test('qualification, unrelated-role and non-listing exclusions carry reasons without raw body replay', async (t) => {
  for (const reason of ['qualification', 'unrelated_role', 'not_listing']) {
    const f = fixture(t);
    f.ports.resolveDetails = () => [{url}];
    f.ports.browser = async () => ({url, text: 'Original listing body. '.repeat(100)});
    f.ports.evaluate = async (_, q) => ({
      answers: q.fit
        ? {fit: answer('mismatch', q.fit.criteria, 0.9)}
        : {
            support: answer('supported', q.support.criteria, 0.85),
            exclusion: answer(reason, q.exclusion.criteria, 0.85),
          },
    });
    const detail = await f.run({operation: 'collect_details'});
    assert.equal(detail.items[0].assessment.decision, 'mismatch');
    assert.equal(detail.items[0].assessment.reason, reason);
    assert.doesNotMatch(JSON.stringify(detail), /Original listing body/);
  }
});

test('access barriers stop the first detail without classification or unchanged-resume fanout', async (t) => {
  const barriers = [
    {verification: {state: 'required'}},
    {verification: {state: 'verification_error'}},
    {status: 'verification_handoff'},
    {siteWait: {site: 'example.test', retryAt: Date.now() + 60000, message: 'Wait'}},
    {
      title: 'Just a moment...',
      text: 'Additional Verification Required\nYour Ray ID for this request is synthetic',
    },
  ];
  for (const barrier of barriers) {
    const f = fixture(t),
      urls = Array.from({length: 30}, (_, i) => url + '/' + i);
    f.ports.resolveDetails = () => urls.map((url) => ({url}));
    let blocked = true;
    f.ports.browser = async (name, args) => {
      f.calls.push({name, args});
      return {
        url: args.url,
        text: 'Actual listing',
        ...(blocked ? barrier : {verification: {state: 'cleared'}}),
      };
    };
    const details = await f.run({operation: 'collect_details'});
    assert.equal(details.status, 'needs_agent');
    assert.equal(details.issue.reason, 'access_barrier');
    assert.equal(details.usage.calls, 0);
    assert.equal(details.steps, 1);
    assert.ok(
      details.items.every(
        (item) => !item.evidenceId && !item.assessment && item.error === 'access_barrier',
      ),
    );
    assert.match(details.next, /Do not resume/i);
    const stored = f.db.jevTasks.get(f.a.id, 'assigned', details.taskId);
    assert.deepEqual(
      stored.items.map((i) => i.url),
      urls,
    );
    await f.run({taskId: details.taskId});
    assert.equal(f.calls.length, 1);
    const scan = await f.run({operation: 'scan_results', url});
    assert.equal(scan.issue.reason, 'access_barrier');
    assert.equal(scan.usage.calls, 0);
    blocked = false;
    f.db.jevTasks.detailWaits.clear();
    f.db.jevTasks.hostWaits.clear();
    const recovered = await f.run({operation: 'collect_details', url: urls[0]});
    assert.ok(recovered.classified > 0);
  }
});

test('a verification widget inside a page form is read like any page and never blocks the site', async (t) => {
  const forms = [
    {
      fillFields: [{fieldId: 'f1', label: 'First name'}],
      passwordFields: [{fieldId: 'p1', label: 'Password'}],
    },
    {passwordFields: [{fieldId: 'p1', label: 'Password'}]},
    {fillFields: [{fieldId: 'f1', label: 'Email'}]},
  ];
  const widgets = [
    {state: 'required', capability: 'supported', checkbox: true},
    {state: 'required', capability: 'not_exposed', handoff: true},
    {state: 'checking', capability: 'pending'},
    {state: 'verification_error'},
  ];
  for (const form of forms)
    for (const verification of widgets) {
      const f = fixture(t),
        signup = url + '/signup?action=save-job:1',
        listing = url + '/listing/1';
      f.ports.recoverDetails = true;
      f.ports.resolveDetails = () => [{url: signup}, {url: listing}];
      f.ports.browser = async (name, args) => {
        f.calls.push({name, args});
        return args.url === signup
          ? {
              url: args.url,
              title: 'Sign up',
              text: 'Create a new account\nFirst name\nLast name\nEmail\nPassword\nSign up',
              verification,
              ...form,
            }
          : {url: args.url, text: 'Actual listing'};
      };
      const details = await f.run({operation: 'collect_details'});
      assert.notEqual(
        details.issue?.reason,
        'access_barrier',
        JSON.stringify({form, verification}),
      );
      assert.equal(details.classified, 2);
      assert.deepEqual(
        f.calls.map((c) => c.args.url),
        [signup, listing],
        'the sign-up page is read once; the listing is still read',
      );
      assert.ok(details.items.every((item) => item.evidenceId && !item.error));
    }
});

test('a verification widget on a page that renders the site navigation is read like any page', async (t) => {
  // The sign-up form sits in a frame Jev cannot read: no fields, one unread frame.
  const nav = Array.from({length: 12}, (_, i) => ({url: url + '/nav/' + i, text: 'Nav ' + i}));
  for (const verification of [
    {state: 'required', capability: 'supported', checkbox: true},
    {state: 'required', capability: 'not_exposed', handoff: true},
    {state: 'checking', capability: 'pending'},
  ]) {
    const f = fixture(t),
      signup = url + '/signup?action=save-job:1',
      listing = url + '/listing/1';
    f.ports.recoverDetails = true;
    f.ports.resolveDetails = () => [{url: signup}, {url: listing}];
    f.ports.browser = async (name, args) => {
      f.calls.push({name, args});
      return args.url === signup
        ? {
            url: args.url,
            title: 'Job Seeker Sign Up',
            text: 'Sign up to save this job',
            links: nav,
            unreadFrames: 1,
            verification,
          }
        : {url: args.url, text: 'Actual listing', links: nav};
    };
    const details = await f.run({operation: 'collect_details'});
    assert.notEqual(details.issue?.reason, 'access_barrier', JSON.stringify(verification));
    assert.deepEqual(
      f.calls.map((c) => c.args.url),
      [signup, listing],
      'the sign-up page is read once and the listing still opens',
    );
    assert.equal(details.classified, 2);
  }
  // A wall that links only to its provider still stops the site.
  const f = fixture(t),
    urls = [url + '/1', url + '/2'];
  f.ports.resolveDetails = () => urls.map((url) => ({url}));
  const provider = Array.from({length: 12}, (_, i) => ({
    url: 'https://challenge.example.net/help/' + i,
    text: 'Help ' + i,
  }));
  f.ports.browser = async (name, args) => {
    f.calls.push({name, args});
    return {
      url: args.url,
      text: 'Verify you are human',
      links: provider,
      verification: {state: 'required'},
    };
  };
  const walled = await f.run({operation: 'collect_details'});
  assert.equal(walled.issue?.reason, 'access_barrier');
  assert.equal(f.calls.length, 1);
});

test('a site-wait exception stops the queue and preserves earlier successful details', async (t) => {
  const f = fixture(t),
    urls = [url + '/ready', url + '/blocked', url + '/untouched'];
  f.ports.resolveDetails = () => urls.map((url) => ({url}));
  f.ports.browser = async (name, args) => {
    f.calls.push({name, args});
    if (args.url === urls[1])
      throw Object.assign(Error('Host wait'), {
        code: 'SITE_WAIT',
        url: args.url,
        wait: {site: 'example.test', message: 'Host wait'},
      });
    return {url: args.url, text: 'Real listing'};
  };
  const details = await f.run({operation: 'collect_details'});
  assert.equal(details.issue.reason, 'access_barrier');
  assert.equal(details.issue.siteWait.site, 'example.test');
  assert.deepEqual(
    f.calls.map((c) => c.args.url),
    urls.slice(0, 2),
  );
  assert.equal(details.classified, 1);
  assert.equal(details.items[0].assessment.decision, 'possible');
  assert.ok(details.items.slice(1).every((i) => !i.evidenceId && i.error === 'access_barrier'));
});

test('ordinary unavailable pages do not block other details', async (t) => {
  const f = fixture(t),
    urls = ['loading', 'empty', 'failed', 'ready'].map((state) => url + '/' + state);
  f.ports.resolveDetails = () => urls.map((url) => ({url}));
  f.ports.browser = async (name, args) => {
    f.calls.push({name, args});
    if (args.url === urls[2]) throw Error('Page not found');
    return {
      url: args.url,
      text: args.url === urls[1] ? '' : 'Real listing',
      ...(args.url === urls[0] ? {status: 'loading'} : {verification: {state: 'cleared'}}),
    };
  };
  const details = await f.run({operation: 'collect_details'});
  assert.equal(details.issue.reason, 'detail_unavailable');
  assert.equal(details.classified, 1);
  assert.equal(details.usage.calls, 1);
  assert.deepEqual(
    f.calls.map((c) => c.args.url),
    urls,
  );
  assert.ok(details.items[3].evidenceId);
});

test('workflow enforces operation scope before creating a task or touching Chrome', async (t) => {
  const f = fixture(t),
    run = f.db.begin(f.a.id, 'trial');
  f.db.putRun({...run, recordOperation: 'verify'});
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: f.controller.signal,
    browser: {},
    report: () => {},
  });
  await assert.rejects(
    flow.call(f.a.id, run.id, 'browser_run_task', {
      operation: 'fill_form',
      answers: [{key: 'name', label: 'Name', value: 'Ada'}],
    }),
    /can only read/,
  );
  assert.equal(f.db.jevTasks.list(f.a.id, run.id).length, 0);
});

test('source workflow checkpoints every discovered detail but does not complete the source', async (t) => {
  const f = fixture(t),
    task = f.core.workspaces.tasks.enqueue(f.a.id, {
      operation: 'scan',
      capability: 'browser.observe',
      sourceUrl: url,
      sources: [url],
      lockKey: 'source:' + url,
    }),
    run = f.db.begin(f.a.id, {kind: 'run', taskId: task.id});
  let current = url;
  const browser = {
    evaluateJev: (_, state, questions) => f.ports.evaluate(state, questions),
    call: async (_, name, args) => {
      if (args.url) current = args.url;
      const page = {
        url: current,
        title: 'Homes',
        text: 'Page 1. Last page.',
        links: [{url: url + '/home', text: 'Home'}],
        pagination: [{text: '1', url, current: true}],
      };
      return {
        jevPage: page,
        pageContext: {url: current, tabId: 'owned'},
        content: [{type: 'text', text: 'Page URL: ' + current + '\n' + JSON.stringify(page)}],
      };
    },
  };
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: f.controller.signal,
    browser,
    report: () => {},
  });
  const result = await flow.call(f.a.id, run.id, 'browser_run_task', {
    operation: 'scan_results',
    url,
  });
  assert.equal(result.status, 'completed');
  assert.ok(result.snapshot.id);
  const queue = f.db.scanQueue(f.a.id, run.id);
  assert.deepEqual(queue.pendingUrls, [url + '/home']);
  assert.equal(queue.pageProgress.currentPage, 1);
  assert.equal(queue.processedCount, 1);
  assert.equal(f.db.run(run.id).status, 'running');
  assert.equal(f.db.results(f.a.id).length, 0);
});

test('scan handoff exposes clean prioritized candidates and exact saved page evidence without board rereads', async (t) => {
  const f = fixture(t),
    filter = url + '?action=facet_selected%3Bage%3Bage_7',
    logo = 'https://example.test/de',
    one = url + '/one',
    two = url + '/two',
    unknown = url + '/unknown';
  const task = f.core.workspaces.tasks.enqueue(f.a.id, {
      operation: 'scan',
      capability: 'browser.observe',
      sourceUrl: url,
      sources: [url],
      lockKey: 'source:' + url,
    }),
    run = f.db.begin(f.a.id, {kind: 'run', taskId: task.id});
  // A previous implementation queued controls. Fresh observed controls can be
  // retired, while uncertain candidate links must survive the cleanup.
  f.db.observe(f.a.id, run.id, url, 'Old observed links', [filter, logo, unknown]);
  f.db.saveScanProgress(
    f.a.id,
    run.id,
    {pendingUrls: [filter, logo, unknown], reason: 'Older queue'},
    {url, text: 'Old observed links'},
  );
  const opened = [],
    evaluated = [];
  const browser = {
    call: async (_, name, args) => {
      opened.push(args.url);
      const page =
        args.url === url
          ? {
              url,
              title: 'Results',
              text: 'Exact original results',
              links: [
                {url: logo, text: 'site-logo'},
                {url: filter, text: 'Only recent'},
                {url: unknown, text: 'Unclear link'},
                {url: one, text: 'Home one'},
                {url: two, text: 'Home two'},
              ],
              pagination: [
                {text: 'Previous', disabled: true},
                {text: '1 of 1', url},
                {text: 'Next', disabled: true},
              ],
            }
          : {url: args.url, title: 'Individual home', text: 'Full original detail'};
      return {
        jevPage: page,
        pageContext: {url: page.url, tabId: 'owned'},
        content: [{type: 'text', text: 'Page URL: ' + page.url + '\n' + JSON.stringify(page)}],
      };
    },
    evaluateJev: async (_, state, questions) => {
      evaluated.push(state);
      return {
        answers: Object.fromEntries(
          Object.entries(questions).map(([key, q]) => {
            // As with TypeSafe, the inference receives instructions/state, not key.
            const reference = q.instructions.match(/`links\.(link\d+)`/)?.[1],
              link = state.links?.[reference];
            if (state.links)
              assert.ok(link, 'Each question must explicitly identify its own observed link');
            return [
              key,
              answer(
                key === 'next'
                  ? 'end'
                  : key === 'fit'
                    ? 'possible'
                    : [unknown, filter].includes(link.url)
                      ? 'other'
                      : 'listing',
                q.criteria,
                link?.url === unknown ? 0.8 : 1,
              ),
            ];
          }),
        ),
      };
    },
  };
  const flow = automationWorkflow({
      db: f.db,
      run,
      signal: f.controller.signal,
      browser,
      report: () => {},
    }),
    call = (name, args) => flow.call(f.a.id, run.id, name, args);
  const scan = await call('browser_run_task', {operation: 'scan_results', url});
  assert.equal(scan.status, 'completed');
  assert.equal(scan.total, 3);
  assert.equal(scan.confirmedListings, 2);
  assert.equal(scan.uncertainLinks, 1);
  assert.equal(scan.items, undefined);
  const index = await call('read_browser_task', {taskId: scan.taskId});
  assert.deepEqual(
    index.items.map((i) => i.url),
    [one, two, unknown],
  );
  assert.equal(index.items[2].discovery.decision, 'uncertain');
  assert.deepEqual(scan.lastPage.position, {currentPage: 1, totalPages: 1, evidence: '1 of 1'});
  assert.equal(scan.lastPage.checkpointSaved, true);
  assert.equal(scan.lastPage.pageReport.evidence, '1 of 1');
  assert.equal(scan.lastPage.chronology.status, 'unverified');
  assert.equal(scan.lastPage.excludedNavigation, 2);
  assert.ok(index.items.every((i) => i.discoveryEvidenceId === scan.lastPage.evidenceId));
  assert.deepEqual(
    new Set(f.db.scanQueue(f.a.id, run.id).pendingUrls),
    new Set([unknown, one, two]),
  );
  const calls = evaluated.length,
    saved = await call('read_browser_task', {taskId: scan.taskId, pageOffset: 0});
  assert.deepEqual(saved.pages, [scan.lastPage]);
  assert.equal(evaluated.length, calls);
  assert.deepEqual(opened, [url]);
  assert.ok(!evaluated.some((s) => Object.values(s.links ?? {}).some((l) => l.url === logo)));
  const details = await call('browser_run_task', {
    operation: 'collect_details',
    fromTaskId: scan.taskId,
  });
  assert.equal(details.classified, 3);
  assert.deepEqual(opened, [url, one, two, unknown]);
  assert.equal(f.db.run(run.id).status, 'running');
  assert.equal(f.db.results(f.a.id).length, 0);
});

test('legacy ambiguous discovery requires a fresh scan without erasing its work or visiting old controls', async (t) => {
  const f = fixture(t),
    old = f.db.jevTasks.create(f.a.id, 'assigned', {operation: 'scan_results', url});
  const e = f.db.jevTasks.evidence(old, {url, text: 'Original board'});
  old.searchId = 'default';
  old.status = 'completed';
  old.items = [
    {
      url: url + '/filter',
      discoveryEvidenceId: e.id,
      discovery: {decision: 'uncertain', confidence: 0.2},
    },
  ];
  f.db.jevTasks.save(old);
  assert.match(jevTaskSummary(old).next, /NEW scan_results/);
  const resumed = await f.run({taskId: old.id});
  assert.equal(resumed.issue.reason, 'discovery_refresh_required');
  assert.deepEqual(resumed.issue.urls, [url]);
  assert.equal(f.calls.length, 0);
  const details = await f.run({operation: 'collect_details', fromTaskId: old.id});
  assert.equal(details.issue.reason, 'discovery_refresh_required');
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.jevTasks.get(f.a.id, 'assigned', old.id).items.length, 1);
  assert.equal(f.db.jevTasks.readEvidence(f.a.id, 'assigned', e.id).text, 'Original board');
  f.ports.browser = async (name, args) => {
    f.calls.push({name, args});
    return {
      url: args.url ?? url,
      title: 'Homes',
      text: 'Final page',
      links: [{url: url + '/1', text: 'One'}],
      pagination: [],
    };
  };
  const fresh = await f.run({operation: 'scan_results', url});
  assert.equal(fresh.status, 'completed');
  assert.equal(f.db.jevTasks.get(f.a.id, 'assigned', fresh.taskId).discoveryVersion, 3);
});

test('page receipts use the same URL normalization as observations without authorizing unseen pages', async (t) => {
  const f = fixture(t),
    task = f.core.workspaces.tasks.enqueue(f.a.id, {
      operation: 'scan',
      capability: 'browser.observe',
      sourceUrl: url,
      sources: [url],
      lockKey: 'source:' + url,
    }),
    run = f.db.begin(f.a.id, {kind: 'run', taskId: task.id});
  f.db.observe(f.a.id, run.id, url + '#', 'Page 1');
  const saved = f.db.reportPage(f.a.id, run.id, {
    url: url + '#',
    currentPage: 1,
    totalPages: 1,
    evidence: '1 of 1',
    at: Date.now(),
  });
  assert.equal(saved.pageProgress.url, url);
  assert.throws(
    () =>
      f.db.reportPage(f.a.id, run.id, {
        url: url + '?page=2#',
        currentPage: 2,
        evidence: '2',
        at: Date.now(),
      }),
    /not observed/,
  );
});

test('lazy results update the saved page receipt after scrolling without losing earlier candidates', async (t) => {
  const f = fixture(t);
  let scrolled = false,
    checkpoints = 0;
  f.ports.browser = async (name) => {
    if (name === 'scroll') scrolled = true;
    return {
      url,
      title: 'Homes',
      text: scrolled ? 'All visible homes' : 'More below',
      links: [
        {url: url + '/one', text: 'One'},
        ...(scrolled ? [{url: url + '/two', text: 'Two'}] : []),
      ],
      scrollTargets: [{controlId: 'scroll', atBottom: scrolled, remainingDown: scrolled ? 0 : 100}],
    };
  };
  f.ports.evaluate = async (state, q) => ({
    answers: Object.fromEntries(
      Object.entries(q).map(([key, question]) => [
        key,
        answer(key === 'next' ? (scrolled ? 'end' : 'scroll') : 'listing', question.criteria),
      ]),
    ),
  });
  f.ports.checkpoint = async () => {
    checkpoints++;
    return {saved: true};
  };
  const scan = await f.run({operation: 'scan_results', url});
  assert.equal(scan.status, 'completed');
  assert.equal(scan.total, 2);
  assert.equal(scan.pageCount, 1);
  assert.equal(checkpoints, 2);
  assert.equal(scan.lastPage.candidates, 2);
  assert.equal(scan.lastPage.confirmedListings, 2);
  assert.equal(scan.lastPage.checkpointSaved, true);
  assert.equal(scan.lastPage.continuation.decision, 'end');
  assert.equal(
    f.db.jevTasks.fullEvidence(f.a.id, 'assigned', scan.lastPage.evidenceId).text,
    'All visible homes',
  );
});

test('a scroll answer on an endless list waits for the next batch and scrolls the results, not a side panel', async (t) => {
  const f = fixture(t);
  // Jev observations carry only positions; the page sits at the bottom until
  // the next batch arrives.
  let loaded = false,
    scrolled = null,
    waits = 0;
  f.ports.wait = async () => {
    waits++;
    loaded = true;
  };
  f.ports.browser = async (name, args) => {
    if (name === 'scroll') scrolled = args.controlId;
    return {
      url,
      title: 'Homes',
      text: scrolled ? 'All homes' : 'First homes',
      links: [
        {url: url + '/one', text: 'One'},
        ...(scrolled ? [{url: url + '/two', text: 'Two'}] : []),
      ],
      scrollTargets: [
        {controlId: 'filters', label: 'Form content', top: 0, height: 2212, viewport: 694},
        {controlId: 'page', label: 'Page', top: 3100, height: loaded ? 6000 : 4000, viewport: 900},
      ],
    };
  };
  f.ports.evaluate = async (state, q) => ({
    answers: Object.fromEntries(
      Object.entries(q).map(([key, question]) => [
        key,
        answer(key === 'next' ? (scrolled ? 'end' : 'scroll') : 'listing', question.criteria),
      ]),
    ),
  });
  const scan = await f.run({operation: 'scan_results', url});
  assert.equal(scan.status, 'completed');
  assert.equal(scrolled, 'page');
  assert.equal(waits, 1);
  assert.equal(scan.total, 2);
});

test('a site extension that loads more on the same page loads it without asking the agent', async (t) => {
  const f = fixture(t);
  let batches = 1,
    scrolls = 0,
    asked = false;
  f.ports.wait = async () => {};
  f.ports.browser = async (name) => {
    if (name === 'more') {
      scrolls++;
      batches = 2;
    }
    const links = [{url: url + '/one', text: 'One', listing: true}];
    if (batches === 2) links.push({url: url + '/two', text: 'Two', listing: true});
    return {
      url,
      title: 'Homes',
      text: `Homes batch ${batches}`,
      links,
      paginationBy: 'site',
      pagination: batches === 1 ? [{text: 'More results', more: true}] : [],
      scrollTargets: [{controlId: 'page', label: 'Page', top: 0, height: 4000, viewport: 900}],
    };
  };
  f.ports.evaluate = async (state, q) => {
    if (q.next) asked = true;
    return {
      answers: Object.fromEntries(
        Object.entries(q).map(([key, question]) => [key, answer('listing', question.criteria)]),
      ),
    };
  };
  const scan = await f.run({operation: 'scan_results', url});
  assert.equal(scan.status, 'completed');
  assert.equal(scrolls, 1);
  assert.equal(asked, false);
  assert.equal(scan.total, 2);
  assert.equal(scan.lastPage.continuation.method, 'site_extension');
});

test('page text cut inside an emoji reaches Jev as well-formed Unicode', async () => {
  const questions = {fit: {type: 'choice', criteria: {keep: 'Keep', unknown: 'Unknown'}}},
    cut = 'Senior .NET Engineer \u{1F680}'.slice(0, -1);
  let body;
  await askJev({links: {link0: {title: cut}}}, questions, {
    apiKey: 'test',
    fetchImpl: async (_, args) => {
      body = args.body;
      return {
        ok: true,
        json: async () => ({answers: {fit: answer('keep', questions.fit.criteria)}}),
      };
    },
  });
  assert.equal(body.isWellFormed(), true);
  assert.doesNotMatch(body, /\\ud[89ab]/i);
  assert.equal(JSON.parse(body).state.links.link0.title, 'Senior .NET Engineer \uFFFD');
});

test('generic Jev requests validate every returned choice and propagate cancellation', async () => {
  const questions = {fit: {type: 'choice', criteria: {keep: 'Keep', unknown: 'Unknown'}}},
    controller = new AbortController();
  let request;
  const result = await askJev({text: 'Synthetic'}, questions, {
    apiKey: 'test',
    signal: controller.signal,
    fetchImpl: async (_, args) => {
      request = args;
      return {
        ok: true,
        json: async () => ({
          answers: {fit: answer('keep', questions.fit.criteria)},
          usage: {input_tokens: 9},
        }),
      };
    },
  });
  assert.equal(result.usage.input_tokens, 9);
  assert.equal(JSON.parse(request.body).state.text, 'Synthetic');
  controller.abort();
  assert.equal(request.signal.aborted, true);
  await assert.rejects(
    askJev({}, questions, {
      apiKey: 'test',
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({answers: {fit: {choice: 'foreign'}}}),
      }),
    }),
    /invalid/,
  );
});

test('observed URLs, the assigned record and a resumed queue do not need a prior Jev task', async (t) => {
  const f = fixture(t),
    one = url + '/one',
    two = url + '/two';
  f.ports.resolveDetails = (input) =>
    jevDetailItems(input, {pendingUrls: [one, two], observedUrls: [one, two]});
  const single = await f.run({operation: 'collect_details', url: one});
  assert.equal(single.status, 'completed');
  assert.equal(single.total, 1);
  const batch = await f.run({operation: 'collect_details', urls: [one, two, one]});
  assert.equal(batch.status, 'completed');
  assert.equal(batch.total, 2);
  const pending = await f.run({operation: 'collect_details'});
  assert.equal(pending.status, 'completed');
  assert.equal(pending.total, 2);
  const classified = await f.run({operation: 'classify_results'});
  assert.equal(classified.status, 'completed');
  assert.ok(classified.items.every((i) => i.assessment.decision === 'possible'));
  assert.equal(classified.items[0].evidenceId, pending.items[0].evidenceId);
  const before = f.calls.length;
  await assert.rejects(
    f.run({operation: 'collect_details', url: 'https://unseen.test/job'}),
    /observed/,
  );
  assert.equal(f.calls.length, before);
  f.ports.searchId = 'another';
  await assert.rejects(
    f.run({operation: 'classify_results'}),
    /First read the listings with collect_details/,
  );
  assert.deepEqual(jevDetailItems({}, {assignedRecord: {url: one, title: 'Assigned'}}), [
    {url: one, title: 'Assigned'},
  ]);
  assert.throws(
    () => jevDetailItems({urls: [two]}, {assignedRecord: {url: one}, savedUrls: [two]}),
    /assigned record/,
  );
});

test('one unavailable detail does not stop other queued details or erase evidence', async (t) => {
  const f = fixture(t);
  f.ports.resolveDetails = () => [
    {url: url + '/loading'},
    {url: url + '/ready'},
    {url: url + '/error'},
  ];
  f.ports.browser = async (name, args) => {
    if (args.url.endsWith('/error')) throw Error('Single page unavailable');
    return {
      url: args.url,
      text: args.url.endsWith('loading') ? '' : 'Complete original listing',
      status: args.url.endsWith('loading') ? 'loading' : 'ready',
    };
  };
  const result = await f.run({operation: 'collect_details'});
  assert.equal(result.status, 'needs_agent');
  assert.equal(result.issue.reason, 'detail_unavailable');
  assert.equal(result.items[0].error, 'detail_unavailable');
  assert.ok(result.items[1].evidenceId);
  assert.match(result.next, /Other details were processed/);
  const triage = await f.run({operation: 'classify_results'});
  assert.deepEqual(
    triage.items.map((i) => i.assessment.decision),
    ['uncertain', 'possible', 'uncertain'],
  );
});

test('marketing/legal navigation is not promoted to listing candidates and handoffs name the next operation', async (t) => {
  const f = fixture(t);
  f.ports.browser = async () => ({
    url,
    title: 'ATS',
    text: 'Learn about the product',
    links: [
      {url: 'https://example.test/', text: 'Learn more about Example'},
      {url: 'https://example.test/privacy', text: 'Privacy Policy'},
      {url: 'https://example.test/security', text: 'Security'},
    ],
  });
  const scan = await f.run({operation: 'scan_results', url});
  assert.equal(scan.status, 'needs_agent');
  assert.equal(scan.total, 0);
  assert.equal(scan.issue.reason, 'no_listing_links');
  assert.equal(scan.usage.calls, 0);
  assert.match(scan.next, /actual results/);
  const search = await f.run({operation: 'prepare_search', url});
  assert.equal(search.status, 'needs_agent');
  assert.match(search.next, /operation=scan_results/);
  assert.match(search.next, /Do not repeat prepare_search/);
});

test('collection after redirect can retire the requested queue URL and report other processed URLs', async (t) => {
  const f = fixture(t),
    original = url + '/old',
    destination = url + '/canonical';
  const task = f.core.workspaces.tasks.enqueue(f.a.id, {
      operation: 'scan',
      capability: 'browser.observe',
      sourceUrl: url,
      sources: [url],
      lockKey: 'source:' + url,
    }),
    run = f.db.begin(f.a.id, {kind: 'run', taskId: task.id});
  f.db.observe(f.a.id, run.id, url, 'Observed queue', [original]);
  f.db.saveScanProgress(
    f.a.id,
    run.id,
    {pendingUrls: [original], reason: 'Pending observed listing'},
    {url, text: 'Observed queue'},
  );
  // Reconstruct a workflow as on restart: the queue is the only input needed.
  const browser = {
    evaluateJev: (_, state, questions) => f.ports.evaluate(state, questions),
    call: async () => {
      const page = {url: destination, title: 'Canonical listing', text: 'Original job description'};
      return {
        jevPage: page,
        pageContext: {url: destination, tabId: 'owned'},
        content: [{type: 'text', text: 'Page URL: ' + destination + '\n' + JSON.stringify(page)}],
      };
    },
  };
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: f.controller.signal,
    browser,
    report: () => {},
  });
  const result = await flow.call(f.a.id, run.id, 'browser_run_task', {
    operation: 'collect_details',
  });
  assert.equal(result.issue.reason, 'batch_ready');
  assert.equal(result.batch.total, 1);
  assert.equal(result.items[0].url, undefined);
  assert.equal(result.items[0].item, 1);
  assert.equal(
    f.db.jevTasks.readEvidence(f.a.id, run.taskId, result.items[0].evidenceId).url,
    destination,
  );
  // Saving the finding under its original queue URL retires it; no progress tool is needed.
  await flow.call(f.a.id, run.id, 'record_automation_result', {
    key: original,
    url: original,
    title: 'Canonical listing',
    summary: 'Read and assessed original listing',
    score: 70,
  });
  assert.equal(f.db.scanQueue(f.a.id, run.id).total, 0);
});

test('restart reuses discovered Jev links only in their task/search without inventing a fresh observation', async (t) => {
  const f = fixture(t),
    child = url + '/saved-child',
    foreign = url + '/foreign-child';
  const task = f.core.workspaces.tasks.enqueue(f.a.id, {
    operation: 'scan',
    capability: 'browser.observe',
    sourceUrl: url,
    sources: [url],
    lockKey: 'source:' + url,
  });
  const old = f.db.begin(f.a.id, {kind: 'run', taskId: task.id});
  const saved = f.db.jevTasks.create(f.a.id, task.id, {operation: 'collect_details'});
  saved.searchId = 'default';
  f.db.jevTasks.save(saved);
  const evidence = f.db.jevTasks.evidence(saved, {
    url: url + '/old-board',
    text: 'Historical board',
    links: [{url: child, text: 'Listing'}],
  });
  const other = f.db.jevTasks.create(f.a.id, 'different-task', {operation: 'collect_details'});
  other.searchId = 'default';
  f.db.jevTasks.save(other);
  f.db.jevTasks.evidence(other, {
    url: url + '/foreign-board',
    text: 'Other task',
    links: [{url: foreign, text: 'Foreign'}],
  });
  f.db.finish(f.a.id, old.id, 'interrupted', 'Restart');
  f.core.workspaces.tasks.put({
    ...f.core.workspaces.tasks.get(f.a.id, task.id),
    state: 'pending',
    workerId: null,
  });
  const run = f.db.begin(f.a.id, {kind: 'run', taskId: task.id}),
    browserCalls = [];
  const browser = {
    evaluateJev: (_, state, questions) => f.ports.evaluate(state, questions),
    call: async (_, name, args) => {
      browserCalls.push(args.url);
      const page = {
        url: args.url,
        title: 'Current page',
        text: 'Current original content',
        links: [],
      };
      return {
        jevPage: page,
        pageContext: {url: page.url, tabId: 'owned'},
        content: [{type: 'text', text: 'Page URL: ' + page.url + '\n' + JSON.stringify(page)}],
      };
    },
  };
  const flow = automationWorkflow({
      db: f.db,
      run,
      signal: f.controller.signal,
      browser,
      report: () => {},
    }),
    call = (name, args) => flow.call(f.a.id, run.id, name, args);
  await call('read_listing_evidence', {evidenceId: evidence.id});
  assert.equal(f.db.run(run.id).observations.length, 0);
  await call('browser_open', {url});
  f.db.saveScanProgress(
    f.a.id,
    run.id,
    {pendingUrls: [child], reason: 'Follow the saved discovery'},
    {url, text: ''},
  );
  assert.ok(!f.db.run(run.id).observedLinks.includes(child));
  f.db.saveScanProgress(
    f.a.id,
    run.id,
    {pendingUrls: [], processedUrls: [child], reason: 'Earlier work complete'},
    {url, text: ''},
  );
  assert.equal(f.db.scanQueue(f.a.id, run.id).total, 0);
  await assert.rejects(
    call('browser_run_task', {operation: 'collect_details', url: foreign}),
    /observed/,
  );
  const result = await call('browser_run_task', {operation: 'collect_details', url: child});
  assert.equal(result.issue.reason, 'batch_ready');
  assert.deepEqual(browserCalls, [url, child]);
  assert.ok(f.db.run(run.id).observations.some((o) => o.url === child));
  assert.deepEqual(f.db.jevTasks.observedUrls('foreign-workspace', task.id, 'default'), []);
});

test('partial collection automatically classifies successful details, including documents with unread frames', async (t) => {
  const f = fixture(t),
    urls = ['broken', 'ready', 'frames'].map((s) => url + '/' + s),
    seen = [];
  f.ports.resolveDetails = () => urls.map((url) => ({url}));
  f.ports.browser = async (_, args) => {
    if (args.url === urls[0]) throw Error('Unavailable listing');
    return {
      url: args.url,
      title: 'One home',
      text: 'Original individual listing',
      reading: {unreadFrames: args.url === urls[2] ? 2 : 0},
    };
  };
  f.ports.evaluate = async (state, questions) => {
    if (questions.exclusion)
      return {
        answers: {
          support: answer('uncertain', questions.support.criteria),
          exclusion: answer('none', questions.exclusion.criteria),
        },
      };
    seen.push(state.listing.url);
    return {
      answers: {
        fit: answer(state.listing.unreadFrames ? 'mismatch' : 'possible', questions.fit.criteria),
      },
    };
  };
  const result = await f.run({operation: 'collect_details'});
  assert.equal(result.status, 'needs_agent');
  assert.deepEqual(result.issue.urls, [urls[0]]);
  assert.equal(result.classified, 2);
  assert.deepEqual(seen, urls.slice(1));
  assert.equal(result.items[1].assessment.decision, 'possible');
  assert.equal(
    result.items[2].assessment.decision,
    'uncertain',
    'an unverified contradiction cannot support a definitive exclusion',
  );
  assert.equal(result.items[2].assessment.reason, 'exclusion_unverified');
  const reused = await f.run({operation: 'classify_results', fromTaskId: result.taskId});
  assert.equal(reused.usage.calls, 0);
  assert.deepEqual(seen, urls.slice(1));
});

test('long detail classification resumes exact fragments without reopening or repeating assessed evidence', async (t) => {
  const f = fixture(t),
    text = 'Original text. '.repeat(33000) + 'EXACT_END',
    fragments = [];
  let opens = 0;
  f.ports.resolveDetails = () => [{url}];
  f.ports.browser = async () => {
    opens++;
    return {url, title: 'Individual home', text};
  };
  f.ports.evaluate = async (state, questions) => {
    fragments.push(state.listing.text);
    return {answers: {fit: answer('possible', questions.fit.criteria)}};
  };
  let result = await f.run({operation: 'collect_details'});
  assert.equal(result.status, 'continue');
  const saved = f.db.jevTasks.get(f.a.id, 'assigned', result.taskId);
  assert.ok(saved.items[0].triage.offset > 0);
  while (result.status === 'continue') result = await f.run({taskId: result.taskId});
  assert.equal(result.status, 'completed');
  assert.equal(result.items[0].assessment.decision, 'possible');
  assert.equal(fragments.join(''), text);
  assert.equal(opens, 1);
  assert.ok(fragments.every((s) => s.length <= 30000));
  assert.equal(
    (await f.run({operation: 'classify_results', fromTaskId: result.taskId})).usage.calls,
    0,
  );
  assert.equal(fragments.join(''), text);
  assert.ok(!JSON.stringify(result).includes('EXACT_END'));
});

test('a confirmed category page defers its sibling-shaped links without opening them', async (t) => {
  const f = fixture(t),
    board = 'https://example.test/jobs/governance',
    cats = [
      board.replace('governance', 'finance'),
      board.replace('governance', 'field-engineering'),
    ],
    listing = 'https://example.test/companies/acme/jobs/privacy-officer',
    opens = [];
  f.ports.browser = async (_, args) => {
    opens.push(args.url);
    return args.url === board
      ? {
          url: board,
          title: 'Governance jobs',
          text: 'Open roles',
          links: [
            {url: cats[0], text: 'Finanzanalyse'},
            {url: listing, text: 'Privacy Officer'},
            {url: cats[1], text: 'Field Engineering'},
          ],
          pagination: [],
        }
      : cats.includes(args.url)
        ? {
            url: args.url,
            title: 'Category',
            text: 'Many roles in this category',
            links: [],
            pagination: [],
          }
        : {
            url: args.url,
            title: 'Privacy Officer',
            text: 'Full individual listing',
            links: [],
            pagination: [],
          };
  };
  f.ports.evaluate = async (state, questions) => ({
    answers: Object.fromEntries(
      Object.entries(questions).map(([key, q]) => [
        key,
        answer(
          key === 'fit'
            ? cats.includes(state.listing.url)
              ? 'results'
              : 'possible'
            : key === 'next'
              ? 'end'
              : 'uncertain',
          q.criteria,
        ),
      ]),
    ),
  });
  const scan = await f.run({operation: 'scan_results', url: board});
  assert.equal(scan.total, 3);
  let details = await f.run({operation: 'collect_details', fromTaskId: scan.taskId});
  while (details.status === 'continue') details = await f.run({taskId: details.taskId});
  assert.equal(details.resultsPages, 2);
  assert.equal(details.classified, 1);
  const byUrl = Object.fromEntries(details.items.map((i) => [i.url, i]));
  assert.equal(byUrl[cats[0]].assessment.reason, 'results_page');
  assert.equal(byUrl[cats[1]].assessment.reason, 'results_page_shape');
  assert.equal(byUrl[listing].assessment.decision, 'possible');
  assert.ok(!opens.includes(cats[1]), 'the sibling category page is never opened');
  assert.ok(opens.includes(listing));
  const before = opens.length,
    again = await f.run({operation: 'collect_details', fromTaskId: scan.taskId});
  assert.equal(
    again.status,
    'completed',
    'known category pages do not reopen the discovery question',
  );
  assert.equal(again.resultsPages, 2);
  assert.deepEqual(
    opens.slice(before),
    [listing],
    'a later detail round reads only the listing, never the known category pages',
  );
  const root = await f.run({operation: 'scan_results', url});
  assert.ok(
    root.items.every((i) => i.resultsUrl === url || i.resultsUrl === undefined),
    'root-level boards keep reading every lead',
  );
});

test('two queued leads read as results pages prove their shape; later siblings are deferred unopened', async (t) => {
  const f = fixture(t),
    cats = [
      'https://example.test/jobs/finance',
      'https://example.test/jobs/sales',
      'https://example.test/jobs/legal',
      'https://example.test/jobs/ops',
    ],
    listing = 'https://example.test/companies/acme/jobs/officer',
    opens = [];
  f.ports.resolveDetails = () =>
    [cats[0], listing, cats[1], cats[2], cats[3]].map((url) => ({url}));
  f.ports.browser = async (_, args) => {
    opens.push(args.url);
    return cats.includes(args.url)
      ? {
          url: args.url,
          title: 'Category',
          text: 'Many roles in this category',
          links: [],
          pagination: [],
        }
      : {
          url: args.url,
          title: 'Officer',
          text: 'Full individual listing',
          links: [],
          pagination: [],
        };
  };
  f.ports.evaluate = async (state, questions) => ({
    answers: Object.fromEntries(
      Object.entries(questions).map(([key, q]) => [
        key,
        answer(
          key === 'fit'
            ? cats.includes(state.listing.url)
              ? 'results'
              : 'possible'
            : key === 'next'
              ? 'end'
              : 'listing',
          q.criteria,
        ),
      ]),
    ),
  });
  let result = await f.run({operation: 'collect_details'});
  while (result.status === 'continue') result = await f.run({taskId: result.taskId});
  assert.deepEqual(
    opens,
    [cats[0], listing, cats[1]],
    'the first two category pages are read; the third and fourth are deferred by shape',
  );
  assert.equal(result.resultsPages, 4);
  assert.equal(result.classified, 1);
  const byUrl = Object.fromEntries(result.items.map((i) => [i.url, i]));
  assert.equal(byUrl[cats[2]].assessment.reason, 'results_page_shape');
  assert.equal(byUrl[cats[3]].assessment.reason, 'results_page_shape');
});

test('apply and save links of a confirmed listing collapse into it instead of becoming leads', async (t) => {
  const f = fixture(t),
    board = 'https://example.test/jobs?q=compliance',
    one = 'https://example.test/viewjob?jk=abc1234567&tk=session1234567',
    two = 'https://example.test/viewjob?jk=def7654321&tk=session1234567';
  const apply = 'https://example.test/applystart?jk=abc1234567&from=vj&tk=session1234567',
    external =
      'https://apply.example.net/form?job=5aebe5a9-7e40&pingback=https%3A%2F%2Fexample.test%2Fconv%3Fjk%3Ddef7654321',
    unrelated = 'https://example.test/viewjob?jk=zzz0000001';
  f.ports.browser = async (_, args) => ({
    url: board,
    title: 'Results',
    text: 'Jobs',
    links: [
      {url: one, text: 'Compliance Officer'},
      {url: apply, text: 'Bewerben'},
      {url: two, text: 'Compliance Analyst'},
      {url: external, text: 'Apply now'},
      {url: unrelated, text: 'Something'},
    ],
    pagination: [],
  });
  f.ports.evaluate = async (state, questions) => ({
    answers: Object.fromEntries(
      Object.entries(questions).map(([key, q]) => [
        key,
        answer(
          key === 'next'
            ? 'end'
            : key.startsWith('link')
              ? [one, two].includes(state.links[key].url)
                ? 'listing'
                : 'uncertain'
              : 'possible',
          q.criteria,
        ),
      ]),
    ),
  });
  const scan = await f.run({operation: 'scan_results', url: board});
  assert.deepEqual(
    scan.items.map((i) => i.url).sort(),
    [one, two, unrelated].sort(),
    'action links sharing a listing identifier vanish; an uncertain link with its own identifier stays',
  );
  assert.equal(scan.confirmedListings, 2);
  assert.equal(scan.uncertainLinks, 1);
});

test('a detail deferred three times is not read again within the task scope', (t) => {
  const f = fixture(t),
    url = 'https://slow.example/job/1';
  for (let n = 0; n < 2; n++)
    f.db.jevTasks.deferDetail(f.a.id, 'assigned', url, {error: 'page_not_ready', retryAt: 0});
  assert.equal(
    f.db.jevTasks.detailWait(f.a.id, 'assigned', url),
    null,
    'two deferrals with an expired wait allow another read',
  );
  f.db.jevTasks.deferDetail(f.a.id, 'assigned', url, {error: 'page_not_ready', retryAt: 0});
  assert.equal(
    f.db.jevTasks.detailWait(f.a.id, 'assigned', url)?.attempts,
    3,
    'the third deferral ends reads for this scope',
  );
  assert.equal(
    f.db.jevTasks.detailWait(f.a.id, 'other-scope', url),
    null,
    'another task scope starts fresh',
  );
});

test('a results page is deferred until discovery is explicitly requested', async (t) => {
  const f = fixture(t),
    one = url + '/one',
    two = url + '/two',
    opens = [],
    checkpoints = [];
  f.ports.resolveDetails = () => [{url}];
  f.ports.browser = async (_, args) => {
    opens.push(args.url);
    return args.url === url
      ? {
          url,
          title: 'Search results',
          text: 'Two available homes',
          links: [
            {url: one, text: 'Home one'},
            {url: two, text: 'Home two'},
          ],
        }
      : {url: args.url, title: 'One home', text: 'Full individual listing'};
  };
  f.ports.evaluate = async (state, questions) => ({
    answers: Object.fromEntries(
      Object.entries(questions).map(([key, q]) => [
        key,
        answer(
          key === 'fit'
            ? state.listing.url === url
              ? 'results'
              : 'possible'
            : key === 'next'
              ? 'end'
              : 'listing',
          q.criteria,
        ),
      ]),
    ),
  });
  f.ports.checkpoint = async (page, urls) => checkpoints.push({page: page.url, urls});
  let result = await f.run({operation: 'collect_details'});
  while (result.status === 'continue') result = await f.run({taskId: result.taskId});
  assert.equal(result.status, 'needs_agent');
  assert.equal(result.issue.reason, 'discovery_required');
  assert.equal(result.resultsPages, 1);
  assert.equal(result.classified, 0);
  const board = result.items[0];
  assert.equal(board.detailComplete, false);
  assert.equal(board.assessment.reason, 'results_page');
  assert.equal(board.scanTaskId, undefined);
  assert.deepEqual(checkpoints, []);
  assert.deepEqual(opens, [url]);
  assert.equal(result.total, 1);
  const scan = await f.run({operation: 'scan_results', url});
  const details = await f.run({operation: 'collect_details', fromTaskId: scan.taskId});
  assert.equal(details.classified, 2);
  assert.deepEqual(
    details.items.map((i) => i.assessment.decision),
    ['possible', 'possible'],
  );
  assert.deepEqual(checkpoints, [{page: url, urls: [one, two]}]);
  assert.deepEqual(opens, [url, url, one, two]);
});

test('an assigned record never expands into a directory scan and an uncertain page type never discards its evidence', async (t) => {
  for (const record of [true, false]) {
    const f = fixture(t);
    f.ports.assignedRecord = record ? {url} : null;
    f.ports.resolveDetails = () => [{url}];
    f.ports.evaluate = async (_, q) => ({
      answers: {fit: answer('results', q.fit.criteria, record ? 1 : 0.8)},
    });
    const result = await f.run({operation: 'collect_details'});
    assert.equal(result.items[0].assessment.decision, 'uncertain');
    assert.ok(result.items[0].evidenceId);
    assert.equal(result.items[0].scanTaskId, undefined);
    assert.equal(f.calls.length, 1);
    assert.equal(result.status, record ? 'needs_agent' : 'completed');
  }
});

test('changed user criteria invalidate saved assessments while reusing the exact collected details', async (t) => {
  const f = fixture(t);
  f.ports.resolveDetails = () => [{url}];
  const first = await f.run({operation: 'collect_details'});
  assert.equal(first.usage.calls, 1);
  f.ports.evaluate = async (state, q) => {
    assert.equal(state.criteria.location, 'Paris');
    return {
      answers: q.fit
        ? {fit: answer('mismatch', q.fit.criteria)}
        : {
            support: answer('supported', q.support.criteria),
            exclusion: answer('hard_constraint', q.exclusion.criteria),
          },
    };
  };
  const next = await f.run({taskId: first.taskId}, {criteria: {location: 'Paris'}});
  assert.equal(next.items[0].assessment.decision, 'mismatch');
  assert.equal(next.usage.calls, 3);
  assert.equal(f.calls.length, 1);
});

test('legacy task summaries direct saved unclassified details to Jev without claiming they were already assessed', async (t) => {
  const f = fixture(t),
    saved = f.db.jevTasks.create(f.a.id, 'assigned', {operation: 'collect_details'});
  saved.items = [{url, collected: true, evidenceId: 'saved-body'}];
  saved.status = 'completed';
  assert.match(jevTaskSummary(saved).next, /operation=classify_results/);
  saved.status = 'needs_agent';
  saved.issue = {reason: 'detail_unavailable'};
  saved.items.push({url: url + '/bad', error: 'Unavailable'});
  assert.match(jevTaskSummary(saved).next, /operation=classify_results/);
  saved.status = 'completed';
  saved.items = [{url, detailComplete: false, evidenceId: 'card-only'}];
  assert.match(jevTaskSummary(saved).next, /operation=collect_details/);
});

test('resume tolerates identical operation arguments without permitting changed task inputs', async (t) => {
  const f = fixture(t);
  f.ports.resolveDetails = () => [{url}];
  const original = await f.run({
      operation: 'collect_details',
      url,
      goal: 'Read this individual home',
    }),
    before = f.calls.length;
  const resumed = await f.run({taskId: original.taskId, operation: 'collect_details', url});
  assert.equal(resumed.taskId, original.taskId);
  assert.equal(resumed.usage.calls, 1);
  assert.equal(f.calls.length, before);
  for (const args of [
    {operation: 'scan_results'},
    {url: url + '/other'},
    {goal: 'Different work'},
    {fromTaskId: original.taskId},
  ])
    await assert.rejects(f.run({taskId: original.taskId, ...args}), /inputs cannot be changed/);
  assert.equal(f.calls.length, before);
});

test('exclusions use 85 percent confidence in both stages without requiring quotes; a weak mismatch is rechecked on the brief', async (t) => {
  for (const [fitConfidence, confidence] of [
    [0.85, 0.85],
    [0.99, 0.9],
    [0.849, 0.99],
    [0.99, 0.849],
  ]) {
    const f = fixture(t),
      text = 'This property is in Paris. Viewings and tenancy require local residence.',
      proofs = [];
    f.ports.resolveDetails = () => [{url}];
    f.ports.browser = async () => ({url, text, reading: {unreadFrames: 3}});
    f.ports.evaluate = async (state, q) => {
      if (!q.fit) proofs.push(state.listing);
      return {
        answers: q.fit
          ? {fit: answer('mismatch', q.fit.criteria, fitConfidence)}
          : {
              support: answer('supported', q.support.criteria, confidence),
              exclusion: answer('hard_constraint', q.exclusion.criteria, 0.6),
            },
      };
    };
    const result = await f.run({operation: 'collect_details'}),
      item = result.items[0];
    assert.equal(item.unreadFrames, 3);
    // A confident fit is proven on the raw fragment; a weak or unproven one gets exactly one more proof on the brief sections.
    assert.equal(result.usage.calls, fitConfidence >= 0.85 && confidence < 0.85 ? 3 : 2);
    assert.equal(
      proofs.at(-1).selectedSections !== undefined,
      fitConfidence < 0.85 || confidence < 0.85,
    );
    const excluded = confidence >= 0.85;
    assert.equal(item.assessment.decision, excluded ? 'mismatch' : 'uncertain');
    if (excluded) {
      assert.equal(item.assessment.exclusion.quote, undefined);
      assert.equal(item.assessment.exclusion.evidenceId, item.evidenceId);
      assert.equal(item.assessment.reason, 'hard_constraint');
      assert.equal(item.assessment.exclusion.basis, fitConfidence < 0.85 ? 'brief' : undefined);
      assert.equal(
        item.assessment.confidence >= 0.85,
        true,
        'a brief-proven exclusion counts as confirmed in the review batch',
      );
    } else {
      assert.equal(item.assessment.exclusion, undefined);
      assert.equal(item.assessment.reason, 'exclusion_unverified');
    }
  }
});

test('exclusion verification resumes after a transport checkpoint without repeating its fit decision', async (t) => {
  const f = fixture(t);
  let time = 0,
    fitCalls = 0,
    proofCalls = 0;
  f.ports.resolveDetails = () => [{url}];
  f.ports.evaluate = async (state, q) => {
    if (q.fit) {
      fitCalls++;
      time = 26000;
      return {answers: {fit: answer('mismatch', q.fit.criteria)}};
    }
    proofCalls++;
    return {
      answers: {
        support: answer('supported', q.support.criteria),
        exclusion: answer('hard_constraint', q.exclusion.criteria),
      },
    };
  };
  const first = await f.run({operation: 'collect_details'}, {now: () => time});
  assert.equal(first.status, 'continue');
  assert.equal(fitCalls, 1);
  assert.equal(proofCalls, 0);
  const next = await f.run({taskId: first.taskId}, {now: () => time});
  assert.equal(next.status, 'completed');
  assert.equal(next.items[0].assessment.decision, 'mismatch');
  assert.equal(fitCalls, 1);
  assert.equal(proofCalls, 1);
  assert.equal(f.calls.length, 1);
});

test('collection stops before opening listing 21 and resumes only after its durable batch is reviewed', async (t) => {
  const f = fixture(t);
  f.ports.resolveDetails = () => Array.from({length: 25}, (_, i) => ({url: url + '/' + i}));
  let result = await f.run({operation: 'collect_details'});
  while (result.status === 'continue') result = await f.run({taskId: result.taskId});
  assert.equal(result.issue.reason, 'batch_ready');
  assert.equal(result.batch.total, 20);
  assert.equal(result.taskTotal, 25);
  assert.equal(
    result.items.length,
    20,
    'the pause lists the whole batch; no second read is needed',
  );
  assert.equal(f.calls.length, 20);
  const batch = result.batch.id,
    calls = result.usage.calls;
  assert.equal((await f.run({operation: 'collect_details'})).batch.id, batch);
  for (let i = 0; i < 2; i++) {
    const unchanged = await f.run({taskId: result.taskId});
    assert.equal(unchanged.batch.id, batch);
    assert.equal(unchanged.usage.calls, calls);
  }
  assert.equal(f.calls.length, 20);
  assert.throws(
    () => jevTaskSummary(f.db.jevTasks.get(f.a.id, 'assigned', result.taskId), {batchId: 'stale'}),
    /stale/,
  );
  await assert.rejects(
    f.run({taskId: result.taskId, reviewedBatchId: batch}),
    /verification is unavailable/,
  );
  f.ports.reviewBatch = async (task, items) => {
    assert.equal(task.batch.id, batch);
    assert.equal(items.length, 20);
  };
  result = await f.run({taskId: result.taskId, reviewedBatchId: batch});
  while (result.status === 'continue') result = await f.run({taskId: result.taskId});
  assert.equal(result.status, 'completed');
  assert.equal(f.calls.length, 25);
  assert.equal(result.usage.calls, 25);
  assert.equal(
    f.db.jevTasks.get(f.a.id, 'assigned', result.taskId).items.filter((i) => i.reviewed).length,
    20,
  );
});

test('legacy assessments are replaced using saved text, without reopening details or continuing child scans', async (t) => {
  const f = fixture(t);
  f.ports.resolveDetails = () => [{url}];
  const first = await f.run({operation: 'collect_details'}),
    task = f.db.jevTasks.get(f.a.id, 'assigned', first.taskId);
  delete task.classificationVersion;
  task.items[0].assessment = {decision: 'uncertain', confidence: 0.99, reason: 'partial_document'};
  task.items.push({
    url: url + '/board',
    pageKind: 'results',
    scanTaskId: 'historical-child',
    scanStatus: 'continue',
    assessment: {decision: 'uncertain', reason: 'results_page'},
  });
  f.db.jevTasks.save(task);
  const next = await f.run({taskId: first.taskId});
  assert.equal(next.status, 'needs_agent');
  assert.equal(next.issue.reason, 'discovery_required');
  assert.equal(next.items[0].assessment.decision, 'possible');
  assert.equal(f.calls.length, 1);
  assert.equal(next.total, 2);
  assert.equal(next.items[1].scanTaskId, 'historical-child');
});

test('resumed context prioritizes review work over child scans and refreshes legacy assessments before exposing their index', async (t) => {
  const f = fixture(t);
  f.ports.resolveDetails = () => [{url}];
  const first = await f.run({operation: 'collect_details'}),
    task = f.db.jevTasks.get(f.a.id, 'assigned', first.taskId);
  delete task.classificationVersion;
  f.db.jevTasks.save(task);
  const before = structuredClone(task),
    summary = jevTaskSummary(task);
  assert.equal(summary.assessmentRefreshRequired, true);
  assert.deepEqual(summary.items, []);
  assert.match(summary.next, /FIRST resume browser_run_task/);
  assert.deepEqual(task, before);
  for (let i = 0; i < 25; i++) {
    const scan = f.db.jevTasks.create(f.a.id, 'assigned', {operation: 'scan_results', url});
    scan.searchId = 'default';
    scan.status = 'completed';
    f.db.jevTasks.save(scan);
  }
  const review = f.db.jevTasks.create(f.a.id, 'assigned', {operation: 'collect_details'});
  review.searchId = 'default';
  review.batch = {id: 'batch', urls: [url]};
  f.db.jevTasks.save(review);
  const context = jevContextTasks(f.db.jevTasks.list(f.a.id, 'assigned'));
  assert.equal(context[0].taskId, review.id);
  assert.equal(context[1].taskId, task.id);
  assert.equal(context[1].assessmentRefreshRequired, true);
  assert.equal(context.length, 20);
  const resumed = await f.run({taskId: task.id});
  assert.equal(resumed.items[0].assessment.decision, 'possible');
  assert.equal(f.calls.length, 1);
});

test('workflow polls a long Jev request, prevents duplicate work and keeps the browser locked', async (t) => {
  const f = fixture(t),
    run = f.db.begin(f.a.id, 'run');
  let finish,
    started = 0;
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: f.controller.signal,
    report: () => {},
    jevWaitMs: 2,
    browser: {
      call: async () => {
        started++;
        await new Promise((resolve) => {
          finish = resolve;
        });
        const page = {url, title: 'Results', text: 'No listings', links: [], pagination: []};
        return {jevPage: page, content: [{type: 'text', text: `Page URL: ${url}\nNo listings`}]};
      },
      evaluateJev: (_id, state, questions) => f.ports.evaluate(state, questions),
    },
  });
  const call = (name, args = {}) => flow.call(f.a.id, run.id, name, args);
  const receipt = await call('browser_run_task', {operation: 'scan_results', url});
  assert.equal(receipt.status, 'running');
  assert.ok(receipt.taskId);
  assert.equal(
    (await call('browser_run_task', {operation: 'scan_results', url})).taskId,
    receipt.taskId,
  );
  assert.equal((await call('browser_open', {url: url + '/other'})).status, 'running');
  assert.equal(
    (await call('finish_automation_run', {status: 'completed', summary: 'Done'})).status,
    'running',
  );
  assert.equal((await call('read_browser_task', {taskId: receipt.taskId})).status, 'running');
  assert.equal(started, 1);
  assert.equal(f.db.run(run.id).status, 'running');
  finish();
  const completed = await call('read_browser_task', {taskId: receipt.taskId});
  assert.equal(completed.status, 'needs_agent');
  assert.equal(
    completed.issue.reason,
    'no_listing_links',
    'a page without listing links is never completed silently',
  );
  assert.equal(started, 1);
  assert.equal(f.db.jevTasks.list(f.a.id, run.taskId ?? run.id).length, 1);
});

test('a foreign ID while a Jev request runs waits for that request and names its real taskId', async (t) => {
  const f = fixture(t),
    run = f.db.begin(f.a.id, 'run');
  let finish;
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: f.controller.signal,
    report: () => {},
    jevWaitMs: 2,
    browser: {
      call: async () => {
        await new Promise((resolve) => {
          finish = resolve;
        });
        const page = {url, title: 'Results', text: 'No listings', links: [], pagination: []};
        return {jevPage: page, content: [{type: 'text', text: `Page URL: ${url}\nNo listings`}]};
      },
      evaluateJev: (_id, state, questions) => f.ports.evaluate(state, questions),
    },
  });
  const call = (name, args = {}) => flow.call(f.a.id, run.id, name, args);
  const receipt = await call('browser_run_task', {operation: 'scan_results', url});
  assert.equal(receipt.status, 'running');
  // The agent client moved the call to the background and gave its own ID.
  const waiting = await call('read_browser_task', {taskId: 'k6drgpagj'});
  assert.equal(waiting.status, 'running');
  assert.equal(waiting.taskId, receipt.taskId);
  assert.match(waiting.note, /"k6drgpagj" is not a Jev task ID/);
  assert.ok(waiting.note.includes(receipt.taskId));
  finish();
  const done = await call('read_browser_task', {taskId: 'k6drgpagj'});
  assert.equal(done.taskId, receipt.taskId);
  assert.equal(done.status, 'needs_agent');
  assert.match(done.note, /Use that taskId from now on/);
  await assert.rejects(
    call('read_browser_task', {taskId: 'k6drgpagj'}),
    (error) =>
      /is not a Jev task ID of this task/.test(error.message) &&
      error.message.includes(`${receipt.taskId} (scan_results,`),
    'once the result was delivered, a foreign ID lists the real Jev tasks',
  );
  assert.equal((await call('read_browser_task', {taskId: receipt.taskId})).taskId, receipt.taskId);
});

test('helper state and bodies never enter SQLite and expire in a new app instance', (t) => {
  const f = fixture(t),
    task = f.db.jevTasks.create(f.a.id, 'assigned', {operation: 'collect_details'}),
    evidence = f.db.jevTasks.evidence(task, {url, text: 'RAM_ONLY_SENTINEL'});
  assert.equal(
    f.db.jevTasks.fullEvidence(f.a.id, 'assigned', evidence.id).text,
    'RAM_ONLY_SENTINEL',
  );
  assert.deepEqual(
    f.core.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('automation_jev_tasks','automation_jev_evidence')",
      )
      .all(),
    [],
  );
  const next = new AutomationStore(f.core);
  assert.deepEqual(next.jevTasks.list(f.a.id, 'assigned'), []);
  assert.notEqual(next.jevTasks.epoch, f.db.jevTasks.epoch);
  assert.throws(() => next.jevTasks.get(f.a.id, 'assigned', task.id), /end when the app restarts/);
  assert.throws(() => next.jevTasks.fullEvidence(f.a.id, 'assigned', evidence.id), /expired/);
  const other = f.db.jevTasks.create(f.a.id, 'other', {operation: 'collect_details'}),
    kept = f.db.jevTasks.evidence(other, {url, text: 'Keep other task'});
  f.db.jevTasks.release(f.a.id, 'assigned');
  assert.throws(() => f.db.jevTasks.fullEvidence(f.a.id, 'assigned', evidence.id), /expired/);
  assert.equal(f.db.jevTasks.fullEvidence(f.a.id, 'other', kept.id).text, 'Keep other task');
});

test('failed source import rolls back temporary helper data along with the parent queue', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.db.jevTasks.atomic(() =>
        f.core.workspaces.tasks.atomic(() => {
          const task = f.db.jevTasks.create(f.a.id, 'assigned', {operation: 'collect_details'});
          f.db.jevTasks.evidence(task, {url, text: 'Temporary import'});
          f.core.workspaces.tasks.enqueue(f.a.id, {id: 'pending-import', operation: 'scan'});
          throw Error('Queue failed');
        }),
      ),
    /Queue failed/,
  );
  assert.deepEqual(f.db.jevTasks.list(f.a.id, 'assigned'), []);
  assert.equal(f.db.jevTasks.bodies.size, 0);
  assert.throws(() => f.core.workspaces.tasks.get(f.a.id, 'pending-import'), /does not belong/);
});

test('discovery retires explicit card conflicts at 85 percent without opening details or creating records', async (t) => {
  const f = fixture(t),
    irrelevant = url + '/surgeon',
    alias = irrelevant + '#:~:text=Surgeon',
    borderline = url + '/adjacent',
    relevant = url + '/legal',
    navigation = url + '/directory',
    unlikely = url + '/driver';
  const queued = f.core.workspaces.tasks.enqueue(f.a.id, {
      operation: 'scan',
      capability: 'browser.observe',
      sourceUrl: url,
      sources: [url],
      lockKey: 'source:' + url,
    }),
    run = f.db.begin(f.a.id, {kind: 'run', taskId: queued.id});
  f.db.observe(f.a.id, run.id, url, 'Previous queue', [irrelevant, alias, borderline, relevant]);
  f.db.saveScanProgress(
    f.a.id,
    run.id,
    {pendingUrls: [irrelevant, alias, borderline, relevant], reason: 'Earlier scan'},
    {url, text: 'Previous queue'},
  );
  const opened = [];
  const browser = {
    call: async (_, name, args) => {
      opened.push(args.url);
      const page = {
        url,
        title: 'Careers',
        text: 'Final page',
        links: [
          {url: irrelevant, text: 'Surgeon - AI Trainer'},
          {url: alias, text: 'Surgeon - AI Trainer'},
          {url: borderline, text: 'Compliance advisor'},
          {url: relevant, text: 'Legal counsel'},
          {url: navigation, text: 'All companies'},
          {url: unlikely, text: 'Truck driver'},
        ],
      };
      return {
        jevPage: page,
        pageContext: {url, tabId: 'owned'},
        content: [{type: 'text', text: 'Page URL: ' + url + '\n' + JSON.stringify(page)}],
      };
    },
    evaluateJev: async (_, state, questions) => {
      if (state.links) {
        assert.deepEqual(state.criteria.criteria, f.a.criteria);
        assert.match(state.discoveryRules, /neighboring cards/);
        for (const q of Object.values(questions).filter((q) => q.criteria?.listing)) {
          assert.equal(
            q.criteria.unrelated_role,
            undefined,
            'what a link opens and how it fits are separate questions',
          );
          assert.doesNotMatch(
            q.criteria.uncertain,
            /relevant/,
            'uncertain is about the link, so real listings do not split between two keep answers',
          );
        }
        for (const q of Object.values(questions).filter((q) => q.criteria?.keep))
          assert.ok(
            q.criteria.unrelated_role && !q.criteria.listing,
            'fit offers keep or an exclusion, never "listing"',
          );
      }
      return {
        answers: Object.fromEntries(
          Object.entries(questions).map(([key, q]) => {
            const link = state.links?.[key.replace(/^fit/, 'link')],
              decision =
                key === 'next'
                  ? 'end'
                  : link.url === irrelevant || link.url === borderline
                    ? 'unrelated_role'
                    : link.url === navigation
                      ? 'other'
                      : 'listing';
            // Below 85% for one reason: a 35% keep stays, a 20% keep is eliminated by its total exclusion.
            if (key.startsWith('fit') && [borderline, unlikely].includes(link.url)) {
              const keep = link.url === borderline ? 0.35 : 0.2,
                probabilities = {
                  keep,
                  unrelated_role: 0.45,
                  hard_constraint: 0.55 - keep,
                  qualification: 0,
                };
              return [key, {choice: 'unrelated_role', confidence: 0.45, probabilities}];
            }
            return [key, answer(decision, q.criteria, link?.url === borderline ? 0.849 : 0.85)];
          }),
        ),
      };
    },
  };
  // Pagination still requires 90%; leave coverage pending even after filtering.
  const flow = automationWorkflow({
    db: f.db,
    run,
    signal: f.controller.signal,
    browser,
    report: () => {},
  });
  const result = await flow.call(f.a.id, run.id, 'browser_run_task', {
    operation: 'scan_results',
    url,
  });
  assert.equal(result.issue.reason, 'pagination_uncertain');
  assert.equal(result.lastPage.rejectedListings, 2);
  assert.equal(result.lastPage.excludedNavigation, 1);
  assert.deepEqual(
    new Set(f.db.scanQueue(f.a.id, run.id).pendingUrls),
    new Set([borderline, relevant]),
  );
  assert.deepEqual(
    f.db.run(run.id).scan.work.searches[0].cards[relevant],
    {title: 'Legal counsel', keep: 1, risk: {reason: 'hard_constraint', p: 0}},
    "a waiting listing shows Jev's card probabilities",
  );
  assert.deepEqual(
    f.db.run(run.id).scan.work.searches[0].excluded,
    [
      {
        url: irrelevant,
        title: 'Surgeon - AI Trainer',
        reason: 'unrelated_role',
        stage: 'card',
        by: 'jev',
        confidence: 0.85,
      },
      {
        url: unlikely,
        title: 'Truck driver',
        reason: 'unrelated_role',
        stage: 'card',
        by: 'jev',
        confidence: 0.8,
      },
    ],
    'the source memory lists what the card stage eliminated',
  );
  assert.equal(f.db.results(f.a.id).length, 0);
  assert.deepEqual(opened, [url]);
  const index = await flow.call(f.a.id, run.id, 'read_browser_task', {taskId: result.taskId});
  assert.equal(index.items.find((i) => i.url === borderline).discovery.decision, 'uncertain');
  assert.equal(f.db.run(run.id).status, 'running');
});

test('source result schema omits record-only identity and proposal while assigned records retain them', (t) => {
  const f = fixture(t),
    run = f.db.begin(f.a.id, 'run');
  const schema = (assigned) =>
    automationWorkflow({
      db: f.db,
      run: {...run, ...assigned},
      signal: f.controller.signal,
      browser: {},
      report: () => {},
    }).tools.find((tool) => tool.name === 'record_automation_result').inputSchema;
  for (const key of ['recordId', 'actionUrl', 'proposal']) {
    assert.equal(schema({}).properties[key], undefined);
    assert.ok(schema({recordId: 'assigned'}).properties[key]);
  }
  assert.ok(schema({}).properties.score);
  assert.ok(schema({}).properties.url);
});

test('invalid provider answers retry only the failing question once and account for both calls', async () => {
  const questions = Object.fromEntries(
      ['good', 'bad'].map((key) => [key, {type: 'choice', criteria: {keep: 'Keep', drop: 'Drop'}}]),
    ),
    requests = [];
  const result = await askJev({text: 'Saved original evidence'}, questions, {
    apiKey: 'test',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      return {
        ok: true,
        json: async () => ({
          answers: Object.fromEntries(
            Object.entries(request.questions).map(([key, q]) => [
              key,
              {
                ...answer(key === 'good' ? 'drop' : 'keep', q.criteria),
                ...(key === 'bad' && requests.length === 1
                  ? {probabilities: {keep: 0.4, drop: 0.1}}
                  : {}),
              },
            ]),
          ),
          usage: {input_tokens: 100, output_tokens: 10},
        }),
      };
    },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(Object.keys(requests[1].questions), ['bad']);
  assert.deepEqual(requests[1].state, requests[0].state);
  assert.equal(result.answers.good.choice, 'drop');
  assert.equal(result.answers.bad.choice, 'keep');
  assert.equal(result.requestCount, 2);
  assert.deepEqual(result.usage, {input_tokens: 200, output_tokens: 20});
});

test('persistent invalid responses stop after one repair and cancellation never launches a repair', async () => {
  const questions = {fit: {type: 'choice', criteria: {keep: 'Keep'}}};
  let calls = 0;
  await assert.rejects(
    askJev({}, questions, {
      apiKey: 'test',
      fetchImpl: async () => {
        calls++;
        return {
          ok: true,
          json: async () => ({
            answers: {fit: {choice: 'keep', confidence: 1, probabilities: {keep: 0.3}}},
          }),
        };
      },
    }),
    (error) =>
      error.code === 'JEV_INVALID_RESPONSE' &&
      /fit:.*sum to/.test(error.message) &&
      error.requestCount === 2,
  );
  assert.equal(calls, 2);
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(
    askJev({}, questions, {
      apiKey: 'test',
      signal: controller.signal,
      fetchImpl: async () => {
        calls++;
        controller.abort();
        return {ok: true, json: async () => ({answers: {}})};
      },
    }),
    {name: 'AbortError'},
  );
  assert.equal(calls, 1);
});

test('source discovery follows observed Next buttons without raw page handoffs or URL guesses', async (t) => {
  const f = fixture(t);
  let current = 1;
  const actions = [];
  f.ports.browser = async (name, args) => {
    actions.push({name, args});
    if (name === 'click') {
      assert.equal(args.targetId, 'next-' + current);
      current++;
    }
    return {
      url,
      text: 'Results page ' + current,
      links: [{url: url + '/job-' + current, text: 'Role ' + current}],
      pagination: [
        {text: `${current} of 3`, current: true},
        {text: 'Next', url: null, targetId: 'next-' + current, disabled: current === 3},
      ],
    };
  };
  f.ports.evaluate = async (state, q) => ({
    answers: Object.fromEntries(
      Object.entries(q).map(([key, question]) => [
        key,
        answer(
          key === 'next' ? (state.position.currentPage < 3 ? '0' : 'end') : 'listing',
          question.criteria,
        ),
      ]),
    ),
  });
  let result = await f.run({operation: 'scan_results', url});
  while (result.status === 'continue') result = await f.run({taskId: result.taskId});
  assert.equal(result.status, 'completed');
  assert.equal(result.total, 3);
  assert.equal(actions.filter((a) => a.name === 'click').length, 2);
  assert.deepEqual(
    actions.filter((a) => a.name === 'open').map((a) => a.args.url),
    [url],
  );
  assert.equal(result.lastPage.position.currentPage, 3);
});

test('offscreen pagination is revealed once and then uses the fresh click target', async (t) => {
  const f = fixture(t);
  let revealed = false,
    current = 1;
  f.ports.browser = async (name, args) => {
    f.calls.push({name, args});
    if (name === 'reveal') {
      assert.equal(args.controlId, 'offscreen');
      revealed = true;
    }
    if (name === 'click') {
      assert.equal(args.targetId, 'fresh');
      current = 2;
    }
    return {
      url,
      text: 'Page ' + current,
      links: [],
      pagination: [
        {text: `${current} of 2`, current: true},
        {
          text: 'Next',
          disabled: current === 2,
          ...(revealed ? {targetId: 'fresh'} : {controlId: 'offscreen'}),
        },
      ],
    };
  };
  f.ports.evaluate = async (state, q) => ({
    answers: {next: answer(state.position.currentPage === 1 ? '0' : 'end', q.next.criteria)},
  });
  const result = await f.run({operation: 'scan_results', url});
  assert.equal(result.status, 'completed');
  assert.deepEqual(
    f.calls.map((a) => a.name),
    ['open', 'reveal', 'click'],
  );
});

test('an unconfirmed pagination click is never replayed on a helper retry', async (t) => {
  const f = fixture(t);
  f.ports.browser = async (name, args) => {
    f.calls.push({name, args});
    return {
      url,
      text: 'Unchanged results',
      links: [],
      pagination: [{text: 'Next', targetId: 'next'}],
      ...(name === 'click' ? {status: 'uncertain'} : {}),
    };
  };
  f.ports.evaluate = async (_state, q) => ({answers: {next: answer('0', q.next.criteria)}});
  const first = await f.run({operation: 'scan_results', url});
  assert.equal(first.issue.reason, 'pagination_action_unconfirmed');
  assert.equal(first.lastPage.pagination[0].targetId, 'next');
  const next = await f.run({taskId: first.taskId});
  assert.equal(next.issue.reason, 'pagination_action_unconfirmed');
  assert.equal(f.calls.filter((c) => c.name === 'click').length, 1);
});

test('unmarked numeric pagination advances via exact observed links without a Jev navigation decision', async (t) => {
  const f = fixture(t),
    root = url + '?radius=30';
  let current = 1,
    questions = 0;
  f.ports.browser = async (name, args) => {
    f.calls.push({name, args});
    current = Number(new URL(args.url).searchParams.get('page') ?? 1);
    return {
      url: args.url,
      text: 'Page ' + current,
      links: [],
      pagination: [
        {text: 'Previous', disabled: current === 1},
        ...[1, 2, 3].map((n) => ({text: n + ' of 3', url: root + '&page=' + n, current: false})),
        {text: 'Next', disabled: current === 3},
      ],
    };
  };
  f.ports.evaluate = async () => {
    questions++;
    throw Error('The last page of a shown page count needs no Jev decision.');
  };
  const result = await f.run({operation: 'scan_results', url: root});
  assert.equal(result.status, 'completed');
  assert.equal(questions, 0);
  assert.deepEqual(
    f.calls.map((c) => c.args.url),
    [root, root + '&page=2', root + '&page=3'],
  );
  const saved = f.db.jevTasks.get(f.a.id, 'assigned', result.taskId);
  assert.deepEqual(
    saved.pages.map((p) => p.position.currentPage),
    [1, 2, 3],
  );
  assert.equal(saved.pages[0].continuation.method, 'observed_page_number');
  assert.equal(saved.pages[2].continuation.method, 'observed_page_count');
});

test('late job descriptions stay in the same tab and are classified only when ready', async (t) => {
  for (const success of [true, false]) {
    const f = fixture(t),
      actions = [];
    f.ports.recoverDetails = true;
    f.ports.resolveDetails = () => [{url}];
    f.ports.browser = async (action) => {
      actions.push(action);
      const loading = !(success && actions.length === 3);
      return {
        url,
        text: loading ? 'Header and footer' : 'Complete description',
        reading: {readiness: {loading, reason: loading ? 'aria_busy' : null}},
      };
    };
    const result = await f.run({operation: 'collect_details'});
    assert.deepEqual(actions, ['open', 'observe', 'observe']);
    assert.equal(result.usage.calls, success ? 1 : 0);
    if (success) assert.equal(result.status, 'completed');
    else {
      assert.equal(result.items[0].error, 'page_not_ready');
      assert.equal(result.items[0].evidenceId, null);
      assert.ok(result.items[0].retryAt > Date.now());
    }
  }
});

test('late-description recovery reopens the assigned URL if the tab moved', async (t) => {
  const f = fixture(t),
    actions = [];
  f.ports.recoverDetails = true;
  f.ports.resolveDetails = () => [{url}];
  f.ports.browser = async (action) => {
    actions.push(action);
    return action === 'open'
      ? {url, text: 'Header', reading: {readiness: {loading: true, reason: 'aria_busy'}}}
      : action === 'observe'
        ? {url: 'https://foreign.test', text: 'Wrong listing'}
        : {url, text: 'Correct listing'};
  };
  const result = await f.run({operation: 'collect_details'});
  assert.deepEqual(actions, ['open', 'observe', 'reopen']);
  assert.equal(result.usage.calls, 1);
});

test('tracking-parameter aliases share one assessment without merging jobs or changing navigation', async (t) => {
  const f = fixture(t),
    base = 'https://example.test/jobs/view/4462650854',
    original = base + '/?utm_source=one&trk=two&gclid=search',
    alias = base + '?utm_source=other&trackingId=three';
  f.ports.resolveDetails = () => [original, alias, base + '?job=2'].map((url) => ({url}));
  const result = await f.run({operation: 'collect_details'});
  assert.equal(result.total, 2);
  assert.equal(result.usage.calls, 2);
  assert.deepEqual(
    f.calls.map((c) => c.args.url),
    [original, base + '?job=2'],
  );
  assert.notEqual(jevDetailKey(base), jevDetailKey(base.replace('4462650854', '4462650855')));
  assert.notEqual(
    jevDetailKey('https://example.test/jobs/view/123?refId=1'),
    jevDetailKey('https://example.test/jobs/view/123?refId=2'),
    'site-specific parameter names stay meaningful',
  );
  assert.throws(() => jevDetailItems({url: base}, {observedUrls: [original]}), /observed/);
});

test('pagination scrolls its observed container without repeating card classification or checkpoint', async (t) => {
  const f = fixture(t);
  let scrolled = 0,
    current = 1,
    classified = 0,
    checkpoints = 0;
  f.ports.checkpoint = async () => {
    checkpoints++;
    return {saved: true};
  };
  f.ports.browser = async (name, args) => {
    f.calls.push({name, args});
    if (name === 'scroll') {
      assert.equal(args.controlId, 'results');
      scrolled++;
    }
    if (name === 'click') {
      assert.equal(args.targetId, 'next');
      current = 2;
    }
    return {
      url,
      text: 'Results ' + current,
      links: [{url: url + '/job-' + current, text: 'Role'}],
      scrollTargets: [
        {controlId: 'wrong-detail', atBottom: false},
        {controlId: 'results', atBottom: false},
      ],
      pagination: [
        {text: `Sayfa ${current}/2`, current: true},
        {
          text: 'Sonraki sayfayı görüntüle',
          disabled: current === 2,
          ...(scrolled >= 2 ? {targetId: 'next'} : {scrollControlId: 'results'}),
        },
      ],
    };
  };
  f.ports.evaluate = async (state, qs) => ({
    answers: Object.fromEntries(
      Object.entries(qs).map(([key, q]) => {
        if (key.startsWith('link')) classified++;
        else if (key === 'next') assert.equal(current, 2);
        return [key, answer(key === 'next' ? 'end' : 'listing', q.criteria)];
      }),
    ),
  });
  let result = await f.run({operation: 'scan_results', url});
  while (result.status === 'continue') result = await f.run({taskId: result.taskId});
  assert.equal(result.status, 'completed');
  assert.equal(scrolled, 2);
  assert.equal(classified, 2);
  assert.equal(checkpoints, 2);
  assert.equal(result.pageCount, 2);
  const pages = f.db.jevTasks.get(f.a.id, 'assigned', result.taskId).pages;
  assert.notEqual(pages[0].evidenceId, pages[1].evidenceId);
  assert.equal(
    f.db.jevTasks.fullEvidence(f.a.id, 'assigned', pages[0].evidenceId).text,
    'Results 1',
  );
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['open', 'scroll', 'scroll', 'click'],
  );
});

test('pagination reveal is bounded across transport slices and never guesses another container', async (t) => {
  const f = fixture(t);
  f.ports.browser = async (name, args) => {
    f.calls.push({name, args});
    return {
      url,
      text: 'Results',
      links: [],
      scrollTargets: [{controlId: 'results', atBottom: false}],
      pagination: [
        {text: '1 of 40', current: true},
        {text: 'Next', scrollControlId: 'results'},
      ],
    };
  };
  f.ports.evaluate = async () => {
    throw Error('No model decision needed while revealing observed Next');
  };
  let result = await f.run({operation: 'scan_results', url});
  while (result.status === 'continue') result = await f.run({taskId: result.taskId});
  assert.equal(result.issue.reason, 'pagination_uncertain');
  assert.equal(f.calls.filter((c) => c.name === 'scroll').length, 8);
  result = await f.run({taskId: result.taskId});
  assert.equal(result.issue.reason, 'pagination_uncertain');
  assert.equal(f.calls.filter((c) => c.name === 'scroll').length, 8);
});

test('generic incomplete content waits in place on arbitrary URLs and evaluates only changed text', async (t) => {
  for (const address of [
    'https://a.test/123',
    'https://b.test/details/descriptive-title',
    'https://c.test/?offer=one',
    'https://d.test/#/offer/abc',
  ]) {
    const f = fixture(t),
      actions = [],
      evaluated = [];
    let reads = 0;
    f.ports.wait = async () => {};
    f.ports.resolveDetails = () => [{url: address}];
    f.ports.browser = async (action) => {
      actions.push(action);
      return {
        url: address,
        title: 'Offer',
        text: ++reads < 4 ? 'Title, navigation and footer' : 'Berlin, 2 rooms, rent 1500',
      };
    };
    f.ports.evaluate = async (state, q) => {
      evaluated.push(state.listing.text);
      return {
        answers: {
          fit: answer(
            state.listing.text.includes('2 rooms') ? 'possible' : 'incomplete',
            q.fit.criteria,
          ),
        },
      };
    };
    const result = await f.run({operation: 'collect_details'});
    assert.equal(result.status, 'completed');
    assert.equal(result.classified, 1);
    assert.deepEqual(actions, ['open', 'observe', 'observe', 'observe']);
    assert.equal(evaluated.length, 2);
    assert.equal(
      f.db.jevTasks.fullEvidence(f.a.id, 'assigned', result.items[0].evidenceId).text,
      'Berlin, 2 rooms, rent 1500',
    );
  }
});

test('a permanent shell is deferred in RAM with no repeated model calls and other details continue', async (t) => {
  const f = fixture(t),
    actions = [];
  f.ports.wait = async () => {};
  f.ports.resolveDetails = () => [{url: url + '/empty'}, {url: url + '/complete'}];
  f.ports.browser = async (action, args) => {
    actions.push(action);
    return {
      url: args.url,
      text: args.url.endsWith('/empty') ? 'Navigation only' : 'Substantive detail',
    };
  };
  f.ports.evaluate = async (state, q) => ({
    answers: {
      fit: answer(
        state.listing.text === 'Navigation only' ? 'incomplete' : 'possible',
        q.fit.criteria,
      ),
    },
  });
  let result = await f.run({operation: 'collect_details'});
  while (result.status === 'continue') result = await f.run({taskId: result.taskId});
  assert.equal(result.issue.reason, 'detail_unavailable');
  assert.equal(result.classified, 1);
  assert.equal(result.usage.calls, 2);
  assert.equal(result.items[0].evidenceId, null);
  assert.equal(result.items[0].detailComplete, false);
  assert.equal(result.items[0].error, 'page_not_ready');
  assert.equal(actions.filter((a) => a === 'open').length, 2);
  assert.equal(actions.filter((a) => a === 'observe').length, 10);
  f.ports.resolveDetails = () => [{url: url + '/empty'}];
  result = await f.run({operation: 'collect_details'});
  assert.equal(result.usage.calls, 0);
  assert.equal(actions.length, 12);
});

test('partial fragments, short listings, missing optional facts and terminal pages do not trigger loading retries', async (t) => {
  for (const text of [
    'Berlin. 2 rooms. Rent 1500.',
    'Original responsibilities; salary unspecified.',
    'This opportunity has closed.',
    'Navigation\n'.repeat(3000) + 'SUBSTANTIVE DETAIL: Berlin, 2 rooms, rent 1500',
  ]) {
    const f = fixture(t);
    f.ports.resolveDetails = () => [{url}];
    f.ports.wait = async () => {
      assert.fail('This document must not be treated as a shell');
    };
    f.ports.browser = async (action, args) => {
      f.calls.push({action, args});
      return {url, text};
    };
    f.ports.evaluate = async (state, q) => ({
      answers: {
        fit: answer(
          state.listing.text.startsWith('Navigation') &&
            !state.listing.text.includes('SUBSTANTIVE DETAIL')
            ? 'incomplete'
            : text.includes('unspecified')
              ? 'uncertain'
              : 'possible',
          q.fit.criteria,
        ),
      },
    });
    const result = await f.run({operation: 'collect_details'});
    assert.equal(result.status, 'completed');
    assert.equal(result.classified, 1);
    assert.equal(f.calls.length, 1);
  }
});

test('incomplete-content waits respect cancellation and never classify another tab destination', async (t) => {
  const f = fixture(t);
  f.ports.resolveDetails = () => [{url}];
  f.ports.browser = async (action) => {
    f.calls.push(action);
    return {url, text: 'Only title'};
  };
  f.ports.evaluate = async (_state, q) => ({answers: {fit: answer('incomplete', q.fit.criteria)}});
  f.ports.wait = async (_ms, signal) => {
    assert.equal(signal, f.controller.signal);
    f.controller.abort();
  };
  await assert.rejects(f.run({operation: 'collect_details'}), {name: 'AbortError'});
  assert.deepEqual(f.calls, ['open']);
  const g = fixture(t);
  g.ports.wait = async () => {};
  g.ports.resolveDetails = () => [{url}];
  g.ports.browser = async (action) => {
    g.calls.push(action);
    return {
      url: action === 'open' ? url : 'https://foreign.test',
      text: action === 'open' ? 'Only title' : 'Another item',
    };
  };
  g.ports.evaluate = async (state, q) => {
    assert.equal(state.listing.text, 'Only title');
    return {answers: {fit: answer('incomplete', q.fit.criteria)}};
  };
  const result = await g.run({operation: 'collect_details'});
  assert.equal(result.issue.reason, 'detail_unavailable');
  assert.equal(result.usage.calls, 1);
  assert.equal(result.classified, 0);
});

test('a changing shell has a bounded number of semantic checks and an elapsed-time deadline', async (t) => {
  for (const expired of [false, true]) {
    const f = fixture(t);
    let time = 1000,
      reads = 0;
    f.ports.resolveDetails = () => [{url}];
    f.ports.wait = async () => {
      if (expired) time += 20001;
    };
    f.ports.browser = async () => ({url, text: 'Navigation only ' + ++reads});
    f.ports.evaluate = async (_state, q) => ({
      answers: {fit: answer('incomplete', q.fit.criteria)},
    });
    let result = await f.run({operation: 'collect_details'}, {now: () => time});
    while (result.status === 'continue')
      result = await f.run({taskId: result.taskId}, {now: () => time});
    assert.equal(result.issue.reason, 'detail_unavailable');
    assert.ok(result.usage.calls <= 3);
    assert.ok(reads <= 3);
  }
});

test('HTTP reader searches and postings are read without a tab; marked listings survive triage but not an explicit conflict', async (t) => {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  db.siteAccess.pace = () => 0; // No real gap between the fake responses.
  const search = 'https://berlinstartupjobs.com/engineering/';
  const a = db.create('housing', {
    goal: 'Backend jobs',
    criteria: {location: 'Germany', budget: '2000', requirements: 'backend'},
    sources: [search],
    agentSettings: {provider: 'codex', decisions: 'jev'},
  });
  db.save(a.id, {browserMode: 'jev'});
  db.review(a.id);
  const controller = new AbortController(),
    task = core.workspaces.tasks.enqueue(a.id, {
      operation: 'scan',
      capability: 'browser.observe',
      sourceUrl: search,
      sources: [search],
      lockKey: 'source:' + search,
    }),
    run = db.begin(a.id, {kind: 'run', taskId: task.id});
  const card = (id, title) =>
    `<li class="bjs-jlid"><div class="bjs-jlid__wrapper"><h4 class="bjs-jlid__h"><a href="${search}${title.toLowerCase().replaceAll(' ', '-')}-${id}/">${title}</a></h4><a class="bjs-jlid__b" href="https://berlinstartupjobs.com/companies/acme/">Acme</a><div class="bjs-jlid__description">Build services in Berlin.</div></div></li>`;
  const ids = Array.from({length: 12}, (_, n) => String(4100000000 + n)),
    titles = ids.map((_, n) => (n === 3 ? 'Truck Driver' : `Backend Engineer ${n}`));
  const fetched = [],
    realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = async (target) => {
    fetched.push(target);
    const u = new URL(target);
    if (!/^\/engineering\/(page\/2\/)?$/.test(u.pathname))
      return new Response(
        `<html><head><title>Backend Engineer</title><script type="application/ld+json">${JSON.stringify({'@type': 'JobPosting', title: 'Backend Engineer', description: 'Go services, Berlin hybrid. '.repeat(10), hiringOrganization: {name: 'Acme'}})}</script></head><body><h1>Backend Engineer</h1></body></html>`,
      );
    const start = u.pathname.includes('page/2') ? 10 : 0;
    return new Response(
      `<html><head><title>Engineering | Berlin Startup Jobs</title></head><body><ul class="jobs-list-items">${ids
        .slice(start, start + 10)
        .map((id, n) => card(id, titles[start + n]))
        .join(
          '',
        )}</ul><div class="pagination">${start ? '' : `<a class="next page-numbers" href="${search}page/2/">Next</a>`}</div></body></html>`,
    );
  };
  const asked = [];
  const browser = {
    call: async () => {
      throw Error('Reader pages must not open a browser tab');
    },
    evaluateJev: async (_, state, questions) => {
      asked.push(Object.keys(questions));
      return {
        answers: Object.fromEntries(
          Object.entries(questions).map(([key, q]) => {
            const ref = q.instructions.match(/`links\.(link\d+)`/)?.[1],
              link = state.links?.[ref];
            // The model calls every card navigation; only the truck driver is an explicit conflict.
            return [
              key,
              answer(
                key === 'next'
                  ? 'end'
                  : link
                    ? link.text === 'Truck Driver'
                      ? 'unrelated_role'
                      : 'other'
                    : 'possible',
                q.criteria,
                link?.text === 'Truck Driver' ? 0.95 : 1,
              ),
            ];
          }),
        ),
      };
    },
  };
  const flow = automationWorkflow({db, run, signal: controller.signal, browser, report: () => {}}),
    call = (name, args) => flow.call(a.id, run.id, name, args);
  const scan = await call('browser_run_task', {operation: 'scan_results', url: search});
  assert.equal(scan.status, 'completed');
  assert.equal(scan.confirmedListings, 11);
  assert.equal(scan.uncertainLinks, 0);
  assert.deepEqual(
    fetched.map((u) => new URL(u).pathname),
    ['/engineering/', '/engineering/page/2/'],
    'the next page is followed without a model choice; the last page ends the search',
  );
  const queue = db.scanQueue(a.id, run.id).pendingUrls;
  assert.equal(queue.length, 11);
  assert.ok(
    queue.every((u) =>
      /^https:\/\/berlinstartupjobs\.com\/engineering\/[a-z0-9-]+-41000000\d\d\/$/.test(u),
    ),
    'card addresses',
  );
  assert.ok(
    !queue.some((u) => u.includes('truck-driver')),
    'an explicit card conflict is still retired',
  );
  const details = await call('browser_run_task', {
    operation: 'collect_details',
    fromTaskId: scan.taskId,
  });
  assert.ok(details.classified > 0);
  assert.ok(
    fetched.slice(2).length > 0 && fetched.slice(2).every((u) => u.startsWith(search)),
    'postings come from the reader',
  );
});
test('TypeSafe HTTP failures are kept for the sidebar until Jev answers again', async () => {
  const questions = {fit: {type: 'noul', instructions: {}}};
  let changes = 0;
  const before = jevProvider.changed;
  jevProvider.changed = () => changes++;
  try {
    await assert.rejects(
      askJev({}, questions, {apiKey: 'test', fetchImpl: async () => ({ok: false, status: 402})}),
      /HTTP 402/,
    );
    await assert.rejects(
      askJev({}, questions, {apiKey: 'test', fetchImpl: async () => ({ok: false, status: 402})}),
      /HTTP 402/,
    );
    assert.equal(jevProvider.issue.status, 402);
    assert.equal(changes, 1, 'a repeated failure does not refresh every workspace again');
    await askJev({}, questions, {
      apiKey: 'test',
      fetchImpl: async () => ({ok: true, json: async () => ({answers: {fit: {noul: 0.5}}})}),
    });
    assert.equal(jevProvider.issue, null);
    assert.equal(changes, 2);
  } finally {
    jevProvider.changed = before;
    jevProvider.issue = null;
  }
});
