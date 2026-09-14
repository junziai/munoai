//! AMT 结果工作台导出命令（融合规划 P0-A / P0-C）。
//!
//! 对齐 music-to-midi 参考项目的下载菜单五件套：
//!   1. MIDI 导出            → 复用 amt.rs 的 export_midi_tracks_to_folder（每乐器一个 .mid）
//!   2. 乐谱导出             → MuseScore 4 刻写 MusicXML + 全谱 PDF，打 zip（本模块）
//!   3. 转录音频导出          → FluidSynth 渲染当前 MIDI：HQ=24bit/48kHz / 兼容=16bit/44.1kHz
//!   4. 分轨音频导出          → 每乐器单独渲染对齐时长，打 zip（本模块）
//!   5. 立体声 A/B 导出       → 左声道=原声、右声道=MIDI 合成（参考 _write_official_stereo_mix）
//!
//! P0-C 多音源挂载：SoundFont（SF2/SF3）发现 / 选择 / 持久化；所有渲染走「当前音源」，
//! 未选择时回退内置 MuseScore_General.sf2 —— 与 amt.rs 的播放链路一致。
//!
//! FluidSynth 命令行与参考实现逐字对齐（src/core/muscriptor_result_assets.py::_synthesize）：
//!   fluidsynth -ni -o audio.file.format={s24|s16} -F out.wav -r {rate} soundfont mid
//! 且复刻其 PATH 注入（bin + lib 目录前置），保证 exe 同目录 DLL 可见。
//!
//! 错误约定（i18n 铁律）：用户可见错误一律稳定 CODE ——
//!   EXPORT_FLUIDSYNTH_NOT_FOUND / EXPORT_MUSESCORE_NOT_FOUND / EXPORT_SOUNDFONT_NOT_FOUND /
//!   EXPORT_SRC_NOT_FOUND: {detail} / EXPORT_RENDER_FAILED: {detail} / EXPORT_SHEET_FAILED: {detail} /
//!   EXPORT_WRITE_FAILED: {detail}

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::AppState;

// ─────────────────────────────────────────────────────────────────────────────
// 工具与音源解析（统一以 models_dir 为根，spawn_blocking 内无需 AppState）
// ─────────────────────────────────────────────────────────────────────────────

const FLUIDSYNTH_REL: [&str; 4] = ["fluidsynth", "2.5.6", "bin", "fluidsynth.exe"];
const MUSESCORE_REL: [&str; 4] = ["musescore", "4.7.4", "bin", "MuseScore4.exe"];
const LEGACY_SOUNDFONT: &str = "MuseScore_General.sf2";

fn fluidsynth_exe(models_dir: &Path) -> Option<PathBuf> {
    let exe: PathBuf = FLUIDSYNTH_REL.iter().fold(models_dir.to_path_buf(), |acc, p| acc.join(p));
    if exe.is_file() { Some(exe) } else { None }
}

fn musescore_exe(models_dir: &Path) -> Option<PathBuf> {
    let exe: PathBuf = MUSESCORE_REL.iter().fold(models_dir.to_path_buf(), |acc, p| acc.join(p));
    if exe.is_file() { Some(exe) } else { None }
}

fn soundfonts_dir(models_dir: &Path) -> PathBuf {
    models_dir.join("soundfonts")
}

fn active_soundfont_marker(models_dir: &Path) -> PathBuf {
    models_dir.join("active_soundfont.txt")
}

/// 解析「当前音源」：用户选择（soundfonts/ 下的文件或内置 MuseScore_General.sf2）
/// 存在且有效则用之；否则回退内置默认。这是全部渲染路径的唯一音源入口。
pub fn resolve_active_soundfont(models_dir: &Path) -> PathBuf {
    if let Ok(sel) = std::fs::read_to_string(active_soundfont_marker(models_dir)) {
        let sel = sel.trim();
        if !sel.is_empty() {
            let candidate = soundfonts_dir(models_dir).join(sel);
            if candidate.is_file() {
                return candidate;
            }
            let legacy = models_dir.join(sel);
            if legacy.is_file() {
                return legacy;
            }
        }
    }
    models_dir.join(LEGACY_SOUNDFONT)
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-C：音源管理命令
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmtSoundfontInfo {
    pub name: String,
    pub filename: String,
    pub path: String,
    pub size_bytes: u64,
    pub is_builtin: bool,
    pub active: bool,
}

fn soundfont_files_in(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase())
                .unwrap_or_default();
            if ext == "sf2" || ext == "sf3" {
                out.push(path);
            }
        }
    }
    out.sort_by_key(|p| p.file_name().unwrap_or_default().to_os_string());
    out
}

