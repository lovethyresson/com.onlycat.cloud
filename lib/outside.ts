/**
 * How long each cat has been outside today.
 *
 * ## The assumptions, stated
 *
 * A cat flap sees the flap. It does not see the cat. Everything here rests on three assumptions
 * that are sometimes wrong, and the design is shaped by which way they fail:
 *
 * 1. **A cat that has not used the flap has not moved.** Cats leave through windows, get carried
 *    to the vet, and are let out of the front door. When that happens the flap sees nothing, and
 *    this will happily count a cat as outside while it sleeps on the sofa. That is why the manual
 *    override exists and why it is authoritative — see below.
 * 2. **An unknown location is not "inside".** A cat we have never seen contributes nothing at
 *    all. Guessing would silently invent hours.
 * 3. **The day turns over at local midnight in the flap's own time zone**, not Homey's and not
 *    UTC. A flap in Stockholm and a Homey set to UTC would otherwise roll over an hour late.
 *
 * ## Why it is not a stopwatch
 *
 * State is `(since, accumulatedToday)` and the live value is computed on read, rather than a
 * timer adding a minute at a time. That survives an app restart, a Homey reboot and a missed
 * tick without drifting: the only thing persisted is when the cat went out, which is a fact, not
 * a running total that can be lost halfway.
 *
 * The owner's manual "mark this cat as home/out" Flow action is treated exactly like a flap
 * transit, because it is better evidence: somebody looked at the cat.
 */

export interface OutsideState {
  /** Epoch ms when the cat was last known to go outside, or null if it is inside/unknown. */
  since: number | null;
  /** Milliseconds already banked for `day`, excluding any run still in progress. */
  accumulated: number;
  /** The local day `accumulated` belongs to, as `YYYY-MM-DD` in the flap's zone. */
  day: string;
}

export function emptyState(day: string): OutsideState {
  return { since: null, accumulated: 0, day };
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
export function rollOver(state: OutsideState, day: string, now: number, dayStart: number): OutsideState {
  if (state.day === day) return state;
  return {
    day,
    accumulated: 0,
    since: state.since === null ? null : Math.max(state.since, dayStart, 0) || dayStart,
  };
}

/** Milliseconds outside today, including a run still in progress. */
export function millisToday(state: OutsideState, now: number): number {
  const running = state.since === null ? 0 : Math.max(0, now - state.since);
  return state.accumulated + running;
}

/** Hours outside today, to one decimal — what the capability shows. */
export function hoursToday(state: OutsideState, now: number): number {
  return Math.round((millisToday(state, now) / 3600000) * 10) / 10;
}

/**
 * Apply a change of location.
 *
 * `outside` of null means "no longer known", which stops the clock without banking a guess:
 * whatever time had accrued is kept, and nothing new accrues until we know where the cat is.
 */
export function applyLocation(state: OutsideState, outside: boolean | null, now: number): OutsideState {
  const wasOutside = state.since !== null;

  if (outside === true) {
    // Already counting: do not restart the clock, or two transits in a row would lose the gap
    // between them.
    if (wasOutside) return state;
    return { ...state, since: now };
  }

  // Coming in, or becoming unknown: bank whatever the run was worth and stop.
  if (!wasOutside) return state;
  return {
    ...state,
    since: null,
    accumulated: state.accumulated + Math.max(0, now - (state.since as number)),
  };
}
