#!/usr/bin/env node
/**
 * How much of the past will OnlyCat give back?
 *
 * "Outside today" resets at local midnight and the app keeps nothing else, so a bar chart of
 * hours-per-day built today starts empty and grows one bar at a time. The only other source is
 * OnlyCat's own event log — and whether that can be replayed into a history depends on four
 * numbers nobody has measured:
 *
 *   1. how far back `getDeviceEvents` actually goes,
 *   2. whether old events are still readable (`accessToken`, `deletedAt`, `paymentRequired`),
 *   3. what a full reconstruction would cost, at one `getEventSummary` round-trip per event,
 *   4. whether the summaries that come back carry a usable direction and chip.
 *
 * This answers all four, and then does the thing that actually settles it: replays the last few
 * days and prints the chart. If those bars match what your cats did, the reconstruction works.
 *
 *   node dev/probe-history.mjs oc_live_...        # last 7 days
 *   node dev/probe-history.mjs oc_live_... 14     # last 14
 *
 * The flap is yours to probe. Nobody but you should ever hold this key.
 */

import { io } from 'socket.io-client';

const KEY = process.argv[2];
const DAYS = Number(process.argv[3] ?? 7);

if (!KEY || !Number.isFinite(DAYS) || DAYS < 1) {
    console.error('usage: node dev/probe-history.mjs <api-key> [days]');
    process.exit(1);
}

/** Summaries are one round-trip each. A blind run must not spend an hour on OnlyCat's server. */
const SUMMARY_CAP = 300;
/** Charted days need to know where each cat already was, so the replay starts before them. */
const LEAD_IN_DAYS = 2;
const DAY = 86400000;

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

// -------------------------------------------------------------------------------------------
// Days, in the FLAP's zone
// -------------------------------------------------------------------------------------------

/** `YYYY-MM-DD` where the cat was, not where the computer running this is. */
function localDay(zone, at) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: zone ?? undefined, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(at));
}

/** Seconds since local midnight at `at`. */
function secondsIntoDay(zone, at) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone ?? undefined, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(at));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return get('hour') * 3600 + get('minute') * 60 + get('second');
}

/**
 * Epoch ms of local midnight for the day containing `at`.
 *
 * The correction pass is not optional. Subtracting the local clock reading uses the offset at
 * `at`, and if the subtraction crosses a DST transition the result lands an hour off — on the
 * spring-forward Sunday it comes back at 23:00 the previous evening, which is a different day.
 * A transition never moves the clock by more than a couple of hours, so one pass settles it:
 * drift past noon means we undershot into yesterday and must go forward.
 */
function startOfDay(zone, at) {
    let guess = at - secondsIntoDay(zone, at) * 1000 - (at % 1000);
    const drift = secondsIntoDay(zone, guess);
    if (drift !== 0) guess += (drift > 43200 ? 86400 - drift : -drift) * 1000;
    return guess;
}

/**
 * Local midnight at the END of the day containing `at`.
 *
 * Jumping 36 hours and snapping back lands inside the following day whether it ran 23, 24 or 25
 * hours. Adding 24h to a midnight does not survive a clock change.
 */
function endOfDay(zone, at) {
    return startOfDay(zone, startOfDay(zone, at) + 36 * 3600 * 1000);
}

/** Add one outside run to the per-day totals, splitting it at every midnight it crosses. */
function addRun(totals, rfid, from, to, zone) {
    let cursor = from;
    for (let guard = 0; cursor < to && guard < 500; guard += 1) {
        const day = localDay(zone, cursor);
        const stop = Math.min(to, endOfDay(zone, cursor));
        // A day that does not end after it starts would spin here forever, banking nothing.
        // It cannot happen now; if a zone ever makes it happen, stop rather than hang.
        if (stop <= cursor) break;
        const bucket = totals[rfid] ?? (totals[rfid] = {});
        bucket[day] = (bucket[day] ?? 0) + (stop - cursor);
        cursor = stop;
    }
}

// -------------------------------------------------------------------------------------------
// The contract, copied from lib/onlycat/models.ts
// -------------------------------------------------------------------------------------------

/**
 * Where a chip ended up. PEEK and DENY mean the cat looked, or was refused, and therefore stayed
 * where it was — so an inward peek leaves it OUTSIDE. BREACH counts as a transit: it got through.
 */
