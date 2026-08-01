// ---------------------------------------------------------------------------
// Slicer registry: install flavours (verified detection data) and the version
// compatibility registry that gates automatic installation.
//
// Every path/name here was read off a real installation — see
// docs/SLICER_PROFILE_RESEARCH.md. Unverified entries are marked and must not
// enable direct install.
//
// A slicer FAMILY (`IntegrationSlicerId`, e.g. 'bambu') can be installed in
// several FLAVOURS — release, beta, nightly — each with its own data
// directory and config file. The family id is the preset-format/adapter key and
// stays the same across flavours; the flavour id addresses one install.
//
// The family id must NEVER be made flavour-specific. Bambu behaviour is
// selected all over the app by comparing this id to the literal 'bambu'
// (validation.ts and orcaFamily.ts use it for the extruder-variant legend
// guards that keep one nozzle's calibration out of another nozzle's slot), and
// TypeScript does not catch a string comparison quietly going false.
// ---------------------------------------------------------------------------

import type {
  IntegrationSlicerId, SlicerFamily, SlicerCapabilities, VerifiedSlicerVersion, Platform
} from './types';

/** One install flavour of a slicer family. Mirrors Rust `SlicerVariant`. */
export interface SlicerVariantDescriptor {
  /** Unique flavour key, e.g. 'bambu-beta'. Used to address one install. */
  variantId: string;
  /** Family key — the adapter/preset-format key shared by every flavour. */
  slicerId: IntegrationSlicerId;
  /** Flavour display name, e.g. 'Bambu Studio (Beta)'. */
  displayName: string;
  /** Folder name under %APPDATA% (Win) / ~/Library/Application Support (macOS). */
  dataDirName: string;
  /**
   * Config file NAME inside the data directory. Not derivable from
   * `dataDirName`: Bambu Studio Beta keeps `BambuStudio.conf` inside
   * `BambuStudioBeta\`, and deriving the name leaves the config unread — which
   * makes the active preset folder unknown and used to target the wrong
   * account directory.
   */
  confFileName: string;
  /** Candidate executable paths relative to the platform's program root. */
  windowsExeCandidates: string[];
  macosAppCandidates: string[];
  /** Process image names used for running-detection. */
  processNames: string[];
  /** The flavour used when nothing narrows the family down. */
  isDefault: boolean;
  /** Verified date for the detection data above. */
  detectionVerifiedOn: string;
  notes: string[];
}

/**
 * Every install flavour, flat, one row per flavour actually seen on a machine.
 *
 * A row may only be added after the data directory, the config file name, the
 * executable path and the process image name have been read off a real
 * install, with the date. Orca nightly builds and the macOS Bambu Studio Beta
 * path are deliberately absent: no machine was available to inspect them, and
 * a guessed path in this table would be indistinguishable from a verified one.
 */
