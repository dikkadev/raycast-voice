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
import { useEffect, useState, useRef, useMemo } from "react";
import {
  startBackendRecording,
  stopRecordingAndTranscribe,
  getAudioLevel,
  cancelBackendRecording,
  CancelEndpointUnavailableError,
} from "./transcription-client";
import { ensureServerRunning, getServerStatus, restartServer, ServerStatus } from "./server-manager";
import { AUTO_START, WHISPER_MODEL, COMPUTE_DEVICE, RETURN_TO_ROOT, getAudioLevelPollingRate, getAutoAction } from "./config";

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

// Waveform rendering with Unicode block characters
const WAVEFORM_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const WAVEFORM_BUFFER_SIZE = 18;

const renderWaveform = (levels: number[]): string => {
  // Pad with zeros if we don't have enough samples yet
  const paddedLevels = [...levels];
  while (paddedLevels.length < WAVEFORM_BUFFER_SIZE) {
    paddedLevels.unshift(0.0);
  }
  
  // Take only the last WAVEFORM_BUFFER_SIZE samples
  const samples = paddedLevels.slice(-WAVEFORM_BUFFER_SIZE);

  if (samples.length === 0 || samples.every((s) => s === 0)) {
    return "▁".repeat(WAVEFORM_BUFFER_SIZE);
  }

  // Find max level for normalization (use adaptive scaling)
  const maxLevel = Math.max(...samples);
  const referenceLevel = Math.max(maxLevel, 0.02); // Use at least 0.02 as reference

  // Normalize and map to Unicode blocks
  const waveform = samples.map((level) => {
    const normalized = Math.min(1.0, Math.max(0.0, level / referenceLevel));
    const charIndex = Math.floor(normalized * (WAVEFORM_CHARS.length - 1));
    return WAVEFORM_CHARS[charIndex];
  });

  return waveform.join("");
};

// Animated dots for loading states
const getAnimatedDots = (tick: number, speedDivisor: number = 1): string => {
  const dots = ["", ".", "..", "..."];
  return dots[Math.floor(tick / speedDivisor) % dots.length];
};

