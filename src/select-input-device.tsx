import { Action, ActionPanel, Icon, List, Toast, showToast, popToRoot } from "@raycast/api";
import { useEffect, useState } from "react";
import {
  InputDevice,
  fetchInputDevices,
  savePreferredInputDevice,
  SYSTEM_DEFAULT_LABEL,
  formatDeviceLabel,
} from "./input-device";

export default function Command() {
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadDevices = async () => {
    setIsLoading(true);
    try {
      const list = await fetchInputDevices();
      setDevices(list);
    } catch (error) {
      console.error("Failed to load input devices", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to list devices",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadDevices();
  }, []);

  const handleSelect = async (device: InputDevice | null) => {
    await savePreferredInputDevice(
      device
        ? {
            deviceId: device.id,
            deviceName: device.name,
            label: formatDeviceLabel(device),
          }
        : {
            deviceId: null,
            deviceName: null,
            label: SYSTEM_DEFAULT_LABEL,
          }
    );

    await showToast({
      style: Toast.Style.Success,
      title: "Transcription input set",
      message: device ? device.name : "System default input",
    });
    await popToRoot({ clearSearchBar: true });
  };

  const listItems = [
    <List.Item
      key="system-default"
      title={SYSTEM_DEFAULT_LABEL}
      icon={Icon.Desktop}
      accessories={[{ text: "Default" }]}
      actions={
        <ActionPanel>
          <Action title="Use System Default" icon={Icon.Check} onAction={() => handleSelect(null)} />
          <Action title="Refresh Devices" icon={Icon.RotateClockwise} onAction={loadDevices} />
        </ActionPanel>
      }
    />,
    ...devices.map((device) => (
      <List.Item
        key={device.id}
        title={device.name}
        subtitle={device.hostapi}
        accessories={[
          device.is_default_input ? { tag: "Default" } : undefined,
          { text: `${device.default_samplerate} Hz` },
        ].filter(Boolean)}
        actions={
          <ActionPanel>
            <Action title="Use This Input" icon={Icon.Microphone} onAction={() => handleSelect(device)} />
            <Action title="Refresh Devices" icon={Icon.RotateClockwise} onAction={loadDevices} />
          </ActionPanel>
        }
      />
    )),
  ];

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Select transcription input device">
      {listItems}
    </List>
  );
}


