/**
 * How long each cat has been outside today.
 *
 * ## The assumptions, stated
 *
 * A cat flap sees the flap. It does not see the cat. Everything here rests on assumptions that
 * are sometimes wrong, and the design is shaped by which way they fail:
 *
 * 1. **A cat that has not used the flap has not moved.** Cats leave through windows, get carried
 *    to the vet, and are let out of the front door. When that happens the flap sees nothing.
 * 2. **An unknown location is not "inside".** A cat we have never seen contributes nothing at
 *    all. Guessing would silently invent hours.
 * 3. **The day turns over at local midnight in the flap's own time zone**, not Homey's and not
 *    UTC. A flap in Stockholm and a Homey set to UTC would otherwise roll over an hour late.
 *
 * ## Unseen trips
 *
 * Assumption 1 breaks visibly, and in both directions:
 *
 * - A cat **comes in** when we already believed it was inside. It must have gone out at some
 *   point; we simply did not see it. Counting nothing **undercounts**.
 * - A cat **goes out** when we already believed it was outside. It must have come in first. We
 *   have been counting that whole stretch as outside, so counting it all **overcounts**.
 *
 * In both cases the unobserved transition happened somewhere between the last time we had any
 * evidence about that cat and now. That bounds the error: zero at one end, the whole gap at the
 * other. `UnseenTrips` picks where in that range to land, and the owner chooses:
 *
 * - `ignore` — count only what the flap saw. Never invents a minute; undercounts real trips.
 * - `half` — assume the transition happened in the middle of the gap. If it is equally likely to
 *   have happened at any moment, this is the least-wrong single answer available.
 * - `full` — assume the whole gap. The upper bound.
 *
 * The maths is symmetric: the unaccounted state occupies `fraction × gap`, added when that state
 * was "outside" and subtracted when it was "inside".
 *
 * ## Why it is not a stopwatch
 *
 * State is `(since, accumulatedToday, lastSeen)` and the live value is computed on read, rather
 * than a timer adding a minute at a time. That survives an app restart, a Homey reboot and a
 * missed tick without drifting: the only things persisted are moments that actually happened.
 *
 * The owner's manual "mark this cat as home/out" Flow action is treated exactly like a flap
 * transit, because it is better evidence: somebody looked at the cat.
 */

export type UnseenTrips = 'ignore' | 'half' | 'full';

export const UNSEEN_FRACTION: Record<UnseenTrips, number> = {
  ignore: 0,
  half: 0.5,
  full: 1,
};

export function unseenFraction(setting: string | null | undefined): number {
  return UNSEEN_FRACTION[(setting as UnseenTrips)] ?? UNSEEN_FRACTION.half;
}

export interface OutsideState {
  /** Epoch ms when the cat was last known to go outside, or null if it is inside/unknown. */
  since: number | null;
  /** Milliseconds already banked for `day`, excluding any run still in progress. */
  accumulated: number;
  /** The local day `accumulated` belongs to, as `YYYY-MM-DD` in the flap's zone. */
  day: string;
  /** Last moment we had ANY evidence about this cat. The other end of an unseen gap. */
  lastSeen: number | null;
}

export function emptyState(day: string): OutsideState {
  return {
    since: null, accumulated: 0, day, lastSeen: null,
  };
}

/** `YYYY-MM-DD` in the given IANA zone. Falls back to the host's day on an unknown zone. */
export function localDay(timeZone: string | null | undefined, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone ?? undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at);
  }
}

/**
 * Roll the state onto `day` if the local date has changed.
 *
 * A cat that is still outside keeps its `since`, but only the part of the run that falls on the
 * new day counts towards it — otherwise a cat that went out at 23:00 would start the new day
 * already an hour in the red.
 */
export function rollOver(
  state: OutsideState, day: string, now: number, dayStart: number,
): OutsideState {
  if (state.day === day) return state;
  return {
    ...state,
    day,
    accumulated: 0,
    since: state.since === null ? null : Math.max(state.since, dayStart),
  };
}

/** Milliseconds outside today, including a run still in progress. */
export function millisToday(state: OutsideState, now: number): number {
  const running = state.since === null ? 0 : Math.max(0, now - state.since);
  return Math.max(0, state.accumulated + running);
}

/** Hours outside today, to one decimal — what the capability shows. */
export function hoursToday(state: OutsideState, now: number): number {
  return Math.round((millisToday(state, now) / 3600000) * 10) / 10;
}

export interface ObservationOptions {
  /** 0 = count only what the flap saw, 0.5 = split the difference, 1 = the whole gap. */
  fraction?: number;
  /** Local midnight, so an unseen gap can never reach back into yesterday's total. */
  dayStart?: number;
}

/**
 * Apply an observation of where a cat is.
 *
 * `outside` of null means "no longer known", which stops the clock without banking a guess:
 * whatever time had accrued is kept, and nothing new accrues until we know where the cat is.
 */
export function applyLocation(
  state: OutsideState,
  outside: boolean | null,
  now: number,
  options: ObservationOptions = {},
): OutsideState {
  const fraction = options.fraction ?? 0;
  const dayStart = options.dayStart ?? 0;

  // An unseen gap cannot reach back past midnight: only today is being counted, and yesterday's
  // total has already been rolled away.
  const from = state.lastSeen === null ? null : Math.max(state.lastSeen, dayStart);
  const gap = from === null ? 0 : Math.max(0, now - from);
  const unseen = gap * fraction;

  const wasOutside = state.since !== null;
  const seen = { ...state, lastSeen: now };

  if (outside === null) {
    // Location no longer known. Bank the run and stop; do not guess at the gap.
    if (!wasOutside) return seen;
    return {
      ...seen,
      since: null,
      accumulated: seen.accumulated + Math.max(0, now - (state.since as number)),
    };
  }

  if (outside) {
    // Already counting, and the cat is going out again: it must have come in unseen, so part of
    // the gap was spent indoors and has been counted as outside. Take it back.
    if (wasOutside) {
      return {
        ...seen,
        since: now,
        accumulated: Math.max(0, seen.accumulated + (now - (state.since as number)) - unseen),
      };
    }
    return { ...seen, since: now };
  }

  // Coming in normally: bank the run.
  if (wasOutside) {
    return {
      ...seen,
      since: null,
      accumulated: seen.accumulated + Math.max(0, now - (state.since as number)),
    };
  }

  // Coming in when we believed it was already inside: it went out and came back unseen.
  return { ...seen, since: null, accumulated: seen.accumulated + unseen };
}
