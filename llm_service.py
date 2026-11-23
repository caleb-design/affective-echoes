"""
Affective Echoes — built-in language model service (standard library only).

Runs Llama 3.2 3B Instruct locally through llama.cpp's `llama-server`, which
ships inside the app (bin/llama/...). No API key, no Ollama, no Python install
on the lab computer (the Windows release bundles a portable Python).

  * Finds the model and the engine both when run from source and from the
    packaged Windows folder (or a PyInstaller build, via sys._MEIPASS).
  * Starts the engine once, in the background, when the server starts, and keeps
    it loaded. Tries the GPU build (Vulkan / Metal) first and falls back to the
    CPU build if the GPU build won't start or can't answer a test request.
  * Caps context (4096 tokens) and threads so 8–16 GB laptops stay responsive.
  * Restarts the engine if it crashes.
  * Can download the model (with resume and a checksum check) if it's missing.
"""
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

MODEL_NAME = "Llama 3.2 3B"
MODEL_FILE = "Llama-3.2-3B-Instruct-Q4_K_M.gguf"
MODEL_URL = os.environ.get("AE_MODEL_URL", "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/" + MODEL_FILE)
MODEL_SIZE_HINT = 2_019_377_696          # bytes, for progress before the server says

CONTEXT_TOKENS = int(os.environ.get("AE_LLM_CONTEXT", "4096"))
LOAD_TIMEOUT_S = int(os.environ.get("AE_LLM_LOAD_TIMEOUT", "240"))
REPLY_TIMEOUT_S = int(os.environ.get("AE_LLM_REPLY_TIMEOUT", "120"))
IS_WINDOWS = os.name == "nt"


# ---------------------------------------------------------------------------
# Paths: source checkout, packaged Windows folder, or a frozen (PyInstaller) app
# ---------------------------------------------------------------------------
def app_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parent


