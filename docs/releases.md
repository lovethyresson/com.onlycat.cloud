# Releases

The engineering view of every release: what changed and, where it matters, why. The user-facing
wording lives in `.homeychangelog.json`; the short version is in the [README](../README.md).

| Version | Highlights |
|---|---|
| **1.0.0** | First release. One Homey device per flap (`class: "lock"`, official `locked` made read-only via `capabilitiesOptions`, policy picker owning the quick-action slot). Cats are runtime capability instances rather than devices. Full event pipeline — `deviceEventUpdate` → `getEvent` + `getEventSummary` — firing Flow cards on the final summary only, since OnlyCat revises a TRANSIT to a PEEK mid-event and Homey cannot un-fire a trigger. Lock state and refusal reasons are both computed from a local re-implementation of the flap's transit-policy engine, which reports an un-confident result rather than naming a cause it cannot stand behind. Image Flow token on every event card. Seven languages. |

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
