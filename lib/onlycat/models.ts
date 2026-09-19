/**
 * The OnlyCat contract.
 *
 * Every enum value, string union and pure function below is copied from OnlyCat's own public
 * models — https://github.com/OnlyCatAI/onlycat-shared-models, at commit aecefd5 (2026-09-15) —
 * rather than re-derived from observed traffic. That repo is the source of truth for what the
 * gateway sends; this file is the only place in the app that is allowed to restate it.
 *
 * What is NOT copied: the upstream classes themselves. They all carry `[key: string]: any` and
 * assign every unknown key onto the instance, which is the right call for a service that owns
 * the schema and the wrong one for a client that should be explicit about the handful of fields
 * it reads. So the enums are verbatim and the shapes are our own narrow interfaces.
 *
 * `dev/check-models.mjs` re-fetches upstream and diffs the enums against this file. Run it at
 * release time: the API carries no version of any kind — no URL segment, no handshake param, no
 * header — and has already renamed a message in place once (`getDeviceErrorLogs` became
 * `getDeviceRebootLogs`, with a different row shape and no deprecation).
 */

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/** DeviceEvent.ts */
export enum EventTriggerSource {
    Manual = 0,
    Remote = 1,
    IndoorMotion = 2,
    OutdoorMotion = 3,
}

/**
 * DeviceEvent.ts. Note the gap: 5–9 are unused and `RemoteUnlock` is 10. Never assume these are
 * contiguous, and never iterate a range.
 */
export enum EventClassification {
    Unknown = 0,
    Clear = 1,
    Suspicious = 2,
    Contraband = 3,
    HumanActivity = 4,
    RemoteUnlock = 10,
}

/** FrameMetadata.ts. `Unknown` is -1 here, not 0 — unlike every other enum in this file. */
export enum FlapState {
    Unknown = -1,
    Closed = 0,
    OpenOutward = 1,
    OpenInward = 2,
    Invalid = 3,
}

/** FrameMetadata.ts */
export enum MotionSensorState {
    Unknown = 0,
    None = 1,
    Indoor = 2,
    Outdoor = 3,
}

/** EventSummary.ts */
export type SubEventDirection = 'INWARD' | 'OUTWARD';

/** EventSummary.ts */
export type SubEventAction = 'PEEK' | 'TRANSIT' | 'DENY' | 'BREACH';

/** RfidLastSeen.ts */
export type RfidLastSeenLocation = 'INSIDE' | 'OUTSIDE';

// ---------------------------------------------------------------------------------------------
// Wire shapes — only the fields we actually read
// ---------------------------------------------------------------------------------------------

export interface DeviceConnectivity {
    connected?: boolean;
    /**
     * Epoch MILLISECONDS. Upstream comment: "If the device has been disconnected for
     * approximately an hour, the time value might be missing." So absence means "it has been a
     * while", never "it just happened".
     */
    timestamp?: number;
    disconnectReason?: string;
}

export interface OnlyCatDevice {
    deviceId: string;
    description?: string | null;
    timeZone?: string | null;
    locale?: string | null;
    firmwareChannel?: string | null;
    deviceTransitPolicyId?: number | null;
    connectivity?: DeviceConnectivity;
}

export interface OnlyCatEvent {
    globalId?: number;
    deviceId: string;
    eventId: number;
    timestamp?: string | null;
    /** null means the event is STILL IN PROGRESS. It is the only completion signal there is. */
    frameCount?: number | null;
    eventTriggerSource?: EventTriggerSource | null;
    eventClassification?: EventClassification | null;
    eventManualClassification?: EventClassification | null;
    posterFrameIndex?: number | null;
    accessToken?: string | null;
    rfidCodes?: string[];
    paymentRequired?: boolean;
    deletedAt?: string | null;
}

export interface OnlyCatSubEvent {
    startFrameIndex?: number;
    endFrameIndex?: number;
    rfidCode: string | null;
    direction: SubEventDirection;
    action: SubEventAction;
}

