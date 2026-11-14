'use strict';

// Helpers shared by the player app (app.js) and the TV/scoreboard display (display.js).
window.HotTake = (() => {
  // ---- storage (can throw in private mode, so always guarded) -----------

  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function writeJSON(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage unavailable: preferences just won't survive a reload */ }
  }

  // ---- text ---------------------------------------------------------------

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const initial = (name) => esc([...String(name).trim()][0]?.toUpperCase() || '?');

  /** Puts answers into the prompt's blanks (or appends them if it has none); empty blanks stay as lines. */
  function fillPrompt(text, cards) {
    const parts = String(text).split(/_{3,}/);
    const fills = cards.map((c) => `<span class="fill">${esc(c.text.replace(/[.!?]+$/, ''))}</span>`);
    if (parts.length - 1 < cards.length) {
      return `${esc(text)} ${fills.join(' / ')}`;
    }
    return parts.map((p, i) => esc(p) + (i < parts.length - 1 ? (fills[i] ?? '<span class="blank"></span>') : '')).join('');
  }

  // ---- icons (simple inline SVG, stroke = currentColor) ------------------

  const svg = (body, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const icons = {
    menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>'),
    users: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.3 3-5 6-5s5.4 1.7 6 5"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14c2.2.2 3.6 1.6 4 4"/>'),
    link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    tv: svg('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    // Hot Take's card mark: a small flame.
    flame: `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.6 2.4c.5 3-1.2 4.6-2.6 6.1-1.5 1.6-3 3.3-3 6 0 3.6 2.6 6.5 5.6 6.5 3.4 0 6.4-2.6 6.4-6.6 0-2.6-1.3-4.4-2.4-5.6.1 1.6-.5 2.9-1.6 3.4.3-3.7-.7-7.6-2.4-9.8zm-.4 11.2c.7 1.3 2.6 2 2.6 4 0 1.5-1.2 2.7-2.7 2.7s-2.6-1.1-2.6-2.6c0-1.8 1.7-2.3 2.7-4.1z"/></svg>`,
  };

  // ---- layout: "phone" or "big", automatic unless the person picks one ----
  // Big = laptops, TVs and tablets held sideways. Phones turned sideways stay on the phone layout
  // because they're too short (under 560px tall) for side-by-side columns.

  const LAYOUT_KEY = 'hottake.layout';
  const LAYOUTS = { auto: 'Auto', phone: 'Phone', big: 'Big screen' };
  const bigQuery = window.matchMedia('(min-width: 900px) and (min-height: 560px) and (orientation: landscape)');
  const layoutListeners = new Set();

  const layoutPref = () => (LAYOUTS[readJSON(LAYOUT_KEY)] ? readJSON(LAYOUT_KEY) : 'auto');
  const resolveLayout = (pref = layoutPref()) => (pref === 'auto' ? (bigQuery.matches ? 'big' : 'phone') : pref);

  function applyLayout() {
    const layout = resolveLayout();
    const root = document.documentElement;
    const changed = root.dataset.layout !== layout;
    root.dataset.layout = layout;
    root.dataset.layoutPref = layoutPref();
    if (changed) layoutListeners.forEach((fn) => fn(layout));
    return layout;
  }

  function setLayoutPref(pref) {
    writeJSON(LAYOUT_KEY, pref === 'auto' ? null : pref);
    applyLayout();
    layoutListeners.forEach((fn) => fn(resolveLayout()));
  }

  bigQuery.addEventListener('change', applyLayout);
  applyLayout();

  /** A segmented Auto / Phone / Big screen control; clicks arrive as data-act="layout" data-value="…". */
  function layoutPicker() {
    const pref = layoutPref();
    const now = resolveLayout();
    return `
      <div class="setting-block">
        <span class="eyebrow">Layout</span>
        <div class="segmented" role="radiogroup" aria-label="Layout">
          ${Object.entries(LAYOUTS).map(([value, label]) => `
            <button role="radio" aria-checked="${pref === value}" class="${pref === value ? 'on' : ''}"
              data-act="layout" data-value="${value}">${label}</button>`).join('')}
        </div>
        <p class="muted small">${pref === 'auto' ? `Auto picked ${LAYOUTS[now]} for this screen.` : 'Saved on this device.'}</p>
      </div>`;
  }

  // ---- keep the screen awake while something is on screen -----------------

  function keepAwake(shouldKeep) {
    let lock = null;
    async function request() {
      if (!shouldKeep() || lock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } catch { /* not allowed (e.g. low battery, or plain HTTP); harmless */ }
    }
    document.addEventListener('visibilitychange', request);
    return request;
  }

  return {
    readJSON,
    writeJSON,
    esc,
    plural,
    initial,
    fillPrompt,
    icons,
    layoutPref,
    resolveLayout,
    setLayoutPref,
    onLayoutChange: (fn) => layoutListeners.add(fn),
    layoutPicker,
    keepAwake,
  };
})();
