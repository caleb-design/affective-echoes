#!/usr/bin/env python3
"""
Build the self-contained Windows release of Affective Echoes.

Produces dist/Affective-Echoes/ and dist/Affective-Echoes-Windows-v<version>.zip containing:
  - the app (server.py, llm_service.py, public/, tools/)
  - a portable Python for Windows (runtime/python)  -> nothing to install
  - llama.cpp's llama-server for Windows, CPU and Vulkan builds (bin/llama/cpu, bin/llama/vulkan)
  - the model, Llama 3.2 3B Instruct Q4_K_M (models/)
  - licenses and the "Built with Llama" notice (LICENSES/)

Runs on any OS with Python 3.9+ and internet (GitHub Actions uses it on Windows).

  python tools/build_windows.py                       # everything, latest llama.cpp release
  python tools/build_windows.py --llama-tag b6000     # pin a llama.cpp release
  python tools/build_windows.py --model-path my.gguf  # use a model you already downloaded
  python tools/build_windows.py --no-model            # small zip; the app offers the download on first run
"""
import argparse
import hashlib
import io
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import llm_service  # noqa: E402

PY_VERSION = "3.12.10"   # last 3.12 release with a Windows embeddable build
URLS = {
    "llama_api": os.environ.get("AE_BUILD_LLAMA_API", "https://api.github.com/repos/ggml-org/llama.cpp/releases"),
    "python": os.environ.get("AE_BUILD_PY_URL", f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"),
    "model": os.environ.get("AE_BUILD_MODEL_URL", llm_service.MODEL_URL),
    "llama_license": os.environ.get("AE_BUILD_LLAMA_LICENSE_URL", "https://raw.githubusercontent.com/meta-llama/llama-models/main/models/llama3_2/LICENSE"),
    "llama_aup": os.environ.get("AE_BUILD_LLAMA_AUP_URL", "https://raw.githubusercontent.com/meta-llama/llama-models/main/models/llama3_2/USE_POLICY.md"),
}
ASSETS = {"cpu": r"bin-win-cpu-x64\.zip$", "vulkan": r"bin-win-vulkan-x64\.zip$"}
APP_FILES = ["server.py", "llm_service.py", "model_server_stub.py", "README.md", ".env.example",
             "Start Affective Echoes (Windows).bat"]
APP_DIRS = ["public", "tools"]
GITHUB_ASSET_LIMIT = int(os.environ.get("AE_BUILD_ASSET_LIMIT", 2 * 2**30 - 1))


def log(msg):
    print(f"[build] {msg}", flush=True)


def request(url, headers=None, method=None):
    h = {"User-Agent": "affective-echoes-build"}
    if "api.github.com" in url and os.environ.get("GITHUB_TOKEN"):
        h["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    h.update(headers or {})
    return urllib.request.Request(url, headers=h, method=method)


def fetch(url, timeout=120):
    with urllib.request.urlopen(request(url), timeout=timeout) as r:
        return r.read()


def download(url, dest: Path, expect_sha=None):
    """Stream to disk with progress; verify SHA-256 if known."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    h = hashlib.sha256()
    with urllib.request.urlopen(request(url), timeout=120) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done, last = 0, 0.0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk); h.update(chunk); done += len(chunk)
            if time.time() - last > 5:
                last = time.time()
                log(f"  {dest.name}: {done / 2**20:,.0f} MB" + (f" of {total / 2**20:,.0f} MB" if total else ""))
    if total and done != total:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"Download of {url} was cut short ({done} of {total} bytes). Run the build again.")
    digest = h.hexdigest()
    if expect_sha and digest != expect_sha:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"Checksum mismatch for {dest.name}: expected {expect_sha}, got {digest}")
    tmp.replace(dest)
    return digest


def sha256_file(p: Path):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()


def model_sha_from_hub(url):
    """Hugging Face reports an LFS file's SHA-256 in the X-Linked-ETag header."""
    try:
        with urllib.request.urlopen(request(url, method="HEAD"), timeout=60) as r:
            etag = (r.headers.get("X-Linked-ETag") or "").strip('"').lower()
            return etag if re.fullmatch(r"[0-9a-f]{64}", etag) else None
    except Exception as e:
        log(f"  couldn't read the model checksum ({e}); continuing without it")
        return None


# ---------------------------------------------------------------------------
def get_llama(out: Path, tag, cache: Path):
    api = f"{URLS['llama_api']}/tags/{tag}" if tag else f"{URLS['llama_api']}/latest"
    try:
        rel = json.loads(fetch(api))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Couldn't find llama.cpp release {tag or 'latest'} (HTTP {e.code}). "
                         "Check the tag at https://github.com/ggml-org/llama.cpp/releases, or leave --llama-tag out.")
    tag = rel["tag_name"]
    log(f"llama.cpp release {tag}")
    for name, pattern in ASSETS.items():
        asset = next((a for a in rel["assets"] if re.search(pattern, a["name"])), None)
        if not asset:
            raise SystemExit(f"Release {tag} has no asset matching {pattern}. Pin another with --llama-tag.")
        zpath = cache / asset["name"]
        if not zpath.exists():
            log(f"  downloading {asset['name']}")
            download(asset["browser_download_url"], zpath)
        dest = out / "bin" / "llama" / name
        dest.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zpath) as z:
            members = z.namelist()
            server = next((m for m in members if m.replace("\\", "/").split("/")[-1].lower() == "llama-server.exe"), None)
            if not server:
                raise SystemExit(f"{asset['name']} doesn't contain llama-server.exe")
            prefix = server[: -len("llama-server.exe")]
            keep = 0
            for m in members:
                base = m[len(prefix):] if m.startswith(prefix) else None
                if not base or "/" in base.strip("/") or m.endswith("/"):
                    continue
                low = base.lower()
                # the server, every DLL it may load (CPU variants, Vulkan, runtime), and licenses
                if low == "llama-server.exe" or low.endswith(".dll") or low.startswith("license"):
                    (dest / base).write_bytes(z.read(m)); keep += 1
        log(f"  {name}: kept {keep} files")
    lic = next((p for p in (out / "bin" / "llama").rglob("LICENSE*")), None)
    return tag, lic