fn soundfont_info(path: &Path, models_dir: &Path, is_builtin: bool) -> AmtSoundfontInfo {
    let filename = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    AmtSoundfontInfo {
        name: Path::new(&filename)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or(filename.clone()),
        filename,
        path: path.to_string_lossy().into_owned(),
        size_bytes: size,
        is_builtin,
        active: &resolve_active_soundfont(models_dir) == path,
    }
}

/// 列出全部可用音源：soundfonts/ 目录下全部 SF2/SF3 + 内置 MuseScore_General.sf2。
#[tauri::command]
pub fn amt_list_soundfonts(state: State<'_, AppState>) -> Vec<AmtSoundfontInfo> {
    let models_dir = state.amt_models_dir.clone();
    let mut list: Vec<AmtSoundfontInfo> = soundfont_files_in(&soundfonts_dir(&models_dir))
        .iter()
        .map(|p| soundfont_info(p, &models_dir, false))
        .collect();

    // 内置默认音源（模型目录顶层，始终列出、不可删除）。
    let builtin = models_dir.join(LEGACY_SOUNDFONT);
    if builtin.is_file() {
        list.push(soundfont_info(&builtin, &models_dir, true));
    }
    list
}

/// 切换当前音源（按文件名）。选择持久化在 active_soundfont.txt，播放/导出共用。
#[tauri::command]
pub fn amt_set_active_soundfont(state: State<'_, AppState>, filename: String) -> Result<(), String> {
    let models_dir = state.amt_models_dir.clone();
    let candidate = soundfonts_dir(&models_dir).join(&filename);
    let legacy = models_dir.join(&filename);
    if candidate.is_file() || (filename == LEGACY_SOUNDFONT && legacy.is_file()) {
        std::fs::write(active_soundfont_marker(&models_dir), &filename)
            .map_err(|e| format!("EXPORT_SOUNDFONT_WRITE_FAILED: {e}"))?;
        Ok(())
    } else {
        Err("EXPORT_SOUNDFONT_NOT_FOUND".to_string())
    }
}

/// 导入一个 SoundFont（SF2/SF3）到 soundfonts/ 目录（P0-C 多音源挂载）。
/// 前端用文件对话框选源文件；这里复制进模型目录并返回其信息。
#[tauri::command]
pub async fn amt_import_soundfont(
    state: State<'_, AppState>,
    source_path: String,
) -> Result<AmtSoundfontInfo, String> {
    let models_dir = state.amt_models_dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<AmtSoundfontInfo, String> {
        let src = absolutize(&source_path);
        if !src.is_file() {
            return Err(format!("EXPORT_SRC_NOT_FOUND: {}", src.display()));
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        if ext != "sf2" && ext != "sf3" {
            return Err("EXPORT_SOUNDFONT_BAD_TYPE".to_string());
        }
        let dir = soundfonts_dir(&models_dir);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("EXPORT_WRITE_FAILED: mkdir: {e}"))?;
        let filename = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if filename.is_empty() || filename == LEGACY_SOUNDFONT {
            return Err("EXPORT_SOUNDFONT_BAD_NAME".to_string());
        }
        let dest = dir.join(&filename);
        std::fs::copy(&src, &dest)
            .map_err(|e| format!("EXPORT_WRITE_FAILED: copy: {e}"))?;
        Ok(soundfont_info(&dest, &models_dir, false))
    })
    .await
    .map_err(|e| format!("EXPORT_WRITE_FAILED: join: {e}"))?
}

/// 删除一个已导入的音源（内置默认不可删）。若删除的是当前音源，回退内置默认。
#[tauri::command]
pub async fn amt_delete_soundfont(
    state: State<'_, AppState>,
    filename: String,
) -> Result<(), String> {
    let models_dir = state.amt_models_dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if filename == LEGACY_SOUNDFONT {
            return Err("EXPORT_SOUNDFONT_BUILTIN".to_string());
        }
        let target = soundfonts_dir(&models_dir).join(&filename);
        if !target.is_file() {
            return Err("EXPORT_SOUNDFONT_NOT_FOUND".to_string());
        }
        std::fs::remove_file(&target)
            .map_err(|e| format!("EXPORT_WRITE_FAILED: delete: {e}"))?;
        // Was the deleted one active? Reset to the built-in default.
        let active = active_soundfont_marker(&models_dir);
        if let Ok(sel) = std::fs::read_to_string(&active) {
            if sel.trim() == filename {
                let _ = std::fs::write(&active, LEGACY_SOUNDFONT);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("EXPORT_WRITE_FAILED: join: {e}"))?
}

/// 导出工具可用性（前端按钮置灰判定）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmtExportToolsStatus {
    pub fluidsynth_available: bool,
    pub musescore_available: bool,
    pub soundfont_available: bool,
    pub soundfont_name: String,
}

