import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// A restore rewrites the exact preset files an open slicer holds — and Orca and
// Bambu Studio write their whole user preset library back out when they exit,
// so a restore performed underneath a live slicer is undone minutes later
// without a word. The install path has refused to run in that state for as long
// as it has existed (`detectRunningSlicerProcess` → "Check again" loop, then a
// second refusal in the backend). Restore has to hold the same line.
//
// The project has no jsdom, so this drives the real UI code against a minimal
// document shim — enough for the element helpers in src/ui/dom.ts.
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

function textOf(n: FakeNode): string {
  return n.tag === '#text' ? n.text : n.children.map(textOf).join('');
}

const body = makeNode('body');
vi.stubGlobal('document', {
  createElement: (tag: string) => makeNode(tag),
  createTextNode: (t: string) => makeNode('#text', t),
  createDocumentFragment: () => makeNode('#fragment'),
  body
});
vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });

// The native bridge, stubbed at the module boundary the UI imports.
const detectRunningSlicerProcess = vi.fn<(id: string) => Promise<boolean>>();
const restoreProfileBackup = vi.fn(async () => ({ restored_files: ['a.json'], deleted_files: [] }));
const deleteProfileBackup = vi.fn(async () => {});
const listProfileBackups = vi.fn(async (): Promise<unknown[]> => []);
vi.mock('../src/slicerIntegration/bridge', () => ({
  isDesktop: () => true,
  detectRunningSlicerProcess: (id: string) => detectRunningSlicerProcess(id),
  restoreProfileBackup: () => restoreProfileBackup(),
  listProfileBackups: () => listProfileBackups(),
  deleteProfileBackup: () => deleteProfileBackup(),
  openBackupDirectory: async () => {}
}));

// Dialog answers, queued in the order the flow asks for them.
const answers: boolean[] = [];
const dialogs: { title: string; body: string; confirmLabel?: string }[] = [];
vi.mock('../src/ui/dom', async importOriginal => {
  const real = await importOriginal<typeof import('../src/ui/dom')>();
  return {
    ...real,
    confirmDialog: async (o: { title: string; body: string; confirmLabel?: string }) => {
      dialogs.push(o);
      return answers.shift() ?? false;
    },
    toast: vi.fn()
  };
});

const { restoreSlicerBackup, slicerBackupsCard } = await import('../src/ui/settings');
const { toast } = await import('../src/ui/dom');

const BACKUP = {
  backup_id: '1785144030-45352',
  slicer_id: 'orca',
  created_at: '2026-07-26T09:40:02Z',
  installed_profile_name: 'Preset library snapshot (default)',
  perfectfit_project_id: 'proj-1',
  file_count: 41,
  backup_root: 'C:\\backups\\orca\\1785144030-45352'
};

function restore(host: FakeNode) {
  return restoreSlicerBackup(host as unknown as HTMLElement, BACKUP);
}

beforeEach(() => {
  answers.length = 0;
  dialogs.length = 0;
  body.children = [];
  detectRunningSlicerProcess.mockReset();
  restoreProfileBackup.mockClear();
  deleteProfileBackup.mockClear();
  listProfileBackups.mockReset();
  listProfileBackups.mockResolvedValue([]);
  vi.mocked(toast).mockClear();
});

/** Every button under `n`, in document order. */
function buttons(n: FakeNode, out: FakeNode[] = []): FakeNode[] {
  if (n.tag === 'button') out.push(n);
  n.children.forEach(c => buttons(c, out));
  return out;
}
/** Let queued promise callbacks run — the click handlers are fire-and-forget. */
const settle = () => new Promise(r => setTimeout(r, 0));

