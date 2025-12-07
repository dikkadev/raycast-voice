# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "requests>=2.32",
#   "pyperclip>=1.8",
#   "customtkinter",
#   "packaging",
# ]
# ///

"""
Minimal GUI to remote-control the transcription backend.

Usage with uv:
  uv run extra-ui/voice_gui.py

Behavior:
  - Start -> POST /record/start
  - While recording -> poll GET /record/level every ~100ms and show a volume bar
  - Stop -> POST /record/stop, extract "text", copy to clipboard

Backend URL can be overridden with VOICE_BACKEND_URL (default http://127.0.0.1:51234).
"""

import os
import threading
import time
import tkinter as tk  # Needed for some constants or variable types
import customtkinter as ctk
import pyperclip
import requests

# Set Appearance and Theme
ctk.set_appearance_mode("Dark")
ctk.set_default_color_theme("dark-blue")

class VoiceGUI:
    def __init__(self, root: ctk.CTk):
        self.root = root
        self.base_url = os.environ.get("VOICE_BACKEND_URL", "http://127.0.0.1:51234")
        self.session = requests.Session()

        self.recording = False
        self.poll_stop = threading.Event()
        self.poll_thread: threading.Thread | None = None
        self.level_max = 0.05  # track max observed level to normalize display

        # UI Variables
        self.base_url_var = ctk.StringVar(value=self.base_url)
        self.model_var = ctk.StringVar(value="")
        self.server_status_var = ctk.StringVar(value="Checking...")
        
        # Build layout
        self._build_ui()
        
        # Initial async tasks
        self.root.after(150, self.fetch_config_async)
        self.root.after(300, self.poll_server_status_async)
        
        # Bindings
        self.root.bind("<Return>", self._on_return_key)
        self.root.bind("<Button-1>", self._on_click_anywhere) # Capture global clicks to clear focus
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    def _build_ui(self) -> None:
        self.root.title("Voice Remote")
        self.root.geometry("400x550")
        self.root.minsize(350, 500)
        
        # Configure Grid Layout
        self.root.grid_columnconfigure(0, weight=1)
        self.root.grid_rowconfigure(0, weight=0)  # Top (Status)
        self.root.grid_rowconfigure(1, weight=0)  # Middle (Action)
        self.root.grid_rowconfigure(2, weight=1)  # Bottom (Output) - expands

        # --- Top Section: Server Status & Config ---
        self.top_frame = ctk.CTkFrame(self.root, corner_radius=10)
        self.top_frame.grid(row=0, column=0, sticky="ew", padx=20, pady=(20, 10))
        self.top_frame.grid_columnconfigure(1, weight=1)

        # Status Label
        self.lbl_status_title = ctk.CTkLabel(self.top_frame, text="Server Status:", font=("Arial", 12, "bold"))
        self.lbl_status_title.grid(row=0, column=0, sticky="w", padx=10, pady=(10, 5))
        
        self.lbl_status_val = ctk.CTkLabel(self.top_frame, textvariable=self.server_status_var, text_color="gray")
        self.lbl_status_val.grid(row=0, column=1, sticky="w", padx=5, pady=(10, 5))

        # URL Input
        self.lbl_url = ctk.CTkLabel(self.top_frame, text="URL:")
        self.lbl_url.grid(row=1, column=0, sticky="e", padx=10, pady=5)
        
        self.entry_url = ctk.CTkEntry(self.top_frame, textvariable=self.base_url_var, height=28)
        self.entry_url.grid(row=1, column=1, sticky="ew", padx=(0, 10), pady=5)

        # Model Input
        self.lbl_model = ctk.CTkLabel(self.top_frame, text="Model:")
        self.lbl_model.grid(row=2, column=0, sticky="e", padx=10, pady=(5, 15))
        
        self.entry_model = ctk.CTkEntry(self.top_frame, textvariable=self.model_var, height=28, placeholder_text="Loading...")
        self.entry_model.grid(row=2, column=1, sticky="ew", padx=(0, 10), pady=(5, 15))

        # Buttons Frame
        self.config_btn_frame = ctk.CTkFrame(self.top_frame, fg_color="transparent")
        self.config_btn_frame.grid(row=3, column=0, columnspan=2, sticky="ew", padx=10, pady=(0, 10))
        self.config_btn_frame.grid_columnconfigure(0, weight=1)
        self.config_btn_frame.grid_columnconfigure(1, weight=1)
        
        self.btn_apply = ctk.CTkButton(self.config_btn_frame, text="Apply Config", height=28, command=self.apply_config_async)
        self.btn_apply.grid(row=0, column=0, padx=(0, 5), sticky="ew")

        self.btn_restart = ctk.CTkButton(self.config_btn_frame, text="Restart Srv", height=28, fg_color="#555555", hover_color="#333333", command=self.restart_server_async)
        self.btn_restart.grid(row=0, column=1, padx=(5, 0), sticky="ew")

        # Auto-minimize - Explicitly added to this frame
        self.check_minimize = ctk.CTkCheckBox(self.top_frame, text="Auto-minimize", onvalue=True, offvalue=False)
        self.check_minimize.select()
        self.check_minimize.grid(row=4, column=0, columnspan=2, sticky="w", padx=10, pady=(0, 10))


        # --- Middle Section: Action ---
        self.action_frame = ctk.CTkFrame(self.root, corner_radius=10)
        self.action_frame.grid(row=1, column=0, sticky="ew", padx=20, pady=10)
        self.action_frame.grid_columnconfigure(0, weight=1)

        # Record Button
        self.btn_record = ctk.CTkButton(
            self.action_frame, 
            text="Record", 
            font=("Arial", 16, "bold"),
            height=60, 
            corner_radius=10,
            command=self.toggle_recording
        )
        self.btn_record.grid(row=0, column=0, sticky="ew", padx=20, pady=(20, 10))

        # Audio Level Bar
        self.progress_bar = ctk.CTkProgressBar(self.action_frame, height=12, corner_radius=6)
        self.progress_bar.set(0.0)
        self.progress_bar.grid(row=1, column=0, sticky="ew", padx=20, pady=(0, 20))
        
        # Clipboard Status Label (New)
        self.lbl_clipboard = ctk.CTkLabel(self.action_frame, text="", text_color="#aaaaaa", font=("Arial", 11))
        self.lbl_clipboard.grid(row=2, column=0, sticky="ew", padx=20, pady=(0, 10))
        
        # --- Bottom Section: Output ---
        # Direct textbox looks better if filling space
        self.textbox = ctk.CTkTextbox(
            self.root, 
            corner_radius=10, 
            font=("Consolas", 12),
            activate_scrollbars=True
        )
        self.textbox.grid(row=2, column=0, sticky="nsew", padx=20, pady=(10, 20))
        self.textbox.insert("0.0", "Transcription will appear here...")
        self.textbox.configure(state="disabled")

    # --- Logic ---

    def toggle_recording(self) -> None:
        if self.recording:
            self.stop_recording()
        else:
            self.start_recording()

    def start_recording(self) -> None:
        self.lbl_clipboard.configure(text="") # Clear old status
        self._set_status_ui(recording=True, msg="Starting...")
        self.btn_record.configure(state="disabled", text="Starting...")
        threading.Thread(target=self._start_request, daemon=True).start()

    def _start_request(self) -> None:
        try:
            resp = self.session.post(f"{self.base_url}/record/start", timeout=5)
            resp.raise_for_status()
        except Exception as exc:
            self.root.after(0, lambda: self._show_error(f"Start failed: {exc}"))
            return
        self.root.after(0, self._on_start_success)

    def _on_start_success(self) -> None:
        self.recording = True
        self._set_status_ui(recording=True, msg="Recording...")
        self._set_record_btn_style(recording=True)
        self._set_transcription_text("")
        self.level_max = 0.05

        self.poll_stop.clear()
        if not self.poll_thread or not self.poll_thread.is_alive():
            self.poll_thread = threading.Thread(target=self._poll_levels, daemon=True)
            self.poll_thread.start()

    def _poll_levels(self) -> None:
        while not self.poll_stop.is_set():
            try:
                resp = self.session.get(f"{self.base_url}/record/level", timeout=2)
                resp.raise_for_status()
                level = float(resp.json().get("level", 0.0))
                # Clamp
                level = max(0.0, min(1.0, level))
                self.root.after(0, lambda lvl=level: self._update_level_bar(lvl))
            except Exception:
                pass
            time.sleep(0.1)

    def stop_recording(self) -> None:
        self._set_status_ui(recording=False, msg="Stopping...")
        self.btn_record.configure(state="disabled", text="Stopping...")
        self.poll_stop.set()
        threading.Thread(target=self._stop_request, daemon=True).start()

    def _stop_request(self) -> None:
        if self.poll_thread and self.poll_thread.is_alive():
            self.poll_thread.join(timeout=1.0)

        try:
            resp = self.session.post(f"{self.base_url}/record/stop", timeout=60)
            resp.raise_for_status()
            data = resp.json()
            text = data.get("text", "") or ""
        except Exception as exc:
            self.root.after(0, lambda: self._show_error(f"Stop failed: {exc}"))
            return

        copied = False
        try:
            pyperclip.copy(text)
            copied = True
        except Exception:
            pass
        self.root.after(0, lambda: self._on_stop_success(text, copied))

    def _on_stop_success(self, text: str, copied: bool) -> None:
        self.recording = False
        self._set_status_ui(recording=False, msg="Done")
        self._update_level_bar(0.0)
        self._set_record_btn_style(recording=False)
        self._set_transcription_text(text)
        
        if copied:
             self.lbl_clipboard.configure(text="Result copied to clipboard!", text_color="#4caf50")
        else:
             self.lbl_clipboard.configure(text="Clipboard copy failed.", text_color="#e53935")
        
        if self.check_minimize.get():
             self.root.after(0, self._try_minimize)

    def _update_level_bar(self, level: float) -> None:
        # Normalize visually
        self.level_max = max(level, self.level_max * 0.98)
        norm = 0.0 if self.level_max <= 1e-4 else level / self.level_max
        norm = max(0.0, min(1.0, norm))
        self.progress_bar.set(norm)

    def _set_record_btn_style(self, recording: bool) -> None:
        if recording:
            self.btn_record.configure(
                state="normal", 
                text="Stop Recording",
                fg_color="red", 
                hover_color="darkred"
            )
        else:
            self.btn_record.configure(
                state="normal", 
                text="Record",
                fg_color=["#3B8ED0", "#1F6AA5"], # Default theme blue-ish
                hover_color=["#36719F", "#144870"]
            )

    def _set_status_ui(self, recording: bool, msg: str) -> None:
        pass

    def _set_transcription_text(self, text: str) -> None:
        self.textbox.configure(state="normal")
        self.textbox.delete("0.0", "end")
        if text:
            self.textbox.insert("0.0", text.strip())
        self.textbox.configure(state="disabled")

    def _show_error(self, message: str) -> None:
        self.recording = False
        self.poll_stop.set()
        self._update_level_bar(0.0)
        self._set_record_btn_style(recording=False)
        self._set_transcription_text(f"Error: {message}")

    def _try_minimize(self) -> None:
        try:
            self.root.iconify()
        except:
            pass

    def _on_click_anywhere(self, event):
        # Allow focus to leave input fields when clicking background
        widget = event.widget
        # If the clicked widget is the root frame or a container frame, reset focus
        # ctk.CTkFrame or standard Frame or the root window itself.
        # This allows keybinds like <Return> to work again.
        if isinstance(widget, (ctk.CTk, ctk.CTkFrame, tk.Frame, tk.Canvas)):
            self.root.focus_set()

    def _on_return_key(self, event):
        # Check current focus
        focused = self.root.focus_get()
        # If currently focused widget is an entry or text-like, ignore Enter for recording
        if isinstance(focused, (ctk.CTkEntry, ctk.CTkTextbox, tk.Entry, tk.Text)):
             return
             
        # Also double check origin widget just in case
        if isinstance(event.widget, (ctk.CTkEntry, ctk.CTkTextbox, tk.Entry, tk.Text)):
             return

        self.toggle_recording()

    def _on_close(self):
        self.poll_stop.set()
        self.root.destroy()
        os._exit(0) # Force kill threads

    # --- Config & Async ---

    def fetch_config_async(self):
        threading.Thread(target=self._fetch_config, daemon=True).start()

    def _fetch_config(self):
        try:
            resp = self.session.get(f"{self.base_url}/config", timeout=4)
            resp.raise_for_status()
            data = resp.json()
        except:
            self.root.after(0, lambda: self.server_status_var.set("Offline"))
            return

        def _apply():
            self.model_var.set(str(data.get("model", "")))
            self.server_status_var.set("Online")
            self.lbl_status_val.configure(text_color="#4caf50") # Green
        self.root.after(0, _apply)

    def apply_config_async(self):
        threading.Thread(target=self._apply_config, daemon=True).start()

    def _apply_config(self):
        new_url = self.base_url_var.get().strip()
        if new_url:
            self.base_url = new_url
        
        payload = {
            "model": self.model_var.get() or None,
        }
        
        try:
            self.root.after(0, lambda: self.server_status_var.set("Applying..."))
            resp = self.session.post(f"{self.base_url}/config", json=payload, timeout=8)
            resp.raise_for_status()
            self.root.after(0, lambda: self.server_status_var.set("Online (Updated)"))
        except Exception as e:
            self.root.after(0, lambda: self.server_status_var.set(f"Error"))

    def restart_server_async(self):
        threading.Thread(target=self._restart_server, daemon=True).start()

    def _restart_server(self):
        self.root.after(0, lambda: self.server_status_var.set("Restarting..."))
        try:
            self.session.post(f"{self.base_url}/shutdown", timeout=3)
        except:
            pass
        
        # Poll for return
        start = time.time()
        while time.time() - start < 15:
            try:
                resp = self.session.get(f"{self.base_url}/health", timeout=2)
                if resp.ok:
                    self.root.after(0, lambda: self.server_status_var.set("Online (Restarted)"))
                    self.root.after(0, lambda: self.lbl_status_val.configure(text_color="#4caf50"))
                    return
            except:
                time.sleep(1)
        
        self.root.after(0, lambda: self.server_status_var.set("Timeout"))

    def poll_server_status_async(self):
        threading.Thread(target=self._poll_server_status, daemon=True).start()

    def _poll_server_status(self):
        try:
            resp = self.session.get(f"{self.base_url}/health", timeout=3)
            ok = resp.ok
        except:
            ok = False
        
        def _update():
            if ok:
                self.server_status_var.set("Online")
                self.lbl_status_val.configure(text_color="#4caf50")
            else:
                self.server_status_var.set("Offline")
                self.lbl_status_val.configure(text_color="#e53935") # Red
        
        self.root.after(0, _update)
        self.root.after(5000, self.poll_server_status_async)

def main():
    app = ctk.CTk()
    VoiceGUI(app)
    app.mainloop()

if __name__ == "__main__":
    main()
