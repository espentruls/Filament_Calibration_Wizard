// ---------------------------------------------------------------------------
// Automated Calibration Pipeline — Installed OrcaSlicer engine (Stage 5).
//
// Drives an OrcaSlicer install the user already has (auto-detected, or an
// executable they selected manually) strictly as an external process. Discovery
// and capability validation are delegated to the native side, which validates
// by *structure* (resources/calib + resources/profiles), never by trusting the
// executable's name, and records a tamper-evident manifest. Slicing runs through
// the safe native process runner; success is judged from the output artifact and
// the engine log, never stdout.
//
// Project assembly (resolvePrinterPreset / prepareProject) is Stage 6 — those
// methods reject clearly until then. Everything degrades to "not detected" in a
// browser/PWA build with no desktop bridge.
// ---------------------------------------------------------------------------

import type {
  AutomatedCalibrationSession,
  CalibrationStepDefinition,
  EngineDetectionResult,
  EngineValidationResult,
  PreparedCalibrationProject,
  PrinterSelection,
  ResolvedPrinterPreset,
  SliceOptions,
  SlicedCalibrationJob,
  SlicedJobInspection,
  SlicingEngine,
  SlicingEngineCapabilities
} from '../types';
import { emptyEngineCapabilities } from '../capabilities';
import { type EngineNativeBridge, nativeEngineBridge, type RawEngineDetection } from '../engineBridge';
import type { EngineStatus } from '../engineRegistry';
import { getAsset, resolveAsset } from '../assets';
import { inputFingerprintForStep } from '../workflow';
import { workspaceDirName } from '../projectPreparation';
import { mergeCalibrationIntoProjectConfig } from '../orcaProjectConfig';
import { mapPrinterToOrca, type OrcaMachineMapping } from '../printerMapping';
import { getPrinterSpec } from '../../data/printerDatabase';
import {
  baseName,
  inspectSlicedJob,
  notSlicedJob,
  resourcesRootFromExe,
  splitRawDetection
} from './engineSupport';

const ENGINE_ID = 'installed_orca' as const;

export class InstalledOrcaEngine implements SlicingEngine {
  readonly id = ENGINE_ID;
  readonly displayName = 'Installed OrcaSlicer';

  private readonly bridge: EngineNativeBridge;
  private lastRaw: RawEngineDetection | null = null;
  private lastVersion: string | null = null;

  constructor(bridge: EngineNativeBridge = nativeEngineBridge) {
    this.bridge = bridge;
  }

  get version(): string | undefined {
    return this.lastVersion ?? undefined;
  }

  /** Web-build fallback used whenever no desktop bridge is present. */
  private notDesktopRaw(): RawEngineDetection {
    return {
      engine_id: ENGINE_ID,
      detected: false,
      display_name: this.displayName,
      version: null,
      executable_path: null,
      source: 'none',
      checksum_sha256: null,
      capabilities: {
        slice: false,
        export_3mf: false,
        export_gcode: false,
        multi_plate: false,
        multi_extruder: false
      },
      valid: false,
      errors: ['Automated slicing requires the PerfectFit desktop app.'],
      warnings: [],
      notes: []
    };
  }

  private remember(raw: RawEngineDetection): RawEngineDetection {
    this.lastRaw = raw;
    this.lastVersion = raw.version;
    return raw;
  }

  /** Detect the engine, optionally from a user-selected executable path. */
  async detect(manualExePath?: string): Promise<EngineDetectionResult> {
    const raw = this.remember(
      this.bridge.isDesktop()
        ? await this.bridge.detectSlicingEngine(ENGINE_ID, manualExePath)
        : this.notDesktopRaw()
    );
    return splitRawDetection(raw).detection;
  }

  /** Re-validate a previously-detected engine from its persisted manifest. */
  async validate(): Promise<EngineValidationResult> {
    if (!this.bridge.isDesktop()) return splitRawDetection(this.notDesktopRaw()).validation;
    const raw = this.remember(await this.bridge.validateSlicingEngine(ENGINE_ID));
    return splitRawDetection(raw).validation;
  }

  async getCapabilities(): Promise<SlicingEngineCapabilities> {
    if (this.lastRaw?.valid) return splitRawDetection(this.lastRaw).capabilities;
    const raw = this.remember(
      this.bridge.isDesktop()
        ? await this.bridge.detectSlicingEngine(ENGINE_ID)
        : this.notDesktopRaw()
    );
    return raw.valid ? splitRawDetection(raw).capabilities : emptyEngineCapabilities();
  }

