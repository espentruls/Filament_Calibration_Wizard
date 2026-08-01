// ---------------------------------------------------------------------------
// Finding the slicer the user actually has.
//
// A slicer family can be installed in several flavours — Bambu Studio and Bambu
// Studio Beta keep separate data directories — and the app used to know only
// one folder name per slicer. On the machine this was written against that made
// the live Beta invisible while the abandoned release folder was reported as a
// verified install: its config version prefix-matched a `directInstallVerified`
// entry, so the wizard offered direct installation into a directory the running
// slicer has not opened since 2026-07-18.
//
// These tests fix the shape of the fix. They run against fabricated detection
// payloads and the static registry — never against a real slicer configuration.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest';
import {
  SLICER_VARIANTS, SLICER_DESCRIPTORS, VERIFIED_VERSIONS, capabilitiesFor,
  defaultVariantFor, familyProcessNames, findVerifiedVersion, slicerDisplayName,
  slicerVariantById, variantsForSlicer
} from '../../src/slicerIntegration/registry';
import {
  chooseDefaultLocation, detectInstallations, rankInstallsByRecency
} from '../../src/slicerIntegration/scanner';
import type {
  IntegrationSlicerId, SlicerInstallation, UserDataLocation
} from '../../src/slicerIntegration/types';
import type { RawDetectedSlicer, RawUserDataLocation } from '../../src/slicerIntegration/bridge';

// --- fabricated detection payloads -----------------------------------------
// Shapes mirror what was read (read-only) off a real Windows machine on
// 2026-08-01: a stale BambuStudio folder (config 02.07.01.62, empty
// preset_folder, sync off, empty user/default) beside a live BambuStudioBeta
// folder (BambuStudio.conf inside it, 02.08.01.55, preset_folder 1234567890,
// sync on).

const RELEASE_CONF_AT = 1784353910; // 2026-07-18
const BETA_CONF_AT = 1785580992;    // 2026-08-01

function loc(over: Partial<RawUserDataLocation> = {}): RawUserDataLocation {
  return {
    account_id: 'default',
    path: 'C:\\Users\\x\\AppData\\Roaming\\BambuStudio\\user\\default',
    active: true,
    filament_profile_count: 0,
    ...over
  };
}

function rawRow(over: Partial<RawDetectedSlicer> = {}): RawDetectedSlicer {
  return {
    slicer_id: 'bambu',
    variant_id: 'bambu',
    variant_label: 'Bambu Studio',
    is_default_variant: true,
    data_dir: 'C:\\Users\\x\\AppData\\Roaming\\BambuStudio',
    conf_version: '02.07.01.62',
    conf_modified_at: RELEASE_CONF_AT,
    preset_folder: '',
    sync_user_preset: false,
    superseded_by: null,
    executable_path: 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
    user_locations: [loc()],
    notes: [],
    ...over
  };
}

const BETA_ROW: RawDetectedSlicer = rawRow({
  variant_id: 'bambu-beta',
  variant_label: 'Bambu Studio (Beta)',
  is_default_variant: false,
  data_dir: 'C:\\Users\\x\\AppData\\Roaming\\BambuStudioBeta',
  conf_version: '02.08.01.55',
  conf_modified_at: BETA_CONF_AT,
  preset_folder: '1234567890',
  sync_user_preset: true,
  user_locations: [
    loc({
      account_id: '1234567890',
      path: 'C:\\Users\\x\\AppData\\Roaming\\BambuStudioBeta\\user\\1234567890',
      active: true,
      filament_profile_count: 1
    }),
    loc({
      account_id: 'default',
      path: 'C:\\Users\\x\\AppData\\Roaming\\BambuStudioBeta\\user\\default',
      active: false,
      filament_profile_count: 0
    })
  ]
});

const RELEASE_ROW: RawDetectedSlicer = rawRow({
  superseded_by: 'Bambu Studio (Beta)',
  notes: ['Bambu Studio (Beta) was used more recently (2026-08-01). A preset written into this folder will not appear in that install.']
});

// --- desktop-shell stub -----------------------------------------------------
// `detectInstallations` reaches the native side through window.__TAURI__.
// Nothing here touches the filesystem.

