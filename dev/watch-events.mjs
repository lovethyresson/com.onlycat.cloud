#!/usr/bin/env node
/**
 * Live tail of a flap, decoded into English.
 *
 * Run it, then send a cat through the flap. This is how the subevent vocabulary gets checked
 * against a real animal actually walking through a real door — which is the only way to check it.
 *
 *   node dev/watch-events.mjs oc_live_... [OC-DEVICEID]
 */

import { io } from 'socket.io-client';

const [KEY, ONLY_DEVICE] = process.argv.slice(2);
if (!KEY) {
    console.error('usage: node dev/watch-events.mjs <api-key> [deviceId]');
    process.exit(1);
}

const PHRASE = {
    'TRANSIT|INWARD': 'came in',
    'TRANSIT|OUTWARD': 'went out',
    'BREACH|INWARD': 'FORCED the flap coming in',
    'BREACH|OUTWARD': 'FORCED the flap going out',
    'PEEK|INWARD': 'looked in but stayed out',
    'PEEK|OUTWARD': 'looked out but stayed in',
    'DENY|INWARD': 'was TURNED AWAY coming in',
    'DENY|OUTWARD': 'was TURNED AWAY going out',
};

const CLASSIFICATION = {
    0: 'unknown', 1: 'clear', 2: 'suspicious', 3: 'CONTRABAND', 4: 'human activity', 10: 'remote unlock',
};
const TRIGGER = { 0: 'manual', 1: 'remote', 2: 'indoor motion', 3: 'outdoor motion' };

const socket = io('https://gateway.onlycat.com', {
    transports: ['websocket'],
    auth: { token: KEY },
    extraHeaders: { platform: 'homey', device: 'com.onlycat.cloud-probe' },
});

const call = (event, payload = {}) => socket.timeout(20000).emitWithAck(event, payload);
const names = new Map();
const stamp = () => new Date().toLocaleTimeString();

socket.on('connect', async () => {
    const devices = await call('getDevices', { subscribe: true });
    if (devices?.code === 401) { console.error('Key rejected.'); process.exit(2); }

    const watched = devices.filter(d => !ONLY_DEVICE || d.deviceId === ONLY_DEVICE);
    for (const device of watched) {
        await call('getDevice', { deviceId: device.deviceId, subscribe: true });
        await call('getDeviceEvents', { deviceId: device.deviceId, subscribe: true });

        const lastSeen = await call('getRfidLastSeenByDevice', { deviceId: device.deviceId });
        for (const entry of lastSeen ?? []) {
            try {
                const profile = await call('getRfidProfile',
                    { deviceId: device.deviceId, rfidCode: entry.rfidCode });
                if (profile?.label) names.set(entry.rfidCode, profile.label);
            } catch { /* keep the chip code */ }
        }
        console.log(`watching ${device.description || device.deviceId}`);
    }
    console.log('\nSend a cat through the flap. Ctrl-C to stop.\n');
});

const name = code => (code ? (names.get(code) ?? `unknown cat ${code}`) : 'something');

socket.on('deviceEventUpdate', async payload => {
    const data = { ...(payload.body ?? {}), ...payload };
    console.log(`${stamp()}  event ${data.eventId} started`);
    try {
        const event = await call('getEvent', { deviceId: data.deviceId, eventId: data.eventId, subscribe: true });
        const token = data.accessToken ?? event?.accessToken;
        if (token)
            await call('getEventSummary',
                { deviceId: data.deviceId, eventId: data.eventId, accessToken: token, subscribe: true });
    } catch (error) {
        console.log(`   could not hydrate: ${error.message}`);
    }
});

socket.on('eventUpdate', payload => {
    const event = { ...(payload.body ?? {}), ...payload };
    const done = event.frameCount != null;
    console.log(`${stamp()}  event ${event.eventId} ${done ? `concluded, ${event.frameCount} frames` : 'in progress'}`
        + ` · ${CLASSIFICATION[event.eventClassification] ?? '?'} · triggered by ${TRIGGER[event.eventTriggerSource] ?? '?'}`);
});

socket.on('eventSummaryUpdate', payload => {
    const body = payload?.body;
    if (!body) return;
    const final = body.processedFrameCount != null ? `${body.processedFrameCount} frames processed` : 'provisional';
    console.log(`${stamp()}  summary for ${body.eventId} (${final}):`);
    for (const sub of body.subevents ?? [])
        console.log(`      ${name(sub.rfidCode)} ${PHRASE[`${sub.action}|${sub.direction}`] ?? `${sub.action}/${sub.direction}`}`);
});

socket.on('connect_error', error => console.error(`connect error: ${error.message}`));
