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
  const wantedIds = new Set(wanted.map((cat) => capabilityForCat(cat.rfidCode)));
  const currentCatIds = current.filter((id) => id.startsWith(`${CAT_CAPABILITY}.`));

  return {
    add: [...wantedIds].filter((id) => !current.includes(id)),
    remove: currentCatIds.filter((id) => !wantedIds.has(id)),
  };
}
