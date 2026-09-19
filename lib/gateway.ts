/**
 * The OnlyCat gateway connection.
 *
 * One socket per API key, shared by every flap on that account — the analogue of
 * `PumpConnection` in `com.nibe.local`, where five devices of one pump share one socket. The key
 * here is account-wide, so a second socket would not just waste a connection, it would subscribe
 * to the same feed twice and double every event.
 *
 * Transport facts, measured against the live gateway rather than assumed:
 *
 *   GET https://gateway.onlycat.com/socket.io/?EIO=4&transport=polling
 *   0{"sid":"…","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000,…}
 *   GET …?EIO=3…  ->  400
 *
 * Engine.IO 4, so socket.io-client 4.x. Ping every 25s with a 20s timeout, which means the
 * library already detects a peer that has gone silent — unlike Modbus, we do not need a
 * watchdog for that. The failure that DOES survive it is different: the socket reconnects but
 * the server-side subscriptions do not. Hence resubscribe on every `connect`.
 */

import { io, Socket } from 'socket.io-client';
import {
  OnlyCatDevice,
  OnlyCatDeviceTransitPolicy,
  OnlyCatEvent,
  OnlyCatEventSummary,
  OnlyCatRfidLastSeen,
  OnlyCatRfidProfile,
} from './onlycat/models';

export const GATEWAY_URL = 'https://gateway.onlycat.com';

/** A bad key does not fail the handshake — the first RPC ack carries this instead. */
export const STATUS_UNAUTHORIZED = 401;

const ACK_TIMEOUT_MS = 20000;
const RECONNECT_DELAY_MS = 5000;

export class OnlyCatAuthError extends Error {}
export class OnlyCatRequestError extends Error {}

type Logger = (...args: any[]) => void;

export interface GatewayEvents {
    /** Fired after every (re)connect, once subscriptions have been re-armed. */
    ready: () => void;
    down: (reason: string) => void;
    unauthorized: () => void;
    deviceUpdate: (deviceId: string) => void;
    deviceEventUpdate: (deviceId: string, eventId: number, accessToken: string | null) => void;
    eventUpdate: (event: OnlyCatEvent) => void;
    eventSummaryUpdate: (summary: OnlyCatEventSummary) => void;
}

type Handler = (...args: any[]) => void;

/**
 * `deviceId`/`eventId` sometimes arrive only inside `body`, and `eventSummaryUpdate` sometimes
 * arrives with no `body` at all. Read the top level, fall back to the body, tolerate neither.
 */
function merge(payload: any): any {
  if (!payload || typeof payload !== 'object') return {};
  const body = payload.body && typeof payload.body === 'object' ? payload.body : {};
  return { ...body, ...Object.fromEntries(Object.entries(payload).filter(([k, v]) => k !== 'body' && v != null)) };
}

