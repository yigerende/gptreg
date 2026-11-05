'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { validateV2Config } = require('../src/config-v2');
const { applyRunPlan, normalizeRunPlan } = require('../src/run-plan');

function defaults(overrides = {}) {
  return validateV2Config({
    schemaVersion: 2,
    mail: { count: overrides.mailCount || 2 },
    aliases: {
      strategy: 'plus',
      count: overrides.aliasCount || 2,
      maxAttempts: Math.max(4, overrides.aliasCount || 2),
      runTag: 'task',
      plusAddressingEnabled: true,
    },
    sms: { provider: 'mock', maxPrice: 0 },
    workers: { maxConcurrency: overrides.workerConcurrency || 2 },
  });
}

test('normalizes a compact task plan and applies it without changing resource configuration', () => {
  const base = defaults();
  const plan = normalizeRunPlan({
    mailCount: 4,
    workerConcurrency: 3,
    aliasEnabled: true,
  }, base);
  const effective = applyRunPlan(base, plan);

  // The switch fixes the arithmetic: two accounts per mailbox, no more. The
  // requested `aliasCount`/`aliasMaxAttempts` inputs are gone, so a plan asking
  // for three per root now gets two.
  assert.equal(plan.aliasCount, 2);
  assert.equal(plan.aliasMaxAttempts, 2);
  assert.equal(plan.totalAccounts, 8);
  assert.equal(effective.mail.count, 4);
  assert.equal(effective.workers.maxConcurrency, 3);
  assert.equal(effective.aliases.count, 2);
  assert.equal(effective.sms.provider, base.sms.provider);
  assert.equal(effective.mail.baseUrl, base.mail.baseUrl);
});

test('a persisted task plan remains independent from later global task defaults', () => {
  const plan = normalizeRunPlan({
    mailCount: 3,
    workerConcurrency: 2,
    aliasStrategy: 'root',
  }, defaults());
  const changedDefaults = defaults({ mailCount: 8, aliasCount: 6, workerConcurrency: 8 });
  const effective = applyRunPlan(changedDefaults, plan);

  assert.equal(effective.mail.count, 3);
  assert.equal(effective.workers.maxConcurrency, 2);
  assert.equal(effective.aliases.strategy, 'root');
  assert.equal(effective.aliases.count, 1);
  assert.equal(effective.aliases.maxAttempts, 1);
});

test('task concurrency cannot exceed the number of requested root mailboxes', () => {
  assert.throws(
    () => normalizeRunPlan({ mailCount: 2, workerConcurrency: 3 }, defaults()),
    /must not exceed plan\.mailCount/,
  );
});

test('schema v2 requires one unique proxy assignment for every Worker', () => {
  const plan = normalizeRunPlan({
    schemaVersion: 2,
    mailCount: 2,
    workerConcurrency: 2,
    proxyAssignments: [
      { workerSlot: 1, kind: 'local', localProxyId: 'proxy-local-1' },
      { workerSlot: 2, kind: 'countryPool', countryCode: 'cl' },
    ],
  }, defaults());
  assert.deepEqual(plan.proxyAssignments, [
    { workerSlot: 1, kind: 'local', localProxyId: 'proxy-local-1' },
    { workerSlot: 2, kind: 'countryPool', countryCode: 'CL' },
  ]);
  assert.equal(applyRunPlan(defaults(), plan).proxyPool.required, true);

  assert.throws(() => normalizeRunPlan({
    schemaVersion: 2,
    mailCount: 2,
    workerConcurrency: 2,
    proxyAssignments: [{ workerSlot: 1, kind: 'local', localProxyId: 'proxy-local-1' }],
  }, defaults()), /exactly one assignment per Worker/);

  assert.throws(() => normalizeRunPlan({
    schemaVersion: 2,
    mailCount: 2,
    workerConcurrency: 2,
    proxyAssignments: [
      { workerSlot: 1, kind: 'local', localProxyId: 'proxy-local-1' },
      { workerSlot: 2, kind: 'local', localProxyId: 'proxy-local-1' },
    ],
  }, defaults()), /cannot be assigned to multiple Workers/);
});