function withDesktop(rows: RawDetectedSlicer[]): void {
  (globalThis as Record<string, unknown>).window = {
    __TAURI__: {
      core: {
        invoke: (cmd: string) => {
          if (cmd === 'get_platform_info') {
            return Promise.resolve({ platform: 'windows', os_version: 'windows' });
          }
          if (cmd === 'detect_supported_slicers') return Promise.resolve(rows);
          return Promise.reject(new Error(`unexpected command ${cmd}`));
        }
      }
    }
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

// --- installation fixtures for the pure helpers -----------------------------

function install(over: Partial<SlicerInstallation> = {}): SlicerInstallation {
  return {
    id: 'bambu@02.07.01.62',
    slicerId: 'bambu',
    variantId: 'bambu',
    displayName: 'Bambu Studio',
    isDefaultVariant: true,
    version: '02.07.01.62',
    executablePath: null,
    dataDirectory: 'C:\\d\\BambuStudio',
    confModifiedAt: RELEASE_CONF_AT,
    cloudSyncEnabled: false,
    supersededBy: null,
    userDataLocations: [],
    source: 'automatic',
    confidence: 'verified',
    capabilities: capabilitiesFor('bambu', '02.07.01.62', 'windows', true, false),
    notes: [],
    ...over
  };
}

function uiLocation(over: Partial<UserDataLocation> = {}): UserDataLocation {
  return {
    id: 'bambu:default',
    variantId: 'bambu',
    path: 'C:\\d\\BambuStudio\\user\\default',
    accountId: 'default',
    active: false,
    filamentProfileCount: 0,
    cloudLinked: false,
    ...over
  };
}

// ---------------------------------------------------------------------------

describe('install flavours in the registry', () => {
  it('keeps the family id stable across flavours', () => {
    // The frontend selects Bambu behaviour by comparing this id to the literal
    // 'bambu' — the extruder-variant legend guards that keep one nozzle's
    // calibration out of another nozzle's slot are among those comparisons. A
    // flavour-specific id would make them silently false for Beta users.
    const bambu = variantsForSlicer('bambu');
    expect(bambu.length).toBeGreaterThan(1);
    for (const v of bambu) expect(v.slicerId).toBe('bambu');
    expect(bambu.map(v => v.variantId)).toContain('bambu-beta');
    expect(slicerDisplayName('bambu')).toBe('Bambu Studio');
  });

  it('gives every family exactly one default flavour, and unique flavour ids', () => {
    const seen = new Set<string>();
    for (const v of SLICER_VARIANTS) {
      expect(seen.has(v.variantId), `duplicate flavour id ${v.variantId}`).toBe(false);
      seen.add(v.variantId);
      expect(SLICER_DESCRIPTORS[v.slicerId], `unknown family ${v.slicerId}`).toBeDefined();
    }
    for (const id of Object.keys(SLICER_DESCRIPTORS) as IntegrationSlicerId[]) {
      const defaults = variantsForSlicer(id).filter(v => v.isDefault);
      expect(defaults.length, `family ${id}`).toBe(1);
      expect(defaultVariantFor(id)?.variantId).toBe(defaults[0].variantId);
    }
  });

  it('records the Beta data folder and its config file name separately', () => {
    // The config inside BambuStudioBeta\ is called BambuStudio.conf. Deriving
    // the name from the folder leaves it unread, which makes the active preset
    // folder unknown and used to target the empty user\default instead of the
    // account folder holding the user's presets.
    const beta = slicerVariantById('bambu-beta');
    expect(beta).not.toBeNull();
    expect(beta!.dataDirName).toBe('BambuStudioBeta');
    expect(beta!.confFileName).toBe('BambuStudio.conf');
    expect(beta!.confFileName).not.toBe(`${beta!.dataDirName}.conf`);
    expect(beta!.isDefault).toBe(false);
  });

  it('gives the Beta no macOS candidate, because none was verified', () => {
    // Guessing ~/Library/Application Support/BambuStudioBeta would be
    // indistinguishable from a path someone actually read off a machine.
    const beta = slicerVariantById('bambu-beta')!;
    expect(beta.macosAppCandidates).toEqual([]);
    expect(beta.notes.join(' ')).toContain('UNVERIFIED');
  });

  it('watches every flavour of a family for a running process', () => {
    // Verified 2026-08-01: the Beta replaced the release binary in the same
    // folder and runs under the same image name, so a process match cannot
    // tell them apart — and a write must be refused while either is open.
    const names = familyProcessNames('bambu');
    expect(names).toContain('bambu-studio.exe');
    for (const v of variantsForSlicer('bambu')) {
      for (const n of v.processNames) expect(names).toContain(n);
    }
    // Deduplicated: the two flavours list the same names.
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('version verification for the Beta', () => {
  it('recognizes 02.08 but does not claim direct install is verified', () => {
    const v = findVerifiedVersion('bambu', '02.08.01.55', 'windows');
    expect(v).not.toBeNull();
    expect(v!.directInstallVerified).toBe(false);
    const caps = capabilitiesFor('bambu', '02.08.01.55', 'windows', true, false);
    expect(caps.canInstallDirectly).toBe(false);
    // Everything that never touches slicer data still works.
    expect(caps.canScanProfiles).toBe(true);
    expect(caps.canGenerateProfiles).toBe(true);
    expect(caps.canExportProfiles).toBe(true);
  });

  it('leaves the verified 02.07 entry alone', () => {
    expect(capabilitiesFor('bambu', '02.07.01.62', 'windows', true, false).canInstallDirectly).toBe(true);
  });

  it('never carries a directInstallVerified entry without a verification date', () => {
    for (const v of VERIFIED_VERSIONS) {
      if (!v.directInstallVerified) continue;
      expect(v.verificationDate, v.slicerId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v.notes.length, v.slicerId).toBeGreaterThan(0);
    }
  });
});

describe('rankInstallsByRecency', () => {
  it('puts the most recently used install of a family first', () => {
    const stale = install({ id: 'bambu@02.07.01.62', confModifiedAt: RELEASE_CONF_AT });
    const live = install({
      id: 'bambu-beta@02.08.01.55', variantId: 'bambu-beta',
      displayName: 'Bambu Studio (Beta)', version: '02.08.01.55',
      confModifiedAt: BETA_CONF_AT, isDefaultVariant: false
    });
    expect(rankInstallsByRecency([stale, live]).map(i => i.id))
      .toEqual(['bambu-beta@02.08.01.55', 'bambu@02.07.01.62']);
  });

  it('does not let a stale install win because its version is the verified one', () => {
    // The exact trap: the abandoned folder reports 02.07.01.62, which matches a
    // directInstallVerified entry, while the running build uses the other
    // folder. Whichever install a caller takes first must be the live one.
    const stale = install({ id: 'bambu@02.07.01.62', confModifiedAt: RELEASE_CONF_AT });
    const live = install({
      id: 'bambu-beta@02.08.01.55', variantId: 'bambu-beta', version: '02.08.01.55',
      confModifiedAt: BETA_CONF_AT, isDefaultVariant: false,
      capabilities: capabilitiesFor('bambu', '02.08.01.55', 'windows', true, false)
    });
    const first = rankInstallsByRecency([stale, live])[0];
    expect(first.variantId).toBe('bambu-beta');
    expect(stale.capabilities.canInstallDirectly).toBe(true);
    expect(first.capabilities.canInstallDirectly).toBe(false);
  });

  it('sorts an unreadable config last rather than treating it as newest', () => {
    const unknown = install({ id: 'bambu@unknown', confModifiedAt: null });
    const known = install({ id: 'bambu-beta@02.08.01.55', variantId: 'bambu-beta', confModifiedAt: BETA_CONF_AT });
    expect(rankInstallsByRecency([unknown, known]).map(i => i.id))
      .toEqual(['bambu-beta@02.08.01.55', 'bambu@unknown']);
  });

  it('keeps different families in the order they arrived', () => {
    const orca = install({ id: 'orca@2.4.2', slicerId: 'orca', variantId: 'orca', confModifiedAt: 1 });
    const bambu = install({ confModifiedAt: 999 });
    expect(rankInstallsByRecency([orca, bambu]).map(i => i.slicerId)).toEqual(['orca', 'bambu']);
  });
});

describe('chooseDefaultLocation', () => {
  it('returns the location the slicer config names as active', () => {
    const active = uiLocation({ id: 'bambu-beta:1234567890', accountId: '1234567890', active: true, cloudLinked: true });
    const other = uiLocation({ id: 'bambu-beta:default' });
    expect(chooseDefaultLocation(install({ userDataLocations: [other, active] }))?.accountId).toBe('1234567890');
  });

  it('returns null rather than guessing when nothing is active', () => {
    // Picking the first folder found is how a preset ends up in a directory
    // the running slicer never reads.
    const a = uiLocation({ id: 'bambu:default' });
    const b = uiLocation({ id: 'bambu:1234', accountId: '1234', cloudLinked: true });
    expect(chooseDefaultLocation(install({ userDataLocations: [a, b] }))).toBeNull();
  });

  it('takes the only folder there is', () => {
    const only = uiLocation();
    expect(chooseDefaultLocation(install({ userDataLocations: [only] }))?.id).toBe('bambu:default');
  });
});

describe('detectInstallations', () => {
  it('reports both Bambu installs, live one first, under one family id', async () => {
    withDesktop([RELEASE_ROW, BETA_ROW]);
    const installs = await detectInstallations();
    expect(installs.length).toBe(2);
    expect(installs.map(i => i.variantId)).toEqual(['bambu-beta', 'bambu']);
    for (const i of installs) expect(i.slicerId).toBe('bambu');
    // Distinct identities, and named so the user can tell which is which.
    expect(new Set(installs.map(i => i.id)).size).toBe(2);
    expect(installs[0].displayName).toBe('Bambu Studio (Beta)');
    expect(installs[1].displayName).toBe('Bambu Studio');
  });

  it('carries the flavour into every location id so a write cannot cross installs', async () => {
    // Both installs have a `default` account folder. A location keyed on the
    // family alone would address two different directories with one string.
    withDesktop([RELEASE_ROW, BETA_ROW]);
    const installs = await detectInstallations();
    const ids = installs.flatMap(i => i.userDataLocations.map(l => l.id));
    expect(ids).toContain('bambu:default');
    expect(ids).toContain('bambu-beta:default');
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of installs) {
      for (const l of i.userDataLocations) expect(l.variantId).toBe(i.variantId);
    }
  });

  it('marks the Beta account folder active and leaves its empty local folder alone', async () => {
    withDesktop([BETA_ROW]);
    const [beta] = await detectInstallations();
    const active = beta.userDataLocations.filter(l => l.active);
    expect(active.length).toBe(1);
    expect(active[0].accountId).toBe('1234567890');
    expect(active[0].cloudLinked).toBe(true);
    expect(chooseDefaultLocation(beta)?.accountId).toBe('1234567890');
  });

  it('passes the stale-install warning through to the user', async () => {
    withDesktop([RELEASE_ROW, BETA_ROW]);
    const installs = await detectInstallations();
    const stale = installs.find(i => i.variantId === 'bambu')!;
    expect(stale.supersededBy).toBe('Bambu Studio (Beta)');
    expect(stale.notes.join(' ')).toContain('will not appear in that install');
    expect(installs.find(i => i.variantId === 'bambu-beta')!.supersededBy).toBeNull();
  });

  it('cautions about preset cloud sync only where the config says it is on', async () => {
    withDesktop([RELEASE_ROW, BETA_ROW]);
    const installs = await detectInstallations();
    const beta = installs.find(i => i.variantId === 'bambu-beta')!;
    const release = installs.find(i => i.variantId === 'bambu')!;
    expect(beta.cloudSyncEnabled).toBe(true);
    expect(beta.notes.join(' ')).toContain('Preset cloud sync is on');
    expect(release.cloudSyncEnabled).toBe(false);
    expect(release.notes.join(' ')).not.toContain('Preset cloud sync is on');
  });

  it('reports honest capabilities per install version', async () => {
    withDesktop([RELEASE_ROW, BETA_ROW]);
    const installs = await detectInstallations();
    expect(installs.find(i => i.variantId === 'bambu-beta')!.capabilities.canInstallDirectly).toBe(false);
    expect(installs.find(i => i.variantId === 'bambu')!.capabilities.canInstallDirectly).toBe(true);
  });

  it('leaves a single-flavour slicer exactly as it was', async () => {
    withDesktop([rawRow({
      slicer_id: 'orca', variant_id: 'orca', variant_label: 'Orca Slicer',
      data_dir: 'C:\\d\\OrcaSlicer', conf_version: '2.4.2', preset_folder: 'default',
      sync_user_preset: null, conf_modified_at: 1,
      user_locations: [loc({ path: 'C:\\d\\OrcaSlicer\\user\\default', filament_profile_count: 4 })]
    })]);
    const [orca] = await detectInstallations();
    expect(orca.id).toBe('orca@2.4.2');
    expect(orca.variantId).toBe('orca');
    expect(orca.displayName).toBe('Orca Slicer');
    expect(orca.userDataLocations[0].id).toBe('orca:default');
    expect(orca.supersededBy).toBeNull();
    expect(orca.cloudSyncEnabled).toBeNull();
    expect(orca.capabilities.canInstallDirectly).toBe(true);
  });

  it('returns nothing in the browser build', async () => {
    // A window with no Tauri global: the PWA build, where detection cannot run
    // and the wizard falls back to manual file selection.
    (globalThis as Record<string, unknown>).window = {};
    const installs = await detectInstallations();
    expect(installs).toEqual([]);
  });
});
