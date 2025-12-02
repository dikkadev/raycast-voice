/**
 * Error Handler
 * Provides user-friendly error messages for common error scenarios
 */

import axios from "axios";

export interface UserFriendlyError {
  title: string;
  message: string;
  suggestion?: string;
}

/**
 * Convert various error types into user-friendly error messages
 */
export function getUserFriendlyError(error: unknown, context: "start" | "stop" | "server" | "cancel" | "general" = "general"): UserFriendlyError {
  // Handle axios errors (network/HTTP errors)
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const detail = error.response?.data?.detail || error.message;
    const code = error.code;

    // Connection refused - server not running
    if (code === "ECONNREFUSED") {
      return {
        title: "Server Not Running",
        message: "Could not connect to the transcription server.",
        suggestion: "The server may have stopped. Try restarting it or check your server port settings.",
      };
    }

    // Timeout errors
    if (code === "ECONNABORTED" || code === "ETIMEDOUT" || error.message.includes("timeout")) {
      if (context === "stop") {
        return {
          title: "Transcription Timeout",
          message: "The transcription took too long to complete.",
          suggestion: "Try using a smaller model (tiny/base) or check if your GPU is working properly.",
        };
      }
      return {
        title: "Request Timeout",
        message: "The server took too long to respond.",
        suggestion: "Check if the server is running and try again.",
      };
    }

    // Network errors
    if (code === "ENOTFOUND" || code === "ENETUNREACH") {
      return {
        title: "Network Error",
        message: "Could not reach the server.",
        suggestion: "Check your network connection and ensure the server is running on localhost.",
      };
    }

    // HTTP status code errors
    if (status === 400) {
      if (detail?.includes("already in progress")) {
        return {
          title: "Recording Already Active",
          message: "A recording is already in progress.",
          suggestion: "Wait for the current recording to finish or cancel it first.",
        };
      }
      return {
        title: "Invalid Request",
        message: detail || "The request was invalid.",
        suggestion: "Try restarting the server or check your configuration.",
      };
    }

    if (status === 404) {
      if (context === "cancel") {
        return {
          title: "Cancel Not Supported",
          message: "The server doesn't support canceling recordings.",
          suggestion: "The server will be restarted to enable this feature.",
        };
      }
      return {
        title: "Endpoint Not Found",
        message: "The server endpoint was not found.",
        suggestion: "The server may be outdated. Try restarting it.",
      };
    }

    if (status === 503) {
      if (detail?.includes("Model not loaded") || detail?.includes("model")) {
        return {
          title: "Model Not Ready",
          message: "The Whisper model is still loading or failed to load.",
          suggestion: "Wait a moment and try again. If the problem persists, check the server logs for model loading errors.",
        };
      }
      return {
        title: "Service Unavailable",
        message: detail || "The server is temporarily unavailable.",
        suggestion: "Try restarting the server or check if it's still running.",
      };
    }

    if (status === 500) {
      if (detail?.includes("Transcription failed")) {
        return {
          title: "Transcription Error",
          message: "The audio could not be transcribed.",
          suggestion: "Check that you recorded audio and try again. If the problem persists, try restarting the server.",
        };
      }
      if (detail?.includes("combine audio")) {
        return {
          title: "Audio Processing Error",
          message: "Failed to process the recorded audio.",
          suggestion: "Try recording again. If the problem persists, restart the server.",
        };
      }
      return {
        title: "Server Error",
        message: detail || "An error occurred on the server.",
        suggestion: "Check the server logs for more details or try restarting the server.",
      };
    }

    // Generic axios error with response
    if (error.response) {
      return {
        title: "Server Error",
        message: detail || `Server returned error ${status}`,
        suggestion: "Check the server logs or try restarting the server.",
      };
    }

    // Generic axios error without response
    return {
      title: "Connection Error",
      message: error.message || "Could not connect to the server.",
      suggestion: "Ensure the server is running and check your server port settings.",
    };
  }

  // Handle standard Error objects
  if (error instanceof Error) {
    const message = error.message;

    // Port conflict errors (from server-manager)
    if (message.includes("Port") && message.includes("already in use")) {
      const portMatch = message.match(/Port (\d+)/);
      const port = portMatch ? portMatch[1] : "unknown";
      return {
        title: "Port Conflict",
        message: `Port ${port} is already in use by another application.`,
        suggestion: `Close the application using port ${port} or change the server port in extension preferences.`,
      };
    }

    // Server startup timeout
    if (message.includes("failed to start within") || message.includes("Server failed to start")) {
      return {
        title: "Server Startup Failed",
        message: "The transcription server could not start.",
        suggestion: "Check that:\n• The backend directory is correct\n• Python dependencies are installed (run `uv sync` in backend folder)\n• The server port is not in use\n• Check the server logs for details",
      };
    }

    // Process kill errors
    if (message.includes("Failed to stop") || message.includes("still running")) {
      return {
        title: "Server Restart Failed",
        message: "Could not restart the server.",
        suggestion: "Close any running Python processes manually or change the server port in preferences, then try again.",
      };
    }

    // Generic error with message
    return {
      title: "Error",
      message: message,
      suggestion: "Check the error details above and try again.",
    };
  }

  // Fallback for unknown error types
  return {
    title: "Unknown Error",
    message: String(error),
    suggestion: "Try restarting the server or check the logs for more details.",
  };
}

/**
 * Format error for display in UI
 */
export function formatErrorForDisplay(error: UserFriendlyError): string {
  let result = `## ${error.title}\n\n${error.message}`;
  if (error.suggestion) {
    result += `\n\n─────────────────────\n\n💡 **Suggestion**\n\n${error.suggestion}`;
  }
  return result;
}

