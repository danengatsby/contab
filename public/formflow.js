'use strict';

import { confirmAction, uiLocale } from './core.js';

/*
 * Flux reutilizabil pentru formularele lungi.
 *
 * Responsabilitățile sunt intenționat separate de salvarea de business:
 * - transformă marcatorii `.sect-form` în pași accesibili;
 * - calculează progresul de completare;
 * - păstrează opțional o ciornă locală în sessionStorage;
 * - oferă modulelor un ciclu explicit loaded / flush / saved / discard.
 *
 * Componenta nu apelează API-uri și nu consideră niciodată autosave-ul drept
 * salvare oficială. Modulele de angajați, documente și mijloace fixe rămân
 * singurele care decid ce se trimite serverului.
 */

const CONTROLLERS = new Map();
const STORAGE_PREFIX = 'contab:form-draft:v1';
let ACTIVE_COMPANY = null;
let ACTIVE_USER = null;

function formElement(ref) {
  if (typeof ref === 'string') return document.querySelector(ref);
  return ref || null;
}

function isForm(form) {
  return !!form && form.nodeType === 1 && String(form.tagName || '').toUpperCase() === 'FORM';
}

// `form.id` nu este sigur pe HTMLFormElement: un control `name="id"` poate câștiga accesul
// nominal și întoarce chiar acel <input>. Atributul DOM rămâne neambiguu.
function formId(form) {
  return form && form.getAttribute ? form.getAttribute('id') : '';
}

function companyKey() {
  if (ACTIVE_COMPANY != null && ACTIVE_COMPANY !== '') return ACTIVE_COMPANY;
  const select = document.querySelector('#firmaSelect');
  return select && select.value && select.value !== '__add__' ? select.value : 'curenta';
}

function userKey() {
  return ACTIVE_USER == null || ACTIVE_USER === '' ? 'anonim' : ACTIVE_USER;
}

function safePart(value, fallback) {
  const text = String(value == null || value === '' ? fallback : value);
  return encodeURIComponent(text);
}

// Cheia poarta UTILIZATORUL, nu doar firma. sessionStorage supravietuieste delogarii (logout-ul
// reincarca pagina, nu inchide tabul), deci pe o statie partajata ciorna lui A ar fi fost
// restaurata lui B pe acelasi formular si aceeasi firma — ocolind drepturile granulare.
export function draftStorageKey(formId, company, entity, user) {
  return [STORAGE_PREFIX, safePart(formId, 'form'), safePart(company, 'curenta'),
    safePart(user, 'anonim'), safePart(entity, 'nou')].join(':');
}

export function completionPercent(values) {
  const list = Array.from(values || []);
  if (!list.length) return 0;
  const complete = list.filter(Boolean).length;
  return Math.round(complete * 100 / list.length);
}

function controlComplete(control) {
  if (!control || control.disabled) return true;
  if (control.type === 'checkbox' || control.type === 'radio') return !!control.checked;
  return String(control.value == null ? '' : control.value).trim() !== '';
}

function defaultProgressControls(form) {
  const required = Array.from(form.querySelectorAll('[required]'));
  return required.length ? required : Array.from(form.elements || []).filter((c) => c.name && c.type !== 'hidden');
}

function serializableControls(form) {
  return Array.from(form.elements || []).filter((control) => {
    // Doar controalele de business (`name`) intră implicit în ciornă. Câmpurile auxiliare cu
    // simplu `id` (căutări, importuri CSV, filtre) nu trebuie confundate cu datele formularului.
    if (!control || control.disabled || !control.name) return false;
    // `password` nu are voie sa ajunga in ciorna: autosave-ul e pornit IMPLICIT
    // (`config.autosave !== false`), deci un formular viitor cu parola ar stoca-o tacut.
    return !['file', 'submit', 'button', 'reset', 'password'].includes(control.type);
  });
}

function serializeDefault(form) {
  const seen = new Map();
  return serializableControls(form).map((control) => {
    const key = control.name;
    const occurrence = seen.get(key) || 0;
    seen.set(key, occurrence + 1);
    let value;
    if (control.type === 'checkbox' || control.type === 'radio') value = !!control.checked;
    else if (control.multiple) value = Array.from(control.selectedOptions || []).map((option) => option.value);
    else value = control.value;
    return { key, occurrence, kind: control.type || control.tagName.toLowerCase(), value };
  });
}

