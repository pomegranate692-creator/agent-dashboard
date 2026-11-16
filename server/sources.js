'use strict';
// Read-only access to (a) the live-session registry and (b) configured agent definitions.
// Nothing here ever writes to the Claude config directory. Files named *.key (which sit next to the
// registry entries) and ~/.claude.json are deliberately never opened.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { safeJson } = require('./util');

function pidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ~/.claude/sessions/<pid>.json — written by Claude Code for each running interactive/background session.
// This file layout is observed, not documented; `claude agents --json` prints the same fields.
async function readRegistry(root) {
  const dir = path.join(root, 'sessions');
  const out = { ts: Date.now(), ok: true, error: null, entries: [] };
  let names;
  try { names = await fsp.readdir(dir); } catch (e) { out.ok = false; out.error = e.code || String(e); return out; }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const j = safeJson(await fsp.readFile(path.join(dir, n), 'utf8').catch(() => ''));
    if (!j || !j.sessionId) continue;
    out.entries.push({
      pid: j.pid, sessionId: j.sessionId, cwd: j.cwd || null, name: j.name || null, status: j.status || null, kind: j.kind || null,
      entrypoint: j.entrypoint || null, version: j.version || null, startedAt: j.startedAt || null, updatedAt: j.updatedAt || null,
      statusUpdatedAt: j.statusUpdatedAt || null, alive: pidAlive(j.pid),
    });
  }
  return out;
}

// Minimal YAML-frontmatter reader (enough for agent definition files: scalar keys, comma lists).
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const out = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) { key = kv[1]; out[key] = kv[2].replace(/^["']|["']$/g, '').trim(); }
    else if (key && /^\s+\S/.test(line)) out[key] = (out[key] + ' ' + line.trim()).trim();
  }
  return out;
}

async function listMd(dir) {
  const res = [];
  async function walk(d, depth) {
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.md')) res.push(p);
    }
  }
  await walk(dir, 0);
  return res;
}

async function readDefs(dir, scope, label) {
  const defs = [];
  for (const file of await listMd(dir)) {
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    const fm = parseFrontmatter(text);
    if (!fm || !fm.name) continue;
    defs.push({ name: fm.name, description: fm.description || '', tools: fm.tools || null, model: fm.model || null, color: fm.color || null, scope, scopeLabel: label, path: file });
  }
  return defs;
}

// Locations per the Claude Code docs (sub-agents): ~/.claude/agents, <project>/.claude/agents (walking up from the
// working directory), and an enabled plugin's agents/ directory. --agents CLI definitions are session-only and
// not saved to disk, so they cannot be observed here.
async function discoverDefinitions({ root, cwds }) {
  const seen = new Set();
  const defs = [];
  const searched = [];
  const add = async (dir, scope, label) => {
    const real = path.resolve(dir);
    if (seen.has(real)) return;
    seen.add(real);
    const exists = await fsp.stat(real).then((s) => s.isDirectory()).catch(() => false);
    searched.push({ dir: real, scope, label, exists });
    if (exists) defs.push(...await readDefs(real, scope, label));
  };
  await add(path.join(root, 'agents'), 'user', 'User (~/.claude/agents)');
  for (const cwd of cwds) {
    let d = cwd;
    for (let i = 0; i < 12; i++) {
      await add(path.join(d, '.claude', 'agents'), 'project', 'Project');
      const p = path.dirname(d);
      if (p === d) break;
      d = p;
    }
  }
  const settings = safeJson(await fsp.readFile(path.join(root, 'settings.json'), 'utf8').catch(() => '')) || {};
  const installed = safeJson(await fsp.readFile(path.join(root, 'plugins', 'installed_plugins.json'), 'utf8').catch(() => '')) || {};
  for (const [pid, on] of Object.entries(settings.enabledPlugins || {})) {
    if (!on) continue;
    const inst = (installed.plugins && installed.plugins[pid] && installed.plugins[pid][0]) || null;
    if (inst && inst.installPath) await add(path.join(inst.installPath, 'agents'), 'plugin', `Plugin ${pid}`);
  }
  return { definitions: defs, searched };
}

module.exports = { readRegistry, discoverDefinitions, pidAlive };
