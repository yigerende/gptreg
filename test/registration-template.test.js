'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  compileRegistrationPlan,
  migrateRegistrationTemplate,
  nextScheduleFireAt,
  normalizeRegistrationRobotConfig,
  normalizeRegistrationTemplate,
  normalizeTemplateSchedule,
  registrationTemplate,
} = require('../src/registration-template');

test('registration template migrates the old mail robot fields', () => {
  const template = normalizeRegistrationTemplate({
    batchSize: 4,
    workerConcurrency: 2,
    countryCode: 'de',
  });

  assert.deepEqual(template, {
    templateId: 'mail-v1',
    name: '默认模板',
    mailInterface: 'mailcom',
    rootEmailCount: 4,
    workerCount: 2,
    proxyMode: 'countryPool',
    proxyDistribution: 'capacity',
    localProxyId: '',
    countryCode: 'DE',
    refreshBeforeEachIteration: true,
    iterations: 1,
    onIterationFailure: 'stop',
    // Off unless asked for: a robot that has always produced login states
    // must not start spending phone numbers because it was upgraded.
    postRegistrationOAuth: false,
    // Rental and schedule fields exist on every template; both are inert
    // unless the interface rents mailboxes and a time is set.
    mailRentalWatch: false,
    mailRentalTarget: 200,
    mailRentalBatchSize: 20,
    mailRentalPollIntervalMs: 20_000,
    schedule: { enabled: false, times: [], weekdays: [] },
  });
});

test('a registration template can carry OAuth into the round it schedules', () => {
  // The launch page offers this as two buttons; a scheduled round has nobody
  // standing over it to pick one, so it is a template setting.
  const plain = compileRegistrationPlan(normalizeRegistrationTemplate({ rootEmailCount: 4, workerCount: 4 }), 'mailcom');
  assert.equal(plain.postRegistrationOAuth, false);

  const combined = normalizeRegistrationTemplate({
    rootEmailCount: 4,
    workerCount: 4,
    postRegistrationOAuth: true,
  });
  assert.equal(combined.postRegistrationOAuth, true);
  const plan = compileRegistrationPlan(combined, 'mailcom');
  assert.equal(plan.taskKind, 'register_session');
  assert.equal(plan.postRegistrationOAuth, true);
  // An OAuth-bearing plan is refused without both security features, and the
  // compiled plan already sets them - so the operator is never asked for a
  // combination the run would reject.
  assert.deepEqual(plan.security, { setPassword: true, enrollTotp: true });

  // Anything other than an explicit true leaves the robot producing login
  // states, which is what every existing stored template says.
  for (const value of [undefined, null, false, 'true', 1]) {
    assert.equal(normalizeRegistrationTemplate({ postRegistrationOAuth: value }).postRegistrationOAuth, false);
  }
});

test('registration template no longer accepts current as a new interface', () => {
  assert.throws(
    () => normalizeRegistrationTemplate({ mailInterface: 'current' }, { strict: true }),
    /mailInterface must be one of xiaopingguo, smsbower, mailcom, fastmail/,
  );
});

test('registration template migrates current to an explicit provider', () => {
  assert.equal(migrateRegistrationTemplate({ mailInterface: 'current' }, 'fastmail').mailInterface, 'fastmail');
  assert.equal(migrateRegistrationTemplate({ mailProvider: 'current' }, 'smsbower').mailInterface, 'smsbower');
});

test('registration template keeps proxy refresh mandatory and validates capacity', () => {
  const template = normalizeRegistrationTemplate({
    mailInterface: 'mailcom',
    rootEmailCount: 3,
    workerCount: 3,
    iterations: 2,
    refreshBeforeEachIteration: false,
  }, { strict: true });

  assert.equal(template.refreshBeforeEachIteration, true);
  assert.equal(template.iterations, 2);
  assert.throws(
    () => normalizeRegistrationTemplate({ rootEmailCount: 1, workerCount: 2 }, { strict: true }),
    /workerCount must not exceed rootEmailCount/,
  );
});

test('registration template compiles a local proxy plan', () => {
  const plan = compileRegistrationPlan({
    mailInterface: 'fastmail',
    rootEmailCount: 2,
    workerCount: 1,
    proxyMode: 'local',
    localProxyId: 'local-1',
  }, 'fastmail');

  assert.equal(plan.mailProvider, 'fastmail');
  assert.deepEqual(plan.proxyAssignments, [
    { workerSlot: 1, kind: 'local', localProxyId: 'local-1' },
  ]);
});

