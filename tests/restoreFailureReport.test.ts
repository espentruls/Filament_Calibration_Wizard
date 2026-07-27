import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// A restore that stops part-way leaves the preset library half old and half
// new. The backend hands back the exact list of what it already reverted —
// dozens of lines — and that list used to be passed to `toast()`, which drops
// it into a small box as one run-on paragraph and deletes the element 3.5 s
// later. There is no scrollback, so the only record of a half-restored slicer
// library disappeared while the user was still reading it.
//
// The project has no jsdom, so this test drives the real UI code against a
// minimal document shim — enough for the element helpers in src/ui/dom.ts.
// ---------------------------------------------------------------------------

interface FakeNode {
  tag: string;
  text: string;
  children: FakeNode[];
  parent: FakeNode | null;
  className: string;
  attrs: Record<string, string>;
  listeners: Record<string, ((e?: unknown) => void)[]>;
  classList: { add: (c: string) => void };
  append: (...n: (FakeNode | string)[]) => void;
  prepend: (...n: (FakeNode | string)[]) => void;
  remove: () => void;
  setAttribute: (k: string, v: string) => void;
  addEventListener: (k: string, fn: (e?: unknown) => void) => void;
  removeChild: (n: FakeNode) => void;
  firstChild: FakeNode | null;
}

function makeNode(tag: string, text = ''): FakeNode {
  const node: FakeNode = {
    tag, text, children: [], parent: null, className: '', attrs: {}, listeners: {},
    classList: { add: (c: string) => { node.className = `${node.className} ${c}`.trim(); } },
    append(...nodes) {
      for (const n of nodes) {
        const child = typeof n === 'string' ? makeNode('#text', n) : n;
        child.parent = node;
        node.children.push(child);
      }
    },
    prepend(...nodes) {
      for (const n of nodes.reverse()) {
        const child = typeof n === 'string' ? makeNode('#text', n) : n;
        child.parent = node;
        node.children.unshift(child);
      }
    },
    remove() {
      if (!node.parent) return;
      node.parent.children = node.parent.children.filter(c => c !== node);
      node.parent = null;
    },
    removeChild(n) { node.children = node.children.filter(c => c !== n); },
    setAttribute(k, v) { node.attrs[k] = v; },
    addEventListener(k, fn) { (node.listeners[k] ??= []).push(fn); },
    get firstChild() { return node.children[0] ?? null; }
  };
  return node;
}

/** All text inside a node tree, the way a reader would see it. */
function textOf(n: FakeNode): string {
  return n.tag === '#text' ? n.text : n.children.map(textOf).join('');
}

/** Is `needle` still somewhere under `root`? */
function contains(root: FakeNode, needle: FakeNode): boolean {
  return root === needle || root.children.some(c => contains(c, needle));
}

const body = makeNode('body');
vi.stubGlobal('document', {
  createElement: (tag: string) => makeNode(tag),
  createTextNode: (t: string) => makeNode('#text', t),
  createDocumentFragment: () => makeNode('#fragment'),
  body
});
vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });

const { reportRestoreFailure } = await import('../src/ui/settings');
const { toast } = await import('../src/ui/dom');

/** What the backend really returns: a RestoreFailure rendered by Display. */
const PART_WAY_REPORT = [
  'Restore copy failed for C:\\Users\\me\\AppData\\Roaming\\OrcaSlicer\\user\\default\\filament\\PLA 11.json: Access is denied. (os error 5)',
  'The restore stopped part-way. Already reverted to the backed-up version:',
  ...Array.from({ length: 10 }, (_, i) => `  restored C:\\Users\\me\\AppData\\Roaming\\OrcaSlicer\\user\\default\\filament\\PLA ${i}.json`),
  'Not reverted (still as they were before this restore):',
  ...Array.from({ length: 30 }, (_, i) => `  C:\\Users\\me\\AppData\\Roaming\\OrcaSlicer\\user\\default\\machine\\Printer ${i}.json`)
].join('\n');

/**
 * The real UI code is typed against the browser DOM; the shim above is a
 * stand-in for it, so the boundary is crossed once, here, instead of littering
 * casts through the assertions.
 */
function report(host: FakeNode, detail: string): FakeNode {
  return reportRestoreFailure(host as unknown as HTMLElement, detail) as unknown as FakeNode;
}

beforeEach(() => {
  body.children = [];
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe('a restore that stopped part-way', () => {
  it('keeps the whole file-by-file report on screen, with no timer', () => {
    const host = makeNode('div');
    const panel = report(host, PART_WAY_REPORT);

    expect(contains(host, panel)).toBe(true);
    const shown = textOf(panel);
    // Every line the backend reported has to be readable, not summarized away.
    for (const line of PART_WAY_REPORT.split('\n')) {
      expect(shown).toContain(line.trim());
    }

    // A toast is gone 3.9 s after it appears. This must not be.
    vi.advanceTimersByTime(60_000);
    expect(contains(host, panel)).toBe(true);
    expect(textOf(panel)).toContain('PLA 0.json');
  });

  it('is longer-lived than the toast it replaced', () => {
    toast('Restore failed: something', 'error');
    const toastHost = body.children.find(c => c.className.includes('toast-host'))!;
    expect(toastHost.children).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(toastHost.children).toHaveLength(0); // the old behaviour, still true

    const host = makeNode('div');
    report(host, PART_WAY_REPORT);
    vi.advanceTimersByTime(4000);
    expect(host.children).toHaveLength(1);
  });

  it('tells the user to close the slicer when that is why it refused', () => {
    const host = makeNode('div');
    const panel = report(host,
      'SLICER_RUNNING: Close OrcaSlicer before restoring — it holds preset files open and rewrites them when it exits.');
    const shown = textOf(panel);
    expect(shown).toContain('Nothing was changed');
    expect(shown).toContain('Close it');
  });

  it('offers the list as copyable text', () => {
    const host = makeNode('div');
    const panel = report(host, PART_WAY_REPORT);
    const buttons: FakeNode[] = [];
    const walk = (n: FakeNode) => { if (n.tag === 'button') buttons.push(n); n.children.forEach(walk); };
    walk(panel);
    const copy = buttons.find(b => textOf(b).includes('Copy'))!;
    copy.listeners['click'][0]();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(PART_WAY_REPORT);
  });
});