#[tauri::command]
pub fn amt_export_tools_status(state: State<'_, AppState>) -> AmtExportToolsStatus {
    let models_dir = state.amt_models_dir.clone();
    let sf = resolve_active_soundfont(&models_dir);
    AmtExportToolsStatus {
        fluidsynth_available: fluidsynth_exe(&models_dir).is_some(),
        musescore_available: musescore_exe(&models_dir).is_some(),
        soundfont_available: sf.is_file(),
        soundfont_name: sf
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FluidSynth 渲染核心
// ─────────────────────────────────────────────────────────────────────────────

struct AudioPreset {
    sample_rate: u32,
    format: &'static str,
    suffix: &'static str,
}

fn audio_preset(preset: &str) -> AudioPreset {
    match preset {
        "compat" => AudioPreset { sample_rate: 44_100, format: "s16", suffix: "16bit-44.1kHz" },
        _ => AudioPreset { sample_rate: 48_000, format: "s24", suffix: "24bit-48kHz" },
    }
}

/// 参考 get_fluidsynth_subprocess_env：bin + lib 目录前置进 PATH，保证同目录 DLL 可见。
fn fluidsynth_env(exe: &Path) -> std::collections::HashMap<String, String> {
    let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
    let bin_dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let lib_dir = bin_dir.parent().map(|p| p.join("lib")).unwrap_or_default();
    let mut entries: Vec<String> = Vec::new();
    if !bin_dir.as_os_str().is_empty() {
        entries.push(bin_dir.to_string_lossy().into_owned());
    }
    if lib_dir.is_dir() {
        entries.push(lib_dir.to_string_lossy().into_owned());
    }
    if let Some(current) = env.get("PATH") {
        entries.push(current.clone());
    }
    env.insert("PATH".to_string(), entries.join(";"));
    env
}

/// 用 FluidSynth 把一个 MIDI 渲染成 WAV。命令行与参考 _synthesize 逐字一致。
/// 管道用后台线程排空避免 pipe-full 死锁；整体 600s 超时保护（参考实现同值）。
fn fluidsynth_render(exe: &Path, sf: &Path, midi: &Path, out: &Path, preset: &AudioPreset) -> Result<(), String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("-ni")
        .arg("-o").arg(format!("audio.file.format={}", preset.format))
        .arg("-F").arg(out)
        .arg("-r").arg(preset.sample_rate.to_string())
        .arg(sf)
        .arg(midi)
        .envs(fluidsynth_env(exe))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::util::CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("EXPORT_RENDER_FAILED: spawn fluidsynth: {e}"))?;

    // 后台线程读尽 stdout/stderr —— FluidSynth 输出很少，但必须排空防止写满管道卡死。
    fn drain<R: std::io::Read + Send + 'static>(stream: Option<R>) -> Option<std::thread::JoinHandle<()>> {
        stream.map(|mut reader| {
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while reader.read(&mut buf).map(|n| n > 0).unwrap_or(false) {}
            })
        })
    }
    let mut stdout_drain = drain(child.stdout.take());
    let mut stderr_drain = drain(child.stderr.take());
    let mut join_drains = || {
        if let Some(h) = stdout_drain.take() {
            let _ = h.join();
        }
        if let Some(h) = stderr_drain.take() {
            let _ = h.join();
        }
    };

    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    join_drains();
                    return Err("EXPORT_RENDER_FAILED: FluidSynth timed out after 600s".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                join_drains();
                return Err(format!("EXPORT_RENDER_FAILED: wait fluidsynth: {e}"));
            }
        }
    };
    join_drains();

    let rendered = out.is_file() && std::fs::metadata(out).map(|m| m.len() > 0).unwrap_or(false);
    if !status.success() || !rendered {
        return Err(format!(
            "EXPORT_RENDER_FAILED: fluidsynth exit={:?} output_exists={}",
            status.code(),
            rendered
        ));
    }
    Ok(())
}

