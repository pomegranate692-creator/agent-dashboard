'use strict';
// Incremental, read-only parser for Claude Code transcript JSONL files.
//
// Observed layout (verified on this machine, Claude Code 2.1.x):
//   <root>/projects/<project-dir>/<sessionId>.jsonl                       main conversation
//   <root>/projects/<project-dir>/<sessionId>/subagents/agent-<id>.jsonl  one file per subagent run
//   <root>/projects/<project-dir>/<sessionId>/subagents/agent-<id>.meta.json  {agentType, description, toolUseId, spawnDepth}
// The subagent meta `toolUseId` equals the `id` of the parent's Agent tool_use block, which is how
// subagents are linked to the session/prompt that started them. Nothing here is inferred beyond that.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { redact, cleanText, clip, safeJson, isoToMs } = require('./util');

const PREVIEW = 240;
const CHUNK = 8 * 1024 * 1024;
const MAX_CHUNK = 512 * 1024 * 1024;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const ATTENTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
// Top-level record types that carry nothing the dashboard displays; skipped without JSON.parse.
const SKIP_PREFIX = /^\{"type":"(last-prompt|file-history-snapshot|file-history-delta|queue-operation|bridge-session|atis-latch|mode|frame-link|artifact-[a-z-]+|permission-mode|summary|pr-link)"/;

function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = (...ks) => { for (const k of ks) if (typeof input[k] === 'string' && input[k]) return input[k]; return ''; };
  let s = '';
  switch (name) {
    case 'Bash': s = pick('command'); break;
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': s = pick('file_path', 'notebook_path'); break;
    case 'Grep': case 'Glob': s = pick('pattern'); break;
    case 'WebSearch': s = pick('query'); break;
    case 'WebFetch': s = pick('url'); break;
    case 'Skill': s = pick('skill'); break;
    case 'ToolSearch': s = pick('query'); break;
    case 'AskUserQuestion': s = input.questions?.[0]?.question || ''; break;
    default:
      if (AGENT_TOOLS.has(name)) s = pick('description', 'prompt');
      else {
        for (const v of Object.values(input)) if (typeof v === 'string' && v) { s = v; break; }
        if (!s) s = JSON.stringify(input);
      }
  }
  return clip(redact(s), PREVIEW);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : `[${b.type}]`)).join('\n');
}

function blocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
}

class Session {
  constructor(id, projectDir) {
    this.id = id;
    this.projectDir = projectDir;
    this.cwd = null;
    this.version = null;
    this.entrypoint = null;
    this.customTitle = null;
    this.firstTs = null;
    this.lastTs = null;
    this.nodes = new Map();
    this.promptIds = [];
    this.open = new Set(); // node ids with no result yet
    this.counts = { prompts: 0, tools: 0, errors: 0, denied: 0, subagents: 0, apiErrors: 0 };
    this.attn = []; // {id, kind, level, ts, text, nodeId}
    this.currentPrompt = new Map(); // scope -> prompt node id
    this.ord = 0;
    this.files = new Map();
    this.lastAction = null; // {ts, text, kind, nodeId}
    this.models = new Set();
    this.agentListing = null;
  }
}

class Ingest {
  // emit(type, payload) is called only for changes observed after a file's initial catch-up.
  constructor({ root, emit }) {
    this.root = root;
    this.projectsDir = path.join(root, 'projects');
    this.emit = emit || (() => {});
    this.sessions = new Map();
    this.fileStates = new Map(); // path -> FileState
    this.subMeta = new Map(); // toolUseId -> {agentType, description, agentId}
    this.health = { files: 0, parseErrors: 0, readErrors: 0, lastScanTs: null, lastScanError: null, indexed: 0, indexTotal: 0, indexing: false };
    this.agentTypes = new Map(); // name -> {description, tools, lastListedTs, sessions:Set}
  }

  session(id, projectDir) {
    let s = this.sessions.get(id);
    if (!s) { s = new Session(id, projectDir); this.sessions.set(id, s); }
    return s;
  }

