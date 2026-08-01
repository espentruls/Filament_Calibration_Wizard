import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_EXPERIMENTAL_FEATURES } from '../src/slicerIntegration/types';

const REPO_ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** The repository slug this build belongs to, taken from package metadata. */
function slugFromPackageJson(): string {
  const pkg = JSON.parse(read('package.json')) as { repository: { url: string } };
  const m = /github\.com\/([^/]+\/[^/.]+)/.exec(pkg.repository.url);
  expect(m, 'package.json repository.url must be a github URL').not.toBeNull();
  return m![1];
}

// A fork whose install guide points at UPSTREAM's releases page sends its own
// downloaders to a different application. Here that difference is a safety one:
// upstream has no per-nozzle feed path, so an X2D auxiliary (bowden) nozzle gets
// direct-drive pressure-advance and retraction ranges roughly ten times too
// narrow. These assertions keep the guide and the metadata from drifting apart
// again on the next fork or rename.
describe('docs and package metadata point at this repository', () => {
  const slug = slugFromPackageJson();

  // Anchor the slug to something the shipped BUILD carries, not just to the
  // other docs: consistency alone is satisfied by every reference pointing at
  // upstream together. The bundle identifier is io.github.<owner>.<app>, and it
  // is the identity macOS/Windows install the app under.
  it('is the repository whose owner the shipped bundle identifier names', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { identifier: string };
    const owner = /^io\.github\.([^.]+)\./.exec(conf.identifier)?.[1];
    expect(owner, `unexpected bundle identifier ${conf.identifier}`).toBeTruthy();
    expect(slug.split('/')[0]).toBe(owner);
  });

  it('sends Mac downloaders to this repository’s releases page', () => {
    const doc = read('Install on Mac.md');
    // A clone URL carries a `.git` suffix on the same slug; strip it so the
    // comparison stays exact rather than becoming a substring check.
    const links = [...doc.matchAll(/https:\/\/github\.com\/([^/\s)>]+\/[^/\s)>]+)/g)]
      .map(m => m[1].replace(/\.git$/, ''));
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l, `Install on Mac.md links to ${l}`).toBe(slug);
  });

  it('routes bug reports and the homepage to this repository', () => {
    const pkg = JSON.parse(read('package.json')) as {
      repository: { url: string }; bugs: { url: string }; homepage: string;
    };
    for (const url of [pkg.repository.url, pkg.bugs.url, pkg.homepage]) {
      expect(url).toContain(`github.com/${slug}`);
    }
    expect(read('src-tauri/Cargo.toml')).toContain(`repository = "https://github.com/${slug}"`);
  });

  it('tells contributors to clone this repository', () => {
    const f = '.github/CONTRIBUTING.md';
    const clones = [...read(f).matchAll(/git clone \(?(https:\/\/github\.com\/[^\s)]+)/g)].map(m => m[1]);
    expect(clones.length, `${f} has no git clone line`).toBeGreaterThan(0);
    for (const c of clones) expect(c, `${f} clones ${c}`).toContain(`github.com/${slug}`);
  });

  // The root copy was misspelled `CONRIBUTING.md`, so GitHub never surfaced it
  // and it drifted out of step with the real one — two guides, one of them
  // invisible and wrong. It was deleted; a second copy under any spelling is a
  // regression, because the next fix will land in only one of them.
  it('keeps exactly one contributing guide', () => {
    const strays = readdirSync(REPO_ROOT).filter(n => /^CON.?RIBUTING\.md$/i.test(n));
    expect(strays, 'contributing guide belongs in .github/ only').toEqual([]);
    expect(existsSync(join(REPO_ROOT, '.github/CONTRIBUTING.md'))).toBe(true);
  });

  it('names the app the way this fork actually installs it', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { productName: string };
    const doc = read('Install on Mac.md');
    expect(doc).toContain(conf.productName);
    // "look for PerfectFit in Applications" would be wrong: the bundle is named
    // by productName, so a bare mention sends the reader hunting for the wrong
    // icon. Since 3.0.0 that icon says "Trim", and "PerfectFit" survives in this
    // guide only as the name of the version the reader is migrating FROM — so
    // every occurrence must still be qualified as "PerfectFit X2D", never bare,
    // or the guide tells a Mac user to look for an app that is not there.
    const bare = [...doc.matchAll(/PerfectFit(?! X2D)/g)];
    expect(bare.map(m => doc.slice(Math.max(0, m.index! - 30), m.index! + 30)))
      .toEqual([]);
  });
});

// The README is where a downloader decides whether to trust the app with their
// slicer configuration. It used to state, under "Known limitations", that there
// is "No slicer preset **file** export" and that the app "deliberately guides
// manual entry instead of risking a broken preset" — while generation AND
// direct installation into the real preset directory both ship ON by default.
// Informed consent for the most dangerous thing this product does cannot rest
// on a document that denies the feature exists.
describe('the README describes what the shipped defaults actually do', () => {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');

  it('does not deny a feature that is on by default', () => {
    if (!DEFAULT_EXPERIMENTAL_FEATURES.slicerProfileGeneration) return;
    expect(readme).not.toMatch(/No slicer preset \*\*file\*\* export/i);
    expect(readme).not.toMatch(/deliberately guides manual entry/i);
  });

  it('discloses direct installation and where to turn it off', () => {
    if (!DEFAULT_EXPERIMENTAL_FEATURES.automaticProfileInstallation) return;
    expect(readme).toMatch(/user preset directory/i);
    expect(readme).toMatch(/Settings → Experimental/);
  });

  it('does not list a shipped feature as a future idea', () => {
    const future = readme.slice(readme.indexOf('## Future ideas'));
    expect(future).not.toMatch(/slicer preset export/i);
  });
});
