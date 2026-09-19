import Homey from 'homey';
import {
  CAT_CAPABILITY, TrackedCat, capabilityForCat, capabilitySyncPlan, initialLocation, rfidFromCapability,
} from '../../lib/cats';
import { EventStore, imageUrl, isEventConcluded } from '../../lib/event-store';
import { SubEventKind, kindOf, locationAfter } from '../../lib/events';
import { Gateway, GATEWAY_URL, OnlyCatAuthError } from '../../lib/gateway';
import {
  EventClassification, EventTriggerSource, OnlyCatDeviceTransitPolicy, OnlyCatEvent,
  OnlyCatEventSummary, OnlyCatSubEvent, effectiveClassification, macAddress,
} from '../../lib/onlycat/models';
import { PolicyOutcome, evaluatePolicy, minutesOfDayIn } from '../../lib/policy';
import { explainRefusal } from '../../lib/reason';

/** How long to wait for a final summary before settling on what we have. */
const SUMMARY_GRACE_MS = 45000;
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

    get deviceId(): string {
      return this.getData().id as string;
    }

    // ------------------------------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------------------------------

    async onInit(): Promise<void> {
      this.cats = (this.getStoreValue('cats') as TrackedCat[]) ?? [];

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

      await this.connect();
    }

    async onUninit(): Promise<void> {
      this.teardown();
    }

    onDeleted(): void {
      this.teardown();
    }

    private teardown(): void {
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
        await this.setUnavailable(this.homey.__('error.unauthorized'));
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
    }

    // Bound fields rather than methods: they are handed to the shared gateway and have to be
    // removable by identity in teardown(), or a re-paired device leaks a listener per init.
    private onReady = (): void => {
      void this.refresh().catch((error) => this.error('refresh failed:', error?.message ?? error));
    };

    private onDown = (reason: string): void => {
      void this.setUnavailable(`${this.homey.__('error.no_connection')} (${reason})`).catch(() => {});
      void this.setCapabilityValue('alarm_connectivity', true).catch(() => {});
    };

    private onUnauthorized = (): void => {
      void this.setUnavailable(this.homey.__('error.unauthorized')).catch(() => {});
    };

    private onDeviceUpdate = (deviceId: string): void => {
      if (deviceId !== this.deviceId) return;
      // Push payloads are invalidation signals, not data — both other clients re-fetch rather
      // than trusting the body, and the body is a Partial<Device> anyway.
      void this.refreshDevice().catch((error) => this.error('device refresh failed:', error?.message ?? error));
    };

    // ------------------------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------------------------

    private async refresh(): Promise<void> {
      await this.setAvailable();
      await this.setCapabilityValue('alarm_connectivity', false).catch(() => {});
      await this.refreshDevice();
      await this.refreshPolicies();
      await this.refreshCatLocations();
    }

    private async refreshDevice(): Promise<void> {
      const device = await this.gateway.getDevice(this.deviceId);
      this.timeZone = device.timeZone ?? null;
      this.activePolicyId = device.deviceTransitPolicyId ?? null;

      const connected = device.connectivity?.connected !== false;
      await this.setCapabilityValue('alarm_connectivity', !connected).catch(() => {});
      if (connected) await this.setAvailable();
      else await this.setUnavailable(this.homey.__('error.no_connection'));

      await this.setSettings({
        device_id: this.deviceId,
        mac_address: macAddress(this.deviceId),
        time_zone: device.timeZone ?? '—',
        firmware_channel: device.firmwareChannel ?? '—',
        tracked_cats: this.cats.map((cat) => cat.name).join(', ') || '—',
      }).catch(() => {});

      await this.updateLockState();
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
        await this.applyPolicyCapability();
      } catch (error: any) {
        this.error('policy refresh failed:', error?.message ?? error);
      }
    }

    private policyName(policy: OnlyCatDeviceTransitPolicy): string {
      return policy.name ?? this.homey.__('policy.unnamed', { id: String(policy.deviceTransitPolicyId) });
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
     * The flap does not report lock state, so this is the idle-state simulation: what the policy
     * decides when nothing is happening.
     */
    private async updateLockState(): Promise<void> {
      const outcome = evaluatePolicy(this.activePolicy(), {
        minutesOfDay: minutesOfDayIn(this.timeZone),
      });
      await this.setCapabilityValue('locked', outcome.locked).catch(() => {});
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
          await this.setCapabilityValue(capabilityForCat(cat.rfidCode), location).catch(() => {});
        }
      } catch (error: any) {
        this.error('cat locations refresh failed:', error?.message ?? error);
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
      this.registerCapabilityListener('policy_ONLYCAT', async (value: string) => {
        const policyId = Number(value);
        if (!this.policies.some((p) => p.deviceTransitPolicyId === policyId)) {
          throw new Error(this.homey.__('error.unknown_policy'));
        }
        await this.gateway.activateDeviceTransitPolicy(this.deviceId, policyId);
        this.activePolicyId = policyId;
        await this.updateLockState();
      });

      this.registerCapabilityListener('button.unlock', async () => {
        await this.gateway.runDeviceCommand(this.deviceId, 'unlock');
      });

      this.registerCapabilityListener('button.reboot', async () => {
        await this.gateway.runDeviceCommand(this.deviceId, 'reboot');
      });
    }

    // ------------------------------------------------------------------------------------------
    // The event pipeline
    // ------------------------------------------------------------------------------------------

    private onDeviceEventUpdate = (deviceId: string, eventId: number, accessToken: string | null): void => {
      if (deviceId !== this.deviceId) return;
      if (!this.store.begin(deviceId, eventId, accessToken)) return;

      // The tile reacts on the FIRST push so the flap visibly does something the moment a cat
      // appears. The cards that claim which cat did what wait for a final summary.
      void this.setCapabilityValue('alarm_motion', true).catch(() => {});
      this.armMotionTimeout();

      void this.hydrate(eventId, accessToken).catch((error) => this.error('hydrate failed:', error?.message ?? error));
    };

    private onEventUpdate = (event: OnlyCatEvent): void => {
      if (event.deviceId !== this.deviceId) return;
      if (!this.store.applyEvent(event)) return;
      void this.afterUpdate().catch((error) => this.error('event update failed:', error?.message ?? error));
    };

    private onEventSummaryUpdate = (summary: OnlyCatEventSummary): void => {
      if (summary.deviceId !== this.deviceId) return;
      if (!this.store.applySummary(summary)) return;
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
          if (late) void this.commit(late).catch((error) => this.error('late commit:', error?.message ?? error));
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

    /** Fire everything this event earns. Called exactly once per event. */
    private async commit(subevents: OnlyCatSubEvent[]): Promise<void> {
      const { tracked } = this.store;
      if (!tracked) return;

      const { event } = tracked;
      this.currentImageUrl = imageUrl(GATEWAY_URL, event);
      await this.lastImage?.update().catch(() => {});

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

      await this.updateLockState();
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
      const actionLabel = this.homey.__(`event.${kind.key}`, { name });

      await this.setCapabilityValue('last_event_ONLYCAT', actionLabel).catch(() => {});

      // Presence, but only for cats we actually track. An untracked chip has no capability.
      if (tracked) {
        const location = locationAfter(subevent);
        if (location !== null) {
          await this.setCapabilityValue(capabilityForCat(rfid), location === 'inside').catch(() => {});
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

      if (kind.trigger === 'cat_denied') {
        const outcome = this.refusalOutcome(event, rfid);
        const reason = explainRefusal(outcome, tracked ? name : null);
        const line = this.homey.__(reason.key, reason.tags);
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
      if (!rfid) return this.homey.__('event.a_cat');
      const tracked = this.cats.find((cat) => cat.rfidCode === rfid);
      return tracked?.name ?? this.homey.__('event.unknown_cat');
    }

    private async fire(card: string, tokens: Record<string, any>, state: Record<string, any> = {}): Promise<void> {
      try {
        await this.homey.flow.getDeviceTriggerCard(card).trigger(this, tokens, state);
      } catch (error: any) {
        this.error(`trigger ${card} failed:`, error?.message ?? error);
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
      if (!this.hasCapability(capability)) throw new Error(this.homey.__('error.unknown_cat'));
      await this.setCapabilityValue(capability, home);
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
        void this.setUnavailableSafely(this.homey.__('error.unauthorized'));
      }
    }

};
