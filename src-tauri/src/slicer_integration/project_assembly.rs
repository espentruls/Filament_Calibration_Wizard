//! Assemble a complete Orca project 3mf for automated slicing (Stage 6).
//!
//! A 3mf is a zip. A shipped calibration project (e.g. Orca's own
//! `resources/calib/.../pa_pattern.3mf`) is already complete and sliceable — it
//! embeds the model, any per-layer custom g-code, and a flat
//! `Metadata/project_settings.config`. To carry the session's calibrated values
//! into it, PerfectFit replaces ONLY that one config entry (produced and merged
//! on the TS side) and copies every other entry byte-for-byte, then writes the
//! result into the job workspace. Nothing else in the project is touched, and
//! the source template (under the user's own Orca install) is only ever read.

use super::{engine, security};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// The single project-config entry PerfectFit replaces.
const PROJECT_CONFIG_ENTRY: &str = "Metadata/project_settings.config";

fn validate_3mf(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("No template path given".into());
    }
    if !trimmed.to_ascii_lowercase().ends_with(".3mf") {
        return Err("Template must be a .3mf".into());
    }
    let p = Path::new(trimmed);
    if !p.is_file() {
        return Err(format!("Template not found: {}", p.display()));
    }
    std::fs::canonicalize(p).map_err(|e| format!("Cannot resolve template {}: {e}", p.display()))
}

/// Read the `project_settings.config` text out of a project 3mf so the TS side
/// can merge the session's calibrated values into it. Read-only.
#[tauri::command]
pub fn read_project_config(template_path: String) -> Result<String, String> {
    let path = validate_3mf(&template_path)?;
    let file = std::fs::File::open(&path).map_err(|e| format!("Cannot open template: {e}"))?;
    let mut zip = ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("Template is not a valid 3mf/zip: {e}"))?;
    let mut entry = zip
        .by_name(PROJECT_CONFIG_ENTRY)
        .map_err(|_| format!("Template has no {PROJECT_CONFIG_ENTRY}"))?;
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|e| format!("Cannot read project config: {e}"))?;
    Ok(text)
}

/// Copy `template` into `out`, replacing the project-config entry with
/// `merged_config`. Every other entry is preserved verbatim. Returns whether the
/// config entry was found+replaced (vs. added) and the total entry count.
fn repackage_with_config(template: &Path, merged_config: &str, out: &Path) -> Result<(bool, usize), String> {
    let src = std::fs::File::open(template).map_err(|e| format!("Cannot open template: {e}"))?;
    let mut zip = ZipArchive::new(std::io::BufReader::new(src))
        .map_err(|e| format!("Template is not a valid 3mf/zip: {e}"))?;
    let out_file = std::fs::File::create(out).map_err(|e| format!("Cannot create project file: {e}"))?;
    let mut writer = ZipWriter::new(std::io::BufWriter::new(out_file));
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let mut replaced = false;
    let mut count = 0usize;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("Corrupt zip entry {i}: {e}"))?;
        let name = entry.name().to_string();
        count += 1;
        if entry.is_dir() {
            writer
                .add_directory(name, opts)
                .map_err(|e| format!("Zip write failed: {e}"))?;
            continue;
        }
        writer
            .start_file(&name, opts)
            .map_err(|e| format!("Zip write failed: {e}"))?;
        if name == PROJECT_CONFIG_ENTRY {
            writer
                .write_all(merged_config.as_bytes())
                .map_err(|e| format!("Zip write failed: {e}"))?;
            replaced = true;
        } else {
            std::io::copy(&mut entry, &mut writer).map_err(|e| format!("Zip copy failed: {e}"))?;
        }
    }
    if !replaced {
        writer
            .start_file(PROJECT_CONFIG_ENTRY, opts)
            .map_err(|e| format!("Zip write failed: {e}"))?;
        writer
            .write_all(merged_config.as_bytes())
            .map_err(|e| format!("Zip write failed: {e}"))?;
        count += 1;
    }
    writer.finish().map_err(|e| format!("Zip finalize failed: {e}"))?;
    Ok((replaced, count))
}