export class Gateway {
    private socket: Socket | null = null;
    private readonly listeners = new Map<keyof GatewayEvents, Handler[]>();
    private readonly subscribedDevices = new Set<string>();
    private refCount = 0;
    private authFailed = false;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        readonly apiKey: string,
        private readonly log: Logger = () => {},
        private readonly logError: Logger = () => {},
        private readonly url: string = GATEWAY_URL,
    ) {}

    // -----------------------------------------------------------------------------------------
    // Registry — kept off module scope on purpose.
    //
    // Nibe keeps its connections in a module-level Map. Athom's Homey Cloud guidance is explicit
    // that a cloud app is multi-tenant and must not use globals, and honouring that here costs
    // nothing while keeping the `platforms: ["cloud"]` door open. So the registry hangs off the
    // App instance and is passed in.
    // -----------------------------------------------------------------------------------------

    static registry(host: { _onlycatGateways?: Map<string, Gateway> }): Map<string, Gateway> {
      if (!host._onlycatGateways) host._onlycatGateways = new Map();
      return host._onlycatGateways;
    }

    static attach(
      host: { _onlycatGateways?: Map<string, Gateway> },
      apiKey: string,
      log: Logger,
      logError: Logger,
      url: string = GATEWAY_URL,
    ): Gateway {
      const registry = Gateway.registry(host);
      const key = `${url}#${apiKey}`;
      let gateway = registry.get(key);
      if (!gateway) {
        gateway = new Gateway(apiKey, log, logError, url);
        registry.set(key, gateway);
      }
      gateway.refCount++;
      return gateway;
    }

    detach(host: { _onlycatGateways?: Map<string, Gateway> }): void {
      this.refCount--;
      if (this.refCount > 0) return;
      Gateway.registry(host).delete(`${this.url}#${this.apiKey}`);
      this.destroy();
    }

    // -----------------------------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------------------------

    on<K extends keyof GatewayEvents>(event: K, handler: GatewayEvents[K]): void {
      const existing = this.listeners.get(event) ?? [];
      existing.push(handler as Handler);
      this.listeners.set(event, existing);
    }

    off<K extends keyof GatewayEvents>(event: K, handler: GatewayEvents[K]): void {
      const existing = this.listeners.get(event) ?? [];
      const index = existing.indexOf(handler as Handler);
      if (index >= 0) existing.splice(index, 1);
    }

    private emit<K extends keyof GatewayEvents>(event: K, ...args: Parameters<GatewayEvents[K]>): void {
      for (const handler of this.listeners.get(event) ?? []) {
        // One misbehaving subscriber must not take the socket's event loop with it.
        try {
          handler(...args);
        } catch (error: any) {
          this.logError(`gateway: listener for ${String(event)} threw:`, error?.message ?? error);
        }
      }
    }

    get connected(): boolean {
      return this.socket?.connected === true;
    }

    connect(): void {
      if (this.socket || this.authFailed) return;

      this.log(`gateway: connecting to ${this.url}`);

      this.socket = io(this.url, {
        transports: ['websocket'],
        auth: { token: this.apiKey },
        // How OnlyCat sees which integration is talking to them. Both other clients set
        // these; identifying ourselves honestly costs nothing and is good manners.
        extraHeaders: { platform: 'homey', device: 'com.onlycat.cloud' },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 5000,
        reconnectionDelayMax: 60000,
        randomizationFactor: 0.5,
      });

      this.socket.on('connect', () => {
        this.log('gateway: socket connected');
        void this.resubscribe();
      });

      this.socket.on('disconnect', (reason: string) => {
        this.log(`gateway: disconnected (${reason})`);
        this.emit('down', reason);

        // socket.io does NOT reconnect on its own when the SERVER hangs up — `reconnection`
        // covers transport failures only. That is not a theoretical case here: OnlyCat's own
        // model documents `disconnectReason: "SERVER_INITIATED_DISCONNECT"`, so a deploy on
        // their side would otherwise leave every flap permanently dark, looking merely
        // unavailable, until the app was restarted by hand. Found by the reconnect test.
        if (reason === 'io server disconnect' && !this.authFailed) this.scheduleReconnect();
      });

      this.socket.on('connect_error', (error: Error) => {
        this.logError('gateway: connect error:', error?.message ?? error);
        this.emit('down', 'connect_error');
      });

      // Treat userUpdate as "re-subscribe everything". It arrives shortly after connect, and
      // the reference implementation binds resubscription to both signals for a reason.
      this.socket.on('userUpdate', () => {
        void this.resubscribe();
      });

      this.socket.on('deviceUpdate', (payload: any) => {
        const data = merge(payload);
        if (data.deviceId) this.emit('deviceUpdate', String(data.deviceId));
      });

      this.socket.on('deviceEventUpdate', (payload: any) => {
        const data = merge(payload);
        if (!data.deviceId || data.eventId == null) return;
        this.emit('deviceEventUpdate', String(data.deviceId), Number(data.eventId), data.accessToken ?? null);
      });

      this.socket.on('eventUpdate', (payload: any) => {
        const data = merge(payload);
        if (!data.deviceId || data.eventId == null) return;
        this.emit('eventUpdate', data as OnlyCatEvent);
      });

      this.socket.on('eventSummaryUpdate', (payload: any) => {
        // Documented to sometimes arrive with no body. Dropping it is correct; throwing is not.
        const body = payload?.body;
        if (!body || typeof body !== 'object') return;
        if (!body.deviceId && payload?.deviceId) body.deviceId = payload.deviceId;
        if (body.eventId == null && payload?.eventId != null) body.eventId = payload.eventId;
        if (!body.deviceId || body.eventId == null) return;
        this.emit('eventSummaryUpdate', body as OnlyCatEventSummary);
      });
    }

    private scheduleReconnect(): void {
      if (this.retryTimer || this.authFailed) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.authFailed || !this.socket) return;
        this.log('gateway: reconnecting after a server-initiated disconnect');
        this.socket.connect();
      }, RECONNECT_DELAY_MS);
    }

    destroy(): void {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      if (!this.socket) return;
      this.log('gateway: destroying socket');
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
      this.subscribedDevices.clear();
    }

    // -----------------------------------------------------------------------------------------
    // Requests
    // -----------------------------------------------------------------------------------------

    /**
     * One RPC. Every call gets an explicit timeout: `getDeviceTransitPolicies`,
     * `getDeviceTransitPolicy`, `getDeviceRebootLogs` and `getDeviceTelemetryMetrics` are all
     * known to hang, and a hung ack must degrade one value rather than wedge the device.
     */
    async send<T = any>(event: string, payload: Record<string, any> = {}): Promise<T> {
      const { socket } = this;
      if (!socket) throw new OnlyCatRequestError(`${event}: not connected`);

      let reply: any;
      try {
        reply = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, payload);
      } catch (error: any) {
        throw new OnlyCatRequestError(`${event}: ${error?.message ?? 'no response'}`);
      }

      if (reply && typeof reply === 'object' && !Array.isArray(reply) && 'code' in reply) {
        const code = Number((reply as any).code);
        if (code === STATUS_UNAUTHORIZED) {
          this.authFailed = true;
          this.emit('unauthorized');
          // Retrying a revoked key forever is pointless and rude to someone else's server.
          this.socket?.disconnect();
          throw new OnlyCatAuthError('The OnlyCat API key was rejected');
        }
        if (code && code !== 200) {
          throw new OnlyCatRequestError(`${event}: ${(reply as any).message ?? `code ${code}`}`);
        }
      }

      return reply as T;
    }

    /** Devices to re-arm on every connect. */
    trackDevice(deviceId: string): void {
      this.subscribedDevices.add(deviceId);
    }

    untrackDevice(deviceId: string): void {
      this.subscribedDevices.delete(deviceId);
    }

    /**
     * Re-arm every subscription, then probe.
     *
     * `subscribe: true` on a getter is the only subscription mechanism this API has — there is no
     * separate subscribe verb — and none of it survives a reconnect. The probe at the end is the
     * translation of Nibe's watchdog: a socket that is up but subscribed to nothing looks
     * identical to a healthy one, and would leave devices showing frozen values indefinitely.
     */
    private async resubscribe(): Promise<void> {
      try {
        await this.send('getDevices', { subscribe: true });
        for (const deviceId of this.subscribedDevices) {
          await this.send('getDevice', { deviceId, subscribe: true });
          await this.send('getDeviceEvents', { deviceId, subscribe: true });
        }
        this.log(`gateway: subscriptions armed for ${this.subscribedDevices.size} device(s)`);
        this.emit('ready');
      } catch (error: any) {
        if (error instanceof OnlyCatAuthError) return;
        this.logError('gateway: resubscribe failed:', error?.message ?? error);
        this.emit('down', 'resubscribe_failed');
      }
    }

    // -----------------------------------------------------------------------------------------
    // Typed calls
    // -----------------------------------------------------------------------------------------

    async getDevices(subscribe = false): Promise<OnlyCatDevice[]> {
      const reply = await this.send<OnlyCatDevice[]>('getDevices', { subscribe });
      return Array.isArray(reply) ? reply : [];
    }

    getDevice(deviceId: string, subscribe = true): Promise<OnlyCatDevice> {
      return this.send<OnlyCatDevice>('getDevice', { deviceId, subscribe });
    }

    getEvent(deviceId: string, eventId: number, subscribe = true): Promise<OnlyCatEvent> {
      return this.send<OnlyCatEvent>('getEvent', { deviceId, eventId, subscribe });
    }

    getEventSummary(
      deviceId: string, eventId: number, accessToken: string, subscribe = true,
    ): Promise<OnlyCatEventSummary | null> {
      return this.send<OnlyCatEventSummary | null>('getEventSummary', {
        deviceId, eventId, accessToken, subscribe,
      });
    }

    async getDeviceEvents(deviceId: string, subscribe = true): Promise<OnlyCatEvent[]> {
      const reply = await this.send<OnlyCatEvent[]>('getDeviceEvents', { deviceId, subscribe });
      return Array.isArray(reply) ? reply : [];
    }

    async getDeviceTransitPolicies(deviceId: string): Promise<OnlyCatDeviceTransitPolicy[]> {
      const reply = await this.send<OnlyCatDeviceTransitPolicy[]>('getDeviceTransitPolicies', { deviceId });
      return Array.isArray(reply) ? reply : [];
    }

    getDeviceTransitPolicy(deviceTransitPolicyId: number): Promise<OnlyCatDeviceTransitPolicy> {
      return this.send<OnlyCatDeviceTransitPolicy>('getDeviceTransitPolicy', { deviceTransitPolicyId });
    }

    activateDeviceTransitPolicy(deviceId: string, deviceTransitPolicyId: number): Promise<any> {
      return this.send('activateDeviceTransitPolicy', { deviceId, deviceTransitPolicyId });
    }

    runDeviceCommand(deviceId: string, command: 'unlock' | 'reboot'): Promise<any> {
      return this.send('runDeviceCommand', { deviceId, command });
    }

    async getRfidLastSeenByDevice(deviceId: string): Promise<OnlyCatRfidLastSeen[]> {
      const reply = await this.send<OnlyCatRfidLastSeen[]>('getRfidLastSeenByDevice', { deviceId });
      return Array.isArray(reply) ? reply : [];
    }

    getRfidProfile(deviceId: string, rfidCode: string): Promise<OnlyCatRfidProfile | null> {
      return this.send<OnlyCatRfidProfile | null>('getRfidProfile', { deviceId, rfidCode });
    }
}

