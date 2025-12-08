/**
 * Transcription history storage using Raycast LocalStorage API
 */

import { LocalStorage } from "@raycast/api";

export interface TranscriptionHistoryItem {
  id: string;
  text: string;
  language: string;
  duration: number;
  transcriptionTime: number;
  model: string;
  device: string;
  timestamp: number;
  originalText?: string;
}

const HISTORY_KEY = "transcription-history";
const DEFAULT_MAX_SIZE = 50;

/**
 * Save a transcription to history
 */
export async function saveTranscription(item: TranscriptionHistoryItem): Promise<void> {
  const history = await getHistory();
  const updated = [item, ...history].slice(0, DEFAULT_MAX_SIZE);
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
}

/**
 * Get transcription history
 */
export async function getHistory(limit?: number): Promise<TranscriptionHistoryItem[]> {
  const stored = await LocalStorage.getItem<string>(HISTORY_KEY);
  if (!stored) return [];
  const history = JSON.parse(stored) as TranscriptionHistoryItem[];
  return limit ? history.slice(0, limit) : history;
}

/**
 * Delete a specific transcription by ID
 */
export async function deleteTranscription(id: string): Promise<void> {
  const history = await getHistory();
  const updated = history.filter((item) => item.id !== id);
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
}

/**
 * Clear all transcription history
 */
export async function clearHistory(): Promise<void> {
  await LocalStorage.removeItem(HISTORY_KEY);
}

/**
 * Get the count of items in history
 */
export async function getHistoryCount(): Promise<number> {
  const history = await getHistory();
  return history.length;
}

/**
 * Get a specific transcription by ID
 */
export async function getTranscriptionById(id: string): Promise<TranscriptionHistoryItem | null> {
  const history = await getHistory();
  return history.find((item) => item.id === id) || null;
}

