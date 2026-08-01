// ---------------------------------------------------------------------------
// Desktop bridge: the single boundary between web-safe code and native Tauri
// commands. Everything else in slicerIntegration/ must go through this module
// so the browser/PWA build degrades cleanly to export-only behavior.
//
// The Tauri API is reached through window.__TAURI__ (withGlobalTauri) to keep
// the frontend dependency-free. Command names and payload shapes mirror
// src-tauri/src/slicer_integration/.
// ---------------------------------------------------------------------------

import type { IntegrationSlicerId, ProfileBackupManifest } from './types';

interface TauriGlobal {
  core: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
}

function tauri(): TauriGlobal | null {
  const w = window as unknown as { __TAURI__?: TauriGlobal };
  return w.__TAURI__ ?? null;
}

/** True when running inside the Tauri desktop shell. */
export function isDesktop(): boolean {
  return tauri() !== null;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = tauri();
  if (!t) throw new Error('NOT_DESKTOP: native commands are only available in the desktop app');
  return t.core.invoke<T>(cmd, args);
}

// --- payload shapes shared with Rust (serde snake_case) ---------------------

export interface RawUserDataLocation {
  account_id: string;
  path: string;
  active: boolean;
  filament_profile_count: number;
}

export interface RawDetectedSlicer {
  /** Family key — 'bambu' for both the release and the Beta. */
  slicer_id: string;
  /** Install flavour key, e.g. 'bambu-beta'. */
  variant_id: string;
  variant_label: string;
  is_default_variant: boolean;
  data_dir: string | null;
  conf_version: string | null;
  conf_modified_at: number | null;
  preset_folder: string | null;
  sync_user_preset: boolean | null;
  superseded_by: string | null;
  executable_path: string | null;
  user_locations: RawUserDataLocation[];
  notes: string[];
}

export interface RawProfileFile {
  file_name: string;
  path: string;
  dir_kind: 'user' | 'user_base' | 'system';
  account_id: string | null;
  vendor: string | null;
  json: string;
  info: string | null;
  writable: boolean;
}

export interface RawInstallOutcome {
  success: boolean;
  installed_files: string[];
  changed_files: string[];
  backup_id: string | null;
  verification_passed: boolean;
  rolled_back: boolean;
  error_code: string | null;
  error_detail: string | null;
}

export interface RawBackupSummary {
  backup_id: string;
  slicer_id: string;
  created_at: string;
  installed_profile_name: string;
  perfectfit_project_id: string;
  file_count: number;
  backup_root: string;
}

// --- commands ---------------------------------------------------------------

export function detectSupportedSlicers(): Promise<RawDetectedSlicer[]> {
  return invoke('detect_supported_slicers');
}

// `variantId` names ONE install flavour ('bambu' vs 'bambu-beta'). Omitting it
// makes the native side resolve the account folder across every flavour of the
// family and refuse when more than one has it, rather than guess — but pass it
// whenever it is known, which is any time the location came from detection.

export function scanSlicerProfiles(
  slicerId: IntegrationSlicerId, accountId: string, variantId?: string
): Promise<RawProfileFile[]> {
  return invoke('scan_slicer_profiles', { slicerId, accountId, variantId: variantId ?? null });
}

export function detectRunningSlicerProcess(slicerId: IntegrationSlicerId): Promise<boolean> {
  return invoke('detect_running_slicer_process', { slicerId });
}

export function openSlicer(slicerId: IntegrationSlicerId): Promise<void> {
  return invoke('open_slicer', { slicerId });
}

export function openProfileDirectory(path: string): Promise<void> {
  return invoke('open_profile_directory', { path });
}

/** Open an http(s) URL in the OS default browser (desktop only). */
export function openExternalUrl(url: string): Promise<void> {
  return invoke('open_external_url', { url });
}

export function installGeneratedProfile(args: {
  slicerId: IntegrationSlicerId;
  accountId: string;
  profileName: string;
  presetJson: string;
  infoText: string;
  projectId: string;
  allowReplace: boolean;
  skipProcessCheck: boolean;
  variantId?: string;
}): Promise<RawInstallOutcome> {
  return invoke('install_generated_profile', {
    slicerId: args.slicerId,
    accountId: args.accountId,
    profileName: args.profileName,
    presetJson: args.presetJson,
    infoText: args.infoText,
    projectId: args.projectId,
    allowReplace: args.allowReplace,
    skipProcessCheck: args.skipProcessCheck,
    variantId: args.variantId ?? null
  });
}

export function verifyGeneratedProfile(path: string, expectedJson: string): Promise<{ verified: boolean; detail: string }> {
  return invoke('verify_generated_profile', { path, expectedJson });
}

export function backupSlicerUserPresets(
  slicerId: IntegrationSlicerId, accountId: string, projectId: string, variantId?: string
): Promise<RawBackupSummary> {
  return invoke('backup_slicer_user_presets', {
    slicerId, accountId, projectId, variantId: variantId ?? null
  });
}

export function listProfileBackups(): Promise<RawBackupSummary[]> {
  return invoke('list_profile_backups');
}

// A backup id is unique only inside one slicer's folder — backing up several
// slicers in one pass mints the same id for each — so every one of these
// addresses a backup by the (slicerId, backupId) PAIR. Both halves are already
// in every RawBackupSummary the caller is holding.

export function getBackupManifest(slicerId: string, backupId: string): Promise<ProfileBackupManifest> {
  return invoke('get_profile_backup_manifest', { slicerId, backupId });
}

export function restoreProfileBackup(
  slicerId: string, backupId: string
): Promise<{ restored_files: string[]; deleted_files: string[] }> {
  return invoke('restore_profile_backup', { slicerId, backupId });
}

export function deleteProfileBackup(slicerId: string, backupId: string): Promise<void> {
  return invoke('delete_profile_backup', { slicerId, backupId });
}

export function openBackupDirectory(slicerId: string, backupId: string): Promise<void> {
  return invoke('open_backup_directory', { slicerId, backupId });
}

export function saveExportedProfile(defaultFileName: string, presetJson: string): Promise<string | null> {
  return invoke('save_exported_profile', { defaultFileName, presetJson });
}

export function getPlatformInfo(): Promise<{ platform: string; os_version: string }> {
  return invoke('get_platform_info');
}