function locationFromSubevent(subevent) {
    if (!subevent) return null;
    if (subevent.action === 'TRANSIT' || subevent.action === 'BREACH')
        return subevent.direction === 'INWARD' ? 'inside' : 'outside';
    if (subevent.action === 'PEEK' || subevent.action === 'DENY')
        return subevent.direction === 'INWARD' ? 'outside' : 'inside';
    return null;
}

/**
 * Replay observations into per-cat, per-day milliseconds outside.
 *
 * Deliberately simpler than `lib/outside.ts`, and correct for this job: that module exists to
 * cope with trips the flap never saw, guessing at a fraction of the unseen gap. Replaying a
 * complete event log has no unseen gaps — every transition is in the data. Do not mistake this
 * for a second implementation of the model.
 */
function replay(observations, zone, until) {
    const totals = {};
    const since = new Map();
    let contradictions = 0;

    for (const obs of observations) {
        const open = since.get(obs.rfid) ?? null;
        if (obs.location === 'outside') {
            if (open === null) since.set(obs.rfid, obs.at);
            else contradictions += 1;
        } else if (open !== null) {
            addRun(totals, obs.rfid, open, obs.at, zone);
            since.set(obs.rfid, null);
        }
    }

    // A cat that is still out has a run in progress. It counts up to now, not to its last event.
    for (const [rfid, open] of since) {
        if (open !== null) addRun(totals, rfid, open, until, zone);
    }

    return { totals, contradictions };
}

// -------------------------------------------------------------------------------------------
// Output
// -------------------------------------------------------------------------------------------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function duration(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'under a minute';
    if (minutes < 90) return plural(minutes, 'minute');
    return `${(minutes / 60).toFixed(1)} hours`;
}

/** One cat's week, as bars. The whole point of the probe: numbers you can check against memory. */
function chart(name, byDay, days, today) {
    const peak = Math.max(...days.map((day) => byDay[day] ?? 0), 1);
    console.log(`    ${name}`);
    for (const day of days) {
        const hours = (byDay[day] ?? 0) / 3600000;
        const width = Math.round((hours / (peak / 3600000)) * 24);
        // The day string is already the flap's calendar date, so it is formatted AS a date in UTC.
        // Re-interpreting it in the flap's zone would shift the weekday by one east of UTC+12.
        const label = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'UTC', weekday: 'short', day: 'numeric',
        }).format(new Date(`${day}T12:00:00Z`));
        const bar = '#'.repeat(width).padEnd(24, '.');
        const note = day === today ? '  (today, still running)' : '';
        console.log(`      ${label.padEnd(8)} ${bar} ${hours.toFixed(1)}h${note}`);
    }
}

// -------------------------------------------------------------------------------------------

