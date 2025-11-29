import {
  Action,
  ActionPanel,
  Clipboard,
  Icon,
  List,
  showToast,
  Toast,
  popToRoot,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { execa } from "execa";
import { writeFile } from "fs/promises";
import { TranscriptionHistoryItem, getHistory, deleteTranscription, clearHistory } from "./history-storage";
import { RETURN_TO_ROOT } from "./config";

export default function ViewHistory() {
  const [history, setHistory] = useState<TranscriptionHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadHistory();
  }, []);

  async function loadHistory() {
    try {
      const items = await getHistory();
      setHistory(items);
    } catch (error) {
      console.error("Failed to load history:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to load history",
      });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteTranscription(id);
      await loadHistory();
      await showToast({
        style: Toast.Style.Success,
        title: "Deleted",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to delete",
      });
    }
  }

  async function handleClearAll() {
    try {
      await clearHistory();
      await loadHistory();
      await showToast({
        style: Toast.Style.Success,
        title: "History cleared",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to clear history",
      });
    }
  }

  async function handleCopy(text: string) {
    await Clipboard.copy(text);
    await showToast({
      style: Toast.Style.Success,
      title: "Copied",
    });
    if (RETURN_TO_ROOT) {
      await popToRoot({ clearSearchBar: true });
    }
  }

  async function handlePaste(text: string) {
    await Clipboard.copy(text);
    await Clipboard.paste(text);
    await showToast({
      style: Toast.Style.Success,
      title: "Pasted & Copied",
    });
    if (RETURN_TO_ROOT) {
      await popToRoot({ clearSearchBar: true });
    }
  }

  function formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  function truncateText(text: string, maxLength: number = 80): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + "...";
  }

  function escapeCsvField(field: string | number): string {
    const str = String(field);
    // If field contains comma, quote, or newline, wrap in quotes and escape quotes
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function convertToCSV(items: TranscriptionHistoryItem[]): string {
    // CSV headers
    const headers = [
      "ID",
      "Text",
      "Language",
      "Duration (s)",
      "Transcription Time (s)",
      "Model",
      "Device",
      "Timestamp",
      "Date",
    ];

    // Create CSV rows
    const rows = items.map((item) => {
      const date = new Date(item.timestamp).toISOString();
      return [
        escapeCsvField(item.id),
        escapeCsvField(item.text),
        escapeCsvField(item.language),
        escapeCsvField(item.duration.toFixed(2)),
        escapeCsvField(item.transcriptionTime.toFixed(2)),
        escapeCsvField(item.model),
        escapeCsvField(item.device),
        escapeCsvField(item.timestamp),
        escapeCsvField(date),
      ];
    });

    // Combine headers and rows
    const csvLines = [headers.join(","), ...rows.map((row) => row.join(","))];
    return csvLines.join("\n");
  }

  async function handleExportCSV() {
    try {
      if (history.length === 0) {
        await showToast({
          style: Toast.Style.Failure,
          title: "No data to export",
          message: "History is empty",
        });
        return;
      }

      const csv = convertToCSV(history);

      // Show Windows Save File Dialog using PowerShell
      const today = new Date().toISOString().split("T")[0];
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        $saveDialog = New-Object System.Windows.Forms.SaveFileDialog
        $saveDialog.Filter = "CSV files (*.csv)|*.csv|All files (*.*)|*.*"
        $saveDialog.FilterIndex = 1
        $saveDialog.DefaultExt = "csv"
        $saveDialog.FileName = "transcription-history-${today}.csv"
        $saveDialog.RestoreDirectory = $true
        
        if ($saveDialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
          Write-Output $saveDialog.FileName
        }
      `;

      await showToast({
        style: Toast.Style.Animated,
        title: "Opening save dialog...",
      });

      const { stdout } = await execa("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript]);
      const filePath = stdout.trim();

      if (!filePath) {
        // User cancelled the dialog
        await showToast({
          style: Toast.Style.Failure,
          title: "Export cancelled",
        });
        return;
      }

      // Write CSV to file
      await writeFile(filePath, csv, "utf-8");

      await showToast({
        style: Toast.Style.Success,
        title: "Exported to CSV",
        message: `Saved ${history.length} transcription(s) to file`,
      });
    } catch (error) {
      console.error("Failed to export CSV:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Export failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (isLoading) {
    return <List isLoading={true} />;
  }

  if (history.length === 0) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Document}
          title="No transcription history"
          description="Your transcriptions will appear here after you record and transcribe audio."
        />
      </List>
    );
  }

  return (
    <List
      searchBarPlaceholder="Search transcriptions..."
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action
            title="Export to CSV"
            icon={Icon.Document}
            onAction={handleExportCSV}
            shortcut={{ modifiers: ["cmd"], key: "e" }}
          />
          <Action
            title="Clear All History"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            onAction={handleClearAll}
            shortcut={{ modifiers: ["cmd", "shift"], key: "delete" }}
          />
        </ActionPanel>
      }
    >
      {history.map((item) => (
        <List.Item
          key={item.id}
          title={truncateText(item.text)}
          subtitle={`${item.language} · ${item.model} · ${item.device.toUpperCase()}`}
          accessories={[
            { text: formatDate(item.timestamp) },
            { text: `${item.duration.toFixed(1)}s` },
          ]}
          detail={
            <List.Item.Detail
              markdown={item.text}
              metadata={
                <List.Item.Detail.Metadata>
                  <List.Item.Detail.Metadata.Label title="Text" text={item.text} />
                  <List.Item.Detail.Metadata.Separator />
                  <List.Item.Detail.Metadata.Label title="Language" text={item.language} />
                  <List.Item.Detail.Metadata.Label title="Model" text={item.model} />
                  <List.Item.Detail.Metadata.Label title="Device" text={item.device.toUpperCase()} />
                  <List.Item.Detail.Metadata.Separator />
                  <List.Item.Detail.Metadata.Label title="Audio Duration" text={`${item.duration.toFixed(1)}s`} />
                  <List.Item.Detail.Metadata.Label title="Transcription Time" text={`${item.transcriptionTime.toFixed(1)}s`} />
                  <List.Item.Detail.Metadata.Label title="Date" text={new Date(item.timestamp).toLocaleString()} />
                </List.Item.Detail.Metadata>
              }
            />
          }
          actions={
            <ActionPanel>
              <Action title="Paste" icon={Icon.Text} onAction={() => handlePaste(item.text)} />
              <ActionPanel.Section>
                <Action title="Copy" icon={Icon.Clipboard} onAction={() => handleCopy(item.text)} shortcut={{ modifiers: ["ctrl"], key: "c" }} />
              </ActionPanel.Section>
              <ActionPanel.Section>
                <Action
                  title="Export to CSV"
                  icon={Icon.Document}
                  onAction={handleExportCSV}
                  shortcut={{ modifiers: ["cmd"], key: "e" }}
                />
                <Action
                  title="Delete"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={() => handleDelete(item.id)}
                  shortcut={{ modifiers: ["ctrl"], key: "delete" }}
                />
                <Action
                  title="Clear All History"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={handleClearAll}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "delete" }}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

