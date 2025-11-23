/**
 * Configuration for the voice transcription extension
 * This file contains the absolute path to the backend directory
 */

import path from "path";
import { getPreferenceValues } from "@raycast/api";

// Preferences typed from Raycast manifest (see https://developers.raycast.com/api-reference/preferences)
const preferences = getPreferenceValues<Preferences.Transcribe>();

// Backend directory is configured via Raycast preferences (directory picker)
export const BACKEND_DIR = preferences.backendDirectory;

// Server configuration
export const SERVER_HOST = "127.0.0.1";
// Prefer a configured port, but fall back to 51234
const preferredPort = preferences.serverPort && preferences.serverPort.trim().length > 0 ? Number(preferences.serverPort) : 51234;
export const SERVER_PORT = Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : 51234;
export const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
