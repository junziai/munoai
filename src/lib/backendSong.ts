//! Frontend IPC layer for Rust commands in `commands/song.rs`.
//!
//! Thin typed wrappers — params & return types mirror the Rust `Serialize` structs.
//! Every command name here must stay byte-identical to `lib.rs` `generate_handler!`.

import { invoke } from "@tauri-apps/api/core";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SongModelFile {
  filename: string;
  size: number;
}

export interface SongServiceProbe {
  ok: boolean;
  status: number;
  message: string;
}

export interface SongOutput {
  label: string;
  audio_path?: string;
  midi_path?: string;
  lrc_path?: string;
}

export interface SongGenRequest {
  model?: string;
  song_name?: string;
  lyrics?: string;
  prompt?: string;
  negative_prompt?: string;
  cot?: string;
  cfg_scale?: number;
  num_inference_steps?: number;
  seed?: number;
  audio_duration?: number;
  guidance_scale?: number;
  shift?: number;
  bpm?: number;
  key_scale?: string;
  time_signature?: string;
  language?: string;
  vocal_gender?: string;
  vocal_type?: string;
  vocal_range?: string;
  checkpoint?: string;
  want_stems?: boolean;
  want_midi?: boolean;
  want_lrc?: boolean;
  format?: string;
  service_url: string;
  output_dir?: string;
}

// ── Model directory / list / download / delete ──────────────────────────────

export function getSongModelsDir(): Promise<string> {
  return invoke<string>("get_song_models_dir");
}

export function listSongModels(): Promise<SongModelFile[]> {
  return invoke<SongModelFile[]>("list_song_models");
}

export function downloadSongModel(
  urls: string[],
  id: string,
  filename: string,
  sha256?: string,
): Promise<string> {
  return invoke<string>("download_song_model", { urls, id, filename, sha256 });
}

export function deleteSongModel(filename: string): Promise<void> {
  return invoke("delete_song_model", { filename });
}

// ── History persistence ────────────────────────────────────────────────────

export function loadSongHistory(): Promise<string> {
  return invoke<string>("load_song_history");
}

export function saveSongHistory(entries: unknown): Promise<void> {
  return invoke("save_song_history", { entries });
}

// ── External inference service ──────────────────────────────────────────────

export function songServiceProbe(url: string): Promise<SongServiceProbe> {
  return invoke<SongServiceProbe>("song_service_probe", { url });
}

export function songGenerate(req: SongGenRequest): Promise<SongOutput[]> {
  return invoke<SongOutput[]>("song_generate", { req });
}

// ── ABC → MIDI ─────────────────────────────────────────────────────────────

export function abcToMidi(abc: string, outPath: string): Promise<string> {
  return invoke<string>("abc_to_midi", { abc, outPath });
}
