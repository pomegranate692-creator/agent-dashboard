#!/usr/bin/env node
'use strict';
// TEST HARNESS: appends synthetic events to a fixture root over ~25s so the live path can be exercised
// (pending → ok, subagent running → completed, a half-written line, process exit with a call still open).
// Usage: node scripts/simulate-live.js <fixture-root>   then   node server/index.js --root <fixture-root> --port 4318
const fs = require('fs');
const path = require('path');
const F = require('./fixture');

const root = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: simulate-live.js <fixture-root>'); process.exit(1); }
const sid = '22222222-2222-4222-8222-222222222222';
const dir = path.join(root, 'projects', '-fixture-project');
fs.mkdirSync(path.join(dir, sid, 'subagents'), { recursive: true });
const file = path.join(dir, `${sid}.jsonl`);
if (!fs.existsSync(path.join(root, 'projects', '-fixture-project', '11111111-1111-4111-8111-111111111111.jsonl'))) F.buildFinished(root);
fs.writeFileSync(file, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const add = (s) => fs.appendFileSync(file, s);
const agentId = 'alive000000000001';
const subFile = path.join(dir, sid, 'subagents', `agent-${agentId}.jsonl`);

(async () => {
  F.writeRegistry(root, process.pid, sid, 'busy', 'Fixture: live health-check task');
  console.log('live fixture session', sid, 'pid', process.pid);
  add(F.prompt(sid, 'Add a health check endpoint and have Plan review the approach', Date.now())); await sleep(1500);
  add(F.assistant(sid, [{ type: 'text', text: 'Looking at the server first.' }, F.toolUse('toolu_l_grep', 'Grep', { pattern: 'app.get' })], Date.now(), 'msg_l1')); await sleep(2500);
  add(F.toolResult(sid, 'toolu_l_grep', '4 matches', Date.now())); await sleep(1000);
  add(F.assistant(sid, [F.toolUse('toolu_l_agent', 'Agent', { description: 'Plan the endpoint', subagent_type: 'Plan', prompt: 'Plan a /health endpoint' })], Date.now(), 'msg_l2'));
  fs.writeFileSync(path.join(dir, sid, 'subagents', `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'Plan', description: 'Plan the endpoint', toolUseId: 'toolu_l_agent', spawnDepth: 1 }));
  await sleep(1200);
  fs.writeFileSync(subFile, F.line(F.rec(sid, { type: 'user', isSidechain: true, agentId, uuid: F.uid('su'), timestamp: F.iso(Date.now()), message: { role: 'user', content: 'Plan a /health endpoint' } }))
    + F.line(F.rec(sid, { type: 'assistant', isSidechain: true, agentId, uuid: F.uid('sa'), timestamp: F.iso(Date.now()), message: { id: 'msg_ls1', role: 'assistant', content: [F.toolUse('toolu_l_sread', 'Read', { file_path: '/fixture/server.js' })], usage: { input_tokens: 1, output_tokens: 1 } } })));
  await sleep(4000);
  fs.appendFileSync(subFile, F.line(F.rec(sid, { type: 'user', isSidechain: true, agentId, uuid: F.uid('sr'), timestamp: F.iso(Date.now()), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_l_sread', content: 'server source' }] } })));
  await sleep(1500);
  add(F.toolResult(sid, 'toolu_l_agent', [{ type: 'text', text: 'Add GET /health returning {ok:true}.' }], Date.now(), { tur: { status: 'completed', agentId, agentType: 'Plan', content: [{ type: 'text', text: 'Add GET /health returning {ok:true}.' }], totalDurationMs: 6900, totalTokens: 1500, totalToolUseCount: 1 } })); await sleep(1500);
  add(F.assistant(sid, [F.toolUse('toolu_l_edit', 'Edit', { file_path: '/fixture/server.js' })], Date.now(), 'msg_l3')); await sleep(1500);
  add(F.toolResult(sid, 'toolu_l_edit', 'old_string not found', Date.now(), { isError: true })); await sleep(1200);
  // half-written line: must not be parsed or duplicated
  const line = F.assistant(sid, [{ type: 'text', text: 'The edit failed; retrying with the exact text.' }], Date.now(), 'msg_l4');
  add(line.slice(0, 60)); await sleep(2000); add(line.slice(60)); await sleep(1500);
  add(F.prompt(sid, 'Now run the tests', Date.now())); await sleep(1000);
  add(F.assistant(sid, [F.toolUse('toolu_l_never', 'Bash', { command: 'npm test' })], Date.now(), 'msg_l5'));
  console.log('left toolu_l_never open; exiting in 8s (process death → session becomes "Not running", call becomes "No result recorded")');
  await sleep(8000);
  process.exit(0);
})();
