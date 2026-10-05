/**
 * Cats, and the capability instances that represent them.
 *
 * A cat is not a device — it is state the flap reports. So each tracked cat gets one boolean
 * capability instance on the flap: `cat_home_ONLYCAT.c956000015949802`, titled with the cat's
 * name. This is the Nibe capability-instance pattern, with one difference that drives the whole
 * design: the instances are not known until runtime.
 */

import { OnlyCatRfidLastSeen, locationFromSubevent } from './onlycat/models';

export const CAT_CAPABILITY = 'cat_home_ONLYCAT';

export interface TrackedCat {
    rfidCode: string;
    /** The owner's name for the cat from their OnlyCat profile, or the chip code. */
    name: string;
}

/**
 * The capability id for a chip.
 *
 * Prefixed `c` rather than using the bare chip number. Chip codes are 15 digits, and a leading
 * digit is exactly what broke the reference implementation's entity ids (its issues #127 and
 * #190: `77200009910828_tracker` cannot be dot-accessed in a template, and the platform now
 * warns the id stops working in 2027.2). Homey may well tolerate a leading digit; the prefix
 * costs one character and removes the question entirely.
 */
export function capabilityForCat(rfidCode: string): string {
  return `${CAT_CAPABILITY}.c${rfidCode.replace(/[^A-Za-z0-9]/g, '')}`;
}

export const OUTSIDE_CAPABILITY = 'time_outside_ONLYCAT';

/** Same `c` prefix as the presence capability, for the same leading-digit reason. */
export function outsideCapabilityForCat(rfidCode: string): string {
  return `${OUTSIDE_CAPABILITY}.c${rfidCode.replace(/[^A-Za-z0-9]/g, '')}`;
}

export function rfidFromCapability(capabilityId: string): string | null {
  const match = new RegExp(`^${CAT_CAPABILITY}\\.c(.+)$`).exec(capabilityId);
  return match ? match[1] : null;
}

/** The chips worth offering during pairing: everything OnlyCat has not hidden. */
export function offerableCats(lastSeen: OnlyCatRfidLastSeen[]): string[] {
  return lastSeen
  // `hiddenAt` is precisely the platform's neighbour-cat mechanism. A household that has
  // already told OnlyCat "not my cat" should not be asked again here.
    .filter((entry) => !entry.hiddenAt)
    .map((entry) => entry.rfidCode)
    .filter((code, index, all) => code && all.indexOf(code) === index);
}

/**
 * The tracked cats with their names refreshed from their OnlyCat profiles.
 *
 * Names only. Which cats are followed is the owner's choice, made in pairing or Repair, and
 * nothing in the background changes it: a cat added in the OnlyCat app waits, unticked, in the
 * Repair list, and a cat hidden there keeps its sensors until the owner removes it — the removal
 * is what carries the warning. A cat with no label keeps the name it had.
 */
export function renameCats(current: TrackedCat[], labels: Record<string, string | undefined>): TrackedCat[] {
  return current.map((cat) => ({ rfidCode: cat.rfidCode, name: labels[cat.rfidCode] || cat.name }));
}

export interface CatChoice extends TrackedCat {
    included: boolean;
}

/**
 * Every cat the Repair list offers: the ones tracked, the ones switched off, and any OnlyCat
 * knows about that are neither yet. Hidden chips are left out — the owner already told OnlyCat
 * they are not theirs. Tracked first, then switched off, then new, each in the order known.
 */
export function catChoices(
  tracked: TrackedCat[],
  excluded: TrackedCat[],
  lastSeen: OnlyCatRfidLastSeen[],
): CatChoice[] {
  const hidden = new Set(lastSeen.filter((entry) => entry.hiddenAt).map((entry) => entry.rfidCode));
  const known = [...tracked, ...excluded].map((cat) => cat.rfidCode);
  return [
    ...tracked.map((cat) => ({ ...cat, included: true })),
    ...excluded.filter((cat) => !hidden.has(cat.rfidCode)).map((cat) => ({ ...cat, included: false })),
    ...offerableCats(lastSeen)
      .filter((code) => !known.includes(code))
      .map((rfidCode) => ({ rfidCode, name: rfidCode, included: false })),
  ];
}

/** Initial location for a chip, from whatever OnlyCat last recorded. */
export function initialLocation(entry: OnlyCatRfidLastSeen): boolean | null {
  const explicit = entry.location ?? locationFromSubevent(entry.lastSubevent);
  if (explicit === 'INSIDE') return true;
  if (explicit === 'OUTSIDE') return false;
  // null is a real state, not a failure: a fresh install knows nothing until the cat moves,
  // and a boolean capability renders that as a gap rather than a wrong answer.
  return null;
}

export interface CapabilityPlan {
    add: string[];
    remove: string[];
}

/**
 * What to add and remove to make `current` match `wanted`.
 *
 * Split out of the device the way Nibe splits `capabilitySyncPlan()` out of `syncCapabilities()`:
 * so it can be tested without a Homey.
 */
export function capabilitySyncPlan(current: string[], wanted: TrackedCat[]): CapabilityPlan {
  // Each cat brings two instances: where it is, and how long it has been there today.
  const wantedIds = new Set(wanted.flatMap((cat) => [
    capabilityForCat(cat.rfidCode),
    outsideCapabilityForCat(cat.rfidCode),
  ]));
  const currentCatIds = current.filter((id) => id.startsWith(`${CAT_CAPABILITY}.`)
    || id.startsWith(`${OUTSIDE_CAPABILITY}.`));

  return {
    add: [...wantedIds].filter((id) => !current.includes(id)),
    remove: currentCatIds.filter((id) => !wantedIds.has(id)),
  };
}