test('schema v3 normalizes login-state and OAuth task inputs with the new registration default', () => {
  const legacy = normalizeRunPlan({ mailCount: 1, workerConcurrency: 1 }, defaults());
  assert.equal(legacy.taskKind, 'register_session');
  assert.equal(legacy.oauthSource, null);
  assert.equal(legacy.postRegistrationOAuth, false);
  assert.deepEqual(legacy.security, { setPassword: true, enrollTotp: true });

  const registration = normalizeRunPlan({
    schemaVersion: 3,
    taskKind: 'register_session',
    mailCount: 2,
    workerConcurrency: 2,
    security: { setPassword: true, enrollTotp: false },
    proxyAssignments: [
      { workerSlot: 1, kind: 'local', localProxyId: 'local-one' },
      { workerSlot: 2, kind: 'countryPool', countryCode: 'us' },
    ],
  }, defaults());
  assert.equal(registration.taskKind, 'register_session');
  assert.deepEqual(registration.security, { setPassword: true, enrollTotp: false });

  const combined = normalizeRunPlan({
    taskKind: 'register_oauth',
    mailCount: 1,
    workerConcurrency: 1,
  }, defaults());
  assert.deepEqual(combined.security, { setPassword: true, enrollTotp: true });

  const oauth = normalizeRunPlan({
    schemaVersion: 3,
    taskKind: 'oauth',
    workerConcurrency: 2,
    oauthSource: { kind: 'session_assets', assetIds: ['asset-one', 'asset-two'] },
    proxyAssignments: [
      { workerSlot: 1, kind: 'local', localProxyId: 'local-one' },
      { workerSlot: 2, kind: 'countryPool', countryCode: 'cl' },
    ],
  }, defaults());
  assert.equal(oauth.mailCount, 2);
  assert.equal(oauth.aliasStrategy, 'root');
  assert.equal(oauth.totalAccounts, 2);
  assert.deepEqual(oauth.oauthSource.assetIds, ['asset-one', 'asset-two']);
  assert.deepEqual(oauth.security, { setPassword: false, enrollTotp: false });
});