  /** Combined status for the engine-status diagnostics view (one native call). */
  async status(): Promise<EngineStatus> {
    const raw = this.remember(
      this.bridge.isDesktop()
        ? await this.bridge.detectSlicingEngine(ENGINE_ID)
        : this.notDesktopRaw()
    );
    const { detection, validation, capabilities } = splitRawDetection(raw);
    return {
      engineId: ENGINE_ID,
      displayName: detection.displayName,
      detected: detection.detected,
      valid: validation.valid,
      version: detection.version,
      source: detection.source,
      executablePath: detection.executablePath,
      capabilities: validation.valid ? capabilities : emptyEngineCapabilities(),
      errors: validation.errors,
      warnings: validation.warnings,
      notes: detection.notes
    };
  }

  // --- Stage 6 territory (project assembly) ---------------------------------

  /**
   * Resolve a printer/process/filament selection given as exact Orca preset
   * names — walks the vendor `inherits` chains natively into a flat
   * project_settings.config. This is the resolver core; mapping a PerfectFit
   * printer-DB selection to these names (`resolvePrinterPreset`) is the
   * remaining piece.
   */
  async resolvePresetByNames(names: {
    vendor: string;
    machine: string;
    process: string;
    filament: string;
  }): Promise<ResolvedPrinterPreset> {
    if (!this.bridge.isDesktop()) {
      throw new Error('NOT_DESKTOP: preset resolution requires the desktop app.');
    }
    const raw = await this.bridge.resolvePresetByNames({ engineId: ENGINE_ID, ...names });
    return {
      settings: JSON.parse(raw.settings_json) as Record<string, unknown>,
      printerModel: raw.printer_model,
      printerSettingsId: raw.printer_settings_id,
      source: 'vendor_profile',
      warnings: raw.warnings
    };
  }

  /**
   * Map a PerfectFit `PrinterSelection` to the installed Orca machine +
   * process. Filament is intentionally not included — Orca machine leaves carry
   * no default filament, and the material is a separate calibration choice — so
   * the full config comes from `resolveForPrinter(selection, filamentName)`.
   * Throws `PRINTER_NOT_IN_ORCA` when the printer/nozzle isn't installed.
   */
  async mapSelection(selection: PrinterSelection): Promise<OrcaMachineMapping> {
    if (!this.bridge.isDesktop()) {
      throw new Error('NOT_DESKTOP: printer mapping requires the desktop app.');
    }
    const spec = getPrinterSpec(selection.printerProfileId);
    if (!spec) {
      throw new Error(`PRINTER_NOT_FOUND: no printer-DB entry for '${selection.printerProfileId}'.`);
    }
    const machines = await this.bridge.listInstalledMachines(ENGINE_ID);
    const mapping = mapPrinterToOrca(spec.model, selection.nozzleDiameterMm, machines);
    if (!mapping) {
      throw new Error(
        `PRINTER_NOT_IN_ORCA: no installed OrcaSlicer machine preset for "${spec.model}" at ${selection.nozzleDiameterMm}mm nozzle.`
      );
    }
    return mapping;
  }

  /**
   * Resolve a complete printer+process+filament config for a PerfectFit printer
   * selection plus a chosen filament preset name — the full end-to-end path.
   */
  async resolveForPrinter(
    selection: PrinterSelection,
    filamentPresetName: string
  ): Promise<ResolvedPrinterPreset> {
    const mapping = await this.mapSelection(selection);
    return this.resolvePresetByNames({
      vendor: mapping.vendor,
      machine: mapping.machineName,
      process: mapping.process,
      filament: filamentPresetName
    });
  }

  /**
   * `SlicingEngine` contract entry. A complete Orca config also needs a base
   * filament preset (the material being calibrated), which a `PrinterSelection`
   * does not carry — so this maps the printer and then directs the caller to
   * `resolveForPrinter` with a filament. The printer mapping itself is done.
   */
  async resolvePrinterPreset(selection: PrinterSelection): Promise<ResolvedPrinterPreset> {
    const mapping = await this.mapSelection(selection);
    throw new Error(
      `FILAMENT_SELECTION_REQUIRED: mapped to Orca machine "${mapping.machineName}" + process "${mapping.process}"; ` +
        'call resolveForPrinter(selection, filamentPresetName) with the material being calibrated.'
    );
  }

