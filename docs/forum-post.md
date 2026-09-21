# Homey Community Forum — release post

Paste the body below into a new topic in the [Apps](https://community.homey.app/c/apps/7) category, with `assets/images/xlarge.png` as the header image. Once the topic exists, put its id into `.homeycompose/app.json` as `homeyCommunityTopicId`, rebuild, and it becomes the "Community" link on the store page.

**Title:** `[APP][Pro] OnlyCat — see which cat came in, and what it was carrying`

---

## Body

![OnlyCat cat flap|690x483](upload://xlarge.png)

Your OnlyCat cat flap in Homey.

- **See which cat, by name.** Every cat becomes its own sensor, under the name you already gave it. Flow cards take *any cat* or a specific one.
- **Get the photo, not just the alert.** Every trigger carries a snapshot, so a prey warning arrives as an actual picture.
- **Know why a cat was turned away.** The app works out which of your door rules refused her, and says so in words — and admits it when the flap's own sensors mean it cannot tell.
- **Watch the clip.** The last event's video and still frame, on the device.
- **Automate the door.** Curfew at sunset, keep everyone in while it is raining, lock both ways when the wind picks up. Unlocking is the tile's quick action.
- **Track the trends.** Times in and out, refusals, prey attempts, who is home, and how long each cat has been outside — all in Insights.

You will need an **OnlyCat API key**: in the OnlyCat app, *Account → Developer Mode → API Keys*.

:warning: That key has full access to your OnlyCat account and cannot be limited, so make one just for Homey and you can revoke it on its own later.

:package: [App Store](https://homey.app/a/com.onlycat.cloud/) · :octopus: [Source & issues](https://github.com/lovethyresson/com.onlycat.cloud) (GPLv3)

Built on OnlyCat's published API and their official Home Assistant integration. Bugs and ideas here or on GitHub — very happy to hear what you would automate with it.

Not affiliated with, endorsed by, or supported by OnlyCat.

### Changelog

**1.0.0** — First release.
