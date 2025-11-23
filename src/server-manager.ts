/**
 * Server Manager
 * Manages the Python transcription server lifecycle
 */

import { execa, ResultPromise } from "execa";
import axios from "axios";
import { BACKEND_DIR, SERVER_URL, SERVER_PORT } from "./config";

const HEALTH_ENDPOINT = `${SERVER_URL}/health`;

let serverProcess: ResultPromise | null = null;

/**
 * Check if the server is running and healthy
 */
export async function isServerRunning(): Promise<boolean> {
    try {
        const response = await axios.get(HEALTH_ENDPOINT, { timeout: 2000 });
        return response.status === 200 && response.data.status === "healthy";
    } catch (error) {
        return false;
    }
}

/**
 * Start the Python transcription server
 */
export async function startServer(): Promise<void> {
    if (serverProcess) {
        console.log("Server process already running");
        return;
    }

    console.log(`Starting server from:${BACKEND_DIR}`);

    try {
        // Start server using UV
        serverProcess = execa("uv", ["run", "python", "transcription_server.py"], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                WHISPER_MODEL: process.env.WHISPER_MODEL || "base",
                WHISPER_SERVER_HOST: "127.0.0.1",
                WHISPER_SERVER_PORT: String(SERVER_PORT),
            },
            detached: false,
            cleanup: true,
        });

        // Log server output
        if (serverProcess.stdout) {
            serverProcess.stdout.on("data", (data: Buffer) => {
                console.log(`[Server] ${data.toString()}`);
            });
        }

        if (serverProcess.stderr) {
            serverProcess.stderr.on("data", (data: Buffer) => {
                console.error(`[Server Error] ${data.toString()}`);
            });
        }

        serverProcess.on("exit", (code: number | null) => {
            console.log(`Server exited with code ${code}`);
            serverProcess = null;
        });

        // Wait for server to be ready (poll health endpoint)
        const maxRetries = 30; // 30 seconds
        for (let i = 0; i < maxRetries; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (await isServerRunning()) {
                console.log("Server is ready!");
                return;
            }
        }

        throw new Error("Server failed to start within 30 seconds");
    } catch (error) {
        console.error("Failed to start server:", error);
        serverProcess = null;
        throw error;
    }
}

/**
 * Stop the server
 */
export async function stopServer(): Promise<void> {
    if (serverProcess) {
        console.log("Stopping server...");
        serverProcess.kill();
        serverProcess = null;
    }
}

/**
 * Ensure server is running, start if needed
 */
export async function ensureServerRunning(): Promise<void> {
    if (await isServerRunning()) {
        console.log("Server is already running");
        return;
    }

    console.log("Server not running, starting...");
    await startServer();
}

/**
 * Get server URL
 */
export function getServerUrl(): string {
    return SERVER_URL;
}
