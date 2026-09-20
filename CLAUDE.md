# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A Homey app for the OnlyCat smart cat flap, talking to OnlyCat's cloud gateway over Socket.IO.
Homey SDK v3, TypeScript, Homey Compose. Conventions follow `com.nibe.local`; the deliberate
departures are noted below.

**There is no local path.** The flap is an outbound-only AWS IoT client and OnlyCat exposes no
local API — the evidence is in [tasks/todo.md](tasks/todo.md) §2. Do not re-litigate this; if it
changes, it changes because OnlyCat shipped firmware, not because we found something.

## Commands

- `npm run build` — `tsc` into `.homeybuild/`.
- `npm run typecheck` — `tsc --noEmit` over the app **and** `tsc -p tsconfig.test.json` over
  `test/`. The second half matters: `npm test` runs through `tsx`, which strips types without
  checking them, so the suite is otherwise compiled by nothing.
- `npm run lint` — ESLint with `eslint-config-athom`. **This is a real gate here**, unlike in
  `com.nibe.local` where it fails repo-wide on legacy 4-space formatting. Keep it green.
- `npm test` — `node --test` over `test/*.test.ts` via `tsx`. **Takes ~45 s**: the integration
  tests drive a real Socket.IO server on loopback and wait on real reconnect timers.
- `homey app run` — run on a linked Homey. Needs the `homey` CLI and `homey login`.
- `homey app validate --level publish` — before every release.

All four are what CI runs (`.github/workflows/ci.yml`).

### The flap is the user's to probe

**Never ask for, or try to use, an OnlyCat API key.** It grants full access to someone's account.
Anything that needs the live API gets written as a `dev/*.mjs` script and handed over as a command
to run. This is `com.nibe.local`'s most expensive repeated lesson, and it applies harder here
because the credential is broader than an IP address.

A probe the user runs blind is worth more when it interprets itself — `dev/probe-account.mjs`
prints "three policies, Night is active, two rules the app cannot evaluate", not a JSON dump.

## Architecture

### Engine in `lib/`, model in `drivers/`

- **`lib/onlycat/models.ts`** — the vendored OnlyCat contract. Enums, string unions and pure
  functions copied verbatim from `OnlyCatAI/onlycat-shared-models` (commit `aecefd5`), with our
  own narrow interfaces for the wire shapes. **This is the only file allowed to restate OnlyCat's
  schema.** The API carries no version of any kind and has renamed a message in place before, so
  `dev/check-models.mjs` diffing against upstream is a release step, not a nicety.
- **`lib/events.ts`** — the subevent vocabulary. The core data table, the way the register table is
  in `com.nibe.local`: Flow card ids, wording, presence effect and i18n keys all resolve through
  it. Adding a case is one entry here. The nine keys are OnlyCat's own, from
  `PushNotificationConfig.ts`.
