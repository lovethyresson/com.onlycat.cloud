/**
 * The pairing view, in jsdom.
 *
 * This file exists because v0.1.0 shipped a pair view that could not possibly work, and nothing
 * caught it. The view was written as a settings page — everything wrapped in
 * `function onHomeyReady(Homey) { ... }`, ending in `Homey.ready()`. A settings page is driven
 * that way. **A pair view is not**: `Homey` is already a global when the script runs, nothing
 * calls `onHomeyReady`, and there is no `ready()`.
 *
 * So the page rendered with every string empty, no click listener was attached, and `verify_key`
 * never reached the driver. From the other side it looked like an OnlyCat API key that the
 * service still reported as "Never used", which is a genuinely confusing symptom: the app log is
 * silent, because the failure is in the webview and the webview never got far enough to fail.
 *
 * The first version of this test passed against the broken view, because the harness called
 * `onHomeyReady` itself. That is the lesson worth keeping: **a UI test that supplies the missing
 * caller is testing the harness, not the view.** This one runs the script exactly the way Homey
 * does — set the global, evaluate top-level, call nothing.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const { JSDOM } = require('jsdom');

const LOCALES = ['en', 'sv', 'de', 'nl', 'no', 'da'];
const VIEWS = ['drivers/cat_flap/pair/api_key.html', 'drivers/cat_flap/repair/api_key.html'];

function translations(locale = 'en'): any {
  return JSON.parse(readFileSync(`.homeycompose/locales/${locale}.json`, 'utf8'));
}

function lookup(dictionary: any, key: string): string | undefined {
  return key.split('.').reduce((node: any, part: string) => node?.[part], dictionary);
}

interface Harness {
  emitted: { event: string; data: any }[];
  views: string[];
  titles: string[];
  window: any;
  settle: () => Promise<void>;
  click: (id: string) => void;
  text: (id: string) => string;
  visible: (id: string) => boolean;
  value: (id: string, v: string) => void;
  disabled: (id: string) => boolean;
}

function harness(view: string, replies: Record<string, any> = {}, locale = 'en'): Harness {
  // `outside-only` so the inline script does NOT run at parse time. We install the global Homey
  // first — exactly as Homey's webview does — and only then evaluate the script. Running it any
  // other way would hide a view that depends on a caller Homey never provides.
  const dom = new JSDOM(readFileSync(view, 'utf8'), { runScripts: 'outside-only' });
  const win = dom.window;
  const dictionary = translations(locale);

  const emitted: { event: string; data: any }[] = [];
  const views: string[] = [];
  const titles: string[] = [];

  win.Homey = {
    emit(event: string, data: any) {
      emitted.push({ event, data });
      if (event === 'get_mode' && !(event in replies)) {
        return Promise.resolve({ mode: view.includes('/repair/') ? 'repair' : 'pair' });
      }
      const reply = replies[event];
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
    setTitle(title: string) {
      titles.push(title);
    },
    showView(id: string) {
      views.push(id);
    },
    nextView() {
      views.push('<next>');
    },
    prevView() {
      views.push('<prev>');
    },
    done() {
      views.push('<done>');
    },
    showLoadingOverlay() {},
    hideLoadingOverlay() {},
    alert(_m: string, _i?: string, cb?: Function) {
      if (cb) cb();
    },
    createDevice: async () => {},
    // The real Homey.__ resolves against the compose locales. Returning the key on a miss is what
    // it does too, which is why the "no raw keys on screen" assertion below matters.
    __: (key: string) => lookup(dictionary, key) ?? key,
  };

  const source = readFileSync(view, 'utf8')
    .replace(/[\s\S]*<script type="text\/javascript">/, '')
    .replace(/<\/script>[\s\S]*/, '');
  win.eval(source);

  return {
    window: win,
    emitted,
    views,
    titles,
    settle: () => new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    }),
    click(id: string) {
      const element = win.document.getElementById(id);
      assert.ok(element, `no #${id} in ${view}`);
      element.dispatchEvent(new win.Event('click', { bubbles: true }));
    },
    text: (id: string) => win.document.getElementById(id)?.textContent ?? '',
    visible: (id: string) => {
      const element = win.document.getElementById(id);
      return !!element && element.style.display !== 'none';
    },
    value: (id: string, v: string) => {
      win.document.getElementById(id).value = v;
    },
    disabled: (id: string) => win.document.getElementById(id).disabled === true,
  };
}

