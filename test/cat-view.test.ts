/**
 * The cat list view, run the way Homey runs a pair view: a global `Homey` installed, the script
 * evaluated top-level, and nothing called by the harness. v0.1.0's pair view passed a harness
 * that called its `onHomeyReady` itself — supplying the very caller Homey does not — so this one
 * calls nothing, and the view either wires itself up or fails.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

/* global Document, HTMLInputElement, HTMLFormElement, HTMLButtonElement */

const html = readFileSync(`${__dirname}/../drivers/cat_flap/repair/select_cats.html`, 'utf8');
const script = readFileSync(`${__dirname}/../assets/pair/cats.js`, 'utf8');

interface Calls {
  emitted: { event: string; data: any }[];
  confirms: string[];
  done: number;
  next: number;
  views: string[];
}

function open(context: any, confirmAnswer = true) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const win = dom.window as any;
  const calls: Calls = {
    emitted: [], confirms: [], done: 0, next: 0, views: [],
  };
  win.Homey = {
    __: (key: string, tags?: Record<string, string>) => `${key}${tags ? ` ${JSON.stringify(tags)}` : ''}`,
    setTitle() {},
    showLoadingOverlay() {},
    hideLoadingOverlay() {},
    alert(message: string) {
      throw new Error(`alert: ${message}`);
    },
    confirm(message: string, _icon: string, callback: (err: any, yes: boolean) => void) {
      calls.confirms.push(message);
      callback(null, confirmAnswer);
    },
    emit(event: string, data: any, callback: (err: any, result?: any) => void) {
      calls.emitted.push({ event, data });
      callback(null, event === 'cat_context' ? context : undefined);
    },
    done() {
      calls.done++;
    },
    nextView() {
      calls.next++;
    },
    showView(id: string) {
      calls.views.push(id);
    },
  };
  win.eval(script);
  const doc = win.document as Document;
  const box = (rfid: string) => doc.querySelector(`input[data-rfid="${rfid}"]`) as HTMLInputElement;
  const save = () => (doc.getElementById('form') as HTMLFormElement)
    .dispatchEvent(new win.Event('submit', { cancelable: true }));
  // Round-tripped because the view builds its objects in jsdom's realm, whose prototypes are not
  // Node's — deepStrictEqual compares those too. Homey serialises the payload anyway.
  const sent = () => {
    const data = calls.emitted.find((e) => e.event === 'cats_selected')?.data;
    return data === undefined ? undefined : JSON.parse(JSON.stringify(data));
  };
  return {
    doc, calls, box, save, sent,
  };
}

const flap = (cats: any[]) => ({ id: 'OC-1', name: 'Back door', cats });

describe('cat view', () => {
  it('renders the driver\'s cats with nothing but a global Homey', () => {
    const view = open({
      mode: 'pair',
      flaps: [flap([
        { rfidCode: 'A', name: 'Zorro', included: true },
        { rfidCode: 'B', name: 'B', included: true },
      ])],
    });
    assert.equal(view.box('A').checked, true);
    assert.match(view.box('B').parentElement!.textContent!, /pair\.cats\.unnamed/,
      'a cat named by its chip is called unnamed, not shown as a bare number');
    assert.equal(view.doc.getElementById('change_key')!.hidden, true, 'no key button while pairing');
  });

  it('pairing: unticking asks nothing, sends the choice and moves on', () => {
    const view = open({
      mode: 'pair',
      flaps: [flap([
        { rfidCode: 'A', name: 'Zorro', included: true },
        { rfidCode: 'B', name: 'Misan', included: true },
      ])],
    });
    view.box('B').checked = false;
    view.save();
    assert.deepEqual(view.calls.confirms, [], 'nothing exists yet, so nothing to warn about');
    assert.deepEqual(view.sent(), {
      'OC-1': [
        { rfidCode: 'A', name: 'Zorro', included: true },
        { rfidCode: 'B', name: 'Misan', included: false },
      ],
    });
    assert.equal(view.calls.next, 1);
    assert.equal(view.calls.done, 0);
  });

  it('repair: removing a tracked cat warns by name, and only proceeds on yes', () => {
    const cats = [
      { rfidCode: 'A', name: 'Zorro', included: true },
      { rfidCode: 'B', name: 'Misan', included: false },
    ];
    const declined = open({ mode: 'repair', flaps: [flap(cats)] }, false);
    declined.box('A').checked = false;
    declined.save();
    assert.equal(declined.calls.confirms.length, 1);
    assert.match(declined.calls.confirms[0], /Zorro/);
    assert.equal(declined.sent(), undefined, 'a declined warning deletes nothing');
    assert.equal(declined.calls.done, 0);

    const accepted = open({ mode: 'repair', flaps: [flap(cats)] }, true);
    accepted.box('A').checked = false;
    accepted.save();
    assert.equal(accepted.sent()['OC-1'][0].included, false);
    assert.equal(accepted.calls.done, 1, 'Repair has no view after this one and must close itself');
  });

  it('repair: switching a cat on needs no warning', () => {
    const view = open({
      mode: 'repair',
      flaps: [flap([{ rfidCode: 'B', name: 'Misan', included: false }])],
    });
    view.box('B').checked = true;
    view.save();
    assert.deepEqual(view.calls.confirms, []);
    assert.equal(view.calls.done, 1);
  });

  it('repair: offers the key screen', () => {
    const view = open({ mode: 'repair', flaps: [flap([])] });
    const button = view.doc.getElementById('change_key') as HTMLButtonElement;
    assert.equal(button.hidden, false);
    button.click();
    assert.deepEqual(view.calls.views, ['login_credentials']);
  });

  it('repair: still offers the key screen when the cat list cannot be read', () => {
    // A rejected key is why most people open Repair, and it is exactly when the list fails.
    const view = open({ mode: 'repair', flaps: [flap([])], error: 'Not connected to OnlyCat' });
    assert.equal(view.doc.getElementById('save')!.hidden, true);
    assert.equal(view.doc.getElementById('note')!.textContent, 'Not connected to OnlyCat');
    (view.doc.getElementById('change_key') as HTMLButtonElement).click();
    assert.deepEqual(view.calls.views, ['login_credentials']);
  });

  it('pair and repair pages load the same script', () => {
    const pair = readFileSync(`${__dirname}/../drivers/cat_flap/pair/select_cats.html`, 'utf8');
    assert.equal(pair, html);
  });
});
