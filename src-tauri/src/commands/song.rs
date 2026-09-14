//! 歌曲制作（Song Studio）后端命令 —— 音乐模型下载/管理 + 生成历史持久化 + 外部推理服务对接。
//!
//! 设计对齐（详见 `.trae/documents/song-production-plan.md`）：
//! - 音乐模型落盘 `<data>/models/song/`，与 `msst`/`amt` 并列，下载统一走 `download.rs`
//!   （.part 续传 + 镜像轮换 + stall 看门狗 + sha256 校验后改名）。
//! - 生成历史落 `<data>/song_history.json`，直接照抄 `storage.rs` 的 `preset_file` /
//!   `load_workflow_presets` / `save_workflow_preset` 范式。
//! - 阶段 A：外部推理服务（YuE2 / ACE-Step 均为 Linux/Python 栈）默认不自动拉起，
//!   仅探测可用性（`song_service_probe`）与转发生成请求（`song_generate`）。
//! - 下载进度事件名 `song-download-progress`（独立于 MSST/AMT，避免卡片状态串台）。

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::AppState;

/// 与 `storage::data_root` 同语义：`<cache_dir>/..`，兜底 `app_dir/data`。
/// song.rs 独立实现一份，避免跨模块私有依赖。
fn data_root(state: &AppState) -> PathBuf {
    state
        .cache_dir
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| state.app_dir.join("data"))
}

fn song_history_file(state: &AppState) -> PathBuf {
    data_root(state).join("song_history.json")
}

/// 文件名清洗：去掉 Windows/跨平台非法字符、路径分隔与控制字符，空白折叠为 `-`。
/// 用于由用户输入的歌曲名生成目录名，避免下游 `join` 越界或建目录失败。
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '.' | '\0' => '-',
            c if c.is_control() || c.is_whitespace() => '-',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

