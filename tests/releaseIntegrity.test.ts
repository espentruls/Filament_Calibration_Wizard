import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

const WORKFLOW = '.github/workflows/release.yml';

// The release workflow is the last thing between a regression and an installer
// on someone's machine — an installer for an app that emits numbers a printer
// physically executes and writes into the user's real slicer preset directory.
// It used to run `npm ci` and the printer-database check, then hand straight off
// to the packaging action, which only builds. Neither test suite gated anything.
describe('the release workflow gates the binaries it publishes', () => {
  const yml = read(WORKFLOW);
  const lines = yml.split(/\r?\n/);
  const lineOf = (re: RegExp, what: string): number => {
    const i = lines.findIndex(l => re.test(l));
    expect(i, `${WORKFLOW} has no step that ${what}`).toBeGreaterThanOrEqual(0);
    return i;
  };

  it('runs the TypeScript suite before anything is packaged', () => {
    const test = lineOf(/^\s*run:\s*npm test\s*$/, 'runs `npm test`');
    const pack = lineOf(/tauri-apps\/tauri-action/, 'packages the app');
    expect(test, '`npm test` must run before the packaging step').toBeLessThan(pack);
  });

  it('runs the Rust suite before anything is packaged', () => {
    const test = lineOf(/^\s*run:\s*cargo test\b/, 'runs `cargo test`');
    const pack = lineOf(/tauri-apps\/tauri-action/, 'packages the app');
    expect(test, '`cargo test` must run before the packaging step').toBeLessThan(pack);
  });

  // Both suites are inside the build matrix rather than in a separate job, so
  // they run on the same OS that produces each binary. The Rust half is where
  // the file writing, the atomic replace and the backup live — the half whose
  // behaviour differs most per platform.
  it('runs them on every platform that produces a binary', () => {
    const publishJob = yml.indexOf('\n  publish:');
    expect(publishJob, 'expected a publish job').toBeGreaterThan(0);
    for (const cmd of ['npm test', 'cargo test']) {
      expect(yml.slice(0, publishJob), `${cmd} must run inside the build matrix`)
        .toContain(cmd);
    }
  });
});

// Every file that states the version has to state the same one. An installer
// reporting one number while its notes and changelog report another is a release
// nobody can reason about, and the workflow's own gate below enforces it in CI.
describe('the version agrees everywhere', () => {
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { version: string };

  it('is the same in package.json, Cargo.toml and tauri.conf.json', () => {
    const cargo = /^version = "(.*)"$/m.exec(read('src-tauri/Cargo.toml'))?.[1];
    expect(conf.version).toBe(pkg.version);
    expect(cargo).toBe(pkg.version);
  });

  it('is what the top CHANGELOG entry describes, and that entry is released', () => {
    const top = /^## +([^\s]+) +- +(.+)$/m.exec(read('CHANGELOG.md'));
    expect(top, 'CHANGELOG.md has no `## <version> - <date>` heading').not.toBeNull();
    expect(top![1]).toBe(pkg.version);
    expect(top![2].trim(), 'the shipped version may not be "Unreleased"')
      .toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is enforced by the workflow rather than kept in step by hand', () => {
    const yml = read(WORKFLOW);
    expect(yml).toMatch(/package\.json/);
    expect(yml).toMatch(/CHANGELOG\.md/);
    expect(yml, 'the workflow must fail on a version mismatch')
      .toMatch(/::error::Version mismatch/);
  });
});

// The assisted path that would have configured and sliced each calibration test
// was removed before release. Advertising it in the release notes or the README
// tells a downloader the app does something it will never do.
describe('nothing advertises the removed auto-prepare path', () => {
  const claim = /auto-?prepare|automated (?:test )?preparation|automated test \*preparation\*|automatically prepares/gi;

  for (const f of [WORKFLOW, 'README.md']) {
    it(`${f} only mentions it as removed`, () => {
      const text = read(f);
      for (const m of text.matchAll(claim)) {
        const around = text.slice(Math.max(0, m.index! - 500), m.index! + 300);
        expect(around, `"${m[0]}" in ${f} is not marked as removed`)
          .toMatch(/removed|gone from the shipped code|does \*\*not\*\* prepare|not prepare/i);
      }
    });
  }
});

// The Windows .exe is unsigned and the macOS .dmg unnotarized. SmartScreen warns
// on every download and macOS reports the dmg as "damaged" — wording that reads
// as a malware detection. Saying nothing leaves a downloader to guess.
describe('the unsigned installer is disclosed', () => {
  it('is stated in the release notes, with the steps to proceed', () => {
    // `\s+` rather than a literal space: these notes are a wrapped YAML block
    // scalar, so the claim may straddle a line break, and `**` emphasis may sit
    // on either side of the word.
    const yml = read(WORKFLOW);
    expect(yml).toMatch(/not\s+(?:\*\*\s*)?code-signed/i);
    expect(yml).toMatch(/not\s+(?:\*\*\s*)?notarized/i);
    expect(yml, 'the Windows steps must be spelled out').toMatch(/More info/);
    expect(yml, 'the macOS steps must be spelled out').toMatch(/Open Anyway/);
  });

  it('is stated in the README', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/not\s+(?:\*\*\s*)?code-signed/i);
    expect(readme).toMatch(/not\s+(?:\*\*\s*)?notarized/i);
    expect(readme).toMatch(/SmartScreen/i);
  });

  it('is stated in the Mac install guide, before the install steps', () => {
    const doc = read('Install on Mac.md');
    const disclosure = doc.search(/not\s+(?:\*\*\s*)?notarized/i);
    expect(disclosure, 'Install on Mac.md never says the dmg is unnotarized')
      .toBeGreaterThanOrEqual(0);
    expect(disclosure, 'the disclosure must come before "Step-by-step install"')
      .toBeLessThan(doc.indexOf('## Step-by-step install'));
    expect(doc, 'the "damaged" message must be explained')
      .toMatch(/damaged/i);
  });
});