fn absolutize(p: &str) -> PathBuf {
    let pb = PathBuf::from(p);
    if pb.is_absolute() {
        pb
    } else {
        std::path::absolute(&pb).unwrap_or(pb)
    }
}

/// 校验源 MIDI / FluidSynth / 音源三要素 —— 所有音频导出命令的共同前置。
fn precheck(models_dir: &Path, midi_path: &str) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let midi = absolutize(midi_path);
    if !midi.is_file() {
        return Err(format!("EXPORT_SRC_NOT_FOUND: {}", midi.display()));
    }
    let exe = fluidsynth_exe(models_dir).ok_or("EXPORT_FLUIDSYNTH_NOT_FOUND")?;
    let sf = resolve_active_soundfont(models_dir);
    if !sf.is_file() {
        return Err("EXPORT_SOUNDFONT_NOT_FOUND".into());
    }
    Ok((midi, exe, sf))
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-A-3：转录音频导出（整首 MIDI 合成 WAV）
// ─────────────────────────────────────────────────────────────────────────────

/// 渲染当前 MIDI 为单个 WAV。preset: "hq"=24bit/48kHz | "compat"=16bit/44.1kHz。
/// 音源由 resolve_active_soundfont 统一管理，前端无需传。
#[tauri::command]
pub async fn amt_export_midi_audio(
    state: State<'_, AppState>,
    midi_path: String,
    out_path: String,
    preset: String,
) -> Result<String, String> {
    let models_dir = state.amt_models_dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let (midi, exe, sf) = precheck(&models_dir, &midi_path)?;
        let out = absolutize(&out_path);
        let preset = audio_preset(&preset);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("EXPORT_WRITE_FAILED: mkdir: {e}"))?;
        }
        fluidsynth_render(&exe, &sf, &midi, &out, &preset)?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("EXPORT_RENDER_FAILED: join: {e}"))?
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-A-4：分轨音频导出（每乐器一个 WAV，打 zip）
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmtStemAudioExportResult {
    pub zip_path: String,
    pub members: Vec<String>,
}

/// 把合并 MIDI 的每条轨道渲染成独立 WAV 并打 zip（参考 stem_archive 语义）。
#[tauri::command]
pub async fn amt_export_stems_audio(
    state: State<'_, AppState>,
    midi_path: String,
    out_path: String,
    preset: String,
) -> Result<AmtStemAudioExportResult, String> {
    let models_dir = state.amt_models_dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<AmtStemAudioExportResult, String> {
        use std::io::Write;

        let (midi, exe, sf) = precheck(&models_dir, &midi_path)?;
        let out = absolutize(&out_path);
        let preset = audio_preset(&preset);

        // 逐轨拆分（与 export_midi_tracks_to_folder 同规则：TrackName 命名 + 去重）。
        let bytes = std::fs::read(&midi)
            .map_err(|e| format!("EXPORT_SRC_NOT_FOUND: read: {e}"))?;
        let smf = midly::Smf::parse(&bytes)
            .map_err(|e| format!("EXPORT_SRC_NOT_FOUND: parse: {e}"))?;

        let base = midi
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "transcription".to_string());

        let temp_dir = std::env::temp_dir().join(format!("amt_stem_export_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("EXPORT_WRITE_FAILED: tmpdir: {e}"))?;
        let result = (|| -> Result<AmtStemAudioExportResult, String> {
            let mut members: Vec<String> = Vec::new();
            let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();

            let file = std::fs::File::create(&out)
                .map_err(|e| format!("EXPORT_WRITE_FAILED: create zip: {e}"))?;
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);

            for (idx, track) in smf.tracks.iter().enumerate() {
                if track.is_empty() {
                    continue;
                }
                let mut name: Option<String> = None;
                for ev in track.iter() {
                    if let midly::TrackEventKind::Meta(midly::MetaMessage::TrackName(n)) = ev.kind {
                        if !n.is_empty() {
                            name = Some(String::from_utf8_lossy(n).into_owned());
                        }
                        break;
                    }
                }
                let raw = name.unwrap_or_else(|| format!("track_{}", idx + 1));
                let safe: String = raw
                    .chars()
                    .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' })
                    .collect::<String>()
                    .trim()
                    .to_string();
                let safe = if safe.is_empty() { format!("track_{}", idx + 1) } else { safe };

                let mut leaf = format!("{}_{}", base, safe);
                let mut n = 2;
                while used.contains(&leaf) {
                    leaf = format!("{}_{}_{}", base, safe, n);
                    n += 1;
                }
                used.insert(leaf.clone());

                let track_midi = temp_dir.join(format!("{leaf}.mid"));
                midly::Smf {
                    header: smf.header,
                    tracks: vec![track.clone()],
                }
                .save(&track_midi)
                .map_err(|e| format!("EXPORT_WRITE_FAILED: split midi: {e}"))?;

                let track_wav = temp_dir.join(format!("{leaf}.wav"));
                fluidsynth_render(&exe, &sf, &track_midi, &track_wav, &preset)?;

                let member_name = format!("{}_{}.wav", leaf, preset.suffix);
                zip.start_file(member_name.clone(), opts)
                    .map_err(|e| format!("EXPORT_WRITE_FAILED: zip entry: {e}"))?;
                let wav_bytes = std::fs::read(&track_wav)
                    .map_err(|e| format!("EXPORT_WRITE_FAILED: read wav: {e}"))?;
                zip.write_all(&wav_bytes)
                    .map_err(|e| format!("EXPORT_WRITE_FAILED: zip write: {e}"))?;
                members.push(member_name);
            }

            zip.finish()
                .map_err(|e| format!("EXPORT_WRITE_FAILED: finalize zip: {e}"))?;
            if members.is_empty() {
                return Err("EXPORT_NO_FILES: no tracks found".into());
            }
            Ok(AmtStemAudioExportResult {
                zip_path: out.to_string_lossy().into_owned(),
                members,
            })
        })();

        let _ = std::fs::remove_dir_all(&temp_dir);
        result
    })
    .await
    .map_err(|e| format!("EXPORT_RENDER_FAILED: join: {e}"))?
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-A-5：立体声 A/B 导出（左=原声，右=MIDI）
// ─────────────────────────────────────────────────────────────────────────────

