import { h, clear, field } from './dom';
import { GLOSSARY } from '../data/glossary';
import { MODEL_MANIFEST } from '../data/models';
import { SLICER_CONTENT } from '../data/slicers';

export function renderHelp(root: HTMLElement, term?: string): void {
  const search = h('input', { type: 'search', placeholder: 'Try "pressure", "stringing", "flow"…', value: term ?? '' });
  const count = h('p', { class: 'field-help', role: 'status', 'aria-live': 'polite', style: 'margin:0' });
  const empty = h('p', { class: 'field-help' }, 'No matches. Try a shorter word.');
  const list = h('dl', { style: 'margin:0' });

  const refresh = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const hits = GLOSSARY.filter(g =>
      !q || g.term.toLowerCase().includes(q) || g.definition.toLowerCase().includes(q));
    count.textContent = q
      ? `${hits.length} of ${GLOSSARY.length} terms match “${search.value.trim()}”.`
      : `${GLOSSARY.length} terms.`;
    empty.style.display = hits.length ? 'none' : '';
    for (const g of hits) {
      list.append(h('div', { class: 'glossary-item' },
        h('dt', {}, g.term),
        h('dd', {}, g.definition,
          g.related?.length
            ? h('p', { class: 'field-help' },
                h('span', { class: 'placard' }, 'Related'), ' ', g.related.join(' · '))
            : null)));
    }
  };
  search.addEventListener('input', refresh);
  refresh();

  root.append(
    h('p', { style: 'margin:0' }, h('span', { class: 'placard' }, 'Reference')),
    h('h1', {}, 'Help & glossary'),
    h('div', { class: 'card' },
      h('h2', {}, 'How PerfectFit works'),
      h('p', {}, 'Each calibration project walks one spool through up to six calibration tests plus a final verification print. The wizard tells you exactly what to click in your slicer, how to judge the print, and does every calculation in the open — inputs, formula, result.'),
      h('p', {}, 'A value you have not measured yet stays dark everywhere in the app. Nothing is filled in with a plausible default on your behalf, so what you see is only ever what you actually measured.'),
      h('p', {}, 'Your data never leaves this device: no account, no uploads, no analytics, no telemetry. Photos you attach are stored locally in your browser\'s storage. External model links open third-party sites in a new tab.'),
      h('p', {}, 'Recommended order and formulas follow the official Orca Slicer documentation; Bambu Studio paths are covered where its features differ. Sources: ',
        ...SLICER_CONTENT.map((s, i) => h('span', {}, i ? ' · ' : '', h('a', { href: s.docsUrl, target: '_blank', rel: 'noopener' }, `${s.slicerLabel} docs ↗`)))
      )
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Glossary'),
      field('Search the glossary', search, 'Matches both terms and their definitions.'),
      count,
      h('hr', { class: 'rule-ticks' }),
      empty,
      list
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Test models'),
      h('p', { class: 'field-help' }, 'Orca Slicer generates every core calibration test in-slicer — no downloads needed. These external models are optional helpers. Links open third-party sites; licenses belong to their authors.'),
      h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Use'), h('th', {}, 'Source'), h('th', {}, 'License'), h('th', {}, 'Attribution'))),
        h('tbody', {}, MODEL_MANIFEST.map(m => h('tr', {},
          h('td', {}, m.test, h('div', { class: 'field-help' }, m.recommendedUse)),
          h('td', {}, h('a', { href: m.sourceUrl, target: '_blank', rel: 'noopener' }, 'Link ↗'), m.bundled ? ' (bundled)' : ' (download)'),
          h('td', {}, m.license),
          h('td', {}, m.attribution))))
      ))
    )
  );
}
