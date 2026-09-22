# Lessons

## A pair view is not a settings page, and a UI test that supplies the missing caller tests nothing

**2026-09-20, v0.1.0.** The app shipped with a pairing view that could not work. Everything in
`drivers/cat_flap/pair/api_key.html` was wrapped in `function onHomeyReady(Homey) { ... }` and
ended with `Homey.ready()`. That is the **settings page** contract. A **pair view** is handed a
global `Homey` and runs top-level; nothing ever calls `onHomeyReady`, and there is no `ready()`.

So the page rendered with every string still empty, no click listener was ever attached, and
`verify_key` never reached the driver. The symptom the owner saw from the other side was an
OnlyCat API key that the service still reported as **"Never used"** — which is a genuinely good
clue and was visible in the screenshot before any code was read.

Three things went wrong, in increasing order of seriousness.

**1. I wrote a view without checking the contract against the working app in the next directory.**
`com.nibe.local` has five pair views that work. One `grep -rn "onHomeyReady" assets/pair/` would
have returned nothing and settled it in seconds. Instead I generalised from settings pages, which
are the other kind of Homey webview and use the opposite convention.

**2. I shipped it having verified only the parts I could see.** Lint, typecheck, 62 tests and
`homey app validate --level publish` were all green, and none of them execute a pair view. I
reported "all four gates green" as though that meant the app worked. It meant the app compiled.
Nibe's lesson already covers this — *"I verified the artifact I control, not the value that ends up
in place"* — and the shape here is identical.

**3. The test I then wrote to catch it passed against the broken view.** The first
`test/pair-ui.test.ts` harness did `win.onHomeyReady(win.Homey)` itself. Of course it passed: I had
supplied the exact caller that Homey does not. A UI test that provides the missing initialisation
is measuring the harness. The fixed harness installs the global and evaluates the script top-level
— **calling nothing** — and it fails against the old file, which is the only evidence that a
regression test is real.

**Rules:**

- Before writing any Homey webview, `grep` the working app for how that *kind* of view starts.
  Pair, repair and settings do not share a contract, and the difference is invisible to every
  static check.
- A green `validate` says the manifest is publishable, not that the app runs. Never report a build
  as working on the strength of gates that cannot reach the code path in question — say which parts
  are unverified.
- **A regression test must be shown to fail against the bug.** Write it, run it against the broken
  version, watch it go red, then fix. A test written after the fix and never run against the defect
  is an assertion that the current code is the current code.
- When a view can be reached by two flows (pair and repair), the *driver* tells the view which one
  it is in. Repair has no view after the form and must `Homey.done()`; pairing must `nextView()`.
  Guessing from the URL would work until it didn't.

**Corollary, on the probe that was right all along.** `dev/probe-account.mjs` worked first time
against the real account and proved the entire backend — key, socket, policies, cats — in 361 ms.
Because it exists, diagnosing this took one command to *exclude* everything below the view, rather
than a hunt through the whole stack. The Nibe habit of writing a self-interpreting probe earns its
keep on the first real failure, not eventually.

## Never put a real credential in a test fixture

**2026-09-20.** Asked to test pairing, I was handed a live OnlyCat API key. I used it — correctly
— to run the probes. Then I wrote a test for `redactKey()` and used **the real key** as its
fixture: in `test/unit.test.ts`, in a function whose entire purpose is proving that keys do not
leak into logs.

It sat in the git history through four commits. I found it only because I scanned before creating
the public repo, which I did out of habit rather than suspicion. One `git push` earlier in the
sequence and an account-wide, full-access credential would have been on GitHub.

The repair was straightforward — fabricated key, `filter-branch` across all seven commits, reflog
expired, `gc --prune=now`, then a scan of every blob in the repository to prove it was gone — but
the credential still has to be rotated, because it existed in a history that existed.

The failure is not "I forgot". It is that **a realistic fixture felt like a better test**, and
that instinct is right for almost everything except secrets, where it inverts completely.

**Rules:**
- A credential goes in exactly one place: the command being run, at the moment it is run. Never
  into a file, a fixture, a comment, a commit message, or a doc example.
