# Releases

The engineering view of every release: what changed and, where it matters, why. The user-facing
wording lives in `.homeychangelog.json`; the short version is in the [README](../README.md).

| Version | Highlights |
|---|---|
| **0.1.0** | First release. One Homey device per flap (`class: "lock"`, official `locked` made read-only via `capabilitiesOptions`, policy picker owning the quick-action slot). Cats are runtime capability instances rather than devices. Full event pipeline — `deviceEventUpdate` → `getEvent` + `getEventSummary` — firing Flow cards on the final summary only, since OnlyCat revises a TRANSIT to a PEEK mid-event and Homey cannot un-fire a trigger. Lock state and refusal reasons are both computed from a local re-implementation of the flap's transit-policy engine, which reports an un-confident result rather than naming a cause it cannot stand behind. Image Flow token on every event card. Six languages. |

## 0.1.0 notes

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

**Unverified against hardware at time of writing.** Everything below needs a real flap and is
tracked in [../tasks/todo.md](../tasks/todo.md):

- whether a Homey capability sub-id starting with a digit works (we prefix `c` to avoid finding out)
- whether the policy picker actually takes the tile's quick-action slot
- whether a Zone "lock all locks" Flow skips a device whose `locked` is `setable: false`
- whether `Device#setCameraImage` exists in SDK 3 and what it does to the tile
- whether the frame-image endpoint really needs no authentication