test('a credentials OAuth source keeps every account it is given', () => {
  const plan = normalizeRunPlan({
    schemaVersion: 3,
    taskKind: 'oauth',
    workerConcurrency: 2,
    oauthSource: {
      kind: 'credentials',
      accounts: [
        { email: 'one@example.test', password: 'Gpt-One!8a', totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' },
        { email: 'two@example.test', password: 'Gpt-Two!8a', totpSecret: '7WEBP5YJ4LKB6BCWYKUR6MVMFEAQTBUK' },
      ],
    },
    proxyAssignments: [
      { workerSlot: 1, kind: 'maintenance' },
      { workerSlot: 2, kind: 'maintenance' },
    ],
  }, defaults());
  assert.equal(plan.mailCount, 2);
  assert.equal(plan.totalAccounts, 2);
  assert.equal(plan.aliasStrategy, 'root');
  assert.deepEqual(plan.oauthSource.accounts.map((account) => account.email), ['one@example.test', 'two@example.test']);
  // The secrets have to survive normalization: they are the whole source.
  assert.equal(plan.oauthSource.accounts[0].password, 'Gpt-One!8a');
  assert.equal(plan.oauthSource.accounts[0].totpSecret, 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  assert.deepEqual(plan.security, { setPassword: false, enrollTotp: false });
});

test('loginOnly is kept on an oauth source and dropped from a refresh', () => {
  const credentials = normalizeRunPlan({
    schemaVersion: 3,
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: {
      kind: 'credentials',
      loginOnly: true,
      accounts: [{ email: 'one@example.test', password: 'Gpt-One!8a', totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' }],
    },
    proxyAssignments: [{ workerSlot: 1, kind: 'maintenance' }],
  }, defaults());
  assert.equal(credentials.oauthSource.loginOnly, true);
  const oauth = normalizeRunPlan({
    schemaVersion: 3,
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: ['asset-one'] },
    proxyAssignments: [{ workerSlot: 1, kind: 'maintenance' }],
  }, defaults());
  assert.equal(oauth.oauthSource.loginOnly, undefined);
  const refresh = normalizeRunPlan({
    schemaVersion: 3,
    taskKind: 'session_refresh',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: ['asset-one'], loginOnly: true },
    proxyAssignments: [{ workerSlot: 1, kind: 'maintenance' }],
  }, defaults());
  assert.equal(refresh.oauthSource.loginOnly, undefined);
});

test('credential sources reject anything that cannot sign in unaided', () => {
  const base = {
    schemaVersion: 3,
    taskKind: 'oauth',
    workerConcurrency: 1,
    proxyAssignments: [{ workerSlot: 1, kind: 'local', localProxyId: 'local-one' }],
  };
  const account = (patch) => ({
    email: 'one@example.test',
    password: 'Gpt-One!8a',
    totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    ...patch,
  });
  assert.throws(() => normalizeRunPlan({
    ...base,
    oauthSource: { kind: 'credentials', accounts: [account({ email: 'bad-address' })] },
  }, defaults()), /Invalid OAuth credential email/);
  // A passwordless account would silently fall back to a mailbox this task
  // never opens, so it has to be refused rather than accepted and hung on.
  assert.throws(() => normalizeRunPlan({
    ...base,
    oauthSource: { kind: 'credentials', accounts: [account({ password: '' })] },
  }, defaults()), /missing a password/);
  assert.throws(() => normalizeRunPlan({
    ...base,
    oauthSource: { kind: 'credentials', accounts: [account({ totpSecret: 'not-base32!' })] },
  }, defaults()), /invalid TOTP secret/);
  assert.throws(() => normalizeRunPlan({
    ...base,
    oauthSource: { kind: 'credentials', accounts: [account({}), account({ email: 'ONE@example.test' })] },
  }, defaults()), /must not contain duplicates/);
  assert.throws(() => normalizeRunPlan({
    ...base,
    oauthSource: { kind: 'email_otp', emails: ['one@example.test'] },
  }, defaults()), /must be "session_assets" or "credentials"/);
});

test('a maintenance lane is a valid assignment and every Worker may share it', () => {
  // Upkeep goes through one local forwarder, so unlike a local proxy entry it is
  // deliberately not exclusive to a single Worker.
  const plan = normalizeRunPlan({
    schemaVersion: 3,
    taskKind: 'oauth',
    workerConcurrency: 3,
    oauthSource: { kind: 'session_assets', assetIds: ['a', 'b', 'c'] },
    proxyAssignments: [
      { workerSlot: 1, kind: 'maintenance' },
      { workerSlot: 2, kind: 'maintenance' },
      { workerSlot: 3, kind: 'maintenance' },
    ],
  }, defaults({ workerConcurrency: 3 }));

  assert.deepEqual(plan.proxyAssignments, [
    { workerSlot: 1, kind: 'maintenance' },
    { workerSlot: 2, kind: 'maintenance' },
    { workerSlot: 3, kind: 'maintenance' },
  ]);
});

test('OAuth without a proxy selection defaults every Worker to maintenance', () => {
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 3,
    oauthSource: { kind: 'session_assets', assetIds: ['a', 'b', 'c'] },
  }, defaults({ workerConcurrency: 3 }));

  assert.equal(plan.schemaVersion, 3);
  assert.deepEqual(plan.proxyAssignments, [
    { workerSlot: 1, kind: 'maintenance' },
    { workerSlot: 2, kind: 'maintenance' },
    { workerSlot: 3, kind: 'maintenance' },
  ]);
});

test('an unknown assignment kind still names the three that exist', () => {
  assert.throws(() => normalizeRunPlan({
    schemaVersion: 3,
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: ['a'] },
    proxyAssignments: [{ workerSlot: 1, kind: 'satellite' }],
  }, defaults({ workerConcurrency: 1 })), /"local", "countryPool" or "maintenance"/);
});

function rentalDefaults() {
  const base = defaults({ workerConcurrency: 2, mailCount: 2, aliasCount: 2 });
  // A price cap is mandatory for the rental channel, exactly as it is for SMS.
  return { ...base, mail: { ...base.mail, provider: 'smsbower', service: 'dr', domain: 'gmail.com', maxPrice: 0.2 } };
}

