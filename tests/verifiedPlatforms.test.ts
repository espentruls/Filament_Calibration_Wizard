// ---------------------------------------------------------------------------
// Verified-version lookup is per PLATFORM, and the platform must be the real one.
//
// The New Profile wizard used to hand `findVerifiedVersion` a hard-coded
// 'windows'. Since every entry in VERIFIED_VERSIONS is Windows-only, that made a
// macOS or Linux install look verified, which SUPPRESSED the paragraph telling
// the user they can still export for manual import — while the capability line
// beside it, computed from the real platform, correctly said direct install was
// unverified. We ship macOS and Linux builds, so these assertions guard a live
// user-visible contradiction, not a hypothetical one.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { VERIFIED_VERSIONS, findVerifiedVersion, capabilitiesFor } from '../src/slicerIntegration/registry';
import type { Platform } from '../src/slicerIntegration/types';

const NON_WINDOWS: Platform[] = ['macos', 'linux'];

describe('verified slicer versions are platform-scoped', () => {
  it('has at least one entry, and every entry names its platforms', () => {
    expect(VERIFIED_VERSIONS.length).toBeGreaterThan(0);
    for (const v of VERIFIED_VERSIONS) {
      expect(v.platforms.length, v.slicerId).toBeGreaterThan(0);
    }
  });

  it('matches a Windows entry only on Windows', () => {
    for (const v of VERIFIED_VERSIONS) {
      if (!v.platforms.includes('windows')) continue;
      const version = `${v.versionRange}.0`;
      expect(findVerifiedVersion(v.slicerId, version, 'windows')).not.toBeNull();
      for (const p of NON_WINDOWS) {
        if (v.platforms.includes(p)) continue;
        expect(findVerifiedVersion(v.slicerId, version, p), `${v.slicerId} on ${p}`).toBeNull();
      }
    }
  });

  it('reports direct install as unverified on a platform with no entry', () => {
    // The capability and the explanatory paragraph must agree: both are driven
    // by this same lookup, so neither can claim verification the other denies.
    const v = VERIFIED_VERSIONS.find(e => e.directInstallVerified && e.platforms.includes('windows'));
    expect(v).toBeDefined();
    const version = `${v!.versionRange}.0`;
    for (const p of NON_WINDOWS) {
      if (v!.platforms.includes(p)) continue;
      const caps = capabilitiesFor(v!.slicerId, version, p, true, false);
      expect(caps.canInstallDirectly, p).toBe(false);
      // Export never touches slicer data, so it stays available everywhere —
      // which is exactly the fallback the suppressed paragraph pointed at.
      expect(caps.canExportProfiles, p).toBe(true);
    }
    expect(capabilitiesFor(v!.slicerId, version, 'windows', true, false).canInstallDirectly).toBe(true);
  });
});