- Fixtures that stand in for secrets are fabricated, look obviously fabricated, and say so —
  `oc_live_EXAMPLE0000_NotARealKeyOnlyUsedForTestingRedaction00`.
- **Scan before the first push of any repo that will be public**, and scan objects rather than
  the working tree: `git rev-list --objects --all` piped through `git cat-file --batch`. The
  working tree being clean says nothing about the history.
- When a user hands over a credential, say plainly at the end that it should be rotated. It has
  been in a screenshot and a transcript whatever else happens.

## `str.replace` does not tell you it matched nothing

**2026-09-20.** Three separate patches applied through `python3 - <<'PY'` heredocs silently did
nothing, because the anchor text differed by indentation after an earlier `eslint --fix` pass.
Python's `str.replace` returns the string unchanged on a miss and raises nothing.

The consequences were not cosmetic. A `get_mode` handler never reached the driver, so repair
would have called `nextView()` into a view that does not exist. A `pendingApiKey` field was never
added. In both cases the *edit script printed a success message* — "driver patched" — and I
believed it, because I had written the print statement myself.

A line-based splice then compounded it: anchoring on the first line equal to `};` found a type
alias twenty lines in rather than the class close, and duplicated half the file. That one at
least failed loudly, at the type-checker.

**Rules:**
- Every scripted edit asserts its anchor: `assert old in s, old[:80]` before replacing. A patch
  that cannot find its target must fail, not pass quietly.
- Never print "patched" unconditionally. Print the count of replacements actually made, or grep
  for the new text afterwards and show the hit.
- Anchor line splices on something unique — the last column-0 `};`, not the first `};`.
- After any `--fix`-style reformatter runs, every stored anchor is stale. Re-read before patching.

## The app icon, the device icon and the driver images are three different things

**2026-09-20.** I used OnlyCat's brand mark for all of them. The correction: *"the driver image
and the device icons can't be the same as the app icon. device icons are usually 3D artwork, and
driver images are lifestyle photos of the product."*

Then I drew the device icon as a flat front elevation — *"thats not 3D"* — and after adding depth,
raked it the wrong way: *"Wrong perspective, should tilt right."*

| Asset | What it is |
|---|---|
| `assets/icon.svg` | the app icon — the brand's mark |
| `assets/images/*` | app store images — lifestyle photography |
| `drivers/<id>/assets/icon.svg` | the device icon — the product drawn at a three-quarter angle |
| `drivers/<id>/assets/images/*` | driver images — lifestyle photography of the product |

A logo on a device tile reads as a sticker next to Homey's outlined hardware icons. The reason
each of the three rounds took a correction is the same: **I never looked at what I had made.**
There is no SVG renderer on this machine, so the icon shipped unseen twice. `dev/make-device-icon.py`
now writes a PNG preview beside the SVG, and the fix took one round after that.

**Rule:** if an artefact is visual, render it and look at it before calling it done. If the tooling
to look at it does not exist, building that tooling is part of the task, not a detour.

## Prefer the platform's own view to a hand-rolled one

**2026-09-20.** The pairing view cost three bugs: nothing called `onHomeyReady` in a pair view;
declaring `navigation.next` made Homey draw its own Next button that skipped the handler entirely;
and the key was held in a closure that did not outlive the view. The user's correction — *"Please
use homey's native pairing views unless you absolutely have to render your own"* — was right, and
would have prevented all three.

Homey's `login_credentials` template has no bypass to get wrong: its Login button is wired to the
`login` handler by the platform. The custom view had to be *made* correct; the native one is
correct by construction.

I reached for custom because the fit was imperfect — a single API key against a two-field login.
That is a real cost, and it is smaller than three rounds of debugging a view I could not see.

**Rule:** when the platform ships a view, a template or a widget for roughly this job, use it and
bend the content to fit. Reach for a custom one only when the native one cannot express the
requirement at all — not when it merely expresses it awkwardly.

## Guessing at platform behaviour twice is a decision to stop guessing

**2026-09-20.** A camera picker showed two rows — one playing a clip, one showing a still. I
explained it three times without looking anything up:

1. "Stale registrations from repeated dev installs." Invented.
2. "They had different titles, which broke the id pairing." Plausible, wrong.
3. "A changed title adds a row rather than renaming one." Confidently wrong, and I wrote it into
   a source comment as observed fact.

The user's correction was two words: *"research this properly now. Look at other apps."* Thirty
minutes of reading Athom's type definitions, thirteen published camera apps and a live API dump
produced facts that none of my three theories contained:

- A camera entry **is** keyed by its `id`; re-registering upserts and never adds a row.
- Its **title is taken from the first registration and never changes again** — passing a new one
  is silently ignored. So the timestamped title everybody wanted could never have worked.
- An image and a video are **two separate entries**, which is what "two rows" was the whole time.
- Nothing can remove a camera entry. `Device` has no `unsetCameraImage`, and
  `unregisterImage`/`unregisterVideo` take a resource instance rather than a camera id.
- Every mature camera app registers **once, behind a guard, with a static localised title**, and
  the one Homey app that exposes per-event clips does it as a Flow token, not a camera.

Each of those was public and cheap to find. The cost of not looking was three wrong fixes, three
installs on someone's hub, and a false statement committed to the repository — which is the worst
of it, because a confident comment is read as evidence by whoever comes next.

**The tell was available from the first round.** Two rows, one image and one video, on a device
where I registered exactly one image and one video. That maps perfectly to "they are separate
entries" and not at all to "duplicates". I reached for an explanation that blamed the platform
instead of counting what I had actually created.

**And then a fourth wrong fix, from the same root.** Armed with all of the above I rewrote
`showEvent` to "register exactly one entry, once" — and shipped it, and the owner saw two entries
still. `showEvent` was never the only registrar: `onInit` called `setCameraImage` directly and
`registerClips` called `setCameraVideo`, both at startup, both titled "Last event". My guard sat in
a method that ran *after* the registrations it was supposed to be preventing. A single
`grep -n setCamera` over the one file I was editing would have shown all three sites; it is what
finally found them. **I had researched the platform correctly and then not read my own code.**

**And then I called it solved on evidence that did not exist.** After splitting the shared id into
`still` and `clip`, the live log showed `still JPEG, 30387 bytes` and I announced the shared id had
been the bug all along. The owner asked, mildly, whether it might just be that there had been no
event since the install.

He was right to ask. Re-reading the failing log: it ends three seconds after init, at
`refresh complete`, and contains **no `still` line and no `clip for event` line**. It captured no
camera interaction whatsoever. It was never evidence about the still — I had read "the absent line
I was looking for is absent" as a finding, when the whole log predated anyone opening the camera.

Three things changed between the two runs: a fresh install, an event present to show, and the id
split. One observation cannot separate them, and I attributed it to the one I had just worked on.

The poster-frame coupling was still worth removing — a documented behaviour nobody has ever
observed should not be load-bearing, and I kept it through four rounds of debugging *the thing it
was breaking*, written into a source comment as "on purpose". A documented feature
nobody has observed is a hypothesis, and this one was load-bearing under every wrong theory I had.

**The logging was still the right move** — it makes "Homey never asked" distinguishable from
"Homey asked and we failed", and those look identical from outside while needing opposite fixes.
But it only pays off in a window that actually contains the event, and I did not check that the
window did.

**Rules:**
- **A missing log line proves nothing unless the log covers the moment.** Check the window before
  reading absence as a finding: what was the last line, and had the thing been tried yet?
- **When several things changed at once, say so instead of crediting the one you just did.** "It
  works now" and "my change fixed it" are different claims, and the second needs the first plus an
  experiment.
- **When a component has several paths, log which one ran before theorising about why none did.**
- **A vendor-documented behaviour you have never observed is an assumption.** Write it down as one.
  If it is coupling two things together, uncouple them before debugging either.
- **Before changing how a resource is registered, grep for every call site of the registering
  method.** "The function I am looking at is the only one that does this" is an assumption, and in
  a 1000-line device class it is usually wrong.
- **A second guess about platform behaviour is the signal to go and read.** Not the third. The
  first wrong theory is cheap; the second means the mental model is wrong, and more theories from
  a wrong model do not converge.