describe('restoring a slicer preset backup while the slicer is open', () => {
  it('never writes into the preset library of a running slicer', async () => {
    detectRunningSlicerProcess.mockResolvedValue(true);
    answers.push(true /* Restore */, false /* give up rather than check again */);

    await restore(makeNode('div'));

    expect(restoreProfileBackup, 'a restore ran underneath a live slicer').not.toHaveBeenCalled();
    expect(detectRunningSlicerProcess).toHaveBeenCalledWith('orca');
  });

  it('names the slicer and offers the installer\'s "Check again" loop', async () => {
    detectRunningSlicerProcess.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    answers.push(true /* Restore */, true /* Check again — user closed it */);

    await restore(makeNode('div'));

    const openDialog = dialogs[1];
    expect(openDialog.title).toContain('Orca Slicer');
    expect(openDialog.confirmLabel).toBe('Check again');
    // Closing the slicer and pressing "Check again" gets on with the restore
    // instead of dropping the user back at the table.
    expect(restoreProfileBackup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls[0][0]).toContain('Restored 1 file');
  });

  it('goes straight through when the slicer is closed', async () => {
    detectRunningSlicerProcess.mockResolvedValue(false);
    answers.push(true);

    await restore(makeNode('div'));

    expect(dialogs).toHaveLength(1); // just the "Restore this backup?" confirm
    expect(restoreProfileBackup).toHaveBeenCalledTimes(1);
  });

  it('still restores when the native process check is unavailable — the backend re-checks', async () => {
    detectRunningSlicerProcess.mockRejectedValue(new Error('no such command'));
    answers.push(true);

    await restore(makeNode('div'));

    expect(restoreProfileBackup).toHaveBeenCalledTimes(1);
  });

  it('cancelling the first confirm checks nothing and writes nothing', async () => {
    detectRunningSlicerProcess.mockResolvedValue(false);
    answers.push(false);

    await restore(makeNode('div'));

    expect(detectRunningSlicerProcess).not.toHaveBeenCalled();
    expect(restoreProfileBackup).not.toHaveBeenCalled();
  });

  // The report names which presets were already reverted and which were not —
  // the only thing a user can finish the job by hand from. Rebuilding the
  // backups table (deleting a backup, taking a new one) must not throw it away
  // behind their back; only the Dismiss button may.
  it('survives a refresh of the backups table', async () => {
    listProfileBackups.mockResolvedValue([BACKUP]);
    detectRunningSlicerProcess.mockResolvedValue(false);
    restoreProfileBackup.mockRejectedValueOnce(new Error(
      'Restore copy failed for PLA 11.json: Access is denied. (os error 5)\n'
      + 'The restore stopped part-way. Already reverted to the backed-up version:\n  restored PLA 0.json'));

    const card = slicerBackupsCard() as unknown as FakeNode;
    await settle();

    const restoreBtn = buttons(card).find(b => textOf(b).includes('Restore'))!;
    answers.push(true);
    restoreBtn.listeners['click'][0]();
    await settle();
    expect(textOf(card), 'the report never appeared').toContain('restored PLA 0.json');

    // Now delete an unrelated backup, which rebuilds the table.
    const deleteBtn = buttons(card).find(b => textOf(b).includes('🗑'))!;
    answers.push(true);
    deleteBtn.listeners['click'][0]();
    await settle();

    expect(deleteProfileBackup).toHaveBeenCalledTimes(1);
    expect(textOf(card), 'refreshing the list erased the half-restored report')
      .toContain('restored PLA 0.json');
  });

  it('reports a backend refusal on a panel that stays, not a toast', async () => {
    detectRunningSlicerProcess.mockResolvedValue(false); // it started during the dialog
    restoreProfileBackup.mockRejectedValueOnce(new Error(
      'SLICER_RUNNING: Close Orca Slicer before restoring — it holds preset files open and rewrites them when it exits.'));
    answers.push(true);

    const host = makeNode('div');
    await restore(host);

    expect(host.children).toHaveLength(1);
    expect(textOf(host.children[0])).toContain('Nothing was changed');
    expect(vi.mocked(toast)).not.toHaveBeenCalled();
  });
});
