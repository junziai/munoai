//! SFZ 解析器(阶段2)。
//!
//! 支持 SFZ 1.0 常用 opcode + SFZ 2.0 的 <global>/<master> 层级继承:
//! `<control> default_path`、`#include` 递归、`<global>/<master>` 模板、
//! `<group>` 组模板(继承 global,遇到新 `<group>` 重置)、`<region>` 实例。
//! 解析结果 = `Vec<Region>`,与 SF2 共用合成引擎。
//!
//! 采样文件支持 WAV/FLAC/OGG/MP3(走 audio::load_audio 三级解码)。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::synth::{LoopMode, Region, Trigger};

/// 解析 SFZ 文件为区域列表。
pub fn parse_sfz(path: &Path) -> Result<Vec<Region>, String> {
    let mut ctx = ParseCtx {
        base_dir: path.parent().unwrap_or(Path::new(".")).to_path_buf(),
        default_path: String::new(),
        global: HashMap::new(),
        group: HashMap::new(),
        regions: Vec::new(),
        depth: 0,
    };
    parse_file(path, &mut ctx)?;
    if ctx.regions.is_empty() {
        return Err(format!("SFZ 文件无 <region>: {}", path.display()));
    }
    Ok(ctx.regions)
}

struct ParseCtx {
    base_dir: PathBuf,
    default_path: String,
    global: HashMap<String, String>,
    group: HashMap<String, String>,
    regions: Vec<Region>,
    depth: u8,
}

fn parse_file(path: &Path, ctx: &mut ParseCtx) -> Result<(), String> {
    if ctx.depth > 8 {
        return Err("#include 嵌套超过 8 层".into());
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("读取 SFZ 失败 '{}': {}", path.display(), e))?;
    let saved_base = ctx.base_dir.clone();
    ctx.base_dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
    ctx.depth += 1;

    // 1. 行级预处理:去注释 + #include 递归展开
    let mut main_text = String::new();
    for line in text.lines() {
        let line = match line.find("//") {
            Some(i) => &line[..i],
            None => line,
        };
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("#include") {
            let inc = rest.trim().trim_matches('"').trim_matches('\'');
            if !inc.is_empty() {
                let inc_path = ctx.base_dir.join(inc.replace('\\', "/"));
                if inc_path.is_file() {
                    parse_file(&inc_path, ctx)?;
                } else {
                    tracing::warn!("#include not found: {}", inc_path.display());
                }
            }
            continue;
        }
        if t.starts_with('#') {
            continue; // #define 等预处理指令不支持,跳过
        }
        main_text.push_str(line);
        main_text.push('\n');
    }

    // 2. header 状态机:<name> 切段,段内 opcode 文本进 pending
    let mut cur_header = String::new();
    let mut pending = String::new();
    let mut in_header = false;
    for ch in main_text.chars() {
        if ch == '<' {
            // 提交上一段的 opcode 文本,开始收集新 header 名
            flush_pending(&mut pending, ctx, &cur_header);
            cur_header.clear();
            in_header = true;
        } else if ch == '>' {
            in_header = false;
            let h = cur_header.trim().to_ascii_lowercase();
            match h.as_str() {
                "group" => {
                    // 新 group 模板:继承 global
                    ctx.group = ctx.global.clone();
                }
                "global" | "master" => {
                    // 新 global 模板:重置
                    ctx.global.clear();
                    ctx.group.clear();
                }
                _ => {}
            }
            cur_header = h;
        } else if in_header {
            cur_header.push(ch);
        } else {
            pending.push(ch);
        }
    }
    flush_pending(&mut pending, ctx, &cur_header);

    ctx.depth -= 1;
    ctx.base_dir = saved_base;
    Ok(())
}

/// 把累积的 opcode 文本刷入对应 header 上下文。
fn flush_pending(pending: &mut String, ctx: &mut ParseCtx, header: &str) {
    let text = std::mem::take(pending);
    if text.trim().is_empty() {
        return;
    }
    let opcodes = parse_opcodes(&text);
    match header {
        "global" | "master" => {
            for (k, v) in opcodes {
                ctx.global.insert(k, v);
            }
            ctx.group = ctx.global.clone();
        }
        "group" => {
            for (k, v) in opcodes {
                ctx.group.insert(k, v);
            }
        }
        "region" => {
            let mut merged = ctx.group.clone();
            for (k, v) in opcodes {
                merged.insert(k, v);
            }
            if let Some(region) = build_region(&merged, &ctx.base_dir, &ctx.default_path) {
                ctx.regions.push(region);
            }
        }
        "control" => {
            for (k, v) in opcodes {
                if k == "default_path" {
                    ctx.default_path = v;
                }
            }
        }
        _ => {}
    }
}