// Personality phrases based on recording duration
const getRecordingPhrase = (elapsed: number): string => {
  if (elapsed < 5) return "Listening...";
  if (elapsed < 15) return "Still listening...";
  if (elapsed < 30) return "Go on...";
  if (elapsed < 60) return "Keep going...";
  return "Still here...";
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
  const [audioLevelHistory, setAudioLevelHistory] = useState<number[]>([]);
  const [animationTick, setAnimationTick] = useState(0);
  const [transcriptionStartTime, setTranscriptionStartTime] = useState<number | null>(null);
  const [transcriptionDuration, setTranscriptionDuration] = useState(0);
  const [processingElapsed, setProcessingElapsed] = useState(0);
  const [skipAutoAction, setSkipAutoAction] = useState(false);
  
  // Memoize auto-action to prevent re-renders
  const autoAction = useMemo(() => getAutoAction(), []);
  
  const hasStarted = useRef(false);
  const autoActionExecutedRef = useRef(false);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const audioLevelPollingRef = useRef<NodeJS.Timeout | null>(null);
  const processingTimerRef = useRef<NodeJS.Timeout | null>(null);
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

  // Processing timer
  useEffect(() => {
    if (state === State.PROCESSING && transcriptionStartTime) {
      processingTimerRef.current = setInterval(() => {
        setProcessingElapsed((Date.now() - transcriptionStartTime) / 1000);
      }, 100);
    } else if (processingTimerRef.current) {
      clearInterval(processingTimerRef.current);
      processingTimerRef.current = null;
    }

    return () => {
      if (processingTimerRef.current) {
        clearInterval(processingTimerRef.current);
        processingTimerRef.current = null;
      }
    };
  }, [state, transcriptionStartTime]);

  // Audio level polling with rolling buffer
  useEffect(() => {
    const pollingRate = getAudioLevelPollingRate();
    
    if (state === State.RECORDING && pollingRate > 0) {
      const pollAudioLevel = async () => {
        try {
          const rawLevel = await getAudioLevel();
          setAudioLevel(rawLevel);
          
          // Track maximum level seen for adaptive normalization
          setMaxAudioLevel((prevMax) => Math.max(prevMax, rawLevel));
          
          // Update rolling buffer for waveform
          setAudioLevelHistory((prev) => {
            const updated = [...prev, rawLevel];
            // Keep only last WAVEFORM_BUFFER_SIZE samples
            return updated.slice(-WAVEFORM_BUFFER_SIZE);
          });
        } catch (error) {
          // Silently fail - audio level is optional
          setAudioLevel(0.0);
          setAudioLevelHistory((prev) => {
            const updated = [...prev, 0.0];
            return updated.slice(-WAVEFORM_BUFFER_SIZE);
          });
        }
      };
      
      // Poll immediately, then at interval
      pollAudioLevel();
      audioLevelPollingRef.current = setInterval(pollAudioLevel, pollingRate);
    } else {
      setAudioLevel(0.0);
      setAudioLevelHistory([]);
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
  }, [state]);

  useEffect(() => {
    activeStateRef.current = state;
  }, [state]);

  // Animation tick for loading states
  useEffect(() => {
    if (state === State.CHECKING || state === State.STARTING || state === State.PROCESSING) {
      // Fast animation for processing (full clock revolution per second: 12 emojis / 1s = ~83ms)
      const intervalMs = state === State.PROCESSING ? 80 : 500;
      const interval = setInterval(() => {
        setAnimationTick((prev) => prev + 1);
      }, intervalMs);
      return () => clearInterval(interval);
    } else {
      setAnimationTick(0);
    }
  }, [state]);

  // Auto-action effect: execute when transcription completes
  useEffect(() => {
    if (state === State.DONE && transcription && !skipAutoAction && autoAction !== "none" && !autoActionExecutedRef.current) {
      autoActionExecutedRef.current = true;
      const executeAutoAction = async () => {
        try {
          if (autoAction === "paste") {
            await paste();
          } else if (autoAction === "copy") {
            await copy();
          }
          // Reset skip flag after execution
          setSkipAutoAction(false);
        } catch (err) {
          console.error("Auto-action failed:", err);
          await showToast({ 
            style: Toast.Style.Failure, 
            title: "Auto-action failed", 
            message: err instanceof Error ? err.message : String(err) 
          });
          setSkipAutoAction(false);
        }
      };
      // Small delay to ensure UI has updated
      const timer = setTimeout(() => {
        executeAutoAction();
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [state, transcription, skipAutoAction, autoAction]);

  // Reset auto-action executed flag when starting a new recording
  useEffect(() => {
    if (state === State.RECORDING || state === State.IDLE) {
      autoActionExecutedRef.current = false;
    }
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
      const processingStart = Date.now();
      setState(State.PROCESSING);
      setTranscriptionStartTime(processingStart);
      setProcessingElapsed(0);
      setRecordingStart(null);
      setRecordingElapsed(0);
      await showToast({ style: Toast.Style.Animated, title: "Transcribing..." });

      const result = await stopRecordingAndTranscribe();

      const processingEnd = Date.now();
      const transcriptionTime = (processingEnd - processingStart) / 1000;

      setTranscription(result.text);
      setLanguage(result.language);
      setDuration(result.duration);
      setTranscriptionDuration(transcriptionTime);
      setState(State.DONE);
      setTranscriptionStartTime(null);
      setProcessingElapsed(0);

      await showToast({ style: Toast.Style.Success, title: "Done" });
      
      // Reset skip flag for next recording (after a brief delay to allow auto-action)
      // The auto-action will be triggered by useEffect when state becomes DONE
    } catch (err) {
      console.error("Transcription failed:", err);
      setState(State.ERROR);
      setError(err instanceof Error ? err.message : String(err));
      setTranscriptionStartTime(null);
      setProcessingElapsed(0);
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
    setAudioLevelHistory([]);
    setAnimationTick(0);
    setTranscriptionStartTime(null);
    setTranscriptionDuration(0);
    setProcessingElapsed(0);
    setSkipAutoAction(false);
    autoActionExecutedRef.current = false;
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

  const toggleSkipAutoAction = () => {
    setSkipAutoAction((prev) => !prev);
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
    // Copy to clipboard first so it's available for later use
    await Clipboard.copy(transcription);
    // Then paste at cursor position using Raycast's paste functionality
    await Clipboard.paste(transcription);
    await showToast({ style: Toast.Style.Success, title: "Pasted & Copied" });
    await maybeReturnToRoot();
  };

  // Playful, animated markdown UI
  const getMarkdown = (): string => {
    const model = WHISPER_MODEL;
    const device = serverInfo?.device || COMPUTE_DEVICE;
    const deviceEmoji = device.toLowerCase() === "cuda" ? "🖥️" : "💻";

    switch (state) {
      case State.CHECKING:
        const checkingAutoAction = autoAction !== "none" ? ` · 🔄 ${autoAction === "paste" ? "Auto-paste" : "Auto-copy"}` : "";
        return `## 🔍 Checking server${getAnimatedDots(animationTick)}\n\n${deviceEmoji} \`${model}\` · \`${device}\`${checkingAutoAction}`;

      case State.STARTING:
        const startingClockEmojis = ["🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚", "🕛"];
        const startingClockEmoji = startingClockEmojis[animationTick % startingClockEmojis.length];
        const startingAutoAction = autoAction !== "none" ? ` · 🔄 ${autoAction === "paste" ? "Auto-paste" : "Auto-copy"}` : "";
        return `## ${startingClockEmoji} Downloading Whisper model${getAnimatedDots(animationTick)}\n\nThis may take a moment on first run.\n\n${deviceEmoji} \`${model}\` · \`${device}\`${startingAutoAction}`;

      case State.IDLE:
        const idleAutoAction = autoAction !== "none" ? ` · 🔄 ${autoAction === "paste" ? "Auto-paste" : "Auto-copy"}` : "";
        return `## 🎙️ Ready\n\nPress **Enter** to start recording.\n\n─────────────────────\n\n${deviceEmoji} \`${model}\` · \`${device}\`${idleAutoAction}`;

      case State.RECORDING:
        const waveform = renderWaveform(audioLevelHistory);
        const recordingPhrase = getRecordingPhrase(recordingElapsed);
        const timerDisplay = recordingStart !== null ? formatElapsed(recordingElapsed) : "00:00";
        const recordingSkipIndicator = autoAction !== "none" && skipAutoAction ? "\n\n⏸️ Auto-action disabled" : "";
        const autoActionText = autoAction === "paste" ? "Auto-paste" : "Auto-copy";
        const recordingAutoAction = autoAction !== "none" 
          ? ` · 🔄 ${skipAutoAction ? `~~\`${autoActionText}\`~~` : `\`${autoActionText}\``}`
          : "";
        
        return `## 🔴 ${recordingPhrase}\n\n### ${timerDisplay}\n\n\`${waveform}\`\n\nPress **Enter** to stop${recordingSkipIndicator}\n\n📦 \`${model}\` · ${deviceEmoji} \`${device}\`${recordingAutoAction}`;

      case State.PROCESSING:
        const clockEmojis = ["🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚", "🕛"];
        const clockEmoji = clockEmojis[animationTick % clockEmojis.length];
        const processingTimer = transcriptionStartTime ? formatElapsed(processingElapsed) : "00:00";
        // Slow down dots: 6 * 80ms = 480ms per dot change (close to original 500ms)
        const processingSkipIndicator = autoAction !== "none" && skipAutoAction ? "\n\n⏸️ Auto-action disabled" : "";
        const processingAutoActionText = autoAction === "paste" ? "Auto-paste" : "Auto-copy";
        const processingAutoAction = autoAction !== "none" 
          ? ` · 🔄 ${skipAutoAction ? `~~\`${processingAutoActionText}\`~~` : `\`${processingAutoActionText}\``}`
          : "";
        return `## ${clockEmoji} Processing${getAnimatedDots(animationTick, 6)}\n\n### ${processingTimer}\n\nTranscribing your audio...${processingSkipIndicator}\n\n📦 \`${model}\` · ${deviceEmoji} \`${device}\`${processingAutoAction}`;

      case State.DONE:
        const languageEmoji = "🌐";
        const audioTime = duration.toFixed(1);
        const transcriptionTime = transcriptionDuration.toFixed(1);
        const doneAutoActionText = autoAction === "paste" ? "Auto-paste" : "Auto-copy";
        const doneAutoAction = autoAction !== "none" 
          ? ` · 🔄 ${skipAutoAction ? `~~\`${doneAutoActionText}\`~~` : `\`${doneAutoActionText}\``}`
          : "";
        return `${transcription}\n\n─────────────────────\n\n⏱️ Audio: \`${audioTime}s\` · ⚡ Transcription: \`${transcriptionTime}s\`\n\n${languageEmoji} \`${language}\` · 📦 \`${model}\`${doneAutoAction}\n\n⏎ **Paste** · ⌃C **Copy** · ⌃E **Edit**`;

      case State.ERROR:
        return `## ❌ Error\n\n${error}\n\n─────────────────────\n\nCheck server and try again.`;

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
            {autoAction !== "none" && (
              <Action
                title={skipAutoAction ? "Enable Auto-Action" : "Skip Auto-Action"}
                icon={skipAutoAction ? Icon.Play : Icon.Pause}
                onAction={toggleSkipAutoAction}
                shortcut={{ modifiers: ["ctrl"], key: "a" }}
              />
            )}
          </ActionPanel>
        );

      case State.PROCESSING:
        return (
          <ActionPanel>
            {autoAction !== "none" && (
              <Action
                title={skipAutoAction ? "Enable Auto-Action" : "Skip Auto-Action"}
                icon={skipAutoAction ? Icon.Play : Icon.Pause}
                onAction={toggleSkipAutoAction}
                shortcut={{ modifiers: ["ctrl"], key: "a" }}
              />
            )}
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
