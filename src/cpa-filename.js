'use strict';

const crypto = require('node:crypto');

const CPA_SUFFIX = '-cpa.json';
const SAFE_ARTIFACT_KEY = /^[a-z0-9][a-z0-9@+._-]{2,254}$/i;
const UNSAFE_FILE_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;
const SAFE_EMAIL_STEM = /^[a-z0-9][a-z0-9@+._-]*$/i;

function cpaFileNameForEmail(value) {
  const email = String(value || '').trim();
  if (!email) throw new Error('CPA email is required for the artifact file name');
  let stem = email.replace(UNSAFE_FILE_CHARACTERS, '_').replace(/[^a-z0-9@+._-]/gi, '_').replace(/[. ]+$/g, '');
  if (!stem) throw new Error('CPA email does not contain a safe file name');
  if (!SAFE_EMAIL_STEM.test(stem)) stem = `email-${stem}`;
  if (stem !== email) {
    const digest = crypto.createHash('sha256').update(email).digest('hex').slice(0, 10);
    stem = `${stem}-${digest}`;
  }
  const maximumStemLength = 240 - CPA_SUFFIX.length;
  if (stem.length > maximumStemLength) {
    const digest = crypto.createHash('sha256').update(email).digest('hex').slice(0, 10);
    stem = `${stem.slice(0, maximumStemLength - digest.length - 1)}-${digest}`;
  }
  return `${stem}${CPA_SUFFIX}`;
}

function isSafeCpaArtifactKey(value) {
  return SAFE_ARTIFACT_KEY.test(String(value || ''));
}

function isCpaArtifactFileName(value) {
  const name = String(value || '');
  return /\.json$/i.test(name) && isSafeCpaArtifactKey(name.slice(0, -'.json'.length));
}

module.exports = {
  cpaFileNameForEmail,
  isCpaArtifactFileName,
  isSafeCpaArtifactKey,
};