/**
 * Open a throwaway connection, prove the key works, close it. Used by the pairing view, where
 * the only question is "is this key good", and where reporting the ACTUAL failure — a rejected
 * key versus no route to the internet — is the difference between a fixable error and a shrug.
 */
export async function verifyApiKey(
  apiKey: string, log: Logger = () => {}, url: string = GATEWAY_URL,
): Promise<OnlyCatDevice[]> {
  const gateway = new Gateway(apiKey, log, log, url);
  gateway.connect();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new OnlyCatRequestError('Timed out connecting to OnlyCat')), 20000);
      const done = () => {
        clearTimeout(timer); resolve();
      };
      const fail = (reason: string) => {
        if (reason === 'connect_error') {
          clearTimeout(timer);
          reject(new OnlyCatRequestError('Could not reach OnlyCat'));
        }
      };
      gateway.on('ready', done);
      gateway.on('down', fail);
      // The 401 arrives on the first RPC and is swallowed by resubscribe(), so without
      // this the pairing view would sit on a spinner for the full timeout and then blame
      // the network for a rejected key.
      gateway.on('unauthorized', () => {
        clearTimeout(timer);
        reject(new OnlyCatAuthError('The OnlyCat API key was rejected'));
      });
    });
    return await gateway.getDevices(false);
  } finally {
    gateway.destroy();
  }
}