describe('the pair and repair copies', () => {
  it('are byte-identical', () => {
    // Homey requires a repair view to live under repair/, so this file is duplicated. Two copies
    // that drift is the failure mode; this is the cheap guard against it.
    assert.equal(readFileSync(VIEWS[0], 'utf8'), readFileSync(VIEWS[1], 'utf8'),
      'pair/api_key.html and repair/api_key.html have drifted apart');
  });
});

for (const view of VIEWS) {
  describe(view, () => {
    it('runs top-level, the way a pair view actually starts', () => {
      // The regression this whole file exists for. A pair view that only does its work inside
      // onHomeyReady does nothing at all, because nothing calls it.
      const h = harness(view);
      assert.equal(h.window.onHomeyReady, undefined,
        'this view defines onHomeyReady — that is a SETTINGS page contract. '
        + 'Homey never calls it in a pair view, so the view would render empty and dead.');
      assert.notEqual(h.text('lead').trim(), '',
        'nothing rendered without a caller — the script is not doing its work at top level');
    });

    it('renders its instructions and the key-scope warning', () => {
      const h = harness(view);
      assert.ok(h.text('warn').includes('full access'),
        'the key-scope warning is missing — it is the one thing this view must say');
      assert.equal(h.window.document.querySelectorAll('#steps li').length, 4,
        'the how-to-get-a-key steps did not render');
      assert.notEqual(h.text('submit').trim(), '', 'the button has no label');
    });

    it('sets a title', () => {
      const h = harness(view);
      assert.equal(h.titles.length, 1);
      assert.notEqual(h.titles[0].trim(), '');
    });

    it('sends the trimmed key to the driver', async () => {
      const h = harness(view, { verify_key: { count: 1 } });
      h.value('key', '  oc_live_abc  ');
      h.click('submit');
      await h.settle();
      assert.deepEqual(h.emitted.filter((e) => e.event === 'verify_key'),
        [{ event: 'verify_key', data: 'oc_live_abc' }]);
    });

    it('advances only once the key is accepted', async () => {
      const h = harness(view, { verify_key: { count: 1 } });
      h.value('key', 'oc_live_abc');
      h.click('submit');
      await h.settle();
      await h.settle();
      assert.equal(h.views.length, 1, 'did not move on after a good key');
      // Repair has no view after this one: calling nextView() there goes nowhere and strands the
      // user on a form that has already done its job.
      const expected = view.includes('/repair/') ? '<done>' : '<next>';
      assert.equal(h.views[0], expected,
        `${view} should finish with ${expected} but used ${h.views[0]}`);
    });

    it('shows the real error and stays put when the key is rejected', async () => {
      const h = harness(view, { verify_key: new Error('OnlyCat rejected that key.') });
      h.value('key', 'nope');
      h.click('submit');
      await h.settle();
      assert.equal(h.views.length, 0, 'moved on despite a rejected key');
      assert.ok(h.text('error').includes('rejected'), 'the driver error never reached the user');
      assert.equal(h.visible('error'), true, 'the error element is still hidden');
    });

    it('re-enables the button after a failure, so a typo is recoverable', async () => {
      const h = harness(view, { verify_key: new Error('nope') });
      h.value('key', 'x');
      h.click('submit');
      await h.settle();
      assert.equal(h.disabled('submit'), false,
        'the button stayed disabled — the user cannot retry without restarting pairing');
    });

    it('refuses an empty key without bothering the driver', async () => {
      const h = harness(view);
      h.click('submit');
      await h.settle();
      assert.deepEqual(h.emitted.filter((e) => e.event === 'verify_key'), [],
        'sent an empty key to the gateway');
      assert.equal(h.visible('error'), true);
    });

    it('reports an account with no flaps as its own case', async () => {
      const h = harness(view, { verify_key: { count: 0 } });
      h.value('key', 'oc_live_abc');
      h.click('submit');
      await h.settle();
      assert.equal(h.views.length, 0, 'advanced to an empty device list');
      assert.notEqual(h.text('error').trim(), '', 'said nothing about the empty account');
    });

    it('has a translation for every key it asks for, in all six languages', () => {
      // Homey.__ returns the key itself on a miss, so a missing string shows the user
      // "pair.warn" rather than a warning. This catches that before they see it.
      for (const locale of LOCALES) {
        const h = harness(view, {}, locale);
        for (const id of ['lead', 'warn', 'submit']) {
          assert.ok(!h.text(id).startsWith('pair.'),
            `${locale}: #${id} rendered the raw key ${h.text(id)}`);
        }
        assert.ok(!h.titles[0].startsWith('pair.'), `${locale}: the title rendered a raw key`);
      }
    });
  });
}
