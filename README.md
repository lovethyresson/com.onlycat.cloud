# OnlyCat for Homey

**Who came in, who was turned away, and why.**

A [Homey](https://homey.app/) app for the [OnlyCat](https://www.onlycat.com/) smart cat flap. One
Homey device per flap, with every cat on it, and a snapshot on every Flow card.

> **On the [Homey App Store](https://homey.app/a/com.onlycat.cloud/).** Questions and ideas go in
> the [Homey Community thread](https://community.homey.app/t/159946); bugs can also go in
> [an issue](https://github.com/lovethyresson/com.onlycat.cloud/issues).

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
not expose. If one of those could have fired first, the app says so rather than guessing:

> Misan was turned away. This flap's rules depend on its own sensors, so the app can't tell you
> which one refused her.

**Plays the clip.** OnlyCat records a short video of every event, and Homey can play HLS — so the
device has a camera tile showing the last event, with the still frame as its poster.

**Charts what your cats actually do.** Times in, times out, refusals and prey attempts are
counters, so Insights shows the trend. Plus how many cats are home right now, and how long each
one has been outside today.

**Switches door policies.** The policies you built in the OnlyCat app appear as a picker on the
tile and as a Flow action, so "curfew at sunset" is one Flow. Unlocking is the tile's quick
action; restarting the flap is a Flow action, since it is not something you reach for often.

## Installing

**Homey Pro only.** Install it from the [Homey App Store](https://homey.app/a/com.onlycat.cloud/),
then add the device: **Devices → + → OnlyCat → Cat flap**.

Nothing technical rules out Homey Cloud — the app talks to nothing but OnlyCat's API and needs no
local network, discovery or permissions. Publishing for Homey Cloud just requires an organization
with [Verified Developer](https://apps.developer.homey.app/app-store/verified-developer) status,
which individuals cannot get, so claiming the platform would be a promise this app cannot keep.

To install from source instead, use the
[Homey CLI](https://apps.developer.homey.app/the-basics/getting-started):

```bash
git clone https://github.com/lovethyresson/com.onlycat.cloud.git
cd com.onlycat.cloud
npm install
npx homey login
npx homey app install
```

### Getting an API key

1. Open the OnlyCat app on your phone.
2. Go to **Account** and turn on **Developer Mode**.
3. Open **API Keys** and create one for Homey.
4. Copy it — it is only shown once — and paste it into the **API key** field when Homey asks.

> **An OnlyCat API key has full access to your OnlyCat account, and there is no way to limit it.**
> Make a key just for Homey so you can revoke that one on its own later.

Homey lists the flaps on the account and picks up the cats OnlyCat knows about, skipping any you
have hidden as neighbours' cats. To change the key later, or pick up a cat you have added since,
use the device's **Repair**.

## Flow cards

| | |
|---|---|
| **When** | A cat came in · A cat went out · A cat was turned away · A cat looked but did not come through · A cat forced the flap · Prey detected · An unknown cat used the flap · Something happened at the flap |
| **And** | A cat is home · The door policy is… |
| **Then** | Unlock the flap · Switch the door policy · Mark a cat as home or out · Restart the flap |

Every "when" card carries a **Snapshot** tag — drop it into a push notification and the photo
comes with it. "A cat was turned away" also carries a **Reason** tag.

The per-cat cards take **Any cat** or a specific one, so you write one Flow rather than one per pet.

"Mark a cat as home or out" is for when a cat gets in through a window and the app's idea of where
it is drifts. It corrects Homey only; it does not tell OnlyCat.

## Good to know

**This app needs the internet, and so does the flap.** OnlyCat has no local API — the flap talks
only to OnlyCat's own cloud, and so do we. OnlyCat have said a local API is planned, but as of
September 2026 it does not exist.

**Your cats are fine during an outage; Homey just goes quiet.** The flap enforces its door policy
on the device itself, so it keeps letting the right cats in with no internet at all. What stops is
Homey knowing about it — no events, no Flows, and the device shows as unavailable until the
connection comes back.

**The connectivity alarm is about the flap, not about Homey.** It means *OnlyCat says your flap is
offline* — a power cut, a rebooted router, a flap out of range. That is worth a notification,
because the flap keeps working and you would otherwise just notice Homey had gone quiet. Homey
losing its own connection to OnlyCat is a different thing and shows as the device being
unavailable, so the two never get confused and a reconnect never fires the alarm.

**There is no lock state, and that is deliberate.** The API defines one — `LockState` with
Locked, Unlocked and LongTermUnlocked — but only inside `FrameMetadata`, the per-frame data
captured during an event. No socket message and no endpoint delivers it: `Device`, `DeviceEvent`
and `EventSummary` all have no lock field. So a live "locked" readout could only ever be a
simulation of your door policy's rules, guessed from outside, and rules that depend on the flap's
own sensors cannot be evaluated at all. The app shows the **active door policy** instead, which is
real data — the same thing OnlyCat's own app shows.

The refusal reason uses that same rule engine, but it is anchored to a `DENY` the flap actually
sent: it explains something that happened rather than asserting a state, and it says when it
cannot be sure.

**The camera has two entries.** An image and a video are separate camera entries in Homey, so the
picker shows **Last still image**, there the moment an event lands, and **Last clip**, once OnlyCat
has finished processing it. A camera's title is fixed when it is first registered and cannot be
changed afterwards, so *which cat and when* lives on the **Last event** sensor instead, where it
can change as often as it likes.

**Clips are per event, not a live feed.** OnlyCat records each event and serves it as an HLS
playlist; there is no continuous stream to watch. The playlist also is not written the instant an
event ends, so the tile says the clip is still processing rather than handing the player a URL
that 404s. Clips are why the app requires Homey 12.7.0 — that is the release that added video
playback, and a cat flap whose whole job is showing you what happened at the door is not worth
shipping without them.

**Refusal alerts arrive a few seconds late, on purpose.** OnlyCat revises an event while it is
happening: a cat that starts coming through and turns back changes from a transit to a peek. Homey
cannot un-fire a Flow, so the app waits for the final version. The activity sensor on the tile
still reacts immediately.

**Prey detected and Human activity switch themselves off after five minutes.** They record
something the flap saw, not something still going on, so each stays on for five minutes after the
flap last reported it and then clears by itself. A cat coming through in the meantime does not
clear it early. The activity sensor is different: it covers the event itself, so it goes off as
soon as the event ends.

**"Outside today" is an estimate, and here is what it assumes.** The flap sees the flap, not the
cat. Cats leave through windows and get carried to the vet, so sometimes one comes back in when
the app thought it was already indoors — it was out, the app just does not know for how long. All
it knows is that the trip happened somewhere between the last sighting and now.

**Unseen trips** in the device's Advanced settings decides what to do with that gap: count
nothing, assume half of it (the default — the least-wrong single answer if the cat could have
slipped out at any moment), or assume all of it. The same applies in reverse, where it takes time
*back*: a cat that goes out when the app thought it was already outside must have come in first,
and that stretch was being counted as outside.

The *Mark a cat as home or out* Flow action is treated as better evidence than a flap transit,
because somebody looked at the cat. A cat the app has never seen counts nothing rather than being
guessed at, an unseen gap never reaches back past midnight, and the day turns over in the
**flap's** time zone, not Homey's.

**Subscription flaps need connectivity for more than notifications** — OnlyCat's subscription tier
checks its subscription online, and individual events can be gated.

## Troubleshooting

The device's **Advanced** settings have a **Debug logging** switch. It is off by default, because
on it writes a line for every gateway message and every cat that walks past. Turn it on, reproduce
whatever went wrong, then send the log from **Settings → Apps → OnlyCat**. Errors, connection
changes and availability transitions are logged either way.

`dev/probe-account.mjs` checks a key and describes what Homey would find, without involving Homey
at all — the fastest way to tell an account problem from an app problem:

```bash
node dev/probe-account.mjs oc_live_...
```

`dev/watch-events.mjs` tails a flap and decodes events into English, which is how you check
behaviour against a real cat going through a real door.

Neither script is part of the app bundle, and neither sends your key anywhere but OnlyCat.

## Development

```bash
npm test           # unit tests, plus an in-process fake gateway
npm run typecheck  # the app, and separately the test suite
npm run lint
npx homey app validate --level publish
```

CI runs all four on every push.

The interesting parts:

| | |
|---|---|
| [`lib/onlycat/models.ts`](lib/onlycat/models.ts) | The vendored OnlyCat contract — enums and pure functions copied from [their public models](https://github.com/OnlyCatAI/onlycat-shared-models) rather than re-derived. The only file allowed to restate their schema. |
| [`lib/events.ts`](lib/events.ts) | The subevent vocabulary. Flow cards, wording, presence and i18n all resolve through this one table. |
| [`lib/policy.ts`](lib/policy.ts) | The flap's rule engine, re-implemented, returning *which* rule matched and whether we can stand behind it. |
| [`lib/reason.ts`](lib/reason.ts) | That rule rendered as one sentence — or an admission that we cannot tell. |
| [`test/fake-gateway.ts`](test/fake-gateway.ts) | A real Socket.IO server on loopback, so reconnection, 401s and out-of-order events are testable without an API key. |

[`CLAUDE.md`](CLAUDE.md) documents the sharp edges of this API — the ones that cost something to
learn are all written down there. [`docs/`](docs/) has the asset provenance and the release notes.

## Credits

The cat-head mark and the brand colour are OnlyCat's own, taken from
[their published logo](https://www.onlycat.com/wp-content/uploads/2024/07/Horizontal.svg); the
photography is theirs too. See [docs/assets.md](docs/assets.md) for provenance and the trademark
position.

Built against [OnlyCat's public models](https://github.com/OnlyCatAI/onlycat-shared-models) and
their [Home Assistant integration](https://github.com/OnlyCatAI/onlycat-home-assistant), which is
the best documentation this API has.

**Not affiliated with, endorsed by, or supported by OnlyCat.**

## Licence

[GNU General Public License v3.0 or later](LICENSE) © 2026 Love Thyresson.

Copyleft rather than permissive on purpose: this is built on a vendor's cloud, using their
artwork, with their GPL-3.0 Home Assistant integration as the reference. Anyone distributing a
modified version ships its source under the same terms.
