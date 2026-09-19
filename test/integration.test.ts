/**
 * The real `Gateway` against a real Socket.IO server on loopback.
 *
 * Nothing is mocked: this exercises socket.io-client, our handshake, our ack handling and our
 * resubscription logic. It is the analogue of Nibe's in-process fake pump, and it is here
 * because the failures that matter in a cloud app — a rejected key, a reconnect that loses its
 * subscriptions, a push with a missing body — are not reachable from unit tests.
 */

import assert from 'node:assert/strict';
import {
  after, before, beforeEach, describe, it,
} from 'node:test';
import {
  Gateway, OnlyCatAuthError, OnlyCatRequestError, verifyApiKey,
} from '../lib/gateway';
import { FakeGateway } from './fake-gateway';

const DEVICE = 'OC-8C1F6448ABCD';

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('Gateway against a live socket', () => {
  let fake: FakeGateway;
  let url: string;
  let gateway: Gateway | null = null;

  before(async () => {
    fake = new FakeGateway({ validKeys: ['oc_live_good'] });
    url = await fake.listen();
  });

  after(async () => {
    gateway?.destroy();
    await fake.close();
  });

  beforeEach(() => {
    gateway?.destroy();
    gateway = null;
    fake.calls.length = 0;
    fake.swallowNextAcks = 0;
    fake.devices = [{
      deviceId: DEVICE,
      description: 'Back door',
      timeZone: 'Europe/Stockholm',
      firmwareChannel: 'stable',
      deviceTransitPolicyId: 5,
      connectivity: { connected: true },
    }];
    fake.policies = [{
      deviceTransitPolicyId: 5,
      deviceId: DEVICE,
      name: 'Night',
      transitPolicy: { idleLock: true, rules: [] },
    }];
  });

  const connect = async (key = 'oc_live_good') => {
    const created = new Gateway(key, () => {}, () => {}, url);
    gateway = created;
    let ready = false;
    created.on('ready', () => {
      ready = true;
    });
    created.connect();
    await waitFor(() => ready);
    return created;
  };

  it('connects, subscribes and reports its devices', async () => {
    const g = await connect();
    const devices = await g.getDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].deviceId, DEVICE);
    assert.deepEqual(fake.callsFor('getDevices')[0], { subscribe: true });
  });

  it('rejects a bad key on the first RPC, not on the handshake', async () => {
    // The trap: a wrong key still completes the Socket.IO handshake. Anything that treats
    // "connected" as "authenticated" reports success and then silently receives nothing.
    const g = new Gateway('oc_live_wrong', () => {}, () => {}, url);
    gateway = g;
    let unauthorized = false;
    g.on('unauthorized', () => {
      unauthorized = true;
    });
    g.connect();

    await assert.rejects(
      () => waitFor(() => unauthorized, 3000).then(() => g.getDevices()),
      () => true,
    );
    assert.equal(unauthorized, true, 'never reported unauthorized');
  });

  it('surfaces a rejected key as an auth error from verifyApiKey', async () => {
    await assert.rejects(() => verifyApiKey('oc_live_wrong', () => {}, url), OnlyCatAuthError);
  });

  it('accepts a good key from verifyApiKey and returns the flaps', async () => {
    const devices = await verifyApiKey('oc_live_good', () => {}, url);
    assert.equal(devices.length, 1);
  });

  it('re-arms every subscription after a reconnect', async () => {
    // The failure this app's watchdog exists for: the socket comes back but the server-side
    // subscriptions do not, so the device looks healthy and receives nothing, indefinitely.
    const g = await connect();
    g.trackDevice(DEVICE);

    let readyAgain = 0;
    g.on('ready', () => {
      readyAgain++;
    });

    fake.calls.length = 0;
    fake.dropClients();

    await waitFor(() => readyAgain > 0, 15000);

    assert.ok(fake.callsFor('getDevices').length > 0, 'did not re-list devices');
    assert.deepEqual(fake.callsFor('getDevice')[0], { deviceId: DEVICE, subscribe: true });
    assert.deepEqual(fake.callsFor('getDeviceEvents')[0], { deviceId: DEVICE, subscribe: true });
  });

  it('times out a hung ack instead of wedging', async () => {
    const g = await connect();
    fake.swallowNextAcks = 1;
    // Documented to happen on getDeviceTransitPolicies and friends. A hung call must degrade
    // one value, not the device.
    await assert.rejects(() => g.send('getDevices', {}), OnlyCatRequestError);
  });

  it('delivers a deviceEventUpdate carrying its token inside body', async () => {
    const g = await connect();
    const seen: any[] = [];
    g.on('deviceEventUpdate', (deviceId, eventId, token) => seen.push({ deviceId, eventId, token }));

    fake.push('deviceEventUpdate', { deviceId: DEVICE, eventId: 42, body: { accessToken: 'tok' } });
    await waitFor(() => seen.length > 0);

    assert.deepEqual(seen[0], { deviceId: DEVICE, eventId: 42, token: 'tok' });
  });

  it('reads ids out of body when the top level omits them', async () => {
    const g = await connect();
    const seen: any[] = [];
    g.on('eventUpdate', (event) => seen.push(event));

    fake.push('eventUpdate', { body: { deviceId: DEVICE, eventId: 7, frameCount: 100 } });
    await waitFor(() => seen.length > 0);

    assert.equal(seen[0].deviceId, DEVICE);
    assert.equal(seen[0].frameCount, 100);
  });

  it('drops a summary push with no body rather than throwing', async () => {
    const g = await connect();
    const seen: any[] = [];
    g.on('eventSummaryUpdate', (summary) => seen.push(summary));

    fake.push('eventSummaryUpdate', { deviceId: DEVICE, eventId: 7 });
    fake.push('eventSummaryUpdate', {
      deviceId: DEVICE,
      eventId: 7,
      body: {
        deviceId: DEVICE, eventId: 7, processedFrameCount: 100, subevents: [],
      },
    });
    await waitFor(() => seen.length > 0);

    assert.equal(seen.length, 1, 'the body-less push should have been dropped');
    assert.equal(seen[0].processedFrameCount, 100);
  });

  it('shares one socket per API key and closes it on the last detach', async () => {
    // An account-wide key means a second socket would subscribe to the same feed twice and
    // double every event, not merely waste a connection.
    const host: any = {};
    const a = Gateway.attach(host, 'oc_live_good', () => {}, () => {}, url);
    const b = Gateway.attach(host, 'oc_live_good', () => {}, () => {}, url);
    assert.equal(a, b, 'two gateways for one key');

    const c = Gateway.attach(host, 'oc_live_other', () => {}, () => {}, url);
    assert.notEqual(a, c, 'different keys shared a gateway');

    a.detach(host);
    assert.equal(Gateway.registry(host).size, 2, 'released while still referenced');
    b.detach(host);
    assert.equal(Gateway.registry(host).has(`${url}#oc_live_good`), false, 'not released on last detach');
    c.detach(host);
  });

  it('reads policies and activates one', async () => {
    const g = await connect();
    const policies = await g.getDeviceTransitPolicies(DEVICE);
    assert.equal(policies.length, 1);

    const full = await g.getDeviceTransitPolicy(5);
    assert.equal(full.transitPolicy?.idleLock, true);

    await g.activateDeviceTransitPolicy(DEVICE, 5);
    assert.deepEqual(fake.callsFor('activateDeviceTransitPolicy')[0],
      { deviceId: DEVICE, deviceTransitPolicyId: 5 });
  });

  it('sends the documented shape for a device command', async () => {
    const g = await connect();
    await g.runDeviceCommand(DEVICE, 'unlock');
    assert.deepEqual(fake.callsFor('runDeviceCommand')[0], { deviceId: DEVICE, command: 'unlock' });
  });

  it('refuses to send when there is no socket', async () => {
    const g = new Gateway('oc_live_good', () => {}, () => {}, url);
    gateway = g;
    await assert.rejects(() => g.send('getDevices'), OnlyCatRequestError);
  });
});
