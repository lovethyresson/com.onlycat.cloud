# Homey Community Forum — release post

Paste the body below into a new topic in the [Apps](https://community.homey.app/c/apps/7) category. Once it exists, put the topic id into `.homeycompose/app.json` as `homeyCommunityTopicId`, rebuild, and it becomes the "Community" link on the store page.

**Title:** `[APP][Pro] OnlyCat — see which cat came in, and what it was carrying`

---

## Body

Your OnlyCat cat flap in Homey. Every event arrives with the photo from the flap, each cat becomes its own sensor under the name you already gave it, and when the flap turns a cat away the app tells you which rule did it.

:package: **App Store:** https://homey.app/a/com.onlycat.cloud/
:octopus: **Source & issues:** https://github.com/lovethyresson/com.onlycat.cloud

This is **0.1.0, a first test version**. It runs against a real flap and a real account, and I use it daily — but you are early, so please report anything odd.

### What it does

**Tells you which cat, by name.** Cats appear as sensors on the flap, so you can see at a glance who is in and who is out. Flow cards take *any cat* or a specific one, so you write one Flow rather than one per pet.

**Puts the photo in the notification.** Every trigger card carries a Snapshot tag. Drop it into a push notification and a prey alert becomes an actual picture rather than a guess.

**Explains a refusal.** When the flap decides not to open, the app works out which of your door policy's rules did it, and says so in words — "turned away, she was carrying something", or "the curfew locks the flap between 22:00 and 07:00". Some rules depend on sensors inside the flap that the API does not expose, and in that case it says it cannot tell rather than inventing a reason.

**Plays the clip.** OnlyCat records a short video of each event. The device has a camera tile with the last clip and the last still frame.

**Charts what your cats do.** Times in, times out, refusals and prey attempts are counters, so Insights shows the trend — plus how many cats are home and roughly how long each has been outside today.

**Switches door policies.** The policies you built in the OnlyCat app appear as a picker on the tile and as a Flow action, so "curfew at sunset" is one Flow. Unlocking is the tile's quick action.

### Flow cards

| | |
|---|---|
| **When** | A cat came in · went out · was turned away · looked but did not come through · forced the flap · Prey detected · An unknown cat used the flap · Something happened at the flap |
| **And** | A cat is home · The door policy is… |
| **Then** | Unlock the flap · Switch the door policy · Mark a cat as home or out · Restart the flap |

### What you need

- A **Homey Pro** on firmware **12.7.0 or newer** (that is the release that added video playback, and clips are most of the point). Not available for Homey Cloud — publishing there requires a Verified Developer organization, which individuals cannot get.
- An **OnlyCat API key**: in the OnlyCat phone app, go to *Account*, turn on *Developer Mode*, open *API Keys* and create one.

:warning: **An OnlyCat API key has full access to your OnlyCat account and cannot be limited.** Create a key just for Homey so you can revoke that one on its own later. I would give the same warning about any app, including mine.

Then add the device: **Devices → + → OnlyCat → Cat flap**. Homey picks up the flaps on the account and the cats OnlyCat knows about, skipping any you have hidden as neighbours' cats. To change the key later, or pick up a cat you have added since, use the device's **Repair**.

### Worth knowing up front

**This needs the internet.** OnlyCat has no local API — the flap talks only to OnlyCat's cloud, and so does this app. If your connection drops, the flap keeps enforcing its door policy on the device itself, so your cats are unaffected; what stops is Homey knowing about it.

**There is no lock state.** The API only reports lock state inside per-frame event data — no message or endpoint gives a live value. So the tile shows the **active door policy**, which is real data, rather than a simulation dressed up as a reading.

**Refusal alerts arrive a few seconds late, deliberately.** OnlyCat revises an event while it is happening — a cat that starts coming through and turns back changes from a transit to a peek. Homey cannot un-fire a Flow, so the app waits for the final version.

**"Outside today" is an estimate.** The flap sees the flap, not the cat. Cats leave through windows and get carried to the vet, so sometimes one comes back in when the app thought it was already indoors. An *Unseen trips* setting decides what to assume about that gap: nothing, half of it (default), or all of it.

### Feedback

Bugs and ideas to [GitHub issues](https://github.com/lovethyresson/com.onlycat.cloud/issues), or just reply here. If something misbehaves, the device's **Advanced** settings have a **Debug logging** switch — turn it on, reproduce it, and send the log from *Settings → Apps → OnlyCat*. That log is what found the last three bugs.

Source is [GPLv3 on GitHub](https://github.com/lovethyresson/com.onlycat.cloud). Not affiliated with, endorsed by, or supported by OnlyCat.

### Changelog

**0.1.0** — First test version.
