import Homey from 'homey';
import {
  CAT_CAPABILITY, TrackedCat, capabilityForCat, capabilitySyncPlan, initialLocation,
  outsideCapabilityForCat, rfidFromCapability,
} from '../../lib/cats';
import {
  EventStore, clipUrl, imageUrl, isEventConcluded, usableSubevents,
} from '../../lib/event-store';
import { SubEventKind, kindOf, locationAfter } from '../../lib/events';
import { Gateway, GATEWAY_URL, OnlyCatAuthError } from '../../lib/gateway';
import { Logger } from '../../lib/log';
import {
  EventClassification, EventTriggerSource, OnlyCatDeviceTransitPolicy, OnlyCatEvent,
  OnlyCatEventSummary, OnlyCatSubEvent, effectiveClassification, macAddress,
} from '../../lib/onlycat/models';
import {
  OutsideState, applyLocation, emptyState, hoursToday, localDay, rollOver, unseenFraction,
} from '../../lib/outside';
import { PolicyOutcome, evaluatePolicy, minutesOfDayIn } from '../../lib/policy';
import { explainRefusal } from '../../lib/reason';

/** One-line rendering of a summary's subevents, for the debug log. */
function describeSubevents(subevents: OnlyCatSubEvent[] | undefined): string {
  if (!subevents?.length) return 'no subevents';
  return subevents
    .map((sub) => `${sub.rfidCode ?? 'unknown'} ${sub.action}/${sub.direction}`)
    .join('; ');
}

/** How long to wait for a final summary before settling on what we have. */
const SUMMARY_GRACE_MS = 45000;
/** How far back to look for a refusal when "Last refusal" has never been filled in. */
const REFUSAL_SCAN = 12;

/**
 * Counters that only ever go up.
 *
 * Monotonic on purpose. A counter that resets nightly looks tidier on the tile but ruins the
 * Insights chart — you get a sawtooth instead of a trend, and `com.nibe.local`'s notes are blunt
 * about what a resetting counter does to Homey's engine. Homey derives the per-day rate from a
 * rising line perfectly well, so the chart answers "is Zorro slowing down?" while the tile still
 * answers "how many times, ever?".
 */
const COUNTERS = [
  'trips_in_ONLYCAT',
  'trips_out_ONLYCAT',
  'refusals_ONLYCAT',
  'prey_attempts_ONLYCAT',
];

/** How long a remote unlock outranks the door policy's idle state on the tile. */
const MANUAL_UNLOCK_MS = 120000;

/** How often to re-evaluate the idle lock state, so a curfew boundary is noticed. */
const LOCK_TICK_MS = 60000;

/** One id shared by the still and the clip, so the still becomes the clip's poster frame. */
const CAMERA_ID = 'event';
/** A HEAD request to find out whether the clip has finished processing. */
const CLIP_PROBE_MS = 4000;

/** Clear the activity alarm if the flap never tells us the event concluded. */
const MOTION_TIMEOUT_MS = 120000;

const TRIGGER_SOURCE_NAMES: Record<number, string> = {
  [EventTriggerSource.Manual]: 'manual',
  [EventTriggerSource.Remote]: 'remote',
  [EventTriggerSource.IndoorMotion]: 'indoor motion',
  [EventTriggerSource.OutdoorMotion]: 'outdoor motion',
};

const CLASSIFICATION_NAMES: Record<number, string> = {
  [EventClassification.Unknown]: 'unknown',
  [EventClassification.Clear]: 'clear',
  [EventClassification.Suspicious]: 'suspicious',
  [EventClassification.Contraband]: 'contraband',
  [EventClassification.HumanActivity]: 'human activity',
  [EventClassification.RemoteUnlock]: 'remote unlock',
};