test('registration template distributes workers by country-pool capacity', () => {
  const plan = compileRegistrationPlan({
    mailInterface: 'mailcom',
    rootEmailCount: 4,
    workerCount: 4,
    proxyMode: 'countryPool',
    proxyDistribution: 'capacity',
  }, 'mailcom', {
    dynamic: {
      countryPools: [
        { countryCode: 'US', total: 4 },
        { countryCode: 'GB', total: 2 },
      ],
    },
  });

  assert.deepEqual(plan.proxyAssignments.map((assignment) => assignment.countryCode), ['US', 'GB', 'US', 'US']);
});

test('registration template carries 挂租 through to the run plan, and only for SMSBower', () => {
  const rental = normalizeRegistrationTemplate({
    mailInterface: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 120,
    mailRentalBatchSize: 8,
    mailRentalPollIntervalMs: 15_000,
    rootEmailCount: 10,
    workerCount: 5,
  });
  assert.equal(rental.mailRentalWatch, true);
  const plan = compileRegistrationPlan(rental, 'smsbower');
  // The broker's target is the plan's mailbox count; the template's roots only
  // matter for an ordinary rental.
  assert.equal(plan.mailCount, 120);
  assert.equal(plan.mailRentalWatch, true);
  assert.equal(plan.mailRentalBatchSize, 8);
  assert.equal(plan.mailRentalPollIntervalMs, 15_000);

  // Every other interface pools mailboxes, so the switch turns itself off
  // rather than producing a plan the run manager would reject.
  const pooled = normalizeRegistrationTemplate({ mailInterface: 'mailcom', mailRentalWatch: true, rootEmailCount: 10, workerCount: 5 });
  assert.equal(pooled.mailRentalWatch, false);
  const pooledPlan = compileRegistrationPlan(pooled, 'mailcom');
  assert.equal(pooledPlan.mailCount, 10);
  assert.equal(Object.hasOwn(pooledPlan, 'mailRentalWatch'), false);
});

test('template schedule keeps only real clock times and finds the next one', () => {
  const schedule = normalizeTemplateSchedule({ enabled: true, times: ['09:00', '24:00', '9:00', '21:30', '09:00'], weekdays: [1, 9, 5] });
  assert.deepEqual(schedule.times, ['09:00', '21:30']);
  assert.deepEqual(schedule.weekdays, [1, 5]);

  // Monday 2026-09-21, 08:00 local.
  const monday = new Date(2026, 8, 21, 8, 0, 0, 0).getTime();
  const first = nextScheduleFireAt(schedule, monday);
  assert.equal(new Date(first).getDay(), 1);
  assert.equal(new Date(first).getHours(), 9);
  const second = nextScheduleFireAt(schedule, first);
  assert.equal(new Date(second).getHours(), 21);
  // Tuesday through Thursday are excluded, so the next one is Friday.
  const third = nextScheduleFireAt(schedule, second);
  assert.equal(new Date(third).getDay(), 5);

  // A schedule with no time never fires, however it is flagged.
  assert.equal(normalizeTemplateSchedule({ enabled: true, times: [] }).enabled, false);
  assert.equal(nextScheduleFireAt(normalizeTemplateSchedule({ enabled: true, times: [] }), monday), null);
  assert.equal(nextScheduleFireAt(normalizeTemplateSchedule({ enabled: false, times: ['09:00'] }), monday), null);
});

test('robot config keeps several named templates and one active id', () => {
  const config = normalizeRegistrationRobotConfig({
    templates: [
      { templateId: 'gb', name: 'GB 挂租', mailInterface: 'smsbower', mailRentalWatch: true },
      { templateId: 'gb', name: '重名', mailInterface: 'mailcom' },
    ],
    activeTemplateId: 'missing',
  });
  assert.deepEqual(config.templates.map((template) => template.templateId), ['gb', 'gb-2']);
  // An unknown active id falls back to the first template rather than leaving
  // the robot with nothing to run.
  assert.equal(config.activeTemplateId, 'gb');
  assert.equal(registrationTemplate(config, 'gb-2').mailInterface, 'mailcom');
  assert.equal(registrationTemplate(config, '').templateId, 'gb');
});