function rentalPlan(overrides = {}) {
  return normalizeRunPlan({
    taskKind: 'register_oauth',
    mailCount: 2,
    workerConcurrency: 2,
    aliasEnabled: false,
    mailProvider: 'smsbower',
    security: { setPassword: true, enrollTotp: true },
    ...overrides,
  }, rentalDefaults());
}

test('ordinary and hang-rental targets share the 1000 mailbox configuration limit', () => {
  for (const mailRentalWatch of [false, true]) {
    for (const count of [271, 1000]) {
      const plan = rentalPlan({
        mailCount: count, mailRentalWatch,
        ...(mailRentalWatch ? { mailRentalTarget: count } : {}),
      });
      assert.equal(validateV2Config(applyRunPlan(rentalDefaults(), plan)).mail.count, count);
    }
    assert.throws(() => rentalPlan({
      mailCount: 1001, mailRentalWatch,
      ...(mailRentalWatch ? { mailRentalTarget: 1001 } : {}),
    }), /must be an integer between 1 and 1000/);
  }
  assert.throws(() => validateV2Config({ ...defaults(), mail: { count: 1001 } }, {
    maxMailCount: 10000,
  }), /mail\.count must be an integer between 1 and 1000/);
});

test('an SMSBower hang-rental plan carries the broker limits and interval', () => {
  const plan = rentalPlan({
    taskKind: 'register_session',
    mailRentalWatch: true,
    mailRentalTarget: 200,
    mailRentalBatchSize: 20,
    mailRentalPollIntervalMs: 30_000,
  });

  assert.equal(plan.mailRentalWatch, true);
  assert.equal(plan.mailCount, 200);
  assert.equal(plan.mailRentalTarget, 200);
  assert.equal(plan.mailRentalBatchSize, 20);
  assert.equal(plan.mailRentalPollIntervalMs, 30_000);
  assert.equal(plan.totalAccounts, 200);

  const fast = rentalPlan({
    taskKind: 'register_session',
    mailRentalWatch: true,
    mailRentalTarget: 2,
    mailRentalBatchSize: 2,
    mailRentalPollIntervalMs: 1_000,
  });
  assert.equal(fast.mailRentalPollIntervalMs, 1_000);

  const extended = rentalPlan({
    taskKind: 'register_session',
    mailRentalWatch: true,
    mailRentalTarget: 201,
    mailRentalBatchSize: 20,
    mailRentalPollIntervalMs: 30_000,
  });
  assert.equal(extended.mailCount, 201);
  assert.equal(extended.totalAccounts, 201);

  assert.throws(
    () => rentalPlan({ mailRentalWatch: true, mailRentalTarget: 1_001 }),
    /plan\.mailRentalTarget must be an integer between 1 and 1000/,
  );
  assert.throws(
    () => rentalPlan({ mailRentalWatch: true, mailRentalBatchSize: 21 }),
    /plan\.mailRentalBatchSize must be an integer between 1 and 20/,
  );
  assert.throws(
    () => rentalPlan({ mailRentalWatch: true, mailRentalPollIntervalMs: 999 }),
    /plan\.mailRentalPollIntervalMs must be an integer between 1000 and 3600000/,
  );
});

test('the mail channel travels with the plan so a task can pick it per run', () => {
  const plan = rentalPlan();
  assert.equal(plan.mailProvider, 'smsbower');
  // And it wins over the saved default when the plan names one.
  assert.equal(normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, mailProvider: 'xiaopingguo' }, rentalDefaults()).mailProvider, 'xiaopingguo');
  const effective = applyRunPlan(rentalDefaults(), rentalPlan());
  assert.equal(effective.mail.provider, 'smsbower');
  assert.equal(effective.mail.maxPollAttempts, 3);
});