export const SLICER_VARIANTS: SlicerVariantDescriptor[] = [
  {
    variantId: 'orca',
    slicerId: 'orca',
    displayName: 'Orca Slicer',
    dataDirName: 'OrcaSlicer',
    confFileName: 'OrcaSlicer.conf',
    windowsExeCandidates: ['OrcaSlicer\\orca-slicer.exe'],
    macosAppCandidates: ['OrcaSlicer.app'],
    processNames: ['orca-slicer.exe', 'OrcaSlicer'],
    isDefault: true,
    detectionVerifiedOn: '2026-07-19',
    notes: []
  },
  {
    variantId: 'bambu',
    slicerId: 'bambu',
    displayName: 'Bambu Studio',
    dataDirName: 'BambuStudio',
    confFileName: 'BambuStudio.conf',
    windowsExeCandidates: ['Bambu Studio\\bambu-studio.exe'],
    macosAppCandidates: ['BambuStudio.app'],
    processNames: ['bambu-studio.exe', 'BambuStudio'],
    isDefault: true,
    detectionVerifiedOn: '2026-07-19',
    notes: ['Account preset directories may be cloud-synchronized.']
  },
  {
    variantId: 'bambu-beta',
    slicerId: 'bambu',
    displayName: 'Bambu Studio (Beta)',
    dataDirName: 'BambuStudioBeta',
    confFileName: 'BambuStudio.conf',
    windowsExeCandidates: ['Bambu Studio\\bambu-studio.exe'],
    // UNVERIFIED on macOS: no macOS machine was available to read the Beta's
    // Application Support folder or bundle name. Left empty rather than
    // guessed — detection there falls back to the data directory.
    macosAppCandidates: [],
    processNames: ['bambu-studio.exe', 'BambuStudio'],
    isDefault: false,
    detectionVerifiedOn: '2026-08-01',
    notes: [
      'Config file is BambuStudio.conf inside BambuStudioBeta\\, not BambuStudioBeta.conf.',
      'On Windows the Beta replaced the release binary in the same folder: one executable at Bambu Studio\\bambu-studio.exe (FileVersion 02.08.01.55) running under the image name bambu-studio.exe, shared with the release entry. The executable therefore cannot tell the two flavours apart — only the data directory can — and the running-slicer refusal covers both because the process name is the same.',
      'macOS data path UNVERIFIED — no macOS entry.'
    ]
  },
  {
    variantId: 'snapmaker-orca',
    slicerId: 'snapmaker-orca',
    displayName: 'Snapmaker Orca',
    dataDirName: 'Snapmaker_Orca',
    confFileName: 'Snapmaker_Orca.conf',
    windowsExeCandidates: ['Snapmaker_Orca\\snapmaker-orca.exe'],
    macosAppCandidates: ['Snapmaker Orca.app', 'Snapmaker_Orca.app'],
    processNames: ['snapmaker-orca.exe', 'Snapmaker Orca'],
    isDefault: true,
    detectionVerifiedOn: '2026-07-19',
    notes: []
  },
  {
    variantId: 'elegoo',
    slicerId: 'elegoo',
    displayName: 'ElegooSlicer',
    dataDirName: 'ElegooSlicer',
    confFileName: 'ElegooSlicer.conf',
    windowsExeCandidates: ['ElegooSlicer\\elegoo-slicer.exe'],
    macosAppCandidates: ['ElegooSlicer.app'],
    processNames: ['elegoo-slicer.exe', 'ElegooSlicer'],
    isDefault: true,
    detectionVerifiedOn: '2026-07-19',
    notes: ['Machine presets can appear directly in the user root; filament scan only reads user/*/filament.']
  },
  {
    variantId: 'flash-studio',
    slicerId: 'flash-studio',
    displayName: 'Flash Studio (Orca-Flashforge)',
    dataDirName: 'Orca-Flashforge',
    confFileName: 'Orca-Flashforge.conf',
    windowsExeCandidates: [
      'Flashforge\\Orca-Flashforge\\flash studio.exe',
      'Flashforge\\Orca-Flashforge\\Orca-Flashforge.exe'
    ],
    macosAppCandidates: ['Orca-Flashforge.app', 'Flash Studio.app'],
    processNames: ['flash studio.exe', 'Orca-Flashforge.exe', 'Orca-Flashforge'],
    isDefault: true,
    detectionVerifiedOn: '2026-07-19',
    notes: ['Rebranded from Orca-Flashforge; data folder keeps the old name. Some presets ship without .info sidecars.']
  }
];

/** Family-level descriptor. Paths live on the flavours, not here. */
export interface SlicerDescriptor {
  id: IntegrationSlicerId;
  displayName: string;
  family: SlicerFamily;
  /** Install flavours of this family, in registry order. */
  variants: SlicerVariantDescriptor[];
}

const FAMILY_META: Record<IntegrationSlicerId, { displayName: string; family: SlicerFamily }> = {
  'orca': { displayName: 'Orca Slicer', family: 'orca' },
  'bambu': { displayName: 'Bambu Studio', family: 'bambu' },
  'snapmaker-orca': { displayName: 'Snapmaker Orca', family: 'orca' },
  'elegoo': { displayName: 'ElegooSlicer', family: 'orca' },
  'flash-studio': { displayName: 'Flash Studio (Orca-Flashforge)', family: 'orca' }
};