def writable_root() -> Path:
    """Where logs and downloads go. Next to the executable for a frozen app, else the app root."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return app_root()


def models_dir() -> Path:
    d = writable_root() / "models"
    d.mkdir(parents=True, exist_ok=True)
    return d


def find_model():
    """The model file to load, or None. AE_MODEL_PATH overrides; otherwise models/<MODEL_FILE>, then any .gguf."""
    override = os.environ.get("AE_MODEL_PATH")
    if override:
        p = Path(override).expanduser()
        return p if p.is_file() else None
    for base in {app_root() / "models", models_dir()}:
        p = base / MODEL_FILE
        if p.is_file():
            return p
    for base in {app_root() / "models", models_dir()}:
        ggufs = sorted(base.glob("*.gguf"), key=lambda q: q.stat().st_size, reverse=True)
        if ggufs:
            return ggufs[0]
    return None


def engine_candidates():
    """(label, exe path, uses_gpu) in the order to try. AE_LLM_BACKEND=cpu|gpu narrows it."""
    exe = "llama-server.exe" if IS_WINDOWS else "llama-server"
    base = app_root() / "bin" / "llama"
    found = []
    for folder, label, gpu in [("vulkan", "GPU (Vulkan)", True), ("metal", "GPU (Metal)", True), ("cpu", "CPU", False)]:
        p = base / folder / exe
        if p.is_file():
            found.append((label, p, gpu))
    on_path = shutil.which("llama-server")          # developer machines with llama.cpp installed
    if on_path and not found:
        found += [("GPU (system llama.cpp)", Path(on_path), True), ("CPU (system llama.cpp)", Path(on_path), False)]
    want = os.environ.get("AE_LLM_BACKEND", "").lower()
    if want in ("cpu", "gpu"):
        found = [c for c in found if c[2] == (want == "gpu")]
    return found


def thread_count():
    logical = os.cpu_count() or 4
    # roughly the physical cores, leaving room for the browser and the UI
    return max(2, min(8, logical // 2))


def total_ram_gb():
    try:
        if IS_WINDOWS:
            import ctypes

            class MEMSTAT(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            m = MEMSTAT(); m.dwLength = ctypes.sizeof(MEMSTAT)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return m.ullTotalPhys / 2**30
        if Path("/proc/meminfo").exists():
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) / 2**20
    except Exception:
        pass
    return None


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _get(url, timeout=3):
    with urllib.request.urlopen(urllib.request.Request(url), timeout=timeout) as r:
        return r.status, r.read()


def _post_json(url, payload, timeout):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


# ---------------------------------------------------------------------------
# The service (one per process)
# ---------------------------------------------------------------------------
class LocalLLM:
    _instance = None

    @classmethod
    def get(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self):
        self.lock = threading.RLock()
        self.proc = None
        self.port = None
        self.state = "idle"        # idle | missing_model | missing_engine | downloading | starting | ready | error
        self.backend = None
        self.detail = ""
        self.model_path = None
        self.download = None       # {"done": bytes, "total": bytes, "error": str|None}
        self.load_seconds = None
        self._starter = None
        self._last_start = 0.0
        logs = writable_root() / "logs"
        logs.mkdir(exist_ok=True)
        self.log_path = logs / "llama-server.log"

    # ----- status for the UI -----
    def status(self):
        with self.lock:
            if self.state == "ready" and self.proc and self.proc.poll() is not None:
                self.state, self.detail = "error", "The built-in model stopped unexpectedly. It will restart on the next reply."
            return {
                "provider": "built-in", "model": MODEL_NAME, "state": self.state, "backend": self.backend,
                "detail": self.detail, "download": self.download, "model_file": MODEL_FILE,
                "model_url": MODEL_URL, "ram_gb": round(total_ram_gb() or 0, 1) or None,
                "load_seconds": self.load_seconds, "context": CONTEXT_TOKENS, "threads": thread_count(),
            }

    def available(self):
        return find_model() is not None and bool(engine_candidates())

    # ----- start / stop -----
    def start_async(self):
        with self.lock:
            if self.state in ("starting", "ready", "downloading"):
                return
            if self._starter and self._starter.is_alive():
                return
            if self.state == "error" and time.time() - self._last_start < 60:
                return                       # don't hammer a setup that just failed
            self._last_start = time.time()
            self._starter = threading.Thread(target=self._start, daemon=True, name="llm-start")
            self._starter.start()

    def _start(self):
        model = find_model()
        engines = engine_candidates()
        with self.lock:
            self.model_path = model
            if not model:
                self.state = "missing_model"
                self.detail = f"Put {MODEL_FILE} in the models folder, or download it from the console."
                return
            if not engines:
                self.state = "missing_engine"
                self.detail = "The llama.cpp engine isn't in bin/llama. Use the Windows release zip, or see the README."
                return
            self.state, self.detail, self.backend = "starting", "Loading the model into memory…", None
        t0 = time.time()
        errors = []
        for label, exe, gpu in engines:
            with self.lock:
                self.detail = f"Loading the model ({label})…"
            ok, why = self._launch(exe, model, gpu)
            if ok:
                with self.lock:
                    self.state, self.backend = "ready", label
                    self.load_seconds = round(time.time() - t0, 1)
                    self.detail = f"Ready on {label} in {self.load_seconds}s"
                print(f"  LLM:  {MODEL_NAME} ready on {label} ({self.load_seconds}s)", flush=True)
                return
            errors.append(f"{label}: {why}")
            print(f"  LLM:  {label} didn't work ({why}); trying the next option", flush=True)
            self._kill()
        with self.lock:
            self.state = "error"
            self.detail = "The built-in model couldn't start. " + "; ".join(errors) + f". Details in {self.log_path.name}."

    def _launch(self, exe, model, gpu):
        port = _free_port()
        args = [str(exe), "-m", str(model), "--host", "127.0.0.1", "--port", str(port),
                "-c", str(CONTEXT_TOKENS), "-t", str(thread_count()), "--parallel", "1",
                "-ngl", "99" if gpu else "0"]
        try:
            log = open(self.log_path, "ab")
            log.write(f"\n=== {time.ctime()} :: {' '.join(args)}\n".encode())
            log.flush()
            # Shares the console on Windows, so closing the app window also closes the engine.
            proc = subprocess.Popen(args, cwd=str(Path(exe).parent), stdout=log, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL)
        except OSError as e:
            return False, f"couldn't run ({e.strerror or e})"
        with self.lock:
            self.proc, self.port = proc, port
        deadline = time.time() + LOAD_TIMEOUT_S
        while time.time() < deadline:
            if proc.poll() is not None:
                return False, f"exited with code {proc.returncode}"
            try:
                code, body = _get(f"http://127.0.0.1:{port}/health", timeout=2)
                if code == 200:
                    break
            except urllib.error.HTTPError as e:      # 503 while the model is still loading
                if e.code != 503:
                    return False, f"health check HTTP {e.code}"
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(0.5)
        else:
            return False, f"didn't finish loading in {LOAD_TIMEOUT_S}s"
        # A tiny real request: a GPU build can load and still fail on the first token.
        try:
            r = _post_json(f"http://127.0.0.1:{port}/v1/chat/completions",
                           {"messages": [{"role": "user", "content": "Say OK."}], "max_tokens": 3, "temperature": 0},
                           timeout=90)
            r["choices"][0]["message"]
        except Exception as e:
            return False, f"test reply failed ({type(e).__name__})"
        return True, ""

    def _kill(self):
        with self.lock:
            p, self.proc = self.proc, None
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=8)
            except subprocess.TimeoutExpired:
                p.kill()

    def stop(self):
        self._kill()
        with self.lock:
            if self.state == "ready":
                self.state = "idle"

    # ----- replies -----
    def chat(self, system, messages, max_tokens=160, temperature=0.7):
        with self.lock:
            dead = self.proc is None or self.proc.poll() is not None
            state, port = self.state, self.port
        if state != "ready" or dead:
            if state in ("ready", "error", "idle"):
                with self.lock:
                    self.state = "idle"
                self.start_async()          # recover from a crash in the background
            raise RuntimeError(f"built-in model not ready ({self.status()['state']})")
        payload = {
            "messages": [{"role": "system", "content": system}] + list(messages),
            "max_tokens": max_tokens, "temperature": temperature,
            "cache_prompt": True,           # reuse the processed system prompt between turns
        }
        r = _post_json(f"http://127.0.0.1:{port}/v1/chat/completions", payload, timeout=REPLY_TIMEOUT_S)
        return r["choices"][0]["message"]["content"]

    # ----- model download (resumable, checksum-verified) -----
    def download_async(self):
        with self.lock:
            if self.state == "downloading" or find_model():
                return False
            self.state, self.detail = "downloading", "Downloading the model…"
            self.download = {"done": 0, "total": MODEL_SIZE_HINT, "error": None}
        threading.Thread(target=self._download, daemon=True, name="llm-download").start()
        return True

    def _download(self):
        dest = models_dir() / MODEL_FILE
        part = dest.with_suffix(".gguf.part")
        try:
            expected = None
            try:   # Hugging Face reports the file's SHA-256 in X-Linked-ETag
                head = urllib.request.Request(MODEL_URL, method="HEAD")
                with urllib.request.urlopen(head, timeout=30) as r:
                    etag = r.headers.get("X-Linked-ETag") or ""
                    total = int(r.headers.get("X-Linked-Size") or r.headers.get("Content-Length") or 0)
                    if total:
                        self.download["total"] = total
                    etag = etag.strip('"').lower()
                    if len(etag) == 64 and all(c in "0123456789abcdef" for c in etag):
                        expected = etag
            except Exception:
                pass
            have = part.stat().st_size if part.exists() else 0
            req = urllib.request.Request(MODEL_URL, headers={"Range": f"bytes={have}-"} if have else {})
            with urllib.request.urlopen(req, timeout=60) as r:
                if have and r.status != 206:      # server ignored the range: start over
                    have = 0
                length = int(r.headers.get("Content-Length") or 0)
                expected_total = (have + length) if length else int(self.download.get("total") or 0)
                if expected_total:
                    self.download["total"] = expected_total
                mode = "ab" if have else "wb"
                with open(part, mode) as f:
                    self.download["done"] = have
                    while True:
                        try:
                            chunk = r.read(1 << 20)
                        except Exception:          # connection dropped mid-file (IncompleteRead etc.)
                            break
                        if not chunk:
                            break
                        f.write(chunk)
                        self.download["done"] += len(chunk)
            got = part.stat().st_size
            if expected_total and got < expected_total:
                raise ConnectionError(f"the connection dropped at {got * 100 // expected_total}%")
            with self.lock:
                self.detail = "Checking the download…"
            if expected:
                h = hashlib.sha256()
                with open(part, "rb") as f:
                    for block in iter(lambda: f.read(1 << 22), b""):
                        h.update(block)
                if h.hexdigest() != expected:
                    part.unlink(missing_ok=True)
                    raise ValueError("the downloaded file didn't match its checksum, so it was deleted. Try again")
            part.replace(dest)
            with self.lock:
                self.state, self.download = "idle", None
            self.start_async()
        except Exception as e:
            with self.lock:
                self.state = "missing_model"
                msg = getattr(e, "reason", None) or str(e)
                self.download = {**(self.download or {}), "error": str(msg)}
                self.detail = f"The download stopped: {msg}. Click Download again to resume."


def describe_for_console():
    s = LocalLLM.get().status()
    return f"{MODEL_NAME} built in ({s['state']}{', ' + s['backend'] if s['backend'] else ''})"