  // ---- discovery -------------------------------------------------------
  async discover() {
    const found = [];
    let projects;
    try { projects = await fsp.readdir(this.projectsDir, { withFileTypes: true }); }
    catch (e) { this.health.lastScanError = e.code || String(e); this.health.lastScanTs = Date.now(); return found; }
    this.health.lastScanError = null;
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = path.join(this.projectsDir, p.name);
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          found.push({ path: path.join(dir, e.name), kind: 'main', sessionId: e.name.slice(0, -6), projectDir: p.name });
        } else if (e.isDirectory()) {
          const sd = path.join(dir, e.name, 'subagents');
          let subs;
          try { subs = await fsp.readdir(sd); } catch { continue; }
          for (const f of subs) {
            if (f.startsWith('agent-') && f.endsWith('.jsonl')) {
              const agentId = f.slice(6, -6);
              found.push({ path: path.join(sd, f), kind: 'sub', sessionId: e.name, projectDir: p.name, agentId, metaPath: path.join(sd, `agent-${agentId}.meta.json`) });
            }
          }
        }
      }
    }
    this.health.lastScanTs = Date.now();
    return found;
  }

  register(found) {
    const fresh = [];
    for (const f of found) {
      if (!this.fileStates.has(f.path)) {
        const fsx = { ...f, offset: 0, ino: null, caught: false, reading: false, size: 0, mtimeMs: 0, metaOk: f.kind === 'main' };
        this.fileStates.set(f.path, fsx);
        this.session(f.sessionId, f.projectDir).files.set(f.path, fsx);
        fresh.push(fsx);
      }
    }
    this.health.files = this.fileStates.size;
    return fresh;
  }

  // ---- reading ---------------------------------------------------------
  async loadMeta(fsx) {
    if (fsx.metaOk) return true;
    try {
      const m = safeJson(await fsp.readFile(fsx.metaPath, 'utf8'));
      if (!m || !m.toolUseId) return false;
      fsx.meta = m;
      fsx.metaOk = true;
      const sess = this.session(fsx.sessionId, fsx.projectDir);
      const sub = this.ensureSub(sess, m.toolUseId, 'main');
      sub.agentId = fsx.agentId;
      sub.agentType = m.agentType || sub.agentType;
      sub.description = m.description || sub.description;
      sub.spawnDepth = m.spawnDepth;
      sub.hasTranscript = true;
      this.touchNode(sess, sub, fsx.caught);
      return true;
    } catch { return false; }
  }

  // Reads any complete new lines. Returns number of lines consumed.
  async drain(fsx) {
    if (fsx.reading) return 0;
    fsx.reading = true;
    try {
      if (!(await this.loadMeta(fsx))) return 0;
      let st;
      try { st = await fsp.stat(fsx.path); } catch (e) { fsx.error = e.code || 'stat'; this.health.readErrors++; return 0; }
      fsx.error = null;
      fsx.mtimeMs = st.mtimeMs;
      if (fsx.ino && (st.ino !== fsx.ino || st.size < fsx.offset)) {
        // File replaced or truncated: drop what we derived from it and start over.
        this.resetFile(fsx);
      }
      fsx.ino = st.ino;
      fsx.size = st.size;
      if (st.size === fsx.offset) { fsx.caught = true; return 0; }
      const live = fsx.caught;
      const sess = this.session(fsx.sessionId, fsx.projectDir);
      const fh = await fsp.open(fsx.path, 'r');
      let lines = 0;
      const dirty = new Map();
      try {
        let want = CHUNK;
        while (fsx.offset < st.size) {
          const len = Math.min(want, st.size - fsx.offset);
          const buf = Buffer.allocUnsafe(len);
          const { bytesRead } = await fh.read(buf, 0, len, fsx.offset);
          const lastNl = buf.lastIndexOf(0x0a, bytesRead - 1);
          if (lastNl < 0) {
            if (fsx.offset + bytesRead >= st.size) break; // partial line still being written
            want = Math.min(want * 2, MAX_CHUNK); continue; // single line longer than the chunk
          }
          want = CHUNK;
          let s = 0;
          while (s <= lastNl) {
            let e = buf.indexOf(0x0a, s);
            if (e < 0 || e > lastNl) e = lastNl;
            if (e > s) {
              const text = buf.toString('utf8', s, e);
              this.processLine(sess, fsx, text, { file: fsx.path, off: fsx.offset + s, len: e - s }, dirty);
              lines++;
            }
            s = e + 1;
          }
          fsx.offset += lastNl + 1;
          if (!live) await new Promise((r) => setImmediate(r));
        }
      } finally { await fh.close(); }
      fsx.caught = true;
      if (live) this.flush(sess, dirty);
      return lines;
    } finally { fsx.reading = false; }
  }

  resetFile(fsx) {
    const sess = this.sessions.get(fsx.sessionId);
    fsx.offset = 0; fsx.caught = false;
    if (!sess) return;
    for (const [id, n] of sess.nodes) if (n.file === fsx.path) { sess.nodes.delete(id); sess.open.delete(id); }
    sess.promptIds = sess.promptIds.filter((id) => sess.nodes.has(id));
  }

  flush(sess, dirty) {
    for (const n of dirty.values()) this.emit('node', { sessionId: sess.id, node: n });
    if (dirty.size) this.emit('session', { sessionId: sess.id });
  }

  // ---- record handling -------------------------------------------------
  processLine(sess, fsx, text, ref, dirty) {
    // Background agents report completion through a <task-notification> queued in the parent transcript.
    if (text.startsWith('{"type":"queue-operation"')) {
      if (text.includes('task-notification') && text.includes('"operation":"enqueue"')) {
        const q = safeJson(text);
        if (q) this.onNotification(sess, fsx, q, dirty);
      }
      return;
    }
    if (SKIP_PREFIX.test(text)) return;
    let rec;
    try { rec = JSON.parse(text); } catch { this.health.parseErrors++; return; }
    const scope = fsx.kind === 'sub' ? fsx.agentId : 'main';
    const ts = isoToMs(rec.timestamp);
    if (ts) {
      if (scope === 'main' || !sess.firstTs) { if (!sess.firstTs || ts < sess.firstTs) sess.firstTs = ts; }
      if (!sess.lastTs || ts > sess.lastTs) sess.lastTs = ts;
    }
    if (ts && fsx.kind === 'sub' && fsx.meta) {
      // Most recent record in the subagent's own transcript: the only direct evidence a background agent is still working.
      const owner = sess.nodes.get('sub:' + fsx.meta.toolUseId);
      if (owner && (!owner.lastActivityTs || ts > owner.lastActivityTs)) { owner.lastActivityTs = ts; this.touchNode(sess, owner, fsx.caught, dirty); }
    }
    if (rec.cwd && scope === 'main' && !sess.cwd) sess.cwd = rec.cwd; // first cwd = where the session started (tools may `cd` later)
    if (rec.version) sess.version = rec.version;
    if (rec.entrypoint) sess.entrypoint = rec.entrypoint;
    switch (rec.type) {
      case 'user': return this.onUser(sess, fsx, scope, rec, ts, ref, dirty);
      case 'assistant': return this.onAssistant(sess, fsx, scope, rec, ts, ref, dirty);
      case 'system': return this.onSystem(sess, fsx, scope, rec, ts, ref, dirty);
      case 'custom-title': if (rec.customTitle) sess.customTitle = rec.customTitle; return;
      case 'attachment': return this.onAttachment(sess, rec, ts);
      default: return;
    }
  }

  newNode(sess, fsx, scope, kind, id, ts, extra) {
    const n = { id, kind, sessionId: sess.id, scope, ts, ord: ++sess.ord, file: fsx.path, ...extra };
    sess.nodes.set(id, n);
    return n;
  }

  touchNode(sess, node, emitNow, dirty) {
    if (dirty) dirty.set(node.id, node);
    else if (emitNow) this.emit('node', { sessionId: sess.id, node });
  }

  setLast(sess, ts, text, kind, nodeId) {
    if (!sess.lastAction || ts >= sess.lastAction.ts) sess.lastAction = { ts, text, kind, nodeId };
  }

  ensureSub(sess, toolUseId, parentScope, fsx) {
    const id = 'sub:' + toolUseId;
    let n = sess.nodes.get(id);
    if (!n) {
      n = { id, kind: 'subagent', sessionId: sess.id, scope: parentScope, ts: null, ord: ++sess.ord, file: fsx ? fsx.path : null,
        toolUseId, agentId: null, agentType: null, description: '', promptText: '', status: 'pending', promptId: sess.currentPrompt.get(parentScope) || null, parent: toolUseId };
      sess.nodes.set(id, n);
      sess.open.add(id);
      sess.counts.subagents++;
    }
    return n;
  }

  onUser(sess, fsx, scope, rec, ts, ref, dirty) {
    const content = rec.message && rec.message.content;
    let hasResult = false;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'tool_result') { hasResult = true; this.onToolResult(sess, fsx, scope, rec, b, ts, ref, dirty); }
      }
    }
    if (hasResult || rec.isMeta || rec.isCompactSummary) return;
    const text = cleanText(blocksText(content));
    if (!text) return;
    if (fsx.kind === 'sub') {
      // First user record of a subagent transcript is the prompt the parent gave it.
      const sub = fsx.meta && sess.nodes.get('sub:' + fsx.meta.toolUseId);
      if (sub && !sub.promptText) { sub.promptText = clip(redact(text), PREVIEW); sub.promptRef = ref; this.touchNode(sess, sub, fsx.caught, dirty); }
      return;
    }
    const id = 'p:' + (rec.uuid || ref.off);
    if (sess.nodes.has(id)) return;
    const n = this.newNode(sess, fsx, 'main', 'prompt', id, ts, {
      text: clip(redact(text), PREVIEW), origin: (rec.origin && rec.origin.kind) || (rec.promptSource ? String(rec.promptSource) : null), ref, promptId: id,
    });
    sess.promptIds.push(id);
    sess.currentPrompt.set('main', id);
    sess.counts.prompts++;
    this.setLast(sess, ts, 'Prompt: ' + n.text, 'prompt', id);
    this.touchNode(sess, n, fsx.caught, dirty);
  }

  onAssistant(sess, fsx, scope, rec, ts, ref, dirty) {
    const m = rec.message;
    if (!m || !Array.isArray(m.content)) return;
    const tid = (scope === 'main' ? 't:' : `t:${scope}:`) + (m.id || rec.uuid);
    const blocks = m.content;
    const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n').trim();
    const uses = blocks.filter((b) => b.type === 'tool_use');
    if (!text && !uses.length) return; // thinking-only records: private reasoning is never shown
    const subNode = fsx.kind === 'sub' && fsx.meta ? sess.nodes.get('sub:' + fsx.meta.toolUseId) : null;
    const promptId = subNode ? subNode.promptId : (sess.currentPrompt.get('main') || null);
    let turn = sess.nodes.get(tid);
    if (!turn) {
      turn = this.newNode(sess, fsx, scope, 'turn', tid, ts, {
        model: m.model && m.model !== '<synthetic>' ? m.model : null, text: '', toolIds: [], refs: [], promptId,
        parent: subNode ? subNode.id : null,
      });
      if (turn.model) sess.models.add(turn.model);
    }
    if (text) {
      // Only a short prefix is kept in memory; the full text is read back from the transcript on demand.
      if (turn.text.length < 700) turn.text = (turn.text ? turn.text + '\n' + text : text).slice(0, 700);
      turn.preview = clip(redact(cleanText(turn.text)), PREVIEW);
      turn.textChars = (turn.textChars || 0) + text.length;
      this.setLast(sess, ts, 'Claude: ' + turn.preview, 'turn', tid);
    }
    if (turn.refs.length < 24) turn.refs.push(ref);
    if (m.usage) {
      const u = m.usage;
      turn.usage = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheCreate: u.cache_creation_input_tokens };
    }
    if (m.stop_reason) turn.stop = m.stop_reason;
    for (const b of uses) this.onToolUse(sess, fsx, scope, turn, b, ts, ref, dirty, subNode);
    this.touchNode(sess, turn, fsx.caught, dirty);
  }

  onToolUse(sess, fsx, scope, turn, b, ts, ref, dirty, subNode) {
    if (sess.nodes.has(b.id)) return;
    const input = summarizeInput(b.name, b.input);
    const isAgent = AGENT_TOOLS.has(b.name);
    const n = this.newNode(sess, fsx, scope, 'tool', b.id, ts, {
      name: b.name, input, status: 'pending', turnId: turn.id, promptId: turn.promptId,
      parent: subNode ? subNode.id : null, ref, isAgentCall: isAgent, needsUser: ATTENTION_TOOLS.has(b.name),
    });
    turn.toolIds.push(b.id);
    sess.open.add(b.id);
    sess.counts.tools++;
    this.setLast(sess, ts, `${b.name}${input ? ': ' + input : ''}`, 'tool', b.id);
    this.touchNode(sess, n, fsx.caught, dirty);
    if (isAgent) {
      const sub = this.ensureSub(sess, b.id, scope, fsx);
      sub.ts = ts;
      sub.promptId = turn.promptId;
      sub.agentType = (b.input && b.input.subagent_type) || sub.agentType;
      sub.description = (b.input && b.input.description) || sub.description;
      sub.background = !!(b.input && b.input.run_in_background);
      sub.model = (b.input && b.input.model) || null;
      sub.promptText = sub.promptText || clip(redact((b.input && b.input.prompt) || ''), PREVIEW);
      sub.promptRef = sub.promptRef || ref; // full prompt lives in the parent's tool_use block
      sub.spawnRef = ref;
      sub.parentScope = scope;
      n.subId = sub.id;
      this.setLast(sess, ts, `Started ${sub.agentType || 'agent'}: ${sub.description}`, 'subagent', sub.id);
      this.touchNode(sess, sub, fsx.caught, dirty);
    }
  }

  onToolResult(sess, fsx, scope, rec, b, ts, ref, dirty) {
    const tool = sess.nodes.get(b.tool_use_id);
    if (!tool) return;
    const text = resultText(b.content);
    const denial = !!rec.toolDenialKind || /^Permission for this action was denied/i.test(text);
    const rejected = /^The user doesn't want to proceed/i.test(text) || /^User rejected/i.test(text);
    tool.status = rejected ? 'rejected' : denial ? 'denied' : b.is_error ? 'error' : 'ok';
    tool.endTs = ts;
    if (tool.ts) tool.durationMs = Math.max(0, ts - tool.ts);
    tool.result = clip(redact(text), PREVIEW);
    tool.resultRef = ref;
    sess.open.delete(tool.id);
    if (tool.status !== 'ok') {
      if (tool.status === 'error') sess.counts.errors++; else sess.counts.denied++;
      sess.attn.push({ id: 'attn:' + tool.id, kind: tool.status, level: tool.status === 'error' ? 'error' : 'warn', ts, nodeId: tool.id, text: `${tool.name} ${tool.status}: ${tool.result || tool.input}` });
      if (sess.attn.length > 60) sess.attn.shift();
    }
    this.touchNode(sess, tool, fsx.caught, dirty);
    if (tool.isAgentCall && tool.subId) {
      const sub = sess.nodes.get(tool.subId);
      const tr = rec.toolUseResult && typeof rec.toolUseResult === 'object' ? rec.toolUseResult : null;
      if (sub) {
        if (tr) {
          sub.agentId = tr.agentId || sub.agentId;
          sub.agentType = tr.agentType || sub.agentType;
          sub.rawStatus = tr.status || null;
          sub.stats = {
            durationMs: numOrNull(tr.totalDurationMs), totalTokens: numOrNull(tr.totalTokens), toolUses: numOrNull(tr.totalToolUseCount), model: tr.resolvedModel || null,
          };
          const content = Array.isArray(tr.content) ? blocksText(tr.content) : (typeof tr.content === 'string' ? tr.content : '');
          sub.result = clip(redact(content || text), PREVIEW);
        } else sub.result = tool.result;
        sub.resultRef = ref;
        if (tool.status !== 'ok') sub.status = 'failed';
        else if (sub.rawStatus && /async|launch|background|running/i.test(sub.rawStatus)) { sub.status = 'async'; }
        else sub.status = 'completed';
        // For a background agent this result only acknowledges the launch; it is not an end time.
        sub.endTs = sub.status === 'async' ? null : ts;
        sub.launchAckTs = sub.status === 'async' ? ts : null;
        if (sub.status !== 'async') sess.open.delete(sub.id); else sess.open.add(sub.id);
        this.setLast(sess, ts, `${sub.agentType || 'agent'} ${sub.status}: ${sub.description}`, 'subagent', sub.id);
        this.touchNode(sess, sub, fsx.caught, dirty);
      }
    }
  }

  onNotification(sess, fsx, q, dirty) {
    const body = typeof q.content === 'string' ? q.content : '';
    const toolUseId = (/<tool-use-id>([^<]+)<\/tool-use-id>/.exec(body) || [])[1];
    const status = (/<status>([^<]+)<\/status>/.exec(body) || [])[1];
    const taskId = (/<task-id>([^<]+)<\/task-id>/.exec(body) || [])[1];
    const ts = isoToMs(q.timestamp);
    let sub = toolUseId ? sess.nodes.get('sub:' + toolUseId) : null;
    if (!sub && taskId) sub = [...sess.nodes.values()].find((n) => n.kind === 'subagent' && n.agentId === taskId);
    if (!sub || !status) return;
    if (/^(completed|done|success)/i.test(status)) sub.status = 'completed';
    else if (/^(failed|error|killed|stopped|cancel)/i.test(status)) sub.status = 'failed';
    else return;
    sub.rawStatus = status;
    sub.endTs = ts;
    sub.reportedBy = 'task-notification';
    sess.open.delete(sub.id);
    this.setLast(sess, ts, `${sub.agentType || 'agent'} ${sub.status}: ${sub.description}`, 'subagent', sub.id);
    this.touchNode(sess, sub, fsx.caught, dirty);
  }

  onSystem(sess, fsx, scope, rec, ts, ref, dirty) {
    if (rec.subtype === 'api_error') {
      sess.counts.apiErrors++;
      const id = 'e:' + rec.uuid;
      if (sess.nodes.has(id)) return;
      const msg = (rec.error && (rec.error.formatted || rec.error.message)) || 'API error';
      const n = this.newNode(sess, fsx, scope, 'event', id, ts, {
        subtype: 'api_error', text: clip(redact(msg), PREVIEW), detail: `retry ${rec.retryAttempt ?? '?'} of ${rec.maxRetries ?? '?'}`,
        promptId: sess.currentPrompt.get('main') || null, parent: null, ref,
      });
      sess.attn.push({ id: 'attn:' + id, kind: 'api_error', level: 'warn', ts, nodeId: id, text: 'API error: ' + n.text });
      if (sess.attn.length > 60) sess.attn.shift();
      this.touchNode(sess, n, fsx.caught, dirty);
    } else if (rec.subtype === 'compact_boundary') {
      const id = 'e:' + rec.uuid;
      if (sess.nodes.has(id)) return;
      const cm = rec.compactMetadata || {};
      const n = this.newNode(sess, fsx, scope, 'event', id, ts, {
        subtype: 'compact', text: 'Conversation compacted', detail: cm.preTokens ? `${cm.trigger || ''} · ${cm.preTokens} → ${cm.postTokens} tokens` : (cm.trigger || ''),
        promptId: sess.currentPrompt.get('main') || null, parent: null, ref,
      });
      this.touchNode(sess, n, fsx.caught, dirty);
    }
  }

  // `agent_listing_delta` attachments record which agent types the harness exposed to the session.
  onAttachment(sess, rec, ts) {
    const a = rec.attachment;
    if (!a || a.type !== 'agent_listing_delta') return;
    sess.agentListing = ts;
    const lines = Array.isArray(a.addedLines) ? a.addedLines : [];
    for (const line of lines) {
      const m = /^- ([^:]+): ([\s\S]*)$/.exec(line);
      if (!m) continue;
      const name = m[1].trim();
      let desc = m[2].trim();
      let tools = null;
      const tm = /\(Tools: ([^)]*)\)\s*$/.exec(desc);
      if (tm) { tools = tm[1].trim(); desc = desc.slice(0, tm.index).trim(); }
      const cur = this.agentTypes.get(name) || { name, sessions: new Set() };
      if (!cur.lastListedTs || ts >= cur.lastListedTs) { cur.description = desc; cur.tools = tools; cur.lastListedTs = ts; }
      cur.sessions.add(sess.id);
      this.agentTypes.set(name, cur);
    }
  }
}

