// =====================================================================
// Affective Echoes — experiment runner
// =====================================================================
(function () {
  const C = window.STUDY_CONFIG;
  const HOSTED = !!window.AE_HOSTED;          // running as the hosted demo (see hosted.js)
  const H = window.AE_HOST || null;
  const CV = C.conversation;
  const TR = C.transitions;
  const $ = (id) => document.getElementById(id);
  const perf = () => performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitUntil = (cond, step = 100) => new Promise((res) => { const f = () => (cond() ? res() : setTimeout(f, step)); f(); });
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}☀-➿❓❗]/gu;

  // ------------------------------------------------------------------
  // Session state
  // ------------------------------------------------------------------
  const S = {
    pid: "", condition: "other_mediated", order: [], engine: "llm", tts: true,
    inputMode: "voice", speed: 1,
    startPerf: 0, startEpoch: 0,
    events: [], affect: [], probes: [], transcript: [],
    phases: [], phaseIdx: -1, phaseElapsed: 0, paused: false, lastTick: 0,
    strategy: "neutral", topicIdx: 0, topic: "", turnsOnTopic: 0,
    history: [], busy: false, openingTopic: false,
    // turn-taking
    lastUserAt: 0, lastCommitAt: 0, userSeq: 0,
    voiceActiveUntil: 0, typingUntil: 0,
    botSpeaking: false, botEndAt: 0, echoGuardUntil: 0, currentBotText: "", ttsChar: 0,
    // probes / transitions
    nextProbeAt: null, probeDueAt: null, activeProbe: null, probeCount: 0, chatLocked: false,
    notice: null,
    lastFeedbackLabel: null, serverOk: false, serverInfo: null,
    pendingLog: [], ended: false, stream: null,
  };
  let engine = null;            // AffectEngine
  let fallbackIdx = {};

  const curPhase = () => S.phases[S.phaseIdx];
  const userActive = () => perf() < Math.max(S.voiceActiveUntil, S.typingUntil);

  // ------------------------------------------------------------------
  // Logging: every event carries epoch ms (for aligning with EmotiBit/EEG
  // recordings on the same machine) plus session-relative seconds.
  // ------------------------------------------------------------------
  function now() {
    const p = perf();
    return {
      t_epoch_ms: +(S.startEpoch + (p - S.startPerf)).toFixed(2),
      t_session_s: +((p - S.startPerf) / 1000).toFixed(3),
    };
  }
  function phaseInfo() {
    const p = curPhase();
    return p ? { phase: p.id, phase_kind: p.kind, block: p.block ?? null, strategy: S.strategy } : {};
  }
  function log(type, data = {}, opts = {}) {
    const ev = { ...now(), pid: S.pid, condition: S.condition, type, ...phaseInfo(), ...data };
    if (type === "affect_sample") S.affect.push(ev);
    else S.events.push(ev);
    S.pendingLog.push(ev);
    if (opts.immediate || type !== "affect_sample") flushLog();
    $("xEvents").textContent = S.events.length;
    return ev;
  }
  let flushing = false;
  async function flushLog() {
    if (!S.serverOk || flushing || !S.pendingLog.length) return;
    flushing = true;
    const batch = S.pendingLog.splice(0);
    try {
      const r = await fetch("/api/log", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid: S.pid, session_start_epoch_ms: S.startEpoch, events: batch }),
      });
      $("xServer").textContent = r.ok ? "ok" : "error " + r.status;
    } catch (e) {
      S.pendingLog.unshift(...batch);
      $("xServer").textContent = "offline (kept in browser)";
    }
    flushing = false;
  }
  setInterval(flushLog, 2000);

  // ------------------------------------------------------------------
  // Setup screen
  // ------------------------------------------------------------------
  const PERMS = [
    ["anger", "shame", "pride"], ["shame", "pride", "anger"], ["pride", "anger", "shame"],
    ["anger", "pride", "shame"], ["shame", "anger", "pride"], ["pride", "shame", "anger"],
  ];
  function computeOrder() {
    const mode = $("orderMode").value;
    if (mode === "manual") {
      const o = $("manualOrder").value.split(",").map((s) => s.trim().toLowerCase()).filter((s) => C.strategies[s]);
      return o.length ? o : [...C.blockStrategies];
    }
    if (mode === "random") return [...C.blockStrategies].sort(() => Math.random() - 0.5);
    const n = parseInt(($("pid").value.match(/\d+/) || ["0"])[0], 10);
    return PERMS[n % PERMS.length];
  }
  let randomCache = null;
  const SEG_LABEL = { rest: "Rest", practice: "Practice", neutral: "Neutral", break: "Break" };

  // Proportional timeline of the protocol, built from config + current options
  function planPhases(order) {
    const T = C.timing, P = [];
    if (!$("skipResting").checked) P.push({ cls: "rest", dur: T.restingBaseline });
    if (!$("skipPractice").checked) P.push({ cls: "practice", dur: T.practice });
    order.forEach((st, i) => {
      P.push({ cls: "neutral", dur: T.blockNeutralBaseline, block: i + 1 });
      P.push({ cls: st, dur: T.blockCondition, label: C.strategies[st].label });
      P.push({ cls: "neutral", dur: T.blockNeutralRecovery });
      if (i < order.length - 1) P.push({ cls: "break", dur: T.blockBreak });
    });
    return P;
  }
  function refreshOrderPreview() {
    if ($("orderMode").value === "random") { randomCache = randomCache || computeOrder(); }
    else randomCache = null;
    const o = randomCache || computeOrder();
    $("manualOrderField").classList.toggle("hidden", $("orderMode").value !== "manual");

    const P = planPhases(o);
    const total = P.reduce((a, p) => a + p.dur, 0);
    const plan = $("plan");
    plan.innerHTML = "";
    P.forEach((p) => {
      const seg = document.createElement("div");
      seg.className = `seg seg-${p.cls}` + (p.block ? " has-block" : "");
      seg.style.flex = `${p.dur} 1 0`;
      const mins = Math.round(p.dur / 60);
      const name = p.label || SEG_LABEL[p.cls] || p.cls;
      seg.title = `${name}, ${mins} min`;
      seg.innerHTML = (p.block ? `<span class="seg-block-label">Part ${p.block}</span>` : "") + `<span>${p.dur >= 240 ? name : ""}</span>`;
      plan.appendChild(seg);
    });
    $("orderPreview").innerHTML = `<strong>${Math.round(total / 60)} minutes</strong> in the app. Block order: ${o.map((s) => C.strategies[s].label).join(", then ")}.`;
    refreshSummary();
  }
  const checklistBoxes = () => [...document.querySelectorAll("#checklist input[type=checkbox]")];
  function checklistState() {
    return Object.fromEntries(checklistBoxes().map((b) => [b.dataset.key, b.checked]));
  }
  let startArmed = false;   // second click on Start when checklist items are still open
  function refreshSummary() {
    const pid = $("pid").value.trim();
    const cond = $("condition").selectedOptions[0].textContent;
    const open = checklistBoxes().filter((b) => !b.checked && b.dataset.key !== "headphones").length;
    const safePid = pid.replace(/[<>&]/g, "");
    $("setupSummary").innerHTML = !pid
      ? "Enter a participant ID to begin."
      : `Ready to start <strong>${safePid}</strong> in <strong>${cond}</strong>.` +
        (open ? ` <span class="open-items">${open} checklist item${open > 1 ? "s" : ""} still open.</span>` : "") + ' <span id="modelNote"></span>';
    updateModelNote();
    startArmed = false;
    $("btnStart").textContent = "Start session";
  }
  ["pid", "orderMode", "manualOrder", "skipResting", "skipPractice", "condition"].forEach((id) => {
    $(id).addEventListener("input", refreshOrderPreview);
    $(id).addEventListener("change", refreshOrderPreview);
  });
  checklistBoxes().forEach((b) => b.addEventListener("change", refreshSummary));
  refreshOrderPreview();
  $("appVersion").textContent = `Version ${C.version}`;

  // Demo preset for walkthroughs: short, fast, clearly labelled in the data
  let demoMode = false;
  $("btnDemo").onclick = () => {
    demoMode = true;
    const d = new Date();
    $("pid").value = `DEMO-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    $("skipResting").checked = true; $("skipPractice").checked = true;
    $("speed").value = "5"; $("orderMode").value = "latin";
    refreshOrderPreview();
    toast("Demo preset loaded: about 7 minutes, no rest or practice. Data is marked as a demo.");
  };
  $("pid").addEventListener("input", () => { if (!/^DEMO-/.test($("pid").value)) demoMode = false; });

  // Suggest the next participant: least-run condition, next ID number
  async function loadSuggestion() {
    try {
      const r = await fetch("/api/sessions");
      if (!r.ok) return;
      const { sessions } = await r.json();
      const real = sessions.filter((x) => !x.demo && x.ended === "completed");
      const counts = { other_mediated: 0, direct: 0, none: 0 };
      real.forEach((x) => { if (x.condition in counts) counts[x.condition]++; });
      const nums = sessions.map((x) => parseInt(((x.pid || "").match(/^P(\d+)$/) || [])[1], 10)).filter((n) => !isNaN(n));
      const nextNum = (nums.length ? Math.max(...nums) : 0) + 1;
      const nextPid = "P" + String(nextNum).padStart(3, "0");
      const order = ["other_mediated", "direct", "none"];
      const nextCond = order.reduce((a, b) => (counts[b] < counts[a] ? b : a), order[0]);
      const label = (c) => C.conditions[c].label;
      $("suggestText").innerHTML = `Suggested next: <strong>${nextPid}</strong> in <strong>${label(nextCond)}</strong>. ` +
        `Completed so far: ${order.map((c) => `${label(c)} ${counts[c]}`).join(", ")}.`;
      $("suggest").classList.remove("hidden");
      $("btnSuggest").onclick = () => {
        $("pid").value = nextPid; $("condition").value = nextCond; demoMode = false;
        refreshOrderPreview();
      };
    } catch (e) { /* server not running: no suggestion */ }
  }
  loadSuggestion();

  function setCheck(id, state, detail) {
    const li = $(id);
    li.dataset.state = state;
    li.querySelector(".ck-detail").textContent = detail;
    li.querySelector(".ck-detail").title = detail;
  }

  async function checkServer() {
    try {
      const r = await fetch("/api/health");
      const d = await r.json();
      S.serverOk = true; S.serverInfo = d;
      setCheck("chkServer", "ok", d.hosted ? (d.log_dir ? "Hosted on Claude, sessions saved privately" : "Hosted on Claude, sign in to save sessions") : d.lsl ? "Connected, LSL markers on" : "Connected");
      renderModelCheck(d);
    } catch (e) {
      setCheck("chkServer", "bad", "Not reachable. Start python server.py");
      setCheck("chkModel", "warn", "Unavailable without the server");
    }
  }
  // Built-in model: show loading / download progress and keep polling until it's ready
  let modelPoll = null;
  function fmtGB(b) { return (b / 2 ** 30).toFixed(1) + " GB"; }
  function renderModelCheck(d) {
    const L = d.llm;
    const li = $("chkModel");
    li.querySelector(".ck-action")?.remove();
    clearTimeout(modelPoll);
    if (!L) { setCheck("chkModel", "warn", "None set up, scripted lines will be used"); return; }
    if (d.hosted) { setCheck("chkModel", "ok", "Claude, on your account"); return; }
    if (L.provider !== "built-in") { setCheck("chkModel", "ok", `${L.model} (${L.provider})`); return; }
    const again = (ms) => { modelPoll = setTimeout(checkServer, ms); };
    switch (L.state) {
      case "ready":
        setCheck("chkModel", "ok", `${L.model}, built in, on ${L.backend}`); break;
      case "starting": case "idle":
        setCheck("chkModel", "warn", `${L.model}: loading into memory (usually under a minute)…`); again(1500); break;
      case "downloading": {
        const dl = L.download || {}, pct = dl.total ? Math.floor((dl.done / dl.total) * 100) : 0;
        setCheck("chkModel", "warn", `Downloading ${L.model}: ${pct}% of ${fmtGB(dl.total || 0)}`); again(1000); break;
      }
      case "missing_model": {
        setCheck("chkModel", "bad", L.download && L.download.error ? "Download stopped. Click to resume" : "Model not downloaded yet (2 GB, one time)");
        const b = document.createElement("button");
        b.type = "button"; b.className = "btn btn-quiet btn-sm ck-action";
        b.textContent = L.download && L.download.error ? "Resume download" : "Download model";
        b.onclick = async () => {
          b.disabled = true;
          try { await fetch("/api/model/download", { method: "POST" }); } catch (e) {}
          checkServer();
        };
        li.appendChild(b);
        break;
      }
      case "missing_engine":
        setCheck("chkModel", "bad", "Engine files missing. Use the Windows release zip"); break;
      default:
        setCheck("chkModel", "bad", L.detail || "The built-in model couldn't start"); again(5000);
    }
    $("chkModel").querySelector(".ck-detail").title = L.detail || "";
    updateModelNote();
  }
  function updateModelNote() {
    const n = document.getElementById("modelNote"); if (!n) return;
    const L = S.serverInfo && S.serverInfo.llm;
    const show = L && L.provider === "built-in" && L.state !== "ready" && $("engine").value !== "scripted";
    n.className = show ? "open-items" : "";
    n.textContent = show ? "Alex's AI isn't ready yet, so replies use scripted lines until it is." : "";
  }

  checkServer();
  if (HOSTED) {
    setCheck("chkFace", "warn", "Not used in the hosted demo");
    setCheck("chkCamera", "warn", "Not available in the hosted demo");
    H.ready.then(() => {
      setCheck("chkSpeech", H.dict ? "ok" : "warn", H.dict ? "Push-to-talk available" : "Not available here, typing only");
      setCheck("chkMic", H.dict ? "ok" : "warn", H.dict ? "Used through push-to-talk" : "Typing only");
    });
  } else {
    setCheck("chkSpeech", (window.SpeechRecognition || window.webkitSpeechRecognition) ? "ok" : "warn",
      (window.SpeechRecognition || window.webkitSpeechRecognition) ? "Available" : "Not supported here. Use Chrome, or typing only");
    fetch("vendor/models/face_expression_model-weights_manifest.json", { method: "HEAD" })
      .then((r) => setCheck("chkFace", r.ok ? "ok" : "bad", r.ok ? "Ready" : "Model files missing"))
      .catch(() => setCheck("chkFace", "bad", "Model files missing"));
  }

  // Live microphone level on the setup screen
  let meterCtx = null, meterRaf = null;
  function startMeter(stream) {
    try {
      meterCtx = new (window.AudioContext || window.webkitAudioContext)();
      const an = meterCtx.createAnalyser(); an.fftSize = 1024;
      meterCtx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      let peak = 0;
      const loop = () => {
        an.getFloatTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const db = 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-8);
        const lvl = Math.max(0, Math.min(1, (db + 60) / 50));
        $("micMeter").style.width = (lvl * 100).toFixed(0) + "%";
        $("micMeterWrap").setAttribute("aria-valuenow", Math.round(lvl * 100));
        if (lvl > 0.25 && lvl > peak) { peak = lvl; setCheck("chkMic", "ok", "Picking up sound"); }
        meterRaf = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) { /* meter is optional */ }
  }
  function stopMeter() {
    cancelAnimationFrame(meterRaf);
    if (meterCtx) { meterCtx.close().catch(() => {}); meterCtx = null; }
  }

  $("btnTestDevices").onclick = async () => {
    if (HOSTED) {
      await H.ready;
      toast(H.dict ? "Speech input works by push-to-talk: press the microphone during the conversation, speak, then press it again."
                   : "Speech input isn't available in this browser. Participants can type their answers.");
      return;
    }
    try {
      const st = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }, audio: { echoCancellation: true, noiseSuppression: true },
      });
      const v = $("previewVideo"); v.srcObject = st;
      document.querySelector(".preview-box").classList.add("live");
      S.stream = st;
      const vt = st.getVideoTracks()[0], s = vt && vt.getSettings();
      setCheck("chkCamera", vt ? "ok" : "bad", vt ? `Working, ${s.width || "?"}×${s.height || "?"}` : "No camera found");
      setCheck("chkMic", st.getAudioTracks().length ? "warn" : "bad", st.getAudioTracks().length ? "Connected. Say something to test" : "No microphone found");
      stopMeter(); startMeter(st);
      $("btnTestDevices").lastChild.textContent = "Test again";
    } catch (e) {
      setCheck("chkCamera", "bad", "Blocked or unavailable");
      setCheck("chkMic", "bad", "Blocked or unavailable");
      toast("Chrome couldn't open the camera or microphone. Allow access in the address bar, then try again.");
    }
  };

  $("btnStart").onclick = async () => {
    S.pid = $("pid").value.trim();
    if (!S.pid) { toast("Enter a participant ID to start the session."); $("pid").focus(); return; }
    const open = checklistBoxes().filter((b) => !b.checked && b.dataset.key !== "headphones");
    if (open.length && !startArmed && !demoMode) {
      startArmed = true;
      $("btnStart").textContent = "Start anyway";
      toast(`Not checked yet: ${open.map((b) => b.parentElement.querySelector("strong").textContent.toLowerCase()).join(", ")}. Click Start anyway to continue.`);
      return;
    }
    S.condition = $("condition").value;
    S.order = randomCache || computeOrder();
    S.engine = $("engine").value;
    S.tts = $("tts").value === "on";
    S.inputMode = $("inputMode").value;
    S.speed = parseFloat($("speed").value);

    $("btnStart").disabled = true; $("btnStart").textContent = HOSTED ? "Starting…" : "Loading models…";
    if (HOSTED) H.requestUpfront();           // one consent dialog for Claude replies + voice
    if (!HOSTED) try {
      S.stream = S.stream || await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }, audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      toast("The session needs the camera and microphone. Allow access in the address bar, then start again.");
      $("btnStart").disabled = false; $("btnStart").textContent = "Start session"; return;
    }
    stopMeter();
    $("previewVideo").srcObject = null;
    if (S.stream) $("selfVideo").srcObject = S.stream;

    S.startPerf = perf(); S.startEpoch = Date.now();
    engine = new window.AffectEngine(C.affect, (t, d) => log(t, d));
    const faceOk = HOSTED ? false : await engine.initFace($("selfVideo"), "vendor/models");
    const voiceOk = HOSTED ? false : engine.initVoice(S.stream);
    if (!HOSTED && C.affect.useExternalModel) engine.connectExternal(C.affect.externalModelUrl);

    log("session_start", {
      order: S.order.join(">"), engine: S.engine, tts: S.tts, input_mode: S.inputMode, speed: S.speed,
      face_model: faceOk, voice_features: voiceOk, user_agent: navigator.userAgent,
      llm: S.serverInfo && S.serverInfo.llm ? `${S.serverInfo.llm.provider}/${S.serverInfo.llm.model}` : null,
      start_epoch_ms: S.startEpoch, config_timing: C.timing, config_probes: C.probes,
      checklist: checklistState(), demo: demoMode || HOSTED, hosted: HOSTED, app_version: C.version,
      config_conversation: CV, config_transitions: { noticeLeadSec: TR.noticeLeadSec, quietTailSec: TR.quietTailSec },
    });
    if (!faceOk && !HOSTED) toast("The face model didn't load. Affect will be estimated from voice and words only.");

    buildPhases();
    buildProgress();
    setupConditionUI();
    startSampling();
    $("xPid").textContent = S.pid;
    $("xCond").textContent = C.conditions[S.condition].label;
    showScreen("screen-instructions");
  };

  window.addEventListener("beforeunload", (e) => {
    if (S.startPerf && !S.ended) { flushLog(); e.preventDefault(); e.returnValue = ""; }
  });

  $("btnBegin").onclick = () => { log("instructions_acknowledged"); nextPhase(); requestAnimationFrame(tick); };

  // ------------------------------------------------------------------
  // Protocol
  // ------------------------------------------------------------------
  function buildPhases() {
    const T = C.timing, P = [];
    if (!$("skipResting").checked) P.push({ id: "resting_baseline", kind: "rest", dur: T.restingBaseline, strategy: null });
    if (!$("skipPractice").checked) P.push({ id: "practice", kind: "chat", dur: T.practice, strategy: "neutral", label: "Practice conversation" });
    S.order.forEach((st, i) => {
      const b = i + 1;
      P.push({ id: `b${b}_neutral_baseline`, kind: "chat", dur: T.blockNeutralBaseline, strategy: "neutral", block: b, label: `Part ${b} of ${S.order.length}` });
      P.push({ id: `b${b}_condition_${st}`, kind: "chat", dur: T.blockCondition, strategy: st, block: b, label: `Part ${b} of ${S.order.length}`, isCondition: true });
      P.push({ id: `b${b}_neutral_recovery`, kind: "chat", dur: T.blockNeutralRecovery, strategy: "neutral", block: b, label: `Part ${b} of ${S.order.length}` });
      if (i < S.order.length - 1) P.push({ id: `b${b}_break`, kind: "break", dur: T.blockBreak, strategy: null, block: b });
    });
    S.phases = P;
  }

  // Participant-facing progress bar: one segment per phase, sized by duration.
  // No strategy names, so the bar never reveals the manipulation.
  function buildProgress() {
    const bar = $("sessionProgress");
    bar.innerHTML = "";
    S.phases.forEach((p) => {
      const seg = document.createElement("div");
      seg.className = "pseg" + (p.kind === "break" ? " is-break" : "");
      seg.style.flex = `${p.dur} 1 0`;
      seg.appendChild(document.createElement("b"));
      bar.appendChild(seg);
    });
    S.progressTotal = S.phases.reduce((a, p) => a + p.dur, 0);
  }
  function updateProgress() {
    const segs = $("sessionProgress").children;
    let done = 0;
    for (let i = 0; i < segs.length; i++) {
      const p = S.phases[i];
      const f = i < S.phaseIdx ? 1 : i === S.phaseIdx ? Math.min(1, S.phaseElapsed / p.dur) : 0;
      segs[i].firstChild.style.width = (f * 100).toFixed(2) + "%";
      done += f * p.dur;
    }
    $("sessionProgress").setAttribute("aria-valuenow", Math.round((done / S.progressTotal) * 100));
  }

  function nextPhase() {
    const prev = curPhase();
    if (prev) {
      if (prev.kind === "chat") flushUtterance("phase_end");
      log("phase_end", { elapsed_s: +S.phaseElapsed.toFixed(2) });
    }
    clearProbe("phase_end");
    hideNotice();
    S.phaseIdx++;
    S.phaseElapsed = 0;
    S.probeDueAt = null;
    if (S.phaseIdx >= S.phases.length) { endSession("completed"); return; }
    const p = curPhase();
    S.strategy = p.strategy || "none";
    log("phase_start", { duration_s: p.dur, scaled_duration_s: +(p.dur / S.speed).toFixed(2) });
    $("xPhase").textContent = p.id;
    $("xStrat").textContent = S.strategy;

    if (p.kind === "rest") {
      S.nextProbeAt = null;
      showScreen("screen-rest");
      engine.startVoiceCalibration();
      setListening(false);
    } else if (p.kind === "break") {
      S.nextProbeAt = null;
      setListening(false);
      stopSpeaking("phase_change");
      $("breakNext").classList.remove("show");
      $("breakNext").textContent = "";
      showScreen("screen-break");
    } else {
      engine.stopVoiceCalibration();
      showScreen("screen-chat");
      $("phaseTag").textContent = p.label || "Conversation";
      S.nextProbeAt = (p.isCondition || !C.probes.onlyDuringCondition) ? randProbeDelay() : null;
      setListening(S.inputMode === "voice");
      if (prev && prev.kind === "chat") openTopicWhenClear();          // continuous chat: don't talk over anyone
      else newTopic(S.phaseIdx === firstChatPhaseIdx());
    }
  }
  function firstChatPhaseIdx() { return S.phases.findIndex((p) => p.kind === "chat"); }
  function randProbeDelay() { return C.probes.minIntervalSec + Math.random() * (C.probes.maxIntervalSec - C.probes.minIntervalSec); }

  function tick(ts) {
    if (S.ended) return;
    const dt = S.lastTick ? (ts - S.lastTick) / 1000 : 0;
    S.lastTick = ts;
    const p = curPhase();
    if (p && !S.paused) {
      S.phaseElapsed += dt * S.speed;
      const left = Math.max(0, p.dur - S.phaseElapsed);
      const txt = fmt(left);
      if (p.kind === "rest") $("restTimer").textContent = txt;
      else if (p.kind === "break") {
        $("breakTimer").textContent = txt;
        if (left <= TR.resumeNoticeSec && !$("breakNext").classList.contains("show")) {
          $("breakNext").textContent = "The next conversation will begin in a few seconds.";
          $("breakNext").classList.add("show");
          log("resume_notice_shown");
        }
      } else {
        $("phaseTimer").textContent = txt;
        updateNotice(left);
        tickProbe(left);
        tickSilence();
      }
      $("xProbe").textContent = S.activeProbe ? "Open now" : S.nextProbeAt != null ? `in ${fmt(Math.max(0, S.nextProbeAt - S.phaseElapsed))}` : "None this phase";
      if (p.kind === "chat") updateProgress();
      if (S.phaseElapsed >= p.dur) nextPhase();
    }
    updateBotStatus();
    requestAnimationFrame(tick);
  }
  function fmt(s) { s = Math.ceil(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

  // Move to a new topic if nobody has said anything for a while
  function tickSilence() {
    if (S.busy || S.openingTopic || S.activeProbe || S.botSpeaking || userActive() || S.notice) return;
    const idleSince = Math.max(S.lastUserAt, S.botEndAt);
    if (idleSince && (perf() - idleSince) / 1000 * S.speed > CV.silenceNudgeSec) {
      log("silence_nudge");
      newTopic(false);
    }
  }

  // ------------------------------------------------------------------
  // Transition notices (before breaks and before the session ends)
  // ------------------------------------------------------------------
  function upcomingTransition() {
    const p = curPhase();
    if (!p || p.kind !== "chat") return null;
    const n = S.phases[S.phaseIdx + 1];
    if (!n) return "end";
    return n.kind === "break" ? "break" : null;
  }
  function phaseLeft() { const p = curPhase(); return p ? p.dur - S.phaseElapsed : Infinity; }
  function inNoticeWindow() { return !!upcomingTransition() && phaseLeft() <= TR.noticeLeadSec; }
  function inQuietTail() { return !!upcomingTransition() && phaseLeft() <= TR.quietTailSec; }

  function updateNotice(left) {
    const kind = upcomingTransition();
    if (!kind || left > TR.noticeLeadSec) return;
    if (!S.notice) showNotice(kind);
    $("noticeBar").style.width = Math.max(0, (left / TR.noticeLeadSec) * 100).toFixed(1) + "%";
  }
  function showNotice(kind) {
    S.notice = kind;
    const el = $("notice");
    el.setAttribute("aria-hidden", "false");
    el.classList.add("show");
    const text = (kind === "break" ? TR.breakNotice : TR.endNotice).replace("{SEC}", TR.noticeLeadSec);
    requestAnimationFrame(() => { $("noticeText").textContent = text; });   // after un-hiding, so screen readers announce it
    log("transition_notice_shown", { notice: kind, lead_s: TR.noticeLeadSec });
  }
  function hideNotice() {
    if (!S.notice) return;
    S.notice = null;
    $("notice").classList.remove("show");
    $("notice").setAttribute("aria-hidden", "true");
    $("noticeText").textContent = "";
  }

  // ------------------------------------------------------------------
  // Conversation
  // ------------------------------------------------------------------
  function newTopic(isFirst) {
    S.topic = C.topics[S.topicIdx % C.topics.length];
    S.topicIdx++;
    S.turnsOnTopic = 0;
    S.lastUserAt = perf();
    const text = isFirst
      ? `Hi, I'm Alex! Let's start with an easy one: ${S.topic}`
      : `Next topic: ${S.topic}`;
    log("topic_start", { topic: S.topic });
    botSay(text, { kind: "opener", engine_used: "fixed" });
  }

  // Between two chat phases: wait for Alex to finish and the participant to stop talking
  async function openTopicWhenClear() {
    const idx = S.phaseIdx;
    S.openingTopic = true;
    const t0 = perf();
    await waitUntil(() => S.ended || S.phaseIdx !== idx || perf() - t0 > 10000 ||
      (!S.botSpeaking && !userActive() && !S.activeProbe));
    S.openingTopic = false;
    if (S.ended || S.phaseIdx !== idx) return;
    newTopic(false);
  }

  function recordUser(text, extra = {}) {
    S.lastUserAt = perf();
    addMsg("user", text);
    S.history.push({ role: "user", content: text });
    S.transcript.push({ ...now(), ...phaseInfo(), speaker: "participant", text });
    engine.ingestText(text);
    engine.sendToExternal({ type: "transcript", text, ...now() });
    S.userSeq++;
    log("user_message", { text, affect: engine.snapshot(), ...extra });
  }

  function handleUser(text, source) {
    text = (text || "").trim();
    if (!text || S.ended) return;
    const p = curPhase();
    if (!p || p.kind !== "chat") return;
    if (S.activeProbe) { log("input_blocked_checkin", { text, input: source }); return; }
    recordUser(text, { input: source });
    S.lastCommitAt = perf();
    if (S.openingTopic) return;          // the new topic is about to be posed
    respond();
  }

  // Generate a reply, then hold it until it's polite to speak:
  // the participant isn't talking/typing, no check-in is open, a short pause
  // has passed, and we're not in the last few seconds before a break.
  async function respond() {
    if (S.busy) return;                  // the running loop notices new input via userSeq
    S.busy = true;
    const phaseIdx = S.phaseIdx;
    let regen = 0;
    try {
      while (true) {
        const seq = S.userSeq;
        const moveOn = S.turnsOnTopic >= CV.turnsPerTopic && !inNoticeWindow();
        const reply = moveOn ? null : await generateReply();
        const heldFrom = perf();
        await waitUntil(() => S.ended || S.phaseIdx !== phaseIdx ||
          (!userActive() && !S.activeProbe && !S.botSpeaking && !inQuietTail() &&
           perf() - S.lastCommitAt >= CV.minReplyDelayMs));
        if (S.ended || S.phaseIdx !== phaseIdx) {
          if (reply) log("reply_discarded", { reason: S.ended ? "session_end" : "phase_changed", text: reply.text });
          return;
        }
        if (S.userSeq !== seq && regen < 2) {     // participant added more while we were preparing
          regen++;
          if (reply) log("reply_discarded", { reason: "new_participant_input", text: reply.text });
          continue;
        }
        if (moveOn) { newTopic(false); return; }
        S.turnsOnTopic++;
        botSay(reply.text, { ...reply.meta, held_ms: Math.round(perf() - heldFrom), regenerations: regen });
        return;
      }
    } finally { S.busy = false; }
  }

  async function generateReply() {
    const strat = C.strategies[S.strategy] || C.strategies.neutral;
    const snapshot = engine.snapshot();
    let echoPhrase = null;
    const stratPrompt = strat.prompt;
    let system = `${C.sharedRules}\n\n${stratPrompt}\n\nCurrent topic: "${S.topic}"`;
    if (S.condition === "other_mediated") {
      // The echo goes last: small local models follow the most recent instruction most reliably.
      echoPhrase = engine.phrase();
      system += "\n\n" + C.conditions.other_mediated.echoPrompt
        .replaceAll("{AFFECT_PHRASE}", echoPhrase)
        .replaceAll("{AFFECT_SHORT}", echoPhrase.split(",")[0]);
    }
    const t0 = perf();
    const meta = { kind: "reply", strategy_used: S.strategy, echo_phrase: echoPhrase, affect_at_generation: snapshot };
    if (strat.firstLine) {             // Shame: ask about the participant's standard first, word for word
      const phaseId = curPhase()?.id;
      const asked = S.transcript.some((t) => t.speaker === "bot" && t.phase === phaseId && t.text.includes(strat.firstLine));
      if (!asked) {
        const text = (echoPhrase ? scriptedEcho(snapshot.label) : "") + strat.firstLine;
        return { text, meta: { ...meta, engine_used: "fixed", line: "standard_question", latency_ms: 0 } };
      }
    }

    if (S.engine === "llm" && S.serverOk && S.serverInfo && S.serverInfo.llm) {
      try {
        const msgs = trimHistory(S.history.slice(-C.llm.historyTurns * 2));
        const r = await fetch("/api/chat", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system, messages: msgs, max_tokens: C.llm.maxTokens, temperature: C.llm.temperature }),
        });
        const d = await r.json();
        if (!r.ok || !d.text) throw new Error(d.error || "empty reply");
        let text = d.text.trim();
        // Other-mediated condition: make sure the affect reflection reaches the participant even
        // if the model skipped it, by adding the same scripted sentence the fallback lines use.
        let echoAdded = false;
        if (echoPhrase && !isExitLine(text) && !echoPresent(text, snapshot.label)) {
          const add = scriptedEcho(snapshot.label);
          if (add) {
            // drop an opening reflection that names the wrong feeling, then add the right one
            text = add + (text.replace(OPENING_REFLECTION, "").trim() || text);
            echoAdded = true;
          }
        }
        return { text, meta: { ...meta, engine_used: "llm", echo_added: echoAdded, latency_ms: Math.round(perf() - t0), system_prompt: system } };
      } catch (e) {
        log("llm_error", { error: String(e.message || e) });
      }
    }
    const bank = strat.fallback;
    fallbackIdx[S.strategy] = ((fallbackIdx[S.strategy] ?? -1) + 1) % bank.length;
    let text = bank[fallbackIdx[S.strategy]];
    if (echoPhrase) text = scriptedEcho(snapshot.label) + text;
    return { text, meta: { ...meta, engine_used: "scripted", latency_ms: Math.round(perf() - t0) } };
  }

  // Messages must alternate and start with a user turn for most APIs
  function trimHistory(h) {
    const out = [];
    for (const m of h) {
      if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n" + m.content;
      else out.push({ ...m });
    }
    while (out.length && out[0].role !== "user") out.shift();
    return out;
  }

  // Words that count as reflecting each affect label back to the participant
  const ECHO_WORDS = {
    tense: /\b(tense|tension|stress|on edge|uneasy|anxious|nervous|wound up|uptight)/i,
    irritated: /\b(irritat|bother|annoy|frustrat|fed up|worked up|agitated|upset)/i,
    subdued: /\b(subdued|low|down|flat|quiet|deflated|tired|muted|unenthusiastic)/i,
    upbeat: /\b(upbeat|energi|excited|enthusias|lively|animated|positive|cheerful|happy)/i,
    warm: /\b(relaxed|easygoing|easy-going|warm|content|comfortable|at ease|laid[- ]back)/i,
    calm: /\b(calm|relaxed|steady|composed|at ease|settled|laid[- ]back)/i,
    alert: /\b(alert|focused|engaged|attentive|sharp|keen|switched on|tuned in)/i,
  };
  const OPENING_REFLECTION = /^(you (sound|seem|look|come across|appear)|it (sounds|seems|looks) like you)[^.!?]*[.!?]\s*/i;
  function echoPresent(text, label) {
    const re = ECHO_WORDS[label];
    return !re || re.test(text);      // "neutral" (no pattern) never needs adding
  }
  function isExitLine(text) {
    return /researcher will be with you/i.test(text);
  }

  function scriptedEcho(label) {
    const map = {
      tense: "You sound a little tense about this. ", irritated: "You seem pretty bothered by this. ",
      subdued: "You seem a bit low on this one. ", upbeat: "You sound energized about this. ",
      warm: "You seem relaxed and easygoing about it. ", calm: "You seem calm about this. ",
      alert: "You seem quite alert to this. ", neutral: "",
    };
    return map[label] || "";
  }

  function botSay(text, meta = {}) {
    S.history.push({ role: "assistant", content: text });
    S.transcript.push({ ...now(), ...phaseInfo(), speaker: "bot", text });
    addMsg("bot", text);
    $("subtitleText").textContent = text;
    log("bot_message", { text, ...meta });
    speak(text);
  }

  // ---------------- TTS ----------------
  let voice = null, ttsId = 0, ttsSafety = null;
  function pickVoice() {
    const vs = speechSynthesis.getVoices();
    voice = vs.find((v) => /en-US/i.test(v.lang) && /Google|Samantha|Aria|Jenny|Natural/i.test(v.name))
         || vs.find((v) => /^en/i.test(v.lang)) || null;
  }
  if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

  function speak(text) {
    const tile = $("botTile");
    if (S.botSpeaking) stopSpeaking("replaced");
    S.currentBotText = text;
    const clean = text.replace(EMOJI_RE, "").trim();
    if (S.tts && HOSTED && H.tts) { speakHosted(text, clean, tile); return; }
    if (!S.tts || !window.speechSynthesis) {
      // Subtitles only: treat the reading time as Alex's turn
      S.botEndAt = perf() + Math.min(8000, 800 + clean.length * 45);
      tile.classList.add("talking"); setTimeout(() => tile.classList.remove("talking"), 1500);
      return;
    }
    speechSynthesis.cancel();
    const id = ++ttsId;
    const u = new SpeechSynthesisUtterance(clean);
    if (voice) u.voice = voice;
    u.rate = CV.ttsRate;
    S.ttsChar = 0;
    S.botSpeaking = true;
    tile.classList.add("talking");
    if (!CV.bargeIn) pauseRecog(true, "tts");
    const done = (how) => {
      if (id !== ttsId || !S.botSpeaking) return;          // stale callback
      S.botSpeaking = false;
      S.botEndAt = perf();
      S.echoGuardUntil = perf() + CV.echoGuardMs;
      tile.classList.remove("talking");
      clearTimeout(ttsSafety);
      pauseRecog(false, "tts");
      log("tts_end", { how });
    };
    u.onstart = () => { if (id === ttsId) log("tts_start"); };
    u.onboundary = (e) => { if (id === ttsId) S.ttsChar = e.charIndex; };
    u.onend = () => done("completed");
    u.onerror = (e) => done(e.error === "interrupted" || e.error === "canceled" ? "canceled" : "error");
    clearTimeout(ttsSafety);
    ttsSafety = setTimeout(() => done("timeout"), 5000 + (clean.length * 110) / CV.ttsRate);
    speechSynthesis.speak(u);
  }

  // Hosted demo: Alex speaks with Claude's voice through the `tts` capability
  function speakHosted(text, clean, tile) {
    const id = ++ttsId;
    S.ttsChar = 0;
    S.botSpeaking = true;
    tile.classList.add("talking");
    const done = (how) => {
      if (id !== ttsId || !S.botSpeaking) return;
      S.botSpeaking = false; S.botEndAt = perf();
      tile.classList.remove("talking"); clearTimeout(ttsSafety);
      log("tts_end", { how });
    };
    log("tts_start");
    H.tts.speak(clean.slice(0, 1900), { rate: CV.ttsRate }).then(() => done("completed"), (e) => done((e && e.code) || "error"));
    clearTimeout(ttsSafety);
    ttsSafety = setTimeout(() => done("timeout"), 8000 + (clean.length * 110) / CV.ttsRate);
  }

  function stopSpeaking(reason) {
    if (!S.botSpeaking) return;
    ttsId++;                                                  // make pending callbacks stale
    clearTimeout(ttsSafety);
    if (HOSTED && H.tts) { try { H.tts.stop(); } catch (e) {} }
    window.speechSynthesis && speechSynthesis.cancel();
    S.botSpeaking = false;
    S.botEndAt = perf();
    S.echoGuardUntil = reason === "barge_in" ? 0 : perf() + CV.echoGuardMs;
    $("botTile").classList.remove("talking");
    pauseRecog(false, "tts");
    log("tts_end", { how: reason, spoken_chars: S.ttsChar, text_chars: S.currentBotText.length });
  }

  // ---------------- STT ----------------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null, recogWanted = false;
  const recogPauses = new Set();
  let utterBuf = "", interimBuf = "", utterTimer = null, committedInterim = "";

  function setListening(on) {
    if (HOSTED) {                       // push-to-talk only: never listens on its own
      $("micBtn").classList.toggle("on", on && !!(H && H.dict));
      if (!on) stopDictation(false);
      return;
    }
    recogWanted = on && !!SR;
    $("micBtn").classList.toggle("on", recogWanted);
    if (recogWanted) startRecog();
    else if (recog) { try { recog.abort(); } catch (e) {} }
  }
  function pauseRecog(on, reason) {
    if (on) recogPauses.add(reason); else recogPauses.delete(reason);
    if (recogPauses.size && recog) { try { recog.abort(); } catch (e) {} }
    if (!recogPauses.size && recogWanted) startRecog();
  }
  function startRecog() {
    if (HOSTED || !SR || recogPauses.size) return;
    if (!recog) {
      recog = new SR();
      recog.lang = "en-US"; recog.continuous = true; recog.interimResults = true;
      recog.onresult = onSpeechResult;
      recog.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") log("stt_error", { error: e.error }); };
      recog.onend = () => { if (recogWanted && !recogPauses.size) setTimeout(startRecog, 250); };
    }
    try { recog.start(); } catch (e) { /* already running */ }
  }

  const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);
  const INTERRUPT_WORDS = new Set(["wait", "sorry", "hold", "actually", "stop", "excuse", "hang"]);
  // Is this speech just the microphone picking up Alex's own voice?
  function isEcho(heard, botText) {
    const hw = words(heard);
    if (!hw.length) return true;
    const bw = new Set(words(botText));
    return hw.filter((w) => bw.has(w)).length / hw.length >= 0.6;
  }
  function looksLikeParticipant(heard) {
    const hw = words(heard);
    return hw.length >= CV.bargeInMinWords || (hw.length === 1 && INTERRUPT_WORDS.has(hw[0]));
  }

  function onSpeechResult(e) {
    if (S.chatLocked || S.activeProbe) return;              // check-in open: ignore speech
    let interim = "", newFinal = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) newFinal += " " + r[0].transcript;
      else interim += r[0].transcript;
    }
    // Drop a final that repeats an interim we already committed on a timeout
    if (committedInterim && newFinal && words(newFinal).join(" ") === words(committedInterim).join(" ")) {
      committedInterim = ""; newFinal = "";
    }
    const heard = (newFinal + " " + interim).trim();
    if (!heard) return;

    // While Alex is talking (or just stopped), filter out Alex's own voice.
    if (S.botSpeaking || perf() < S.echoGuardUntil) {
      if (isEcho(heard, S.currentBotText) || !looksLikeParticipant(heard)) return;
      if (S.botSpeaking) {
        // Participant is talking over Alex: Alex stops and listens.
        log("bot_interrupted", { heard, spoken_chars: S.ttsChar, text_chars: S.currentBotText.length });
        stopSpeaking("barge_in");
      }
      S.echoGuardUntil = 0;
    }

    if (newFinal) utterBuf += newFinal;
    interimBuf = interim;
    $("liveTranscript").textContent = (utterBuf + " " + interim).trim();
    $("micBtn").classList.add("hearing");
    S.voiceActiveUntil = perf() + CV.endOfUtteranceMs;
    clearTimeout(utterTimer);
    utterTimer = setTimeout(commitUtterance, CV.endOfUtteranceMs);
  }

  // The participant has been quiet for endOfUtteranceMs: send what they said
  function commitUtterance() {
    clearTimeout(utterTimer);
    $("micBtn").classList.remove("hearing");
    let t = utterBuf.trim();
    if (interimBuf.trim()) { t = (t + " " + interimBuf).trim(); committedInterim = interimBuf; }
    utterBuf = ""; interimBuf = "";
    $("liveTranscript").textContent = "";
    S.voiceActiveUntil = 0;
    if (t) handleUser(t, "voice");
  }

  // Phase ending / check-in opening mid-sentence: keep the words, no reply
  function flushUtterance(reason) {
    clearTimeout(utterTimer);
    $("micBtn").classList.remove("hearing");
    const t = (utterBuf + " " + interimBuf).trim();
    if (interimBuf.trim()) committedInterim = interimBuf;
    utterBuf = ""; interimBuf = "";
    $("liveTranscript").textContent = "";
    S.voiceActiveUntil = 0;
    if (t && curPhase() && curPhase().kind === "chat") recordUser(t, { input: "voice", no_reply: true, cut_reason: reason });
  }

  // ---------------- Hosted demo: push-to-talk dictation ----------------
  let dictWired = false, dictDiscard = false;
  function wireDictation() {
    if (dictWired || !H || !H.dict) return;
    dictWired = true;
    H.dict.onPartial(({ text }) => {
      if (dictDiscard || S.chatLocked) return;
      interimBuf = text || "";
      $("liveTranscript").textContent = (utterBuf + " " + interimBuf).trim();
    });
    H.dict.onFinal(({ text }) => {
      if (dictDiscard || S.chatLocked) return;
      utterBuf += text; interimBuf = "";
      $("liveTranscript").textContent = utterBuf.trim();
    });
    H.dict.onState(({ state, reason }) => {
      const on = state !== "idle";
      $("micBtn").classList.toggle("dictating", on);
      $("micBtn").classList.toggle("hearing", state === "listening");
      if (on) { S.voiceActiveUntil = perf() + 3600e3; return; }   // Alex holds its reply while the mic is open
      S.voiceActiveUntil = 0;
      if (dictDiscard) { dictDiscard = false; utterBuf = ""; interimBuf = ""; $("liveTranscript").textContent = ""; return; }
      if (reason && !["stopped", "viewer_stopped", "hidden"].includes(reason)) log("stt_error", { error: reason });
      interimBuf = "";
      commitUtterance();
    });
  }
  if (HOSTED) H.ready.then(wireDictation);
  function stopDictation(discard) {
    if (!HOSTED || !H || !H.dict || !H.dict.active()) return;
    dictDiscard = !!discard;
    H.dict.stop().catch(() => {});
  }

  $("micBtn").onclick = () => {
    if (S.chatLocked || S.inputMode !== "voice") return;
    if (HOSTED) {
      if (!H || !H.dict) { toast("Speech input isn't available here. Type your answer instead."); return; }
      if (H.dict.active()) { log("mic_toggle", { on: false }); H.dict.stop().catch(() => {}); return; }
      if (S.botSpeaking) {             // pressing the mic while Alex talks: Alex stops and listens
        log("bot_interrupted", { heard: "(pressed the microphone)", spoken_chars: S.ttsChar, text_chars: S.currentBotText.length });
        stopSpeaking("barge_in");
      }
      dictDiscard = false;
      H.dict.start().catch((e) => {
        if (e && e.code === "not_granted") toast("Microphone access was declined. You can type your answers instead.");
      });
      log("mic_toggle", { on: true });
      return;
    }
    setListening(!recogWanted); log("mic_toggle", { on: recogWanted });
  };
  $("sendBtn").onclick = () => {
    if (S.chatLocked) return;
    const v = $("textInput").value; $("textInput").value = "";
    S.typingUntil = 0;
    handleUser(v, "text");
  };
  $("textInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("sendBtn").click(); });
  $("textInput").addEventListener("input", () => {
    S.typingUntil = $("textInput").value.trim() ? perf() + CV.typingHoldMs : 0;   // Alex waits while they type
  });

  function addMsg(who, text) {
    const d = document.createElement("div");
    d.className = "msg " + who; d.textContent = text;
    $("chatbox").appendChild(d); $("chatbox").scrollTop = 1e9;
    return d;
  }

  let lastStatus = null;
  function updateBotStatus() {
    let s = "";
    if (S.activeProbe) s = "Paused";
    else if (S.botSpeaking) s = "Speaking";
    else if (userActive()) s = "Listening…";
    else if (S.busy || S.openingTopic) s = "Thinking…";
    if (s !== lastStatus) {
      $("botStatus").textContent = s;
      $("botStatus").classList.toggle("on", !!s);
      lastStatus = s;
    }
  }

  // ------------------------------------------------------------------
  // Check-in (slider dialog over the chat; the chat is locked while open)
  // ------------------------------------------------------------------
  function tickProbe(left) {
    if (S.activeProbe) {
      if (!S.activeProbe.submitted && (perf() - S.activeProbe.shownPerf) / 1000 * S.speed > C.probes.autoDismissSec) clearProbe("timeout");
      return;
    }
    if (S.nextProbeAt == null || S.phaseElapsed < S.nextProbeAt) return;
    if (left < C.probes.minRemainingSec || inNoticeWindow()) {
      log("probe_skipped", { reason: "phase_ending" });
      S.nextProbeAt = null; S.probeDueAt = null;
      return;
    }
    if (S.probeDueAt == null) S.probeDueAt = perf();
    const waited = perf() - S.probeDueAt;
    // Wait for a natural gap (Alex done speaking, participant done talking), up to maxDeferSec
    if ((!S.botSpeaking && !userActive()) || waited > C.probes.maxDeferSec * 1000) showProbe("scheduled", waited);
  }

  function setChatLocked(on) {
    S.chatLocked = on;
    $("chatPanel").classList.toggle("locked", on);
    $("textInput").disabled = on; $("sendBtn").disabled = on; $("micBtn").disabled = on;
    $("textInput").placeholder = on ? "Chat paused during the check-in" : "Type or speak your answer…";
    $("chatbox").inert = on;
    if (on) { S.typingUntil = 0; S.voiceActiveUntil = 0; pauseRecog(true, "checkin"); stopDictation(true); }
    else pauseRecog(false, "checkin");
  }

  function midValue(it) {
    const step = it.step || 1;
    return it.min + Math.round((it.max - it.min) / 2 / step) * step;
  }
  function valueText(it, v) {
    const end = v === it.min ? `, ${it.left}` : v === it.max ? `, ${it.right}` : "";
    return `${v} out of ${it.max}${end}`;
  }

  function showProbe(trigger, deferredMs = 0) {
    const p = curPhase();
    if (S.activeProbe || !p || p.kind !== "chat") return;
    if (S.botSpeaking) stopSpeaking("checkin");
    flushUtterance("checkin");
    setChatLocked(true);
    S.probeCount++;
    S.probeDueAt = null;
    const id = `probe_${S.probeCount}`;
    const shown = log("probe_shown", { probe_id: id, trigger, deferred_ms: Math.round(deferredMs), affect: engine.snapshot() });

    const layer = $("probeLayer");
    layer.innerHTML = "";
    const card = document.createElement("div");
    card.className = "probe-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "probeTitle");
    card.setAttribute("aria-describedby", "probeSub");
    card.innerHTML = `<h3 id="probeTitle" tabindex="-1">Quick check-in</h3>
      <p class="probe-sub" id="probeSub">The conversation is paused. Click or drag along each line to show how you feel right now.</p>`;

    const answers = {}, firstRt = {}, nChanges = {};
    const foot = document.createElement("div"); foot.className = "probe-foot";
    const hint = document.createElement("span"); hint.className = "probe-hint"; hint.setAttribute("aria-live", "polite");
    const submit = document.createElement("button");
    submit.className = "btn btn-primary"; submit.textContent = "Save check-in"; submit.disabled = true;
    const refresh = () => {
      const left = C.probeItems.length - Object.keys(answers).length;
      submit.disabled = left > 0;
      hint.textContent = left > 0 ? `${left} of ${C.probeItems.length} left to answer` : "All answered";
    };

    C.probeItems.forEach((it) => {
      const sid = `probe-${it.id}`;
      const ticks = [];
      for (let v = it.min; v <= it.max; v += it.step || 1) ticks.push(`<span>${v}</span>`);
      const wrap = document.createElement("div");
      wrap.className = "probe-item";
      wrap.innerHTML = `
        <div class="pi-head">
          <label for="${sid}">${it.text}</label>
          <output class="pi-value empty" id="${sid}-out" for="${sid}">Not answered</output>
        </div>
        <input type="range" class="slider untouched" id="${sid}" min="${it.min}" max="${it.max}" step="${it.step || 1}"
               value="${midValue(it)}" aria-describedby="${sid}-anchors" aria-valuetext="Not answered yet" />
        <div class="ticks" aria-hidden="true">${ticks.join("")}</div>
        <div class="anchors" id="${sid}-anchors"><span>${it.left}</span><span>${it.right}</span></div>`;
      const input = wrap.querySelector("input"), out = wrap.querySelector("output");
      const take = () => {
        if (!S.activeProbe || S.activeProbe.submitted) return;
        const v = +input.value;
        if (answers[it.id] !== v) nChanges[it.id] = (nChanges[it.id] || 0) + 1;
        answers[it.id] = v;
        if (firstRt[it.id] == null) firstRt[it.id] = Math.round(perf() - S.activeProbe.shownPerf);
        input.classList.remove("untouched");
        input.style.setProperty("--fill", (((v - it.min) / (it.max - it.min)) * 100).toFixed(1) + "%");
        input.setAttribute("aria-valuetext", valueText(it, v));
        out.textContent = v; out.classList.remove("empty");
        refresh();
      };
      input.addEventListener("input", take);
      input.addEventListener("pointerup", take);                 // a click on the current (middle) value still counts
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); take(); } });
      card.appendChild(wrap);
    });

    submit.onclick = () => {
      if (!S.activeProbe || S.activeProbe.submitted || submit.disabled) return;
      S.activeProbe.submitted = true;
      const rt = Math.round(perf() - S.activeProbe.shownPerf);
      const rec = {
        probe_id: id, ...phaseInfo(),
        shown_epoch_ms: shown.t_epoch_ms, shown_session_s: shown.t_session_s,
        answered_epoch_ms: now().t_epoch_ms, rt_ms: rt, status: "answered", deferred_ms: Math.round(deferredMs),
        ...Object.fromEntries(C.probeItems.map((it) => [it.id, answers[it.id]])),
        ...Object.fromEntries(C.probeItems.map((it) => [`${it.id}_first_rt_ms`, firstRt[it.id]])),
        ...Object.fromEntries(C.probeItems.map((it) => [`${it.id}_n_changes`, nChanges[it.id]])),
        affect_at_shown: shown.affect, affect_at_answer: engine.snapshot(),
      };
      S.probes.push(rec);
      log("probe_response", rec);
      addMsg("system", "Check-in saved");
      card.innerHTML = `<div class="probe-thanks" role="status">Saved. Back to the conversation.</div>`;
      setTimeout(() => { if (S.activeProbe && S.activeProbe.id === id) closeProbe(); }, 900);
    };

    foot.appendChild(hint); foot.appendChild(submit);
    card.appendChild(foot);
    layer.appendChild(card);
    layer.classList.add("show");
    refresh();
    S.activeProbe = { id, card, shownPerf: perf(), shown, submitted: false };
    $("probeTitle").focus();
  }

  function closeProbe() {
    $("probeLayer").classList.remove("show");
    $("probeLayer").innerHTML = "";
    S.activeProbe = null;
    setChatLocked(false);
    S.lastUserAt = perf();                                     // restart the silence timer
    scheduleNextProbe();
    if (S.inputMode === "text" && !S.ended) $("textInput").focus();
  }
  function clearProbe(reason) {
    if (!S.activeProbe) return;
    if (!S.activeProbe.submitted) {
      const { id, shown } = S.activeProbe;
      const rec = { probe_id: id, ...phaseInfo(), shown_epoch_ms: shown.t_epoch_ms, shown_session_s: shown.t_session_s, status: reason, affect_at_shown: shown.affect };
      S.probes.push(rec);
      log("probe_missed", rec);
      if (reason === "timeout") addMsg("system", "Check-in skipped");
    }
    closeProbe();
  }
  function scheduleNextProbe() {
    const p = curPhase();
    S.nextProbeAt = p && p.kind === "chat" && (p.isCondition || !C.probes.onlyDuringCondition) ? S.phaseElapsed + randProbeDelay() : null;
  }

  // ------------------------------------------------------------------
  // Affect sampling + feedback rendering
  // ------------------------------------------------------------------
  function setupConditionUI() {
    $("directPanel").classList.toggle("hidden", S.condition !== "direct");
  }

  function startSampling() {
    setInterval(() => {
      if (S.ended || !engine) return;
      const f = engine.update();
      const snap = engine.snapshot();
      log("affect_sample", snap);
      if (engine.external.connected) {
        const payload = { type: "features", ...now(), features: snap };
        if (C.affect.sendFramesToExternal) payload.frame_jpeg_b64 = grabFrame();
        engine.sendToExternal(payload);
      }
      $("xAffect").textContent = `${f.label}, valence ${f.valence.toFixed(2)}, arousal ${f.arousal.toFixed(2)}`;
      $("xSource").textContent = f.source + (engine.external.connected ? " (ext model live)" : "");

      const p = curPhase();
      if (!p || p.kind !== "chat") return;
      if (S.condition === "other_mediated") renderSubtitleTint(f);
      else if (S.condition === "direct") renderDirect(f);
      if ((S.condition !== "none") && f.label !== S.lastFeedbackLabel) {
        log("feedback_render", { feedback_label: f.label, valence: snap.valence, arousal: snap.arousal });
        S.lastFeedbackLabel = f.label;
      }
    }, C.affect.sampleMs);
  }

  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = 224; frameCanvas.height = 168;
  function grabFrame() {
    try {
      frameCanvas.getContext("2d").drawImage($("selfVideo"), 0, 0, 224, 168);
      return frameCanvas.toDataURL("image/jpeg", 0.7).split(",")[1];
    } catch (e) { return null; }
  }

  // Other-mediated: valence shifts the subtitle window's hue/saturation,
  // arousal raises border strength and adds a slow pulse. No labels, no numbers.
  function renderSubtitleTint(f) {
    const root = document.documentElement.style;
    const v = f.valence, a = f.arousal;
    const hue = v < 0 ? 8 : v > 0 ? 38 : 230;          // negative → rose, positive → warm amber
    const sat = 12 + Math.min(1, Math.abs(v)) * 60;
    root.setProperty("--sub-hue", hue);
    root.setProperty("--sub-sat", sat.toFixed(0) + "%");
    root.setProperty("--sub-light", (97 - Math.abs(v) * 6).toFixed(1) + "%");
    root.setProperty("--sub-border", (0.12 + Math.max(0, a) * 0.7).toFixed(2));
    const sub = $("subtitle");
    if (a > 0.25) { sub.classList.add("pulse"); root.setProperty("--sub-pulse", (3.2 - a * 1.8).toFixed(2) + "s"); }
    else sub.classList.remove("pulse");
  }

  function renderDirect(f) {
    $("dpLabel").textContent = f.label;
    $("dpDot").setAttribute("cx", (50 + f.valence * 44).toFixed(1));
    $("dpDot").setAttribute("cy", (50 - f.arousal * 44).toFixed(1));
    const bar = (el, x) => {
      const w = Math.abs(x) * 50;
      el.style.left = x >= 0 ? "50%" : (50 - w) + "%";
      el.style.width = w + "%";
    };
    bar($("dpVal"), f.valence); bar($("dpAro"), f.arousal);
    $("dpValNum").textContent = f.valence.toFixed(2);
    $("dpAroNum").textContent = f.arousal.toFixed(2);
  }

  // ------------------------------------------------------------------
  // Stop / end / export
  // ------------------------------------------------------------------
  function askDialog({ title, body, ok, cancel = "Cancel", input = false, tone = "primary" }) {
    return new Promise((resolve) => {
      const layer = document.createElement("div");
      layer.className = "modal-layer";
      layer.innerHTML = `<div class="modal" role="${input ? "dialog" : "alertdialog"}" aria-modal="true" aria-labelledby="mdTitle" aria-describedby="mdBody">
        <h2 id="mdTitle"></h2><p id="mdBody"></p>
        ${input ? '<input id="mdInput" type="text" autocomplete="off" aria-labelledby="mdTitle" />' : ""}
        <div class="modal-actions"><button type="button" class="btn btn-quiet" data-a="no"></button><button type="button" class="btn btn-${tone}" data-a="yes"></button></div></div>`;
      layer.querySelector("#mdTitle").textContent = title;
      layer.querySelector("#mdBody").textContent = body || "";
      layer.querySelector('[data-a="no"]').textContent = cancel;
      layer.querySelector('[data-a="yes"]').textContent = ok;
      const prev = document.activeElement;
      const finish = (v) => { layer.remove(); document.removeEventListener("keydown", onKey, true); if (prev && prev.focus) prev.focus(); resolve(v); };
      const yes = () => finish(input ? layer.querySelector("#mdInput").value : true);
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); finish(input ? null : false); }
        if (e.key === "Enter" && input && document.activeElement && document.activeElement.id === "mdInput") { e.preventDefault(); yes(); }
        if (e.key === "Tab") {   // keep focus inside the dialog
          const f = [...layer.querySelectorAll("button, input")];
          const i = f.indexOf(document.activeElement);
          if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
      };
      layer.querySelector('[data-a="no"]').onclick = () => finish(input ? null : false);
      layer.querySelector('[data-a="yes"]').onclick = yes;
      layer.addEventListener("click", (e) => { if (e.target === layer) finish(input ? null : false); });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(layer);
      (input ? layer.querySelector("#mdInput") : layer.querySelector('[data-a="no"]')).focus();
    });
  }

  $("btnStop").onclick = async () => {
    log("stop_button_pressed");
    const yes = await askDialog({ title: "Stop the session?", body: "You can stop at any time. There's no penalty for stopping.", ok: "Stop session", cancel: "Keep going" });
    if (yes) endSession("participant_stopped"); else log("stop_cancelled");
  };

  function endSession(reason) {
    if (S.ended) return;
    const p = curPhase();
    if (p) {
      if (p.kind === "chat") flushUtterance("session_end");
      log("phase_end", { elapsed_s: +S.phaseElapsed.toFixed(2), interrupted: reason !== "completed" });
    }
    clearProbe("session_end");
    hideNotice();
    log("session_end", { reason, n_probes_answered: S.probes.filter((x) => x.status === "answered").length });
    S.ended = true;
    setListening(false);
    stopSpeaking("session_end");
    window.speechSynthesis && speechSynthesis.cancel();
    flushLog();
    if (reason !== "completed") {
      $("endTitle").textContent = "Session stopped";
      $("endText").textContent = "Thank you for your time. The researcher will be with you in a moment.";
    }
    document.querySelector(".exp-strip-label").textContent = HOSTED
      ? (S.serverInfo && S.serverInfo.log_dir ? "For the researcher. This demo session is saved privately to your account, under Sessions and review." : "For the researcher. Sign in to Claude to keep demo sessions; you can still download this one.")
      : S.serverOk
      ? `For the researcher. This session was also saved automatically to data/${S.pid.replace(/[^A-Za-z0-9_-]/g, "_")}.`
      : "For the researcher. The local server wasn't reachable, so download the data now.";
    $("exportBox").classList.remove("hidden");
    showScreen("screen-end");
  }

  $("btnShowDebrief").onclick = () => { $("debrief").classList.remove("hidden"); $("exportBox").classList.add("hidden"); log("debrief_shown"); flushLog(); };
  $("btnExport").onclick = exportAll;

  async function exportAll() {
    const stamp = new Date(S.startEpoch).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const base = `${S.pid}_${S.condition}_${stamp}`;
    const full = JSON.stringify({
      pid: S.pid, condition: S.condition, order: S.order, start_epoch_ms: S.startEpoch,
      events: S.events, affect_samples: S.affect, probes: S.probes, transcript: S.transcript,
    }, null, 1);
    if (HOSTED) {   // each hosted download asks the viewer, so offer the two files that matter, one after the other
      await download(`${base}_full.json`, full, "application/json");
      await download(`${base}_probes.csv`, toCSV(S.probes.map(flat)));
      return;
    }
    download(`${base}_full.json`, JSON.stringify({
      pid: S.pid, condition: S.condition, order: S.order, start_epoch_ms: S.startEpoch,
      events: S.events, affect_samples: S.affect, probes: S.probes, transcript: S.transcript,
    }, null, 1), "application/json");
    download(`${base}_events.csv`, toCSV(S.events.map(flat)));
    download(`${base}_affect.csv`, toCSV(S.affect.map(flat)));
    download(`${base}_probes.csv`, toCSV(S.probes.map(flat)));
    download(`${base}_transcript.csv`, toCSV(S.transcript));
  }
  function flat(o, pre = "", out = {}) {
    for (const [k, v] of Object.entries(o)) {
      if (k === "system_prompt") continue;
      if (v && typeof v === "object" && !Array.isArray(v)) flat(v, pre + k + ".", out);
      else out[pre + k] = Array.isArray(v) ? v.join("|") : v;
    }
    return out;
  }
  function toCSV(rows) {
    if (!rows.length) return "";
    const cols = [...new Set(rows.flatMap(Object.keys))];
    const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  }
  function download(name, text, type = "text/csv") {
    if (HOSTED) return H.save(name, text, type).catch((e) => {
      if (e && e.code !== "declined") toast("The download didn't start. Try again in a moment.");
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }

  // ------------------------------------------------------------------
  // Experimenter panel + shortcuts
  // ------------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "e") { e.preventDefault(); $("expPanel").classList.toggle("hidden"); }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "x") { e.preventDefault(); if (S.startPerf) endSession("experimenter_emergency_stop"); }
  });
  $("expClose").onclick = () => $("expPanel").classList.add("hidden");
  $("xSkip").onclick = () => { log("experimenter_skip_phase"); nextPhase(); };
  $("xPause").onclick = () => {
    S.paused = !S.paused; log(S.paused ? "experimenter_pause" : "experimenter_resume");
    $("xPause").textContent = S.paused ? "Resume" : "Pause";
  };
  $("xMarker").onclick = async () => {
    const m = await askDialog({ title: "Add a marker", body: "A short note saved with the current time, for example 'participant coughed'.", ok: "Add marker", input: true });
    if (m != null && m.trim()) { log("experimenter_marker", { note: m.trim() }); toast("Marker added."); }
  };
  $("xProbeNow").onclick = () => showProbe("manual");
  $("xAbort").onclick = async () => {
    if (await askDialog({ title: "End the session now?", body: "The participant goes to the end screen. Data recorded so far is kept.", ok: "End session", tone: "danger-solid" })) endSession("experimenter_ended");
  };

  // ------------------------------------------------------------------
  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
  }
  let toastT;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), 4000);
  }

  // Expose for debugging / automated checks
  window.__AE = { S, handleUser, showProbe, nextPhase, endSession, generateReply, get engine() { return engine; } };
})();