/// 参考 _write_official_stereo_mix：原声 mono → L、MIDI 合成 mono → R，等长 pad 后交织。
/// 采样率跟随原声（避免额外重采样有损）；MIDI 按同一采样率渲染，天然对齐。
#[tauri::command]
pub async fn amt_export_stereo_wav(
    state: State<'_, AppState>,
    original_audio_path: String,
    midi_path: String,
    out_path: String,
) -> Result<String, String> {
    let models_dir = state.amt_models_dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let (midi, exe, sf) = precheck(&models_dir, &midi_path)?;
        let original = absolutize(&original_audio_path);
        if !original.is_file() {
            return Err(format!("EXPORT_SRC_NOT_FOUND: {}", original.display()));
        }

        // 1) 原声 → mono f32（工程统一 load_audio 三级加载：hound/symphonia/ffmpeg）。
        let buf = crate::audio::load_audio(&original)
            .map_err(|e| format!("EXPORT_RENDER_FAILED: load original: {e}"))?;
        let sr = buf.sample_rate;
        let mut left = to_mono(&buf.samples, buf.channels as usize);

        // 2) MIDI 按原声采样率渲染（FluidSynth 支持 8k–96k）→ mono。
        let temp_dir = std::env::temp_dir().join(format!("amt_stereo_export_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("EXPORT_WRITE_FAILED: tmpdir: {e}"))?;
        let result = (|| -> Result<String, String> {
            let midi_wav = temp_dir.join("midi_render.wav");
            let preset = AudioPreset { sample_rate: sr, format: "s16", suffix: "" };
            fluidsynth_render(&exe, &sf, &midi, &midi_wav, &preset)?;
            let mbuf = crate::audio::load_audio(&midi_wav)
                .map_err(|e| format!("EXPORT_RENDER_FAILED: load midi render: {e}"))?;
            let mut right = to_mono(&mbuf.samples, mbuf.channels as usize);

            // 3) 等长 pad（参考 np.pad 语义）。
            let length = left.len().max(right.len());
            left.resize(length, 0.0);
            right.resize(length, 0.0);

            // 4) 交织立体声写盘（16bit —— 参考兼容档定位）。
            let out = absolutize(&out_path);
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("EXPORT_WRITE_FAILED: mkdir: {e}"))?;
            }
            let spec = hound::WavSpec {
                channels: 2,
                sample_rate: sr,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = hound::WavWriter::create(&out, spec)
                .map_err(|e| format!("EXPORT_WRITE_FAILED: create wav: {e}"))?;
            for (l, r) in left.iter().zip(right.iter()) {
                let lv = (l.clamp(-1.0, 1.0) * 32767.0).round() as i16;
                let rv = (r.clamp(-1.0, 1.0) * 32767.0).round() as i16;
                writer
                    .write_sample(lv)
                    .and_then(|_| writer.write_sample(rv))
                    .map_err(|e| format!("EXPORT_WRITE_FAILED: wav sample: {e}"))?;
            }
            writer
                .finalize()
                .map_err(|e| format!("EXPORT_WRITE_FAILED: finalize wav: {e}"))?;
            Ok(out.to_string_lossy().into_owned())
        })();
        let _ = std::fs::remove_dir_all(&temp_dir);
        result
    })
    .await
    .map_err(|e| format!("EXPORT_RENDER_FAILED: join: {e}"))?
}