def get_python(out: Path, cache: Path):
    zpath = cache / Path(URLS["python"]).name
    if not zpath.exists():
        log(f"downloading portable Python {PY_VERSION}")
        download(URLS["python"], zpath)
    dest = out / "runtime" / "python"
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(dest)
    pth = next(dest.glob("python3*._pth"), None)
    if not pth:
        raise SystemExit("The portable Python has no ._pth file; unexpected download.")
    lines = [l for l in pth.read_text(encoding="utf-8").splitlines() if l.strip() != "../.."]
    # Let the portable Python import the app's own modules (llm_service) from the app folder.
    lines.insert(0, "../..")
    pth.write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(f"  portable Python ready ({pth.name} points at the app folder)")


def get_model(out: Path, cache: Path, model_path):
    dest = out / "models" / llm_service.MODEL_FILE
    dest.parent.mkdir(parents=True, exist_ok=True)
    if model_path:
        src = Path(model_path)
        log(f"using model {src}")
        shutil.copy2(src, dest)
        return sha256_file(dest)
    cached = cache / llm_service.MODEL_FILE
    expect = model_sha_from_hub(URLS["model"])
    if cached.exists() and (not expect or sha256_file(cached) == expect):
        log("model found in cache")
    else:
        log(f"downloading {llm_service.MODEL_FILE} (about 2 GB)")
        download(URLS["model"], cached, expect)
    shutil.copy2(cached, dest)
    return expect or sha256_file(dest)


def copy_app(out: Path):
    for f in APP_FILES:
        shutil.copy2(ROOT / f, out / f)
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store")
    for d in APP_DIRS:
        shutil.copytree(ROOT / d, out / d, ignore=ignore, dirs_exist_ok=True)
    (out / "models").mkdir(exist_ok=True)
    shutil.copy2(ROOT / "models" / "README.md", out / "models" / "README.md")
    shutil.copytree(ROOT / "LICENSES", out / "LICENSES", dirs_exist_ok=True)


