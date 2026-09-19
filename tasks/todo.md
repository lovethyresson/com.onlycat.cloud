# com.onlycat.cloud — plan for v0.1.0

**Status:** proposed, not started. Nothing in this repo yet but this file.
**Written:** 2026-09-19.

A Homey app for the [OnlyCat](https://www.onlycat.com/) smart cat flap, talking to OnlyCat's own cloud
gateway. Built to the conventions established in `com.nibe.local`, with the deliberate departures noted
in [§3](#3-what-carries-over-from-comnibelocal-and-what-changes).

---

## 1. The prior art, and why we build anyway

Three things exist. None of them is a reason not to do this.

| | What it is | Verdict |
|---|---|---|
| **`OnlyCatAI/onlycat-home-assistant`** | The **official** HA integration. v2.0.7, 42★, last pushed 2026-09-18. Tested, maintained. | **The reference implementation.** Read it, learn from it, copy none of it verbatim — it has confirmed bugs we can start past ([§9](#9-bugs-to-not-inherit)). |
| **`OnlyCatAI/onlycat-shared-models`** | OnlyCat's own server-side object models. **Public, TypeScript.** | **The contract.** This is the source of truth for every enum and payload shape. Vendor it ([§7](#7-the-onlycat-type-contract)). |
| **`erdebee/onlycat-homey`** | A community Homey app. | **Not a competitor.** Two commits, both on the evening of 2025-08-29, author's own message: *"presence is still broken. code is not super tidy yet"*. 3★, zero human-filed issues, 320 consecutive CI failures (it runs Home Assistant's `hassfest` on a branch that doesn't exist). **Never published** — `api.athom.com/app/com.onlycat.app` returns 404 against a control group of real ids that return 200. Full provenance below; the short version is that it was never submitted, never announced, and OnlyCat were never involved. |
| **`matthiaseinig/Homebridge-OnlyCat`** | A HomeKit plugin, TypeScript. | **Worth reading once.** It ships `docs/PROTOCOL.md` — the best third-party protocol write-up that exists — and a typed `OutboundRpcMap` / `InboundEventMap` in `src/api/types.ts`. Closest thing to a TypeScript client for this API. Its own disclaimer is the right posture: *"The protocol is undocumented and may change without notice — this file is a living reference, not a contract."* |
| **`Sickboy78/ioBroker.onlycat`** | An ioBroker adapter, JS. | Read for its defensive habits: it treats every server push as an **invalidation signal** and re-fetches, rather than trusting the payload. |

**There is no OnlyCat app on the Homey App Store, and no forum thread asking for one.** The only cat-flap
app on Homey is Sure Petcare. We are not entering a crowded field; we are creating one.

### Why `erdebee/onlycat-homey` was never published, and why we are clear to proceed

Worth settling, because "an OnlyCat Homey app already exists" would be a reason to stop if it were a
maintained app or a vendor project. It is neither.

**It was a single evening.** The repo was created 2025-08-29 20:00:14Z; both commits landed at 20:01:26Z
and 22:21:09Z the same night. Nothing since. Every publication signal is absent: no tags, no releases,
no `.homeychangelog.json` (mandatory for submission), version never moved off `1.0.0`, no
`homey app validate` in CI.

**The author knew exactly how to publish and chose not to.** `erdebee` is Roy Brondgeest, Amsterdam —
an experienced Homey developer with **two apps already on the store** (`nl.pulsive.innova`,
`nl.pulsive.autarco`), a `[APP][Pro]` forum thread, and a documented 48-hour submit-to-approved
turnaround. He also has a stated habit of leaving apps on GitHub: *"I do not plan to distribute it to
the app store. The source code is here…"* Two of his five Homey apps are published; three are not.
OnlyCat is in the majority.

**He never told anyone it exists.** A Homey Community Forum search for `onlycat` returns a genuine empty
result across every bucket — verified against a control query (`kattenluik`, Dutch for cat flap, returns
real threads), so the search works. No `[APP][Pro]` thread, no app request, no beta link. Across his last
50 forum posts and all four topics he has ever created, OnlyCat is not mentioned once.

**OnlyCat were never involved, and we know what their involvement looks like.** When the Home Assistant
thread opened on 2024-12-22, OnlyCat replied *the same day* — *"we've been in discussions with Heisenberg
and are fully supportive of this development"* — then took the repo into their own org with
`"codeowners": ["@OnlyCatAI"]`. None of that happened here: the 80-post HA thread contains **zero**
mentions of Homey or Athom, and `github.com/OnlyCatAI/onlycat-homey` (the URL in the app's own `bugs`
field) **never existed** — Wayback CDX returns zero captures for it, ever, and only `onlycat-home-assistant`
URLs across the whole org prefix. OnlyCat's developer portal, created March 2026 and explicitly
*"featuring community-built projects"*, lists Home Assistant and nothing else. Their FAQ's passing
mention of "a Homey app" first appeared between 2025-09-06 and 2025-12-06 — *after* the repo existed and
*after* it had already gone dormant.

**Two things follow for us:**

- **The etiquette is clear.** No vendor endorsement to step on, no `[APP][Pro]` thread, no users to
  strand (3★, 0 forks, 0 human-filed issues, 0 forum footprint), no maintainer working the space. The
  author is still active (forum last seen 2026-09-09) and reachable as `RoyB` — a courtesy note that we
  are building one costs nothing and is worth sending. OnlyCat have a Discord
  (`discord.gg/Xg3bCgXbZa`) if we want to open that conversation too.
- **Do not copy his code.** The licence is genuinely ambiguous: the `LICENSE` file is **GPL-3.0** while
  `package.json` and the README both claim MIT, and GitHub reports GPL-3.0. We have no reason to copy
  any of it — the official HA integration is the better reference — but the ambiguity makes "no reason"
  into "definitely not".

Its remaining value is as protocol documentation: it independently confirms the gateway URL, the
Socket.IO auth shape and the RPC method names. Read it once for that, then close it.

> One detail worth carrying as a warning rather than a joke. His `package.json` says
> `"name": "nl.pulsive.onlycat-homey"` — his own namespace, his real convention — while the `app.json`
> that Homey actually reads says `"id": "com.onlycat.app"` with `"author": {"name": "OnlyCat AI",
> "email": "support@onlycat.com"}` and a bug tracker that 404s. The file he wrote is right; the file
> that ships is vendor-branded boilerplate he never reviewed. He has written publicly about building
> Homey apps with an AI editor. **Check the generated manifest, every release.** That is exactly the
> class of error `homey app validate --level publish` in CI exists to catch, which is why it is in ours
> from the first commit.

**App id:** `com.onlycat.cloud`. Distinct from the unpublished `com.onlycat.app`, so no collision.
The `.cloud` suffix is honest and matches the `com.nibe.local` / `com.homevolt.local` naming: it says
where the data comes from. This app has no local path at all — OnlyCat exposes none.

---

## 2. What v0.1.0 is

> **One Homey device per flap — and every event tells you which cat, with the picture.**

Both clauses are load-bearing:

- **One device per flap.** A Homey device maps to a *thing you own*. You own one cat flap, so you get one
  device. Cats are not devices — they are state the flap reports, and they belong on it as capabilities,
  Flow arguments and Flow tokens ([§4](#4-the-device-model)).

  > **This reverses an earlier draft of this plan**, which proposed one Homey device per cat on the Nibe
  > "one pump becomes several devices" model. That was the wrong analogy. Nibe's split works because a
  > pump genuinely *is* several appliances — heating and hot water are separate machines sharing a
  > compressor, each with its own controls, its own settings and its own energy meter. A cat has none of
  > those. It is not something the household installed, and modelling it as hardware produces devices
  > that go stale when a cat moves away, plus a pairing flow that asks you to enumerate your pets before
  > you can see your flap. One flap, one device.

- **With the picture** is the differentiator no other integration has on Homey. Homey Flow trigger tokens
  support `type: "image"` (verified in Athom's own `app/schema.json`: the token `type` enum is
  `["boolean", "number", "string", "image"]`). So a **"Prey detected"** trigger can carry the frame
  straight into a push notification. On a flap whose marquee feature is prey detection, that is the
  feature. The HA integration has image *entities*; it does not have an image you can drop into a
  notification in two clicks.

Everything else in v0.1.0 exists to make those two work honestly.

### Why `.cloud` and not `.local`

Asked and answered, so that it is not re-litigated: **there is no local path, and no third party can build one.**

The flap is an **outbound-only AWS IoT Core client**. The evidence is multi-sourced and unambiguous:
`DeviceCommand.ts` / `DeviceCommandExecution.ts` carry `commandArn`, `targetArn`, `executionId`,
`statusReason.reasonCode`, `nextToken` — a field-for-field match for AWS IoT Device Management's Commands
API. `Device.ts` references the **device shadow** twice by name (`screenTemplate` is *"deliberately NOT in
the shadow"*; `locale` is *"Mirrored to the shadow like timeZone"*). `DeviceConnectivity`'s "missing after
~an hour" caveat is AWS IoT Fleet Indexing semantics verbatim. So `unlock` travels
Homey → `gateway.onlycat.com` → OnlyCat cloud → AWS IoT → flap. **Every hop is theirs.** OnlyCat's own
integration declares `"iot_class": "cloud_push"`.

A local API has been promised since **2024-12-22**, once, by OnlyCat's official account:

> "We've provided the above code bundle as an initial reference for our Cloud API - and **will be working
> on launching a Local API**. We envisage the community HA plugin can get started with the former, and
> switch over to the latter in a piecewise manner as local MQTT support and APIs are available/documented."

Twenty-one months later it does not exist. The developer hub and Discord that OnlyCat launched in **March
2026** — fifteen months *after* that promise — document the cloud API only; the word "local" appears
nowhere in either. Four direct public requests for a timeline (Dec 2025, Jan 2026, Feb 2026, Aug 2026)
went unanswered; OnlyCat's last post in the Home Assistant thread is from **March 2025**. The official
integration's maintainer put it plainly in Aug 2025: *"Local api is a topic that is blocked until OnlyCat
develops that functionality into the device firmware."* He is now building his own open flap
(`Alex-ala/OpenCatFlap`), which is its own kind of answer.

**So the name is honest and the architecture follows from it.** Two consequences to carry into the code
and the FAQ:

- **The flap keeps working offline; Homey does not.** Door policy is enforced on-device, every frame — the
  FAQ says the one-time version *"can continue its door functions without internet after setup"*, and the
  helpdesk's offline guide expects transit detection to continue. So during an outage the cats are fine
  and Homey goes dark. That is the inverse of `com.nibe.local`, where the cloud is the thing being
  bypassed. **Say this in the FAQ.** It is the first question an owner of both apps will ask.
- **Subscription hardware is weaker still** — *"The subscription version needs connectivity to check its
  subscription"* — and events carry `paymentRequired`.

Latency is not the problem, for what it's worth: a policy activation round-trips in ~300 ms.

**One unpublished fact, and it is cheap to get.** Nobody has ever published a port scan, teardown, firmware
dump or LAN capture of an OnlyCat flap — I checked GitHub code search, the whole 82-post HA thread, and
the web. So "the flap exposes nothing on the LAN" is *unproven, not disproven*: it is an inference from
the absence of local-discovery code in cloud clients, which is weak evidence. The owner can settle it in
two minutes on their own hardware ([§14](#14-how-this-gets-verified-and-by-whom)). It almost certainly
changes nothing — but it is the one question where this plan is reasoning from absence, and Nibe's lesson
is that an absence found through one filter is evidence about the filter as much as about the world.

---

## 3. What carries over from `com.nibe.local`, and what changes

### Carried over unchanged

| Convention | Why |
|---|---|
| **TypeScript, SDK 3, Homey Compose.** `app.json` is generated; never hand-edited. Sources are `.homeycompose/app.json`, `.homeycompose/capabilities/*.json`, `.homeycompose/locales/*.json`, `drivers/*/driver.compose.json`, `drivers/*/driver.flow.compose.json`. | The thing that makes the Nibe app maintainable at 280 capabilities. |
| **Engine in `lib/`, model in `drivers/`.** Nothing OnlyCat-version-specific in the engine. | Same seam, same reason. |
| **One data table drives everything.** In Nibe it is the register table. Here it is the **subevent vocabulary** ([§5](#5-the-core-table-the-subevent-vocabulary)). | Flow cards, presence, capability values and i18n keys all resolve through one array, so adding a case is one entry, not five edits. |
| **One shared connection, refcounted by attach/detach.** | Nibe's `PumpConnection` per host. Here: one gateway socket per API key, shared by every flap on that account. A two-flap household must not open two sockets — and since the key is account-wide, a second socket would re-subscribe to the same feed twice. |
| **Custom capability types suffixed `_ONLYCAT`**, official Homey types preferred wherever the semantics genuinely match. | Nibe's rule, verbatim. |
| **Docs split by venue.** `README.md` user-facing with no release notes; `docs/releases.md` the engineering view; `docs/FAQ.md`; `tasks/` for the trail. | The 0.9.13 lesson: the detail was right, the venue was wrong. |
| **Changelog discipline.** `.homeychangelog.json` entries are 2–3 sharp sentences. Delete every clause explaining why or how. When there is nothing the owner must do, say nothing. | Learned three times in `tasks/lessons.md`. Start with it already learned. |
| **Pre-1.0 means hard cuts.** A capability rename before 1.0 is a rename, not a migration. | The user's standing policy, and it is a function of the version, never of the install count. |
| **Six languages from day one** — `en`, `sv`, `de`, `nl`, `no`, `da`, at full parity. | Nibe ships six and advertises six. The string set here is an order of magnitude smaller, so parity is cheap now and expensive to retrofit. OnlyCat's market is UK/DE/NL-heavy; English-only would be a real gap. |

### Deliberately changed

| Change | Why |
|---|---|
| **`npm run lint` goes *in* CI.** | Nibe excludes it because the codebase is 4-space and `eslint-config-athom` wants 2, so it fails repo-wide on untouched files and is not a signal. That is a legacy-formatting problem a **new repo does not have**. Adopt `eslint-config-athom` from the first commit and gate on it. This is the lesson applied, not the workaround copied. |
| **No module-level connection registry.** Nibe keeps `connections` in a module-level `Map`. | Athom's Homey Cloud guidance is explicit: *"Avoid global variables due to multi-tenancy — use instance properties instead."* Hang the registry off the `App` instance. Costs nothing, and keeps the cloud door open ([§11](#11-decisions-to-confirm)). |
| **No app settings page.** Nibe has `settings/index.html` for the alarm log. | Custom app settings views are **prohibited on Homey Cloud** — *"Information should be requested during device pairing instead."* Everything configurable goes in pairing and Repair. Same reason. |
| **`this.homey.setTimeout` / `setInterval` everywhere, never the globals.** | Cloud requirement; also just correct — they clean up on unload. |
| **No `homey:manager:api` permission.** Nibe needs it to read other devices' sensors. This app needs nothing outside itself. | It is one of the permissions Homey Cloud forbids, and an app should not ask for what it does not use. |
| **No subnet sweep, no mDNS, no discovery at all.** | There is no local device to find. Pairing is: paste an API key, pick what you found. |

---

## 4. The device model

**One driver, `cat_flap`. One device is one cat flap.** `data.id` is the OnlyCat `deviceId`
(e.g. `OC-8C1F6448ABCD`). Default name is `Device.description`, falling back to OnlyCat's own
`humanHash` ("Warm Tabby Hatch") — it is in the shared models and it beats "OnlyCat 1".

### What the device does

Five jobs, and every capability below exists to serve one of them:

| | Job | Carried by |
|---|---|---|
| 1 | **Assign door policies** | `policy_ONLYCAT` picker → `activateDeviceTransitPolicy` |
| 2 | **Detect transits**, with the cat's name or "unknown" | `TRANSIT` subevents → Flow triggers, `last_event_ONLYCAT`, `cat_home_ONLYCAT.<id>` |
| 3 | **Detect refusals, with the reason** | `DENY` subevents → `last_blocked_ONLYCAT` + a `reason` Flow token ([§6](#6-lock-state-and-the-reason-a-cat-was-turned-away)) |
| 4 | **Detect peeks** (a look, no transit) | `PEEK` subevents → Flow trigger, `last_event_ONLYCAT` |
| 5 | **Report lock state** | `locked`, computed ([§6](#6-lock-state-and-the-reason-a-cat-was-turned-away)) |

`BREACH` — a cat forcing through a locked flap — is not on that list but is kept anyway: it is in
OnlyCat's own vocabulary, it is the one event an owner would most want a notification for, and dropping
it would mean silently discarding a subevent the API sends.

### Capabilities

| Capability | Type | Notes |
|---|---|---|
| `locked` | **official**, `setable: false` | Job 5. See the note below on why this is the official capability and not a custom one. |
| `policy_ONLYCAT` | custom enum, picker, setable | Job 1, and the tile's **quick action**. |
| `alarm_motion` | official | An event is in progress: set on `deviceEventUpdate`, cleared when `frameCount` is set. |
| `alarm_prey_ONLYCAT` | custom bool | `eventEffectiveClassification === Contraband`. Custom rather than `alarm_problem`: prey is not a device fault, and a specific title reads better than "Problem". |
| `alarm_human_ONLYCAT` | custom bool | `eventEffectiveClassification === HumanActivity`. |
| `alarm_connectivity` | official | `Device.connectivity.connected === false`, paired with `setUnavailable()`. |
| `last_event_ONLYCAT` | custom string, sensor | Job 2/4 — the last thing that happened, in words: "Misan came in". Rendered from the vocabulary table ([§5](#5-the-core-table-the-subevent-vocabulary)) in the flap's own time zone. |
| `last_blocked_ONLYCAT` | custom string, sensor | Job 3 — the last refusal *and why*: "Misan was turned away — she was carrying something." |
| `cat_home_ONLYCAT.<id>` | custom bool, one per tracked cat | Which cats are in. See below. |
| `button.unlock` | official sub-capability | `runDeviceCommand { command: "unlock" }`. |
| `button.reboot` | official sub-capability | `runDeviceCommand { command: "reboot" }`. |

The two string capabilities follow Nibe's `alarm_text_NIBE` precedent — surface an unordered, categorical
fact as **text, not a number**, so Homey does not auto-generate meaningless "becomes greater than" Flow
triggers for it.

Read-only informational values — firmware channel, time zone, device id, MAC — go to **`label` settings**
declared in `driver.compose.json`, not capabilities. Nibe's rule, same reason.

### Cats are capability instances, not devices

One boolean per tracked cat: `cat_home_ONLYCAT.c956000015949802`, titled with the cat's name. `true` =
inside, `false` = outside, **`null` = not yet known** — a real state, since `RfidLastSeen.location` is
nullable and a fresh install knows nothing until the cat moves.

This is the Nibe capability-instance pattern (`measure_temperature.i1_outside` plus per-instance
`capabilitiesOptions`), with one difference that drives the design: **the instances are not known until
runtime.** Four consequences, three of which are Nibe lessons arriving early:

- **The sub-id is prefixed `c`, not the bare chip number.** Chip codes are 15 digits, and a leading digit
  is exactly what broke the HA integration's entity ids (issues #127 and #190: `77200009910828_tracker`
  cannot be dot-accessed in a template, and HA now warns the id will stop working in 2027.2). Homey may
  well tolerate it; the prefix costs one character and removes the question. **Verify both ways before
  relying on either answer.**
- **`setCapabilityOptions()` must be called explicitly after `addCapability()`.** Nibe learned this the
  expensive way: `addCapability()` applies only the base type's defaults, not per-instance options. Here
  there is no compose declaration to fall back on at all, so the cat's name *only* appears if we push it.
- **An Insights log's display name is snapshotted the first time that capability id is ever added, and
  never changes** — not via `setCapabilityOptions()`, not by removing and re-adding the id. So a cat
  renamed in the OnlyCat app keeps its old name in Insights forever, and since the sub-id is the chip
  code, "rename to a new id" is not available either. **Decision: accept and document.**
- **New cats do not auto-appear.** A neighbour cat that peeks once must not mint a permanent capability.
  The tracked set is `store.cats`, chosen during pairing and changeable via **Repair** — the direct
  analogue of Nibe's feature-group selection. Cats OnlyCat itself has hidden (`RfidLastSeen.hiddenAt`,
  precisely the platform's neighbour-cat mechanism) are excluded by default. An untracked cat still fires
  the "An unknown cat used the flap" trigger, so nothing is silently swallowed — and that trigger is how
  you learn there is someone new to add.

`syncCapabilities()` reconciles the capability list against `store.cats` at `onInit` and after Repair.
Nibe's version is split into a testable `capabilitySyncPlan()`; do the same.

### Device class: `lock`

**Settled: `lock`, with the official `locked` capability made read-only.** This reverses a `sensor`
recommendation earlier in this plan, on new evidence rather than on preference.

The `sensor` argument was that the class drives **Zone Flow membership and voice-assistant mapping** —
Athom: *"your device will be automatically included if it has both the `onoff` capability and the `light`
class"* — so declaring `lock` would enrol the flap in "lock everything" Flows and "lock the back door"
voice commands that a read-only lock cannot honour. That reasoning had a hidden premise: that `locked`
would have to be a *custom* capability because the official one is setable and we cannot honour a
`set(true)`.

The premise is false. **`capabilitiesOptions` accepts `setable: false` per instance** — `com.nibe.local`
already does exactly this on four capabilities (`status_NIBE.i1100_compressor_status` and three others
carry `{"setable": false, "getable": true}`). So the flap can carry the *official* `locked` capability,
declared read-only.

That makes `lock` the right class, and it is now the better one:

- **The connotation is exactly right.** A cat flap locks and unlocks, and it does so per individual —
  which is what `lock` means on a smart lock with user codes. Nothing else in Homey's 74 classes says
  that.
- **The official capability pays for itself.** `locked` ships titles in 13 languages, Insights labels
  ("Locked" / "Unlocked" rather than "true" / "false"), and its own `$flow` triggers. A custom
  `locked_ONLYCAT` would mean re-translating and re-declaring all of it, worse.
- **The Zone-Flow risk is contained by the same mechanism.** Athom's rule is capability **and** class.
  A Zone "lock all" card sets `locked`; ours is not setable, so it should be skipped — this is the
  expected behaviour, **not a verified one**, and it goes on the hardware checklist along with what
  Google Assistant does with a non-setable lock. If it turns out a Zone card does try and fail, the
  fallback is a custom `locked_ONLYCAT` and class `sensor`, which is a one-release change.

Two details that follow:

- **`locked` gets `uiQuickAction: false`.** The quick-action slot belongs to the policy picker, which is
  the real control. This is the hot-water lesson from Nibe applied directly: *"Hot water had
  `uiQuickAction` pinned to 'More hot water', which displaced the enable toggle from that one slot. The
  class was never involved."* One slot, spend it deliberately.
- **`lock` becomes fully honest the day `locked` becomes setable**, which needs policy writing
  ([§12](#12-explicitly-out-of-scope-for-v010)). `set(false)` already has a real implementation
  (`runDeviceCommand unlock`); it is `set(true)` that has no command behind it, which is why the
  capability is read-only rather than half-working.

Rejected alternatives, for the record: `camera` (means *security camera*; OnlyCat serves per-event clips,
never a live view — overclaiming a live feed is worse than under-claiming), `garagedoor` (a door you open
and close via `garagedoor_closed`; we do neither), `petfeeder` (the only pet class, wrong appliance),
`sensor` / `other` (honest, but say less than `lock` does). Homey has no `petflap` or `petdoor` class — I
checked all 74.
## 5. The core table: the subevent vocabulary

Nibe's engine is driven by one `Register[]`. This app's engine is driven by one `SubEventKind[]` in
`lib/events.ts`, and everything downstream resolves through it: Flow card ids, `cat_last_action_ONLYCAT`
enum values, the presence effect, and the i18n keys.

The vocabulary is **not invented** — it is OnlyCat's own. `PushNotificationConfig.ts` defines exactly
these nine keys, which is the platform's own answer to "what does a household care about":

```
transit.inward   transit.outward
peek.inward      peek.outward
deny.inward      deny.outward
breach.inward    breach.outward
contraband
```

Each entry carries: `action` (`TRANSIT | PEEK | DENY | BREACH`), `direction` (`INWARD | OUTWARD`), the
resulting cat location, an `en`/`sv`/`de`/`nl`/`no`/`da` phrase, and whether it gets its own Flow trigger.

The location column comes from `getRfidLastSeenLocationFromSubevent()` in `RfidLastSeen.ts` — OnlyCat's
own function, which is **not** what the HA integration implements:

| Action | Inward → | Outward → |
|---|---|---|
| `TRANSIT` | inside | outside |
| `BREACH` | **inside** | **outside** |
| `PEEK` | outside | inside |
| `DENY` | outside | inside |

`PEEK` and `DENY` invert because the cat looked or was refused and therefore *stayed where it was*. The HA
integration treats everything that is not `TRANSIT` as the inverse, which makes a `BREACH` inward — a cat
that forced its way in — mark the cat as **outside**. Use the vendored OnlyCat function. A unit test
asserts all eight combinations against it.

---

## 6. Lock state, and the reason a cat was turned away

These are one problem, not two. The API reports neither, and both fall out of the same simulation.

`LockState` exists (`Unknown/Locked/Unlocked/LongTermUnlocked`) but only inside `FrameMetadata`, the
per-frame device state — and **no documented socket event delivers it**. The flap evaluates its own
transit policy locally, on every frame, so any client wanting a lock state must re-implement that rule
engine in `lib/policy.ts`. The HA integration does the same.

The good news: unlike most of this API, the policy format **is** properly documented — OnlyCat publishes
a canonical draft-07 JSON Schema at <https://www.onlycat.com/door-policy-schema/> with prose semantics.

### Evaluation

1. Walk `rules` in order. **First match wins** — OnlyCat: *"For as long as a rule is matching, the rules
   below it will not be evaluated."*
2. Skip a disabled rule.
3. Skip a rule whose criteria we cannot evaluate client-side. `flapState` and `motionSensorState` are
   live frame data we do not have; `action.lockoutDuration` (the flap locks for N ms and stops
   evaluating) and `action.final` are behaviours we cannot reproduce. **These skips are the whole
   difficulty — see below.**
4. Criteria we *can* match: `eventTriggerSource`, `eventClassification`, `rfidCode` (any overlap),
   `timeRange` (`"HH:MM-HH:MM"`, evaluated in `Device.timeZone`, wrapping over midnight).
5. Match → `action.lock ? Locked : Unlocked`.
6. No match → `transitPolicy.idleLock ? Locked : Unlocked`.
7. `EventTriggerSource.Remote` short-circuits to unlocked — the owner pressed the button.

**`idleLock` defaults to `true`.** `TransitPolicy.ts` says `idleLock ?? true`; the HA integration reads
`api_policy.get("idleLock", False)` — the opposite. A policy omitting the field therefore reads as
*unlocked* in HA and *locked* on the platform. On a lock, that is a fail-open divergence. Take the
server's default.

**`determinePolicyResult()` returns which rule matched, not just the verdict** — `{ result, ruleIndex,
rule, confident }`. That extra return value is the entire reason feature, and it is why this is one
module and not two.

### The reason

> *"Detect blockers — times when the flap decided not to open, and ideally the reason."*

A `DENY` subevent tells you a cat was refused. It does not tell you why, and "why" is the whole value:
a refusal at 3am under a curfew is working as intended, and a refusal of your own cat at noon is
something you want to look at. This is Nibe's `reason.ts` for a cat flap, and it carries the same
lesson:

> *"When the deliverable is an explanation, the interpretation is the deliverable. Shipping the raw
> inputs and leaving the reader to infer the conclusion is not a partial answer, it's a non-answer."*

So `lib/reason.ts` takes the matched rule plus the event's classification, trigger source, chip code and
local time, and returns one sentence naming the rule that fired and the two or three facts that justify
it:

| What matched | Sentence |
|---|---|
| `eventClassification: Contraband` | "Misan was turned away — she was carrying something." |
| `timeRange` | "Misan was turned away — the curfew locks the flap between 22:00 and 07:00." |
| `rfidCode` with no match | "An unknown cat was turned away — only registered cats may come in." |
| `rfidCode` naming this cat | "Misan was turned away — she is not allowed in at the moment." |
| Fell through to `idleLock` | "Misan was turned away — the flap is locked when nothing else applies." |

### The honesty constraint, which is the hard part

**Our simulation can be confidently wrong**, and a confidently wrong explanation is worse than no
explanation. If any rule *above* the one we matched is one we had to skip at step 3, then the real flap
may have matched that one instead, and our sentence names the wrong cause.

So `determinePolicyResult()` carries a `confident` flag: false when any skipped rule precedes the match,
or when the fallthrough was reached past a skipped rule. When it is false, the app says so rather than
guessing:

> "Misan was turned away. This flap's rules depend on its own sensors, so the app can't tell you which
> one refused her."

That is a worse sentence and the right one. It is also directly Nibe's lesson about register 2727 —
*"a register's documentation tells you it exists, never that it is wired up"* — in a different costume:
the policy tells us the rules exist, not which one the firmware actually fired.

**This module gets exhaustive unit tests before it gets a capability**, including the un-confident paths.
It is the one place in the app where we are re-implementing someone else's engine and asserting a
conclusion about their hardware's behaviour.

---
## 7. The OnlyCat type contract

`onlycat-shared-models` is public TypeScript, which is unusually lucky for a Homey app. It is not on npm
and it is consumed upstream as a git submodule — neither of which packages cleanly into a Homey app
bundle.

**Vendor it.** `lib/onlycat/` holds a trimmed copy: the enums, the string-union types and the two pure
functions we depend on (`getRfidLastSeenLocationFromSubevent`, `Device.expandMacId`/`humanHash`), each
with the upstream commit SHA in a header comment. The classes with their `[key: string]: any` escape
hatches are not vendored; we write narrow interfaces for what we read.

`dev/check-models.mjs` refetches upstream and diffs against the vendored copy, reporting drift. Run by
hand at release time, the way `dev/audit-registers.mjs` is in Nibe. A test asserts our enum values equal
the vendored ones, so a sync that silently changes a number fails loudly instead of quietly.

---

## 8. The connection layer (`lib/gateway.ts`)

**Transport, verified directly against the gateway rather than assumed:**

```
GET https://gateway.onlycat.com/socket.io/?EIO=4&transport=polling
0{"sid":"…","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}

GET …?EIO=3…  →  400
```

Engine.IO **v4**, so the Node client is `socket.io-client@4.x`. Ping every 25 s, 20 s timeout, 1 MB max
payload. Polling is available and upgrades to websocket; we force `transports: ['websocket']` as both
other integrations do, with polling as a documented fallback if a user's network blocks it.

```ts
io('https://gateway.onlycat.com', {
  transports: ['websocket'],
  auth: { token: apiKey },
  extraHeaders: { platform: 'homey', device: 'com.onlycat.cloud' },
})
```

The `platform`/`device` headers are how OnlyCat sees which integration is talking to it. Both existing
clients set them; setting ours honestly is good citizenship and costs nothing.

**Requests** use `socket.emitWithAck()` (socket.io ≥ 4.6) with an explicit timeout. We do **not** copy the
HA client's design where a reply is also fanned out to the listener registry under the request's name —
that exists because python-socketio's ergonomics pushed it there, and it makes every call site handle its
answer twice.

**Reconnection.** socket.io's own, with backoff, infinite attempts. The abandoned Homey app capped at 10
attempts × flat 5 s, so a one-minute ISP blip bricked it permanently — do not repeat that.

**The watchdog, translated.** Nibe watches for a socket that is open but answering nothing, because Modbus
has no liveness signal. Engine.IO's ping/pong already covers that case here. The failure mode that
*survives* it is different and specific: **the socket reconnects, but the server-side subscriptions do
not.** So:

- Re-send every `getDevice` / `getDeviceEvents` with `subscribe: true` on **every** `connect`, not just
  the first.
- Probe with `getDevices` after resubscribing. If the probe fails, mark devices unavailable rather than
  leaving them looking healthy with frozen values — which is precisely the symptom Nibe's watchdog exists
  to prevent.

**Auth failure is a distinct state, and it does not look like one.** A bad key **does not fail the socket
connect** — the handshake succeeds and the *first RPC ack* comes back `{ code: 401 }`. So the connection
is not "up" until a `getDevices` probe has answered. Treat a 401 as terminal: mark the devices unavailable
with a message naming the fix ("Open Repair and paste a new API key"), and stop reconnecting until the key
changes. Retrying a revoked key forever is pointless and rude to someone else's server.

**Timeouts are expected, not exceptional.** `getDeviceTransitPolicies`, `getDeviceTransitPolicy`,
`getDeviceRebootLogs` and `getDeviceTelemetryMetrics` are all known to hang — the HA integration wraps
every one of them in a `TimeoutError` handler. Every `emitWithAck` gets an explicit timeout; a timeout
degrades that one value, never the connection.

**Rate limits are undocumented.** No published quota, no `429` handling in any client, no `Retry-After`.
Be conservative by default: one subscription set per account, no polling loops in v0.1.0, everything
event-driven.

### The event pipeline

This is the part that is easy to get wrong, because **a `DeviceEvent` on its own cannot tell you whether
the cat got in.** Allow-vs-deny lives only in the *summary*. OnlyCat's own developer discussion is the
record of this being the API's headline gap, and `getEventSummary` is the fix.

```
deviceEventUpdate {deviceId, eventId, body:{accessToken}}      ← a flap event started
  ├─ getEvent        {deviceId, eventId, subscribe:true}       → classification, frameCount, poster frame
  └─ getEventSummary {deviceId, eventId, accessToken, …}       → subevents: action × direction × rfidCode
eventUpdate         → event progressed;  frameCount set ⇒ concluded
eventSummaryUpdate  → summary progressed; processedFrameCount === frameCount ⇒ FINAL
```

Three traps in that diagram:

- **`frameCount === null` means the event is still in progress.** `rfidCodes` is usually `[]` at that
  point — chip reads arrive late. Never treat the first push as complete.
- **A summary is provisional until `processedFrameCount === frameCount`, and it can change.** A `TRANSIT`
  can be demoted to a `PEEK` when the cat thinks better of it. See decision E.
- **`eventSummaryUpdate` sometimes arrives with no `body` at all**, and `eventUpdate` may carry
  `deviceId`/`eventId` *only* inside `body`. Read top-level, fall back to `body`, tolerate neither.

Server pushes are **invalidation signals, not data**. Both the HA integration and the ioBroker adapter
re-fetch rather than trusting a pushed `body`; we do the same.

**Key storage.** The API key goes in the device **`store`**, not `settings` — `settings` renders in the
device UI, and this key has full account access. Changing it is a Repair flow. With two flaps, both
devices carry the same key and rotating it means repairing each; acceptable at v0.1.0, noted in the FAQ.

---

## 9. Bugs to not inherit

The official HA integration is the best reference available and it has confirmed defects. Starting past
them is free. Each becomes a test.

| | Trap | What we do |
|---|---|---|
| 1 | `EventTriggerSource.Manual = 0` and `EventClassification.Unknown = 0` are **falsy**. HA parses with `if trigger_source`, so every manually triggered event loses its trigger source, then dereferences `None`. | Never test these for truthiness. `!= null`, always. |
| 2 | `idleLock` server default is `true`; HA defaults it to `false`. | Take the server's default ([§6](#6-lock-state-and-the-reason-a-cat-was-turned-away)). |
| 3 | Presence from a subevent: `BREACH` is a transit, `PEEK`/`DENY` leave the cat on the far side. HA gets `BREACH` backwards. | Use OnlyCat's own function ([§5](#5-the-core-table-the-subevent-vocabulary)). |
| 4 | `FlapState.Unknown = -1`, not `0`. HA's `EventFlapstate` has no `UNKNOWN` member at all, so its `_missing_` handler raises `AttributeError` on a real `-1`. | Vendor the enum with `-1` present. |
| 5 | `RfidLastSeen.lastSubevent` is nullable. HA passes it straight into a parser that assumes a dict. | Guard it. |
| 6 | Events can arrive out of order. | Guard on `eventId` monotonicity before overwriting state. |
| 7 | `DeviceEvent.accessToken` is nullable, and it is required for the summary request and the video URL. | Treat its absence as "no media", not as an error. |
| 8 | `eventManualClassification` overrides `eventClassification` — the model exposes `eventEffectiveClassification` for exactly this. | Use the effective value everywhere; an owner who corrected a misclassification in the app should not keep getting prey alerts. |
| 9 | `TransitPolicyRuleAction.final` exists and HA never parses it. | Parse it, even though v0.1.0 does not write policies. |
| 10 | Every enum needs an unknown fallback. `EventClassification` has a **gap at 5–9** with `RemoteUnlock = 10`; never assume contiguity. | A value we do not recognise degrades to unknown and logs once, never throws. |
| 11 | `connectivity.timestamp` and `disconnectReason` **go missing after ~an hour** of disconnection — documented in the model. Absence is not "just connected". | Never infer state from a missing timestamp. |
| 12 | `DeviceRebootLog.isError === null` means *"the device did not report it"*, **not** *"this was not an error"*. | Three-state, not boolean. |
| 13 | Events carry `paymentRequired?: boolean` — a device without an active plan can have its events gated. | Surface it as a clear device-unavailable message rather than an unexplained empty feed. |
| 14 | The API has **no version** anywhere — no URL segment, no handshake param, no header. It changes without deprecation: `getDeviceErrorLogs` was renamed to `getDeviceRebootLogs` with a different row shape and no notice. | Assume nothing is stable. `dev/check-models.mjs` and a tolerant parser are the defence. |

---

## 10. Flow cards

Every card lives on the flap device now. **The cat is an argument, not a device** — which is the
better shape anyway: one "Cat came in" card with a cat picker beats N cards you have to keep in sync
with your pets.

| Kind | Card | Arguments | Tokens |
|---|---|---|---|
| Trigger | A cat came in | `cat` (autocomplete, default **any**) | cat name, chip code, classification, **image** |
| Trigger | A cat went out | `cat` (autocomplete, default **any**) | cat name, chip code, classification, **image** |
| Trigger | A cat was turned away | `cat` (autocomplete, default **any**) | cat name, chip code, direction, **reason**, **image** |
| Trigger | A cat looked but did not come through | `cat` (autocomplete, default **any**) | cat name, chip code, direction, **image** |
| Trigger | A cat forced the flap | `cat` (autocomplete, default **any**) | cat name, chip code, direction, **image** |
| Trigger | **Prey detected** | — | cat name, chip code, **image** |
| Trigger | An unknown cat used the flap | — | chip code, action, direction, **image** |
| Trigger | Something happened at the flap | `action` (any / came in / went out / looked / was turned away / forced through), `cat` (autocomplete, any) | cat name, chip code, action, direction, classification, trigger source, **image** |
| Condition | A cat is home | `cat` (autocomplete) | |
| Condition | The flap is locked | — | |
| Condition | The door policy is … | `policy` (autocomplete) | |
| Action | Unlock the flap | — | |
| Action | Switch the door policy to … | `policy` (autocomplete) | |
| Action | Mark a cat as home / out | `cat` (autocomplete), `where` (home/out) | |
| Action | Reboot the flap | — | |

The `cat` autocomplete lists the tracked cats by name, plus an **Any cat** entry — and it is AND-ed
with `store.cats`, exactly as Nibe AND-s its register autocompletes with the device's feature selection.
`registerAutofillFlow()` in Nibe's `lib/driver.ts` is the shape to copy.

The five specific action cards are deliberate redundancy with the generic "Something happened at the
flap". The generic card is complete; the specific ones are what someone actually reaches for, and a Flow
editor is a place where obvious beats minimal. Nibe made the opposite call because it had ~280 registers
and one card per register was untenable. Five is not 280.

**The `reason` token is the one worth building the release around.** "A cat was turned away" with a
reason you can drop into a notification — *"Misan was turned away — she was carrying something"* — is a
sentence no other OnlyCat integration produces, on any platform. See
[§6](#6-lock-state-and-the-reason-a-cat-was-turned-away) for how it is derived and, more importantly, for
when it refuses to guess.

Every arg-bearing card gets `titleFormatted` — its absence is an App Store validation failure, and it is
one of the things that would have failed the abandoned app at review.

**The image token.** `this.homey.images.createImage()` + `setStream()` fetching
`https://gateway.onlycat.com/events/<deviceId>/<eventId>/<frame>`, where `frame` is
`posterFrameIndex ?? (frameCount / 2) ?? 1`. Still frames are unauthenticated and unsigned — no token, no
expiry. Images are capped at 5 MB, which a single JPEG frame will not approach.

"Mark a cat as home / out" exists because presence drifts — a cat that got in through a window is the
classic case — and it is what the HA integration's `set_pet_location` service is for. v0.1.0 applies it
**locally** to the capability. `RfidLastSeen` carries `locationSource: "MANUAL"` and
`locationUpdatedByUserId`, which strongly implies the platform accepts a write, but no published client
performs it and the verb name is unverified — so v0.1.0 does not claim to push it upstream. Finding it is
a task ([§13](#13-checklist)).

---
## 11. Decisions

Settled 2026-09-19 unless marked open.

**A. Homey Cloud support — OPEN.** This app has zero local dependencies, so `platforms: ["local",
"cloud"]` is technically available and roughly doubles the addressable audience. It requires a *Homey
Verified Developer* subscription to publish, and forbids app settings pages, `homey:manager:api`, app Web
APIs and global state.

→ **Standing recommendation:** build to every cloud constraint from the first commit (they are all good
practice anyway — see [§3](#3-what-carries-over-from-comnibelocal-and-what-changes)) but ship v0.1.0 as
`["local"]`. Flipping the flag later is one line if the constraints were respected from the start, and an
expensive rewrite if they were not. **Proceeding on this basis** — it costs nothing and preserves the
option — but the "should we actually publish for Cloud" question is still yours to answer.

**B. Analytics — DECIDED: skip for now.** No Amplitude in v0.1.0, no `lib/analytics.ts`, no consent
checkbox in pairing. When it is added later it is its own change, with the `docs/analytics-taxonomy.md`
port as its own commit across all three repos — that file is byte-identical in `com.nibe.local` and
`com.homevolt.local` and must never be edited in one alone.

> One thing to get right *now* because it is free now and awkward later: the taxonomy's `role` property
> would have taken values `flap` and `cat` under the old per-cat device model. Under the per-device model
> there is only one role, and *"a property with one value is noise, not a dimension"* — the taxonomy says
> exactly that about `role` on Nibe's alarm event. So when analytics does arrive, this app contributes no
> `role` at all. Worth writing down before the reasoning is lost.

**C. Device class — DECIDED: `lock`, with the official `locked` capability made read-only.** Full
reasoning and rejected alternatives in [§4](#4-the-device-model).

> This went `lock` → `sensor` → `lock`. The middle step was not noise: `sensor` was right *given the
> premise that `locked` had to be a custom capability*, because the class drives Zone Flow membership and
> voice mapping, and declaring `lock` would have enrolled the flap in "lock everything" Flows it could not
> honour. The premise turned out to be false — `capabilitiesOptions` takes `setable: false` per instance,
> as `com.nibe.local` already does on four capabilities — so the flap can carry the *official* `locked`
> declared read-only, and Athom's capability-**and**-class rule contains the Zone-Flow risk by the same
> mechanism. Recorded because the losing argument is still the reason the fallback exists: if a Zone card
> turns out to target a non-setable `locked` anyway, `sensor` plus a custom `locked_ONLYCAT` is the
> one-release retreat.

**D. API key scope — DECIDED: say it plainly.** OnlyCat's own docs: *"API keys have full access to your
OnlyCat account."* No code change, but the pairing view states this and tells the user to mint a
Homey-only key so it can be revoked without collateral damage.

**E. Provisional summaries — DECIDED: fire on final only.** A summary is not final until
`processedFrameCount === frameCount`, and it genuinely changes — *"a `TRANSIT` may be demoted to a `PEEK`
if the cat retreats"*. Homey Flow has no way to un-fire a trigger, so a correct notification a few seconds
late beats a wrong one that stands forever. `alarm_motion` still goes true on the *first* push, so the
tile reacts immediately; the latency applies only to cards that make a claim about which cat did what.
If hardware testing shows "final" lags badly, the fallback is firing provisionally plus a "still true at
the end" condition — a v0.2.0 shape, not a v0.1.0 one.

---
## 12. Explicitly out of scope for v0.1.0

Named so that "not yet" is a decision rather than an oversight.

- **Video / HLS clips.** The gateway serves them (`/sharing/video/<deviceId>/<eventId>?t=<accessToken>`),
  but Homey has no clean HLS camera story. Still frames only.
- **Editing door policies** (`updateDeviceTransitPolicy`). Read and activate only. Writing a policy we
  cannot fully evaluate client-side is a way to break someone's cat flap.
- **Sounds.** `ux.onActivate.sound` takes one of nine values (`affirm`, `alarm`, `angry-meow`, `bell`,
  `choir`, `coin`, `deny`, `fanfare`, `success`) and `angry-meow` on an intruder cat is a genuinely funny
  Flow. But setting it means writing a policy, which is the line above.
- **Activity statistics.** `ActivityStats.ts` exposes daily and monthly rollups per cat — transits in/out,
  peeks, denies, breaches, prey attempts, a 24-hour histogram. This is a genuinely good future feature and
  a whole release of its own.
- **Telemetry metrics and reboot logs.** Device errors surface as `alarm_connectivity` only.
- **Editing pet profiles / RFID labels.** The official HA integration does not do it either.
- **Analytics** (decision B), **Homey Cloud** (decision A).
- **One Homey device per cat.** Considered and rejected — see [§2](#2-what-v010-is). Not "later": the
  per-device model is the intended shape, and cats belong on the flap.

---

## 13. Checklist

### Scaffolding
- [ ] `git init`; MIT `LICENSE`; `.gitignore`, `.homeyignore`, `.eslintrc.json` (`eslint-config-athom`)
- [ ] `package.json` — `socket.io-client@^4`, `typescript`, `tsx`, `@types/homey`, `eslint-config-athom`
- [ ] `tsconfig.json` + `tsconfig.test.json`, mirroring Nibe's split (app excludes `test/`; tests
      type-checked separately because `tsx` strips types without checking them)
- [ ] `.homeycompose/app.json` — id, `version: 0.1.0`, `sdk: 3`, `platforms: ["local"]`, category,
      brand colour, author, six-language description
- [ ] `.github/workflows/ci.yml` — typecheck app, typecheck tests, **lint**, test, `homey app validate
      --level publish`
- [ ] `CLAUDE.md` — conventions, release steps, sharp edges
- [ ] App and driver assets (icon, small/large/xlarge)

### Engine
- [ ] `lib/onlycat/` — vendored enums, types and pure functions, with upstream SHAs
- [ ] `lib/events.ts` — the subevent vocabulary table ([§5](#5-the-core-table-the-subevent-vocabulary))
- [ ] `lib/policy.ts` — transit-policy evaluation, returning `{result, ruleIndex, rule, confident}`
      ([§6](#6-lock-state-and-the-reason-a-cat-was-turned-away))
- [ ] `lib/reason.ts` — the matched rule rendered as one sentence, in six languages, with the
      un-confident fallback
- [ ] `lib/presence.ts` — subevent → cat location, aggregated across every flap on the account
- [ ] `lib/gateway.ts` — socket, auth, RPC with per-call timeouts, resubscribe on `connect` **and**
      `userUpdate`, 401-on-first-RPC handling, attach/detach refcount, injectable base URL so tests can
      point it at localhost
- [ ] `lib/event-store.ts` — the `deviceEventUpdate` → `getEvent` + `getEventSummary` pipeline, provisional
      vs final summaries, `eventId` ordering guard, missing-`body` tolerance
- [ ] `lib/driver.ts`, `lib/device.ts` — lifecycle, `capabilitySyncPlan()` + `syncCapabilities()` for the
      per-cat capability instances; `drivers/cat_flap/` — the thin model subclass

### Surface
- [ ] `.homeycompose/capabilities/*.json` — `alarm_prey_ONLYCAT`, `alarm_human_ONLYCAT`,
      `policy_ONLYCAT`, `cat_home_ONLYCAT`, `last_event_ONLYCAT`, `last_blocked_ONLYCAT`
      (`locked` is official — no definition needed, only `capabilitiesOptions`)
- [ ] `drivers/cat_flap/driver.compose.json` — `class: "lock"`, `locked` with
      `{"setable": false, "uiQuickAction": false}`, capability superset,
      `capabilitiesOptions`, label settings. The `cat_home_ONLYCAT.<id>` instances are **not** declared
      here — only their type is; they are added at runtime with `addCapability()` +
      `setCapabilityOptions()`
- [ ] `drivers/cat_flap/driver.flow.compose.json` — the cards in [§10](#10-flow-cards), every arg-bearing
      card with `titleFormatted`
- [ ] Pairing: `api_key` view (paste, test, report the *actual* error — 401 vs network; state that the
      key is account-wide, per decision D) → `list_devices` (the flaps on the account, multi-select) →
      `cats` view (which cats to track, pre-checked, excluding those OnlyCat has hidden)
- [ ] Repair: re-enter the API key, and change the tracked-cat selection
- [ ] Event image wired to the Flow token; **verify whether `setCameraImage` puts it on the tile too** —
      unconfirmed in SDK 3 docs, and the token works regardless
- [ ] `.homeycompose/locales/*.json` at six-language parity

### Verification
- [ ] `test/fake-gateway.ts` — an in-process socket.io server speaking the real message names. This is the
      highest-value test asset in the repo and the direct analogue of Nibe's fake pump: it lets
      `GatewayConnection` be tested end-to-end including reconnect, resubscribe, 401, and out-of-order events.
- [ ] Unit tests: policy evaluation (exhaustive, against the published JSON Schema's own examples),
      **reason rendering including every un-confident path**,
      presence (all eight action × direction pairs), the provisional→final summary transition including a
      `TRANSIT` demoted to a `PEEK`, vocabulary-table invariants, `capabilitySyncPlan()` adding and
      removing cat instances, every Flow card resolving to a live capability, vendored enums matching
      upstream
- [ ] Integration tests against the fake gateway
- [ ] `npm test`, `npm run typecheck`, `npm run lint`, `npx homey app validate --level publish` all green
- [ ] **Hardware checklist run by the owner** — see below

### Open questions to resolve during the build

**Answered already, recorded so nobody re-asks:**
- ~~Battery and signal strength.~~ **Neither exists.** The `Device` model has no `batteryLevel`, `rssi`,
  `signalStrength` or `firmwareVersion` — `connectivity.connected` is a bare boolean and `firmwareChannel`
  is a release channel, not a version. The flap is mains-powered over USB-C with only a small
  shutdown-safety backup, so there is no battery percentage to report even in principle. **Do not add
  `measure_battery` or `measure_signal_strength`.** (A firmware *build number* does exist, but only inside
  `getDeviceRebootLogs` rows.)

**Still open:**
- [ ] Does the gateway accept a write to set a cat's location? `RfidLastSeen.locationSource: "MANUAL"` and
      `locationUpdatedByUserId` say the platform stores one — but no published client performs the write
      and the verb name is unverified.
- [ ] Does a Homey capability sub-id starting with a digit work? We prefix `c` to avoid finding out the
      hard way, but confirm which way it actually goes — it decides whether the prefix stays.
- [ ] Does `policy_ONLYCAT` actually land as the tile's quick action, with `locked` pushed out by
      `uiQuickAction: false`? `ui.quickAction` is the mechanism, and Nibe's experience is that a declared
      value not landing usually has a second writer.
- [ ] **Does a Zone "lock all locks" Flow card skip a device whose `locked` is `setable: false`?** And
      what does Google Assistant / Alexa do with a non-setable lock? This is the one assumption holding up
      `class: "lock"` ([§4](#4-the-device-model)). Expected: skipped, because Athom's rule is capability
      **and** class. If wrong, fall back to a custom `locked_ONLYCAT` and `class: "sensor"`.
- [ ] Confirm `Device#setCameraImage` exists in SDK 3 and what it does to the tile. The image *Flow token*
      is confirmed and works regardless; this is only about the tile.
- [ ] Is `getEvents` (account-wide, rather than per-device `getDeviceEvents`) a simpler subscription for a
      multi-flap household? Only `subscribe` and `limit` are confirmed on the wire, though
      `UserDeviceEventCriteria` implies a richer filter set.
- [ ] The frame-image endpoint appears to need **no authentication at all** — no header, no token, no
      query param, in any client. Confirm whether that is genuinely the case before relying on it, and say
      so in the FAQ either way. It affects what a shared Flow image discloses.
- [ ] OnlyCat publish a client-code reference bundle at
      `media.onlycat.com.s3.amazonaws.com/code/onlycat-client-code-reference.zip`, linked from the HA
      community thread. It is likely the most complete artifact available — probably the app's own request
      list. **Not downloaded: say the word and I'll fetch it.**

---

## 14. How this gets verified, and by whom

**The flap is the user's to probe.** This is the Nibe lesson that costs the most round-trips when it is
forgotten: *"anything that talks to the pump gets written as a `dev/*.mjs` script and handed over as a
command to run."* It applies with more force here, because the credential is an account-wide API key that
belongs to the owner. **Never ask for it; never try to use one.**

So every live question becomes a `dev/*.mjs` script the owner runs, and — per the corollary — a script
that **interprets itself**. A probe that prints a wall of JSON costs several round-trips; one that says
"three policies found, `Night` is active, idleLock is true" costs one.

Planned probes:

- `dev/probe-account.mjs` — connect, `getDevices`, list flaps, cats and policies in plain language
- `dev/watch-events.mjs` — live tail of `deviceEventUpdate` / `eventUpdate` / `eventSummaryUpdate`,
  decoded through the vocabulary table, so the table can be checked against a cat actually walking through
  a door
- `dev/check-models.mjs` — vendored-type drift against upstream
- `dev/scan-flap.mjs` — **one-off**: find the flap's IP (DHCP table, or MAC prefix `8C1F6448…` /
  `0CBFB490…`, both of which are OnlyCat's own IEEE MA-S block registered to VirtualV Trading Ltd) and
  scan it for open TCP ports and mDNS/SSDP advertisements. This is the owner's own device on the owner's
  own network, and it closes the one open question in [§2](#why-cloud-and-not-local). Expected result:
  nothing, confirming the cloud-only architecture. Worth two minutes to know rather than assume — and if
  it *does* answer on something, that is the most interesting finding in this whole plan.

And a hardware checklist in `docs/` covering what only a real flap can answer: does the tile read right,
does the image arrive fast enough to be worth putting in a notification, does the computed lock state
match what the flap actually did, does a policy switch take effect.

---

## Review

*(Filled in when v0.1.0 ships — what changed, what was wrong in this plan, what the hardware said.)*