/// 交织 f32 → mono（多声道均值；单声道直通）。
fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-A-2：乐谱导出（MusicXML + 全谱 PDF，MuseScore 4 刻写，打 zip）
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmtSheetMusicExportResult {
    pub zip_path: String,
    pub members: Vec<String>,
}

/// MuseScore 刻写：MIDI → score.musicxml + full_score.pdf，连同 score.mid 打 zip。
/// 参考 engrave_sheet_directory 的核心产物（MusicXML + 全谱 PDF）。
#[tauri::command]
pub async fn amt_export_sheet_music(
    state: State<'_, AppState>,
    midi_path: String,
    out_path: String,
) -> Result<AmtSheetMusicExportResult, String> {
    let models_dir = state.amt_models_dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<AmtSheetMusicExportResult, String> {
        use std::io::Write;

        let midi = absolutize(&midi_path);
        if !midi.is_file() {
            return Err(format!("EXPORT_SRC_NOT_FOUND: {}", midi.display()));
        }
        let mscore = musescore_exe(&models_dir).ok_or("EXPORT_MUSESCORE_NOT_FOUND")?;
        let out = absolutize(&out_path);

        let temp_dir = std::env::temp_dir().join(format!("amt_sheet_export_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("EXPORT_WRITE_FAILED: tmpdir: {e}"))?;

        let result = (|| -> Result<AmtSheetMusicExportResult, String> {
            let run_musescore = |args: &[&str], what: &str| -> Result<(), String> {
                let mut cmd = std::process::Command::new(&mscore);
                cmd.args(args)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .env("QT_QPA_PLATFORM", "offscreen");
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(crate::util::CREATE_NO_WINDOW);
                }
                let output = cmd
                    .output()
                    .map_err(|e| format!("EXPORT_SHEET_FAILED: spawn {what}: {e}"))?;
                if !output.status.success() {
                    return Err(format!(
                        "EXPORT_SHEET_FAILED: MuseScore {what} exit={:?} stderr={}",
                        output.status.code(),
                        String::from_utf8_lossy(&output.stderr).chars().take(400).collect::<String>()
                    ));
                }
                Ok(())
            };

            // MIDI → MusicXML（刻写即量化，MuseScore 导入默认按 1/16 网格吸附）。
            let musicxml = temp_dir.join("score.musicxml");
            let midi_str = midi.to_string_lossy().into_owned();
            run_musescore(
                &["-o", &musicxml.to_string_lossy(), &midi_str],
                "write MusicXML",
            )?;
            if !musicxml.is_file() || std::fs::metadata(&musicxml).map(|m| m.len()).unwrap_or(0) == 0 {
                return Err("EXPORT_SHEET_FAILED: MusicXML output missing".into());
            }

            // MIDI → 全谱 PDF。
            let pdf = temp_dir.join("full_score.pdf");
            run_musescore(
                &["-o", &pdf.to_string_lossy(), &midi_str],
                "render full score PDF",
            )?;
            let pdf_ok = std::fs::read(&pdf)
                .map(|b| b.starts_with(b"%PDF-"))
                .unwrap_or(false);
            if !pdf_ok {
                return Err("EXPORT_SHEET_FAILED: PDF output invalid".into());
            }

            // 打 zip：score.mid + score.musicxml + full_score.pdf。
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("EXPORT_WRITE_FAILED: mkdir: {e}"))?;
            }
            let file = std::fs::File::create(&out)
                .map_err(|e| format!("EXPORT_WRITE_FAILED: create zip: {e}"))?;
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            let mut members = Vec::new();
            for (name, path) in [
                ("score.mid", midi.clone()),
                ("score.musicxml", musicxml.clone()),
                ("full_score.pdf", pdf.clone()),
            ] {
                let bytes = std::fs::read(&path)
                    .map_err(|e| format!("EXPORT_WRITE_FAILED: read {name}: {e}"))?;
                zip.start_file(name, opts)
                    .map_err(|e| format!("EXPORT_WRITE_FAILED: zip entry {name}: {e}"))?;
                zip.write_all(&bytes)
                    .map_err(|e| format!("EXPORT_WRITE_FAILED: zip write {name}: {e}"))?;
                members.push(name.to_string());
            }
            zip.finish()
                .map_err(|e| format!("EXPORT_WRITE_FAILED: finalize zip: {e}"))?;

            Ok(AmtSheetMusicExportResult {
                zip_path: out.to_string_lossy().into_owned(),
                members,
            })
        })();

        let _ = std::fs::remove_dir_all(&temp_dir);
        result
    })
    .await
    .map_err(|e| format!("EXPORT_SHEET_FAILED: join: {e}"))?
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-D：音符编辑器试听（VocalEditor 乐器模式）
// ─────────────────────────────────────────────────────────────────────────────

