/**
 * An in-process OnlyCat gateway.
 *
 * The direct analogue of `com.nibe.local`'s in-process fake pump, and for the same reason: it
 * lets the real `Gateway` be driven end to end — handshake, auth rejection, resubscription after
 * a reconnect, out-of-order pushes — without an API key, a network, or somebody's cat.
 *
 * It speaks real Socket.IO on a real loopback port, so what is under test is the actual client
 * library and our actual code, not a mock of either.
 */

import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server, Socket } from 'socket.io';

export interface FakeGatewayOptions {
    /** Keys the gateway accepts. Anything else gets `{code: 401}` on the first RPC. */
    validKeys?: string[];
}

export class FakeGateway {
    private http: HttpServer;
    private io: Server;
    private sockets = new Set<Socket>();

    /** Every RPC received, in order. The assertion surface for subscription behaviour. */
    readonly calls: { event: string; payload: any }[] = [];

    devices: any[] = [];
    policies: any[] = [];
    events = new Map<number, any>();
    summaries = new Map<number, any>();
    lastSeen: any[] = [];
    profiles = new Map<string, any>();

    /** Set to make the next N acks never arrive, for exercising the RPC timeout. */
    swallowNextAcks = 0;

    private validKeys: string[];

    constructor(options: FakeGatewayOptions = {}) {
      this.validKeys = options.validKeys ?? ['oc_live_test'];
      this.http = createServer();
      this.io = new Server(this.http, { transports: ['websocket'] });

      this.io.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.on('disconnect', () => this.sockets.delete(socket));

        const authorized = this.validKeys.includes((socket.handshake.auth as any)?.token);

        socket.onAny((event: string, ...args: any[]) => {
          const ack = args[args.length - 1];
          const payload = typeof args[0] === 'function' ? {} : args[0];
          if (typeof ack !== 'function') return;

          this.calls.push({ event, payload });

          if (this.swallowNextAcks > 0) {
            this.swallowNextAcks--;
            return;
          }

          // A bad key does NOT fail the handshake — the first RPC ack carries the 401.
          if (!authorized) {
            ack({ code: 401, message: 'Unauthorized' });
            return;
          }

          ack(this.handle(event, payload ?? {}));
        });

        if (authorized) setTimeout(() => socket.emit('userUpdate', { id: 1 }), 5);
      });
    }

    private handle(event: string, payload: any): any {
      switch (event) {
        case 'getDevices':
          return this.devices;
        case 'getDevice':
          return this.devices.find((d) => d.deviceId === payload.deviceId) ?? null;
        case 'getDeviceEvents':
          return [...this.events.values()].filter((e) => e.deviceId === payload.deviceId);
        case 'getEvent':
          return this.events.get(payload.eventId) ?? null;
        case 'getEventSummary':
          return this.summaries.get(payload.eventId) ?? null;
        case 'getDeviceTransitPolicies':
          return this.policies.map((p) => ({
            deviceTransitPolicyId: p.deviceTransitPolicyId, deviceId: p.deviceId, name: p.name,
          }));
        case 'getDeviceTransitPolicy':
          return this.policies.find((p) => p.deviceTransitPolicyId === payload.deviceTransitPolicyId) ?? null;
        case 'getRfidLastSeenByDevice':
          return this.lastSeen;
        case 'getRfidProfile':
          return this.profiles.get(payload.rfidCode) ?? null;
        case 'activateDeviceTransitPolicy': {
          const device = this.devices.find((d) => d.deviceId === payload.deviceId);
          if (device) device.deviceTransitPolicyId = payload.deviceTransitPolicyId;
          return { ok: true };
        }
        case 'runDeviceCommand':
          return { ok: true };
        default:
          return { code: 400, message: `Unknown event ${event}` };
      }
    }

    async listen(): Promise<string> {
      await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve));
      const { port } = this.http.address() as AddressInfo;
      return `http://127.0.0.1:${port}`;
    }

    /** Push to every connected client, the way the real gateway does. */
    push(event: string, payload: any): void {
      for (const socket of this.sockets) socket.emit(event, payload);
    }

    /** Drop every client without shutting the server down, to exercise reconnection. */
    dropClients(): void {
      for (const socket of this.sockets) socket.disconnect(true);
    }

    callsFor(event: string): any[] {
      return this.calls.filter((call) => call.event === event).map((call) => call.payload);
    }

    async close(): Promise<void> {
      await this.io.close();
      await new Promise<void>((resolve) => this.http.close(() => resolve()));
    }
}
