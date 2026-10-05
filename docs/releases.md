# Releases

The engineering view of every release: what changed and, where it matters, why. The user-facing
wording lives in `.homeychangelog.json`; the short version is in the [README](../README.md).

| Version | Highlights |
|---|---|
| **1.0.4** | Cats and door policies are re-read while connected, not only at pairing, Repair and connect. `syncCats()` (new `reconcileCats()` in `lib/cats.ts`) runs on every connect, every ten minutes (`ACCOUNT_SYNC_MS`) and when an untracked chip uses the flap. `refreshPolicies()` runs on the same clock and on a `deviceUpdate` naming an active policy we do not know. The gateway logs any push it has no handler for. Fixes Repair stopping the lock and outside-today ticks. |
| **1.0.3** | `homeyCommunityTopicId` points the store page's Community link at [the forum thread](https://community.homey.app/t/159946). No code change. |
| **1.0.2** | `alarm_prey_ONLYCAT` and `alarm_human_ONLYCAT` fall on a five-minute hold (`CLASSIFICATION_HOLD_MS`) instead of latching until the next event's classification. `seedAlarms()` now lowers all three alarms at startup rather than only filling blanks. |
| **1.0.1** | Connection hardening. A flap OnlyCat reports as offline no longer marks the Homey device unavailable. `alarm_connectivity` says the flap is down, availability says our socket is down, and neither writes the other's signal any more. |
| **1.0.0** | First release. One Homey device per flap (`class: "lock"`, official `locked` made read-only via `capabilitiesOptions`, policy picker owning the quick-action slot). Cats are runtime capability instances rather than devices. Full event pipeline — `deviceEventUpdate` → `getEvent` + `getEventSummary` — firing Flow cards on the final summary only, since OnlyCat revises a TRANSIT to a PEEK mid-event and Homey cannot un-fire a trigger. Lock state and refusal reasons are both computed from a local re-implementation of the flap's transit-policy engine, which reports an un-confident result rather than naming a cause it cannot stand behind. Image Flow token on every event card. Seven languages. |

## 1.0.4 notes

**Nothing re-read the account after connecting.** Policies were fetched in `refresh()`, which runs on `ready`, so a restart did pick up a new one. Nothing ran between connects, and the socket stays up for days. Cats were worse off: `this.cats` came from the store written at pairing, and only Repair rewrote it. A cat added in the OnlyCat app never appeared without a Repair, and restarting did not help.

**OnlyCat pushes nothing for either, as far as we know.** `subscribe: true` covers devices and events. No policy or RFID-profile push has ever been seen. So the app polls every ten minutes and also watches for two cheaper signals. An untracked chip passing through the flap is the moment a new cat matters. A `deviceUpdate` whose `deviceTransitPolicyId` is not in our list means a policy was created and activated in the OnlyCat app. `socket.onAny` now logs every unhandled push by name, so a diagnostic log will show it if OnlyCat does announce these changes under some other name.

**`reconcileCats()` adds and drops on purpose, and asymmetrically.** It adds whatever pairing would have offered (`offerableCats`, unhidden chips). It drops only chips that come back with `hiddenAt`. It keeps a chip that is merely missing from `getRfidLastSeenByDevice`: removing a capability takes its Insights log and every Flow pointing at it, and one incomplete reply is not evidence the cat is gone. Names come from `getRfidProfile` each pass, so a rename reaches the tile. Insights keeps the name the log was created with (see CLAUDE.md). New cats get their location seeded from the same `lastSeen` reply, tagged `restatement`, so the outside-today clock charges nothing for them.

**Churn is avoided.** `syncCapabilities()` only runs when the cat list actually changed. The policy picker's `setCapabilityOptions` is only re-sent when the serialized values differ. `syncCats()` is single-flight, because connect, the clock and an unknown chip can all ask at once.

**A latent bug fixed along the way.** `applyRepair()` calls `teardown()`, which clears `lockTimer`, and nothing restarted it. After a Repair the lock state stopped following curfew boundaries and outside-today stopped ticking until the app restarted. Timers are now started by `startTimers()` from both `onInit` and `applyRepair`.

**Unverified on hardware.** As in 1.0.2, no test instantiates the device. The new tests cover `reconcileCats()`. The check on a real flap: add a policy in the OnlyCat app and wait up to ten minutes for the picker; add a cat and either wait or let it use the flap.

## 1.0.2 notes

