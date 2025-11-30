/**
 * Server Manager
 * Manages the Python transcription server lifecycle
 */

import { execa, ResultPromise } from "execa";
import axios from "axios";
import { BACKEND_DIR, SERVER_URL, SERVER_PORT, getServerConfig, getConfigFingerprint, SERVER_BUILD_ID } from "./config";
import * as net from "net";

const HEALTH_ENDPOINT = `${SERVER_URL}/health`;
const SHUTDOWN_ENDPOINT = `${SERVER_URL}/shutdown`;
const PORT_CONFLICT_MESSAGE = (port: number) =>
  `Port ${port} is already in use by another application.\n\n` +
  `Please either:\n` +
  `• Close the application using port ${port}\n` +
  `• Change the server port in extension preferences`;

let serverProcess: ResultPromise | null = null;
let currentConfigFingerprint: string | null = null;

export interface ServerStatus {
  running: boolean;
  isOurServer: boolean;
  portInUse?: boolean;
  model?: string;
  liveModel?: string;
  device?: string;
  computeType?: string;
  configMismatch?: boolean;
  deviceFallback?: boolean;
  buildId?: string | null;
}

/**
 * Check if a port is in use
 */
async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Get PID of process listening on a port
 */
async function getPidOnPort(port: number): Promise<number | null> {
  try {
    if (process.platform === "win32") {
      const psScript = `
        try {
          $conn = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1
          if ($conn -and $conn.OwningProcess) { Write-Output $conn.OwningProcess }
        } catch { }
      `;
      const { stdout } = await execa("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript]);
      const pid = parseInt(stdout.trim(), 10);
      return Number.isFinite(pid) ? pid : null;
    }

    // Unix/macOS fallback
    const { stdout } = await execa("lsof", ["-ti", `tcp:${port}`]);
    const firstLine = stdout.trim().split("\n").filter(Boolean)[0];
    const pid = parseInt(firstLine, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Force kill process by PID
 */
async function forceKillPid(pid: number): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await execa("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Id ${pid} -Force`]);
    } else if (process.platform === "darwin" || process.platform === "linux") {
      await execa("kill", ["-9", String(pid)]);
    } else {
      return false;
    }
    return true;
  } catch (error) {
    console.error(`Failed to kill PID ${pid}:`, error);
    return false;
  }
}

/**
 * Wait until port is released or timeout
 */
async function waitForPortRelease(port: number, timeoutMs = 10000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await isPortInUse(port))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

/**
 * Check if our Whisper server is running on the port
 */
async function isOurServerOnPort(): Promise<{ isOurs: boolean; healthy: boolean; data?: Record<string, unknown> }> {
  try {
    const response = await axios.get(HEALTH_ENDPOINT, { timeout: 2000 });
    // Check if response looks like our server
    if (response.status === 200 && response.data && typeof response.data.status === "string") {
      return {
        isOurs: true,
        healthy: response.data.status === "healthy",
        data: response.data,
      };
    }
    return { isOurs: false, healthy: false };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      // Connection refused = nothing on port
      if (error.code === "ECONNREFUSED") {
        return { isOurs: false, healthy: false };
      }
      // Got a response but not what we expected = something else on port
      if (error.response) {
        return { isOurs: false, healthy: false };
      }
    }
    return { isOurs: false, healthy: false };
  }
}

/**
 * Check if the server is running and healthy
 */
export async function isServerRunning(): Promise<boolean> {
  const check = await isOurServerOnPort();
  return check.isOurs && check.healthy;
}

/**
 * Get detailed server status including config
 */
export async function getServerStatus(): Promise<ServerStatus> {
  const check = await isOurServerOnPort();

  if (!check.isOurs || !check.healthy || !check.data) {
    // Check if port is in use by something else
    const portUsed = await isPortInUse(SERVER_PORT);
    return {
      running: false,
      isOurServer: false,
      portInUse: portUsed,
    };
  }

  const data = check.data;
  const expectedConfig = getServerConfig();

  const modelMismatch = data.model !== expectedConfig.model;
  const liveModelMismatch = data.live_model !== expectedConfig.liveModel;
  const deviceDiffers = data.device !== expectedConfig.device;

  let configMismatch = modelMismatch || liveModelMismatch;
  let deviceFallback = false;

  if (!configMismatch) {
    if (expectedConfig.device === "cpu") {
      configMismatch = data.device !== "cpu";
    } else if (deviceDiffers) {
      // User asked for CUDA but we fell back to CPU - treat as fallback, not mismatch
      deviceFallback = true;
    }
  }

  if (configMismatch) {
    console.log(
      `Config mismatch detected. Running model=${data.model} device=${data.device}, expected model=${expectedConfig.model} device=${expectedConfig.device}`
    );
  }

  return {
    running: true,
    isOurServer: true,
    portInUse: true,
    model: data.model as string,
    liveModel: (data.live_model as string) || undefined,
    device: data.device as string,
    computeType: data.compute_type as string,
    configMismatch,
    deviceFallback,
    buildId: (data.build_id as string) || null,
  };
}

/**
 * Check if server config matches current preferences
 */
export async function checkConfigMatch(): Promise<boolean> {
  const status = await getServerStatus();
  return status.running && !status.configMismatch;
}

/**
 * Start the Python transcription server (internal - doesn't check existing)
 */
async function launchServer(): Promise<void> {
  if (serverProcess) {
    console.log("Server process reference exists, cleaning up...");
    serverProcess = null;
  }

  const config = getServerConfig();
  console.log(`Starting server from: ${BACKEND_DIR}`);
  console.log(`Config: model=${config.model}, liveModel=${config.liveModel}, device=${config.device}, port=${config.port}`);

  try {
    // Start server using UV with command line arguments
    serverProcess = execa(
      "uv",
      [
        "run",
        "python",
        "transcription_server.py",
        "--host",
        "127.0.0.1",
        "--port",
        String(config.port),
        "--model",
        config.model,
        "--device",
        config.device,
        "--compute-type",
        config.computeType,
        "--live-model",
        config.liveModel,
      ],
      {
        cwd: BACKEND_DIR,
        detached: false,
        cleanup: true,
      }
    );

    // Log server output
    if (serverProcess.stdout) {
      serverProcess.stdout.on("data", (data: Buffer) => {
        console.log(`[Server] ${data.toString()}`);
      });
    }

    if (serverProcess.stderr) {
      serverProcess.stderr.on("data", (data: Buffer) => {
        console.error(`[Server] ${data.toString()}`);
      });
    }

    serverProcess.on("exit", (code: number | null) => {
      console.log(`Server exited with code ${code}`);
      serverProcess = null;
      currentConfigFingerprint = null;
    });

    // Wait for server to be ready
    const maxRetries = 60; // 60 seconds for model download
    for (let i = 0; i < maxRetries; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (await isServerRunning()) {
        console.log("Server is ready!");
        currentConfigFingerprint = getConfigFingerprint();
        return;
      }
    }

    throw new Error("Server failed to start within 60 seconds. Check that the backend is configured correctly.");
  } catch (error) {
    console.error("Failed to start server:", error);
    serverProcess = null;
    currentConfigFingerprint = null;
    throw error;
  }
}

/**
 * Start the server - checks for existing server first
 */
export async function startServer(): Promise<void> {
  // Check if port is in use
  const portInUse = await isPortInUse(SERVER_PORT);

  if (portInUse) {
    // Check if it's our server
    const check = await isOurServerOnPort();
    if (check.isOurs && check.healthy) {
      console.log("Server already running");
      return;
    }
    // Something else is using the port
    if (!check.isOurs) {
      throw new Error(PORT_CONFLICT_MESSAGE(SERVER_PORT));
    }
  }

  await launchServer();
}

/**
 * Stop the server gracefully
 */
export async function stopServer(): Promise<void> {
  // Try graceful shutdown via API first
  try {
    await axios.post(SHUTDOWN_ENDPOINT, null, { timeout: 2000 });
    // Wait a moment for shutdown
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch {
    // Server might already be down
  }

  // Force kill if still running
  if (serverProcess) {
    console.log("Force stopping server...");
    serverProcess.kill();
    serverProcess = null;
  }

  currentConfigFingerprint = null;

  await waitForPortRelease(SERVER_PORT, 8000);
}

/**
 * Restart server with current config
 */
export async function restartServer(): Promise<void> {
  console.log("Restarting server with new config...");
  await stopServer();

  // Make sure nothing is still listening on the port before launching again
  const statusAfterStop = await getServerStatus();
  if (statusAfterStop.running && statusAfterStop.isOurServer) {
    console.warn("Existing Whisper server did not shut down gracefully, attempting force kill...");
    const pid = await getPidOnPort(SERVER_PORT);
    if (pid) {
      const killed = await forceKillPid(pid);
      if (killed) {
        await waitForPortRelease(SERVER_PORT, 8000);
      } else {
        throw new Error(
          `Failed to stop the existing Whisper server (PID ${pid}).\n\n` +
            `Please close that Python process manually or change the server port in preferences, then try again.`
        );
      }
    } else {
      throw new Error(
        `An existing Whisper server is still running with model=${statusAfterStop.model} (${statusAfterStop.device}).\n\n` +
          `Please close that Python process manually or change the server port in preferences, then try again.`
      );
    }
  }

  await launchServer(); // Use launchServer directly, not startServer
}

/**
 * Ensure server is running with correct config, restart if needed
 */
export async function ensureServerRunning(): Promise<void> {
  const desiredConfig = getServerConfig();
  const desiredFingerprint = getConfigFingerprint();
  const status = await getServerStatus();

  if (status.running && status.isOurServer) {
    if (!status.buildId || status.buildId !== SERVER_BUILD_ID) {
      console.log(
        `Backend build mismatch detected (running=${status.buildId || "unknown"}, expected=${SERVER_BUILD_ID}). Restarting...`
      );
      await restartServer();
      return;
    }

    // If we previously launched the server, compare fingerprints to detect preference changes
    if (currentConfigFingerprint && currentConfigFingerprint !== desiredFingerprint) {
      console.log("Preferences updated, restarting server...");
      await restartServer();
      return;
    }

    // If we attached to an already running server (current fingerprint unknown), validate it once
    if (!currentConfigFingerprint) {
      const modelMismatch = status.model !== desiredConfig.model;
      const deviceMismatch = desiredConfig.device === "cpu" ? status.device !== "cpu" : false;

      if (modelMismatch || deviceMismatch) {
        console.log("Running server uses different config, restarting...");
        await restartServer();
        return;
      }

      currentConfigFingerprint = desiredFingerprint;
    }

    console.log("Server already running with desired config");
    return;
  }

  // Check for port conflict before starting
  if (status.portInUse && !status.isOurServer) {
    throw new Error(PORT_CONFLICT_MESSAGE(SERVER_PORT));
  }

  console.log("Server not running, starting...");
  await launchServer();
}

/**
 * Get server URL
 */
export function getServerUrl(): string {
  return SERVER_URL;
}