export const SLICER_DESCRIPTORS: Record<IntegrationSlicerId, SlicerDescriptor> =
  (Object.keys(FAMILY_META) as IntegrationSlicerId[]).reduce((acc, id) => {
    acc[id] = {
      id,
      displayName: FAMILY_META[id].displayName,
      family: FAMILY_META[id].family,
      variants: SLICER_VARIANTS.filter(v => v.slicerId === id)
    };
    return acc;
  }, {} as Record<IntegrationSlicerId, SlicerDescriptor>);

/** Family display name (never flavour-specific — use `variantLabel` for that). */
export function slicerDisplayName(id: IntegrationSlicerId): string {
  return SLICER_DESCRIPTORS[id]?.displayName ?? id;
}

/** Every install flavour of one family, in registry order. */
export function variantsForSlicer(id: IntegrationSlicerId): SlicerVariantDescriptor[] {
  return SLICER_VARIANTS.filter(v => v.slicerId === id);
}

export function slicerVariantById(variantId: string): SlicerVariantDescriptor | null {
  return SLICER_VARIANTS.find(v => v.variantId === variantId) ?? null;
}

/** The flavour used when only the family is known. */
export function defaultVariantFor(id: IntegrationSlicerId): SlicerVariantDescriptor | null {
  const vs = variantsForSlicer(id);
  return vs.find(v => v.isDefault) ?? vs[0] ?? null;
}

/** Display name of one install flavour; falls back to the family name. */
export function variantDisplayName(variantId: string, slicerId: IntegrationSlicerId): string {
  return slicerVariantById(variantId)?.displayName ?? slicerDisplayName(slicerId);
}

/**
 * Process image names to watch for one family, across every flavour.
 * Family-wide on purpose: flavours can share a binary (Bambu Studio and its
 * Beta do), so a preset write must be refused while any of them is open.
 */
