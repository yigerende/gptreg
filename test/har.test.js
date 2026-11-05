'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { findDefaultHar } = require('../src/har');

function withHarDirectory(names, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-har-'));
  try {
    for (const name of names) fs.writeFileSync(path.join(directory, name), '{}');
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('uses the sole HAR file as the default', () => {
  withHarDirectory(['capture.har'], (directory) => {
    assert.equal(findDefaultHar(directory), path.join(directory, 'capture.har'));
  });
});

test('keeps the localhost registration capture as baseline when diagnostic HAR files coexist', () => {
  withHarDirectory(['chatgpt.com_Archive.har', 'localhost_Archive.har'], (directory) => {
    assert.equal(findDefaultHar(directory), path.join(directory, 'localhost_Archive.har'));
  });
});

test('prefers the full localhost registration capture over a callback-only localhost HAR', () => {
  withHarDirectory(['auth.openai.com.har', 'localhost.har', 'localhost_Archive.har'], (directory) => {
    assert.equal(findDefaultHar(directory), path.join(directory, 'localhost_Archive.har'));
  });
});

test('requires an explicit path when multiple HAR files have no unique registration baseline', () => {
  withHarDirectory(['first.har', 'second.har'], (directory) => {
    assert.throws(() => findDefaultHar(directory), /Multiple \.har files found/);
  });
});
