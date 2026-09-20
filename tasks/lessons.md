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
