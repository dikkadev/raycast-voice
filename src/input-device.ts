import axios from "axios";
import { LocalStorage } from "@raycast/api";
import { SERVER_URL } from "./config";

export interface InputDevice {
  id: number;
  name: string;
  hostapi: string;
  max_input_channels: number;
  default_samplerate: number;
  is_default_input: boolean;
}

export interface InputDeviceSelection {
  deviceId: number | null;
  deviceName: string | null;
  label?: string;
}

export interface StartRecordingDeviceInfo {
  id: number | null;
  name: string;
  hostapi?: string;
  source?: string;
  fallback_used?: boolean;
  fallback_reason?: string | null;
  requested?: {
    id: number | null;
    name: string | null;
  };
}

const STORAGE_KEY = "preferred_input_device";
export const SYSTEM_DEFAULT_LABEL = "System default input";

export async function fetchInputDevices(): Promise<InputDevice[]> {
  const url = `${SERVER_URL}/audio/devices`;
  const response = await axios.get(url, { timeout: 3000 });
  return (response.data?.devices as InputDevice[]) || [];
}

export async function savePreferredInputDevice(selection: InputDeviceSelection | null): Promise<void> {
  if (!selection) {
    await LocalStorage.removeItem(STORAGE_KEY);
    return;
  }
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
}

export async function getPreferredInputDevice(): Promise<InputDeviceSelection | null> {
  const raw = await LocalStorage.getItem<string>(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as InputDeviceSelection;
  } catch {
    return null;
  }
}

export function formatDeviceLabel(device: InputDevice | null | undefined): string {
  if (!device) return SYSTEM_DEFAULT_LABEL;
  const defaultTag = device.is_default_input ? " · default" : "";
  return `${device.name} (${device.hostapi}${defaultTag})`;
}

export function formatSelectionLabel(selection: InputDeviceSelection | null): string {
  if (!selection) return SYSTEM_DEFAULT_LABEL;
  return selection.label || selection.deviceName || SYSTEM_DEFAULT_LABEL;
}


