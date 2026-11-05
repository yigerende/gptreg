'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  base64urlDecode,
  base64urlEncode,
  cookieNames,
  getHeader,
  headerNames,
  parseUrl,
  queryNames,
  redactBody,
  redactText,
  redactUrl,
  responseLocation,
  sha256Short,
  tryParseJson,
} = require('./http-shape');

/**
 * Reading a capture.
 *
 * A capture is evidence of one recorded session, and nothing in the
 * registration or login flows depends on one: both build their requests from
 * the templates declared in `protocol-templates.js`. What is left here serves
 * the offline commands — `summary`, `chain`, `sentinel`, `protocol-drift` —
 * and the `protocolTemplates: capture` mode that replays a recording so a
 * fresh one can be compared against those templates.
 *
 * The generic HTTP helpers that used to live here moved to `http-shape.js`;
 * they are re-exported so callers can migrate when they are touched anyway.
 */

const BASELINE_HAR_NAME = /^localhost(?:[_.-]|$)/i;
const REGISTRATION_BASELINE_HAR_NAME = /^localhost[_-]archive\b/i;

function findDefaultHar(cwd = process.cwd()) {
  const files = fs
    .readdirSync(cwd)
    .filter((name) => name.toLowerCase().endsWith('.har'))
    .sort();

  if (files.length === 0) {
    throw new Error(`No .har file found in ${cwd}`);
  }

  if (files.length > 1) {
    const baselines = files.filter((name) => BASELINE_HAR_NAME.test(name));
    const registrationBaselines = baselines.filter((name) => REGISTRATION_BASELINE_HAR_NAME.test(name));
    if (registrationBaselines.length === 1) return path.join(cwd, registrationBaselines[0]);
    if (baselines.length === 1) return path.join(cwd, baselines[0]);
    throw new Error(`Multiple .har files found; pass one explicitly: ${files.join(', ')}`);
  }

  return path.join(cwd, files[0]);
}

function loadHar(filePath) {
  const selected = filePath || process.env.GPT_RE_HAR || '';
  const resolved = selected ? path.resolve(selected) : findDefaultHar();
  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.log || !Array.isArray(parsed.log.entries)) {
    throw new Error(`Invalid HAR: ${resolved}`);
  }
  return { har: parsed, path: resolved };
}

function entriesOf(har) {
  return (har && har.log && Array.isArray(har.log.entries) ? har.log.entries : []);
}

function summarizeValue(value, depth = 0, options = {}) {
  if (depth > 2) return Array.isArray(value) ? `[array:${value.length}]` : typeof value;
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sample: value.length ? summarizeValue(value[0], depth + 1, options) : undefined,
    };
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, child]) => [key, summarizeValue(child, depth + 1, options)]));
  }
  if (typeof value === 'string') {
    return {
      type: 'string',
      length: value.length,
      sampleShape: options.redact === false ? redactText(value.slice(0, 64)) : '<redacted>',
    };
  }
  return typeof value;
}

function bodySummary(postData, options = {}) {
  if (!postData) return null;
  const text = postData.text || '';
  const parsed = tryParseJson(text);
  return {
    mimeType: postData.mimeType || '',
    params: (postData.params || []).map((param) => param.name),
    textLength: text.length,
    jsonKeys: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [],
    shape: parsed === null ? undefined : summarizeValue(parsed, 0, { redact: options.redact !== false }),
    text: options.includeText ? (options.redact ? redactBody(text) : text) : undefined,
  };
}

function hostCounts(entries) {
  const counts = {};
  for (const entry of entries) {
    const host = parseUrl(entry.request?.url)?.host || '';
    counts[host] = (counts[host] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

module.exports = {
  bodySummary,
  entriesOf,
  findDefaultHar,
  hostCounts,
  loadHar,
  summarizeValue,
  // Re-exported from http-shape.js, which is where they now live.
  base64urlDecode,
  base64urlEncode,
  cookieNames,
  getHeader,
  headerNames,
  parseUrl,
  queryNames,
  redactBody,
  redactUrl,
  responseLocation,
  sha256Short,
  tryParseJson,
};
