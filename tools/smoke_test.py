#!/usr/bin/env python3
"""
Smoke-test a built release folder: start the app the way the lab does, wait for the
built-in model, and require a real reply from Alex in each strategy.

  python tools/smoke_test.py dist/Affective-Echoes

Uses the bundled portable Python on Windows (runtime/python/python.exe).
"""
import json, os, subprocess, sys, time, urllib.request
from pathlib import Path

folder = Path(sys.argv[1]).resolve()
port = os.environ.get("SMOKE_PORT", "8611")
timeout_s = int(os.environ.get("SMOKE_TIMEOUT", "1200"))
py = folder / "runtime" / "python" / "python.exe"
python = str(py) if (os.name == "nt" and py.exists()) else sys.executable
base = f"http://127.0.0.1:{port}"
fail = []


def get(path):
    return json.load(urllib.request.urlopen(base + path, timeout=10))


def chat(strategy, text):
    body = {"system": f"You are Alex, a conversation partner in a study. Reply in 1-2 short sentences.\nSTRATEGY — {strategy}.",
            "messages": [{"role": "user", "content": text}], "max_tokens": 80}
    req = urllib.request.Request(base + "/api/chat", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    t0 = time.time()
    r = json.load(urllib.request.urlopen(req, timeout=300))
    return r["text"], time.time() - t0


print(f"[smoke] starting {folder.name} with {python}", flush=True)
env = {**os.environ, "NO_BROWSER": "1", "PORT": port, "AE_LLM": "local"}
proc = subprocess.Popen([python, "server.py"], cwd=folder, env=env)
try:
    for _ in range(60):
        try:
            get("/api/health"); break
        except Exception:
            time.sleep(1)
    else:
        raise SystemExit("[smoke] FAIL: the server didn't start")
    page = urllib.request.urlopen(base + "/", timeout=10).read().decode()
    if "Affective Echoes" not in page:
        fail.append("console page didn't load")
    t0 = time.time()
    while True:
        L = get("/api/health")["llm"]
        if L["state"] == "ready":
            print(f"[smoke] model ready on {L['backend']} after {time.time() - t0:.0f}s ({L['detail']})", flush=True)
            break
        if L["state"] in ("error", "missing_model", "missing_engine"):
            raise SystemExit(f"[smoke] FAIL: {L['state']}: {L['detail']}")
        if time.time() - t0 > timeout_s:
            raise SystemExit("[smoke] FAIL: model didn't load in time")
        time.sleep(3)
    for strategy, text in [("NEUTRAL", "I think small classes are better because you can ask questions."),
                           ("ANGER induction", "Group study is better than studying alone."),
                           ("PRIDE induction", "Living on campus helps you make friends.")]:
        reply, secs = chat(strategy, text)
        print(f"[smoke] {strategy}: {secs:.1f}s -> {reply!r}", flush=True)
        if len(reply.split()) < 3:
            fail.append(f"{strategy}: reply too short")
    if fail:
        raise SystemExit("[smoke] FAIL: " + "; ".join(fail))
    print("[smoke] PASS", flush=True)
finally:
    proc.terminate()
    try:
        proc.wait(15)
    except subprocess.TimeoutExpired:
        proc.kill()