test('a persisted remote provider also selects its own endpoint on resume', () => {
  const base = validateV2Config({
    ...defaults(),
    mail: {
      ...defaults().mail,
      provider: 'fastmail',
      mailcomBaseUrl: 'http://mailcom.internal:8001',
      fastmailBaseUrl: 'http://fastmail.internal:8001',
    },
  });
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    mailProvider: 'mailcom',
  }, base);

  const resumed = applyRunPlan(base, plan);
  assert.equal(resumed.mail.provider, 'mailcom');
  assert.equal(resumed.mail.baseUrl, 'http://mailcom.internal:8001');
  assert.equal(resumed.mail.fastmailBaseUrl, 'http://fastmail.internal:8001');
  assert.equal(resumed.mail.maxPollAttempts, 15);
});

test('a rented mailbox allows registration without OAuth but requires password and TOTP', () => {
  const registration = rentalPlan({ taskKind: 'register_session' });
  assert.equal(registration.postRegistrationOAuth, false);
  assert.deepEqual(registration.security, { setPassword: true, enrollTotp: true });
  // OAuth remains an explicit opt-in for the same rental channel.
  assert.equal(rentalPlan({ taskKind: 'register_session', postRegistrationOAuth: true }).postRegistrationOAuth, true);
  assert.throws(() => rentalPlan({ security: { setPassword: false, enrollTotp: true } }), /setPassword and security\.enrollTotp/);
  assert.throws(() => rentalPlan({ security: { setPassword: true, enrollTotp: false } }), /setPassword and security\.enrollTotp/);
});

test('a task that continues into OAuth is refused without password and TOTP', () => {
  // The OAuth leg mints a CPA someone else signs into, and the only
  // credentials that outlive the run are the password and the TOTP secret.
  // Refused at the plan rather than discovered one held account at a time.
  const combined = (security) => normalizeRunPlan({
    taskKind: 'register_session',
    postRegistrationOAuth: true,
    mailCount: 1,
    workerConcurrency: 1,
    security,
  }, defaults());
  assert.equal(combined({ setPassword: true, enrollTotp: true }).postRegistrationOAuth, true);
  assert.throws(() => combined({ setPassword: false, enrollTotp: true }), /continues into OAuth requires both/);
  assert.throws(() => combined({ setPassword: true, enrollTotp: false }), /continues into OAuth requires both/);
  assert.throws(() => combined({ setPassword: false, enrollTotp: false }), /continues into OAuth requires both/);
  // `register_oauth` normalizes to the same shape, so it is bound by the rule
  // its own name promises.
  assert.throws(() => normalizeRunPlan({
    taskKind: 'register_oauth',
    mailCount: 1,
    workerConcurrency: 1,
    security: { setPassword: true, enrollTotp: false },
  }, defaults()), /continues into OAuth requires both/);

  // Registration on its own keeps the choice: an account with no TOTP is a
  // thin login state, not an unusable product, and it can be finished later.
  const registrationOnly = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    security: { setPassword: true, enrollTotp: false },
  }, defaults());
  assert.deepEqual(registrationOnly.security, { setPassword: true, enrollTotp: false });
});

test('one Gmail rental registers one account: the address it issued', () => {
  // Deriving a `+alias` from a rented address was dropped. It doubled the codes
  // one mailbox had to receive, and running its code quota out was a real
  // failure mode rather than a theoretical one.
  const plan = rentalPlan();
  assert.equal(plan.aliasStrategy, 'root');
  assert.equal(plan.aliasCount, 1);
  assert.equal(plan.totalAccounts, plan.mailCount, 'one rented mailbox is exactly one account');
  // Any other strategy is normalized rather than refused, so a plan saved
  // before this change still starts instead of erroring.
  assert.equal(rentalPlan({ aliasStrategy: 'plus' }).aliasStrategy, 'root');
  assert.equal(rentalPlan({ aliasStrategy: 'root_plus' }).aliasStrategy, 'root');
  // Even asked for outright, the switch cannot open on a rental.
  assert.equal(rentalPlan({ aliasEnabled: true }).aliasEnabled, false);
  assert.equal(rentalPlan({ aliasEnabled: true }).aliasCount, 1);
  // The pooled channel reads an old `plus` as "alias on", which is now the only
  // alias shape there is: the root address plus one sub-address.
  assert.equal(normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'plus' }, defaults()).aliasStrategy, 'root_plus');
});

