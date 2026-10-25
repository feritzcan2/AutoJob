import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentSessions, carriesMessage} from '../app/agents/sessions.mjs';
import {claudeProjectDirectory} from '../app/agents/transcript.mjs';

const NATIVE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PROMPT = 'Current user request (JSON):\n{"task":"Read the synthetic CV."}\n\nRead AGENTS.md.';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Slow runners read the transcript later than a fixed pause allows.
async function until(check, ms = 2000) {
  for (const end = Date.now() + ms; !check() && Date.now() < end;) await wait(10);
}

async function fixture(t) {
  const data = await mkdtemp(path.join(tmpdir(), 'delivery-check-')),
    cwd = path.join(data, 'workspace'),
    previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(data, 'claude');
  const project = path.join(data, 'claude', 'projects', claudeProjectDirectory(cwd)),
    file = path.join(project, `${NATIVE}.jsonl`);
  await mkdir(project, {recursive: true});
  await mkdir(cwd, {recursive: true});
  const requests = [],
    events = [];
  let emit;
  const agents = new AgentSessions({
    root: process.cwd(),
    data,
    deliveryCheck: {reads: 3, intervalMs: 10},
    createEngine: (_binary, _directory, onEvent) => {
      emit = onEvent;
      return {
        request: async (op, args) => {
          requests.push([op, args]);
          if (op === 'start')
            await onEvent({event: 'identity', sessionId: args.sessionId, nativeId: NATIVE});
          return {};
        },
        close: async () => {},
      };
    },
  });
  t.after(async () => {
    await agents.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(data, {recursive: true, force: true});
  });
  await agents.start({
    id: 'w',
    sessionId: 's1',
    settings: {provider: 'claude'},
    cwd,
    runtimeDirectory: data,
    prompt: PROMPT,
    resume: false,
    onEvent: (event) => events.push(event),
  });
  return {
    requests,
    events,
    messages: () => requests.filter(([op]) => op === 'message').map(([, args]) => args.text),
    event: (value) => emit({sessionId: 's1', ...value}),
    // One prompt the provider submitted, as Claude records it.
    submitted: (content) =>
      appendFile(
        file,
        JSON.stringify({
          type: 'user',
          sessionId: NATIVE,
          cwd,
          uuid: String(Math.random()),
          timestamp: new Date().toISOString(),
          message: {role: 'user', content},
        }) + '\n',
      ),
  };
}

test('a submitted prompt carries the message only when both of its ends are there', () => {
  assert.equal(
    carriesMessage(`\n\n<pasted_content id="a0cd">\n${PROMPT}\n</pasted_content>`, PROMPT),
    true,
  );
  assert.equal(carriesMessage('$', PROMPT), false);
  assert.equal(carriesMessage(PROMPT.slice(30), PROMPT), false);
  assert.equal(carriesMessage(PROMPT.slice(0, -5), PROMPT), false);
});

test('a delivered message is not sent again', async (t) => {
  const f = await fixture(t);
  f.event({event: 'delivery', state: 'Some(WritingPaste)'});
  await f.submitted(`<pasted_content id="1">\n${PROMPT}\n</pasted_content>`);
  f.event({event: 'delivery', state: 'None'});
  f.event({event: 'state', state: 'Some(Working)'});
  await wait(80);
  assert.deepEqual(f.messages(), []);
  assert.equal(
    f.events.some((e) => e.event === 'delivery_failed'),
    false,
  );
});

test('other text submitted in place of the message sends it once more, then reports it', async (t) => {
  const f = await fixture(t);
  f.event({event: 'delivery', state: 'Some(Blocked)'});
  await f.submitted('$');
  f.event({event: 'delivery', state: 'Some(Confirmed)'});
  f.event({event: 'state', state: 'Some(Working)'});
  await until(() => f.messages().length);
  assert.deepEqual(f.messages(), [PROMPT]);
  assert.equal(
    f.events.some((e) => e.event === 'delivery_failed'),
    false,
  );

  // The resent message is replaced too: report it instead of resending again.
  await wait(5);
  f.event({event: 'delivery', state: 'Some(WritingPaste)'});
  await f.submitted('y');
  f.event({event: 'delivery', state: 'None'});
  f.event({event: 'state', state: 'Some(Working)'});
  await until(() => f.events.some((e) => e.event === 'delivery_failed'));
  assert.deepEqual(f.messages(), [PROMPT]);
  const failed = f.events.filter((e) => e.event === 'delivery_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].replaced, true);
});

test('a message still queued or being written is not resent for text the user submitted', async (t) => {
  const f = await fixture(t);
  await f.submitted('a question the user typed');
  f.event({event: 'state', state: 'Some(Working)'});
  await wait(60);
  f.event({event: 'delivery', state: 'Some(WritingPaste)'});
  f.event({event: 'state', state: 'Some(Idle)'});
  await wait(60);
  assert.deepEqual(f.messages(), []);
});

test('a missing transcript leaves the delivery unconfirmed instead of resending', async (t) => {
  const f = await fixture(t);
  f.event({event: 'delivery', state: 'Some(Confirmed)'});
  f.event({event: 'state', state: 'Some(Working)'});
  await wait(60);
  assert.deepEqual(f.messages(), []);
  assert.equal(
    f.events.some((e) => e.event === 'delivery_failed'),
    false,
  );
});