  /**
   * Assemble a complete, sliceable Orca project 3mf for one step: take the
   * calibration template shipped in the user's Orca install, merge the session's
   * calibrated filament values into its `project_settings.config`, and stage it
   * in the job workspace. Narrow support in this increment — only steps whose
   * asset is already a complete project (`project-template`, e.g. the pressure
   * advance pattern). Bare-model steps (temperature/flow towers) need parameterized
   * project generation and are the next increment. Arbitrary-printer preset
   * resolution is `resolvePrinterPreset` (also next); this carries the template's
   * own printer plus the calibrated filament values.
   */
  async prepareProject(
    session: AutomatedCalibrationSession,
    step: CalibrationStepDefinition
  ): Promise<PreparedCalibrationProject> {
    if (!this.bridge.isDesktop()) {
      throw new Error('NOT_DESKTOP: project assembly requires the desktop app.');
    }
    const exe = this.lastRaw?.executable_path ?? (await this.ensureDetected());
    if (!exe) throw new Error('ENGINE_NOT_DETECTED: detect the engine before preparing a project.');

    const asset = getAsset(step.id);
    if (!asset || asset.assetType !== 'project-template') {
      throw new Error(
        `UNSUPPORTED_ASSET: '${step.id}' needs parameterized project generation, not yet available.`
      );
    }
    const resolved = resolveAsset(step.id, { slicerResourceRoot: resourcesRootFromExe(exe) });
    if (!resolved.available || !resolved.location) {
      throw new Error(`ASSET_UNAVAILABLE: ${resolved.remedy ?? step.id}`);
    }

    const fingerprint = inputFingerprintForStep(session.workingProfile, step.id);
    const jobId = workspaceDirName(session.id, step.id, fingerprint);
    const templateConfig = await this.bridge.readProjectConfig(resolved.location);
    const merged = mergeCalibrationIntoProjectConfig(templateConfig, session);
    const assembled = await this.bridge.assembleCalibrationProject({
      engineId: ENGINE_ID,
      sessionId: session.id,
      jobId,
      templatePath: resolved.location,
      mergedConfigJson: merged.text,
      outputFileName: 'project.3mf'
    });

    return {
      id: jobId,
      projectId: session.id,
      stepId: step.id,
      workspaceDir: assembled.workspace_dir,
      projectFilePath: assembled.project_path,
      // The job manifest is written alongside in a later staging step; report
      // its intended location so the workspace layout is discoverable.
      manifestPath: `${assembled.workspace_dir}/job-manifest.json`,
      sliced: false,
      createdAt: new Date().toISOString()
    };
  }

  /** Ensure detection has run at least once, returning the executable path. */
  private async ensureDetected(): Promise<string | null> {
    if (!this.lastRaw) await this.detect();
    return this.lastRaw?.executable_path ?? null;
  }

  /** Slice a staged project via the native runner. The prepared project's
   *  identifiers map onto the managed job layout: the project id is the session
   *  id, the prepared-project id is the job id, and the assembled 3mf's file
   *  name is passed through. Never accepts a raw executable path — the runner
   *  launches only the manifest-vetted engine binary. */
  async slice(
    project: PreparedCalibrationProject,
    options: SliceOptions
  ): Promise<SlicedCalibrationJob> {
    if (!this.bridge.isDesktop() || !project.projectFilePath) {
      return notSlicedJob(project.id, project.stepId, ENGINE_ID, this.lastVersion);
    }
    const raw = await this.bridge.runCalibrationSlice({
      engineId: ENGINE_ID,
      sessionId: project.projectId,
      jobId: project.id,
      projectFileName: baseName(project.projectFilePath),
      timeoutMs: options.timeoutMs,
      cancellationToken: options.cancellationToken
    });
    return {
      preparedProjectId: project.id,
      stepId: project.stepId,
      outputGcodePath: raw.gcode_path,
      outputArtifactPaths: raw.artifact_paths,
      engineId: ENGINE_ID,
      engineVersion: this.lastVersion,
      exitCode: raw.exit_code,
      durationMs: raw.duration_ms,
      logPath: raw.log_dir,
      sliced: raw.succeeded,
      succeeded: raw.succeeded
    };
  }

  async inspectOutput(job: SlicedCalibrationJob): Promise<SlicedJobInspection> {
    return inspectSlicedJob(job);
  }
}
