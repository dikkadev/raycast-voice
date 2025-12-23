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
  launchCommand,
  LaunchType,
  AI,
  environment,
} from "@raycast/api";
import { useEffect, useState, useRef, useMemo } from "react";
import {
  startBackendRecording,
  stopRecordingAndTranscribe,
  getAudioLevel,
  cancelBackendRecording,
  CancelEndpointUnavailableError,
  retranscribeLastRecording,
  clearCachedRecording,
} from "./transcription-client";
import { ensureServerRunning, getServerStatus, restartServer, ServerStatus } from "./server-manager";
import { processTranscription } from "./post-processing";
import { AUTO_START, WHISPER_MODEL, COMPUTE_DEVICE, RETURN_TO_ROOT, getAudioLevelPollingRate, getAutoAction, getSaveToHistory, getRevisionPrimer } from "./config";
import { saveTranscription, getTranscriptionById } from "./history-storage";
import { HistoryDetailView, calculatePerformanceRatio } from "./view-history";
import { getUserFriendlyError, formatErrorForDisplay, UserFriendlyError } from "./error-handler";

enum State {
  IDLE = "idle",
  CHECKING = "checking",
  STARTING = "starting",
  RECORDING = "recording",
  PROCESSING = "processing",
  DONE = "done",
  ERROR = "error",
  REVISION_RECORDING = "revision_recording",
  REVISION_PROCESSING = "revision_processing",
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

type AutoActionStatus = "idle" | "pending" | "success" | "failure";

export default function Command() {
  const copyShortcut: Keyboard.Shortcut = { modifiers: ["ctrl"], key: "c" };

  const [state, setState] = useState<State>(State.IDLE);
  const [transcription, setTranscription] = useState("");
  const [error, setError] = useState("");
  const [errorDetails, setErrorDetails] = useState<UserFriendlyError | null>(null);
  const [language, setLanguage] = useState("");
  const [duration, setDuration] = useState(0);
  const [serverInfo, setServerInfo] = useState<ServerStatus | null>(null);
  const [recordingStart, setRecordingStart] = useState<number | null>(null);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [audioLevelHistory, setAudioLevelHistory] = useState<number[]>([]);
  const [animationTick, setAnimationTick] = useState(0);
  const [transcriptionStartTime, setTranscriptionStartTime] = useState<number | null>(null);
  const [transcriptionDuration, setTranscriptionDuration] = useState(0);
  const [processingElapsed, setProcessingElapsed] = useState(0);
  const [skipAutoAction, setSkipAutoAction] = useState(false);
  const [skipSaveToHistory, setSkipSaveToHistory] = useState(false);
  const [autoActionStatus, setAutoActionStatus] = useState<AutoActionStatus>("idle");
  const [savedTranscriptionId, setSavedTranscriptionId] = useState<string | null>(null);
  const [hasCachedRecording, setHasCachedRecording] = useState(false);
  
  // Check if AI API is accessible
  const canAccessAI = environment.canAccess(AI);
  
  // Memoize auto-action to prevent re-renders
  const autoAction = useMemo(() => getAutoAction(), []);
  const autoActionEnabled = autoAction !== "none";
  const autoActionActive = autoActionEnabled && !skipAutoAction;
  
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
    if ((state === State.RECORDING || state === State.REVISION_RECORDING) && recordingStart) {
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
    if ((state === State.PROCESSING || state === State.REVISION_PROCESSING) && transcriptionStartTime) {
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
    
    if ((state === State.RECORDING || state === State.REVISION_RECORDING) && pollingRate > 0) {
      const pollAudioLevel = async () => {
        try {
          const rawLevel = await getAudioLevel();
          
          // Update rolling buffer for waveform
          setAudioLevelHistory((prev) => {
            const updated = [...prev, rawLevel];
            // Keep only last WAVEFORM_BUFFER_SIZE samples
            return updated.slice(-WAVEFORM_BUFFER_SIZE);
          });
        } catch {
          // Silently fail - audio level is optional
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
    const shouldAnimate =
      state === State.CHECKING ||
      state === State.STARTING ||
      state === State.PROCESSING ||
      state === State.REVISION_PROCESSING ||
      (state === State.DONE && autoActionActive && autoActionStatus !== "failure");

    if (shouldAnimate) {
      // Fast animation for processing (full clock revolution per second: 12 emojis / 1s = ~83ms)
      const intervalMs = (state === State.PROCESSING || state === State.REVISION_PROCESSING) ? 80 : 500;
      const interval = setInterval(() => {
        setAnimationTick((prev) => prev + 1);
      }, intervalMs);
      return () => clearInterval(interval);
    } else {
      setAnimationTick(0);
    }
  }, [state, autoActionActive, autoActionStatus]);

  // Auto-action effect: execute when transcription completes
  useEffect(() => {
    if (state === State.DONE && transcription && autoActionActive && !autoActionExecutedRef.current) {
      autoActionExecutedRef.current = true;
      setAutoActionStatus("pending");
      const executeAutoAction = async () => {
        try {
          if (autoAction === "paste") {
            await paste();
          } else if (autoAction === "copy") {
            await copy();
          }
          setAutoActionStatus("success");
          // Reset skip flag after execution
          setSkipAutoAction(false);
        } catch (err) {
          console.error("Auto-action failed:", err);
          setAutoActionStatus("failure");
          await showToast({
            style: Toast.Style.Failure,
            title: "Auto-action failed",
            message: err instanceof Error ? err.message : String(err),
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
  }, [state, transcription, autoActionActive, autoAction]);

  // Reset auto-action executed flag and skip flags when starting a new recording
  useEffect(() => {
    if (state === State.RECORDING || state === State.IDLE) {
      autoActionExecutedRef.current = false;
      setSkipAutoAction(false);
      setSkipSaveToHistory(false);
      setAutoActionStatus("idle");
    }
  }, [state]);

  useEffect(() => {
    if (skipAutoAction) {
      setAutoActionStatus("idle");
    }
  }, [skipAutoAction]);

  useEffect(() => {
    return () => {
      if (activeStateRef.current === State.RECORDING || activeStateRef.current === State.REVISION_RECORDING) {
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
      // Best-effort clear of cached audio when leaving the command
      clearCachedRecording().catch((err) => console.error("Failed to clear cached recording on unmount:", err));
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
      setHasCachedRecording(false);
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
      const friendlyError = getUserFriendlyError(err, "start");
      setState(State.ERROR);
      setErrorDetails(friendlyError);
      setError(formatErrorForDisplay(friendlyError));
      setRecordingStart(null);
      setRecordingElapsed(0);
      await showToast({ 
        style: Toast.Style.Failure, 
        title: friendlyError.title, 
        message: friendlyError.message 
      });
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

      const rawText = result.text;
      const processedText = processTranscription(rawText);

      setTranscription(processedText);
      setLanguage(result.language);
      setDuration(result.duration);
      setTranscriptionDuration(transcriptionTime);
      setState(State.DONE);
      setTranscriptionStartTime(null);
      setProcessingElapsed(0);
      setHasCachedRecording(true);

      // Save to history if enabled and not skipped
      let transcriptionId: string | null = null;
      if (getSaveToHistory() && !skipSaveToHistory) {
        try {
          transcriptionId = Date.now().toString();
          await saveTranscription({
            id: transcriptionId,
            text: processedText,
            originalText: rawText,
            language: result.language,
            duration: result.duration,
            timestamp: Date.now(),
            transcriptionTime: transcriptionTime,
            model: WHISPER_MODEL,
            device: serverInfo?.device || COMPUTE_DEVICE,
          });
          setSavedTranscriptionId(transcriptionId);
        } catch (err) {
          // Silently fail - history saving is optional
          console.error("Failed to save to history:", err);
        }
      } else {
        setSavedTranscriptionId(null);
      }

      await showToast({ style: Toast.Style.Success, title: "Done" });
      
      // Reset skip flag for next recording (after a brief delay to allow auto-action)
      // The auto-action will be triggered by useEffect when state becomes DONE
    } catch (err) {
      console.error("Transcription failed:", err);
      const friendlyError = getUserFriendlyError(err, "stop");
      setState(State.ERROR);
      setErrorDetails(friendlyError);
      setError(formatErrorForDisplay(friendlyError));
      setTranscriptionStartTime(null);
      setProcessingElapsed(0);
      await showToast({ 
        style: Toast.Style.Failure, 
        title: friendlyError.title, 
        message: friendlyError.message 
      });
    }
  };

  const startRevision = async () => {
    try {
      setState(State.REVISION_RECORDING);
      await ensureServerRunning();
      
      // Clear previous recording state if any
      try {
        await cancelBackendRecording();
      } catch {
        // Ignore cleanup errors
      }

      setRecordingStart(Date.now());
      setRecordingElapsed(0);
      await startBackendRecording();
      await showToast({ style: Toast.Style.Success, title: "Listening for instructions..." });
    } catch (err) {
      console.error("Failed to start revision:", err);
      const friendlyError = getUserFriendlyError(err, "start");
      setState(State.ERROR);
      setErrorDetails(friendlyError);
      setError(formatErrorForDisplay(friendlyError));
      setRecordingStart(null);
      await showToast({
        style: Toast.Style.Failure,
        title: friendlyError.title,
        message: friendlyError.message
      });
    }
  };

  const stopRevision = async () => {
    try {
      const processingStart = Date.now();
      setState(State.REVISION_PROCESSING);
      setTranscriptionStartTime(processingStart);
      setProcessingElapsed(0);
      setRecordingStart(null);
      setRecordingElapsed(0);
      await showToast({ style: Toast.Style.Animated, title: "Transcribing instructions..." });

      // 1. Get instruction text (transcribe normally)
      const result = await stopRecordingAndTranscribe();
      const instructionText = result.text;
      
      if (!instructionText || !instructionText.trim()) {
         await showToast({ style: Toast.Style.Failure, title: "No instructions heard" });
         setState(State.DONE); // Return to done without changes
         setTranscriptionStartTime(null);
         return;
      }

      await showToast({ style: Toast.Style.Animated, title: "Applying revision..." });

      // 2. Call LLM
      const primer = getRevisionPrimer();
      const systemInstruction = `${primer ? primer + "\n\n" : ""}You are a helpful assistant. You are an expert in text revision and editing.
You know the NATO Spelling Alphabet and should use it to interpret spelling instructions if provided.
You will receive the original text and a set of spoken instructions for how to revise it.
Apply the instructions to the original text.
Output ONLY the final revised text. Do not include any explanations, preambles, or conversational text.`;
      
      const fullPrompt = `${systemInstruction}\n\nOriginal text:\n"${transcription}"\n\nInstructions:\n"${instructionText}"`;

      try {
        // Try to use Kimi K2 if available, otherwise let Raycast use its default model
        const askOptions: { creativity: AI.Creativity; model?: AI.Model } = {
          creativity: "low", // We want faithful execution of instructions
        };
        
        // Attempt to use Kimi K2 model if available (requires newer Raycast version)
        // If the model isn't available, Raycast will fallback to a similar one
        if ("Groq_Kimi_K2_Instruct" in AI.Model) {
          askOptions.model = AI.Model["Groq_Kimi_K2_Instruct"];
        }
        
        const answer = await AI.ask(fullPrompt, askOptions);
        
        setTranscription(answer.trim());
        setState(State.DONE);
        await showToast({ style: Toast.Style.Success, title: "Revision complete" });
        
      } catch (aiErr) {
        console.error("AI Revision failed:", aiErr);
         await showToast({ 
          style: Toast.Style.Failure, 
          title: "AI Revision failed", 
          message: aiErr instanceof Error ? aiErr.message : String(aiErr) 
        });
        setState(State.DONE); // Return to done state even if AI failed
      }
      
      setTranscriptionStartTime(null);
      setProcessingElapsed(0);

    } catch (err) {
      console.error("Revision failed:", err);
      const friendlyError = getUserFriendlyError(err, "stop");
      setState(State.ERROR);
      setErrorDetails(friendlyError);
      setError(formatErrorForDisplay(friendlyError));
      setTranscriptionStartTime(null);
      await showToast({ 
        style: Toast.Style.Failure, 
        title: friendlyError.title, 
        message: friendlyError.message 
      });
    }
  };

  const rerunTranscription = async () => {
    try {
      const processingStart = Date.now();
      setState(State.PROCESSING);
      setTranscriptionStartTime(processingStart);
      setProcessingElapsed(0);
      await showToast({ style: Toast.Style.Animated, title: "Re-running transcription..." });

      const result = await retranscribeLastRecording();

      const processingEnd = Date.now();
      const transcriptionTime = (processingEnd - processingStart) / 1000;

      const rawText = result.text;
      const processedText = processTranscription(rawText);

      setTranscription(processedText);
      setLanguage(result.language);
      setDuration(result.duration);
      setTranscriptionDuration(transcriptionTime);
      setState(State.DONE);
      setTranscriptionStartTime(null);
      setProcessingElapsed(0);
      setHasCachedRecording(true); // still valid and timer reset backend-side

      let transcriptionId: string | null = null;
      if (getSaveToHistory() && !skipSaveToHistory) {
        try {
          transcriptionId = Date.now().toString();
          await saveTranscription({
            id: transcriptionId,
            text: processedText,
            originalText: rawText,
            language: result.language,
            duration: result.duration,
            timestamp: Date.now(),
            transcriptionTime: transcriptionTime,
            model: WHISPER_MODEL,
            device: serverInfo?.device || COMPUTE_DEVICE,
          });
          setSavedTranscriptionId(transcriptionId);
        } catch (err) {
          console.error("Failed to save retranscription to history:", err);
        }
      } else {
        setSavedTranscriptionId(null);
      }

      await showToast({ style: Toast.Style.Success, title: "Re-run complete" });
    } catch (err) {
      console.error("Retranscription failed:", err);
      const friendlyError = getUserFriendlyError(err, "stop");
      setState(State.ERROR);
      setErrorDetails(friendlyError);
      setError(formatErrorForDisplay(friendlyError));
      setTranscriptionStartTime(null);
      setProcessingElapsed(0);
      await showToast({ 
        style: Toast.Style.Failure, 
        title: friendlyError.title, 
        message: friendlyError.message 
      });
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
      const friendlyError = getUserFriendlyError(err, "server");
      setState(State.ERROR);
      setErrorDetails(friendlyError);
      setError(formatErrorForDisplay(friendlyError));
      await showToast({ 
        style: Toast.Style.Failure, 
        title: friendlyError.title, 
        message: friendlyError.message 
      });
    }
  };

  const reset = () => {
    setState(State.IDLE);
    setTranscription("");
    setError("");
    setErrorDetails(null);
    setLanguage("");
    setDuration(0);
    setRecordingStart(null);
    setRecordingElapsed(0);
    setAudioLevelHistory([]);
    setAnimationTick(0);
    setTranscriptionStartTime(null);
    setTranscriptionDuration(0);
    setProcessingElapsed(0);
    setSkipAutoAction(false);
    setSkipSaveToHistory(false);
    setAutoActionStatus("idle");
    setSavedTranscriptionId(null);
    setHasCachedRecording(false);
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

      const friendlyError = getUserFriendlyError(err, "cancel");
      setState(State.ERROR);
      setErrorDetails(friendlyError);
      setError(formatErrorForDisplay(friendlyError));
      await showToast({ 
        style: Toast.Style.Failure, 
        title: friendlyError.title, 
        message: friendlyError.message 
      });
    }
  };

  const toggleSkipAutoAction = () => {
    setSkipAutoAction((prev) => !prev);
  };

  const toggleSkipSaveToHistory = () => {
    setSkipSaveToHistory((prev) => !prev);
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
        return `## ${startingClockEmoji} Loading Whisper model${getAnimatedDots(animationTick)}\n\nThis may take a moment on first run.\n\n${deviceEmoji} \`${model}\` · \`${device}\`${startingAutoAction}`;

      case State.IDLE:
        const idleAutoAction = autoAction !== "none" ? ` · 🔄 ${autoAction === "paste" ? "Auto-paste" : "Auto-copy"}` : "";
        return `## 🎙️ Ready\n\nPress **Enter** to start recording.\n\n─────────────────────\n\n${deviceEmoji} \`${model}\` · \`${device}\`${idleAutoAction}`;

      case State.RECORDING:
        const waveform = renderWaveform(audioLevelHistory);
        const recordingPhrase = getRecordingPhrase(recordingElapsed);
        const timerDisplay = recordingStart !== null ? formatElapsed(recordingElapsed) : "00:00";
        const recordingSkipIndicator = autoAction !== "none" && skipAutoAction ? "\n\n⏸️ Auto-action disabled" : "";
        const recordingSaveDisabled = getSaveToHistory() && skipSaveToHistory ? "\n\n💾 Saving disabled" : "";
        const autoActionText = autoAction === "paste" ? "Auto-paste" : "Auto-copy";
        const recordingAutoAction = autoAction !== "none" 
          ? ` · 🔄 ${skipAutoAction ? `~~\`${autoActionText}\`~~` : `\`${autoActionText}\``}`
          : "";
        
        return `## 🔴 ${recordingPhrase}\n\n### ${timerDisplay}\n\n\`${waveform}\`\n\nPress **Enter** to stop${recordingSkipIndicator}${recordingSaveDisabled}\n\n📦 \`${model}\` · ${deviceEmoji} \`${device}\`${recordingAutoAction}`;

      case State.REVISION_RECORDING:
        const revWaveform = renderWaveform(audioLevelHistory);
        const revTimer = recordingStart !== null ? formatElapsed(recordingElapsed) : "00:00";
        const quotedTranscription = transcription.split("\n").map(line => `> ${line}`).join("\n");
        return `## 🗣️ Listening for instructions...\n\n### ${revTimer}\n\n\`${revWaveform}\`\n\n**Original text:**\n${quotedTranscription}\n\nTell me how to change the text (e.g., "Make it more formal", "Replace X with Y")\n\nPress **Enter** to apply revision.`;

      case State.PROCESSING:
        const clockEmojis = ["🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚", "🕛"];
        const clockEmoji = clockEmojis[animationTick % clockEmojis.length];
        const processingTimer = transcriptionStartTime ? formatElapsed(processingElapsed) : "00:00";
        // Slow down dots: 6 * 80ms = 480ms per dot change (close to original 500ms)
        const processingSkipIndicator = autoAction !== "none" && skipAutoAction ? "\n\n⏸️ Auto-action disabled" : "";
        const processingSaveDisabled = getSaveToHistory() && skipSaveToHistory ? "\n\n💾 Saving disabled" : "";
        const processingAutoActionText = autoAction === "paste" ? "Auto-paste" : "Auto-copy";
        const processingAutoAction = autoAction !== "none" 
          ? ` · 🔄 ${skipAutoAction ? `~~\`${processingAutoActionText}\`~~` : `\`${processingAutoActionText}\``}`
          : "";
        return `## ${clockEmoji} Processing${getAnimatedDots(animationTick, 6)}\n\n### ${processingTimer}\n\nTranscribing your audio...${processingSkipIndicator}${processingSaveDisabled}\n\n📦 \`${model}\` · ${deviceEmoji} \`${device}\`${processingAutoAction}`;

      case State.REVISION_PROCESSING:
        const revClockEmojis = ["🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚", "🕛"];
        const revClockEmoji = revClockEmojis[animationTick % revClockEmojis.length];
        const revProcessingTimer = transcriptionStartTime ? formatElapsed(processingElapsed) : "00:00";
        return `## ${revClockEmoji} Revising text${getAnimatedDots(animationTick, 6)}\n\n### ${revProcessingTimer}\n\nTranscribing instructions & applying AI revision...`;

      case State.DONE:
        if (autoActionActive && autoActionStatus !== "failure") {
          const activeAutoActionText = autoAction === "paste" ? "Auto-paste" : "Auto-copy";
          const autoActionEmoji = autoActionStatus === "success" ? "✅" : "🔄";
          const progressDots = autoActionStatus === "success" ? "" : getAnimatedDots(animationTick);
          const headline =
            autoActionStatus === "success"
              ? `${autoActionEmoji} ${activeAutoActionText} complete`
              : `${autoActionEmoji} ${activeAutoActionText} in progress${progressDots}`;
          return `## ${headline}\n\nYour transcription is handled via ${activeAutoActionText.toLowerCase()}.\n\nYou can stay on this screen or start a new recording whenever you're ready.`;
        }

        const languageEmoji = "🌐";
        const audioTime = duration.toFixed(1);
        const transcriptionTime = transcriptionDuration.toFixed(1);
        const doneAutoActionText = autoAction === "paste" ? "Auto-paste" : "Auto-copy";
        const doneAutoAction = autoActionEnabled
          ? ` · 🔄 ${skipAutoAction ? `~~\`${doneAutoActionText}\`~~` : `\`${doneAutoActionText}\``}`
          : "";
        const aiWarning = !canAccessAI ? "\n\n⚠️ *AI revision not available (Raycast Pro required)*" : "";
        return `${transcription}\n\n─────────────────────\n\n⏱️ Audio: \`${audioTime}s\` · ⚡ Transcription: \`${transcriptionTime}s\`\n\n${languageEmoji} \`${language}\` · 📦 \`${model}\`${doneAutoAction}${aiWarning}\n\n⏎ **Paste** · ⌃C **Copy** · ⌃V **Revise** · ⌃R **Re-run** · ⌃E **Edit**`;

      case State.ERROR:
        // error already contains formatted markdown with title, message, and suggestion
        return error || "## ❌ Error\n\nAn unknown error occurred.";

      default:
        return "";
    }
  };

  const getActions = () => {
    const configMismatch = serverInfo?.configMismatch;
    const restartAction = <Action title="Restart Server" icon={Icon.RotateClockwise} onAction={handleRestart} />;

    switch (state) {
      case State.IDLE:
        return (
          <ActionPanel>
            <Action title="Start Recording" icon={Icon.Microphone} onAction={startRecording} />
            {configMismatch ? (
              <Action title="Restart Server (Config Changed)" icon={Icon.ArrowClockwise} onAction={handleRestart} />
            ) : (
              restartAction
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
            {getSaveToHistory() && (
              <Action
                title={skipSaveToHistory ? "Enable Saving" : "Skip Saving"}
                icon={skipSaveToHistory ? Icon.Document : Icon.XMarkCircle}
                onAction={toggleSkipSaveToHistory}
                shortcut={{ modifiers: ["ctrl"], key: "s" }}
              />
            )}
            {restartAction}
          </ActionPanel>
        );

      case State.REVISION_RECORDING:
        return (
          <ActionPanel>
            <Action title="Stop & Apply Revision" icon={Icon.Check} onAction={stopRevision} />
            <Action title="Cancel Revision" icon={Icon.XMarkCircle} onAction={() => {
              cancelBackendRecording().catch(console.error);
              setState(State.DONE);
            }} />
            {restartAction}
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
            {getSaveToHistory() && (
              <Action
                title={skipSaveToHistory ? "Enable Saving" : "Skip Saving"}
                icon={skipSaveToHistory ? Icon.Document : Icon.XMarkCircle}
                onAction={toggleSkipSaveToHistory}
                shortcut={{ modifiers: ["ctrl"], key: "s" }}
              />
            )}
            {restartAction}
          </ActionPanel>
        );

      case State.REVISION_PROCESSING:
        return (
          <ActionPanel>
            {restartAction}
          </ActionPanel>
        );

      case State.DONE:
        return (
          <ActionPanel>
            <Action title="Paste" icon={Icon.Text} onAction={paste} />
            <Action title="Copy" icon={Icon.Clipboard} onAction={copy} shortcut={copyShortcut} />
            {canAccessAI && (
              <Action 
                title="Revise Transcription" 
                icon={Icon.Microphone} 
                onAction={startRevision}
                shortcut={{ modifiers: ["ctrl"], key: "v" }}
              />
            )}
            {hasCachedRecording && (
              <Action
                title="Re-run Transcription"
                icon={Icon.RotateClockwise}
                shortcut={{ modifiers: ["ctrl"], key: "r" }}
                onAction={rerunTranscription}
              />
            )}
            {savedTranscriptionId && (
              <Action.Push
                title="View Details"
                icon={Icon.Eye}
                target={<TranscriptionDetailViewWrapper transcriptionId={savedTranscriptionId} />}
                shortcut={{ modifiers: ["ctrl"], key: "d" }}
              />
            )}
            <Action.Push
              title="Edit Transcription"
              icon={Icon.Pencil}
              shortcut={{ modifiers: ["ctrl"], key: "e" }}
              target={<EditTranscriptionForm initialText={transcription} onSave={setTranscription} />}
            />
            <Action
              title="View History"
              icon={Icon.Clock}
              onAction={() => launchCommand({ name: "view-history", type: LaunchType.UserInitiated })}
              shortcut={{ modifiers: ["ctrl"], key: "h" }}
            />
            <Action title="New Recording" icon={Icon.Microphone} onAction={reset} shortcut={{ modifiers: ["ctrl"], key: "n" }} />
            <Action title="Open Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
            {restartAction}
          </ActionPanel>
        );

      case State.ERROR:
        return (
          <ActionPanel>
            <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={reset} />
            {restartAction}
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

type TranscriptionDetailViewWrapperProps = {
  transcriptionId: string;
};

function TranscriptionDetailViewWrapper({ transcriptionId }: TranscriptionDetailViewWrapperProps) {
  const [item, setItem] = useState<import("./history-storage").TranscriptionHistoryItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadTranscription() {
      try {
        const loadedItem = await getTranscriptionById(transcriptionId);
        if (loadedItem) {
          setItem(loadedItem);
        } else {
          await showToast({
            style: Toast.Style.Failure,
            title: "Not found",
            message: "Could not find this transcription in history",
          });
        }
      } catch (error) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to load",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setIsLoading(false);
      }
    }

    loadTranscription();
  }, [transcriptionId]);

  if (isLoading) {
    return <Detail markdown="Loading..." isLoading={true} />;
  }

  if (!item) {
    return <Detail markdown="## Transcription not found\n\nThis transcription could not be found in history." />;
  }

  const performanceRatio = calculatePerformanceRatio(item.duration, item.transcriptionTime);
  return <HistoryDetailView item={item} performanceRatio={performanceRatio} />;
}
