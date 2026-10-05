/* The cat list, shared by pairing (pair/select_cats.html) and Repair (repair/select_cats.html).
 *
 * A pair view gets a global `Homey` and runs top-level: nothing calls an onHomeyReady, and there
 * is no Homey.ready(). Those belong to settings pages, and using them here was the v0.1.0 bug —
 * see tasks/lessons.md. The DRIVER says which flow this is (`context.mode`); the view never
 * guesses from the URL. Pairing moves on with nextView(); Repair has nothing after this and
 * must call done().
 */
/* global Homey */
/* eslint-env browser */

'use strict';

let context = null;

function t(key, tags) {
  return Homey.__(`pair.cats.${key}`, tags) || key;
}

function chosen() {
  const selection = {};
  context.flaps.forEach((flap) => {
    selection[flap.id] = flap.cats.map((cat) => {
      const box = document.querySelector(`input[data-flap="${flap.id}"][data-rfid="${cat.rfidCode}"]`);
      return { rfidCode: cat.rfidCode, name: cat.name, included: !!(box && box.checked) };
    });
  });
  return selection;
}

// Cats that were tracked when the view opened and are now unticked: the ones whose sensors and
// history are about to be deleted. Only Repair can have any — in pairing nothing exists yet.
function removals(selection) {
  const names = [];
  if (context.mode !== 'repair') return names;
  context.flaps.forEach((flap) => {
    flap.cats.forEach((cat, index) => {
      if (cat.included && !selection[flap.id][index].included) names.push(cat.name);
    });
  });
  return names;
}

function render() {
  const root = document.getElementById('flaps');
  root.innerHTML = '';
  const several = context.flaps.length > 1;

  context.flaps.forEach((flap) => {
    const section = document.createElement('fieldset');
    section.className = 'homey-form-fieldset cats-flap';
    if (several) {
      const legend = document.createElement('legend');
      legend.className = 'homey-form-legend cats-flap-name';
      legend.textContent = flap.name;
      section.appendChild(legend);
    }

    if (!flap.cats.length && !context.error) {
      const empty = document.createElement('p');
      empty.className = 'cats-empty';
      empty.textContent = t('none');
      section.appendChild(empty);
    }

    flap.cats.forEach((cat) => {
      const label = document.createElement('label');
      label.className = 'homey-form-checkbox';

      const input = document.createElement('input');
      input.className = 'homey-form-checkbox-input';
      input.type = 'checkbox';
      input.checked = !!cat.included;
      input.dataset.flap = flap.id;
      input.dataset.rfid = cat.rfidCode;

      const mark = document.createElement('span');
      mark.className = 'homey-form-checkbox-checkmark';

      const text = document.createElement('span');
      text.className = 'homey-form-checkbox-text';
      // A cat with no profile in OnlyCat is named by its chip. Say so rather than show a
      // bare fifteen-digit number as though it were a name.
      const unnamed = cat.name === cat.rfidCode;
      text.textContent = unnamed ? t('unnamed') : cat.name;
      const chip = document.createElement('span');
      chip.className = 'cats-chip';
      chip.textContent = cat.rfidCode;
      text.appendChild(chip);

      label.appendChild(input);
      label.appendChild(mark);
      label.appendChild(text);
      section.appendChild(label);
    });

    root.appendChild(section);
  });

  const repair = context.mode === 'repair';
  document.getElementById('intro').textContent = t(repair ? 'intro_repair' : 'intro_pair');
  document.getElementById('note').textContent = context.error || (repair ? t('note_repair') : '');
  const save = document.getElementById('save');
  save.textContent = t(repair ? 'save' : 'next');
  // With no list there is nothing to save — but the key button below must still work.
  save.hidden = !!context.error;
  const changeKey = document.getElementById('change_key');
  changeKey.textContent = t('change_key');
  changeKey.hidden = !repair;
}

function submit(selection) {
  Homey.showLoadingOverlay();
  Homey.emit('cats_selected', selection, (err) => {
    Homey.hideLoadingOverlay();
    if (err) {
      Homey.alert(err.message || String(err), 'error');
      return;
    }
    if (context.mode === 'repair') Homey.done();
    else Homey.nextView();
  });
}

document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!context) return;
  const selection = chosen();
  const removed = removals(selection);
  if (!removed.length) {
    submit(selection);
    return;
  }
  Homey.confirm(t('confirm_remove', { names: removed.join(', ') }), 'warning', (err, yes) => {
    if (!err && yes) submit(selection);
  });
});

document.getElementById('change_key').addEventListener('click', () => {
  Homey.showView('login_credentials');
});

Homey.setTitle(t('title'));
Homey.showLoadingOverlay();
Homey.emit('cat_context', {}, (err, ctx) => {
  Homey.hideLoadingOverlay();
  if (err) {
    Homey.alert(err.message || String(err), 'error');
    return;
  }
  context = ctx;
  render();
});