function restoreDefault(form, records) {
  const grouped = new Map();
  serializableControls(form).forEach((control) => {
    const key = control.name;
    const list = grouped.get(key) || [];
    list.push(control);
    grouped.set(key, list);
  });
  Array.from(records || []).forEach((record) => {
    const control = (grouped.get(record.key) || [])[record.occurrence || 0];
    if (!control) return;
    if (control.type === 'checkbox' || control.type === 'radio') control.checked = !!record.value;
    else if (control.multiple && Array.isArray(record.value)) {
      Array.from(control.options || []).forEach((option) => { option.selected = record.value.includes(option.value); });
    } else control.value = record.value == null ? '' : record.value;
  });
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function draftTime(savedAt) {
  if (!Number.isFinite(Number(savedAt))) return '';
  return new Date(Number(savedAt)).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });
}

function groupsFromMarkers(form, config) {
  const children = Array.from(form.children);
  const markers = children.filter((node) => node.classList && node.classList.contains('sect-form'));
  if (!markers.length) return [];

  const groups = [];
  markers.forEach((marker, index) => {
    const position = children.indexOf(marker);
    if (index === 0 && position > 0) {
      groups.push({ title: config.firstStepTitle || 'Date principale', intro: null, nodes: children.slice(0, position) });
    }
    const next = markers[index + 1];
    const stop = next ? children.indexOf(next) : children.length;
    const heading = marker.querySelector('h2,h3,h4');
    groups.push({
      title: heading ? heading.textContent.trim() : ('Secțiunea ' + (groups.length + 1)),
      intro: marker,
      nodes: children.slice(position + 1, stop),
    });
  });
  return groups.filter((group) => group.nodes.length || (group.intro && group.intro.children.length > 1));
}

