/**
 * Audio Recorder Utility (Windows)
 * Records microphone audio using PowerShell and Windows MCI APIs.
 * Uses a signal file to communicate stop command to the recording process.
 */

import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

export interface RecordingOptions {
    sampleRate?: number;
    channels?: number;
}

export class AudioRecorder {
    private recordingProcess: ChildProcess | null = null;
    private outputPath: string = "";
    private stopSignalPath: string = "";
    private scriptPath: string = "";

    /**
     * Start recording audio to a file using PowerShell and Windows MCI
     * @param outputPath - Path to save the WAV file
     * @param options - Recording options
     */
    async startRecording(outputPath: string, options: RecordingOptions = {}): Promise<void> {
        if (this.recordingProcess) {
            throw new Error("Recording already in progress");
        }

        this.outputPath = outputPath;
        this.stopSignalPath = path.join(path.dirname(outputPath), "_stop_signal");
        this.scriptPath = path.join(path.dirname(outputPath), "_record.ps1");

        // Ensure the output path is free so MCI can create the file
        if (fs.existsSync(this.outputPath)) {
            try {
                fs.unlinkSync(this.outputPath);
            } catch (err) {
                console.warn("Failed to remove existing recording file:", err);
            }
        }

        // Clean up any leftover signal file
        if (fs.existsSync(this.stopSignalPath)) {
            fs.unlinkSync(this.stopSignalPath);
        }

        // Escape backslashes for PowerShell
        const escapedOutputPath = outputPath.replace(/\\/g, "\\\\");
        const escapedSignalPath = this.stopSignalPath.replace(/\\/g, "\\\\");

        // PowerShell script that:
        // 1. Starts MCI recording
        // 2. Watches for a signal file
        // 3. When signal file appears, saves and closes the recording
        const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class AudioRecorder {
    [DllImport("winmm.dll", EntryPoint = "mciSendStringA", CharSet = CharSet.Ansi)]
    private static extern int mciSendString(string command, System.Text.StringBuilder buffer, int bufferSize, IntPtr callback);

    public static int SendCommand(string command) {
        return mciSendString(command, null, 0, IntPtr.Zero);
    }
}
"@

\$outputFile = "${escapedOutputPath}"
\$signalFile = "${escapedSignalPath}"

# Start recording
[AudioRecorder]::SendCommand("open new Type waveaudio Alias recsound")
[AudioRecorder]::SendCommand("record recsound")

Write-Host "Recording started, waiting for stop signal..."

# Wait for stop signal file to appear
while (-not (Test-Path \$signalFile)) {
    Start-Sleep -Milliseconds 100
}

Write-Host "Stop signal received, saving recording..."

# Save and close
[AudioRecorder]::SendCommand("save recsound \`"\$outputFile\`"")
[AudioRecorder]::SendCommand("close recsound")

Write-Host "Recording saved"

# Clean up signal file
Remove-Item \$signalFile -ErrorAction SilentlyContinue

exit 0
`.trim();

        fs.writeFileSync(this.scriptPath, psScript);

        try {
            // Start PowerShell process using native spawn (no promise rejection on kill)
            this.recordingProcess = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-File", this.scriptPath], {
                detached: false,
                stdio: ["ignore", "pipe", "pipe"],
            });

            // Log output for debugging
            this.recordingProcess.stdout?.on("data", (data: Buffer) => {
                console.log("[Recorder]", data.toString().trim());
            });

            this.recordingProcess.stderr?.on("data", (data: Buffer) => {
                console.error("[Recorder Error]", data.toString().trim());
            });

            // Handle process errors gracefully
            this.recordingProcess.on("error", (err) => {
                console.warn("Recording process error:", err);
            });

            this.recordingProcess.on("exit", (code, signal) => {
                if (code === 0) {
                    console.log("Recording process completed successfully");
                } else if (signal) {
                    console.log("Recording process terminated with signal", signal);
                } else {
                    console.warn("Recording process exited with code", code);
                }
            });

            // Give PowerShell a moment to start recording
            await new Promise((resolve) => setTimeout(resolve, 500));

            console.log("Recording started");
        } catch (err) {
            this.recordingProcess = null;
            throw err;
        }
    }

    /**
     * Stop recording and finalize the file
     */
    async stopRecording(): Promise<string> {
        if (!this.recordingProcess) {
            throw new Error("No recording in progress");
        }

        const filePath = this.outputPath;

        // Create the stop signal file to tell the PowerShell script to save and exit
        fs.writeFileSync(this.stopSignalPath, "stop");
        console.log("Stop signal sent");

        // Wait for the process to exit gracefully (it should save and close)
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                // Force kill if it takes too long
                console.warn("Recording process did not exit in time, force killing");
                if (this.recordingProcess) {
                    try {
                        this.recordingProcess.kill();
                    } catch (err) {
                        // Ignore
                    }
                }
                resolve();
            }, 5000);

            if (this.recordingProcess) {
                this.recordingProcess.on("exit", () => {
                    clearTimeout(timeout);
                    resolve();
                });
            } else {
                clearTimeout(timeout);
                resolve();
            }
        });

        this.recordingProcess = null;
        this.outputPath = "";

        // Clean up script file
        try {
            if (fs.existsSync(this.scriptPath)) {
                fs.unlinkSync(this.scriptPath);
            }
        } catch (e) {
            // Ignore cleanup errors
        }

        // Small delay to ensure file is fully written
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Verify the file exists and has content
        if (!fs.existsSync(filePath)) {
            throw new Error("Recording file was not created");
        }

        const stats = fs.statSync(filePath);
        if (stats.size < 100) {
            throw new Error("Recording file is too small (" + stats.size + " bytes), recording may have failed");
        }

        console.log("Recording saved:", filePath, "(" + stats.size + " bytes)");
        return filePath;
    }

    /**
     * Check if currently recording
     */
    isRecording(): boolean {
        return this.recordingProcess !== null;
    }

    /**
     * Cancel recording without saving
     */
    async cancelRecording(): Promise<void> {
        if (this.recordingProcess) {
            try {
                this.recordingProcess.kill();
            } catch (err) {
                // Ignore errors
            }
            this.recordingProcess = null;
        }

        // Delete the output file if it exists
        if (this.outputPath && fs.existsSync(this.outputPath)) {
            try {
                fs.unlinkSync(this.outputPath);
            } catch (e) {
                // Ignore
            }
        }

        // Clean up signal and script files
        try {
            if (this.stopSignalPath && fs.existsSync(this.stopSignalPath)) {
                fs.unlinkSync(this.stopSignalPath);
            }
            if (this.scriptPath && fs.existsSync(this.scriptPath)) {
                fs.unlinkSync(this.scriptPath);
            }
        } catch (e) {
            console.warn("Failed to clean up:", e);
        }

        this.outputPath = "";
        this.stopSignalPath = "";
        this.scriptPath = "";
    }
}
