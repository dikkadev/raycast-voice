/**
 * Transcription Client
 * Communicates with the Python backend for audio transcription
 */

import axios from "axios";
import { SERVER_URL } from "./config";

export interface TranscriptionResult {
  text: string;
  language: string;
  language_probability: number;
  duration: number;
}

export interface LivePreviewResult {
  text: string;
  error?: string;
}

export interface ServerConfig {
  model: string;
  device: string;
  compute_type: string;
  host: string;
  port: number;
}

export class CancelEndpointUnavailableError extends Error {
  constructor() {
    super("cancel_endpoint_unavailable");
    this.name = "CancelEndpointUnavailableError";
  }
}

/**
 * Start backend microphone recording
 */
export async function startBackendRecording(): Promise<void> {
  const url = `${SERVER_URL}/record/start`;
  try {
    const response = await axios.post(url, null, { timeout: 5000 });
    if (response.status !== 200) {
      throw new Error(`Unexpected status code: ${response.status}`);
    }
  } catch (error) {
    console.error("Failed to start backend recording:", error);
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.detail || error.message;
      if (error.response?.status === 400 && message === "Recording already in progress") {
        // Treat as success – recording is already running
        console.warn("Recording already in progress, continuing.");
        return;
      }
      throw new Error(`Failed to start recording: ${message}`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Stop backend recording and transcribe
 */
export async function stopRecordingAndTranscribe(): Promise<TranscriptionResult> {
  const url = `${SERVER_URL}/record/stop`;
  try {
    const response = await axios.post(url, null, { timeout: 600000 });
    console.log("Transcription successful:", response.data);
    return response.data as TranscriptionResult;
  } catch (error) {
    console.error("Transcription failed:", error);
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.detail || error.message;
      throw new Error(`Transcription failed: ${message}`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Check server health
 */
export async function checkHealth(): Promise<boolean> {
  const healthUrl = `${SERVER_URL}/health`;
  try {
    const response = await axios.get(healthUrl, { timeout: 2000 });
    return response.status === 200 && response.data.status === "healthy";
  } catch {
    return false;
  }
}

/**
 * Get current server configuration
 */
export async function getServerConfig(): Promise<ServerConfig | null> {
  const url = `${SERVER_URL}/config`;
  try {
    const response = await axios.get(url, { timeout: 2000 });
    return response.data as ServerConfig;
  } catch {
    return null;
  }
}

/**
 * Get current audio level (0.0 to 1.0)
 */
export async function getAudioLevel(): Promise<number> {
  const url = `${SERVER_URL}/record/level`;
  try {
    const response = await axios.get(url, { timeout: 1000 });
    return (response.data as { level: number }).level;
  } catch (error) {
    // If recording isn't active or endpoint fails, return 0
    return 0.0;
  }
}

/**
 * Cancel backend recording without transcribing
 */
export async function cancelBackendRecording(): Promise<void> {
  const url = `${SERVER_URL}/record/cancel`;
  try {
    await axios.post(url, null, { timeout: 5000 });
  } catch (error) {
    console.error("Failed to cancel backend recording:", error);
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.detail || error.message;
      if (error.response?.status === 404) {
        throw new CancelEndpointUnavailableError();
      }
      throw new Error(`Failed to cancel recording: ${message}`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Get the live transcription preview
 */
export async function getLivePreview(): Promise<LivePreviewResult | null> {
  const url = `${SERVER_URL}/record/preview`;
  try {
    const response = await axios.post(url, null, { timeout: 10000 });
    return response.data as LivePreviewResult;
  } catch (error) {
    console.error("Live preview request failed:", error);
    return null;
  }
}