test('the pooled channel keeps every combination it always allowed', () => {
  const base = defaults();
  assert.equal(normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1 }, base).mailProvider, 'xiaopingguo');
  assert.equal(normalizeRunPlan({ taskKind: 'oauth', workerConcurrency: 1, oauthSource: { kind: 'session_assets', assetIds: ['a'] } }, base).mailProvider, 'xiaopingguo');
});

test('a rental plan survives applyRunPlan and re-validation', () => {
  // Every rule this plan meets is checked somewhere else; what this covers is
  // the round trip, which is where it broke before: the plan has to already
  // carry the full chain so the resource summary previews what will be started.
  const plan = rentalPlan();
  assert.equal(plan.postRegistrationOAuth, true);

  const effective = applyRunPlan(rentalDefaults(), plan);
  assert.equal(effective.aliases.strategy, 'root');
  // A rental derives nothing, so plus addressing is not needed and must not be
  // switched on behind the operator's back.
  assert.equal(effective.aliases.plusAddressingEnabled, false);
  assert.equal(effective.mail.provider, 'smsbower');

  // The effective config is what the run is validated against, so it must pass.
  assert.doesNotThrow(() => validateV2Config(effective));
});

test('the pooled channel still turns plus addressing off for a root-only plan', () => {
  const effective = applyRunPlan(defaults(), normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, defaults()));
  assert.equal(effective.aliases.plusAddressingEnabled, false);
});

test('the alias switch is the only alias input, and it is off by default', () => {
  const base = defaults();
  const plan = (input) => normalizeRunPlan({ taskKind: 'register_session', mailCount: 5, workerConcurrency: 1, ...input }, base);

  const off = plan({});
  assert.equal(off.aliasEnabled, false, 'a plan that says nothing registers root addresses only');
  assert.equal(off.aliasStrategy, 'root');
  assert.equal(off.aliasCount, 1);
  assert.equal(off.totalAccounts, 5);

  const on = plan({ aliasEnabled: true });
  assert.equal(on.aliasStrategy, 'root_plus');
  assert.equal(on.aliasCount, 2, 'the root address and exactly one sub-address');
  // `aliasMaxAttempts` used to allow replacement addresses past the target; a
  // failed alias now simply does not get a second address.
  assert.equal(on.aliasMaxAttempts, 2);
  assert.equal(on.totalAccounts, 10);

  // Asking for more than the switch allows changes nothing.
  assert.equal(plan({ aliasEnabled: true, aliasCount: 6, aliasMaxAttempts: 8 }).aliasCount, 2);

  // A plan saved before the switch existed is read through its old strategy
  // rather than rejected, so it still starts.
  assert.equal(plan({ aliasStrategy: 'plus' }).aliasEnabled, true);
  assert.equal(plan({ aliasStrategy: 'root_plus' }).aliasEnabled, true);
  assert.equal(plan({ aliasStrategy: 'root' }).aliasEnabled, false);
  // An explicit switch always wins over the legacy field.
  assert.equal(plan({ aliasStrategy: 'plus', aliasEnabled: false }).aliasEnabled, false);
});

test('work on existing login states is not held to the mail-channel rules', () => {
  // `mailProvider` comes from the config file whether or not a task will ever
  // open a mailbox, so selecting a rental channel used to fail preflight for
  // every login-state OAuth and every session refresh: they were asked to
  // enable a password and TOTP they were never going to set, to protect a
  // mailbox they were never going to open.
  const source = { kind: 'session_assets', assetIds: ['asset-one'] };
  for (const provider of ['mailcom', 'fastmail', 'smsbower', 'xiaopingguo']) {
    const config = { ...rentalDefaults(), mail: { ...rentalDefaults().mail, provider } };
    for (const taskKind of ['oauth', 'session_refresh']) {
      const plan = normalizeRunPlan({ schemaVersion: 3, taskKind, oauthSource: source, workerConcurrency: 1 }, config);
      assert.equal(plan.taskKind, taskKind);
      // No mailbox, so no password/TOTP requirement is imposed on it.
      assert.deepEqual(plan.security, { setPassword: false, enrollTotp: false });
    }
  }
});