/// opcode 文本 → (key, value) 序列。value 允许含空格(sample 路径),= 后到下一个
/// `key=` 边界为止;key 仅 [a-z0-9_]。
fn parse_opcodes(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    let n = bytes.len();
    let mut i = 0usize;
    while i < n {
        // 找 key 开始(字母)
        if !bytes[i].is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        let key_start = i;
        while i < n && (bytes[i].is_ascii_alphanumeric() || bytes[i] == '_') {
            i += 1;
        }
        let key: String = bytes[key_start..i].iter().collect::<String>().to_ascii_lowercase();
        // 跳过空白,期待 '='
        while i < n && bytes[i].is_whitespace() {
            i += 1;
        }
        if i >= n || bytes[i] != '=' {
            continue; // 不是 opcode,跳过
        }
        i += 1; // '='
        while i < n && bytes[i].is_whitespace() {
            i += 1;
        }
        let val_start = i;
        // value 直到下一个 "key=" 模式(字母序列后跟可选空白和 =)或结尾
        while i < n {
            let c = bytes[i];
            if c.is_ascii_alphabetic() {
                // 探测这是否是下一个 opcode 的 key
                let mut j = i;
                while j < n && (bytes[j].is_ascii_alphanumeric() || bytes[j] == '_') {
                    j += 1;
                }
                let mut k2 = j;
                while k2 < n && bytes[k2].is_whitespace() {
                    k2 += 1;
                }
                if k2 < n && bytes[k2] == '=' && j > i {
                    break; // 下一个 opcode 开始
                }
            }
            i += 1;
        }
        let value: String = bytes[val_start..i].iter().collect();
        out.push((key, value.trim().trim_matches('"').to_string()));
    }
    out
}

/// key 字段解析:数字(0-127)或音名(c4 / cs4 / db3 → MIDI)。
/// SFZ 音名约定:c4 = 60,升号 s/#,降号 b,八度 -1..9。
fn parse_key(v: &str) -> Option<u8> {
    let v = v.trim();
    if let Ok(n) = v.parse::<i32>() {
        return Some(n.clamp(0, 127) as u8);
    }
    let mut chars = v.chars();
    let letter = chars.next()?.to_ascii_lowercase();
    if !matches!(letter, 'a'..='g') {
        return None;
    }
    let mut semis_from_c = match letter {
        'c' => 0,
        'd' => 2,
        'e' => 4,
        'f' => 5,
        'g' => 7,
        'a' => 9,
        'b' => 11,
        _ => return None,
    };
    let mut rest: String = chars.collect();
    // 前导 #/s/b 变音
    if rest.starts_with('#') || rest.starts_with('s') {
        if rest.starts_with('#') {
            semis_from_c += 1;
            rest = rest[1..].to_string();
        } else if rest.starts_with('s') && rest.len() > 1 && rest[1..].parse::<i32>().is_ok() {
            semis_from_c += 1;
            rest = rest[1..].to_string();
        }
    } else if rest.starts_with('b') {
        semis_from_c -= 1;
        rest = rest[1..].to_string();
    } else if rest.starts_with('f') && rest.len() > 1 && rest[1..].parse::<i32>().is_ok() {
        semis_from_c -= 1;
        rest = rest[1..].to_string();
    }
    let octave: i32 = rest.trim().parse().ok()?;
    let midi = (octave + 1) * 12 + semis_from_c;
    if (0..=127).contains(&midi) {
        Some(midi as u8)
    } else {
        None
    }
}

fn parse_f32(v: &str) -> Option<f32> {
    v.trim().parse::<f32>().ok()
}

fn parse_u32(v: &str) -> Option<u32> {
    v.trim().parse::<u32>().ok()
}

/// 合并后的 opcode 表 → Region(sample 相对 base_dir + default_path 解析)。
fn build_region(opcodes: &HashMap<String, String>, base_dir: &Path, default_path: &str) -> Option<Region> {
    let sample = opcodes.get("sample")?;
    if sample.is_empty() {
        return None;
    }
    let sample_path = resolve_sample(sample, base_dir, default_path);
    if !sample_path.exists() {
        // 采样缺失的区域直接丢弃(引擎无法回放)
        return None;
    }
    let mut r = Region {
        sample_path,
        ..Default::default()
    };
    for (k, v) in opcodes {
        apply_opcode(&mut r, k, v);
    }
    Some(r)
}

fn resolve_sample(sample: &str, base_dir: &Path, default_path: &str) -> PathBuf {
    let s = sample.replace('\\', "/");
    // 绝对路径直接用
    let p = Path::new(&s);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    let joined = if default_path.is_empty() {
        base_dir.join(&s)
    } else {
        let dp = default_path.replace('\\', "/");
        let dp = dp.trim_end_matches('/');
        base_dir.join(dp).join(&s)
    };
    joined
}

