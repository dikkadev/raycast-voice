import { Action, ActionPanel, Detail, Icon, Clipboard, showToast, Toast, environment } from "@raycast/api";
import { useEffect, useState, useRef } from "react";
import { startBackendRecording, stopRecordingAndTranscribe } from "./transcription-client";
import { ensureServerRunning, isServerRunning } from "./server-manager";

enum RecordingState {
  IDLE = "idle",
  CHECKING_SERVER = "checking_server",
  STARTING_SERVER = "starting_server",
  RECORDING = "recording",
  PROCESSING = "processing",
  COMPLETED = "completed",
  ERROR = "error",
}

export default function Command() {
  const [state, setState] = useState<RecordingState>(RecordingState.IDLE);
  const [transcription, setTranscription] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [language, setLanguage] = useState<string>("");
  const [duration, setDuration] = useState<number>(0);
  const hasStartedRecording = useRef(false);

  // Check server status on mount and auto-start recording
  useEffect(() => {
    if (!hasStartedRecording.current) {
      hasStartedRecording.current = true;
      checkServerAndStartRecording();
    }
  }, []);

  const checkServerAndStartRecording = async () => {
    setState(RecordingState.CHECKING_SERVER);
    const running = await isServerRunning();
    if (!running) {
      await showToast({
        style: Toast.Style.Animated,
        title: "Server not running",
        message: "Starting server...",
      });
    }
    // Auto-start recording
    await startRecording();
  };

  const checkServer = async () => {
    setState(RecordingState.CHECKING_SERVER);
    const running = await isServerRunning();
    if (running) {
      setState(RecordingState.IDLE);
      await showToast({
        style: Toast.Style.Success,
        title: "Server is ready",
      });
    } else {
      setState(RecordingState.IDLE);
      await showToast({
        style: Toast.Style.Animated,
        title: "Server not running",
        message: "Will auto-start when recording",
      });
    }
  };

  const startRecording = async () => {
    try {
      // Ensure server is running
      setState(RecordingState.STARTING_SERVER);
      await showToast({
        style: Toast.Style.Animated,
        title: "Starting server...",
      });

      await ensureServerRunning();

      await showToast({
        style: Toast.Style.Success,
        title: "Server ready",
      });

      // Start backend recording
      setState(RecordingState.RECORDING);
      await startBackendRecording();

      await showToast({
        style: Toast.Style.Success,
        title: "Recording started",
        message: "Speak now...",
      });
    } catch (err) {
      console.error("Failed to start recording:", err);
      setState(RecordingState.ERROR);
      setError(err instanceof Error ? err.message : String(err));
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to start recording",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const stopRecording = async () => {
    try {
      setState(RecordingState.PROCESSING);
      await showToast({
        style: Toast.Style.Animated,
        title: "Processing...",
      });

      // Stop backend recording and transcribe
      const result = await stopRecordingAndTranscribe();

      setTranscription(result.text);
      setLanguage(result.language);
      setDuration(result.duration);
      setState(RecordingState.COMPLETED);

      await showToast({
        style: Toast.Style.Success,
        title: "Transcription complete",
        message: `${result.text.substring(0, 50)}...`,
      });
    } catch (err) {
      console.error("Failed to process recording:", err);
      setState(RecordingState.ERROR);
      setError(err instanceof Error ? err.message : String(err));
      await showToast({
        style: Toast.Style.Failure,
        title: "Transcription failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const cancelRecording = async () => {
    try {
      setState(RecordingState.IDLE);
      setTranscription("");
      setError("");
      await showToast({
        style: Toast.Style.Success,
        title: "Recording cancelled",
      });
    } catch (err) {
      console.error("Failed to cancel recording:", err);
    }
  };

  const reset = () => {
    setState(RecordingState.IDLE);
    setTranscription("");
    setError("");
    setLanguage("");
    setDuration(0);
  };

  const copyToClipboard = async () => {
    await Clipboard.copy(transcription);
    await showToast({
      style: Toast.Style.Success,
      title: "Copied to clipboard",
    });
  };

  const pasteText = async () => {
    await Clipboard.paste(transcription);
    await showToast({
      style: Toast.Style.Success,
      title: "Pasted",
    });
  };

  // Generate markdown content based on state
  const getMarkdown = () => {
    switch (state) {
      case RecordingState.CHECKING_SERVER:
        return "# 🔍 Checking Server\n\nVerifying transcription server status...";

      case RecordingState.STARTING_SERVER:
        return "# 🚀 Starting Server\n\nStarting the Whisper transcription server...\n\nThis may take a moment on first run while downloading the model.";

      case RecordingState.IDLE:
        return "# 🎤 Voice Transcription\n\nReady to record audio.\n\nClick **Start Recording** to begin.";

      case RecordingState.RECORDING:
        return "# 🔴 Recording...\n\nSpeak now. Click **Stop Recording** when finished.";

      case RecordingState.PROCESSING:
        return "# ⚙️ Processing\n\nTranscribing your audio using Whisper (CUDA)...\n\nPlease wait...";

      case RecordingState.COMPLETED:
        return `# ✅ Transcription Complete\n\n## Result\n\n${transcription}\n\n---\n\n**Language:** ${language}\n**Duration:** ${duration.toFixed(2)}s`;

      case RecordingState.ERROR:
        return `# ❌ Error\n\n${error}\n\n---\n\nPlease check:\n- Is the server running?\n- Is CUDA available?\n- Are dependencies installed?`;

      default:
        return "# Voice Transcription";
    }
  };

  // Actions based on state
  const getActions = () => {
    if (state === RecordingState.IDLE) {
      return (
        <ActionPanel>
          <Action title="Start Recording" icon={Icon.Microphone} onAction={startRecording} />
          <Action title="Check Server" icon={Icon.Network} onAction={checkServer} />
        </ActionPanel>
      );
    }

    if (state === RecordingState.RECORDING) {
      return (
        <ActionPanel>
          <Action title="Stop Recording" icon={Icon.Stop} onAction={stopRecording} />
          <Action title="Cancel" icon={Icon.XMarkCircle} onAction={cancelRecording} />
        </ActionPanel>
      );
    }

    if (state === RecordingState.COMPLETED) {
      return (
        <ActionPanel>
          <Action title="Copy to Clipboard" icon={Icon.Clipboard} onAction={copyToClipboard} />
          <Action title="Paste at Cursor" icon={Icon.Text} onAction={pasteText} />
          <Action title="New Recording" icon={Icon.Microphone} onAction={reset} />
        </ActionPanel>
      );
    }

    if (state === RecordingState.ERROR) {
      return (
        <ActionPanel>
          <Action title="Try Again" icon={Icon.RotateClockwise} onAction={reset} />
          <Action title="Check Server" icon={Icon.Network} onAction={checkServer} />
        </ActionPanel>
      );
    }

    return <ActionPanel />;
  };

  return <Detail markdown={getMarkdown()} actions={getActions()} />;
}
