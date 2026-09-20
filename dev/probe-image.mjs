#!/usr/bin/env node
/**
 * Why does "Last still image" not load?
 *
 * "Last clip" works, so the socket, the key and the event are all fine — what is left is the one
 * thing the two do not share: the still-frame URL. The clip is
 * `/sharing/video/<device>/<event>?t=<accessToken>`; the still is `/events/<device>/<event>/<frame>`
 * with no token at all, on the strength of a note in the plan that said stills are unsigned.
 * This checks that note against the server.
 *
 * Homey does not just pipe what it is given: `Image._validateBuffer` sniffs the magic bytes and
 * rejects anything that is not an image. So a 200 carrying an HTML error page fails exactly like
 * a 404 does, and neither is visible from inside the app. This prints the status, the content
 * type AND the first bytes, because only the last of those three can tell them apart.
 *
 *   node dev/probe-image.mjs oc_live_...
 *
 * It fetches images only, never writes anything, and sends the key nowhere but OnlyCat.
 */

import { io } from 'socket.io-client';

const KEY = process.argv[2];
if (!KEY) {
    console.error('usage: node dev/probe-image.mjs <api-key>');
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

/** What the bytes actually are, which is the question Homey asks and the status code does not. */
function sniff(buffer) {
    const b = buffer;
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPEG ✓';
    if (b.length >= 8 && b.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return 'PNG ✓';
    if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'WEBP ✓';
    if (b.length >= 6 && b.toString('latin1', 0, 3) === 'GIF') return 'GIF ✓';
    const head = b.toString('utf8', 0, 120).replace(/\s+/g, ' ').trim();
    return `NOT AN IMAGE — Homey will reject this. Starts: ${JSON.stringify(head)}`;
}

async function probe(label, url) {
    process.stdout.write(`  ${label.padEnd(26)} `);
    try {
        const response = await fetch(url);
        const buffer = Buffer.from(await response.arrayBuffer());
        const type = response.headers.get('content-type') ?? 'no content-type';
        console.log(`${response.status} ${type}, ${buffer.length} bytes`);
        console.log(`  ${''.padEnd(26)} ${sniff(buffer)}`);
        return response.ok && !sniff(buffer).startsWith('NOT');
    } catch (error) {
        console.log(`request failed: ${error.message}`);
        return false;
    }
}

socket.on('connect_error', error => {
    console.error(`Could not reach ${URL}: ${error.message}`);
    process.exit(3);
});

socket.on('connect', async () => {
    try {
        const devices = check(await call('getDevices', { subscribe: false }), 'getDevices');
        if (!devices.length) {
            console.log('No cat flaps on this account.');
            process.exit(0);
        }
        const device = devices[0];
        const deviceId = device.deviceId ?? device.id;

        const events = check(await call('getEvents', { deviceId, limit: 5 }), 'getEvents');
        const list = Array.isArray(events) ? events : (events?.body ?? []);
        if (!list.length) {
            console.log(`No events on ${deviceId} yet — walk a cat through the flap and re-run.`);
            process.exit(0);
        }

        const event = list.reduce((a, b) => ((b.eventId ?? 0) > (a.eventId ?? 0) ? b : a));
        const full = check(await call('getEvent', { deviceId, eventId: event.eventId }), 'getEvent');
        const e = full?.body ?? full ?? event;

        const frameCount = e.frameCount ?? null;
        const poster = e.posterFrameIndex ?? (frameCount ? Math.floor(frameCount / 2) : 1);
        const token = e.accessToken ?? event.accessToken ?? null;

        console.log(`Flap ${deviceId}, event ${e.eventId}.`);
        console.log(`  frameCount ${frameCount ?? 'absent'}, posterFrameIndex `
            + `${e.posterFrameIndex ?? 'absent'} -> the app asks for frame ${poster}`);
        console.log(`  accessToken ${token ? 'present' : 'ABSENT (no clip either, then)'}\n`);

        const base = `${URL}/events/${deviceId}/${e.eventId}`;
        console.log('What the app asks for today:');
        const ok = await probe('no token', `${base}/${poster}`);

        console.log('\nVariants, to find one that works:');
        if (token) {
            await probe('?t=<accessToken>', `${base}/${poster}?t=${token}`);
            await probe('frame 0, with token', `${base}/0?t=${token}`);
            await probe('frame 1, with token', `${base}/1?t=${token}`);
            await probe('no frame, with token', `${base}?t=${token}`);
        }
        await probe('frame 0, no token', `${base}/0`);
        await probe('frame 1, no token', `${base}/1`);

        console.log(ok
            ? '\nThe still URL the app uses is fine, so the fault is inside the app, not the URL.'
            : '\nThe still URL the app uses does NOT return an image. Whichever line above says '
              + '"JPEG ✓" or "PNG ✓" is the shape the app should be building.');
        process.exit(0);
    } catch (error) {
        console.error(`\nFailed: ${error.message}`);
        process.exit(4);
    }
});