fn apply_opcode(r: &mut Region, k: &str, v: &str) {
    match k {
        "sample" => {}
        "key" | "pitch_keynote" => {
            if let Some(key) = parse_key(v) {
                r.key_lo = key;
                r.key_hi = key;
                r.keycenter = Some(key);
            }
        }
        "lokey" => {
            if let Some(key) = parse_key(v) {
                r.key_lo = key;
            }
        }
        "hikey" => {
            if let Some(key) = parse_key(v) {
                r.key_hi = key;
            }
        }
        "lovel" => {
            if let Some(x) = parse_f32(v) {
                r.vel_lo = x.clamp(0.0, 127.0) as u8;
            }
        }
        "hivel" => {
            if let Some(x) = parse_f32(v) {
                r.vel_hi = x.clamp(0.0, 127.0) as u8;
            }
        }
        "pitch_keycenter" => {
            if let Some(key) = parse_key(v) {
                r.keycenter = Some(key);
            }
        }
        "pitch_track" => {
            r.track = parse_f32(v).map(|x| x != 0.0).unwrap_or(true);
        }
        "transpose" => {
            if let Some(x) = parse_f32(v) {
                r.transpose = x.round() as i32;
            }
        }
        "tune" => {
            if let Some(x) = parse_f32(v) {
                r.tune = x.clamp(-3600.0, 3600.0);
            }
        }
        "volume" => {
            if let Some(x) = parse_f32(v) {
                r.volume_db = x.clamp(-144.0, 48.0);
            }
        }
        "pan" => {
            if let Some(x) = parse_f32(v) {
                r.pan = (x / 100.0).clamp(-1.0, 1.0);
            }
        }
        "amp_veltrack" => {
            if let Some(x) = parse_f32(v) {
                r.veltrack = x.clamp(-200.0, 200.0);
            }
        }
        "ampeg_attack" | "attack" => {
            if let Some(x) = parse_f32(v) {
                r.attack = x.max(0.0);
            }
        }
        "ampeg_hold" | "hold" => {
            if let Some(x) = parse_f32(v) {
                r.hold = x.max(0.0);
            }
        }
        "ampeg_decay" | "decay" => {
            if let Some(x) = parse_f32(v) {
                r.decay = x.max(0.0);
            }
        }
        "ampeg_sustain" | "sustain" => {
            if let Some(x) = parse_f32(v) {
                r.sustain = (x / 100.0).clamp(0.0, 1.0);
            }
        }
        "ampeg_release" | "release" => {
            if let Some(x) = parse_f32(v) {
                r.release = x.max(0.0);
            }
        }
        "loop_mode" => {
            r.loop_mode = match v.trim().to_ascii_lowercase().as_str() {
                "no_loop" => LoopMode::NoLoop,
                "one_shot" => LoopMode::OneShot,
                "loop_continuous" => LoopMode::Continuous,
                "loop_sustain" => LoopMode::Sustain,
                _ => r.loop_mode,
            };
        }
        "loop_start" => {
            if let Some(x) = parse_u32(v) {
                r.loop_start = Some(x);
            }
        }
        "loop_end" => {
            if let Some(x) = parse_u32(v) {
                r.loop_end = Some(x);
            }
        }
        "end" => {
            if let Some(x) = parse_u32(v) {
                r.end = Some(x);
            }
        }
        "offset" => {
            if let Some(x) = parse_u32(v) {
                r.offset = x;
            }
        }
        "seq_length" => {
            if let Some(x) = parse_u32(v) {
                r.seq_length = x.max(1);
            }
        }
        "seq_position" => {
            if let Some(x) = parse_u32(v) {
                r.seq_position = x.max(1);
            }
        }
        "off_by" => {
            if let Some(x) = parse_u32(v) {
                r.off_by = Some(x);
            }
        }
        "group" => {
            if let Some(x) = parse_u32(v) {
                r.group = x;
            }
        }
        "trigger" => {
            r.trigger = match v.trim().to_ascii_lowercase().as_str() {
                "attack" => Trigger::Attack,
                "release" => Trigger::Release,
                "first" => Trigger::First,
                "legato" => Trigger::Legato,
                _ => r.trigger,
            };
        }
        "sw_last" => {
            if let Some(key) = parse_key(v) {
                r.sw_last = Some(key);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_names() {
        assert_eq!(parse_key("c4"), Some(60));
        assert_eq!(parse_key("60"), Some(60));
        assert_eq!(parse_key("cs4"), Some(61));
        assert_eq!(parse_key("c#4"), Some(61));
        assert_eq!(parse_key("db4"), Some(61));
        assert_eq!(parse_key("a4"), Some(69));
        assert_eq!(parse_key("c-1"), Some(0));
        assert_eq!(parse_key("g9"), Some(127));
        assert_eq!(parse_key("x"), None);
    }

    #[test]
    fn opcode_parse() {
        let ops = parse_opcodes("sample=piano C4.wav lokey=60 hikey=72 volume=-3.5");
        let map: HashMap<_, _> = ops.into_iter().collect();
        assert_eq!(map.get("sample").unwrap(), "piano C4.wav");
        assert_eq!(map.get("lokey").unwrap(), "60");
        assert_eq!(map.get("hikey").unwrap(), "72");
        assert_eq!(map.get("volume").unwrap(), "-3.5");
    }
}
