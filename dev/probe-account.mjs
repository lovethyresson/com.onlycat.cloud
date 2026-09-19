#!/usr/bin/env node
/**
 * Read an OnlyCat account and describe it in plain language.
 *
 * Run this BEFORE pairing. It answers "is my key good, and what will Homey find?" without
 * touching Homey at all, so a pairing failure can be attributed to the right layer.
 *
 * The rule this exists for, from com.nibe.local's lessons: the hardware is the owner's to probe.
 * Nobody but you should ever hold this key.
 *
 *   node dev/probe-account.mjs oc_live_...
 *
 * A probe that prints a wall of JSON costs several round-trips; one that interprets itself costs
 * one. So this says "three policies, Night is active, idleLock is on" rather than dumping objects.
 */

import { io } from 'socket.io-client';

const KEY = process.argv[2];
if (!KEY) {
    console.error('usage: node dev/probe-account.mjs <api-key>');
    process.exit(1);
}

const URL = 'https://gateway.onlycat.com';
const socket = io(URL, {
    transports: ['websocket'],
    auth: { token: KEY },
    extraHeaders: { platform: 'homey', device: 'com.onlycat.cloud-probe' },
    reconnection: false,
});

const call = (event, payload = {}) => socket.timeout(20000).emitWithAck(event, payload);

function check(reply, what) {
    if (reply && typeof reply === 'object' && !Array.isArray(reply) && reply.code === 401) {
        console.error('\n  The key was rejected. Check you copied all of it and it is not revoked.');
        process.exit(2);
    }
    if (reply && typeof reply === 'object' && !Array.isArray(reply) && reply.code && reply.code !== 200)
        throw new Error(`${what}: ${reply.message ?? reply.code}`);
    return reply;
}

socket.on('connect_error', error => {
    console.error(`Could not reach ${URL}: ${error.message}`);
    process.exit(3);
});

socket.on('connect', async () => {
    try {
        console.log(`Connected to ${URL}.\n`);

        const devices = check(await call('getDevices', { subscribe: false }), 'getDevices');
        if (!devices.length) {
            console.log('The key works, but there are no cat flaps on this account.');
            process.exit(0);
        }

        console.log(`${devices.length} cat flap${devices.length === 1 ? '' : 's'} on this account:\n`);

        for (const device of devices) {
            const online = device.connectivity?.connected !== false;
            console.log(`  ${device.description || device.deviceId}  (${device.deviceId})`);
            console.log(`    ${online ? 'online' : 'OFFLINE'} · ${device.timeZone ?? 'no time zone'} · firmware channel ${device.firmwareChannel ?? '—'}`);

            let policies = [];
            try {
                policies = check(await call('getDeviceTransitPolicies', { deviceId: device.deviceId }), 'policies');
            } catch (error) {
                console.log(`    could not read door policies: ${error.message}`);
            }

            for (const summary of policies) {
                const active = summary.deviceTransitPolicyId === device.deviceTransitPolicyId;
                let detail = '';
                try {
                    const full = check(await call('getDeviceTransitPolicy',
                        { deviceTransitPolicyId: summary.deviceTransitPolicyId }), 'policy');
                    const rules = full.transitPolicy?.rules ?? [];
                    const idleLock = full.transitPolicy?.idleLock ?? true;
                    const opaque = rules.filter(r =>
                        r.criteria?.flapState !== undefined || r.criteria?.motionSensorState !== undefined).length;
                    detail = `${rules.length} rule${rules.length === 1 ? '' : 's'}, locked when idle: ${idleLock ? 'yes' : 'no'}`;
                    if (opaque) detail += ` — ${opaque} rule${opaque === 1 ? '' : 's'} the app cannot evaluate (uses the flap's own sensors)`;
                } catch {
                    detail = 'could not read its rules';
                }
                console.log(`    ${active ? '>' : ' '} ${summary.name ?? `policy ${summary.deviceTransitPolicyId}`} — ${detail}`);
            }

            let lastSeen = [];
            try {
                lastSeen = check(await call('getRfidLastSeenByDevice', { deviceId: device.deviceId }), 'lastSeen');
            } catch (error) {
                console.log(`    could not read cats: ${error.message}`);
            }

            const visible = lastSeen.filter(entry => !entry.hiddenAt);
            const hidden = lastSeen.length - visible.length;
            console.log(`    ${visible.length} cat${visible.length === 1 ? '' : 's'} Homey would offer${hidden ? ` (${hidden} hidden in the OnlyCat app, skipped)` : ''}:`);

            for (const entry of visible) {
                let name = entry.rfidCode;
                try {
                    const profile = check(await call('getRfidProfile',
                        { deviceId: device.deviceId, rfidCode: entry.rfidCode }), 'profile');
                    if (profile?.label) name = profile.label;
                } catch { /* an unnamed cat is still a cat */ }
                const where = entry.location ? entry.location.toLowerCase() : 'not known yet';
                console.log(`      ${name}  (${entry.rfidCode}) — ${where}`);
            }
            console.log('');
        }

        console.log('If that looks right, the key is good and pairing will find the same thing.');
        process.exit(0);
    } catch (error) {
        console.error(`\nFailed: ${error.message}`);
        process.exit(4);
    }
});
