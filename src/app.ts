import { h, clear } from './ui/dom';
import { loadSettings, saveSettings } from './storage/store';
import { renderDashboard } from './ui/dashboard';
import { renderPrinters } from './ui/printers';
import { renderNewProject } from './ui/projectNew';
import { renderProject } from './ui/projectView';
import { renderWizard } from './ui/wizard';
import { renderGuidedSession } from './ui/guidedSession';
import { renderHelp } from './ui/help';
import { renderSettings } from './ui/settings';
import { renderCard } from './ui/card';
import { renderReport } from './ui/report';
import { renderProfileWizard } from './ui/profileWizard';
import { isDesktop, openExternalUrl } from './slicerIntegration/bridge';
import { toast } from './ui/dom';
import type { CalibrationId } from './types';

export type Route =
  | { view: 'dashboard' }
  | { view: 'printers' }
  | { view: 'new-project' }
  | { view: 'project'; id: string }
  | { view: 'wizard'; id: string; step: CalibrationId }
  // The guided session runs ALONGSIDE the wizard above, which is unchanged. The
  // step segment is optional: without one the session opens on its own focus.
  | { view: 'session'; id: string; step?: CalibrationId }
  | { view: 'card'; id: string }
  | { view: 'report'; id: string }
  | { view: 'profile'; id: string }
  | { view: 'help'; term?: string }
  | { view: 'settings' };

let outlet: HTMLElement;

/** Guard invoked before navigating away; set by wizard forms with unsaved work. */
let leaveGuard: (() => Promise<boolean>) | null = null;
export function setLeaveGuard(fn: (() => Promise<boolean>) | null): void { leaveGuard = fn; }

function prefersDarkScheme(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Re-lights the header's DAY|NIGHT switch. Registered by `startApp` so that
 * `applyTheme()` — which Settings also calls — keeps the switch honest no matter
 * where the theme was changed from.
 */
let relightPanelSwitch: (() => void) | null = null;

export function applyTheme(): void {
  const s = loadSettings();
  const theme = s.theme === 'auto' ? (prefersDarkScheme() ? 'dark' : 'light') : s.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.largeText = String(s.largeText);
  relightPanelSwitch?.();
}

function onPreferredColorSchemeChange(fn: () => void): void {
  if (typeof window.matchMedia !== 'function') return;
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', fn);
  } else if (typeof query.addListener === 'function') {
    query.addListener(fn);
  }
}

export function navigate(hash: string): void {
  if (location.hash === hash) { void route(); return; }
  location.hash = hash;
}

export function parseHash(): Route {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case 'printers': return { view: 'printers' };
    case 'new': return { view: 'new-project' };
    case 'project': return parts[1] ? { view: 'project', id: parts[1] } : { view: 'dashboard' };
    case 'wizard': return parts[1] && parts[2] ? { view: 'wizard', id: parts[1], step: parts[2] as CalibrationId } : { view: 'dashboard' };
    case 'session': return parts[1] ? { view: 'session', id: parts[1], step: parts[2] as CalibrationId | undefined } : { view: 'dashboard' };
    case 'card': return parts[1] ? { view: 'card', id: parts[1] } : { view: 'dashboard' };
    case 'report': return parts[1] ? { view: 'report', id: parts[1] } : { view: 'dashboard' };
    case 'profile': return parts[1] ? { view: 'profile', id: parts[1] } : { view: 'dashboard' };
    case 'help': return { view: 'help', term: parts[1] };
    case 'settings': return { view: 'settings' };
    default: return { view: 'dashboard' };
  }
}

async function route(): Promise<void> {
  const r = parseHash();
  updateNav(r);
  clear(outlet);
  try {
    switch (r.view) {
      case 'dashboard': await renderDashboard(outlet); break;
      case 'printers': await renderPrinters(outlet); break;
      case 'new-project': await renderNewProject(outlet); break;
      case 'project': await renderProject(outlet, r.id); break;
      case 'wizard': await renderWizard(outlet, r.id, r.step); break;
      case 'session': await renderGuidedSession(outlet, r.id, r.step); break;
      case 'card': await renderCard(outlet, r.id); break;
      case 'report': await renderReport(outlet, r.id); break;
      case 'profile': await renderProfileWizard(outlet, r.id); break;
      case 'help': renderHelp(outlet, r.term); break;
      case 'settings': renderSettings(outlet); break;
    }
  } catch (err) {
    clear(outlet);
    outlet.append(
      h('div', { class: 'callout callout-bad', role: 'alert' },
        h('h1', { class: 'co-title' }, 'Instrument fault'),
        h('p', {}, 'This view failed to load. Your data is stored locally on this device and is not affected — nothing was lost.'),
        h('p', { class: 'field-help' }, String(err)),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-primary', onClick: () => navigate('#/') }, 'Back to dashboard'))
      )
    );
  }
  window.scrollTo(0, 0);
}

/**
 * Nav items are panel placards: a short ALL-CAPS legend under an icon (the icon
 * itself is drawn from the stylesheet, keyed off `href`). `title` carries the
 * long name so the terse placard never costs meaning.
 */
function navLink(href: string, label: string, title: string = label): HTMLElement {
  return h('a', { href, title }, label);
}

let navEl: HTMLElement;

function updateNav(r: Route): void {
  navEl.querySelectorAll('a').forEach(a => {
    const target = a.getAttribute('href') ?? '';
    const active =
      (target === '#/' && r.view === 'dashboard') ||
      (target === '#/printers' && r.view === 'printers') ||
      (target === '#/help' && r.view === 'help') ||
      (target === '#/settings' && r.view === 'settings');
    a.classList.toggle('active', active);
  });
}

