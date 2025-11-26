import { Action, ActionPanel, Detail, Icon, Clipboard, showToast, Toast, openExtensionPreferences, Keyboard } from "@raycast/api";
import { useEffect, useState, useRef } from "react";
import { startBackendRecording, stopRecordingAndTranscribe } from "./transcription-client";
import { ensureServerRunning, getServerStatus, restartServer, ServerStatus } from "./server-manager";
import { AUTO_START, WHISPER_MODEL, COMPUTE_DEVICE } from "./config";

enum State {
  IDLE = "idle",
  CHECKING = "checking",
  STARTING = "starting",
  RECORDING = "recording",
  PROCESSING = "processing",
  DONE = "done",
  ERROR = "error",
}

export default function Command() {
  const pasteShortcut: Keyboard.Shortcut = { modifiers: ["shift"], key: "enter" };

  const [state, setState] = useState<State>(State.IDLE);
  const [transcription, setTranscription] = useState("");
  const [error, setError] = useState("");
  const [language, setLanguage] = useState("");
  const [duration, setDuration] = useState(0);
  const [serverInfo, setServerInfo] = useState<ServerStatus | null>(null);
  const hasStarted = useRef(false);

  // Initialize on mount
  useEffect(() => {
    if (!hasStarted.current) {
      hasStarted.current = true;
      if (AUTO_START) {
        checkAndRecord();
      } else {
        checkServer();
      }
    }
  }, []);

  const checkServer = async () => {
    setState(State.CHECKING);
    const status = await getServerStatus();
    setServerInfo(status);
    setState(State.IDLE);
  };

  const checkAndRecord = async () => {
    setState(State.CHECKING);
    await startRecording();
  };

  const startRecording = async () => {
    try {
      setState(State.STARTING);
      await ensureServerRunning();

      const status = await getServerStatus();
      setServerInfo(status);

      setState(State.RECORDING);
      await startBackendRecording();

      await showToast({ style: Toast.Style.Success, title: "Recording", message: "Speak now..." });
    } catch (err) {
      console.error("Failed to start:", err);
      setState(State.ERROR);
      setError(err instanceof Error ? err.message : String(err));
      await showToast({ style: Toast.Style.Failure, title: "Failed", message: String(err) });
    }
  };

  const stopRecording = async () => {
    try {
      setState(State.PROCESSING);
      await showToast({ style: Toast.Style.Animated, title: "Transcribing..." });

      const result = await stopRecordingAndTranscribe();

      setTranscription(result.text);
      setLanguage(result.language);
      setDuration(result.duration);
      setState(State.DONE);

      await showToast({ style: Toast.Style.Success, title: "Done" });
    } catch (err) {
      console.error("Transcription failed:", err);
      setState(State.ERROR);
      setError(err instanceof Error ? err.message : String(err));
      await showToast({ style: Toast.Style.Failure, title: "Failed", message: String(err) });
    }
  };

  const handleRestart = async () => {
    try {
      setState(State.STARTING);
      await showToast({ style: Toast.Style.Animated, title: "Restarting server..." });
      await restartServer();
      const status = await getServerStatus();
      setServerInfo(status);
      setState(State.IDLE);
      await showToast({ style: Toast.Style.Success, title: "Server restarted" });
    } catch (err) {
      setState(State.ERROR);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const reset = () => {
    setState(State.IDLE);
    setTranscription("");
    setError("");
    setLanguage("");
    setDuration(0);
  };

  const copy = async () => {
    await Clipboard.copy(transcription);
    await showToast({ style: Toast.Style.Success, title: "Copied" });
  };

  const paste = async () => {
    await Clipboard.paste(transcription);
    await showToast({ style: Toast.Style.Success, title: "Pasted" });
  };

  // Clean, minimal markdown
  const getMarkdown = (): string => {
    const configLine = `\`${WHISPER_MODEL}\` · \`${serverInfo?.device || COMPUTE_DEVICE}\``;

    switch (state) {
      case State.CHECKING:
        return `## Checking server...\n\n${configLine}`;

      case State.STARTING:
        return `## Starting server...\n\nThis may take a moment on first run.\n\n${configLine}`;

      case State.IDLE:
        return `## Ready\n\nPress **Enter** to start recording.\n\n${configLine}`;

      case State.RECORDING:
        return `## 🔴 Recording\n\nSpeak now. Press **Enter** when done.`;

      case State.PROCESSING:
        return `## Processing...\n\nTranscribing audio...`;

      case State.DONE:
        return `${transcription}\n\n---\n\n\`${language}\` · \`${duration.toFixed(1)}s\`\n\n**Copy** (Enter) · **Paste** (⇧ Enter)`;

      case State.ERROR:
        return `## Error\n\n${error}\n\n---\n\nCheck server and try again.`;

      default:
        return "";
    }
  };

  const getActions = () => {
    const configMismatch = serverInfo?.configMismatch;

    switch (state) {
      case State.IDLE:
        return (
          <ActionPanel>
            <Action title="Start Recording" icon={Icon.Microphone} onAction={startRecording} />
            {configMismatch && (
              <Action title="Restart Server (Config Changed)" icon={Icon.ArrowClockwise} onAction={handleRestart} />
            )}
            <Action title="Open Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
          </ActionPanel>
        );

      case State.RECORDING:
        return (
          <ActionPanel>
            <Action title="Stop & Transcribe" icon={Icon.Stop} onAction={stopRecording} />
            <Action title="Cancel" icon={Icon.XMarkCircle} onAction={reset} />
          </ActionPanel>
        );

      case State.DONE:
        return (
          <ActionPanel>
            <Action title="Copy" icon={Icon.Clipboard} onAction={copy} />
            <Action title="Paste" icon={Icon.Text} onAction={paste} shortcut={pasteShortcut} />
            <Action title="New Recording" icon={Icon.Microphone} onAction={reset} shortcut={{ modifiers: ["cmd"], key: "n" }} />
            <Action title="Open Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
          </ActionPanel>
        );

      case State.ERROR:
        return (
          <ActionPanel>
            <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={reset} />
            <Action title="Restart Server" icon={Icon.RotateClockwise} onAction={handleRestart} />
            <Action title="Open Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
          </ActionPanel>
        );

      default:
        return <ActionPanel />;
    }
  };

  return <Detail markdown={getMarkdown()} actions={getActions()} />;
}
