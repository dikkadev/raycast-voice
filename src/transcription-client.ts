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
    } catch (error) {
        return false;
    }
}