export interface OnlyCatEventSummary {
    deviceId: string;
    eventId: number;
    /** Equal to the event's `frameCount` once the summary is FINAL. Until then it can change. */
    processedFrameCount?: number;
    subevents?: OnlyCatSubEvent[];
    invalidatedAt?: string | null;
}

export interface OnlyCatRfidProfile {
    rfidCode: string;
    /** The owner's name for the cat. Null on rows that only contribute an avatar. */
    label?: string | null;
}

export interface OnlyCatRfidLastSeen {
    deviceId: string;
    rfidCode: string;
    eventId?: number;
    eventTimestamp?: string | null;
    lastSubevent?: OnlyCatSubEvent | null;
    location?: RfidLastSeenLocation | null;
    /** Set when the household has hidden this chip — a neighbour's cat. */
    hiddenAt?: string | null;
}

export interface TransitPolicyRuleCriteria {
    eventTriggerSource?: EventTriggerSource | EventTriggerSource[];
    eventClassification?: EventClassification | EventClassification[];
    rfidCode?: string | string[];
    rfidTimeout?: number;
    timeRange?: string | string[];
    motionSensorState?: MotionSensorState | MotionSensorState[];
    flapState?: FlapState | FlapState[];
}

export interface TransitPolicyRuleAction {
    lock?: boolean;
    sound?: string;
    lockoutDuration?: number;
    final?: boolean;
}

export interface TransitPolicyRule {
    criteria?: TransitPolicyRuleCriteria;
    action?: TransitPolicyRuleAction;
    /** Undocumented in the published schema, present on real objects. Defaults to true. */
    enabled?: boolean;
    description?: string;
}

export interface TransitPolicy {
    rules?: TransitPolicyRule[];
    idleLock?: boolean;
    idleLockBattery?: boolean;
}

export interface OnlyCatDeviceTransitPolicy {
    deviceTransitPolicyId: number;
    deviceId: string;
    name?: string | null;
    activatedAt?: number | null;
    transitPolicy?: TransitPolicy;
}

// ---------------------------------------------------------------------------------------------
// Pure functions, copied rather than re-derived
// ---------------------------------------------------------------------------------------------

/**
 * Where a chip ended up, given its last subevent. Copied from
 * `RfidLastSeen.ts::getRfidLastSeenLocationFromSubevent`.
 *
 * The inversion is deliberate and is the part everyone gets wrong: PEEK and DENY mean the cat
 * looked, or was refused, and therefore STAYED WHERE IT WAS — so an inward peek leaves it
 * outside. BREACH counts as a transit, because the cat did get through. The official Home
 * Assistant integration treats everything that is not TRANSIT as the inverse, which makes an
 * inward BREACH — a cat that forced its way in — mark the cat as outside.
 */
export function locationFromSubevent(subevent: OnlyCatSubEvent | null | undefined): RfidLastSeenLocation | null {
  if (!subevent) return null;

  if (subevent.action === 'TRANSIT' || subevent.action === 'BREACH') {
    return subevent.direction === 'INWARD' ? 'INSIDE' : 'OUTSIDE';
  }

  if (subevent.action === 'PEEK' || subevent.action === 'DENY') {
    return subevent.direction === 'INWARD' ? 'OUTSIDE' : 'INSIDE';
  }

  return null;
}

/** Device.ts::expandMacId — strips the `OC-` prefix and any colons, uppercases. */
export function expandMacId(macIdOrDeviceId: string): string {
  let macId = macIdOrDeviceId.trim().toUpperCase().replace(/^OC-/, '').replace(/:/g, '');
  if (/^[0-9A-F]{4}$/.test(macId)) {
    macId = macId.startsWith('1') ? `8C1F6448${macId}` : `0CBFB490${macId}`;
  }
  return macId;
}

/** Device.ts::macId — formatted xx:xx:xx:xx:xx:xx, for the device's information settings. */
export function macAddress(deviceId: string): string {
  return expandMacId(deviceId).match(/.{1,2}/g)!.join(':');
}

