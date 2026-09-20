import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  capabilityForCat, capabilitySyncPlan, initialLocation, offerableCats, rfidFromCapability,
} from '../lib/cats';
import {
  EventStore, isSummaryFinal, posterFrame, usableSubevents,
} from '../lib/event-store';
import { SUB_EVENT_KINDS, kindOf, locationAfter } from '../lib/events';
import {
  EventClassification, EventTriggerSource, OnlyCatSubEvent,
  effectiveClassification, humanHash, locationFromSubevent, macAddress,
} from '../lib/onlycat/models';
import {
  evaluatePolicy, isEvaluable, minutesOfDayIn, parseTimeRange, timeRangeContains,
} from '../lib/policy';
import { Logger, redactKey } from '../lib/log';
import { explainRefusal } from '../lib/reason';

const sub = (action: any, direction: any, rfidCode: string | null = 'A'): OnlyCatSubEvent => (
  { action, direction, rfidCode }
);

describe('the subevent vocabulary', () => {
  it('agrees with OnlyCat\'s own location function for every entry', () => {
    // The table's `location` column is for readability; locationFromSubevent is what the app
    // acts on. If they ever disagree, the table is lying to whoever reads it.
    for (const kind of SUB_EVENT_KINDS) {
      const expected = kind.location === 'inside' ? 'INSIDE' : 'OUTSIDE';
      assert.equal(
        locationFromSubevent(sub(kind.action, kind.direction)), expected,
        `${kind.key} disagrees with locationFromSubevent`,
      );
    }
  });

  it('covers every action x direction pair OnlyCat defines', () => {
    for (const action of ['TRANSIT', 'PEEK', 'DENY', 'BREACH']) {
      for (const direction of ['INWARD', 'OUTWARD']) {
        assert.ok(kindOf(sub(action, direction)), `no entry for ${action}/${direction}`);
      }
    }
    assert.equal(SUB_EVENT_KINDS.length, 8);
  });

  it('has unique keys', () => {
    const keys = SUB_EVENT_KINDS.map((k) => k.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('treats a breach as a transit and a peek as staying put', () => {
    // The exact pair the reference implementation gets wrong: an inward BREACH is a cat that
    // forced its way IN, so it ends up inside.
    assert.equal(locationAfter(sub('BREACH', 'INWARD')), 'inside');
    assert.equal(locationAfter(sub('BREACH', 'OUTWARD')), 'outside');
    assert.equal(locationAfter(sub('PEEK', 'INWARD')), 'outside');
    assert.equal(locationAfter(sub('DENY', 'INWARD')), 'outside');
    assert.equal(locationAfter(sub('DENY', 'OUTWARD')), 'inside');
  });

  it('returns null for an action OnlyCat adds later', () => {
    assert.equal(kindOf(sub('TELEPORT', 'INWARD')), null);
    assert.equal(locationFromSubevent(sub('TELEPORT', 'INWARD')), null);
  });
});

describe('policy evaluation', () => {
  const policy = (transitPolicy: any) => ({
    deviceTransitPolicyId: 1, deviceId: 'OC-1', name: 'Test', transitPolicy,
  });

  it('defaults idleLock to true, as the server does', () => {
    // The reference implementation defaults this to false, so a policy omitting the field
    // reads as unlocked there and locked on the real flap. Fail-open, on a lock.
    assert.equal(evaluatePolicy(policy({ rules: [] }), {}).locked, true);
    assert.equal(evaluatePolicy(policy({ rules: [], idleLock: false }), {}).locked, false);
  });

  it('takes the first matching rule and reports which it was', () => {
    const outcome = evaluatePolicy(policy({
      idleLock: true,
      rules: [
        { criteria: { eventClassification: EventClassification.Clear }, action: { lock: false } },
        { criteria: {}, action: { lock: true } },
      ],
    }), { eventClassification: EventClassification.Clear });

    assert.equal(outcome.locked, false);
    assert.equal(outcome.ruleIndex, 0);
    assert.equal(outcome.confident, true);
  });

  it('does not drop a zero-valued enum', () => {
    // EventTriggerSource.Manual is 0 and EventClassification.Unknown is 0. A truthiness
    // check silently loses both — which is exactly the reference implementation's bug.
    const outcome = evaluatePolicy(policy({
      rules: [{ criteria: { eventTriggerSource: EventTriggerSource.Manual }, action: { lock: true } }],
    }), { eventTriggerSource: EventTriggerSource.Manual });
    assert.equal(outcome.ruleIndex, 0);

    const unknown = evaluatePolicy(policy({
      rules: [{ criteria: { eventClassification: EventClassification.Unknown }, action: { lock: true } }],
    }), { eventClassification: EventClassification.Unknown });
    assert.equal(unknown.ruleIndex, 0);
  });

  it('short-circuits a remote unlock', () => {
    const outcome = evaluatePolicy(policy({
      idleLock: true, rules: [{ criteria: {}, action: { lock: true } }],
    }), { eventTriggerSource: EventTriggerSource.Remote });
    assert.equal(outcome.locked, false);
    assert.equal(outcome.remoteUnlock, true);
  });

  it('skips disabled rules', () => {
    const outcome = evaluatePolicy(policy({
      idleLock: false,
      rules: [{ enabled: false, criteria: {}, action: { lock: true } }],
    }), {});
    assert.equal(outcome.locked, false);
    assert.equal(outcome.ruleIndex, null);
    assert.equal(outcome.confident, true);
  });

  it('loses confidence when an unevaluable rule sits above the match', () => {
    // This is the honesty constraint. The flap may have stopped at rule 0, which depends on
    // its own sensors — so naming rule 1 as the cause could be flatly wrong.
    const outcome = evaluatePolicy(policy({
      rules: [
        { criteria: { flapState: 0 }, action: { lock: true } },
        { criteria: {}, action: { lock: true } },
      ],
    }), {});
    assert.equal(outcome.ruleIndex, 1);
    assert.equal(outcome.confident, false);
  });

  it('loses confidence when an unevaluable rule precedes the idle fallthrough', () => {
    const outcome = evaluatePolicy(policy({
      idleLock: true,
      rules: [{ criteria: { motionSensorState: 2 }, action: { lock: false } }],
    }), {});
    assert.equal(outcome.ruleIndex, null);
    assert.equal(outcome.confident, false);
  });

  it('knows which criteria it cannot evaluate', () => {
    assert.equal(isEvaluable({ rfidCode: 'A' }), true);
    assert.equal(isEvaluable({ flapState: 0 }), false);
    assert.equal(isEvaluable({ motionSensorState: 1 }), false);
    assert.equal(isEvaluable(undefined), true);
  });

  it('matches rfid codes by overlap', () => {
    const rule = { criteria: { rfidCode: ['A', 'B'] }, action: { lock: true } };
    assert.equal(evaluatePolicy(policy({ rules: [rule] }), { rfidCodes: ['B'] }).ruleIndex, 0);
    assert.equal(evaluatePolicy(policy({ rules: [rule] }), { rfidCodes: ['C'] }).ruleIndex, null);
  });
});

describe('time ranges', () => {
  it('parses and rejects', () => {
    assert.deepEqual(parseTimeRange('08:00-18:00'), { from: 480, to: 1080 });
    assert.equal(parseTimeRange('nonsense'), null);
    assert.equal(parseTimeRange('25:00-26:00'), null);
    assert.equal(parseTimeRange('08:70-09:00'), null);
  });

  it('wraps over midnight', () => {
    assert.equal(timeRangeContains('22:00-07:00', 23 * 60), true);
    assert.equal(timeRangeContains('22:00-07:00', 2 * 60), true);
    assert.equal(timeRangeContains('22:00-07:00', 12 * 60), false);
  });

  it('handles the ordinary case', () => {
    assert.equal(timeRangeContains('08:00-18:00', 12 * 60), true);
    assert.equal(timeRangeContains('08:00-18:00', 7 * 60), false);
    assert.equal(timeRangeContains('08:00-18:00', 18 * 60), false);
  });

  it('resolves minutes in the flap\'s own zone, not Homey\'s', () => {
    const at = new Date('2026-06-15T12:00:00Z');
    assert.equal(minutesOfDayIn('UTC', at), 720);
    assert.equal(minutesOfDayIn('Europe/Stockholm', at), 840);
    assert.equal(minutesOfDayIn(null, at), null);
    assert.equal(minutesOfDayIn('Not/AZone', at), null);
  });
});

describe('the reason', () => {
  const confident = (rule: any) => ({
    locked: true, ruleIndex: 0, rule, confident: true, remoteUnlock: false,
  });

  it('names prey', () => {
    const reason = explainRefusal(
      confident({ criteria: { eventClassification: EventClassification.Contraband } }), 'Misan',
    );
    assert.equal(reason.key, 'reason.prey_named');
    assert.equal(reason.tags.name, 'Misan');
  });

  it('names a curfew and quotes the range', () => {
    const reason = explainRefusal(confident({ criteria: { timeRange: '22:00-07:00' } }), 'Misan');
    assert.equal(reason.key, 'reason.curfew_named');
    assert.equal(reason.tags.range, '22:00-07:00');
  });

  it('falls back to the idle state when nothing matched', () => {
    const reason = explainRefusal(
      {
        locked: true, ruleIndex: null, rule: null, confident: true, remoteUnlock: false,
      }, 'Misan',
    );
    assert.equal(reason.key, 'reason.idle_named');
  });

  it('refuses to name a cause it cannot stand behind', () => {
    // The whole point of the confident flag. A confidently wrong explanation is worse than
    // admitting we cannot tell.
    const reason = explainRefusal({
      locked: true,
      rule: { criteria: { eventClassification: EventClassification.Contraband } },
      ruleIndex: 1,
      confident: false,
      remoteUnlock: false,
    }, 'Misan');
    assert.equal(reason.key, 'reason.unknown_named');
  });

  it('drops the name for an unknown cat', () => {
    assert.equal(explainRefusal(confident({ criteria: { timeRange: '22:00-07:00' } }), null).key, 'reason.curfew');
  });
});

describe('the event pipeline', () => {
  it('treats a null frameCount as still in progress', () => {
    assert.equal(isSummaryFinal({ deviceId: 'd', eventId: 1, frameCount: null },
      { deviceId: 'd', eventId: 1, processedFrameCount: 10 }), false);
  });

  it('is final only once processing catches up with the frame count', () => {
    const event = { deviceId: 'd', eventId: 1, frameCount: 100 };
    assert.equal(isSummaryFinal(event, { deviceId: 'd', eventId: 1, processedFrameCount: 40 }), false);
    assert.equal(isSummaryFinal(event, { deviceId: 'd', eventId: 1, processedFrameCount: 100 }), true);
  });

  it('does not settle on a provisional summary, and settles exactly once', () => {
    const store = new EventStore();
    store.begin('d', 7, 'tok');
    store.applyEvent({ deviceId: 'd', eventId: 7, frameCount: null });
    store.applySummary({
      deviceId: 'd', eventId: 7, processedFrameCount: 20, subevents: [sub('TRANSIT', 'INWARD')],
    });
    assert.equal(store.settle(), null, 'settled while still in progress');

    store.applyEvent({ deviceId: 'd', eventId: 7, frameCount: 50 });
    // A TRANSIT demoted to a PEEK — exactly what the grace period exists to wait out.
    store.applySummary({
      deviceId: 'd', eventId: 7, processedFrameCount: 50, subevents: [sub('PEEK', 'INWARD')],
    });

    const settled = store.settle();
    assert.equal(settled?.length, 1);
    assert.equal(settled?.[0].action, 'PEEK');
    assert.equal(store.settle(), null, 'settled twice — every Flow would fire again');
  });

  it('ignores a stale event id', () => {
    const store = new EventStore();
    store.begin('d', 10, null);
    assert.equal(store.begin('d', 9, null), false);
    assert.equal(store.applyEvent({ deviceId: 'd', eventId: 9, frameCount: 5 }), false);
    assert.equal(store.tracked?.eventId, 10);
  });

  it('merges rather than replaces, so a later push cannot drop the access token', () => {
    const store = new EventStore();
    store.begin('d', 3, 'tok');
    store.applyEvent({ deviceId: 'd', eventId: 3, frameCount: 12 });
    assert.equal(store.tracked?.event.accessToken, 'tok');
  });

  it('settles a concluded event that never produced a usable summary', () => {
    const store = new EventStore();
    store.begin('d', 4, null);
    store.applyEvent({ deviceId: 'd', eventId: 4, frameCount: 30 });
    assert.deepEqual(store.settleStale(), []);
    assert.equal(store.settleStale(), null);
  });

  it('drops half-formed subevents rather than half-reading them', () => {
    const summary = {
      deviceId: 'd',
      eventId: 1,
      subevents: [sub('TRANSIT', 'INWARD'), { rfidCode: 'B' } as any],
    };
    assert.equal(usableSubevents(summary).length, 1);
  });

  it('picks the poster frame, then the midpoint, then the first', () => {
    assert.equal(posterFrame({
      deviceId: 'd', eventId: 1, posterFrameIndex: 5, frameCount: 100,
    }), 5);
    assert.equal(posterFrame({ deviceId: 'd', eventId: 1, frameCount: 100 }), 50);
    assert.equal(posterFrame({ deviceId: 'd', eventId: 1 }), 1);
  });
});

describe('cats as capabilities', () => {
  it('prefixes the chip code so the sub-id never starts with a digit', () => {
    assert.equal(capabilityForCat('956000015949802'), 'cat_home_ONLYCAT.c956000015949802');
    assert.equal(rfidFromCapability('cat_home_ONLYCAT.c956000015949802'), '956000015949802');
    assert.equal(rfidFromCapability('locked'), null);
  });

  it('plans adds and removes without touching other capabilities', () => {
    const plan = capabilitySyncPlan(
      ['locked', 'cat_home_ONLYCAT.cA', 'cat_home_ONLYCAT.cB'],
      [{ rfidCode: 'B', name: 'Misan' }, { rfidCode: 'C', name: 'Pelle' }],
    );
    assert.deepEqual(plan.add, ['cat_home_ONLYCAT.cC']);
    assert.deepEqual(plan.remove, ['cat_home_ONLYCAT.cA']);
  });

  it('excludes cats OnlyCat has hidden', () => {
    // hiddenAt is the platform's own neighbour-cat mechanism. A household that already said
    // "not my cat" should not be asked again.
    const offered = offerableCats([
      { deviceId: 'd', rfidCode: 'A' },
      { deviceId: 'd', rfidCode: 'B', hiddenAt: '2026-01-01T00:00:00Z' },
    ]);
    assert.deepEqual(offered, ['A']);
  });

  it('treats an unknown location as null, not as "out"', () => {
    assert.equal(initialLocation({ deviceId: 'd', rfidCode: 'A', location: 'INSIDE' }), true);
    assert.equal(initialLocation({ deviceId: 'd', rfidCode: 'A', location: 'OUTSIDE' }), false);
    assert.equal(initialLocation({ deviceId: 'd', rfidCode: 'A' }), null);
    assert.equal(initialLocation({ deviceId: 'd', rfidCode: 'A', lastSubevent: null }), null);
  });

  it('derives a location from lastSubevent when the platform did not set one', () => {
    assert.equal(initialLocation({
      deviceId: 'd', rfidCode: 'A', lastSubevent: sub('TRANSIT', 'INWARD'),
    }), true);
  });
});

describe('the vendored contract', () => {
  it('keeps the non-contiguous classification values', () => {
    assert.equal(EventClassification.RemoteUnlock, 10);
    assert.equal(EventClassification.Unknown, 0);
    assert.equal(EventTriggerSource.Manual, 0);
  });

  it('prefers a manual classification over the automatic one', () => {
    // An owner who corrected a misclassification should stop getting prey alerts.
    assert.equal(effectiveClassification({
      deviceId: 'd',
      eventId: 1,
      eventClassification: EventClassification.Contraband,
      eventManualClassification: EventClassification.Clear,
    }), EventClassification.Clear);

    assert.equal(effectiveClassification({
      deviceId: 'd', eventId: 1, eventClassification: EventClassification.Contraband,
    }), EventClassification.Contraband);
  });

  it('formats a device id the way OnlyCat does', () => {
    assert.equal(macAddress('OC-8C1F6448ABCD'), '8C:1F:64:48:AB:CD');
    assert.equal(typeof humanHash('OC-8C1F6448ABCD'), 'string');
    assert.equal(humanHash('OC-8C1F6448ABCD').split(' ').length, 3);
  });
});

describe('the flow card surface', () => {
  const manifest = require('../app.json');
  const driver = manifest.drivers.find((d: any) => d.id === 'cat_flap');

  it('declares every capability the device code sets', () => {
    const expected = ['locked', 'policy_ONLYCAT', 'alarm_motion', 'alarm_prey_ONLYCAT',
      'alarm_human_ONLYCAT', 'alarm_connectivity', 'last_event_ONLYCAT', 'last_blocked_ONLYCAT'];
    for (const capability of expected) {
      assert.ok(driver.capabilities.includes(capability), `missing ${capability}`);
    }
  });

  it('declares the cat capability type even though instances are runtime-only', () => {
    assert.ok(manifest.capabilities.cat_home_ONLYCAT, 'cat_home_ONLYCAT type not declared');
  });

  it('keeps `locked` read-only, which is what makes class lock honest', () => {
    assert.equal(driver.capabilitiesOptions.locked.setable, false);
    assert.equal(driver.capabilitiesOptions.locked.uiQuickAction, false);
    assert.equal(driver.class, 'lock');
  });

  it('gives every arg-bearing card a titleFormatted', () => {
    // Its absence is an App Store validation failure, and is one of the things that would
    // have failed the abandoned community app at review.
    for (const section of ['triggers', 'conditions', 'actions'] as const) {
      for (const card of manifest.flow[section] ?? []) {
        if ((card.args ?? []).some((a: any) => a.type !== 'device')) {
          assert.ok(card.titleFormatted, `${section}/${card.id} has args but no titleFormatted`);
        }
      }
    }
  });

  it('has a trigger for every vocabulary entry', () => {
    const ids = new Set((manifest.flow.triggers ?? []).map((c: any) => c.id));
    for (const kind of SUB_EVENT_KINDS) {
      assert.ok(ids.has(kind.trigger), `no trigger card ${kind.trigger} for ${kind.key}`);
    }
  });

  it('carries an image token on every card that describes an event', () => {
    const withImages = ['cat_came_in', 'cat_went_out', 'cat_denied', 'cat_peeked',
      'cat_breached', 'prey_detected', 'unknown_cat', 'flap_event'];
    for (const id of withImages) {
      const card = manifest.flow.triggers.find((c: any) => c.id === id);
      assert.ok(card, `no card ${id}`);
      assert.ok((card.tokens ?? []).some((t: any) => t.type === 'image'), `${id} has no image token`);
    }
  });

  it('offers an action filter value for every vocabulary entry', () => {
    const card = manifest.flow.triggers.find((c: any) => c.id === 'flap_event');
    const values = new Set(card.args.find((a: any) => a.name === 'action').values.map((v: any) => v.id));
    for (const kind of SUB_EVENT_KINDS) {
      assert.ok(values.has(kind.actionFilter), `no filter value ${kind.actionFilter}`);
    }
  });
});

describe('i18n', () => {
  const locales = ['en', 'sv', 'de', 'nl', 'no', 'da'];

  const flatten = (object: any, prefix = ''): string[] => Object.entries(object)
    .flatMap(([key, value]) => (value && typeof value === 'object'
      ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`]));

  it('has the same keys in all six languages', () => {
    const base = flatten(require('../.homeycompose/locales/en.json')).sort();
    for (const locale of locales) {
      const keys = flatten(require(`../.homeycompose/locales/${locale}.json`)).sort();
      assert.deepEqual(keys, base, `${locale} differs from en`);
    }
  });

  it('has a phrase for every vocabulary entry', () => {
    const en = require('../.homeycompose/locales/en.json');
    for (const kind of SUB_EVENT_KINDS) {
      const [group, direction] = kind.key.split('.');
      assert.ok(en.event?.[group]?.[direction], `no event.${kind.key} phrase`);
    }
  });

  it('has a string for every branch the reason can take', () => {
    for (const locale of locales) {
      const strings = require(`../.homeycompose/locales/${locale}.json`).reason;
      const keys = ['prey', 'prey_named', 'human', 'curfew', 'curfew_named', 'not_allowed',
        'not_allowed_named', 'idle', 'idle_named', 'rule', 'rule_named', 'unknown', 'unknown_named'];
      for (const key of keys) {
        assert.ok(strings?.[key], `${locale} is missing reason.${key}`);
      }
    }
  });
});

describe('logging', () => {
  const sink = (): { lines: string[]; host: { log: (...a: any[]) => void; error: (...a: any[]) => void } } => {
    const lines: string[] = [];
    return {
      lines,
      host: { log: (...a: any[]) => lines.push(a.join(' ')), error: (...a: any[]) => lines.push(`ERR ${a.join(' ')}`) },
    };
  };

  it('never prints a whole key', () => {
    // The one rule this module exists to keep. A support log is something people paste into a
    // public forum thread, and an OnlyCat key grants full account access.
    //
    // This fixture is a made-up key with the real shape. An earlier version of this test used a
    // real one, which put it in the git history of a repo about to go public — exactly the
    // mistake the function under test exists to prevent.
    const key = 'oc_live_EXAMPLE0000_NotARealKeyOnlyUsedForTestingRedaction00';
    const shown = redactKey(key);
    assert.ok(!shown.includes('NotARealKey'), `redactKey leaked the middle: ${shown}`);
    assert.ok(key.indexOf(shown.split('…')[0]) === 0, 'the prefix should still identify the key');
    assert.ok(shown.length < 24, 'too much of the key survives');
  });

  it('handles a missing or tiny key without throwing', () => {
    assert.equal(redactKey(null), '<none>');
    assert.equal(redactKey(''), '<none>');
    assert.equal(redactKey(undefined), '<none>');
    assert.ok(redactKey('short').endsWith('…'));
  });

  it('stays silent at debug until switched on', () => {
    const { lines, host } = sink();
    const logger = new Logger(host, 'test');
    logger.debug('quiet');
    // Not deepEqual against []: that narrows `lines` to never[] for the rest of the test, and
    // every later .includes() stops type-checking.
    assert.equal(lines.length, 0, 'debug logged while disabled');

    logger.setDebug(true);
    logger.debug('loud');
    assert.ok(lines.some((l) => l.includes('loud')), 'debug stayed silent after being enabled');
  });

  it('always logs info and error, switch or no switch', () => {
    // These are what someone pastes into a support thread without being told to enable anything
    // first, so they must not be gated.
    const { lines, host } = sink();
    const logger = new Logger(host, 'test');
    logger.info('important');
    logger.error('broken');
    assert.ok(lines.some((l) => l.includes('important')));
    assert.ok(lines.some((l) => l.includes('ERR') && l.includes('broken')));
  });

  it('announces the switch on both edges', () => {
    // A log that suddenly goes quiet should not look like the app died.
    const { lines, host } = sink();
    const logger = new Logger(host, 'test');
    logger.setDebug(true);
    logger.setDebug(true);
    logger.setDebug(false);
    const announcements = lines.filter((l) => l.includes('debug logging'));
    assert.equal(announcements.length, 2, 'a no-op change should not be announced');
    assert.ok(announcements[0].includes('ENABLED'));
    assert.ok(announcements[1].includes('disabled'));
  });

  it('scopes a child to its parent and inherits the switch', () => {
    const { lines, host } = sink();
    const parent = new Logger(host, 'cat_flap:OC-1');
    parent.setDebug(true);
    parent.child('gateway').debug('hello');
    assert.ok(lines.some((l) => l.includes('[cat_flap:OC-1:gateway]')), lines.join('\n'));
  });

  it('is switchable from the device\'s Advanced settings', () => {
    const manifest = require('../app.json');
    const driver = manifest.drivers.find((d: any) => d.id === 'cat_flap');
    const advanced = (driver.settings ?? []).find((g: any) => g.label?.en === 'Advanced');
    assert.ok(advanced, 'no Advanced settings group');
    const toggle = advanced.children.find((c: any) => c.id === 'debug_logging');
    assert.ok(toggle, 'no debug_logging setting');
    assert.equal(toggle.type, 'checkbox');
    assert.equal(toggle.value, false, 'debug logging must default to off');
    assert.ok(toggle.hint?.en, 'the setting needs a hint saying what it does and how to send the log');
  });
});

describe('pairing', () => {
  const manifest = require('../app.json');
  const driver = manifest.drivers.find((d: any) => d.id === 'cat_flap');

  it('uses Homey\'s own credentials view rather than a hand-rolled one', () => {
    // Two bugs came out of a custom view: one where nothing called the script, and one where
    // declaring `navigation.next` made Homey draw a Next button that skipped verification
    // entirely and reached the device list with no key. The native template cannot be bypassed —
    // Homey wires its Login button straight to the `login` handler.
    const first = driver.pair[0];
    assert.equal(first.template, 'login_credentials');
    assert.equal(first.navigation, undefined,
      'navigation on the credentials view would let the user walk past the login handler');
  });

  it('labels both fields for a product that has no username', () => {
    const { options } = driver.pair[0];
    assert.ok(options.passwordLabel?.en?.includes('API key'), 'the key field is not labelled');
    assert.ok(options.usernameLabel?.en, 'the other field needs a purpose, not a blank prompt');
    assert.ok(options.passwordPlaceholder?.en?.startsWith('oc_live'),
      'the placeholder should show what an OnlyCat key looks like');
  });

  it('chains to the device list and then adds', () => {
    assert.equal(driver.pair[1].template, 'list_devices');
    assert.equal(driver.pair[1].navigation?.next, 'add_devices');
    assert.equal(driver.pair[2].template, 'add_devices');
  });

  it('gives repair the same view and nothing after it', () => {
    assert.equal(driver.repair.length, 1);
    assert.equal(driver.repair[0].template, 'login_credentials');
    assert.equal(driver.repair[0].navigation, undefined);
  });

  it('ships no hand-rolled pairing HTML', () => {
    // If a custom view ever comes back it should be a decision, not a leftover.
    assert.equal(existsSync('drivers/cat_flap/pair'), false, 'a custom pair view has reappeared');
    assert.equal(existsSync('drivers/cat_flap/repair'), false, 'a custom repair view has reappeared');
  });

  it('records which key a flap is using', () => {
    // An account-wide key that gets rotated is otherwise impossible to trace back to a device.
    const flap = driver.settings.find((g: any) => g.label?.en === 'Flap');
    assert.ok(flap.children.some((c: any) => c.id === 'key_name'), 'no key_name label setting');
  });
});

describe('assets', () => {
  const read = (p: string) => readFileSync(p, 'utf8');

  it('gives the app, the device and the driver three different things', () => {
    // The app icon is OnlyCat's brand mark; the device icon is a drawing of the flap; the driver
    // images are photographs. v0.1.0 used the brand mark for all three, which made the device
    // tile read as a sticker among Homey's outlined device icons.
    const appIcon = read('assets/icon.svg');
    const deviceIcon = read('drivers/cat_flap/assets/icon.svg');
    assert.notEqual(appIcon, deviceIcon, 'the app and device icons are the same file');
    assert.ok(appIcon.includes('<polygon'), 'the app icon should be the brand mark');
    assert.ok(deviceIcon.includes('stroke='), 'the device icon should be line art, not a filled mark');
    assert.ok(!deviceIcon.includes('<polygon'), 'the device icon is still the brand mark');
  });

  it('draws the device icon on the canvas Homey specifies', () => {
    const deviceIcon = read('drivers/cat_flap/assets/icon.svg');
    assert.ok(deviceIcon.includes('viewBox="0 0 960 960"'), 'not a 960x960 canvas');
    assert.ok(deviceIcon.includes('fill="none"'),
      'Homey rejects filled illustrations as icons — they read as a solid shape when small');
  });

  it('uses photographs for the driver images', () => {
    // A flat two-colour render compresses to a few KB; a photograph does not. This is a crude
    // check and that is the point — it catches the brand mark being pasted back in.
    for (const name of ['small', 'large', 'xlarge']) {
      const { size } = statSync(`drivers/cat_flap/assets/images/${name}.png`);
      if (name !== 'small') {
        assert.ok(size > 40_000, `${name}.png is ${size}B — too flat to be a photo`);
      }
    }
  });
});

describe('the app manifest', () => {
  const manifest = require('../app.json');

  it('has the properties the App Store needs', () => {
    for (const key of ['id', 'version', 'compatibility', 'sdk', 'platforms', 'name',
      'description', 'category', 'brandColor', 'images', 'author', 'source', 'bugs', 'license']) {
      assert.ok(manifest[key], `manifest is missing ${key}`);
    }
  });

  it('gives users somewhere to ask for help', () => {
    // Athom require a support URL to publish, and it has to be reachable — the abandoned
    // community app pointed its bug tracker at a repository that does not exist.
    assert.ok(manifest.support, 'no support URL');
    assert.match(manifest.support, /^(https:\/\/|mailto:)/, 'support must be https:// or mailto:');
    assert.match(manifest.bugs.url, /^https:\/\/github\.com\/lovethyresson\//, 'bugs URL is not ours');
    assert.match(manifest.homepage, /^https:\/\/github\.com\/lovethyresson\//);
  });

  it('is findable in the App Store', () => {
    assert.ok(manifest.tags, 'no search tags');
    for (const locale of ['en', 'sv', 'de', 'nl', 'no', 'da']) {
      assert.ok(manifest.tags[locale]?.length, `no tags for ${locale}`);
      assert.ok(manifest.tags[locale].includes('OnlyCat'),
        `${locale} tags omit the brand name, which is what people will search for`);
      assert.ok(manifest.description[locale], `no description for ${locale}`);
    }
  });

  it('asks for no permissions, because it needs none', () => {
    // This app talks to one cloud service and nothing else on the Homey. Requesting a permission
    // it does not use is the kind of thing review asks about, and rightly.
    assert.ok(!manifest.permissions?.length, `unexpected permissions: ${manifest.permissions}`);
  });

  it('claims a real category', () => {
    const valid = ['lights', 'video', 'music', 'appliances', 'security', 'climate',
      'tools', 'internet', 'localization', 'energy'];
    for (const category of [manifest.category].flat()) {
      assert.ok(valid.includes(category), `${category} is not a Homey category`);
    }
  });

  it('credits the author and nobody who did not contribute', () => {
    assert.ok(manifest.author?.name);
    // contributors is for people who actually worked on the app. The vendor is not one of them,
    // and listing them would imply an endorsement that does not exist.
    for (const person of manifest.contributors?.developers ?? []) {
      assert.ok(!/onlycat/i.test(person.name), 'do not list the vendor as a contributor');
    }
  });
});