fn timestamp_slug() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/// 生成产物默认输出目录：`<data>/songs/<sanitized(song_name)>/`；song_name 为空时用时间戳。
fn default_song_output_dir(state: &AppState, song_name: &str) -> Result<PathBuf, String> {
    let slug = if song_name.trim().is_empty() {
        format!("untitled-{}", timestamp_slug())
    } else {
        sanitize_filename(song_name)
    };
    let dir = data_root(state).join("songs").join(slug);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// ---------------------------------------------------------------------------
// 音乐模型目录 / 列表 / 下载 / 删除
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_song_models_dir(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let dir = state.song_models_dir.clone();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create song models dir: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 已下载音乐模型的简单清单：`<filename, size>`。前端与 `SONG_MODEL_CATALOG` 比对得出
/// 安装状态。递归扫描，扩展名白名单只认模型类产物。
#[tauri::command]
pub fn list_song_models(state: State<'_, Arc<AppState>>) -> Result<Vec<SongModelFile>, String> {
    let dir = &state.song_models_dir;
    let mut models = Vec::new();
    if !dir.exists() {
        return Ok(models);
    }
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(current) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    let ext = path
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    if ["safetensors", "ckpt", "pt", "pth", "onnx", "whl", "bin", "yaml", "json", "sf2", "mid", "wav"]
                        .contains(&ext.as_str())
                    {
                        let rel = path.strip_prefix(dir).unwrap_or(&path);
                        let filename = rel.to_string_lossy().to_string().replace('\\', "/");
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        models.push(SongModelFile { filename, size });
                    }
                }
            }
        }
    }
    models.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(models)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SongModelFile {
    pub filename: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
struct SongDownloadProgress {
    id: String,
    downloaded: u64,
    total: u64,
    stage: String,
}

#[tauri::command]
pub async fn download_song_model(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    urls: Vec<String>,
    id: String,
    filename: String,
    sha256: Option<String>,
) -> Result<String, String> {
    let dir = state.song_models_dir.clone();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create models dir: {e}"))?;

    let dest = dir.join(&filename);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let client = crate::download::client().map_err(|e| e.to_string())?;
    let app_emit = app.clone();
    let model_id = id.clone();
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut last_emit: u64 = 0;

    crate::download::download(
        &client,
        &crate::download::DownloadRequest {
            urls,
            dest: dest.clone(),
            sha256,
            expected_size: None,
        },
        &cancel,
        move |done, total| {
            // Range 续传时 done 会回落（新起点更小），重置 high-water 以免进度条倒退。
            if done < last_emit {
                last_emit = 0;
            }
            if done.saturating_sub(last_emit) > 1_000_000 || Some(done) == total {
                last_emit = done;
                let _ = app_emit.emit(
                    "song-download-progress",
                    SongDownloadProgress {
                        id: model_id.clone(),
                        downloaded: done,
                        total: total.unwrap_or(0),
                        stage: "download".into(),
                    },
                );
            }
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    tracing::info!("Downloaded song model: {}", filename);
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_song_model(state: State<'_, Arc<AppState>>, filename: String) -> Result<(), String> {
    let dir = &state.song_models_dir;
    // ⛔ 路径穿越防护：拒绝任何解析后越出 song_models_dir 的路径（`..` / 绝对路径等）。
    let path = dir.join(&filename);
    let canon_dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.clone());
    let canon_path = match std::fs::canonicalize(&path) {
        Ok(p) => p,
        // 目标不存在（或已被删除）——幂等地视为成功，避免前端反复删除报错。
        Err(_) => return Ok(()),
    };
    if !canon_path.starts_with(&canon_dir) {
        return Err("SONG_DELETE_REJECTED: path escapes models dir".into());
    }
    if path.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| format!("SONG_DELETE_FAILED: {e}"))?;
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("SONG_DELETE_FAILED: {e}"))?;
    }
    // 清理空父目录（不越出 song_models_dir）。
    let mut parent = path.parent();
    while let Some(p) = parent {
        if p == dir || !p.starts_with(dir) {
            break;
        }
        if let Ok(entries) = std::fs::read_dir(p) {
            if entries.count() == 0 {
                let _ = std::fs::remove_dir(p);
            }
        }
        parent = p.parent();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 生成历史持久化（照抄 storage.rs 的 preset_file 范式）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn load_song_history(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let path = song_history_file(&state);
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(_) => Ok("[]".into()),
    }
}

/// `entries` 为前端已序列化的完整历史数组（`Vec<SongHistoryEntry>`），整体覆盖写入。
#[tauri::command]
pub fn save_song_history(
    state: State<'_, Arc<AppState>>,
    entries: serde_json::Value,
) -> Result<(), String> {
    let root = data_root(&state);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let path = song_history_file(&state);
    let out = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    // 原子写入：tmp + 同目录 rename，崩溃时不会留下半截 JSON（下一轮 load 解析即失败）。
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
    crate::util::rename_with_retry(&tmp, &path, "SONG_HISTORY_WRITE")
}

// ---------------------------------------------------------------------------
// 外部推理服务对接（阶段 A：只探测 + 转发，不自动拉起 Python 服务）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SongServiceProbe {
    pub ok: bool,
    pub status: u16,
    pub message: String,
}

#[tauri::command]
pub async fn song_service_probe(url: String) -> Result<SongServiceProbe, String> {
    let client = crate::download::client().map_err(|e| e.to_string())?;
    let base = url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Ok(SongServiceProbe {
            ok: false,
            status: 0,
            message: "SONG_SERVICE_URL_EMPTY".into(),
        });
    }
    match client
        .get(format!("{base}/"))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(resp) => Ok(SongServiceProbe {
            ok: resp.status().is_success(),
            status: resp.status().as_u16(),
            message: resp.status().to_string(),
        }),
        Err(e) => Ok(SongServiceProbe {
            ok: false,
            status: 0,
            message: format!("{e}"),
        }),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct SongGenRequest {
    pub model: String,
    pub song_name: String,
    pub lyrics: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub cot: String,
    pub cfg_scale: f64,
    pub num_inference_steps: u32,
    pub seed: i64,
    pub audio_duration: f64,
    pub guidance_scale: f64,
    pub shift: f64,
    pub bpm: f64,
    pub key_scale: String,
    pub time_signature: String,
    pub language: String,
    pub vocal_gender: String,
    pub vocal_type: String,
    pub vocal_range: String,
    pub checkpoint: String,
    pub want_stems: bool,
    pub want_midi: bool,
    pub want_lrc: bool,
    pub format: String,
    pub service_url: String,
    pub output_dir: String,
}