function enhance(config) {
  const form = formElement(config.form);
  const id = formId(form);
  if (!isForm(form) || !id || form.dataset.formFlow === '1') return CONTROLLERS.get(id) || null;
  const groups = groupsFromMarkers(form, config);
  if (!groups.length) return null;

  form.dataset.formFlow = '1';
  form.dataset.steps = '1'; // compatibilitate cu versiunile vechi ale stratului vizual
  const autosaveEnabled = config.autosave !== false;
  form.dataset.autosave = autosaveEnabled ? 'on' : 'off';

  const progress = make('div', 'form-progress full');
  const progressTitle = make('strong', '', config.title || 'Completarea formularului');
  const initialMessage = autosaveEnabled ? 'Autosave activ' : 'Datele sensibile nu sunt păstrate local';
  const progressStatus = make('span', 'form-progress-status' + (autosaveEnabled ? ' draft-state' : ''), initialMessage);
  progressStatus.setAttribute('role', 'status');
  progressStatus.setAttribute('aria-live', 'polite');
  const progressActions = make('div', 'form-progress-actions');
  const discardButton = make('button', 'btn ghost small form-draft-discard', 'Șterge ciorna');
  discardButton.type = 'button';
  discardButton.hidden = true;
  discardButton.title = 'Elimină datele salvate local în acest tab și reîncarcă formularul';
  progressActions.append(progressStatus, discardButton);
  const track = make('div', 'form-progress-track');
  track.setAttribute('aria-hidden', 'true');
  const fill = make('span');
  track.appendChild(fill);
  progress.append(progressTitle, progressActions, track);

  const fragment = document.createDocumentFragment();
  fragment.appendChild(progress);
  const steps = [];

  function openStep(index, focus) {
    steps.forEach((step, stepIndex) => { step.open = stepIndex === index; });
    const step = steps[index];
    if (!step) return;
    if (focus !== false) {
      step.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const field = step.querySelector('input:not([type="hidden"]),select,textarea,button');
      if (field) setTimeout(() => field.focus({ preventScroll: true }), 180);
    }
  }

  groups.forEach((group, index) => {
    const step = make('details', 'form-step full');
    step.dataset.stepIndex = String(index);
    step.open = index === 0;
    const summary = make('summary');
    summary.append(
      make('span', 'form-step-number', String(index + 1)),
      make('span', 'form-step-title', group.title),
      make('span', 'form-step-state'),
    );
    const body = make('div', 'form-step-body');
    if (group.intro) {
      Array.from(group.intro.children).forEach((node) => {
        if (!/^H[2-4]$/.test(node.tagName)) body.appendChild(node);
      });
    }
    group.nodes.forEach((node) => body.appendChild(node));

    const actions = make('div', 'form-step-actions full');
    if (index > 0) {
      const previous = make('button', 'btn ghost', 'Înapoi');
      previous.type = 'button';
      previous.addEventListener('click', () => openStep(index - 1));
      actions.appendChild(previous);
    }
    if (index < groups.length - 1) {
      const next = make('button', 'btn primary', 'Continuă');
      next.type = 'button';
      next.addEventListener('click', () => {
        // Nu ascunde un câmp obligatoriu invalid într-un pas închis. Validarea finală rămâne și
        // pe submit, dar aici utilizatorul primește context exact în locul în care completează.
        const invalid = Array.from(body.querySelectorAll('input,select,textarea'))
          .find((control) => !control.disabled && typeof control.checkValidity === 'function' && !control.checkValidity());
        if (invalid) {
          step.classList.add('has-error');
          updateProgress();
          invalid.reportValidity();
          invalid.focus();
          return;
        }
        openStep(index + 1);
      });
      actions.appendChild(next);
    }
    if (actions.children.length) body.appendChild(actions);
    step.append(summary, body);
    fragment.appendChild(step);
    steps.push(step);
  });
  form.replaceChildren(fragment);

  let entity = typeof config.entityKey === 'function' ? config.entityKey(form) : (config.entityKey || 'nou');
  let timer = 0;
  let restoring = false;
  let dirty = false;
  let hasDraft = false;
  let message = initialMessage;

  function storageKey() {
    const company = typeof config.companyKey === 'function' ? config.companyKey(form) : companyKey();
    return draftStorageKey(id, company, entity, userKey());
  }

  function progressControls() {
    if (typeof config.progressFields === 'function') return Array.from(config.progressFields(form) || []);
    if (Array.isArray(config.progressFields)) return config.progressFields.map((name) => form.elements[name]).filter(Boolean);
    return defaultProgressControls(form);
  }

  function updateProgress() {
    const controls = progressControls();
    const tracked = new Set(controls);
    const percent = completionPercent(controls.map(controlComplete));
    fill.style.width = percent + '%';
    progress.setAttribute('aria-label', (config.title || 'Formular') + ' completat ' + percent + '%');
    progressStatus.textContent = percent + '% complet · ' + message;
    discardButton.hidden = !autosaveEnabled || !hasDraft;
    steps.forEach((step) => {
      const required = Array.from(step.querySelectorAll('[required]')).filter((control) => !control.disabled);
      // Formularele de configurare au deliberat puține atribute `required`: serverul acceptă
      // valori parțiale, dar bara de progres urmărește explicit câmpurile importante. Pentru ele,
      // pasul devine „Complet” când toate controalele urmărite din acel pas au valoare.
      const followed = Array.from(step.querySelectorAll('input,select,textarea'))
        .filter((control) => !control.disabled && tracked.has(control));
      const completionControls = required.length ? required : followed;
      const complete = completionControls.length > 0 && completionControls.every(controlComplete);
      const valid = Array.from(step.querySelectorAll('input,select,textarea')).every((control) =>
        control.disabled || !control.willValidate || !control.validity || control.validity.valid);
      if (step.classList.contains('has-error') && valid) step.classList.remove('has-error');
      step.classList.toggle('is-complete', complete);
      const state = step.querySelector('.form-step-state');
      if (state) {
        state.textContent = step.classList.contains('has-error') ? 'Verifică' : (complete ? 'Complet' : '');
        state.classList.toggle('is-error', step.classList.contains('has-error'));
      }
    });
  }

  function capture() {
    return typeof config.serialize === 'function' ? config.serialize(form) : serializeDefault(form);
  }

  function saveDraft() {
    clearTimeout(timer);
    timer = 0;
    if (!autosaveEnabled) return false;
    if (restoring || !dirty) return false;
    const payload = { version: 1, savedAt: Date.now(), data: capture() };
    try { sessionStorage.setItem(storageKey(), JSON.stringify(payload)); } catch (_) { return false; }
    dirty = false;
    hasDraft = true;
    message = 'Ciornă salvată la ' + draftTime(payload.savedAt);
    progressStatus.classList.add('draft-state');
    updateProgress();
    return true;
  }

  function restoreDraft() {
    clearTimeout(timer);
    timer = 0;
    if (!autosaveEnabled) {
      dirty = false;
      hasDraft = false;
      message = initialMessage;
      progressStatus.classList.remove('draft-state');
      updateProgress();
      return false;
    }
    let raw = null;
    try { raw = sessionStorage.getItem(storageKey()); } catch (_) { /* autosave-ul este best effort */ }
    if (!raw) {
      dirty = false;
      hasDraft = false;
      message = initialMessage;
      progressStatus.classList.add('draft-state');
      updateProgress();
      return false;
    }
    let payload;
    try { payload = JSON.parse(raw); } catch (_) { return false; }
    if (!payload || payload.version !== 1) return false;
    restoring = true;
    try {
      if (typeof config.restore === 'function') config.restore(form, payload.data);
      else restoreDefault(form, payload.data);
    } finally { restoring = false; }
    dirty = false;
    hasDraft = true;
    message = 'Ciornă restaurată · salvată la ' + draftTime(payload.savedAt);
    progressStatus.classList.add('draft-state');
    updateProgress();
    form.dispatchEvent(new CustomEvent('formflow:restored', { detail: { entity, savedAt: payload.savedAt } }));
    return true;
  }

  function removeDraft(savedMessage) {
    clearTimeout(timer);
    timer = 0;
    if (autosaveEnabled) { try { sessionStorage.removeItem(storageKey()); } catch (_) { /* */ } }
    dirty = false;
    hasDraft = false;
    message = savedMessage || 'Autosave activ';
    progressStatus.classList.toggle('draft-state', autosaveEnabled);
    updateProgress();
  }

  const controller = {
    form,
    flush: saveDraft,
    refresh: updateProgress,
    restore: restoreDraft,
    loaded(nextEntity, options = {}) {
      clearTimeout(timer);
      timer = 0;
      entity = nextEntity || 'nou';
      dirty = false;
      hasDraft = false;
      message = initialMessage;
      progressStatus.classList.toggle('draft-state', autosaveEnabled);
      steps.forEach((step) => step.classList.remove('has-error'));
      const restored = options.restore !== false && restoreDraft();
      if (!restored) updateProgress();
      openStep(0, false);
      return restored;
    },
    saved() { removeDraft('Date salvate pe server'); },
    discard() { removeDraft('Ciornă eliminată'); },
    openStep,
    get entity() { return entity; },
    get key() { return storageKey(); },
  };
  CONTROLLERS.set(id, controller);

  discardButton.addEventListener('click', async () => {
    if (!hasDraft) return;
    const accepted = await confirmAction(
      'Se elimină doar ciorna păstrată local în acest tab. Datele salvate deja pe server nu sunt afectate.',
      { title: 'Ștergi ciorna locală?', confirmLabel: 'Șterge ciorna', danger: true },
    );
    if (!accepted) return;
    const discardedEntity = entity;
    controller.discard();
    if (typeof config.onDiscard === 'function') await config.onDiscard(form, controller);
    else {
      form.reset();
      controller.loaded(entity, { restore: false });
    }
    form.dispatchEvent(new CustomEvent('formflow:discarded', { detail: { entity: discardedEntity } }));
  });

  steps.forEach((step) => {
    step.addEventListener('toggle', () => {
      if (!step.open) return;
      steps.forEach((other) => { if (other !== step) other.open = false; });
    });
  });
  form.addEventListener('invalid', (event) => {
    const step = event.target.closest && event.target.closest('.form-step');
    if (step) {
      step.classList.add('has-error');
      openStep(steps.indexOf(step), false);
      updateProgress();
    }
  }, true);
  form.addEventListener('input', () => {
    if (restoring) return;
    if (!autosaveEnabled) { updateProgress(); return; }
    dirty = true;
    message = 'Se salvează ciorna…';
    progressStatus.classList.remove('draft-state');
    updateProgress();
    clearTimeout(timer);
    timer = setTimeout(saveDraft, config.delay || 450);
  });
  form.addEventListener('change', updateProgress);
  updateProgress();
  return controller;
}