export function familyProcessNames(id: IntegrationSlicerId): string[] {
  const out: string[] = [];
  for (const v of variantsForSlicer(id)) {
    for (const n of v.processNames) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Map the wizard's project slicer id onto integration slicer ids. */
export function integrationIdsForProjectSlicer(projectSlicer: string): IntegrationSlicerId[] {
  switch (projectSlicer) {
    case 'orca': return ['orca', 'snapmaker-orca', 'elegoo', 'flash-studio'];
    case 'bambu': return ['bambu'];
    default: return [];
  }
}

// --- version compatibility registry ----------------------------------------
//
// directInstallVerified may only be set to true after the manual test matrix
// (docs/SLICER_PROFILE_TEST_MATRIX.md) records a successful install +
// restart + slice test for that slicer/version/OS.

export const VERIFIED_VERSIONS: VerifiedSlicerVersion[] = [
  {
    slicerId: 'orca',
    versionRange: '2.4.',
    platforms: ['windows'],
    profileScanVerified: true,
    profileGenerationVerified: true,
    directInstallVerified: true,
    verificationDate: '2026-07-19',
    notes: ['Full manual E2E pass on Orca Slicer 2.4.2, Windows 11, in the real cloud-linked account dir (signed in to Orca Cloud): transactional install + verified backup, preset appears in the filament list (Elegoo OrangeStorm Giga 0.6 nozzle), model slices cleanly, backup restore returns the account directory byte-identical to baseline. Cloud caveat: the slicer may later sync/duplicate/re-id presets in an account dir — surfaced as a user warning, not a blocker.']
  },
  {
    slicerId: 'bambu',
    versionRange: '02.07.',
    platforms: ['windows'],
    profileScanVerified: true,
    profileGenerationVerified: true,
    directInstallVerified: true,
    verificationDate: '2026-07-19',
    notes: ['Full manual E2E pass on Bambu Studio 02.07.01.62, Windows 11, in the real cloud-linked account dir: transactional install + verified backup, preset appears under Custom presets with correct values (Type PCTG, flow 1.03), dual-nozzle array preserved (tool 0 patched, tool 1 untouched: temp ["213","260"]), model slices cleanly, backup restore returns the account directory byte-identical to baseline. Cloud caveat: the slicer may later sync/duplicate/re-id presets in an account dir — surfaced as a user warning, not a blocker.']
  },
  {
    slicerId: 'bambu',
    versionRange: '02.08.',
    platforms: ['windows'],
    profileScanVerified: true,
    profileGenerationVerified: false,
    directInstallVerified: false,
    verificationDate: '2026-08-01',
    notes: ['Directory layout, config schema, system/BBL library layout and user preset/.info schema verified by read-only inspection of a real Bambu Studio Beta 02.08.01.55 install on Windows 11 (data dir BambuStudioBeta, config BambuStudio.conf, BBL library 02.08.00.04). No preset has been generated or installed against this version, so direct install stays gated: scan, generate and export still work, automatic installation does not.']
  },
  {
    slicerId: 'snapmaker-orca',
    versionRange: '01.10.',
    platforms: ['windows'],
    profileScanVerified: true,
    profileGenerationVerified: true,
    directInstallVerified: true,
    verificationDate: '2026-07-19',
    notes: ['Full manual E2E pass on Snapmaker Orca 01.10.01.50, Windows 11 (multi-tool U1): transactional install + verified backup, preset appears and is selectable as tool 1\'s filament, on-disk values correct (temp 213 / flow 1.03 / PA 0.041), model slices cleanly on the U1, backup restore returns the directory byte-identical to baseline.']
  },
  {
    slicerId: 'elegoo',
    versionRange: '1.5.',
    platforms: ['windows'],
    profileScanVerified: true,
    profileGenerationVerified: true,
    directInstallVerified: true,
    verificationDate: '2026-07-19',
    notes: [
      'Full manual E2E pass on ElegooSlicer 1.5.2.2, Windows 11: transactional install + verified backup, preset appears in the filament list, all calibrated values load correctly (temp/flow/PA/MVS), model slices cleanly, backup restore returns the directory byte-identical to baseline.'
    ]
  },
  {
    slicerId: 'flash-studio',
    versionRange: '01.10.',
    platforms: ['windows'],
    profileScanVerified: true,
    profileGenerationVerified: true,
    directInstallVerified: true,
    verificationDate: '2026-07-19',
    notes: ['Full manual E2E pass on Flash Studio (Orca-Flashforge) 01.10.01.50, Windows 11: transactional install + verified backup, preset appears in the filament list with correct values (flow 1.03, PA 0.041 enabled), model slices cleanly, backup restore returns the directory byte-identical to baseline.']
  }
];

export function findVerifiedVersion(
  slicerId: IntegrationSlicerId,
  version: string | null,
  platform: Platform
): VerifiedSlicerVersion | null {
  if (!version) return null;
  for (const v of VERIFIED_VERSIONS) {
    if (v.slicerId === slicerId && v.platforms.includes(platform) && version.startsWith(v.versionRange)) {
      return v;
    }
  }
  return null;
}

/**
 * Compute honest capabilities for a detected installation. Anything not
 * verified for this slicer/version/platform stays false; export always works
 * because it never touches slicer data.
 */
export function capabilitiesFor(
  slicerId: IntegrationSlicerId,
  version: string | null,
  platform: Platform,
  isDesktop: boolean,
  allowUnverifiedOverride: boolean
): SlicerCapabilities {
  const verified = findVerifiedVersion(slicerId, version, platform);
  return {
    // Read-only scanning and pure data transforms are safe on any version;
    // only direct installation is gated by per-version verification.
    canScanProfiles: isDesktop,
    canParseProfiles: true,
    canGenerateProfiles: true,
    canExportProfiles: true,
    canInstallDirectly: isDesktop && (!!verified?.directInstallVerified || allowUnverifiedOverride),
    canVerifyInstallation: isDesktop,
    requiresRestart: true,
    requiresClosedProcess: true
  };
}
