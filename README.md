# OnlyCat for Homey

**Your cat flap in Homey — who came in, who was turned away, and why.**

A [Homey](https://homey.app/) app for the [OnlyCat](https://www.onlycat.com/) smart cat flap. One
Homey device per flap, with every cat on it, and a snapshot on every Flow card.

---

## What it does

**Tells you which cat, by name.** Every event carries the name you already gave your cat in the
OnlyCat app, plus its chip code. Cats appear as sensors on the flap, so you can see at a glance
who is in and who is out.

**Shows you the picture.** Homey Flow cards can carry an image, so "Prey detected" can put the
actual frame in a push notification. On a flap whose whole job is spotting prey, seeing it is the
point.

**Explains a refusal.** When the flap decides not to open, the app works out which of your door
policy's rules did it and says so in words:

> Misan was turned away — she was carrying something.
> Misan was turned away — the curfew locks the flap between 22:00 and 07:00.

**And admits when it can't tell.** Some rules depend on sensors inside the flap that the API does
not expose. If one of those could have fired first, the app says that instead of guessing:

> Misan was turned away. This flap's rules depend on its own sensors, so the app can't tell you
> which one refused her.

**Switches door policies.** The policies you built in the OnlyCat app appear as a picker on the
tile and as a Flow action, so "curfew at sunset" is one Flow.

## Getting started

You need an **OnlyCat API key**:

1. Open the OnlyCat app on your phone.
2. Go to **Account** and turn on **Developer Mode**.
3. Open **API Keys** and create one for Homey.
4. Copy it — it is only shown once — and paste it when Homey asks.

> **An OnlyCat API key has full access to your OnlyCat account, and there is no way to limit it.**
> Make a key just for Homey so you can revoke that one on its own later.

Then add the device: **Devices → + → OnlyCat → Cat flap**. Homey lists the flaps on the account and
pre-selects the cats OnlyCat knows about, skipping any you have hidden as neighbours' cats.

To change the key later, or pick up a cat you have added since, use the device's **Repair**.

## Flow cards

| | |
|---|---|
| **When** | A cat came in · A cat went out · A cat was turned away · A cat looked but did not come through · A cat forced the flap · Prey detected · An unknown cat used the flap · Something happened at the flap |
| **And** | A cat is home · The flap is locked · The door policy is… |
| **Then** | Unlock the flap · Switch the door policy · Mark a cat as home or out · Restart the flap |

Every "when" card carries a **Snapshot** tag. Drop it into a push notification and the photo comes
with it. "A cat was turned away" also carries a **Reason** tag.

The per-cat cards take **Any cat** or a specific one, so you write one Flow rather than one per pet.

"Mark a cat as home or out" is for when a cat gets in through a window and the app's idea of where
it is drifts. It corrects Homey only; it does not tell OnlyCat.

## Good to know

**This app needs the internet, and so does the flap.** OnlyCat has no local API — the flap talks
only to OnlyCat's own cloud, and so do we. There is no way around this from the outside; OnlyCat
have said a local API is planned, but it does not exist yet.

**Your cats are fine during an outage; Homey just goes quiet.** The flap enforces its door policy
on the device itself, so it keeps letting the right cats in with no internet at all. What stops is
Homey knowing about it — no events, no Flows, and the device shows as unavailable until the
connection comes back.

**Lock state is worked out, not read.** OnlyCat does not report whether the flap is locked, so the
app runs your door policy's rules itself. Rules that depend on the flap's own sensors — flap
position, its motion detectors — cannot be evaluated from outside, which is the same limit behind
the "can't tell you which one" message above.

**Refusal alerts arrive a few seconds late, on purpose.** OnlyCat revises an event while it is
happening: a cat that starts coming through and turns back changes from a transit to a peek. Homey
cannot un-fire a Flow, so the app waits for the final version rather than sending you a correct
notification's wrong first draft. The activity sensor on the tile still reacts immediately.

**Subscription flaps need connectivity for more than notifications** — OnlyCat's own subscription
tier checks its subscription online, and individual events can be gated.

## Which flaps

Any OnlyCat flap on your account. The app reads the account, so a second flap is just a second
device.

## Development

```bash
npm install
npm test           # unit tests + the in-process fake gateway
npm run typecheck  # the app, and separately the test suite
npm run lint
npx homey app validate --level publish
```

`dev/probe-account.mjs` checks a key and describes what Homey would find, without involving Homey:

```bash
node dev/probe-account.mjs oc_live_...
```

`dev/watch-events.mjs` tails a flap and decodes events into English — the way to check behaviour
against a real cat going through a real door:

```bash
node dev/watch-events.mjs oc_live_...
```

Neither script is part of the app bundle.

## Troubleshooting

The device's **Advanced** settings have a **Debug logging** switch. It is off by default, because
on it writes a line for every gateway message and every cat that walks past. Turn it on, reproduce
whatever went wrong, then send the log from **Settings → Apps → OnlyCat**. Errors and connection
changes are logged either way; the switch only adds the per-event detail.

Pairing always logs, because that is the one moment when there is no device yet on which to tick
the box.

`dev/probe-account.mjs` checks a key and describes what Homey would find, without involving Homey
at all — the fastest way to tell an account problem from an app problem.

## Credits

The cat-head mark and the brand colour are OnlyCat's own, taken from
[their published logo](https://www.onlycat.com/wp-content/uploads/2024/07/Horizontal.svg). See
[docs/assets.md](docs/assets.md) for provenance and the trademark position.

Built against [OnlyCat's public models](https://github.com/OnlyCatAI/onlycat-shared-models) and
their [Home Assistant integration](https://github.com/OnlyCatAI/onlycat-home-assistant), which is
the best documentation this API has. **Not affiliated with or endorsed by OnlyCat.**

MIT licensed.
