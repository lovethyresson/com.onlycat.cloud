/**
 * The flap's own rule engine, re-implemented.
 *
 * NOT for reporting lock state. An earlier version drove a `locked` capability from this, which
 * was an unhedged live claim built on a simulation with known blind spots — and OnlyCat's own app
 * does not make that claim, because the API cannot tell it one. The capability is gone.
 *
 * What is left is legitimate because it is anchored to something that definitely happened: when a
 * DENY subevent arrives, the flap really did refuse, and this works out which of the owner's own
 * rules most likely did it — reporting `confident: false` when it cannot be sure. Explaining a
 * fact, rather than asserting a state.
 *
 * OnlyCat does not report lock state. `LockState` exists in their models but only inside
 * `FrameMetadata`, the per-frame device state, and no socket event delivers it. The flap
 * evaluates its transit policy locally on every frame, so a client that wants to show a lock
 * state — or explain a refusal — has to run the same rules itself.
 *
 * The policy format is the one part of this API that IS properly documented:
 * https://www.onlycat.com/door-policy-schema/ (draft-07 JSON Schema plus prose semantics).
 *
 * This module returns WHICH RULE matched, not just the verdict. That extra return value is the
 * entire reason feature (see reason.ts), and it is why lock state and "why was she turned away"
 * are one module rather than two.
 */

import {
  EventClassification,
  EventTriggerSource,
  OnlyCatDeviceTransitPolicy,
  TransitPolicyRule,
  TransitPolicyRuleCriteria,
} from './onlycat/models';

export interface PolicyInput {
    eventTriggerSource?: EventTriggerSource | null;
    eventClassification?: EventClassification | null;
    rfidCodes?: string[];
    /** Minutes since local midnight in the FLAP's time zone, not Homey's. */
    minutesOfDay?: number | null;
}

export interface PolicyOutcome {
    locked: boolean;
    /** Index into the policy's `rules`, or null when nothing matched and idleLock decided. */
    ruleIndex: number | null;
    rule: TransitPolicyRule | null;
    /**
     * False when a rule we could not evaluate sits ABOVE the one we matched (or above the
     * fallthrough). The real flap may have matched that one instead, so any explanation we give
     * could name the wrong cause. Callers must not present an explanation when this is false.
     */
    confident: boolean;
    /** True when the short-circuit for a remote unlock decided it. */
    remoteUnlock: boolean;
}

function asArray<T>(value: T | T[] | undefined): T[] | null {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value : [value];
}

/**
 * Parse "HH:MM-HH:MM" into minutes since midnight. Returns null on anything unparseable rather
 * than throwing — a malformed range in someone's policy must not take the whole device down.
 */
export function parseTimeRange(range: string): { from: number; to: number } | null {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(range.trim());
  if (!match) return null;

  const from = Number(match[1]) * 60 + Number(match[2]);
  const to = Number(match[3]) * 60 + Number(match[4]);
  if (from > 1439 || to > 1439 || Number(match[2]) > 59 || Number(match[4]) > 59) return null;

  return { from, to };
}

/** Handles overnight ranges: 22:00-07:00 contains 23:30 and 02:00, but not 12:00. */
export function timeRangeContains(range: string, minutesOfDay: number): boolean | null {
  const parsed = parseTimeRange(range);
  if (!parsed) return null;

  const { from, to } = parsed;
  if (from === to) return true;
  if (from < to) return minutesOfDay >= from && minutesOfDay < to;
  return minutesOfDay >= from || minutesOfDay < to;
}

/**
 * Criteria that depend on live frame data we do not receive. A rule carrying one of these cannot
 * be evaluated client-side at all — it is skipped, and its presence above a match is what makes
 * an outcome un-confident.
 */
export function isEvaluable(criteria: TransitPolicyRuleCriteria | undefined): boolean {
  if (!criteria) return true;
  return criteria.flapState === undefined && criteria.motionSensorState === undefined;
}

function criteriaMatch(criteria: TransitPolicyRuleCriteria | undefined, input: PolicyInput): boolean {
  if (!criteria) return true;

  const triggerSources = asArray(criteria.eventTriggerSource);
  if (triggerSources) {
    // `!= null`, never truthiness: EventTriggerSource.Manual is 0 and would be dropped.
    if (input.eventTriggerSource == null) return false;
    if (!triggerSources.includes(input.eventTriggerSource)) return false;
  }

  const classifications = asArray(criteria.eventClassification);
  if (classifications) {
    // Same trap: EventClassification.Unknown is 0.
    if (input.eventClassification == null) return false;
    if (!classifications.includes(input.eventClassification)) return false;
  }

  const rfidCodes = asArray(criteria.rfidCode);
  if (rfidCodes) {
    const seen = input.rfidCodes ?? [];
    if (!rfidCodes.some((code) => seen.includes(code))) return false;
  }

  const timeRanges = asArray(criteria.timeRange);
  if (timeRanges) {
    if (input.minutesOfDay == null) return false;
    const hit = timeRanges.some((range) => timeRangeContains(range, input.minutesOfDay!) === true);
    if (!hit) return false;
  }

  return true;
}

/**
 * Evaluate a policy against one event.
 *
 * Order matters and is OnlyCat's: "For as long as a rule is matching, the rules below it will not
 * be evaluated — so the actions that are invoked are the ones associated with the first matched
 * rule."
 */
export function evaluatePolicy(
  policy: OnlyCatDeviceTransitPolicy | null | undefined,
  input: PolicyInput,
): PolicyOutcome {
  const transit = policy?.transitPolicy;

  // The server default is TRUE. The reference implementation reads `idleLock` defaulting to
  // false, which means a policy omitting the field reads as unlocked there and locked on the
  // real flap — a fail-open divergence on a lock. Take the server's default.
  const idleLock = transit?.idleLock ?? true;

  if (!transit) {
    return {
      locked: idleLock, ruleIndex: null, rule: null, confident: false, remoteUnlock: false,
    };
  }

  // The owner pressed unlock in the app. Nothing in the policy overrides that.
  if (input.eventTriggerSource === EventTriggerSource.Remote) {
    return {
      locked: false, ruleIndex: null, rule: null, confident: true, remoteUnlock: true,
    };
  }

  const rules = transit.rules ?? [];
  let skippedAbove = false;

  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index];

    if (rule.enabled === false) continue;

    if (!isEvaluable(rule.criteria)) {
      // We cannot tell whether this one fired. If a later rule matches, the flap may in
      // fact have stopped here instead — so the answer stops being trustworthy.
      skippedAbove = true;
      continue;
    }

    if (!criteriaMatch(rule.criteria, input)) continue;

    return {
      locked: rule.action?.lock === true,
      ruleIndex: index,
      rule,
      confident: !skippedAbove,
      remoteUnlock: false,
    };
  }

  return {
    locked: idleLock,
    ruleIndex: null,
    rule: null,
    confident: !skippedAbove,
    remoteUnlock: false,
  };
}

/**
 * Minutes since local midnight in an IANA zone. Uses Intl rather than arithmetic on offsets so
 * DST is the platform's problem, not ours. Falls back to null on an unknown zone, which makes
 * every `timeRange` criterion fail to match rather than match wrongly.
 */
export function minutesOfDayIn(timeZone: string | null | undefined, at: Date = new Date()): number | null {
  if (!timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return (hour % 24) * 60 + minute;
  } catch {
    return null;
  }
}