- Read the vendor's **type definitions** before their prose. `lib/Device.d.ts` answers "does this
  method exist" in seconds, and absence — no `unsetCameraImage` — is as informative as presence.
- **Other people's shipped apps are the specification the docs are not.** Thirteen of them agreed
  on a convention the documentation never states.
- Never write an unverified behaviour into a comment as though observed. Say "assumed" or find
  out. `docs/` and a test are for what was checked; a comment asserting a platform fact is a
  claim the next reader will trust.

## "This view doesn't work" is a question about the surface, not the data

**2026-09-22, v1.0.0.** Asked how better to illustrate "Outside today" than a cumulative timeseries
that resets every night, I offered three variations on the same theme: a rolling 24-hour window, a
"yesterday" companion capability, a per-trip duration. All three were new *numbers fed to Homey
Insights*. The answer was "none of these were helpful — what would be helpful is a bar chart with
hours outside, and week/month; Homey's Insights really doesn't work for that."

The complaint was never about which number to compute. It was that Insights charts a capability's
value over time with per-bucket averaging and has no concept of a daily total as a bar. No choice
of capability fixes that, so every option I gave was a variation inside the broken constraint.
Homey Pro apps have shipped their own **dashboard widgets** since firmware 12.3.0 — HTML, CSS, JS
and an `api.js` backend, where you draw whatever you like. This app already requires `>=12.7.0`.
The capability existed the whole time and I did not look for it, because I had accepted the
surface as fixed and was only searching within it.

Worse: the rule was already written down. `tasks/lessons.md` says *"when the platform ships a view,
a template or a widget for roughly this job, use it"* — the word **widget** is in it. A lesson that
is only read after the mistake repeats has not been learned.

**Rules:**
- **When someone says an existing view does not work, the first question is whether a different
  surface exists** — not which data to feed the one that does not work. Enumerate the platform's
  surfaces before enumerating options inside one of them.
- **Check the platform's capability list before declaring a shape impossible.** "Homey can't chart
  that" was true of Insights and false of Homey. One search settled it, after three wrong answers.
- **A written lesson only counts if it is read at the start.** Re-read `tasks/lessons.md` when a
  task touches a platform surface, which is exactly when it is most likely to already say something.
- When the user rejects a whole set of options rather than picking one, **the framing is wrong, not
  the ranking.** Stop generating more options in that frame.

## Survey the sources before building the pipeline

**2026-09-22, v1.0.0.** App Store review wanted the driver image to show the flap on white. I took
the first plausible source — OnlyCat's product photograph, shot on a white table — and spent the
next hour on it: flood fills that leaked, a modelled backdrop gradient, edge thresholds at five
settings, and finally a silhouette polygon traced by hand against a pixel grid. It worked. Then:
*"that driver image wasn't great. Can we look at options? Search for transparent version."* The
answer was a cut-out with a real alpha channel, and the whole apparatus became one composite-over-
white loop.

Two separate failures, and the second is the expensive one. I never enumerated the candidate
sources — the store photographs, the turntable render, the manual vectors — before committing to
one; I found the render only when asked for options, and it was better than what I had already
finished. And I never asked whether the hard part could be skipped. "Does an asset exist that
already has the thing I am about to reconstruct?" costs one search. Reconstructing an alpha channel
from a white-on-white photograph costs an hour and is worse.

**Rules:**
- **Enumerate the available sources before picking one**, and show them. A survey is cheap; a
  pipeline built on the first candidate is not, and sunk cost then argues for keeping it.
- **Before writing an algorithm to recover information, look for the information.** Alpha channels,
  vector originals, press kits, raw exports. Segmentation, OCR and colour keying are all
  reconstruction of something that existed upstream.
- **When the work turns into a fight — five thresholds, three approaches, none clean — that is the
  signal to go back to the input**, not to try a sixth threshold. Both cut-outs here ended in a
  hand-traced polygon, which should have been read as "the input is wrong" rather than "tracing
  works".
- Show a rough option early. An hour of polish on an unchosen direction is an hour spent on the
  wrong axis.
