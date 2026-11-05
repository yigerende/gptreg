'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const WEB_DIR = path.join(ROOT, 'web');
const QUICK_NODE_TESTS = [
  'registration-template.test.js',
  'smsbower-mail-settings.test.js',
  'docker-runtime.test.js',
  'run-manager-cleanup.test.js',
  'robot-service.test.js',
];
const QUICK_WEB_TESTS = [
  'src/RobotsPage.test.tsx',
  'src/components/AppSelect.test.tsx',
  'src/components/ConsoleUi.test.tsx',
];
let testForceExitSupport;

/**
 * Pin the capture the remaining capture-bound tests replay.
 *
 * Those tests call `loadHar()` with no argument, which scans the repo root.
 * That worked while exactly one baseline capture sat there; a second one
 * arrived and `findDefaultHar` started refusing to choose, which failed 70-odd
 * tests at once for a reason that had nothing to do with any of them. The
 * production console does not rely on this — it builds its requests from the
 * templates in code — so this only serves the tests that still diff against a
 * recording, and it picks the oldest baseline so a newly dropped capture never
 * silently changes what they assert.
 */
function pinTestCapture() {
  if (process.env.GPT_RE_HAR) return;
  const captures = fs.readdirSync(ROOT)
    .filter((name) => /^localhost[_-]archive\b.*\.har$/i.test(name))
    .sort();
  if (!captures.length) return;
  process.env.GPT_RE_HAR = path.join(ROOT, captures[0]);
}

function allNodeTests() {
  return fs.readdirSync(TEST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => entry.name)
    .sort();
}

function resolveTestFiles(names) {
  return names.map((name) => path.join(TEST_DIR, name));
}

function resolveVitestCli() {
  try {
    return require.resolve('vitest/vitest.mjs', { paths: [ROOT] });
  } catch (error) {
    throw new Error('Vitest is not installed. Run npm.cmd install before running Web tests.', { cause: error });
  }
}

function formatDuration(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(2)}s`;
}

function supportsTestForceExit() {
  if (testForceExitSupport !== undefined) return testForceExitSupport;
  const result = spawnSync(process.execPath, ['--test', '--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  testForceExitSupport = `${result.stdout || ''}\n${result.stderr || ''}`.includes('--test-force-exit');
  return testForceExitSupport;
}

function runProcess(label, command, args, cwd) {
  process.stdout.write(`\n[test] ${label}\n`);
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });

  if (result.error) {
    process.stderr.write(`[test] ${label} could not start: ${result.error.message}\n`);
    return 1;
  }
  if (result.status !== 0) {
    const reason = result.status === null ? `signal ${result.signal || 'unknown'}` : `exit ${result.status}`;
    process.stderr.write(`[test] ${label} failed (${reason}) after ${formatDuration(startedAt)}\n`);
    return result.status || 1;
  }

  process.stdout.write(`[test] ${label} passed in ${formatDuration(startedAt)}\n`);
  return 0;
}

function runNodeTests(names, options = {}, extraArgs = []) {
  const args = ['--test'];
  if (options.forceExit && supportsTestForceExit()) args.push('--test-force-exit');
  if (options.concurrency) args.push(`--test-concurrency=${options.concurrency}`);
  args.push(...extraArgs, ...resolveTestFiles(names));
  return runProcess(options.label || 'Node tests', process.execPath, args, ROOT);
}

function runWebTests(files, label) {
  const args = [resolveVitestCli(), 'run'];
  if (files) args.push(...files);
  return runProcess(label || 'Web tests', process.execPath, args, WEB_DIR);
}

const suites = {
  quick: (args) => runNodeTests(QUICK_NODE_TESTS, { label: 'registration backend tests' }, args),
  'ui-server-quick': (args) => runNodeTests(QUICK_NODE_TESTS, { label: 'ui-server quick tests' }, args),
  'ui-server': (args) => runNodeTests(['ui-server.test.js'], { forceExit: true, label: 'ui-server tests' }, args),
  all: (_args) => runNodeTests(allNodeTests(), { concurrency: 4, forceExit: true, label: 'all Node tests' }, _args),
  'web-quick': () => runWebTests(QUICK_WEB_TESTS, 'registration UI tests'),
  web: () => runWebTests(null, 'all Web tests'),
  'ui-quick': (args) => {
    const backendStatus = runNodeTests(QUICK_NODE_TESTS, { label: 'ui-server quick tests' }, args);
    return backendStatus || runWebTests(QUICK_WEB_TESTS, 'registration UI tests');
  },
  ui: (args) => {
    const backendStatus = runNodeTests(['ui-server.test.js'], { forceExit: true, label: 'ui-server tests' }, args);
    return backendStatus || runWebTests(null, 'all Web tests');
  },
};

function printUsage() {
  process.stderr.write([
    'Usage: node scripts/run-tests.js <suite> [Node test options]',
    '',
    'Suites:',
    '  quick              Registration backend regression tests (default)',
    '  ui-server-quick    Registration-focused ui-server regression tests',
    '  ui-server           Complete test/ui-server.test.js',
    '  all                 All Node tests with concurrency 4',
    '  web-quick           Registration configuration UI tests',
    '  web                 All Vitest tests',
    '  ui-quick            ui-server quick tests plus registration UI tests',
    '  ui                  Complete ui-server plus all Vitest tests',
  ].join('\n') + '\n');
}

const suiteName = process.argv[2] || 'quick';
const extraArgs = process.argv.slice(3);
if (suiteName === '--help' || suiteName === '-h') {
  printUsage();
  process.exitCode = 0;
} else if (!suites[suiteName]) {
  printUsage();
  process.exitCode = 2;
} else {
  try {
    pinTestCapture();
    process.exitCode = suites[suiteName](extraArgs);
  } catch (error) {
    process.stderr.write(`[test] ${error.message}\n`);
    process.exitCode = 1;
  }
}
