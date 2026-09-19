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
- **`locked` is the official capability with `setable: false`** via `capabilitiesOptions`, which is
  what lets the driver be `class: "lock"` honestly. It also carries `uiQuickAction: false` so the
  policy picker owns the tile's quick action. If a Zone "lock all" Flow turns out to target a
  non-setable `locked` anyway, the retreat is a custom `locked_ONLYCAT` and `class: "sensor"`.
- **Cats are runtime capability instances**, `cat_home_ONLYCAT.c<chip>`. Only the *type* is declared
  in compose. Two consequences: `addCapability()` does not apply per-instance options, so
  `setCapabilityOptions()` must be pushed explicitly or every cat is titled "Cat"; and an Insights
  log's display name is snapshotted the first time an id is added and **never changes**, so a cat
  renamed in the OnlyCat app keeps its old name in Insights forever. Accepted and documented.
- **The `c` prefix on the chip code is deliberate** — 15-digit chip codes start with a digit, which
  is exactly what broke the reference implementation's entity ids.
- **Six languages at parity** — `en`, `sv`, `de`, `nl`, `no`, `da`. A test enforces it.
- **`this.homey.setTimeout`, never the global**, and no module-level state. Neither is required
  today (`platforms: ["local"]`), both are required for Homey Cloud, and honouring them now keeps
  that a one-line change.

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
