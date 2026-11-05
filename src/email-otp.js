'use strict';

const { parse } = require('parse5');

const EMAIL_OTP_PATTERN = /^[A-Z0-9]{4,8}$/i;
const HIDDEN_HTML_NODES = new Set(['head', 'noscript', 'script', 'style', 'template']);

function normalizeEmailOtp(value) {
  const code = String(value || '').trim();
  if (!EMAIL_OTP_PATTERN.test(code) || !/\d/.test(code)) return '';
  return code;
}

function visibleNodeText(node, hidden = false) {
  if (!node) return '';
  const nextHidden = hidden || HIDDEN_HTML_NODES.has(String(node.tagName || '').toLowerCase());
  if (nextHidden) return '';
  if (node.nodeName === '#text') return String(node.value || '');
  return (node.childNodes || []).map((child) => visibleNodeText(child, nextHidden)).join(' ');
}

function readableEmailText(value) {
  return visibleNodeText(parse(String(value || ''))).replace(/\s+/g, ' ').trim();
}

function extractEmailOtp(value) {
  const text = readableEmailText(value);
  const contextual = text.matchAll(
    /(?:\bverification\s+code\b|\bsecurity\s+code\b|\bone[-\s]?time(?:\s+(?:password|code))?\b|\botp\b|\bpasscode\b|\bcode\b|\u9a8c\u8bc1\u7801)\s*(?:is\b|[:#-]|\u4e3a|\u662f)?\s*([A-Z0-9]{4,8})\b/gi,
  );
  for (const match of contextual) {
    const code = normalizeEmailOtp(match[1]);
    if (code) return code;
  }

  const numericFallback = text.match(/\b(\d{6})\b/);
  return normalizeEmailOtp(numericFallback?.[1]);
}

module.exports = {
  extractEmailOtp,
  normalizeEmailOtp,
};