export function registerFormFlow(config) {
  return enhance(config || {});
}

function controllerFor(ref) {
  const form = formElement(ref);
  return form && CONTROLLERS.get(formId(form));
}

export function formFlowFlush(ref) {
  const controller = controllerFor(ref);
  return controller ? controller.flush() : false;
}

export function formFlowLoaded(ref, entity, options) {
  const controller = controllerFor(ref);
  return controller ? controller.loaded(entity, options) : false;
}

export function formFlowSaved(ref) {
  const controller = controllerFor(ref);
  if (controller) controller.saved();
}

export function formFlowDiscard(ref) {
  const controller = controllerFor(ref);
  if (controller) controller.discard();
}

export function refreshFormFlow(ref) {
  const controller = controllerFor(ref);
  if (controller) controller.refresh();
}

export function flushAllFormFlows() {
  CONTROLLERS.forEach((controller) => controller.flush());
}

export function setFormFlowCompany(company) {
  ACTIVE_COMPANY = company == null || company === '' ? null : String(company);
}

export function setFormFlowUser(user) {
  ACTIVE_USER = user == null || user === '' ? null : String(user);
}

// Delogarea trebuie sa duca ciornele cu ea. Cheia pe utilizator opreste RESTAURAREA la alt cont,
// dar datele (CNP, salariu brut) ar ramane in tab pana la inchiderea lui; stergerea le scoate.
export function clearFormFlowDrafts() {
  let keys = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && key.indexOf(STORAGE_PREFIX) === 0) keys.push(key);
    }
    keys.forEach((key) => sessionStorage.removeItem(key));
  } catch (_) { /* stocarea locala este best effort */ }
  return keys.length;
}