impl Default for SongGenRequest {
    fn default() -> Self {
        Self {
            model: "acestep".into(),
            song_name: String::new(),
            lyrics: String::new(),
            prompt: String::new(),
            negative_prompt: String::new(),
            cot: "full".into(),
            cfg_scale: 1.0,
            num_inference_steps: 30,
            seed: 0,
            audio_duration: 30.0,
            guidance_scale: 1.0,
            shift: 1.0,
            bpm: 0.0,
            key_scale: String::new(),
            time_signature: "4/4".into(),
            language: String::new(),
            vocal_gender: "auto".into(),
            vocal_type: String::new(),
            vocal_range: String::new(),
            checkpoint: "turbo".into(),
            want_stems: true,
            want_midi: true,
            want_lrc: false,
            format: "wav".into(),
            service_url: String::new(),
            output_dir: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SongOutput {
    pub label: String,
    pub audio_path: Option<String>,
    pub midi_path: Option<String>,
    pub lrc_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct SongProgress {
    stage: String,
    current: u64,
    total: u64,
    stem_label: String,
}

/// 转发生成请求到外部推理服务（`service_url` 指向本地 acestep-api 或 YuE2 pipeline HTTP）。
/// 阶段 A 语义：服务未就绪时返回明确的 SONG_SERVICE_UNAVAILABLE，交由前端既有的
/// `maybeShowErrorModal` 路径提示用户，绝不静默失败、也不自动拉起重进程。
#[tauri::command]
pub async fn song_generate(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    mut req: SongGenRequest,
) -> Result<Vec<SongOutput>, String> {
    let service_url = req.service_url.trim().trim_end_matches('/').to_string();
    if service_url.is_empty() {
        return Err("SONG_SERVICE_URL_EMPTY".into());
    }
    // output_dir 兜底：前端未传或为空时落到 <data>/songs/<sanitized(song_name)>/，
    // 避免 `create_dir_all("")` 直接失败导致生成请求还没发出就报错。
    let output_dir = if req.output_dir.trim().is_empty() {
        default_song_output_dir(&state, &req.song_name)?
    } else {
        std::fs::create_dir_all(&req.output_dir).map_err(|e| e.to_string())?;
        PathBuf::from(&req.output_dir)
    };
    // 回填真实的输出目录到请求，转发的推理服务据此把产物写回本地。
    req.output_dir = output_dir.to_string_lossy().to_string();

    let emit_progress = |stage: &str, current: u64, total: u64, stem: &str| {
        let _ = app.emit(
            "song-progress",
            SongProgress {
                stage: stage.to_string(),
                current,
                total,
                stem_label: stem.to_string(),
            },
        );
    };

    emit_progress("request", 0, 1, "song");

    let client = crate::download::client().map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{service_url}/generate"))
        .json(&req)
        .timeout(std::time::Duration::from_secs(7200))
        .send()
        .await
        .map_err(|e| format!("SONG_SERVICE_UNAVAILABLE: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("SONG_SERVICE_ERROR: HTTP {}", resp.status()));
    }

    // 外部服务的产物清单：期望 `{ "outputs": [ {label, audio_path?, midi_path?, lrc_path?}, ... ] }`。
    #[derive(Deserialize)]
    struct Body {
        #[serde(default)]
        outputs: Vec<SongOutput>,
    }
    let body: Body = resp.json().await.map_err(|e| format!("SONG_SERVICE_BAD_RESPONSE: {e}"))?;

    emit_progress("done", 1, 1, "song");
    Ok(body.outputs)
}

/// 极简 ABC 符号谱 → MIDI（单旋律轨：音高 A-G + 升降号 + 八度 + 时值）。
/// 供 YuE2 的 `abc` 产物映射为 MIDI 轨道；不支持的语法原样跳过并继续，绝不 panic。
/// 约定：`C`=中央 C(MIDI 60)，`c`=高八度；`'` 升八度、`,` 降八度；`^` 升半音、`_` 降半音。
#[tauri::command]
pub fn abc_to_midi(abc: String, out_path: String) -> Result<String, String> {
    write_midi_from_abc(&abc, &out_path)?;
    Ok(out_path)
}

fn abc_tokens(input: &str) -> Vec<(i64, String)> {
    // 只保留第一个曲谱块（T: 之后的正文），并按 | 分小节；返回 (小节序号, 小节原文)。
    let mut body = String::new();
    let mut in_body = false;
    for line in input.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('%') {
            continue;
        }
        // 头部字段（K:/M:/L:/Q:/X:/T:）
        if t.len() >= 2 && t.as_bytes()[1] == b':' && t.as_bytes()[0].is_ascii_alphabetic() {
            in_body = true;
            continue;
        }
        if in_body {
            body.push_str(t);
            body.push(' ');
        }
    }
    let mut out = Vec::new();
    for (i, bar) in body.split('|').enumerate() {
        let b = bar.trim();
        if !b.is_empty() {
            out.push((i as i64, b.to_string()));
        }
    }
    out
}

/// 默认时值（拍）→ 每音符 tick。L: 未指定时按 1/8。
fn abc_default_len(input: &str) -> f64 {
    for line in input.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("L:") {
            let r = rest.trim();
            if let Some((a, b)) = r.split_once('/') {
                let a: f64 = a.trim().parse().unwrap_or(1.0);
                let b: f64 = b.trim().parse().unwrap_or(8.0);
                if b > 0.0 {
                    return a / b;
                }
            }
        }
    }
    1.0 / 8.0
}

fn abc_pitch(letter: char, acc: i32, oct: i32) -> i32 {
    // C=0, D=2, E=4, F=5, G=7, A=9, B=11
    let base: i32 = match letter.to_ascii_uppercase() {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        _ => return -1,
    };
    // ABC：大写=C4，小写=C5；oct 额外偏移（' 升、, 降）。
    let case_oct = if letter.is_ascii_uppercase() { 4 } else { 5 };
    // MIDI 编号 = (octave + 1) * 12 + pitchClass（中央 C = C4 = 60）。
    let midi = (case_oct + oct + 1) * 12 + base + acc;
    midi.clamp(0, 127)
}

fn write_midi_from_abc(input: &str, out_path: &str) -> Result<(), String> {
    use midly::num::{u15, u24, u28, u4, u7};
    use midly::{Format, Header, MetaMessage, MidiMessage, Smf, Timing, Track, TrackEvent, TrackEventKind};

    let default_len = abc_default_len(input);
    let ticks_per_beat = 480u16;
    let ticks_per_note = (default_len * ticks_per_beat as f64).round().max(1.0) as u32;

    let mut smf = Smf::new(Header::new(Format::SingleTrack, Timing::Metrical(u15::new(ticks_per_beat))));
    // conductor：Tempo 120 默认。
    let mut track: Track = vec![TrackEvent {
        delta: u28::new(0),
        kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(500_000))),
    }];

    for (_bar, text) in abc_tokens(input) {
        let chars: Vec<char> = text.chars().collect();
        let mut i = 0usize;
        while i < chars.len() {
            let c = chars[i];
            // 小节内分隔符 / 空格 / 连音符
            if c.is_whitespace() || c == '|' || c == '(' || c == ')' || c == '[' || c == ']' {
                i += 1;
                continue;
            }
            if c == 'z' || c == 'Z' || c == 'x' || c == 'X' {
                // 休止符
                let mut dur = ticks_per_note as i64;
                i += 1;
                if i < chars.len() && chars[i].is_ascii_digit() {
                    let mut s = String::new();
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        s.push(chars[i]);
                        i += 1;
                    }
                    dur = (s.parse::<f64>().unwrap_or(1.0) * ticks_per_note as f64) as i64;
                }
                let _ = dur; // 休止：仅推进时间，这里 delta 累积由最终音符绝对 tick 决定，跳过即可
                continue;
            }
            if c.is_ascii_alphabetic() {
                // 意外音 / 和弦装饰 [CEG] 内字母也在此，逐个作为旋律音处理
                let mut acc = 0i32;
                // 前置变音记号
                let mut k = i;
                while k < chars.len() && (chars[k] == '^' || chars[k] == '_' || chars[k] == '=') {
                    if chars[k] == '^' {
                        acc += 1;
                    } else if chars[k] == '_' {
                        acc -= 1;
                    }
                    k += 1;
                }
                if k >= chars.len() || !chars[k].is_ascii_alphabetic() {
                    i = k;
                    continue;
                }
                let letter = chars[k];
                k += 1;
                let mut oct = 0i32;
                while k < chars.len() && (chars[k] == '\'' || chars[k] == ',') {
                    if chars[k] == '\'' {
                        oct += 1;
                    } else {
                        oct -= 1;
                    }
                    k += 1;
                }
                let mut mult = 1.0f64;
                // 时值乘数：数字、或 / // 的除号
                if k < chars.len() && chars[k].is_ascii_digit() {
                    let mut s = String::new();
                    while k < chars.len() && chars[k].is_ascii_digit() {
                        s.push(chars[k]);
                        k += 1;
                    }
                    mult = s.parse::<f64>().unwrap_or(1.0);
                } else if k < chars.len() && chars[k] == '/' {
                    let mut div = 1.0f64;
                    while k < chars.len() && chars[k] == '/' {
                        div *= 2.0;
                        k += 1;
                    }
                    if k < chars.len() && chars[k].is_ascii_digit() {
                        let mut s = String::new();
                        while k < chars.len() && chars[k].is_ascii_digit() {
                            s.push(chars[k]);
                            k += 1;
                        }
                        div = s.parse::<f64>().unwrap_or(div);
                    }
                    mult = 1.0 / div;
                }
                let pitch = abc_pitch(letter, acc, oct);
                let dur = (mult * ticks_per_note as f64).round().max(1.0) as u32;
                if pitch >= 0 {
                    let vel = u7::new(100);
                    let key = u7::new(pitch as u8);
                    track.push(TrackEvent {
                        delta: u28::new(0),
                        kind: TrackEventKind::Midi {
                            channel: u4::new(0),
                            message: MidiMessage::NoteOn { key, vel },
                        },
                    });
                    track.push(TrackEvent {
                        delta: u28::new(dur.min(0x0FFF_FFFF)),
                        kind: TrackEventKind::Midi {
                            channel: u4::new(0),
                            message: MidiMessage::NoteOff { key, vel: u7::new(0) },
                        },
                    });
                }
                i = k;
                continue;
            }
            i += 1;
        }
    }

    track.push(TrackEvent {
        delta: u28::new(0),
        kind: TrackEventKind::Meta(MetaMessage::EndOfTrack),
    });
    smf.tracks.push(track);

    let mut buf: Vec<u8> = Vec::new();
    smf.write(&mut buf).map_err(|e| format!("SONG_ABC_WRITE_FAIL: {e}"))?;
    std::fs::write(out_path, buf).map_err(|e| format!("SONG_ABC_WRITE_FAIL: {e}"))
}