- **`lib/policy.ts`** — the flap's rule engine, re-implemented. Returns `{result, ruleIndex, rule,
  confident}`.
- **`lib/reason.ts`** — the matched rule rendered as one sentence.
- **`lib/gateway.ts`** — one socket per API key, refcounted.
- **`lib/event-store.ts`** — the `deviceEventUpdate` → `getEvent` + `getEventSummary` pipeline.
- **`lib/cats.ts`** — cats as capability instances, and the sync plan.
- **`drivers/cat_flap/`** — the Homey surface.

### Sharp edges, each of which cost something to learn

- **A bad API key does not fail the handshake.** The socket connects; the *first RPC ack* returns
  `{code: 401}`. Anything treating "connected" as "authenticated" reports success and then
  receives nothing forever.
- **socket.io does not auto-reconnect when the server hangs up.** `reconnection: true` covers
  transport failures only; `io server disconnect` requires an explicit `connect()`. OnlyCat's own
  model documents `disconnectReason: "SERVER_INITIATED_DISCONNECT"`, so this is a real path — a
  deploy on their side would leave every flap dark until the app was restarted by hand. Found by
  the reconnect integration test, which is why that test exists.
- **Subscriptions do not survive a reconnect.** `subscribe: true` on a getter is the only
  subscription mechanism there is, and it is per-socket. Re-arm on every `connect`, then probe.
- **`EventTriggerSource.Manual` is 0 and `EventClassification.Unknown` is 0.** Never test these
  for truthiness — `!= null`, always. The reference implementation's bug, and it silently loses
  every manually triggered event.
- **`idleLock` defaults to `true`**, per `TransitPolicy.ts`. The reference implementation defaults
  it to `false`, which is fail-open on a lock.
- **`BREACH` counts as a transit; `PEEK` and `DENY` leave the cat where it was.** Use
  `locationFromSubevent`, which is OnlyCat's own function. Do not re-derive it.
- **A summary is provisional until `processedFrameCount === frameCount`** and genuinely changes — a
  TRANSIT gets demoted to a PEEK. Flow cards fire on final only; Homey cannot un-fire a trigger.
- **`eventSummaryUpdate` sometimes has no `body`**, and `eventUpdate` sometimes carries its ids
  only inside one. Read top level, fall back to body, tolerate neither.
- **Server pushes are invalidation signals, not data.** Re-fetch rather than trusting a payload.
- **`getDeviceTransitPolicies` and friends hang.** Every RPC gets an explicit timeout, and a
  timeout degrades one value rather than the device.

### Homey specifics

- **`app.json` is generated.** Sources are `.homeycompose/`. Run `homey app build`; never
  hand-edit it. It is committed because the CLI refuses to run without it.
- **`locked` is reported only when the simulation is confident, and `null` otherwise.** The API
  defines `LockState` but only inside `FrameMetadata` — per-frame data captured during an event —
  and no socket message or endpoint delivers it; `Device`, `DeviceEvent` and `EventSummary` carry
  no lock field. So the value comes from re-running the owner's door policy at idle. That is
  legitimate **only** because `PolicyOutcome.confident` gates it: when a rule keyed on `flapState`
  or `motionSensorState` sits above the match, the flap may have stopped there instead, and the
  capability goes to `null` — unknown, not unlocked. Never assert a lock state that flag does not
  support. The `flap_is_locked` condition card throws on `null` rather than silently taking the
  "not locked" branch.
- **`lib/policy.ts` serves both the lock state and the refusal reason**, and both honour
  `confident` the same way. The reason has the extra justification that it is anchored to a `DENY`
  the flap actually sent.
- **`alarm_connectivity` means the FLAP is offline, never that we are.** Its single writer is
  `refreshDevice()`, from the gateway's own `device.connectivity.connected`. Our socket dropping
  is `markUnavailable()` and nothing else. Both used to write it, which made them
  indistinguishable on the tile and fired an alarm Flow on every reconnect blip — and clearing it
  at the top of `refresh()` flickered a genuinely offline flap off and on, two spurious triggers,
  every reconnect. One writer. Do not add a second.
- **A minute timer re-evaluates the lock state.** Time-range rules turn over on the clock, not on
  an event: a curfew starting at 22:00 must show up without waiting for the next cat.
- **`locked` is read-only** — OnlyCat has no "lock now", only policy activation and a one-shot
  unlock — and carries `uiQuickAction: false` so the policy picker keeps the tile's one slot.
  **There are no `button.*` capabilities.** Unlocking is the lock toggle's quick action, and
  rebooting is the `reboot_flap` Flow action — a lone button on a tile full of sensors read as
  leftover scaffolding. Both commands stay automatable.
- **Cats are runtime capability instances**, `cat_home_ONLYCAT.c<chip>`. Only the *type* is declared
  in compose. Two consequences: `addCapability()` does not apply per-instance options, so
  `setCapabilityOptions()` must be pushed explicitly or every cat is titled "Cat"; and an Insights
  log's display name is snapshotted the first time an id is added and **never changes**, so a cat
  renamed in the OnlyCat app keeps its old name in Insights forever. Accepted and documented.
- **The `c` prefix on the chip code is deliberate** — 15-digit chip codes start with a digit, which
  is exactly what broke the reference implementation's entity ids.
- **The still and the clip are separate camera ids**, `still` and `clip`. They shared `event` for
  four builds, on an Athom doc line promising a matching image becomes the video's poster frame.
  That poster frame was never once observed; two rows that refused to play were. Do not re-couple
  them to chase a behaviour nobody has seen.
- **Clips are `createVideoHLS()` + `setCameraVideo()`**. Video landed in Homey **12.7.0**, and
  `compatibility` is `>=12.7.0` rather than degrading on older firmware: this app's whole job is
  showing you what happened at the door. The try/catch stays anyway — `validate` cannot prove
  `homey.videos` exists on **Homey Cloud**, which we have no way to test, and losing clips there
  beats losing the app.
- **A camera entry is keyed by its `id`, its title is set once and never changes, and it cannot
  be removed.** Verified against the live API, after two rounds of guessing wrong. Re-registering
  an id upserts the resource without adding a row; a new title is silently ignored; and `Device`
  has no `unsetCameraImage` (`unregisterImage`/`unregisterVideo` take a resource instance, not a
  camera id). Correcting a title means re-pairing the device. **Never put changing text in a
  camera title** — it freezes on the first value. The time goes on `last_event_ONLYCAT`.
- **An image and a video are two separate entries**, even sharing an id — that is what "two rows
  in the picker" was. Rather than fight it, both are registered and **named for what they are**:
  "Last still image" and "Last clip". Two rows called the same thing tell you nothing.
- **Both entries are registered once, in `onInit`** — `setCameraImage` directly, `setCameraVideo`
  in `registerClips`. `showEvent()` only re-points the image resource. A guard placed in
  `showEvent` is dead code, because init has already registered by the time it runs; that mistake
  shipped once. Before touching this, `grep -n setCamera drivers/cat_flap/device.ts`.
- **The last event is backfilled on connect**, adopted as already-settled so no Flow card fires.
  Without it a freshly started app shows an empty camera until the next cat, which can be hours;
  with it, nobody gets a prey alert about last Tuesday because their Homey rebooted.
- **Homey substitutes `__name__`, not `{{name}}`.** The Mustache spelling is not an error: `homey.__()` does not recognise it and hands back the string untouched, so the tile and every push notification read "{{name}} was turned away" for months without a single failure anywhere. Tests now reject `{{` in any locale and require every language to carry the same placeholders, since a translation that drops one silently loses the cat's name.
- **Six languages at parity** — `en`, `sv`, `de`, `nl`, `no`, `da`. A test enforces it.
- **`platforms: ["local", "cloud"]`.** The app talks to nothing but OnlyCat's API, so it needs no
  local network, no discovery, no app settings page and no permissions — the Homey Cloud
  constraints were honoured from the first commit and `validate --level publish` passes for both.
  **Untested on Cloud**, because Homey Cloud runs only App Store builds: there is no CLI install
  and no `homey app run` to try it with. Publishing for Cloud also needs a Homey Verified
  Developer subscription.
- **`this.homey.setTimeout`/`setInterval`, never the globals**, and no module-level state — the
  gateway registry hangs off the App instance. Both are Homey Cloud requirements.

## Releasing

1. `version` in `.homeycompose/app.json` **and** `package.json`.
2. `homey app build` to regenerate `app.json`.
3. An entry in `.homeychangelog.json`, English and Swedish. **2–3 sharp sentences.** Name what
   changed for the owner and anything they must do, then stop — delete every clause explaining why
   or how. It is a store listing, not release notes. When there is nothing the owner must do, say
   nothing; the null case is silence.
4. A row in `docs/releases.md` — the engineering view. Mechanism, measurements and rejected
   alternatives belong here, not in the changelog.
5. `dev/check-models.mjs` to catch upstream schema drift.
6. Verify: `npm test`, `npm run typecheck`, `npm run lint`,
   `npx homey app validate --level publish`.

**Pre-1.0 means hard cuts.** A capability rename before 1.0 is a rename and nothing else. This is a
function of the version, not of the install count — do not infer otherwise from evidence about
users.