socket.on('connect_error', (error) => {
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

        for (const device of devices) {
            const zone = device.timeZone ?? null;
            const now = Date.now();
            console.log(`${device.description || device.deviceId}  (${device.deviceId})`);
            console.log(`  days are counted in ${zone ?? 'this computer\'s zone — the flap reports none'}\n`);

            const events = check(await call('getDeviceEvents',
                { deviceId: device.deviceId, subscribe: false }), 'getDeviceEvents');
            const dated = events.filter((e) => e.eventId != null && e.timestamp);

            if (!dated.length) {
                console.log('  The event log is empty. Nothing can be reconstructed.\n');
                continue;
            }

            // 1. Depth.
            const stamps = dated.map((e) => Date.parse(e.timestamp)).filter(Number.isFinite);
            const oldest = Math.min(...stamps);
            const newest = Math.max(...stamps);
            const span = Math.max(1, Math.round((newest - oldest) / DAY));
            console.log(`  1. Depth — ${plural(events.length, 'event')} in the log,`
                + ` ${localDay(zone, oldest)} to ${localDay(zone, newest)}`);
            console.log(`     That is ${plural(span, 'day')}, averaging`
                + ` ${(dated.length / span).toFixed(1)} events a day.`);

            // 2. Reachability.
            const deleted = events.filter((e) => e.deletedAt).length;
            const tokenless = dated.filter((e) => !e.accessToken).length;
            const paywalled = dated.filter((e) => e.paymentRequired).length;
            console.log('\n  2. Reachability —'
                + ` ${deleted} deleted, ${tokenless} without an access token, ${paywalled} marked paymentRequired`);
            if (paywalled)
                console.log('     A paymentRequired event is the one that could kill this: the data exists but is gated.');
            if (tokenless)
                console.log('     An event without a token has no summary, so its direction is unknowable.');

            // The replay window, plus a lead-in so the first charted day knows where each cat was.
            const windowStart = startOfDay(zone, now - (DAYS - 1) * DAY);
            const replayStart = windowStart - LEAD_IN_DAYS * DAY;
            const candidates = dated
                .filter((e) => !e.deletedAt && e.accessToken && Date.parse(e.timestamp) >= replayStart)
                .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

            console.log(`\n  3. Cost — fetching ${plural(Math.min(candidates.length, SUMMARY_CAP), 'summary', 'summaries')}`
                + ` for the last ${plural(DAYS + LEAD_IN_DAYS, 'day')}...`);

            const latencies = [];
            const observations = [];
            let resolved = 0;
            let usable = 0;
            const capped = candidates.length > SUMMARY_CAP;

            for (const event of candidates.slice(0, SUMMARY_CAP)) {
                const started = Date.now();
                let summary;
                try {
                    summary = check(await call('getEventSummary', {
                        deviceId: device.deviceId,
                        eventId: event.eventId,
                        accessToken: event.accessToken,
                        subscribe: false,
                    }), 'getEventSummary');
                } catch {
                    continue;
                }
                latencies.push(Date.now() - started);
                if (!summary) continue;
                resolved += 1;

                for (const subevent of summary.subevents ?? []) {
                    const location = locationFromSubevent(subevent);
                    if (!location || !subevent.rfidCode) continue;
                    usable += 1;
                    observations.push({ at: Date.parse(event.timestamp), rfid: subevent.rfidCode, location });
                }
            }

            const typical = median(latencies);
            console.log(`     ${resolved} of ${Math.min(candidates.length, SUMMARY_CAP)} summaries came back,`
                + ` median ${typical} ms each.`);
            if (capped) console.log(`     Stopped at the ${SUMMARY_CAP}-call cap; the window holds ${candidates.length}.`);
            console.log(`     Reconstructing all ${plural(dated.length, 'event')} at that rate would take`
                + ` ${duration(dated.length * typical)}.`);

            // 4. Fidelity.
            console.log(`\n  4. Fidelity — ${plural(usable, 'subevent')} carried both a direction and a chip.`);
            if (!usable) {
                console.log('     Nothing usable came back, so there is nothing to replay.\n');
                continue;
            }

            // 5. The dry run.
            const { totals, contradictions } = replay(observations, zone, now);
            const days = [];
            for (let at = windowStart; at <= now; at = endOfDay(zone, at)) days.push(localDay(zone, at));
            const today = localDay(zone, now);

            console.log(`\n  5. What the chart would have said (last ${plural(DAYS, 'day')}):\n`);
            for (const rfid of Object.keys(totals)) {
                let name = rfid;
                try {
                    const profile = check(await call('getRfidProfile',
                        { deviceId: device.deviceId, rfidCode: rfid }), 'getRfidProfile');
                    if (profile?.label) name = profile.label;
                } catch { /* an unnamed cat is still a cat */ }
                chart(name, totals[rfid], days, today);
                console.log('');
            }

            if (contradictions)
                console.log(`     ${plural(contradictions, 'time')} a cat went out when the log said it was already out.`
                    + ' Those are trips the flap never saw — the app\'s "unseen trips" setting is about exactly this.\n');

            // 6. The verdict.
            const readable = resolved / Math.max(1, Math.min(candidates.length, SUMMARY_CAP));
            const fullRun = dated.length * typical;
            const verdict = [];
            if (span < DAYS) verdict.push(`the log only reaches back ${plural(span, 'day')}`);
            if (paywalled) verdict.push(`${paywalled} events are behind paymentRequired`);
            if (readable < 0.8) verdict.push(`only ${Math.round(readable * 100)}% of summaries resolved`);
            if (fullRun > 30 * 60000) verdict.push(`a full reconstruction would take ${duration(fullRun)}`);

            console.log(verdict.length
                ? `  6. Verdict — worth a second look: ${verdict.join('; ')}.`
                : `  6. Verdict — a backfill looks viable: ${plural(span, 'day')} of readable history,`
                    + ` about ${duration(fullRun)} to replay it all.`);
            console.log('');
        }

        console.log('If those bars match what your cats actually did, the replay is sound and the');
        console.log('chart can be backfilled. If they do not, say which day is wrong — that is the bug.');
        process.exit(0);
    } catch (error) {
        console.error(`\nFailed: ${error.message}`);
        process.exit(4);
    }
});
