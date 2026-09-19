import Homey from 'homey';
import PairSession from 'homey/lib/PairSession';
import { TrackedCat, offerableCats } from '../../lib/cats';
import { ActionFilter } from '../../lib/events';
import {
  Gateway, GATEWAY_URL, OnlyCatAuthError, verifyApiKey,
} from '../../lib/gateway';
import { humanHash } from '../../lib/onlycat/models';

type CatFlapDevice = Homey.Device & {
    trackedCats(): TrackedCat[];
    policyList(): { id: string; name: string }[];
    activePolicyIdString(): string | null;
    isCatHome(rfid: string): boolean | null;
    setCatLocation(rfid: string, home: boolean): Promise<void>;
    unlock(): Promise<void>;
    reboot(): Promise<void>;
    activatePolicy(policyId: number): Promise<void>;
    applyRepair(apiKey: string, cats: TrackedCat[]): Promise<void>;
};

interface DiscoveredFlap {
    name: string;
    data: { id: string };
    store: { apiKey: string; cats: TrackedCat[] };
    settings: Record<string, string>;
}

module.exports = class CatFlapDriver extends Homey.Driver {

  async onInit(): Promise<void> {
    this.registerFlowCards();
  }

  // ------------------------------------------------------------------------------------------
  // Flow
  // ------------------------------------------------------------------------------------------

  private anyCat(): { name: string; rfid: string } {
    return { name: this.homey.__('flow.any_cat'), rfid: '' };
  }

    private catAutocomplete = async (query: string, args: any) => {
      const device = args?.device as CatFlapDevice | undefined;
      const cats = device?.trackedCats?.() ?? [];
      const options = [
        this.anyCat(),
        ...cats.map((cat) => ({ name: cat.name, rfid: cat.rfidCode })),
      ];
      const needle = (query ?? '').toLowerCase();
      return options.filter((option) => option.name.toLowerCase().includes(needle));
    };

    private policyAutocomplete = async (query: string, args: any) => {
      const device = args?.device as CatFlapDevice | undefined;
      const policies = device?.policyList?.() ?? [];
      const needle = (query ?? '').toLowerCase();
      return policies
        .map((policy) => ({ name: policy.name, id: policy.id }))
        .filter((option) => option.name.toLowerCase().includes(needle));
    };

    /** A card with a cat argument fires when "Any cat" is chosen or the chips match. */
    private catMatches(args: any, state: any): boolean {
      const wanted = args?.cat?.rfid;
      if (!wanted) return true;
      return wanted === state?.cat;
    }

    private registerFlowCards(): void {
      const perCatTriggers = ['cat_came_in', 'cat_went_out', 'cat_denied', 'cat_peeked', 'cat_breached'];

      for (const id of perCatTriggers) {
        const card = this.homey.flow.getDeviceTriggerCard(id);
        card.registerRunListener(async (args: any, state: any) => this.catMatches(args, state));
        card.registerArgumentAutocompleteListener('cat', this.catAutocomplete);
      }

      const generic = this.homey.flow.getDeviceTriggerCard('flap_event');
      generic.registerRunListener(async (args: any, state: any) => {
        if (!this.catMatches(args, state)) return false;
        const wanted = (args?.action ?? 'any') as ActionFilter | 'any';
        return wanted === 'any' || wanted === state?.action;
      });
      generic.registerArgumentAutocompleteListener('cat', this.catAutocomplete);

      const isHome = this.homey.flow.getConditionCard('cat_is_home');
      isHome.registerRunListener(async (args: any) => {
        const device = args.device as CatFlapDevice;
        const rfid = args?.cat?.rfid;
        if (!rfid) {
          // "Any cat" on a condition means "is at least one of them home?", which is the
          // reading that makes a lights-out flow work.
          return device.trackedCats().some((cat) => device.isCatHome(cat.rfidCode) === true);
        }
        return device.isCatHome(rfid) === true;
      });
      isHome.registerArgumentAutocompleteListener('cat', this.catAutocomplete);

      this.homey.flow.getConditionCard('flap_is_locked')
        .registerRunListener(async (args: any) => args.device.getCapabilityValue('locked') === true);

      const policyIs = this.homey.flow.getConditionCard('policy_is');
      policyIs.registerRunListener(async (args: any) => {
        const device = args.device as CatFlapDevice;
        return device.activePolicyIdString() === args?.policy?.id;
      });
      policyIs.registerArgumentAutocompleteListener('policy', this.policyAutocomplete);

      this.homey.flow.getActionCard('unlock_flap')
        .registerRunListener(async (args: any) => (args.device as CatFlapDevice).unlock());

      this.homey.flow.getActionCard('reboot_flap')
        .registerRunListener(async (args: any) => (args.device as CatFlapDevice).reboot());

      const setPolicy = this.homey.flow.getActionCard('set_policy');
      setPolicy.registerRunListener(async (args: any) => {
        const id = Number(args?.policy?.id);
        if (!Number.isFinite(id)) throw new Error(this.homey.__('error.unknown_policy'));
        await (args.device as CatFlapDevice).activatePolicy(id);
      });
      setPolicy.registerArgumentAutocompleteListener('policy', this.policyAutocomplete);

      const setLocation = this.homey.flow.getActionCard('set_cat_location');
      setLocation.registerRunListener(async (args: any) => {
        const rfid = args?.cat?.rfid;
        if (!rfid) throw new Error(this.homey.__('error.unknown_cat'));
        await (args.device as CatFlapDevice).setCatLocation(rfid, args?.where === 'home');
      });
      setLocation.registerArgumentAutocompleteListener('cat', this.catAutocomplete);
    }

    // ------------------------------------------------------------------------------------------
    // Pairing
    // ------------------------------------------------------------------------------------------

    /**
     * Read the account and turn it into pairable devices.
     *
     * Every flap on the account is offered, with every cat OnlyCat has not hidden pre-selected.
     * Hidden chips are the platform's own neighbour-cat mechanism, so a household that has
     * already said "not my cat" is not asked again here.
     */
    private async discover(apiKey: string): Promise<DiscoveredFlap[]> {
      const gateway = new Gateway(apiKey, (...a) => this.log(...a), (...a) => this.error(...a), GATEWAY_URL);
      gateway.connect();

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = this.homey.setTimeout(() => reject(new Error('Timed out connecting to OnlyCat')), 20000);
          gateway.on('ready', () => {
            this.homey.clearTimeout(timer); resolve();
          });
        });

        const devices = await gateway.getDevices(false);
        const paired = this.getDevices().map((device) => device.getData().id);
        const results: DiscoveredFlap[] = [];

        for (const device of devices) {
          if (paired.includes(device.deviceId)) continue;

          let cats: TrackedCat[] = [];
          try {
            const lastSeen = await gateway.getRfidLastSeenByDevice(device.deviceId);
            const codes = offerableCats(lastSeen);
            for (const rfidCode of codes) {
              let name = rfidCode;
              try {
                const profile = await gateway.getRfidProfile(device.deviceId, rfidCode);
                if (profile?.label) name = profile.label;
              } catch {
                // A profile we cannot read is a cat named by its chip, not a failure.
              }
              cats.push({ rfidCode, name });
            }
          } catch (error: any) {
            this.error(`cats for ${device.deviceId}:`, error?.message ?? error);
            cats = [];
          }

          results.push({
            name: device.description || humanHash(device.deviceId),
            data: { id: device.deviceId },
            store: { apiKey, cats },
            settings: {
              device_id: device.deviceId,
              time_zone: device.timeZone ?? '—',
              firmware_channel: device.firmwareChannel ?? '—',
              tracked_cats: cats.map((cat) => cat.name).join(', ') || '—',
            },
          });
        }

        this.log(`pair: offering ${results.length} flap(s)`);
        return results;
      } finally {
        gateway.destroy();
      }
    }

    async onPair(session: PairSession): Promise<void> {
      let apiKey = '';

      session.setHandler('verify_key', async (key: string) => {
        const trimmed = (key ?? '').trim();
        if (!trimmed) throw new Error('Paste your OnlyCat API key first.');

        // Report the ACTUAL failure. "Something went wrong" makes a rejected key and a
        // missing internet connection look identical, and they need opposite responses.
        try {
          const devices = await verifyApiKey(trimmed, (...a) => this.log(...a));
          apiKey = trimmed;
          return { count: devices.length };
        } catch (error: any) {
          if (error instanceof OnlyCatAuthError) {
            throw new Error('OnlyCat rejected that key. Check you copied all of it, and that it has not been revoked.');
          }
          throw new Error(error?.message ?? 'Could not reach OnlyCat.');
        }
      });

      session.setHandler('list_devices', async () => {
        if (!apiKey) throw new Error('No API key yet.');
        return this.discover(apiKey);
      });
    }

    async onRepair(session: PairSession, device: Homey.Device): Promise<void> {
      session.setHandler('verify_key', async (key: string) => {
        const trimmed = (key ?? '').trim();
        if (!trimmed) throw new Error('Paste your OnlyCat API key first.');

        let flaps;
        try {
          flaps = await verifyApiKey(trimmed, (...a) => this.log(...a));
        } catch (error: any) {
          if (error instanceof OnlyCatAuthError) {
            throw new Error('OnlyCat rejected that key. Check you copied all of it, and that it has not been revoked.');
          }
          throw new Error(error?.message ?? 'Could not reach OnlyCat.');
        }

        const deviceId = device.getData().id as string;
        if (!flaps.some((flap) => flap.deviceId === deviceId)) {
          throw new Error('That key works, but this flap is not on its OnlyCat account.');
        }

        // Re-read the cats too: Repair is also how a new cat gets picked up, and asking the
        // owner to re-pair the whole flap for that would be absurd.
        const gateway = new Gateway(trimmed, (...a) => this.log(...a), (...a) => this.error(...a), GATEWAY_URL);
        gateway.connect();
        let cats: TrackedCat[] = (device.getStoreValue('cats') as TrackedCat[]) ?? [];
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = this.homey.setTimeout(() => reject(new Error('Timed out')), 20000);
            gateway.on('ready', () => {
              this.homey.clearTimeout(timer); resolve();
            });
          });
          const lastSeen = await gateway.getRfidLastSeenByDevice(deviceId);
          const codes = offerableCats(lastSeen);
          const refreshed: TrackedCat[] = [];
          for (const rfidCode of codes) {
            const existing = cats.find((cat) => cat.rfidCode === rfidCode);
            let name = existing?.name ?? rfidCode;
            try {
              const profile = await gateway.getRfidProfile(deviceId, rfidCode);
              if (profile?.label) name = profile.label;
            } catch { /* keep the name we have */ }
            refreshed.push({ rfidCode, name });
          }
          if (refreshed.length) cats = refreshed;
        } catch (error: any) {
          this.error('repair: cat refresh failed:', error?.message ?? error);
        } finally {
          gateway.destroy();
        }

        await (device as CatFlapDevice).applyRepair(trimmed, cats);
        return { count: cats.length };
      });
    }

};