/**
 * In the desktop (Tauri) app, `target="_blank"` anchors silently do nothing —
 * the webview has nowhere to open a new tab. Intercept clicks on external
 * http(s) links and hand them to the OS default browser via the native command.
 * In the browser build this handler is inert, so normal `_blank` behavior stays.
 */
function installExternalLinkHandler(): void {
  if (!isDesktop()) return;
  document.addEventListener('click', (e) => {
    // Left-click only; modifier keys have no useful default in the webview, so
    // we still handle them rather than letting them do nothing.
    if (e.defaultPrevented || e.button !== 0) return;
    const anchor = (e.target as HTMLElement | null)?.closest('a');
    const href = anchor?.getAttribute('href');
    if (!href || !/^https?:\/\//i.test(href)) return; // in-app #/ routes fall through
    e.preventDefault();
    openExternalUrl(href).catch(() => toast('Could not open the link in your browser.', 'error'));
  });
}

/** The theme actually in force right now ('auto' resolved against the OS). */
function effectiveTheme(): 'dark' | 'light' {
  const s = loadSettings();
  return s.theme === 'auto' ? (prefersDarkScheme() ? 'dark' : 'light') : s.theme;
}

/**
 * Panel lighting switch — a two-position DAY | NIGHT selector in the DIM-knob
 * idiom. Both positions are always drawn; only the one in force is lit. A single
 * static legend can only ever name a mode, never report which one you are in;
 * a two-position switch reports state the way a real panel switch does.
 *
 * Semantics: a radiogroup with roving tabindex, so the pair is ONE tab stop and
 * the arrow keys walk the detents. Selecting a position writes an explicit
 * theme into settings (leaving 'auto' behind, exactly as the old button did);
 * while settings still say 'auto', the lit position is whatever the OS resolves
 * to, and it re-lights if the OS flips.
 */
function panelLightingSwitch(): { root: HTMLElement; sync: () => void } {
  const positions: { theme: 'light' | 'dark'; label: string; name: string }[] = [
    { theme: 'light', label: 'DAY', name: 'Day' },
    { theme: 'dark', label: 'NIGHT', name: 'Night' }
  ];

  const buttons = positions.map(p => h('button', {
    type: 'button',
    class: 'dim-switch-opt',
    role: 'radio',
    'aria-checked': 'false',
    'aria-label': `${p.name} panel lighting`,
    tabindex: '-1',
    title: `Panel lighting: ${p.name.toLowerCase()}`
  }, p.label));

  const sync = (): void => {
    const active = effectiveTheme();
    positions.forEach((p, i) => {
      const lit = p.theme === active;
      buttons[i].classList.toggle('is-active', lit);
      buttons[i].setAttribute('aria-checked', String(lit));
      buttons[i].tabIndex = lit ? 0 : -1;
    });
  };

  const select = (index: number, moveFocus: boolean): void => {
    const s = loadSettings();
    s.theme = positions[index].theme;
    saveSettings(s);
    applyTheme(); // re-lights this switch via `relightPanelSwitch`
    if (moveFocus) buttons[index].focus();
  };

  buttons.forEach((b, i) => b.addEventListener('click', () => select(i, false)));

  const root = h('div', { class: 'dim-switch', role: 'radiogroup', 'aria-label': 'Panel lighting' }, buttons);

  root.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1
      : key === 'ArrowLeft' || key === 'ArrowUp' ? -1
        : 0;
    if (!step) return;
    e.preventDefault();
    const current = positions.findIndex(p => p.theme === effectiveTheme());
    select((current + step + positions.length) % positions.length, true);
  });

  sync();
  return { root, sync };
}

export function startApp(): void {
  applyTheme();
  installExternalLinkHandler();

  const root = document.getElementById('app')!;
  clear(root);
  navEl = h('nav', { class: 'app-nav', 'aria-label': 'Main navigation' },
    navLink('#/', 'Projects', 'Calibration projects'),
    navLink('#/printers', 'Printers', 'Printer profiles'),
    navLink('#/help', 'Help', 'Help & glossary'),
    navLink('#/settings', 'Settings', 'Settings')
  );

  const lighting = panelLightingSwitch();
  relightPanelSwitch = lighting.sync;
  onPreferredColorSchemeChange(() => { applyTheme(); });

  root.append(
    h('header', { class: 'app-header' },
      // Order matters at narrow widths: `.app-nav` goes full-width and wraps to
      // its own line, so the lighting switch must sit BEFORE it to stay on the
      // logo row. Trailing it would orphan it onto a third line, left-aligned,
      // where it reads like a fifth nav item.
      h('div', { class: 'app-header-inner' },
        h('a', { class: 'app-logo', href: '#/', title: 'PerfectFit — filament calibration' },
          h('span', { class: 'dot', 'aria-hidden': 'true' }, '•'),
          h('span', { class: 'placard placard-lit', style: 'font-size:.8rem' }, 'PerfectFit'),
          h('span', { class: 'readout-label' }, 'Filament calibration')),
        h('div', { class: 'header-spacer' }),
        lighting.root,
        navEl
      )
    ),
    (outlet = h('main', { id: 'main' }))
  );

  window.addEventListener('hashchange', async (e) => {
    if (leaveGuard) {
      const ok = await leaveGuard();
      if (!ok) {
        // Revert the hash; replaceState doesn't fire hashchange, so the guard stays armed.
        const old = (e as HashChangeEvent).oldURL;
        const oldHash = old.includes('#') ? old.slice(old.indexOf('#')) : '#/';
        history.replaceState(null, '', oldHash);
        return;
      }
      leaveGuard = null;
    }
    void route();
  });

  void route();
}