/// 把一段音符直接渲染成可试听的 WAV（不落工程、不进导出链）：
///   1. 写临时 SMF（复用 amt_write_edited_midi，PPQ 480 与前端 TICKS_PER_BEAT 同轴）
///   2. FluidSynth 按指定音源（缺省=当前音源）合成
///   3. 返回 WAV 绝对路径；前端用 loadAudioBuffer 播放。临时文件留在
///      %TEMP%/utai_note_preview/（只保留最近 3 个，旧的自动清）。
#[tauri::command]
pub async fn preview_notes_render(
    state: State<'_, AppState>,
    bpm: f64,
    notes: Vec<crate::commands::amt::EditedNoteInput>,
    program: Option<u8>,
    channel: Option<u8>,
    soundfont: Option<String>,
) -> Result<String, String> {
    let models_dir = state.amt_models_dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        use crate::commands::amt::{amt_write_edited_midi, EditedTrackInput};

        if notes.is_empty() {
            return Err("PREVIEW_NO_NOTES".into());
        }
        let exe = fluidsynth_exe(&models_dir).ok_or("EXPORT_FLUIDSYNTH_NOT_FOUND")?;
        // 音源：显式指定 → soundfonts/ 下按文件名取；否则当前音源。
        let sf = match soundfont.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(name) => {
                let cand = soundfonts_dir(&models_dir).join(name);
                if !cand.is_file() {
                    return Err("EXPORT_SOUNDFONT_NOT_FOUND".into());
                }
                cand
            }
            None => {
                let sf = resolve_active_soundfont(&models_dir);
                if !sf.is_file() {
                    return Err("EXPORT_SOUNDFONT_NOT_FOUND".into());
                }
                sf
            }
        };

        let dir = std::env::temp_dir().join("utai_note_preview");
        std::fs::create_dir_all(&dir).map_err(|e| format!("EXPORT_WRITE_FAILED: tmpdir: {e}"))?;
        // 只保留最近 3 个 WAV —— 试听是高频操作，别把 TEMP 撑爆。
        if let Ok(entries) = std::fs::read_dir(&dir) {
            let mut olds: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("wav"))
                .collect();
            olds.sort();
            while olds.len() >= 3 {
                let victim = olds.remove(0);
                let _ = std::fs::remove_file(victim);
            }
        }

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let midi_path = dir.join(format!("notes_{stamp}.mid"));
        let wav_path = dir.join(format!("notes_{stamp}.wav"));

        let tracks = vec![EditedTrackInput {
            name: "Note Preview".into(),
            program,
            channel,
            notes,
        }];
        amt_write_edited_midi(
            midi_path.to_string_lossy().into_owned(),
            bpm,
            tracks,
        )?;

        let preset = audio_preset("compat"); // 16bit/44.1kHz —— 试听档，出得快
        fluidsynth_render(&exe, &sf, &midi_path, &wav_path, &preset)?;
        let _ = std::fs::remove_file(&midi_path);
        Ok(wav_path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("EXPORT_RENDER_FAILED: join: {e}"))?
}
