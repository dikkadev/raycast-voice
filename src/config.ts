/**
 * Configuration for the voice transcription extension
 * All settings are managed via Raycast preferences
 */

import { getPreferenceValues } from "@raycast/api";
import { statSync } from "fs";
import * as path from "path";

// Preferences interface matching package.json
export interface TranscribePreferences {
  backendDirectory: string;
  serverPort?: string;
  autoStart?: boolean;
  whisperModel?: string;
  computeDevice?: string;
  returnToRoot?: boolean;
  audioLevelPollingRate?: string;
  autoAction?: string;
  saveToHistory?: boolean;
}

/**
 * Get all preferences with defaults
 */
export function getConfig(): TranscribePreferences {
  const prefs = getPreferenceValues<TranscribePreferences>();
  return {
    backendDirectory: prefs.backendDirectory,
    serverPort: prefs.serverPort || "51234",
    autoStart: prefs.autoStart ?? true,
    whisperModel: prefs.whisperModel || "base",
    computeDevice: prefs.computeDevice || "cuda",
    returnToRoot: prefs.returnToRoot ?? false,
    audioLevelPollingRate: prefs.audioLevelPollingRate || "150",
    autoAction: prefs.autoAction || "none",
  };
}

// Cached config for module exports
const config = getConfig();

// Backend directory from preferences
export const BACKEND_DIR = config.backendDirectory;

// Backend/server build identifier (must stay in sync with Python backend)
export const SERVER_BUILD_ID = "2025-11-29-cancel-endpoint";

// Server configuration
export const SERVER_HOST = "127.0.0.1";
export const SERVER_PORT = parsePort(config.serverPort);
export const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;

// Model and device settings
export const WHISPER_MODEL = config.whisperModel || "base";
export const COMPUTE_DEVICE = config.computeDevice || "cuda";

// Auto-start preference
export const AUTO_START = config.autoStart ?? true;

// Return to root preference
export const RETURN_TO_ROOT = config.returnToRoot ?? false;

// Auto-action preference (function to read dynamically)
export function getAutoAction(): string {
  const cfg = getConfig();
  return cfg.autoAction || "none";
}

// Save to history preference
export function getSaveToHistory(): boolean {
  const cfg = getConfig();
  return cfg.saveToHistory ?? true;
}

// Audio level polling rate (in milliseconds, 0 = disabled)
export function getAudioLevelPollingRate(): number {
  const rateStr = config.audioLevelPollingRate || "100";
  const rate = parseInt(rateStr, 10);
  if (!Number.isFinite(rate) || rate < 0) {
    return 0; // Disabled
  }
  // Clamp between 25ms and 250ms, or 0 to disable
  if (rate === 0) {
    return 0; // Disabled
  }
  return Math.max(25, Math.min(250, rate));
}

/**
 * Parse port with fallback
 */
function parsePort(port?: string): number {
  const parsed = port ? Number(port) : 51234;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 51234;
}

/**
 * Server configuration object for passing to backend
 */
export interface ServerConfig {
  model: string;
  device: string;
  computeType: string;
  port: number;
}

/**
 * Get server config object
 */
export function getServerConfig(): ServerConfig {
  const cfg = getConfig();
  const device = cfg.computeDevice || "cuda";
  return {
    model: cfg.whisperModel || "base",
    device: device,
    computeType: device === "cuda" ? "float16" : "int8",
    port: parsePort(cfg.serverPort),
  };
}

/**
 * Generate a config fingerprint to detect changes
 */
export function getConfigFingerprint(): string {
  const cfg = getConfig();
  const backendSignature = getBackendCodeSignature(cfg.backendDirectory);
  return `${cfg.whisperModel}|${cfg.computeDevice}|${cfg.serverPort}|${backendSignature}`;
}

function getBackendCodeSignature(dir?: string): string {
  if (!dir) {
    return "no-backend-dir";
  }

  try {
    const serverPath = path.join(dir, "transcription_server.py");
    const stats = statSync(serverPath);
    return `${stats.mtimeMs}-${stats.size}`;
  } catch {
    return "backend-missing";
  }
}
