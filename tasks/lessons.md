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
