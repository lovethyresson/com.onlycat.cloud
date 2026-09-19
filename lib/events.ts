/**
 * The subevent vocabulary — this app's core data.
 *
 * `com.nibe.local` drives everything from one `Register[]`. This app drives everything from the
 * array below: Flow card ids, the `last_event_ONLYCAT` wording, the presence effect and the i18n
 * keys all resolve through it. Adding a case is one entry here, not five edits spread around.
 *
 * The vocabulary is not invented. `PushNotificationConfig.ts` in OnlyCat's own models defines
 * exactly these nine keys — `transit.inward`, `peek.outward`, `contraband` and the rest — which
 * is the platform's own answer to "what does a household care about". Reusing their taxonomy
 * means a Flow card and a phone notification describe the same event the same way.
 */

import {
  OnlyCatSubEvent, SubEventAction, SubEventDirection, locationFromSubevent,
} from './onlycat/models';

export type CatLocation = 'inside' | 'outside';

export interface SubEventKind {
    /** OnlyCat's own rule key, e.g. `transit.inward`. Also the i18n key suffix. */
    key: string;
    action: SubEventAction;
    direction: SubEventDirection;
    /** Where this leaves the cat. Always agrees with `locationFromSubevent` — asserted by a test. */
    location: CatLocation;
    /** The Flow trigger this fires, beyond the generic `flap_event`. */
    trigger: 'cat_came_in' | 'cat_went_out' | 'cat_denied' | 'cat_peeked' | 'cat_breached';
    /** Value of the `action` dropdown on the generic card that selects this kind. */
    actionFilter: 'transit_in' | 'transit_out' | 'peek' | 'deny' | 'breach';
}

export const SUB_EVENT_KINDS: SubEventKind[] = [
  {
    key: 'transit.inward',
    action: 'TRANSIT',
    direction: 'INWARD',
    location: 'inside',
    trigger: 'cat_came_in',
    actionFilter: 'transit_in',
  },
  {
    key: 'transit.outward',
    action: 'TRANSIT',
    direction: 'OUTWARD',
    location: 'outside',
    trigger: 'cat_went_out',
    actionFilter: 'transit_out',
  },
  {
    // A cat that forced a locked flap. Kept even though it is rare: it is the single event an
    // owner would most want to know about, and the API sends it whether we model it or not.
    key: 'breach.inward',
    action: 'BREACH',
    direction: 'INWARD',
    location: 'inside',
    trigger: 'cat_breached',
    actionFilter: 'breach',
  },
  {
    key: 'breach.outward',
    action: 'BREACH',
    direction: 'OUTWARD',
    location: 'outside',
    trigger: 'cat_breached',
    actionFilter: 'breach',
  },
  {
    // Inward peek leaves the cat OUTSIDE — it looked and thought better of it. This inversion
    // is the thing the reference implementation gets wrong; see locationFromSubevent().
    key: 'peek.inward',
    action: 'PEEK',
    direction: 'INWARD',
    location: 'outside',
    trigger: 'cat_peeked',
    actionFilter: 'peek',
  },
  {
    key: 'peek.outward',
    action: 'PEEK',
    direction: 'OUTWARD',
    location: 'inside',
    trigger: 'cat_peeked',
    actionFilter: 'peek',
  },
  {
    key: 'deny.inward',
    action: 'DENY',
    direction: 'INWARD',
    location: 'outside',
    trigger: 'cat_denied',
    actionFilter: 'deny',
  },
  {
    key: 'deny.outward',
    action: 'DENY',
    direction: 'OUTWARD',
    location: 'inside',
    trigger: 'cat_denied',
    actionFilter: 'deny',
  },
];

const BY_ACTION_DIRECTION = new Map<string, SubEventKind>(
  SUB_EVENT_KINDS.map((kind) => [`${kind.action}|${kind.direction}`, kind]),
);

/** null for an action/direction pair OnlyCat has added since this table was written. */
export function kindOf(subevent: OnlyCatSubEvent | null | undefined): SubEventKind | null {
  if (!subevent?.action || !subevent?.direction) return null;
  return BY_ACTION_DIRECTION.get(`${subevent.action}|${subevent.direction}`) ?? null;
}

/**
 * The location this subevent implies, straight from OnlyCat's own function rather than from the
 * table. The table's `location` column exists for readability; this is what the app acts on, and
 * a unit test asserts the two never disagree.
 */
export function locationAfter(subevent: OnlyCatSubEvent): CatLocation | null {
  const location = locationFromSubevent(subevent);
  if (location === 'INSIDE') return 'inside';
  if (location === 'OUTSIDE') return 'outside';
  return null;
}

/** The `action` dropdown on the generic "Something happened at the flap" card. */
export const ACTION_FILTERS = ['any', 'transit_in', 'transit_out', 'peek', 'deny', 'breach'] as const;
export type ActionFilter = (typeof ACTION_FILTERS)[number];
