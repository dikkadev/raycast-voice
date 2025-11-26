/**
 * Configuration for the voice transcription extension
 * All settings are managed via Raycast preferences
 */

import { getPreferenceValues } from "@raycast/api";

// Preferences interface matching package.json
export interface TranscribePreferences {
  backendDirectory: string;
  serverPort?: string;
  autoStart?: boolean;
  whisperModel?: string;
  computeDevice?: string;
  returnToRoot?: boolean;
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
  };
}

// Cached config for module exports
const config = getConfig();

// Backend directory from preferences
export const BACKEND_DIR = config.backendDirectory;

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
  return `${cfg.whisperModel}|${cfg.computeDevice}|${cfg.serverPort}`;
}