test('registration through a rental channel is still refused without password and TOTP', () => {
  const mailcom = () => {
    const base = rentalDefaults();
    return { ...base, mail: { ...base.mail, provider: 'mailcom' } };
  };
  assert.throws(
    () => normalizeRunPlan({
      taskKind: 'register_oauth',
      mailCount: 1,
      workerConcurrency: 1,
      mailProvider: 'mailcom',
      security: { setPassword: false, enrollTotp: false },
    }, mailcom()),
    /mail\.com API channel requires both security\.setPassword and security\.enrollTotp/,
  );
});

test('Fastmail registration uses the remote-pool security rules', () => {
  const base = defaults();
  const config = { ...base, mail: { ...base.mail, provider: 'fastmail' } };
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    mailProvider: 'fastmail',
  }, config);

  assert.equal(plan.aliasEnabled, false);
  assert.equal(plan.aliasCount, 1);
  assert.deepEqual(plan.security, { setPassword: true, enrollTotp: true });
  assert.doesNotThrow(() => validateV2Config(applyRunPlan(config, plan)));
  assert.throws(
    () => normalizeRunPlan({
      taskKind: 'register_session',
      mailCount: 1,
      workerConcurrency: 1,
      mailProvider: 'fastmail',
      security: { setPassword: false, enrollTotp: false },
    }, config),
    /Fastmail API channel requires both security\.setPassword and security\.enrollTotp/,
  );
});

test('iCloud registration can add one local plus alias and keeps its endpoint outside Mail API settings', () => {
  const base = validateV2Config({
    ...defaults(),
    mail: {
      ...defaults().mail,
      provider: 'icloud',
      icloudBaseUrl: 'http://icloud.example.test:8001',
      mailcomBaseUrl: 'http://mailcom.example.test:8001',
      fastmailBaseUrl: 'http://fastmail.example.test:8001',
      aliasDomainMode: 'selected',
      aliasDomains: ['mail-only.example'],
    },
  });
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 2,
    workerConcurrency: 2,
    mailProvider: 'icloud',
    aliasEnabled: true,
  }, base);

  // The alias switch now works for iCloud: root plus one `+tag` address.
  assert.equal(plan.aliasEnabled, true);
  assert.equal(plan.aliasStrategy, 'root_plus');
  assert.equal(plan.aliasCount, 2);
  assert.deepEqual(plan.security, { setPassword: true, enrollTotp: true });
  // On by default for iCloud; an explicit `false` keeps it root-only.
  const byDefault = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, mailProvider: 'icloud',
  }, base);
  assert.equal(byDefault.aliasEnabled, true);
  assert.equal(byDefault.aliasCount, 2);
  const rootOnly = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, mailProvider: 'icloud', aliasEnabled: false,
  }, base);
  assert.equal(rootOnly.aliasEnabled, false);
  assert.equal(rootOnly.aliasCount, 1);

  const effective = applyRunPlan(base, plan);
  assert.equal(effective.aliases.plusAddressingEnabled, true);
  assert.equal(effective.mail.provider, 'icloud');
  assert.equal(effective.mail.baseUrl, 'http://icloud.example.test:8001');
  assert.equal(effective.mail.icloudBaseUrl, 'http://icloud.example.test:8001');
  assert.equal(effective.mail.mailcomBaseUrl, 'http://mailcom.example.test:8001');
  assert.equal(effective.mail.fastmailBaseUrl, 'http://fastmail.example.test:8001');
  assert.deepEqual(effective.mail.aliasDomains, []);
  assert.equal(effective.mail.aliasDomainMode, 'random');
  assert.doesNotThrow(() => validateV2Config(effective));
  assert.throws(
    () => normalizeRunPlan({
      taskKind: 'register_session',
      mailCount: 1,
      workerConcurrency: 1,
      mailProvider: 'icloud',
      security: { setPassword: false, enrollTotp: false },
    }, base),
    /iCloud API channel requires both security\.setPassword and security\.enrollTotp/,
  );
});