#[derive(Serialize, Clone)]
pub struct RawAssembledProject {
    pub project_file_name: String,
    pub project_path: String,
    pub workspace_dir: String,
    /// True when the template already had a project config (replaced), false
    /// when PerfectFit had to add one.
    pub config_replaced: bool,
    pub entry_count: usize,
    pub warnings: Vec<String>,
}

/// Stage a complete calibration project into the job workspace: copy the
/// template 3mf and swap in the merged `project_settings.config`. The output
/// lands at `sessions/<session>/jobs/<job>/workspace/<output_file_name>`, ready
/// for `run_calibration_slice`.
#[tauri::command]
pub fn assemble_calibration_project(
    engine_id: String,
    session_id: String,
    job_id: String,
    template_path: String,
    merged_config_json: String,
    output_file_name: String,
) -> Result<RawAssembledProject, String> {
    security::validate_component(&output_file_name)?;
    if !output_file_name.to_ascii_lowercase().ends_with(".3mf") {
        return Err("Output file must be a .3mf".into());
    }
    let template = validate_3mf(&template_path)?;

    // Confine the template to the vetted engine's own resources when we can
    // resolve them — a calibration model must come from the user's own install,
    // never an arbitrary path handed in by the frontend.
    let mut warnings = Vec::new();
    if engine_id == "installed_orca" {
        match engine::engine_resources_root(&engine_id) {
            Some(root) => security::ensure_under(&root, &template)?,
            None => warnings
                .push("Engine resources root unknown; template not confined to the install.".into()),
        }
    }

    let workspace = security::job_root(&session_id, &job_id)?.join("workspace");
    std::fs::create_dir_all(&workspace).map_err(|e| format!("Cannot create workspace: {e}"))?;
    let out_path = workspace.join(&output_file_name);

    let (config_replaced, entry_count) = repackage_with_config(&template, &merged_config_json, &out_path)?;
    if !config_replaced {
        warnings.push(format!("Template lacked {PROJECT_CONFIG_ENTRY}; added it."));
    }

    Ok(RawAssembledProject {
        project_file_name: output_file_name,
        project_path: out_path.display().to_string(),
        workspace_dir: workspace.display().to_string(),
        config_replaced,
        entry_count,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pf_assembly_{tag}_{n}_{}", super::super::now_unix()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Write a tiny project-3mf-shaped zip: a couple of preserved entries plus a
    /// project config to be replaced.
    fn make_template(path: &Path, config: &str) {
        let f = std::fs::File::create(path).unwrap();
        let mut w = ZipWriter::new(f);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        w.start_file("[Content_Types].xml", opts).unwrap();
        w.write_all(b"<Types/>").unwrap();
        w.start_file("3D/3dmodel.model", opts).unwrap();
        w.write_all(b"<model/>").unwrap();
        w.start_file(PROJECT_CONFIG_ENTRY, opts).unwrap();
        w.write_all(config.as_bytes()).unwrap();
        w.finish().unwrap();
    }

    fn read_entry(path: &Path, name: &str) -> Option<String> {
        let f = std::fs::File::open(path).ok()?;
        let mut z = ZipArchive::new(f).ok()?;
        let mut e = z.by_name(name).ok()?;
        let mut s = String::new();
        e.read_to_string(&mut s).ok()?;
        Some(s)
    }

    #[test]
    fn repackage_replaces_only_the_config() {
        let d = temp_dir("repack");
        let tmpl = d.join("template.3mf");
        make_template(&tmpl, "{\"old\":1}");
        let out = d.join("project.3mf");
        let (replaced, count) = repackage_with_config(&tmpl, "{\"new\":2}", &out).unwrap();
        assert!(replaced);
        assert_eq!(count, 3);
        assert_eq!(read_entry(&out, PROJECT_CONFIG_ENTRY).as_deref(), Some("{\"new\":2}"));
        // other entries preserved verbatim
        assert_eq!(read_entry(&out, "[Content_Types].xml").as_deref(), Some("<Types/>"));
        assert_eq!(read_entry(&out, "3D/3dmodel.model").as_deref(), Some("<model/>"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn read_project_config_extracts_the_entry() {
        let d = temp_dir("readcfg");
        let tmpl = d.join("t.3mf");
        make_template(&tmpl, "{\"printer_settings_id\":\"X\"}");
        let text = read_project_config(tmpl.display().to_string()).unwrap();
        assert!(text.contains("printer_settings_id"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn repackage_adds_config_when_template_lacks_one() {
        let d = temp_dir("addcfg");
        let tmpl = d.join("t.3mf");
        // template with no project config entry
        let f = std::fs::File::create(&tmpl).unwrap();
        let mut w = ZipWriter::new(f);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        w.start_file("3D/3dmodel.model", opts).unwrap();
        w.write_all(b"<model/>").unwrap();
        w.finish().unwrap();

        let out = d.join("project.3mf");
        let (replaced, _count) = repackage_with_config(&tmpl, "{\"added\":true}", &out).unwrap();
        assert!(!replaced);
        assert_eq!(read_entry(&out, PROJECT_CONFIG_ENTRY).as_deref(), Some("{\"added\":true}"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn validate_3mf_rejects_bad_inputs() {
        assert!(validate_3mf("").is_err());
        assert!(validate_3mf("C:/nope/x.txt").is_err());
        assert!(validate_3mf("C:/nope/missing.3mf").is_err());
    }

    /// End-to-end pipeline proof on the real installed Orca (supervised):
    /// read a shipped calib project's config, change a filament value, repackage
    /// it with our assembler, and headless-slice the result into an isolated temp
    /// datadir. Asserts a genuine g-code artifact comes out. Run with
    /// `cargo test -- --ignored probe_real_orca_slice`.
    #[test]
    #[ignore]
    fn probe_real_orca_slice_of_assembled_project() {
        use std::process::{Command, Stdio};
        let orca = Path::new("C:/Program Files/OrcaSlicer/orca-slicer.exe");
        let template =
            Path::new("C:/Program Files/OrcaSlicer/resources/calib/pressure_advance/pa_pattern.3mf");
        if !orca.is_file() || !template.is_file() {
            eprintln!("SKIP: OrcaSlicer or pa_pattern.3mf not present");
            return;
        }
        let d = temp_dir("probe");

        // Read + modify the real project config (change pressure_advance).
        let cfg_text = read_project_config(template.display().to_string()).unwrap();
        let mut cfg: serde_json::Value = serde_json::from_str(&cfg_text).unwrap();
        cfg["pressure_advance"] = serde_json::json!(["0.0425"]);
        cfg["enable_pressure_advance"] = serde_json::json!(["1"]);
        let merged = serde_json::to_string_pretty(&cfg).unwrap();

        let project = d.join("project.3mf");
        let (replaced, count) = repackage_with_config(template, &merged, &project).unwrap();
        assert!(replaced, "template should have had a project config");
        assert!(count > 3, "expected the full project's entries");

        // Slice headless into an isolated datadir (never the user's real one).
        let datadir = d.join("datadir");
        let outdir = d.join("out");
        std::fs::create_dir_all(&datadir).unwrap();
        std::fs::create_dir_all(&outdir).unwrap();
        let status = Command::new(orca)
            .arg("--datadir")
            .arg(&datadir)
            .arg("--outputdir")
            .arg(&outdir)
            .arg("--slice")
            .arg("0")
            .arg(&project)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("failed to launch orca");

        let gcode = outdir.join("plate_1.gcode");
        let meta = std::fs::metadata(&gcode);
        println!(
            "orca exit={:?} gcode_exists={} size={:?}",
            status.code(),
            gcode.is_file(),
            meta.as_ref().map(|m| m.len()).ok()
        );
        assert!(gcode.is_file(), "expected {}", gcode.display());
        assert!(meta.unwrap().len() > 1000, "g-code implausibly small");
        // Keep artifacts for inspection on success? Clean up — temp only.
        std::fs::remove_dir_all(&d).ok();
    }
}
