'use strict';
// Synthetic Claude-Code-shaped transcripts for TESTING ONLY. These live under a temp/fixture root and are
// never mixed into the live view: the server shows a "FIXTURE DATA" banner whenever --root is not ~/.claude.
const fs = require('fs');
const path = require('path');

const iso = (ms) => new Date(ms).toISOString();
let n = 0;
const uid = (p) => `${p}-${(++n).toString(16).padStart(4, '0')}-0000-0000-000000000000`;

function line(o) { return JSON.stringify(o) + '\n'; }

function rec(sessionId, extra) {
  return { isSidechain: false, userType: 'external', entrypoint: 'fixture', cwd: '/fixture/project', sessionId, version: '0.0.0-fixture', ...extra };
}

function prompt(sessionId, text, t) {
  return line(rec(sessionId, { type: 'user', uuid: uid('u'), promptId: uid('pr'), timestamp: iso(t), origin: { kind: 'human' }, message: { role: 'user', content: text } }));
}
function assistant(sessionId, blocks, t, msgId, extra = {}) {
  return line(rec(sessionId, { type: 'assistant', uuid: uid('a'), timestamp: iso(t), message: { id: msgId || uid('msg'), role: 'assistant', model: 'claude-fixture-1', content: blocks, stop_reason: null, usage: { input_tokens: 10, output_tokens: 5 } }, ...extra }));
}
function toolUse(id, name, input) { return { type: 'tool_use', id, name, input }; }
function toolResult(sessionId, id, content, t, { isError = false, tur } = {}) {
  return line(rec(sessionId, { type: 'user', uuid: uid('r'), timestamp: iso(t), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError || undefined }] }, ...(tur ? { toolUseResult: tur } : {}) }));
}

function writeRegistry(root, pid, sessionId, status, name) {
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: '/fixture/project', startedAt: Date.now(), version: '0.0.0-fixture', kind: 'interactive', entrypoint: 'fixture', name, status, updatedAt: Date.now(), statusUpdatedAt: Date.now() }));
}

// A finished session: prompt → tools (ok / error / denied) → Agent subagent with its own tools → final reply.
function buildFinished(root, t0 = Date.now() - 3 * 3600e3) {
  const sid = '11111111-1111-4111-8111-111111111111';
  const dir = path.join(root, 'projects', '-fixture-project');
  fs.mkdirSync(path.join(dir, sid, 'subagents'), { recursive: true });
  let t = t0;
  let out = '';
  out += line({ type: 'custom-title', customTitle: 'Fixture: refactor the parser', sessionId: sid });
  out += prompt(sid, 'Refactor the parser and run the tests', t);
  out += assistant(sid, [{ type: 'text', text: 'I will read the parser first.' }, toolUse('toolu_read1', 'Read', { file_path: '/fixture/parser.js' })], t += 2000, 'msg_a');
  out += toolResult(sid, 'toolu_read1', 'file contents here', t += 500);
  out += assistant(sid, [toolUse('toolu_bash1', 'Bash', { command: 'npm test' }), toolUse('toolu_bash2', 'Bash', { command: 'rm -rf /' })], t += 1500, 'msg_b');
  out += toolResult(sid, 'toolu_bash1', 'Error: 2 tests failed\nAPI key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789', t += 4000, { isError: true });
  out += toolResult(sid, 'toolu_bash2', 'Permission for this action was denied by the Claude Code auto mode classifier.', t += 100, { isError: true });
  out += assistant(sid, [{ type: 'text', text: 'Tests fail; delegating a review.' }, toolUse('toolu_agent1', 'Agent', { description: 'Review failing tests', subagent_type: 'Explore', prompt: 'Find why the tests fail' })], t += 2000, 'msg_c');
  const subStart = t + 300;
  const agentId = 'afixture000000001';
  fs.writeFileSync(path.join(dir, sid, 'subagents', `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'Review failing tests', toolUseId: 'toolu_agent1', spawnDepth: 1 }));
  let s = '';
  s += line(rec(sid, { type: 'user', isSidechain: true, agentId, uuid: uid('su'), timestamp: iso(subStart), message: { role: 'user', content: 'Find why the tests fail' } }));
  s += line(rec(sid, { type: 'assistant', isSidechain: true, agentId, uuid: uid('sa'), timestamp: iso(subStart + 800), message: { id: 'msg_s1', role: 'assistant', model: 'claude-fixture-1', content: [toolUse('toolu_sub_grep', 'Grep', { pattern: 'assert' })], usage: { input_tokens: 3, output_tokens: 3 } } }));
  s += line(rec(sid, { type: 'user', isSidechain: true, agentId, uuid: uid('sr'), timestamp: iso(subStart + 1500), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sub_grep', content: '3 matches' }] } }));
  fs.writeFileSync(path.join(dir, sid, 'subagents', `agent-${agentId}.jsonl`), s);
  out += toolResult(sid, 'toolu_agent1', [{ type: 'text', text: 'The parser mishandles empty input.' }], t += 9000, { tur: { status: 'completed', agentId, agentType: 'Explore', content: [{ type: 'text', text: 'The parser mishandles empty input.' }], totalDurationMs: 8700, totalTokens: 4321, totalToolUseCount: 1, resolvedModel: 'claude-fixture-1' } });
  out += assistant(sid, [{ type: 'text', text: 'Fixed the parser and the tests pass.' }], t += 2000, 'msg_d');
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), out);
  return { sid, agentId, dir, file: path.join(dir, `${sid}.jsonl`) };
}

module.exports = { buildFinished, writeRegistry, prompt, assistant, toolUse, toolResult, rec, line, iso, uid };
