import Homey from 'homey';
import PairSession from 'homey/lib/PairSession';
import { CatChoice, TrackedCat, offerableCats } from '../../lib/cats';
import { ActionFilter } from '../../lib/events';
import {
  Gateway, GATEWAY_URL, OnlyCatAuthError, verifyApiKey,
} from '../../lib/gateway';
import { Logger, redactKey } from '../../lib/log';
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
    applyRepair(apiKey: string): Promise<void>;
    catList(): Promise<CatChoice[]>;
    applyCatSelection(choices: CatChoice[]): Promise<void>;
};

interface DiscoveredFlap {
    name: string;
    data: { id: string };
    store: { apiKey: string; cats: TrackedCat[]; excludedCats?: TrackedCat[] };
    settings: Record<string, string>;
}

/** What the shared cat view is handed: which flow it is in, and the cats per flap. */
interface CatContext {
    mode: 'pair' | 'repair';
    flaps: { id: string; name: string; cats: CatChoice[] }[];
    /** Why the list could not be read. The view still opens, so the key button stays reachable. */
    error?: string;
}

/** What the cat view sends back: each flap's full list, with `included` set by the owner. */
type CatSelection = Record<string, CatChoice[]>;

module.exports = class CatFlapDriver extends Homey.Driver {

  /**
   * Pairing logs at info unconditionally. It runs once, interactively, and it is exactly the
   * moment when there is no device yet on which to tick a debug box — which is how an
   * unexplained "No API key yet" reached a user with nothing in any log to explain it.
   */
  readonly logger = new Logger(
    { log: (...a: any[]) => this.log(...a), error: (...a: any[]) => this.error(...a) },
    'cat_flap',
  );

  async onInit(): Promise<void> {
    this.registerFlowCards();
    this.logger.info('driver ready');
  }

  // ------------------------------------------------------------------------------------------
  // Flow
  // ------------------------------------------------------------------------------------------

  private anyCat(): { name: string; rfid: string } {
    // `__()` is typed `string | undefined`; fall back to something legible rather than blank.
    return { name: this.homey.__('flow.any_cat') ?? 'Any cat', rfid: '' };
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
        .registerRunListener(async (args: any) => {
          const locked = args.device.getCapabilityValue('locked');
          if (locked === null || locked === undefined) {
          // Unknown is not false. Silently taking the "unlocked" branch would be a wrong answer
          // dressed as a confident one; stopping the Flow with a reason is the honest failure.
            throw new Error(this.homey.__('error.lock_unknown') ?? 'error.lock_unknown');
          }
          return locked === true;
        });

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
        if (!Number.isFinite(id)) throw new Error(this.homey.__('error.unknown_policy') ?? 'error.unknown_policy');
        await (args.device as CatFlapDevice).activatePolicy(id);
      });
      setPolicy.registerArgumentAutocompleteListener('policy', this.policyAutocomplete);

      const setLocation = this.homey.flow.getActionCard('set_cat_location');
      setLocation.registerRunListener(async (args: any) => {
        const rfid = args?.cat?.rfid;
        if (!rfid) throw new Error(this.homey.__('error.unknown_cat') ?? 'error.unknown_cat');
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
    private async discover(apiKey: string, keyName = ''): Promise<DiscoveredFlap[]> {
      const gateway = new Gateway(
        apiKey,
        (...a) => this.logger.debug('discover:', ...a),
        (...a) => this.logger.error('discover:', ...a),
        GATEWAY_URL,
      );
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
            this.logger.error(`cats for ${device.deviceId}:`, error?.message ?? error);
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
              key_name: keyName || '—',
            },
          });
        }

        return results;
      } finally {
        gateway.destroy();
      }
    }

    /**
     * The key accepted during the current pairing session, and the name the owner gave it.
     *
     * On the DRIVER, not in an `onPair` closure. v0.1.0 kept it in the closure and pairing died
     * with "No API key yet" at the device list: the handler that sets it and the handler that
     * reads it run from different views, so the state has to outlive any one closure. A driver is
     * a singleton and only one person pairs at a time, which makes this the right lifetime. It is
     * cleared on disconnect, so a key never outlives the session that supplied it.
     */
    private pendingApiKey = '';

    private pendingKeyName = '';

    /** The account as read for this pairing session, so the cat view and the device list agree. */
    private pendingFlaps: DiscoveredFlap[] | null = null;

    private pendingSelection: CatSelection = {};

    private async pendingDiscovery(): Promise<DiscoveredFlap[]> {
      if (!this.pendingApiKey) {
        this.logger.error('pair: discovery ran with no verified key — login never completed');
        throw new Error('The API key did not carry over. Go back and enter it again.');
      }
      this.pendingFlaps ??= await this.discover(this.pendingApiKey, this.pendingKeyName);
      return this.pendingFlaps;
    }

    async onPair(session: PairSession): Promise<void> {
      this.resetPairing();
      this.logger.info('pair: session started');

      session.setHandler('disconnect', async () => {
        this.logger.info('pair: session ended');
        this.resetPairing();
      });

      /*
       * `login` is Homey's own handler for the login_credentials template.
       *
       * Using the native view rather than a hand-rolled one is what makes this reliable: Homey
       * wires its Login button straight to this handler, so there is no way for the user to
       * navigate past it. A custom view here shipped two bugs in a row — one where nothing called
       * the script, and one where declaring `navigation.next` made Homey draw its own Next button
       * that jumped to the device list without ever running verification.
       */
      session.setHandler('login', async ({ username, password }: { username: string; password: string }) => {
        const key = (password ?? '').trim();
        const name = (username ?? '').trim();
        this.logger.info(`pair: login attempt, key name "${name || '(unnamed)'}", ${redactKey(key)}`);

        if (!key) throw new Error('Paste your OnlyCat API key into the API key field.');

        // Report the ACTUAL failure. "Something went wrong" makes a rejected key and a missing
        // internet connection look identical, and they need opposite responses.
        try {
          const devices = await verifyApiKey(key, (...a) => this.logger.debug('verify:', ...a));
          if (!devices.length) {
            this.logger.info('pair: key is valid but the account has no flaps');
            throw new Error('That key works, but there are no cat flaps on the account.');
          }
          this.pendingApiKey = key;
          this.pendingKeyName = name;
          this.pendingFlaps = null;
          this.logger.info(`pair: key accepted, ${devices.length} flap(s) on the account`);
          return true;
        } catch (error: any) {
          if (error instanceof OnlyCatAuthError) {
            this.logger.info('pair: key REJECTED by OnlyCat');
            throw new Error('OnlyCat rejected that key. Check you copied all of it, and that it has not been revoked.');
          }
          this.logger.error('pair: login failed:', error?.message ?? error);
          throw error;
        }
      });

      // Between the key and the device list: which cats each flap should track. Every cat starts
      // ticked, the way pairing has always worked; unticking one here costs nothing, since no
      // capability exists yet.
      session.setHandler('cat_context', async (): Promise<CatContext> => {
        const flaps = await this.pendingDiscovery();
        return {
          mode: 'pair',
          flaps: flaps.map((flap) => ({
            id: flap.data.id,
            name: flap.name,
            cats: flap.store.cats.map((cat) => ({ ...cat, included: true })),
          })),
        };
      });

      session.setHandler('cats_selected', async (selection: CatSelection) => {
        this.pendingSelection = selection ?? {};
        this.logger.info(`pair: cats chosen for ${Object.keys(this.pendingSelection).length} flap(s)`);
      });

      session.setHandler('list_devices', async () => {
        this.logger.info(`pair: list_devices called, holding ${redactKey(this.pendingApiKey)}`);
        try {
          const found = (await this.pendingDiscovery()).map((flap) => this.withSelection(flap));
          this.logger.info(`pair: offering ${found.length} flap(s)${
            found.length ? `: ${found.map((f) => f.data.id).join(', ')}` : ''}`);
          return found;
        } catch (error: any) {
          this.logger.error('pair: discovery failed:', error?.message ?? error);
          throw error;
        }
      });
    }

    private resetPairing(): void {
      this.pendingApiKey = '';
      this.pendingKeyName = '';
      this.pendingFlaps = null;
      this.pendingSelection = {};
    }

    /**
     * A discovered flap with the owner's cat choice applied. The cats left out are stored as
     * switched off, so the device's own sync does not add them back on its first connect.
     */
    private withSelection(flap: DiscoveredFlap): DiscoveredFlap {
      const chosen = this.pendingSelection[flap.data.id];
      if (!chosen) return flap;
      const pick = (included: boolean) => chosen
        .filter((cat) => cat.included === included)
        .map(({ rfidCode, name }) => ({ rfidCode, name }));
      const cats = pick(true);
      return {
        ...flap,
        store: { ...flap.store, cats, excludedCats: pick(false) },
        settings: { ...flap.settings, tracked_cats: cats.map((cat) => cat.name).join(', ') || '—' },
      };
    }

    async onRepair(session: PairSession, device: Homey.Device): Promise<void> {
      const deviceId = device.getData().id as string;
      this.logger.info(`repair: session started for ${deviceId}`);

      session.setHandler('disconnect', async () => {
        this.logger.info('repair: session ended');
      });

      // Repair opens on the cat list. Changing the key is a button on it, because the key screen
      // cannot be pre-filled and putting it first would mean re-pasting the key every time.
      // A rejected key is the commonest reason to open Repair, and it is exactly when the cat list
      // cannot be read. Throwing here would leave the view with an alert and no way to the key
      // screen, so the failure travels as data instead.
      session.setHandler('cat_context', async (): Promise<CatContext> => {
        const flap = { id: deviceId, name: device.getName() ?? '', cats: [] as CatChoice[] };
        try {
          flap.cats = await (device as CatFlapDevice).catList();
          return { mode: 'repair', flaps: [flap] };
        } catch (error: any) {
          this.logger.error('repair: cat list unavailable:', error?.message ?? error);
          return { mode: 'repair', flaps: [flap], error: error?.message ?? String(error) };
        }
      });

      session.setHandler('cats_selected', async (selection: CatSelection) => {
        const chosen = selection?.[deviceId];
        if (!chosen) throw new Error('No cat selection arrived for this flap.');
        await (device as CatFlapDevice).applyCatSelection(chosen);
      });

      session.setHandler('login', async ({ username, password }: { username: string; password: string }) => {
        const key = (password ?? '').trim();
        const name = (username ?? '').trim();
        this.logger.info(`repair: login attempt, key name "${name || '(unnamed)'}", ${redactKey(key)}`);

        if (!key) throw new Error('Paste your OnlyCat API key into the API key field.');

        let flaps;
        try {
          flaps = await verifyApiKey(key, (...a) => this.logger.debug('verify:', ...a));
        } catch (error: any) {
          if (error instanceof OnlyCatAuthError) {
            this.logger.info('repair: key REJECTED by OnlyCat');
            throw new Error('OnlyCat rejected that key. Check you copied all of it, and that it has not been revoked.');
          }
          this.logger.error('repair: could not reach OnlyCat:', error?.message ?? error);
          throw error;
        }

        if (!flaps.some((flap) => flap.deviceId === deviceId)) {
          this.logger.info(`repair: key is valid but does not cover ${deviceId}`);
          throw new Error('That key works, but this flap is not on its OnlyCat account.');
        }

        await device.setSettings({ key_name: name || '—' }).catch(() => {});
        await (device as CatFlapDevice).applyRepair(key);
        this.logger.info('repair: applied');
        return true;
      });
    }

};