**The classification alarms never fell.** `applyClassification()` was their only writer, and it wrote `classification === X` for the event in hand — so the only thing that could ever write `false` was a later event classified as something else. A person seen at 14:00 left "Human activity — yes" on the tile for as long as the flap stayed quiet, which overnight is hours. The auto-generated "turned off" trigger fired whenever an unrelated cat eventually came through, and a Flow condition on either alarm read `true` all that time.

**Clearing on conclusion, the `alarm_motion` pattern, was the first proposal and is wrong.** `isEventConcluded` is `frameCount != null`, and OnlyCat only classifies an event at or after it concludes. `afterUpdate()` runs `applyClassification()` and then checks conclusion in the same pass, so the alarm would have been lowered in the tick that raised it. `hydrate()` fetching an already-finished event makes that the common case. `alarm_motion` describes a state whose end the flap reports; "a person was at the door" is a moment, and a moment needs a hold.

**The mechanism.** `holdAlarm()` raises the alarm and arms a `this.homey.setTimeout` to lower it after five minutes, re-arming on each update pass for the same event, so the hold runs from the last thing the flap said. Each alarm is raised only by its own classification and lowered only by its own timer, so a cat going out at 14:01 no longer clears a person seen at 14:00. A `null` classification (still being classified) or `Unknown` (`0`, compared and never truth-tested) raises nothing and leaves a running hold alone. `teardown()` clears the timers.

**The other half of the latch was the restart.** `seedAlarms()` only wrote into a blank, on the grounds that a stored value was real state. It wasn't: Homey persists the capability value across a restart, but the timer that would lower it dies with the process. It now writes `false` unconditionally. A restart inside a hold costs one early "turned off" trigger. The backfill of the last event does not call `applyClassification()`, so a reboot does not re-raise an alarm from history.

**Five minutes is a choice.** It is long enough for a Flow condition to read and for the tile to be worth a glance, and short enough to be gone before it misleads. It is not derived from anything OnlyCat reports.

**Unverified on hardware.** No test instantiates `drivers/cat_flap/device.ts`, since it needs a Homey runtime, so the suite passing shows nothing else broke and does not prove the hold works. The check is on a real flap: trigger a human event and watch the tile fall five minutes later. Model drift was checked by hand again, because `dev/check-models.mjs` still does not exist: upstream `OnlyCatAI/onlycat-shared-models` HEAD is `aecefd5`, the commit that is vendored.

## 1.0.1 notes

**A flap offline was reported as the app being broken.** `refreshDevice()` wrote
availability as well as `alarm_connectivity`: `connected === false` on the *flap* called
`markUnavailable()`, so Homey greyed the tile out and captioned it "Not connected to OnlyCat" — a
sentence about our socket, printed because of theirs. The rule forbidding the reverse (`onDown`
must never write `alarm_connectivity`) was already documented, three lines above the offending
call.

Diagnostic `f180ca74` (Homey Pro Early 2023, flap `OC-0CBFB4903101`) shows the whole shape of it.
OnlyCat pushed `deviceUpdate` at 16:02:57 with `CONNECTION_LOST`, flickered back at 16:03:05, went
down again at 16:03:08 with `DUPLICATE_CLIENTID` and then `CONNECTION_LOST`, and never once pushed a
recovery: the re-read at 16:18:08 still said offline. Meanwhile the socket was never touched — there
is no `gateway: disconnected` line in the log at all. Event 105 arrived at 16:23 and event 106 at
16:48, both fully classified, both committed, both incrementing the trip counters, underneath a
device Homey considered dead. `deviceUpdate` is the only thing that re-reads connectivity, so with
no recovery push there was nothing to clear it; the owner restarted the app, `refreshDevice()` ran
against a by-then-healthy record, and it came back. They reported it, reasonably, as "my app was
disconnected".

The fix is a separation, not a retry. Availability is written only by the gateway's own lifecycle —
`onReady`, `onDown`, `onUnauthorized` — and `refreshDevice()` writes only `alarm_connectivity`.
`ready` is the honest signal: it fires after `getDevices`, `getDevice` and `getDeviceEvents` have
all acked, so a rejected key emits `unauthorized` and never reaches it. The already-connected
shortcut in `connect()`, which exists because a second flap attaching to a live shared gateway never
sees `ready`, now calls `onReady()` rather than duplicating half of it.

What this deliberately does not fix: OnlyCat's `connectivity.connected` was stale for at least five
minutes — offline at 16:18, sending events at 16:23 — so `alarm_connectivity` stands alone and wrong
for that hour instead. Clearing it on an arriving event is tempting and was not done.
`refreshDevice()` is the single writer, that rule has already been paid for once, and there is no
evidence a re-read at 16:23 would have returned anything different. The alarm reports what OnlyCat
says, and only that.