module.exports = class CatFlapDevice extends Homey.Device {

    private gateway!: Gateway;
    private store = new EventStore();
    private policies: OnlyCatDeviceTransitPolicy[] = [];
    private activePolicyId: number | null = null;
    private timeZone: string | null = null;
    private cats: TrackedCat[] = [];
    private lastImage: Homey.Image | null = null;
    private currentImageUrl: string | null = null;
    private summaryTimer: ReturnType<typeof setTimeout> | null = null;
    private motionTimer: ReturnType<typeof setTimeout> | null = null;

    /** Scoped per flap, so a two-flap household's logs can be told apart. */
    private logger!: Logger;

    /** Null until the first decision, so the first transition is always logged. */
    private available: boolean | null = null;

    private refreshing = false;

    private lockTimer: ReturnType<typeof setInterval> | null = null;

    private clipVideo: any = null;

    private cameraTitle = '';

    /** While set, the derived lock state defers to a remote unlock the owner just asked for. */
    private manualUnlockUntil = 0;

    /** Per chip code. Persisted, so a restart does not lose how long a cat has been out. */
    private outside: Record<string, OutsideState> = {};

    get deviceId(): string {
      return this.getData().id as string;
    }

    /**
     * `this.homey.__()` is typed `string | undefined` — a key with no translation returns
     * nothing. Falling back to the key itself makes a missing string visible and greppable
     * instead of rendering as an empty label nobody can trace.
     */
    private t(key: string, tags?: Record<string, string>): string {
      return this.homey.__(key, tags) ?? key;
    }

    // ------------------------------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------------------------------

    async onInit(): Promise<void> {
      this.logger = new Logger(
        { log: (...a: any[]) => this.log(...a), error: (...a: any[]) => this.error(...a) },
        `cat_flap:${this.deviceId}`,
      );
      this.logger.setDebug(this.getSetting('debug_logging') === true);

      this.outside = (this.getStoreValue('outside') as Record<string, OutsideState>) ?? {};

      await this.seedAlarms();

      this.cats = (this.getStoreValue('cats') as TrackedCat[]) ?? [];
      this.logger.info(`init: ${this.cats.length} tracked cat(s)${
        this.cats.length ? ` — ${this.cats.map((c) => c.name).join(', ')}` : ''}`);

      await this.syncCapabilities();
      this.registerListeners();

      const image = await this.homey.images.createImage();
      image.setStream(async (stream: any) => {
        if (!this.currentImageUrl) throw new Error('No event image yet');
        const response = await fetch(this.currentImageUrl);
        if (!response.ok) throw new Error(`Image request failed: ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        stream.end(buffer);
      });
      this.lastImage = image;

      // Same id for the image and the video on purpose: Homey uses a matching image as the
      // poster frame behind a video while it loads, which is exactly the right still to show.
      await this.setCameraImage(CAMERA_ID, this.t('camera.last_event'), image)
        .catch((error) => this.logger.error('setCameraImage failed:', error?.message ?? error));

      await this.registerClips();

      // Time-range rules change on the clock, not on an event: a curfew starting at 22:00 must
      // show up without waiting for the next cat. A minute's granularity is plenty and costs
      // nothing; computing exact boundaries across wrapping ranges would not buy anything.
      this.lockTimer = this.homey.setInterval(() => {
        void this.updateLockState().catch((e) => this.logger.error('lock tick:', e?.message ?? e));
        void this.updateOutside().catch((e) => this.logger.error('outside tick:', e?.message ?? e));
      }, LOCK_TICK_MS);

      await this.connect();
    }

    /**
     * Homey calls this when the owner saves the device's settings. Wiring the checkbox here is
     * what makes it a real switch rather than a stored preference nothing reads: it takes effect
     * on the next log line, not at the next app restart.
     */
    async onSettings({ newSettings, changedKeys }: {
      newSettings: Record<string, any>; changedKeys: string[];
    }): Promise<void> {
      if (changedKeys.includes('debug_logging')) {
        this.logger.setDebug(newSettings.debug_logging === true);
      }
      if (changedKeys.includes('unseen_trips')) {
        // Only changes what future unseen trips assume; today's total already banked stands.
        this.logger.info(`unseen trips now assume: ${newSettings.unseen_trips}`);
      }
    }

    /**
     * The event clip, as an HLS stream.
     *
     * OnlyCat serves a per-event HLS playlist, not a live feed — so this is "the clip of the last
     * thing that happened", not a camera you can watch. The title says so.
     *
     * Wrapped in try/catch the way Athom's own example is: videos need Homey 12.7.0 and are not
     * on every model. An older hub simply gets everything except clips, which is better than
     * raising `compatibility` and excluding it from the app entirely.
     */
    private async registerClips(): Promise<void> {
      try {
        const video = await this.homey.videos.createVideoHLS();

        video.registerVideoUrlListener(async () => ({ url: await this.currentClipUrl() }));

        await this.setCameraVideo(CAMERA_ID, this.t('camera.last_event'), video);
        this.logger.debug('clips registered');
      } catch (error: any) {
        // Not an error worth alarming anyone about — it is what an older Homey looks like.
        this.logger.info(`clips unavailable on this Homey: ${error?.message ?? error}`);
      }
    }

    /** Throws rather than returning a URL that would play nothing. */
    private async currentClipUrl(): Promise<string> {
      const { tracked } = this.store;
      const url = tracked ? clipUrl(GATEWAY_URL, tracked.event) : null;
      if (!url) throw new Error(this.t('error.no_clip'));

      // The playlist is not written the instant an event ends; the reference implementation
      // treats 404 and 5xx as "not ready yet" for the same reason. Better to say so than to hand
      // the player a URL that 404s.
      const probe = await fetch(url, {
        method: 'HEAD', signal: AbortSignal.timeout(CLIP_PROBE_MS),
      }).catch(() => null);

      if (!probe || probe.status === 404 || probe.status >= 500) {
        this.logger.debug(`clip for event ${tracked?.eventId} not ready (${probe?.status ?? 'no response'})`);
        throw new Error(this.t('error.clip_not_ready'));
      }

      this.logger.debug(`clip for event ${tracked?.eventId} ready`);
      return url;
    }

    async onUninit(): Promise<void> {
      this.teardown();
    }

    onDeleted(): void {
      this.teardown();
    }

    private teardown(): void {
      if (this.lockTimer) this.homey.clearInterval(this.lockTimer);
      this.lockTimer = null;
      if (this.summaryTimer) this.homey.clearTimeout(this.summaryTimer);
      if (this.motionTimer) this.homey.clearTimeout(this.motionTimer);
      this.summaryTimer = null;
      this.motionTimer = null;
      if (this.gateway) {
        this.gateway.untrackDevice(this.deviceId);
        this.gateway.off('ready', this.onReady);
        this.gateway.off('down', this.onDown);
        this.gateway.off('unauthorized', this.onUnauthorized);
        this.gateway.off('deviceUpdate', this.onDeviceUpdate);
        this.gateway.off('deviceEventUpdate', this.onDeviceEventUpdate);
        this.gateway.off('eventUpdate', this.onEventUpdate);
        this.gateway.off('eventSummaryUpdate', this.onEventSummaryUpdate);
        this.gateway.detach(this.homey.app as any);
      }
    }

    private async connect(): Promise<void> {
      const apiKey = this.getStoreValue('apiKey') as string | undefined;
      if (!apiKey) {
        this.logger.error('no API key in the device store — re-pair, or use Repair');
        await this.markUnavailable(this.t('error.unauthorized'));
        return;
      }

      this.gateway = Gateway.attach(
            this.homey.app as any,
            apiKey,
            (...args) => this.log(...args),
            (...args) => this.error(...args),
            GATEWAY_URL,
      );

      this.gateway.trackDevice(this.deviceId);
      this.gateway.on('ready', this.onReady);
      this.gateway.on('down', this.onDown);
      this.gateway.on('unauthorized', this.onUnauthorized);
      this.gateway.on('deviceUpdate', this.onDeviceUpdate);
      this.gateway.on('deviceEventUpdate', this.onDeviceEventUpdate);
      this.gateway.on('eventUpdate', this.onEventUpdate);
      this.gateway.on('eventSummaryUpdate', this.onEventSummaryUpdate);
      this.gateway.connect();

      // The gateway is shared per API key. A second flap attaching to one that is already up
      // would never see `ready` — that fires on connect, which already happened — and would sit
      // in "No response" forever with a perfectly healthy socket underneath it.
      if (this.gateway.connected) {
        this.logger.debug('gateway was already up; refreshing without waiting for ready');
        void this.refresh().catch((e) => this.logger.error('refresh failed:', e?.message ?? e));
      }
    }

    // Bound fields rather than methods: they are handed to the shared gateway and have to be
    // removable by identity in teardown(), or a re-paired device leaks a listener per init.
    private onReady = (): void => {
      this.logger.info('connected; refreshing');
      void this.refresh().catch((error) => this.logger.error('refresh failed:', error?.message ?? error));
    };

    private onDown = (reason: string): void => {
      void this.markUnavailable(`${this.t('error.no_connection')} (${reason})`);
      void this.setCapabilityValue('alarm_connectivity', true).catch(() => {});
    };

    private onUnauthorized = (): void => {
      this.logger.error('the API key was rejected — open Repair and paste a new one');
      void this.markUnavailable(this.t('error.unauthorized'));
    };

    private onDeviceUpdate = (deviceId: string): void => {
      if (deviceId !== this.deviceId) return;
      this.logger.debug('deviceUpdate -> re-reading the device');
      // Push payloads are invalidation signals, not data — both other clients re-fetch rather
      // than trusting the body, and the body is a Partial<Device> anyway.
      void this.refreshDevice().catch((error) => this.logger.error('device refresh failed:', error?.message ?? error));
    };

    // ------------------------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------------------------

    /** Marks the device available and says so once, not on every repeat call. */
    private async markAvailable(): Promise<void> {
      if (this.available === true) return;
      this.available = true;
      this.logger.info('available');
      await this.setAvailable()
        .catch((error) => this.logger.error('setAvailable failed:', error?.message ?? error));
    }

    private async markUnavailable(reason: string): Promise<void> {
      if (this.available === false) return;
      this.available = false;
      this.logger.info(`unavailable: ${reason}`);
      await this.setUnavailable(reason)
        .catch((error) => this.logger.error('setUnavailable failed:', error?.message ?? error));
    }

    /**
     * Bring the device up to date after a (re)connect.
     *
     * Each stage runs independently on purpose. `getDeviceTransitPolicies` and friends are
     * documented to hang, and when the stages were chained with `await` one hung call left the
     * device sitting in "No response" with nothing in the log — the socket was fine, the refresh
     * simply never finished. Availability is decided by the first stage; nothing later can hold
     * it hostage, and every stage says how long it took.
     */
    private async refresh(): Promise<void> {
      if (this.refreshing) {
        // `connect` and `userUpdate` both trigger resubscription, so `ready` arrives twice per
        // connection. Running the whole refresh twice raced two setSettings calls for no gain.
        this.logger.debug('refresh already running, skipping the duplicate');
        return;
      }
      this.refreshing = true;

      try {
        await this.setCapabilityValue('alarm_connectivity', false).catch(() => {});

        const stages: [string, () => Promise<void>][] = [
          ['device', () => this.refreshDevice()],
          ['policies', () => this.refreshPolicies()],
          ['lock', () => this.updateLockState()],
          ['history', () => this.backfillLatestEvent()],
          ['cats', () => this.refreshCatLocations()],
        ];

        for (const [name, run] of stages) {
          const started = Date.now();
          try {
            await run();
            this.logger.debug(`refresh: ${name} in ${Date.now() - started}ms`);
          } catch (error: any) {
            this.logger.error(`refresh: ${name} failed after ${Date.now() - started}ms:`,
              error?.message ?? error);
          }
        }
        this.logger.info('refresh complete');
      } finally {
        this.refreshing = false;
      }
    }

    private async refreshDevice(): Promise<void> {
      const device = await this.gateway.getDevice(this.deviceId);
      if (!device || !device.deviceId) {
        // The gateway answering with nothing for a device we are subscribed to is not a state
        // worth guessing about, and treating it as connected would be worse.
        throw new Error(`getDevice returned nothing for ${this.deviceId}`);
      }

      this.timeZone = device.timeZone ?? null;
      this.activePolicyId = device.deviceTransitPolicyId ?? null;

      const connected = device.connectivity?.connected !== false;
      this.logger.debug(`device: flap is ${connected ? 'online' : 'OFFLINE'}`
        + `${device.connectivity?.disconnectReason ? ` (${device.connectivity.disconnectReason})` : ''}`
        + `, zone ${device.timeZone ?? 'unset'}, policy ${device.deviceTransitPolicyId ?? 'none'}`);

      await this.setCapabilityValue('alarm_connectivity', !connected).catch(() => {});
      if (connected) await this.markAvailable();
      else await this.markUnavailable(this.t('error.no_connection'));

      await this.setSettings({
        device_id: this.deviceId,
        mac_address: macAddress(this.deviceId),
        time_zone: device.timeZone ?? '—',
        firmware_channel: device.firmwareChannel ?? '—',
        tracked_cats: this.cats.map((cat) => cat.name).join(', ') || '—',
      }).catch(() => {});

    }

    private async refreshPolicies(): Promise<void> {
      try {
        const summaries = await this.gateway.getDeviceTransitPolicies(this.deviceId);
        const full: OnlyCatDeviceTransitPolicy[] = [];
        for (const summary of summaries) {
          try {
            full.push(await this.gateway.getDeviceTransitPolicy(summary.deviceTransitPolicyId));
          } catch {
            // These calls are documented to hang. A policy we could not fetch degrades to
            // its name-only summary rather than taking the whole list down.
            full.push(summary);
          }
        }
        this.policies = full;
        const names = full.map((p) => `${this.policyName(p)}#${p.deviceTransitPolicyId}`);
        this.logger.debug(`policies: ${names.join(', ') || 'none'};`
          + ` active ${this.activePolicyId ?? 'none'}`);
        await this.applyPolicyCapability();
      } catch (error: any) {
        this.logger.error('policy refresh failed:', error?.message ?? error);
      }
    }

    private policyName(policy: OnlyCatDeviceTransitPolicy): string {
      return policy.name ?? this.t('policy.unnamed', { id: String(policy.deviceTransitPolicyId) });
    }

    private async applyPolicyCapability(): Promise<void> {
      const values = this.policies.map((policy) => ({
        id: String(policy.deviceTransitPolicyId),
        title: this.policyName(policy),
      }));
      if (!values.length) return;

      // The enum's values are per-device and only knowable at runtime, so they are pushed with
      // setCapabilityOptions() rather than declared in compose.
      await this.setCapabilityOptions('policy_ONLYCAT', { values }).catch((error) => {
        this.error('setCapabilityOptions(policy) failed:', error?.message ?? error);
      });

      if (this.activePolicyId != null) {
        await this.setCapabilityValue('policy_ONLYCAT', String(this.activePolicyId)).catch(() => {});
      }
    }

    private activePolicy(): OnlyCatDeviceTransitPolicy | null {
      if (this.activePolicyId == null) return null;
      return this.policies.find((p) => p.deviceTransitPolicyId === this.activePolicyId) ?? null;
    }

    /**
     * The lock state the active door policy leaves the flap in when nothing is happening.
     *
     * Reported **only when the simulation can stand behind it.** If the policy contains a rule
     * whose criteria depend on the flap's own sensors — `flapState`, `motionSensorState`, neither
     * of which the API exposes — that rule might have pre-empted the one we matched, and the
     * answer would be a guess dressed as a fact. In that case the capability is set to `null`,
     * which Homey renders as "unknown" rather than as "unlocked".
     *
     * This is the same `confident` flag the refusal reason uses, for the same reason. What the
     * app must never do is assert a lock state it cannot justify; saying nothing is allowed.
     */
    private async updateLockState(): Promise<void> {
      const policy = this.activePolicy();
      if (!policy) return;

      if (Date.now() < this.manualUnlockUntil) {
        await this.setCapabilityValue('locked', false).catch(() => {});
        return;
      }

      // No event context on purpose: this is the IDLE state. Rules keyed on a chip code or an
      // event classification genuinely cannot match when nothing is happening, so leaving those
      // inputs empty is the correct question to ask, not a missing input.
      const outcome = evaluatePolicy(policy, { minutesOfDay: minutesOfDayIn(this.timeZone) });
      const value = outcome.confident ? outcome.locked : null;

      if (value !== this.getCapabilityValue('locked')) {
        const state = value === null ? 'unknown' : ['unlocked', 'locked'][Number(value)];
        this.logger.info(`lock state: ${state}`
          + ` (rule ${outcome.ruleIndex ?? 'none, idle state'}`
          + `${outcome.confident ? '' : ', cannot be sure — policy uses the flap\'s own sensors'})`);
      }

      await this.setCapabilityValue('locked', value).catch(() => {});
    }

    /**
     * Load the most recent event so the camera and the event line are not blank.
     *
     * Without this a freshly started app shows an empty camera and no history until the next cat
     * goes through, which can be hours. The event is adopted as already-settled, so no Flow card
     * fires — nobody wants a prey alert about last Tuesday because their Homey rebooted.
     */
    /**
     * Give the alarms a value before anything has happened.
     *
     * Homey persists a capability's value across restarts, but only once something has written
     * one — an untouched capability renders as "-" on the tile, which is how "Prey detected"
     * and "Human activity" looked on a freshly paired flap. `false` is not a guess here: it
     * means no event is in progress, which is true at startup by definition.
     *
     * Only ever fills a blank. A value already there is real state and is left alone.
     */
    private async seedAlarms(): Promise<void> {
      for (const capability of ['alarm_motion', 'alarm_prey_ONLYCAT', 'alarm_human_ONLYCAT']) {
        if (!this.hasCapability(capability)) continue;
        if (this.getCapabilityValue(capability) !== null) continue;
        await this.setCapabilityValue(capability, false).catch(() => {});
      }

      // Counters start at zero rather than blank, so Insights has a baseline to draw from
      // instead of starting wherever the first event happens to put it.
      for (const capability of [...COUNTERS, 'cats_home_ONLYCAT']) {
        if (!this.hasCapability(capability)) continue;
        if (this.getCapabilityValue(capability) !== null) continue;
        await this.setCapabilityValue(capability, 0).catch(() => {});
      }
    }

    /**
     * Record where a cat is, and keep its "outside today" clock honest.
     *
     * The single funnel for every source of truth about a cat's location — a flap transit, the
     * backfill at startup, and the owner's manual override — so none of them can update the
     * presence capability while forgetting the clock.
     */
    private async setCatState(rfid: string, home: boolean | null, at = Date.now()): Promise<void> {
      const capability = capabilityForCat(rfid);
      if (this.hasCapability(capability)) {
        await this.setCapabilityValue(capability, home).catch(() => {});
      }

      const day = localDay(this.timeZone, new Date(at));
      const dayStart = this.localMidnight(at);
      const current = this.outside[rfid] ?? emptyState(day);
      const outside = home === null ? null : !home;

      const before = this.outside[rfid];
      this.outside[rfid] = applyLocation(
        rollOver(current, day, at, dayStart),
        outside,
        at,
        { fraction: unseenFraction(this.getSetting('unseen_trips')), dayStart },
      );

      // Worth a line when it happens: it means the cat used a route the flap cannot see, and it
      // is the one place "Outside today" stops being a measurement and starts being an estimate.
      if (before && (before.since !== null) === (outside === true)) {
        this.logger.info(`${this.nameFor(rfid)}: unseen trip — it was ${outside ? 'in' : 'out'}`
          + ' at some point without using the flap'
          + ` (assuming: ${this.getSetting('unseen_trips') ?? 'half'})`);
      }

      await this.setStoreValue('outside', this.outside).catch(() => {});
      await this.publishOutside(rfid, at);
      await this.updateCatsHome();
    }

    /** Epoch ms of the most recent local midnight in the flap's zone. */
    private localMidnight(at: number): number {
      const minutes = minutesOfDayIn(this.timeZone, new Date(at));
      return minutes === null ? at : at - minutes * 60000;
    }

    private async publishOutside(rfid: string, at: number): Promise<void> {
      const capability = outsideCapabilityForCat(rfid);
      if (!this.hasCapability(capability)) return;
      const state = this.outside[rfid];
      if (!state) return;
      await this.setCapabilityValue(capability, hoursToday(state, at)).catch(() => {});
    }

    /**
     * Tick every tracked cat's clock, and turn the day over at local midnight.
     *
     * The value is recomputed from `since` rather than accumulated a minute at a time, so a
     * missed tick, a restart or a Homey reboot costs nothing.
     */
    private async updateOutside(): Promise<void> {
      const at = Date.now();
      const day = localDay(this.timeZone, new Date(at));
      const midnight = this.localMidnight(at);
      let rolled = false;

      for (const cat of this.cats) {
        const current = this.outside[cat.rfidCode] ?? emptyState(day);
        const next = rollOver(current, day, at, midnight);
        if (next !== current) rolled = true;
        this.outside[cat.rfidCode] = next;
        await this.publishOutside(cat.rfidCode, at);
      }

      if (rolled) {
        this.logger.info(`a new day started (${day}); outside timers reset`);
        await this.setStoreValue('outside', this.outside).catch(() => {});
      }
    }

    /** Add to a counter, reading its persisted value rather than keeping one in memory. */
    private async bump(capability: string, by = 1): Promise<void> {
      if (!this.hasCapability(capability)) return;
      const current = Number(this.getCapabilityValue(capability) ?? 0);
      const next = current + by;
      await this.setCapabilityValue(capability, next).catch(() => {});
      this.logger.debug(`${capability}: ${current} -> ${next}`);
    }

    /**
     * How many tracked cats are inside.
     *
     * Counts only cats whose state is actually known: `null` means "not seen yet", which is not
     * the same as "out" and must not quietly become one.
     */
    private async updateCatsHome(): Promise<void> {
      if (!this.hasCapability('cats_home_ONLYCAT')) return;
      const home = this.cats.filter((cat) => this.isCatHome(cat.rfidCode) === true).length;
      await this.setCapabilityValue('cats_home_ONLYCAT', home).catch(() => {});
    }

    /**
     * Fill in the last refusal from history, once.
     *
     * "Last refusal" would otherwise stay blank until a cat is actually turned away, which on a
     * well-behaved household could be never. Costs one summary request per event scanned, so it
     * runs only while the capability is empty — after that the stored value persists.
     */
    private async backfillLastRefusal(events: OnlyCatEvent[]): Promise<void> {
      if (this.getCapabilityValue('last_blocked_ONLYCAT')) return;

      const recent = [...events].sort((a, b) => b.eventId - a.eventId).slice(0, REFUSAL_SCAN);
      for (const event of recent) {
        if (!event.accessToken) continue;
        let summary;
        try {
          summary = await this.gateway.getEventSummary(
            this.deviceId, event.eventId, event.accessToken, false,
          );
        } catch {
          continue;
        }

        const denied = usableSubevents(summary).find((sub) => sub.action === 'DENY');
        if (!denied) continue;

        const rfid = denied.rfidCode ?? '';
        const tracked = rfid ? this.cats.find((cat) => cat.rfidCode === rfid) : null;
        const reason = explainRefusal(this.refusalOutcome(event, rfid), tracked ? this.nameFor(rfid) : null);
        const line = this.t(reason.key, reason.tags);

        await this.setCapabilityValue('last_blocked_ONLYCAT', line).catch(() => {});
        this.logger.debug(`history: last refusal was event ${event.eventId} — ${line}`);
        return;
      }
      this.logger.debug(`history: no refusal in the last ${recent.length} event(s)`);
    }

    private async backfillLatestEvent(): Promise<void> {
      const events = await this.gateway.getDeviceEvents(this.deviceId, false);
      const usable = events.filter((event) => event.eventId != null && !event.deletedAt);
      if (!usable.length) {
        this.logger.debug('history: no past events to show');
        return;
      }

      const latest = usable.reduce((a, b) => (b.eventId > a.eventId ? b : a));
      this.store.adopt(latest);
      await this.showEvent(latest);

      let label = '';
      if (latest.accessToken) {
        try {
          const summary = await this.gateway.getEventSummary(
            this.deviceId, latest.eventId, latest.accessToken, false,
          );
          if (summary) {
            this.store.applySummary(summary);
            const subevents = usableSubevents(summary);
            const last = subevents[subevents.length - 1];
            const kind = last ? kindOf(last) : null;
            if (kind) label = this.t(`event.${kind.key}`, { name: this.nameFor(last.rfidCode) });
          }
        } catch (error: any) {
          this.logger.debug(`history: no summary for ${latest.eventId}: ${error?.message ?? error}`);
        }
      }

      if (label) await this.setCapabilityValue('last_event_ONLYCAT', label).catch(() => {});
      this.logger.debug(`history: showing event ${latest.eventId}${label ? ` — ${label}` : ''}`);

      await this.backfillLastRefusal(usable);
    }

    private async refreshCatLocations(): Promise<void> {
      if (!this.cats.length) return;
      try {
        const lastSeen = await this.gateway.getRfidLastSeenByDevice(this.deviceId);
        for (const cat of this.cats) {
          const entry = lastSeen.find((e) => e.rfidCode === cat.rfidCode);
          if (!entry) continue;
          const location = initialLocation(entry);
          if (location === null) continue;
          await this.setCatState(cat.rfidCode, location);
        }
      } catch (error: any) {
        this.logger.error('cat locations refresh failed:', error?.message ?? error);
      }
    }

    // ------------------------------------------------------------------------------------------
    // Capabilities
    // ------------------------------------------------------------------------------------------

    async syncCapabilities(): Promise<void> {
      const plan = capabilitySyncPlan(this.getCapabilities(), this.cats);

      for (const capability of plan.remove) {
        await this.removeCapability(capability)
          .catch((error) => this.error(`remove ${capability}:`, error?.message));
      }

      for (const cat of this.cats) {
        const outsideCapability = outsideCapabilityForCat(cat.rfidCode);
        if (plan.add.includes(outsideCapability)) {
          await this.addCapability(outsideCapability)
            .catch((error) => this.error(`add ${outsideCapability}:`, error?.message));
        }
        await this.setCapabilityOptions(outsideCapability,
          { title: `${cat.name} — ${this.t('camera.outside_today')}` })
          .catch((error) => this.error(`options ${outsideCapability}:`, error?.message));

        const capability = capabilityForCat(cat.rfidCode);
        if (plan.add.includes(capability)) {
          await this.addCapability(capability).catch((error) => this.error(`add ${capability}:`, error?.message));
        }

        // addCapability() applies only the base type's defaults — never the per-instance
        // options — and for a runtime-created instance there is no compose declaration to
        // fall back on. Without this the tile says "Cat" for every cat.
        await this.setCapabilityOptions(capability, { title: cat.name })
          .catch((error) => this.error(`options ${capability}:`, error?.message));
      }
    }

    private registerListeners(): void {
      /*
       * The tile's quick action. Only one direction of this toggle has a command behind it.
       *
       * `false` is OnlyCat's remote unlock, which is real. There is no "lock now" — the flap
       * locks itself according to whichever door policy is active — so `true` explains that
       * instead of failing silently or pretending to work.
       */
      this.registerCapabilityListener('locked', async (value: boolean) => {
        if (value) throw new Error(this.t('error.cannot_lock'));

        await this.gateway.runDeviceCommand(this.deviceId, 'unlock');
        this.logger.info('remote unlock sent');

        // Hold the derived value off for a moment. `locked` is otherwise computed from the door
        // policy's idle state, which would recompute to "locked" within seconds and make the
        // toggle snap back as though the unlock had failed. It had not: the flap really is open
        // until a cat goes through or OnlyCat relocks it.
        this.manualUnlockUntil = Date.now() + MANUAL_UNLOCK_MS;
      });

      this.registerCapabilityListener('policy_ONLYCAT', async (value: string) => {
        const policyId = Number(value);
        if (!this.policies.some((p) => p.deviceTransitPolicyId === policyId)) {
          throw new Error(this.t('error.unknown_policy'));
        }
        await this.gateway.activateDeviceTransitPolicy(this.deviceId, policyId);
        this.activePolicyId = policyId;
        await this.updateLockState();
      });

    }

    // ------------------------------------------------------------------------------------------
    // The event pipeline
    // ------------------------------------------------------------------------------------------

    private onDeviceEventUpdate = (deviceId: string, eventId: number, accessToken: string | null): void => {
      if (deviceId !== this.deviceId) return;
      if (!this.store.begin(deviceId, eventId, accessToken)) {
        this.logger.debug(`event ${eventId}: ignored, older than the one in hand`);
        return;
      }
      this.logger.debug(`event ${eventId}: started (token ${accessToken ? 'present' : 'absent'})`);

      // The tile reacts on the FIRST push so the flap visibly does something the moment a cat
      // appears. The cards that claim which cat did what wait for a final summary.
      void this.setCapabilityValue('alarm_motion', true).catch(() => {});
      this.armMotionTimeout();

      void this.hydrate(eventId, accessToken).catch((error) => this.error('hydrate failed:', error?.message ?? error));
    };

    private onEventUpdate = (event: OnlyCatEvent): void => {
      if (event.deviceId !== this.deviceId) return;
      if (!this.store.applyEvent(event)) return;
      this.logger.debug(`event ${event.eventId}: `
        + `${event.frameCount == null ? 'in progress' : `concluded, ${event.frameCount} frames`}`
        + `, classification ${effectiveClassification(event) ?? '?'}`);
      void this.afterUpdate().catch((error) => this.error('event update failed:', error?.message ?? error));
    };

    private onEventSummaryUpdate = (summary: OnlyCatEventSummary): void => {
      if (summary.deviceId !== this.deviceId) return;
      if (!this.store.applySummary(summary)) return;
      this.logger.debug(`event ${summary.eventId}: summary, `
        + `${summary.processedFrameCount ?? '?'} frames processed, `
        + `${describeSubevents(summary.subevents)}`);
      void this.afterUpdate().catch((error) => this.error('summary update failed:', error?.message ?? error));
    };

    private async hydrate(eventId: number, accessToken: string | null): Promise<void> {
      const event = await this.gateway.getEvent(this.deviceId, eventId);
      this.store.applyEvent(event);

      const token = accessToken ?? event.accessToken ?? null;
      if (token) {
        const summary = await this.gateway.getEventSummary(this.deviceId, eventId, token);
        if (summary) this.store.applySummary(summary);
      }
      await this.afterUpdate();
    }

    private async afterUpdate(): Promise<void> {
      const { tracked } = this.store;
      if (!tracked) return;

      await this.applyClassification(tracked.event);

      if (isEventConcluded(tracked.event)) {
        await this.setCapabilityValue('alarm_motion', false).catch(() => {});
        if (this.motionTimer) this.homey.clearTimeout(this.motionTimer);
        this.motionTimer = null;
      }

      const settled = this.store.settle();
      if (settled) {
        this.logger.debug(`event ${tracked.eventId}: summary final, committing ${settled.length} subevent(s)`);
        if (this.summaryTimer) this.homey.clearTimeout(this.summaryTimer);
        this.summaryTimer = null;
        await this.commit(settled);
        return;
      }

      // The event is over but the summary has not caught up. Give it a grace period, then take
      // what we have — an event with no cat in it may never produce a usable summary, and
      // holding it forever would make the next event look stale.
      if (isEventConcluded(tracked.event) && !this.summaryTimer) {
        this.summaryTimer = this.homey.setTimeout(() => {
          this.summaryTimer = null;
          const late = this.store.settleStale();
          if (late) {
            this.logger.debug(`event ${tracked.eventId}: no final summary after `
              + `${SUMMARY_GRACE_MS / 1000}s, committing ${late.length} subevent(s) anyway`);
            void this.commit(late).catch((error) => this.logger.error('late commit:', error?.message ?? error));
          }
        }, SUMMARY_GRACE_MS);
      }
    }

    private armMotionTimeout(): void {
      if (this.motionTimer) this.homey.clearTimeout(this.motionTimer);
      this.motionTimer = this.homey.setTimeout(() => {
        this.motionTimer = null;
        void this.setCapabilityValue('alarm_motion', false).catch(() => {});
      }, MOTION_TIMEOUT_MS);
    }

    private async applyClassification(event: OnlyCatEvent): Promise<void> {
      const classification = effectiveClassification(event);
      await this.setCapabilityValue('alarm_prey_ONLYCAT',
        classification === EventClassification.Contraband).catch(() => {});
      await this.setCapabilityValue('alarm_human_ONLYCAT',
        classification === EventClassification.HumanActivity).catch(() => {});
    }

    /**
     * Point the camera at an event, and say which one in its title.
     *
     * The picker once filled up with duplicate rows, and the cause was NOT re-titling: it was the
     * still and the clip being registered under the same id with DIFFERENT titles, which broke
     * the pairing and produced two rows — one showing the clip, one showing the still. They are
     * always written together now, with the same id and the same title, so the row updates
     * instead of multiplying.
     *
     * The title carries the event's local time because a row called "Last event" tells you
     * nothing you did not already know from it being the only row.
     */
    private async showEvent(event: OnlyCatEvent, label?: string): Promise<void> {
      this.currentImageUrl = imageUrl(GATEWAY_URL, event);
      await this.lastImage?.update().catch(() => {});

      const when = this.formatTime(event.timestamp);
      const title = [label, when].filter(Boolean).join(' · ') || this.t('camera.last_event');
      if (title === this.cameraTitle) return;
      this.cameraTitle = title;

      // One id for both, so Homey uses the still as the clip's poster while it loads.
      if (this.lastImage) {
        await this.setCameraImage(CAMERA_ID, title, this.lastImage)
          .catch((error) => this.logger.error('setCameraImage failed:', error?.message ?? error));
      }
      if (this.clipVideo) {
        await this.setCameraVideo(CAMERA_ID, title, this.clipVideo)
          .catch((error) => this.logger.error('setCameraVideo failed:', error?.message ?? error));
      }
      this.logger.debug(`camera now showing "${title}"`);
    }

    /** Short local time in the FLAP's zone, which is where the cat was. */
    private formatTime(timestamp: string | null | undefined): string {
      if (!timestamp) return '';
      try {
        return new Intl.DateTimeFormat(this.homey.i18n.getLanguage() ?? 'en', {
          timeZone: this.timeZone ?? undefined,
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(timestamp));
      } catch {
        return '';
      }
    }

    /** Fire everything this event earns. Called exactly once per event. */
    private async commit(subevents: OnlyCatSubEvent[]): Promise<void> {
      const { tracked } = this.store;
      if (!tracked) return;

      const { event } = tracked;
      const classification = effectiveClassification(event);

      if (classification === EventClassification.Contraband) {
        const carrier = subevents.find((s) => s.rfidCode) ?? null;
        await this.fire('prey_detected', {
          cat: this.nameFor(carrier?.rfidCode ?? null),
          rfid: carrier?.rfidCode ?? '',
          image: this.lastImage,
        });
      }

      for (const subevent of subevents) {
        const kind = kindOf(subevent);
        if (!kind) continue;
        await this.commitSubevent(event, subevent, kind, classification);
      }

    }

    private async commitSubevent(
      event: OnlyCatEvent,
      subevent: OnlyCatSubEvent,
      kind: SubEventKind,
      classification: EventClassification | null,
    ): Promise<void> {
      const rfid = subevent.rfidCode ?? '';
      const tracked = rfid ? this.cats.find((cat) => cat.rfidCode === rfid) ?? null : null;
      const name = this.nameFor(rfid || null);
      const direction = subevent.direction === 'INWARD' ? 'in' : 'out';
      const actionLabel = this.t(`event.${kind.key}`, { name });

      this.logger.info(actionLabel);
      await this.setCapabilityValue('last_event_ONLYCAT', actionLabel).catch(() => {});
      await this.showEvent(event, actionLabel);

      // Presence, but only for cats we actually track. An untracked chip has no capability.
      if (tracked) {
        const location = locationAfter(subevent);
        if (location !== null) {
          await this.setCatState(rfid, location === 'inside');
        }
      }

      const base = {
        cat: name,
        rfid,
        direction,
        classification: classification != null ? (CLASSIFICATION_NAMES[classification] ?? 'unknown') : '',
        action: actionLabel,
        trigger: event.eventTriggerSource != null
          ? (TRIGGER_SOURCE_NAMES[event.eventTriggerSource] ?? 'unknown') : '',
        image: this.lastImage,
      };

      if (kind.action === 'TRANSIT' || kind.action === 'BREACH') {
        // A breach counts as a trip: the cat did get through, just not with permission.
        await this.bump(kind.direction === 'INWARD' ? 'trips_in_ONLYCAT' : 'trips_out_ONLYCAT');
      } else if (kind.action === 'DENY') {
        await this.bump('refusals_ONLYCAT');
      }

      if (kind.trigger === 'cat_denied') {
        const outcome = this.refusalOutcome(event, rfid);
        const reason = explainRefusal(outcome, tracked ? name : null);
        const line = this.t(reason.key, reason.tags);
        this.logger.info(`refusal: ${line}`
          + ` (rule ${outcome.ruleIndex ?? 'none, idle state'}, ${outcome.confident ? 'confident' : 'NOT confident'})`);
        await this.setCapabilityValue('last_blocked_ONLYCAT', line).catch(() => {});
        await this.fire('cat_denied', { ...base, reason: line }, { cat: rfid });
      } else {
        await this.fire(kind.trigger, base, { cat: rfid });
      }

      if (!tracked) {
        await this.fire('unknown_cat', {
          rfid, action: actionLabel, direction, image: this.lastImage,
        });
      }

      await this.fire('flap_event', base, { cat: rfid, action: kind.actionFilter });
    }

    /** Re-run the policy against this specific event, so the refusal has a cause to name. */
    private refusalOutcome(event: OnlyCatEvent, rfid: string): PolicyOutcome {
      return evaluatePolicy(this.activePolicy(), {
        eventTriggerSource: event.eventTriggerSource ?? null,
        eventClassification: effectiveClassification(event),
        rfidCodes: rfid ? [rfid] : (event.rfidCodes ?? []),
        minutesOfDay: minutesOfDayIn(this.timeZone),
      });
    }

    private nameFor(rfid: string | null): string {
      if (!rfid) return this.t('event.a_cat');
      const tracked = this.cats.find((cat) => cat.rfidCode === rfid);
      return tracked?.name ?? this.t('event.unknown_cat');
    }

    private async fire(card: string, tokens: Record<string, any>, state: Record<string, any> = {}): Promise<void> {
      try {
        await this.homey.flow.getDeviceTriggerCard(card).trigger(this, tokens, state);
      } catch (error: any) {
        this.logger.error(`trigger ${card} failed:`, error?.message ?? error);
      }
    }

    // ------------------------------------------------------------------------------------------
    // Used by the driver's Flow listeners
    // ------------------------------------------------------------------------------------------

    trackedCats(): TrackedCat[] {
      return this.cats;
    }

    policyList(): { id: string; name: string }[] {
      return this.policies.map((policy) => ({
        id: String(policy.deviceTransitPolicyId),
        name: this.policyName(policy),
      }));
    }

    activePolicyIdString(): string | null {
      return this.activePolicyId == null ? null : String(this.activePolicyId);
    }

    isCatHome(rfid: string): boolean | null {
      const capability = capabilityForCat(rfid);
      if (!this.hasCapability(capability)) return null;
      return this.getCapabilityValue(capability) as boolean | null;
    }

    async setCatLocation(rfid: string, home: boolean): Promise<void> {
      const capability = capabilityForCat(rfid);
      if (!this.hasCapability(capability)) throw new Error(this.t('error.unknown_cat'));
      // Treated exactly like a flap transit, because it is better evidence: somebody looked at
      // the cat. A cat let out of the front door is invisible to the flap, and this is the only
      // way the clock learns about it.
      await this.setCatState(rfid, home);
      this.logger.info(`${this.nameFor(rfid)} marked ${home ? 'home' : 'out'} by hand`);
    }

    async unlock(): Promise<void> {
      await this.gateway.runDeviceCommand(this.deviceId, 'unlock');
    }

    async reboot(): Promise<void> {
      await this.gateway.runDeviceCommand(this.deviceId, 'reboot');
    }

    async activatePolicy(policyId: number): Promise<void> {
      await this.gateway.activateDeviceTransitPolicy(this.deviceId, policyId);
      this.activePolicyId = policyId;
      await this.setCapabilityValue('policy_ONLYCAT', String(policyId)).catch(() => {});
      await this.updateLockState();
    }

    /** Called by the driver after a Repair that changed the key or the tracked cats. */
    async applyRepair(apiKey: string, cats: TrackedCat[]): Promise<void> {
      this.teardown();
      await this.setStoreValue('apiKey', apiKey);
      await this.setStoreValue('cats', cats);
      this.cats = cats;
      await this.syncCapabilities();
      await this.connect();
    }

    /** Every capability instance currently representing a cat, for the autocomplete. */
    catCapabilities(): string[] {
      return this.getCapabilities()
        .filter((id) => id.startsWith(`${CAT_CAPABILITY}.`))
        .filter((id) => rfidFromCapability(id) !== null);
    }

    private async setUnavailableSafely(message: string): Promise<void> {
      await this.setUnavailable(message).catch(() => {});
    }

    handleAuthError(error: unknown): void {
      if (error instanceof OnlyCatAuthError) {
        void this.setUnavailableSafely(this.t('error.unauthorized'));
      }
    }

};