function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// ---- lazy detail reads ---------------------------------------------------
async function readRef(ref) {
  const fh = await fsp.open(ref.file, 'r');
  try {
    const buf = Buffer.allocUnsafe(ref.len);
    await fh.read(buf, 0, ref.len, ref.off);
    return safeJson(buf.toString('utf8'));
  } finally { await fh.close(); }
}

const DETAIL_LIMIT = 200 * 1024;
function limit(s) {
  s = redact(s || '');
  return s.length > DETAIL_LIMIT ? { text: s.slice(0, DETAIL_LIMIT), truncated: true, fullLength: s.length } : { text: s, truncated: false, fullLength: s.length };
}

// Returns the full (redacted, size-capped) content for a node. Reasoning blocks are never returned.
async function nodeDetail(sess, node) {
  const out = { id: node.id, kind: node.kind };
  if (node.kind === 'prompt') {
    const r = await readRef(node.ref);
    out.sections = [{ title: 'Prompt', ...limit(cleanText(blocksText(r && r.message && r.message.content))) }];
  } else if (node.kind === 'turn') {
    const parts = [];
    for (const ref of node.refs) {
      const r = await readRef(ref);
      const t = r && r.message && r.message.content ? r.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
      if (t) parts.push(t);
    }
    out.sections = [{ title: 'Response text', ...limit(parts.join('\n\n')) }];
    out.usage = node.usage || null;
  } else if (node.kind === 'tool') {
    const r = await readRef(node.ref);
    const blk = r && r.message && r.message.content ? r.message.content.find((b) => b.type === 'tool_use' && b.id === node.id) : null;
    out.sections = [{ title: 'Input', ...limit(blk ? JSON.stringify(blk.input, null, 2) : '') }];
    if (node.resultRef) {
      const rr = await readRef(node.resultRef);
      const rb = rr && rr.message && Array.isArray(rr.message.content) ? rr.message.content.find((b) => b.type === 'tool_result' && b.tool_use_id === node.id) : null;
      out.sections.push({ title: node.status === 'ok' ? 'Output' : 'Result (' + node.status + ')', ...limit(rb ? resultText(rb.content) : '') });
    }
  } else if (node.kind === 'subagent') {
    out.sections = [];
    if (node.promptRef) {
      const r = await readRef(node.promptRef);
      let text = '';
      if (r && r.message && Array.isArray(r.message.content)) {
        const blk = r.message.content.find((b) => b.type === 'tool_use' && b.id === node.toolUseId);
        text = blk && blk.input ? blk.input.prompt || '' : blocksText(r.message.content);
      } else text = blocksText(r && r.message && r.message.content);
      out.sections.push({ title: 'Prompt given to the subagent', ...limit(cleanText(text)) });
    }
    if (node.resultRef) {
      const rr = await readRef(node.resultRef);
      const tr = rr && rr.toolUseResult;
      let text = '';
      if (tr && typeof tr === 'object' && Array.isArray(tr.content)) text = blocksText(tr.content);
      if (!text && rr && Array.isArray(rr.message && rr.message.content)) {
        const rb = rr.message.content.find((b) => b.type === 'tool_result' && b.tool_use_id === node.toolUseId);
        text = rb ? resultText(rb.content) : '';
      }
      out.sections.push({ title: 'Result returned to parent', ...limit(text) });
    }
  } else if (node.kind === 'event') {
    out.sections = [{ title: 'Event', ...limit(node.text + (node.detail ? '\n' + node.detail : '')) }];
  }
  return out;
}

module.exports = { Ingest, Session, nodeDetail, summarizeInput, AGENT_TOOLS, ATTENTION_TOOLS };
