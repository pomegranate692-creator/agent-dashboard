'use strict';
// Small helpers: secret redaction, text cleanup, previews.

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9]{24,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const KV_SECRET = /((?:api[_-]?key|secret|token|passw(?:or)?d|authorization)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi;

function redact(s) {
  if (!s) return s;
  let out = String(s);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  out = out.replace(KV_SECRET, (_, k) => k + '[redacted]');
  return out;
}

// Remove harness-injected wrappers so previews show what a person would recognise.
function cleanText(s) {
  if (!s) return '';
  return String(s)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .trim();
}

function clip(s, n) {
  if (s == null) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function isoToMs(ts) {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

module.exports = { redact, cleanText, clip, safeJson, isoToMs };
