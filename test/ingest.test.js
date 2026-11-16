'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ingest } = require('../server/ingest');
const F = require('../scripts/fixture');
const { redact } = require('../server/util');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dash-test-')); }
async function load(root, events = []) {
  const ing = new Ingest({ root, emit: (t, p) => events.push([t, p]) });
  ing.register(await ing.discover());
  for (const f of ing.fileStates.values()) await ing.drain(f);
  return ing;
}

test('links prompt → tools → subagent → subagent tools, with correct statuses', async () => {
  const root = tmpRoot();
  const { sid } = F.buildFinished(root);
  const ing = await load(root);
  const s = ing.sessions.get(sid);
  assert.equal(s.customTitle, 'Fixture: refactor the parser');
  assert.equal(s.counts.prompts, 1);
  const byName = (n) => [...s.nodes.values()].filter((x) => x.kind === 'tool' && x.name === n);
  assert.equal(byName('Read')[0].status, 'ok');
  const bash = byName('Bash');
  assert.equal(bash.find((b) => b.id === 'toolu_bash1').status, 'error');
  assert.equal(bash.find((b) => b.id === 'toolu_bash2').status, 'denied');
  const sub = s.nodes.get('sub:toolu_agent1');
  assert.equal(sub.agentType, 'Explore');
  assert.equal(sub.status, 'completed');
  assert.equal(sub.stats.totalTokens, 4321);
  assert.ok(sub.agentId && sub.hasTranscript);
  const subTool = s.nodes.get('toolu_sub_grep');
  assert.equal(subTool.parent, sub.id, 'tool inside the subagent transcript belongs to the subagent');
  assert.equal(subTool.status, 'ok');
  assert.equal(s.open.size, 0);
  fs.rmSync(root, { recursive: true });
});

test('secrets are redacted from previews', async () => {
  const root = tmpRoot();
  const { sid } = F.buildFinished(root);
  const ing = await load(root);
  const n = ing.sessions.get(sid).nodes.get('toolu_bash1');
  assert.ok(!/sk-ant-abcdef/.test(n.result), n.result);
  assert.equal(redact('token=abcdefghijklmnop1234'), 'token=[redacted]');
  fs.rmSync(root, { recursive: true });
});

test('partial line is not parsed until complete; re-reading never duplicates', async () => {
  const root = tmpRoot();
  const { sid, file } = F.buildFinished(root);
  const ing = await load(root);
  const s = ing.sessions.get(sid);
  const before = s.nodes.size;
  const events = [];
  ing.emit = (t, p) => events.push([t, p]);
  const full = F.prompt(sid, 'second prompt', Date.now());
  fs.appendFileSync(file, full.slice(0, 40)); // writer is mid-line
  const f = [...ing.fileStates.values()].find((x) => x.kind === 'main');
  await ing.drain(f);
  assert.equal(s.nodes.size, before);
  fs.appendFileSync(file, full.slice(40));
  await ing.drain(f);
  await ing.drain(f); // nothing new: must be a no-op
  assert.equal(s.nodes.size, before + 1);
  assert.equal(events.filter(([t, p]) => t === 'node' && p.node.kind === 'prompt').length, 1, 'exactly one emitted node event');
  fs.rmSync(root, { recursive: true });
});

test('a tool call with no result stays open (pending), never "completed"', async () => {
  const root = tmpRoot();
  const { sid, file } = F.buildFinished(root);
  fs.appendFileSync(file, F.assistant(sid, [F.toolUse('toolu_pending', 'Bash', { command: 'sleep 100' })], Date.now(), 'msg_p'));
  const ing = await load(root);
  const s = ing.sessions.get(sid);
  assert.equal(s.nodes.get('toolu_pending').status, 'pending');
  assert.ok(s.open.has('toolu_pending'));
  fs.rmSync(root, { recursive: true });
});

test('truncated/replaced transcript is re-read from scratch without duplicates', async () => {
  const root = tmpRoot();
  const { sid, file } = F.buildFinished(root);
  const ing = await load(root);
  const f = [...ing.fileStates.values()].find((x) => x.kind === 'main');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.split('\n').slice(0, 3).join('\n') + '\n');
  await ing.drain(f);
  const s = ing.sessions.get(sid);
  assert.equal(s.nodes.has('toolu_bash2'), false);
  assert.ok(s.nodes.has('toolu_read1'));
  fs.rmSync(root, { recursive: true });
});

test('background agent: async launch stays open until a task-notification reports completion', async () => {
  const root = tmpRoot();
  const { sid, file } = F.buildFinished(root);
  const t = Date.now();
  fs.appendFileSync(file, F.assistant(sid, [F.toolUse('toolu_bg', 'Agent', { description: 'bg job', subagent_type: 'general-purpose', prompt: 'x', run_in_background: true })], t, 'msg_bg'));
  fs.appendFileSync(file, F.toolResult(sid, 'toolu_bg', 'Async agent launched', t + 10, { tur: { isAsync: true, status: 'async_launched', agentId: 'abg1' } }));
  const ing = await load(root);
  const sub = ing.sessions.get(sid).nodes.get('sub:toolu_bg');
  assert.equal(sub.status, 'async');
  assert.ok(ing.sessions.get(sid).open.has(sub.id));
  fs.appendFileSync(file, F.line({ type: 'queue-operation', operation: 'enqueue', timestamp: F.iso(t + 5000), sessionId: sid, content: '<task-notification>\n<task-id>abg1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n</task-notification>' }));
  const f = [...ing.fileStates.values()].find((x) => x.kind === 'main');
  await ing.drain(f);
  assert.equal(sub.status, 'completed');
  assert.equal(ing.sessions.get(sid).open.has(sub.id), false);
  fs.rmSync(root, { recursive: true });
});
