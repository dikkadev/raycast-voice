import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  Clipboard,
  showToast,
  Toast,
  openExtensionPreferences,
  Keyboard,
  popToRoot,
  Form,
  useNavigation,
} from "@raycast/api";
import { useEffect, useState, useRef } from "react";
import {
  startBackendRecording,
  stopRecordingAndTranscribe,
  getAudioLevel,
  cancelBackendRecording,
  CancelEndpointUnavailableError,
} from "./transcription-client";
import { ensureServerRunning, getServerStatus, restartServer, ServerStatus } from "./server-manager";
import { AUTO_START, WHISPER_MODEL, COMPUTE_DEVICE, RETURN_TO_ROOT, getAudioLevelPollingRate } from "./config";

enum State {
  IDLE = "idle",
  CHECKING = "checking",
  STARTING = "starting",
  RECORDING = "recording",
  PROCESSING = "processing",
  DONE = "done",
  ERROR = "error",
}

const formatElapsed = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60)
    .toString()
    .padStart(2, "0");
  const secs = (safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${secs}`;
};

export default function Command() {
  const copyShortcut: Keyboard.Shortcut = { modifiers: ["ctrl"], key: "c" };

  const [state, setState] = useState<State>(State.IDLE);
  const [transcription, setTranscription] = useState("");
  const [error, setError] = useState("");
  const [language, setLanguage] = useState("");
  const [duration, setDuration] = useState(0);
  const [serverInfo, setServerInfo] = useState<ServerStatus | null>(null);
  const [recordingStart, setRecordingStart] = useState<number | null>(null);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0.0);
  const [maxAudioLevel, setMaxAudioLevel] = useState(0.0);
  const hasStarted = useRef(false);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const audioLevelPollingRef = useRef<NodeJS.Timeout | null>(null);
  const activeStateRef = useRef<State>(State.IDLE);

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

  useEffect(() => {
    if (state === State.RECORDING && recordingStart) {
      recordingTimerRef.current = setInterval(() => {
        setRecordingElapsed((Date.now() - recordingStart) / 1000);
      }, 200);
    } else if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    };
  }, [state, recordingStart]);

  // Audio level polling
  useEffect(() => {
    const pollingRate = getAudioLevelPollingRate();
    
    if (state === State.RECORDING && pollingRate > 0) {
      const pollAudioLevel = async () => {
        try {
          const rawLevel = await getAudioLevel();
          setAudioLevel(rawLevel);
          // Track maximum level seen for adaptive normalization
          if (rawLevel > maxAudioLevel) {
            setMaxAudioLevel(rawLevel);
          }
        } catch (error) {
          // Silently fail - audio level is optional
          setAudioLevel(0.0);
        }
      };
      
      // Poll immediately, then at interval
      pollAudioLevel();
      audioLevelPollingRef.current = setInterval(pollAudioLevel, pollingRate);
    } else {
      setAudioLevel(0.0);
      if (audioLevelPollingRef.current) {
        clearInterval(audioLevelPollingRef.current);
        audioLevelPollingRef.current = null;
      }
    }

    return () => {
      if (audioLevelPollingRef.current) {
        clearInterval(audioLevelPollingRef.current);
        audioLevelPollingRef.current = null;
      }
    };
  }, [state, maxAudioLevel]);

  useEffect(() => {
    activeStateRef.current = state;
  }, [state]);

  useEffect(() => {
    return () => {
      if (activeStateRef.current === State.RECORDING) {
        cancelBackendRecording()
          .catch((err) => {
            if (err instanceof CancelEndpointUnavailableError) {
              restartServer().catch((restartErr) => {
                console.error("Failed to restart server during cleanup:", restartErr);
              });
            } else {
              console.error("Failed to cancel recording during cleanup:", err);
            }
          })
          .finally(() => {
            activeStateRef.current = State.IDLE;
          });
      }
    };
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

      try {
        await cancelBackendRecording();
      } catch (cleanupErr) {
        if (cleanupErr instanceof CancelEndpointUnavailableError) {
          // Backend will be restarted in ensureServerRunning due to build mismatch,
          // but log just in case.
          console.warn("Cancel endpoint unavailable during start cleanup.");
        } else {
          console.warn("Failed to clear previous recording state:", cleanupErr);
        }
      }

      setState(State.RECORDING);
      setRecordingStart(Date.now());
      setRecordingElapsed(0);
      await startBackendRecording();

      await showToast({ style: Toast.Style.Success, title: "Recording", message: "Speak now..." });
    } catch (err) {
      console.error("Failed to start:", err);
      setState(State.ERROR);
      setError(err instanceof Error ? err.message : String(err));
      setRecordingStart(null);
      setRecordingElapsed(0);
      await showToast({ style: Toast.Style.Failure, title: "Failed", message: String(err) });
    }
  };

  const stopRecording = async () => {
    try {
      setState(State.PROCESSING);
      setRecordingStart(null);
      setRecordingElapsed(0);
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
    setRecordingStart(null);
    setRecordingElapsed(0);
    setAudioLevel(0.0);
    setMaxAudioLevel(0.0);
  };

  const cancelRecording = async () => {
    try {
      await showToast({ style: Toast.Style.Animated, title: "Cancelling recording..." });
      await cancelBackendRecording();
      reset();
      await showToast({ style: Toast.Style.Success, title: "Recording cancelled" });
    } catch (err) {
      console.error("Failed to cancel recording:", err);
      if (err instanceof CancelEndpointUnavailableError) {
        await showToast({
          style: Toast.Style.Animated,
          title: "Updating backend...",
          message: "Restarting server to enable cancel support",
        });
        await restartServer();
        reset();
        await showToast({
          style: Toast.Style.Success,
          title: "Server updated",
          message: "Cancel recording again if needed",
        });
        return;
      }

      setState(State.ERROR);
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      await showToast({ style: Toast.Style.Failure, title: "Cancel failed", message });
    }
  };

  const maybeReturnToRoot = async () => {
    if (RETURN_TO_ROOT) {
      await popToRoot({ clearSearchBar: true });
    }
  };

  const copy = async () => {
    await Clipboard.copy(transcription);
    await showToast({ style: Toast.Style.Success, title: "Copied" });
    await maybeReturnToRoot();
  };

  const paste = async () => {
    await Clipboard.paste(transcription);
    await showToast({ style: Toast.Style.Success, title: "Pasted" });
    await maybeReturnToRoot();
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
        const pollingRate = getAudioLevelPollingRate();
        
        // Normalize audio level for display - adaptive based on observed values
        // Use adaptive normalization: scale based on max seen, but also have a reasonable default
        // If max is very small (like 0.01-0.02), scale it up to be useful
        // If max is larger, use it as the reference
        const referenceLevel = Math.max(maxAudioLevel, 0.02); // Use at least 0.02 as reference
        const normalizedLevel = Math.min(1.0, audioLevel / referenceLevel);
        const barLength = Math.floor(normalizedLevel * 20);
        
        const debugInfo = pollingRate > 0 
          ? `\n\n---\n\n### Audio Level Debug\n\n\`\`\`\nPolling Rate: ${pollingRate}ms\nRaw Level: ${audioLevel.toFixed(6)}\nMax Seen: ${maxAudioLevel.toFixed(6)}\nReference: ${referenceLevel.toFixed(6)}\nNormalized: ${normalizedLevel.toFixed(3)}\nBar Length: ${barLength}/20\n\`\`\`\n\n📊 Visual: ${"█".repeat(barLength)}${"░".repeat(20 - barLength)}`
          : `\n\n---\n\n### Audio Level Debug\n\n\`\`\`\nPolling Rate: DISABLED (0)\nRaw Level: ${audioLevel.toFixed(6)}\nMax Seen: ${maxAudioLevel.toFixed(6)}\n\`\`\``;
        return `## 🔴 Recording\n\nSpeak now. Press **Enter** when done.${
          recordingStart !== null ? `\n\n⏱ ${formatElapsed(recordingElapsed)}` : ""
        }${debugInfo}`;

      case State.PROCESSING:
        return `## Processing...\n\nTranscribing audio...`;

      case State.DONE:
        return `${transcription}\n\n---\n\n\`${language}\` · \`${duration.toFixed(1)}s\`\n\n**Paste** (Enter) · **Copy** (⌃ C)`;

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
            <Action title="Cancel" icon={Icon.XMarkCircle} onAction={cancelRecording} />
          </ActionPanel>
        );

      case State.DONE:
        return (
          <ActionPanel>
            <Action title="Paste" icon={Icon.Text} onAction={paste} />
            <Action title="Copy" icon={Icon.Clipboard} onAction={copy} shortcut={copyShortcut} />
            <Action.Push
              title="Edit Transcription"
              icon={Icon.Pencil}
              shortcut={{ modifiers: ["ctrl"], key: "e" }}
              target={<EditTranscriptionForm initialText={transcription} onSave={setTranscription} />}
            />
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

type EditTranscriptionFormProps = {
  initialText: string;
  onSave: (value: string) => void;
};

function EditTranscriptionForm({ initialText, onSave }: EditTranscriptionFormProps) {
  const { pop } = useNavigation();

  const handleSubmit = async (values: { transcription?: string }) => {
    const updated = values.transcription ?? "";
    onSave(updated);
    await showToast({ style: Toast.Style.Success, title: "Transcription updated" });
    pop();
  };

  return (
    <Form
      navigationTitle="Edit Transcription"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Changes" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextArea id="transcription" title="Transcription" defaultValue={initialText} autoFocus />
    </Form>
  );
}