def write_licenses(out: Path, llama_cpp_license):
    lic = out / "LICENSES"
    lic.mkdir(exist_ok=True)
    for key, name in (("llama_license", "Llama-3.2-LICENSE.txt"), ("llama_aup", "Llama-3.2-Acceptable-Use-Policy.md")):
        try:
            (lic / name).write_bytes(fetch(URLS[key]))
        except Exception as e:
            raise SystemExit(f"Couldn't download the {name} (required to redistribute the model): {e}")
    if llama_cpp_license:
        shutil.copy2(llama_cpp_license, lic / "llama.cpp-LICENSE.txt")
    py_lic = out / "runtime" / "python" / "LICENSE.txt"
    if py_lic.exists():
        shutil.copy2(py_lic, lic / "Python-LICENSE.txt")


def make_zip(folder: Path, zip_path: Path, include_model=True):
    log(f"zipping {zip_path.name}")
    with zipfile.ZipFile(zip_path, "w", allowZip64=True) as z:
        for p in sorted(folder.rglob("*")):
            if p.is_dir():
                continue
            if not include_model and p.suffix == ".gguf":
                continue
            arc = Path(folder.name) / p.relative_to(folder)
            # the model doesn't compress; store it so unzipping is fast
            ctype = zipfile.ZIP_STORED if p.suffix == ".gguf" else zipfile.ZIP_DEFLATED
            z.write(p, arc.as_posix(), compress_type=ctype)
    return zip_path.stat().st_size


def app_version():
    m = re.search(r'version:\s*"([^"]+)"', (ROOT / "public" / "config.js").read_text(encoding="utf-8"))
    return m.group(1) if m else "0.0.0"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="dist")
    ap.add_argument("--cache", default=".build-cache", help="downloads are kept here between builds")
    ap.add_argument("--llama-tag", default=os.environ.get("LLAMA_TAG") or None)
    ap.add_argument("--model-path")
    ap.add_argument("--no-model", action="store_true")
    a = ap.parse_args()

    out_root = (ROOT / a.out).resolve() if not Path(a.out).is_absolute() else Path(a.out)
    cache = (ROOT / a.cache).resolve() if not Path(a.cache).is_absolute() else Path(a.cache)
    cache.mkdir(parents=True, exist_ok=True)
    folder = out_root / "Affective-Echoes"
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    version = app_version()
    log(f"Affective Echoes {version} -> {folder}")

    copy_app(folder)
    get_python(folder, cache)
    tag, llama_lic = get_llama(folder, a.llama_tag, cache)
    model_sha = None if a.no_model else get_model(folder, cache, a.model_path)
    write_licenses(folder, llama_lic)
    (folder / "data").mkdir(exist_ok=True)

    info = {"app_version": version, "built_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "llama_cpp_release": tag, "python": PY_VERSION, "model_file": None if a.no_model else llm_service.MODEL_FILE,
            "model_sha256": model_sha}
    (folder / "build-info.json").write_text(json.dumps(info, indent=2), encoding="utf-8")

    stem = f"Affective-Echoes-Windows-v{version}"
    full = out_root / f"{stem}.zip"
    size = make_zip(folder, full, include_model=True)
    outputs = [full]
    log(f"{full.name}: {size / 2**30:.2f} GB")
    if size > GITHUB_ASSET_LIMIT:
        # GitHub release files must be under 2 GB: also offer the app and the model separately
        log("over GitHub's 2 GB per-file limit, so also writing a no-model zip and the model as its own file")
        small = out_root / f"{stem}-without-model.zip"
        make_zip(folder, small, include_model=False)
        model_copy = out_root / llm_service.MODEL_FILE
        shutil.copy2(folder / "models" / llm_service.MODEL_FILE, model_copy)
        full.unlink()
        outputs = [small, model_copy]
    sums = out_root / "SHA256SUMS.txt"
    sums.write_text("".join(f"{sha256_file(p)}  {p.name}\n" for p in outputs), encoding="utf-8")
    (out_root / "build-info.json").write_text(json.dumps({**info, "outputs": [p.name for p in outputs]}, indent=2), encoding="utf-8")
    log("done: " + ", ".join(p.name for p in outputs))


if __name__ == "__main__":
    main()
