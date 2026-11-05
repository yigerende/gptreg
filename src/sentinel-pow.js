'use strict';

function encodeAnswer(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function sentinelHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489909) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function gatherProofData(options = {}) {
  return [
    options.screenSize || 3000,
    options.date || String(new Date()),
    options.jsHeapSizeLimit || null,
    Math.random(),
    options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0',
    options.scriptSources || '',
    options.hardwareConcurrency || 16,
    options.language || 'zh-CN',
    options.languages || 'zh-CN,zh,en-US,en',
    options.location || 'https://auth.openai.com/log-in',
    options.windowKeys || '',
    options.documentBuild || '',
  ];
}

function runCheck(startedAt, seed, difficulty, data, attempt, options = {}) {
  data[3] = attempt;
  data[9] = Math.round((options.now || (() => performance.now()))() - startedAt);
  const encoded = encodeAnswer(data);
  const hash = sentinelHash(seed + encoded);
  return hash.substring(0, difficulty.length) <= difficulty ? `${encoded}~S` : null;
}

function generateAnswer(seed, difficulty, options = {}) {
  const startedAt = options.now ? options.now() : performance.now();
  const data = gatherProofData(options);
  const maxAttempts = options.maxAttempts || 500000;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const answer = runCheck(startedAt, seed, difficulty, data, attempt, options);
    if (answer) return answer;
  }
  return encodeAnswer('e');
}

function buildEnforcementToken(sentinelResponse, options = {}) {
  const pow = sentinelResponse?.proofofwork;
  if (!pow?.required) return null;
  if (typeof pow.seed !== 'string' || typeof pow.difficulty !== 'string') return null;
  return `gAAAAAB${generateAnswer(pow.seed, pow.difficulty, options)}`;
}

module.exports = {
  buildEnforcementToken,
  sentinelHash,
};