## 1.0.0 notes

**Two bugs avoided, both confirmed in the reference implementation** (`OnlyCatAI/onlycat-home-assistant`):

- `EventTriggerSource.Manual` and `EventClassification.Unknown` are both `0`, and a truthiness
  check drops them. There it makes every manually triggered event lose its trigger source and then
  dereference null.
- `idleLock` defaults to `true` server-side (`TransitPolicy.ts`) and to `false` there. A policy
  omitting the field therefore reads as unlocked in the reference client and locked on the real
  flap — fail-open, on a lock.

Presence also follows OnlyCat's own `getRfidLastSeenLocationFromSubevent` rather than a re-derivation:
`BREACH` is a transit, `PEEK` and `DENY` leave the cat where it was. The reference implementation
treats everything that is not `TRANSIT` as the inverse, which marks a cat that forced its way in as
being outside.

**One bug found by our own tests, in our own code.** The reconnect integration test failed because
socket.io does not auto-reconnect after `io server disconnect` — `reconnection: true` covers
transport failures only. OnlyCat's models document `disconnectReason: "SERVER_INITIATED_DISCONNECT"`,
so a deploy on their side would have left every flap dark, looking merely unavailable, until the app
was restarted by hand. `scheduleReconnect()` in `lib/gateway.ts` is the fix. This is the single
strongest argument for the in-process fake gateway existing at all: no unit test would have reached it.

**Verified against hardware since.** Run on a real flap (`OC-0CBFB4903101`) on 2026-09-20:

- `Device#setCameraImage` and `setCameraVideo` both exist and work. An image and a video are *separate* entries even under one id, and while they shared the id `event` the still was never requested at all. Split into `still` and `clip`, both serve — `still JPEG, 30387 bytes`. An id that stops being registered leaves no orphan behind, contrary to what this repo claimed for several days.
- The frame-image endpoint needs no authentication: `GET /events/<device>/<event>/<frame>` returns `200 image/jpeg` with and without `?t=<accessToken>`. `posterFrameIndex` really can be `0`, so the `!= null` guard in `posterFrame()` is load-bearing.
- The policy picker does **not** hold the quick-action slot. `locked` does, with `setable: true` and `uiQuickAction: true` — unlocking is the tile's one-tap action and the policy picker is reached from the device page. This reverses the original design note.
- `homey.__()` substitutes `__name__` and ignores `{{name}}`. Every templated string shipped with the wrong spelling and rendered the placeholder verbatim, through every gate, until a debug log showed it.

**Still unverified:**

- whether a Homey capability sub-id starting with a digit works (we prefix `c` to avoid finding out)
- whether a Zone "lock all locks" Flow reaches this device now that `locked` is setable

**Not shipped for Homey Cloud.** `platforms` is `["local"]`. Nothing technical prevents Cloud — no local network, no discovery, no settings page, no permissions, and it validated for both platforms for its whole life — but publishing there needs an organization with Verified Developer status, which individuals cannot get. The Cloud-safe discipline stays in the code (`this.homey.setTimeout` over the globals, gateway registry hung off the App instance), so re-enabling is adding `"cloud"` back to two arrays.

**A process gap, recorded rather than papered over.** `dev/check-models.mjs` is named as a release step in [../CLAUDE.md](../CLAUDE.md) and in the plan, and was never written. For 0.1.0 the check was done by hand: upstream `OnlyCatAI/onlycat-shared-models` HEAD is `aecefd5`, which is exactly the commit vendored in `lib/onlycat/models.ts`, so there is no drift. The script still needs writing before a release where that is not trivially true.

**One round of App Store review, both points about the listing rather than the app.** The driver image was a square crop of the same hero photograph the app image is a landscape crop of; review read the two as one image and asked for a distinct driver image on a white background, showing the device. Two crops of one photograph are not byte-identical, and that is beside the point — they look the same, and a driver image has a different job from an app image. It is now a cut-out of the flap over white, generated by `dev/make-driver-images.py`. The store description lost its lead-in — "Your cat flap in Homey — who came in, who was turned away, and why" became "Who came in, who was turned away, and why." in all seven languages, since the store already says whose app it is and which hub it runs on.

**The cut-out is the one asset not derived from OnlyCat's own artwork**, and [assets.md](assets.md) records why: nothing OnlyCat publishes has an alpha channel, or a white background, and both plausible sources defeat automatic keying badly enough that the first two attempts were hand-traced silhouette polygons. Ask OnlyCat about it alongside the brand mark.