const HUMAN_HASH_PARTS = {
  tone: ['Cool', 'Warm', 'Bright', 'Dark', 'Funny', 'Silly', 'Quick', 'Swift', 'Flash', 'Magic',
    'Red', 'Blue', 'Green', 'Navy', 'Gold', 'Amber', 'Pearl', 'Coral', 'Ruby', 'Opal', 'Jade',
    'Slate', 'Smoke', 'Ash', 'Snow', 'Frost', 'Ember', 'Mist', 'Dawn', 'Dusk', 'Star', 'Sun',
    'Cloud', 'Indigo', 'Violet', 'Peach', 'Sepia', 'Beige', 'Brown', 'Black', 'White', 'Grey',
    'Silver', 'Steel', 'Iron', 'Copper', 'Bronze', 'Brass', 'Teak', 'Oak', 'Pine', 'Wood',
    'Cedar', 'Palm', 'Stone', 'Sand', 'Grass'],
  cat: ['Cat', 'Kitty', 'Kitten', 'Tom', 'Luna', 'Queen', 'Tabby', 'Moggy', 'Feline', 'Tortie',
    'Rex', 'Tiger', 'Lion', 'Puma', 'Purr', 'Meow', 'Paw', 'Claw', 'Tail', 'Fur', 'Fuzz',
    'Bean', 'Whisk', 'Hunt', 'Pounce', 'Sneak', 'Leap', 'Nap', 'Doze', 'Cub', 'Calico',
    'Pixie', 'Mitt', 'Boots', 'Fluff', 'Mouse', 'Bird'],
  door: ['Door', 'Gate', 'Hatch', 'Flap', 'Port', 'Arch', 'Entry', 'Exit', 'Window', 'Way',
    'Path', 'Pass', 'Gap', 'Bridge', 'Aisle', 'Alley', 'Ramp', 'Hall', 'Porch', 'Lobby',
    'Nook', 'Vent', 'Duct', 'Tube', 'Chute', 'Snug', 'Lock', 'Latch', 'Bolt', 'Catch', 'Seal',
    'Ring', 'Loop', 'Stop', 'Slot', 'Slide', 'Link', 'Hinge', 'Bar', 'Sill', 'Pane', 'Frame',
    'Grate', 'Screen', 'Mesh'],
};

/**
 * Device.ts::humanHash — "Warm Tabby Hatch". The same three words the OnlyCat app shows, so a
 * flap with no description is still recognisable rather than "OnlyCat 1".
 *
 * `replace("-", "")` strips only the FIRST hyphen. That is a bug upstream, kept verbatim because
 * fixing it here would produce different names from the phone app for the same flap. The
 * upstream comment says the same: "NB: Hyphen was missed in original implementation - keep for
 * compatibility".
 */
export function humanHash(deviceId: string): string {
  const source = deviceId.replace('-', '');
  let h = 0xdeadbeef;
  for (let i = 0; i < source.length; i++) h = Math.imul(h ^ source.charCodeAt(i), 2654435761);
  const hash = (h ^ (h >>> 16)) >>> 0;

  const { tone, cat, door } = HUMAN_HASH_PARTS;
  return [
    tone[Math.abs(hash) % tone.length],
    cat[Math.abs(Math.floor(hash / tone.length)) % cat.length],
    door[Math.abs(Math.floor(hash / (tone.length * cat.length))) % door.length],
  ].join(' ');
}

/**
 * The manual classification wins when the owner has corrected one in the OnlyCat app.
 * `DeviceEvent.ts::eventEffectiveClassification`. Using the raw classification instead means an
 * owner who told OnlyCat "that wasn't prey" keeps getting prey alerts from us.
 */
export function effectiveClassification(event: OnlyCatEvent): EventClassification | null {
  if (event.eventManualClassification != null) return event.eventManualClassification;
  return event.eventClassification ?? null;
}
