// =====================================================================
// Affective Echoes — Sessions and review
// Library of saved sessions + a per-session explorer. No dependencies.
// =====================================================================
(function () {
  const C = window.STUDY_CONFIG;
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const COND = { other_mediated: "Other-mediated", direct: "Direct", none: "No feedback" };
  const COND_ORDER = ["other_mediated", "direct", "none"];
  const STRAT = Object.fromEntries(Object.entries(C.strategies).map(([k, v]) => [k, v.label]));
  const WINDOW_S = 30;                        // analysis window before each check-in

  const state = { sessions: [], cond: "all", search: "", showDemos: true, model: null, file: null };

  // ---------------- helpers ----------------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const lengthLabel = (s) => (s >= 90 ? `${Math.round(s / 60)} min` : mmss(s));
  const fmtDate = (ms) => ms ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms)) : "Unknown";
  const signed = (x) => (x == null || isNaN(x) ? "—" : (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(2));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  function pearson(xs, ys) {
    const n = xs.length; if (n < 3) return null;
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }
  function statusOf(ended) {
    if (ended === "completed") return { cls: "completed", text: "Completed" };
    if (ended === "participant_stopped") return { cls: "stopped", text: "Stopped by participant" };
    if (ended) return { cls: "stopped", text: "Ended early" };
    return { cls: "open", text: "Incomplete" };
  }
  function phaseName(id) {
    if (!id) return "";
    if (id === "resting_baseline") return "Resting baseline";
    if (id === "practice") return "Practice";
    const m = id.match(/^b(\d+)_(.+)$/);
    if (!m) return id;
    const part = `Part ${m[1]}`;
    if (m[2] === "neutral_baseline") return `${part}, neutral start`;
    if (m[2] === "neutral_recovery") return `${part}, recovery`;
    if (m[2] === "break") return "Break";
    const st = m[2].replace("condition_", "");
    return `${part}, ${STRAT[st] || st}`;
  }
  let toastT;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), 4500);
  }
  function download(name, text, type = "text/csv") {
    if (window.AE_HOSTED) return window.AE_HOST.save(name, text, type).catch((e) => {
      if (e && e.code !== "declined") toast("The download didn't start. Try again in a moment.");
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  function toCSV(rows) {
    if (!rows.length) return "";
    const cols = [...new Set(rows.flatMap(Object.keys))];
    const q = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c])).join(","))].join("\n");
  }

  // =====================================================================
  // Library
  // =====================================================================
  function skeleton() {
    $("emptyState").classList.add("hidden");
    $("sessionTable").classList.remove("hidden");
    $("sessionRows").innerHTML = Array.from({ length: 4 }, () =>
      `<tr class="skel">${"<td><span></span></td>".repeat(7)}</tr>`).join("");
  }

  async function loadLibrary() {
    skeleton();
    try {
      const r = await fetch("/api/sessions", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      state.sessions = (await r.json()).sessions || [];
      renderLibrary();
    } catch (e) {
      state.sessions = [];
      renderLibrary("offline");
    }
  }

  function visibleSessions() {
    const q = state.search.trim().toLowerCase();
    return state.sessions.filter((s) =>
      (state.cond === "all" || s.condition === state.cond) &&
      (state.showDemos || !s.demo) &&
      (!q || (s.pid || "").toLowerCase().includes(q)));
  }

  function renderLibrary(mode) {
    renderBalance();
    const rows = visibleSessions();
    const tbody = $("sessionRows");
    if (mode === "offline" || !rows.length) {
      tbody.innerHTML = "";
      $("sessionTable").classList.add("hidden");
      $("emptyState").classList.remove("hidden");
      if (window.AE_HOSTED && (mode === "offline" || !state.sessions.length)) {
        $("emptyTitle").textContent = "No demo sessions yet";
        $("emptyText").textContent = (window.AE_HOST && window.AE_HOST.db)
          ? "Run the demo from the console and it will appear here, saved privately to your account. Or open the simulated example to see a full 36-minute session."
          : "Sign in to Claude to save your demo sessions here. You can still open the simulated example to see a full 36-minute session.";
        $("emptyCta").classList.remove("hidden");
        $("emptyCta").textContent = "Run the demo";
      } else if (mode === "offline") {
        $("emptyTitle").textContent = "The local server isn't running";
        $("emptyText").textContent = "Start it with python server.py to see saved sessions, or open a file you downloaded at the end of a session.";
        $("emptyCta").classList.add("hidden");
      } else if (state.sessions.length) {
        $("emptyTitle").textContent = "No sessions match";
        $("emptyText").textContent = "Try another condition, clear the search, or turn on Show demos.";
        $("emptyCta").classList.add("hidden");
      } else {
        $("emptyTitle").textContent = "No sessions yet";
        $("emptyText").textContent = "Sessions appear here as soon as one starts. Run your first session from the console, or open a file you downloaded at the end of a session.";
        $("emptyCta").classList.remove("hidden");
      }
      return;
    }
    $("sessionTable").classList.remove("hidden");
    $("emptyState").classList.add("hidden");
    tbody.innerHTML = rows.map((s) => {
      const st = statusOf(s.ended);
      const total = s.probes_answered + s.probes_missed;
      const tags = s.demo ? ` <span class="tag tag-demo">${s.simulated ? "Simulated" : "Demo"}</span>` : "";
      return `<tr tabindex="0" data-file="${esc(s.file)}" aria-label="Open session ${esc(s.pid)}">
        <td class="lead" data-label="Participant"><span class="pid">${esc(s.pid || "Unknown")}</span>${tags}</td>
        <td data-label="Condition"><span class="tag tag-cond">${esc(COND[s.condition] || s.condition || "—")}</span></td>
        <td data-label="Date">${esc(fmtDate(s.start_epoch_ms))}</td>
        <td class="num" data-label="Length">${esc(lengthLabel(s.last_t || 0))}</td>
        <td class="num" data-label="Check-ins">${s.probes_answered}/${total}</td>
        <td class="num" data-label="Interruptions">${s.interruptions}</td>
        <td class="tail" data-label="Status"><span class="status status-${st.cls}">${st.text}</span></td>
      </tr>`;
    }).join("");
  }

  function renderBalance() {
    const done = state.sessions.filter((s) => !s.demo && s.ended === "completed");
    const counts = Object.fromEntries(COND_ORDER.map((c) => [c, done.filter((s) => s.condition === c).length]));
    const max = Math.max(1, ...Object.values(counts));
    $("balanceBars").innerHTML = COND_ORDER.map((c) => `
      <div class="bb-row">
        <div class="bb-top"><span>${COND[c]}</span><strong>${counts[c]}</strong></div>
        <div class="bb-track" role="img" aria-label="${COND[c]}: ${counts[c]} completed"><b style="width:${(counts[c] / max) * 100}%"></b></div>
      </div>`).join("");
    const next = COND_ORDER.reduce((a, b) => (counts[b] < counts[a] ? b : a), COND_ORDER[0]);
    const total = done.length;
    $("balanceNext").innerHTML = total
      ? `${total} completed in total. Assign the next participant to <strong>${COND[next]}</strong> to keep the groups even.`
      : "No completed sessions yet. Groups stay balanced if you follow the suggestion on the console.";
  }

  // filters
  $("condTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cond]"); if (!b) return;
    selectTab(b);
  });
  $("condTabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const tabs = [...$("condTabs").querySelectorAll("button")];
    const i = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    selectTab(n); n.focus();
  });
  function selectTab(b) {
    $("condTabs").querySelectorAll("button").forEach((t) => t.setAttribute("aria-selected", String(t === b)));
    state.cond = b.dataset.cond; renderLibrary();
  }
  $("search").addEventListener("input", (e) => { state.search = e.target.value; renderLibrary(); });
  $("showDemos").addEventListener("change", (e) => { state.showDemos = e.target.checked; renderLibrary(); });
  $("btnRefresh").addEventListener("click", loadLibrary);
  $("sessionRows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-file]"); if (tr) location.hash = "s=" + encodeURIComponent(tr.dataset.file);
  });
  $("sessionRows").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr[data-file]"); if (!tr) return;
    e.preventDefault(); location.hash = "s=" + encodeURIComponent(tr.dataset.file);
  });

  // Hosted demo: a clearly labelled simulated session that ships with the page
  $("btnExample").addEventListener("click", async () => {
    try {
      const r = await fetch("sample-session.json");
      const d = await r.json();
      state.file = null;
      showDetail(buildModel(d.events), "sample-session.json");
    } catch (e) { toast("The simulated example couldn't be loaded."); }
  });

  // open a downloaded file (works without the server)
  $("fileInput").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const text = await f.text();
      let events;
      if (f.name.endsWith(".jsonl")) {
        events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } else {
        const d = JSON.parse(text);
        events = Array.isArray(d) ? d : [...(d.events || []), ...(d.affect_samples || [])];
      }
      events.sort((a, b) => (a.t_session_s || 0) - (b.t_session_s || 0));
      if (!events.some((x) => x.type === "session_start")) throw new Error("not a session file");
      state.file = null;
      showDetail(buildModel(events), f.name);
    } catch (err) {
      toast("That file isn't an Affective Echoes session. Use the _full.json or .jsonl file from a session.");
    }
    e.target.value = "";
  });

  // =====================================================================
  // Routing
  // =====================================================================
  async function route() {
    const m = location.hash.match(/^#s=(.+)$/);
    if (!m) { showLibrary(); return; }
    const file = decodeURIComponent(m[1]);
    if (state.model && state.file === file) return;
    try {
      const r = await fetch("/api/session?file=" + encodeURIComponent(file), { cache: "no-store" });
      if (!r.ok) throw new Error("missing");
      const d = await r.json();
      state.file = file;
      showDetail(buildModel(d.events), file);
    } catch (e) {
      toast("That session couldn't be loaded. It may have been moved out of the data folder.");
      location.hash = "";
    }
  }
  function showLibrary() {
    $("detail").classList.add("hidden");
    $("library").classList.remove("hidden");
    document.title = "Sessions | Affective Echoes";
    if (!state.sessions.length) loadLibrary(); else renderLibrary();
  }
  $("backLink").addEventListener("click", (e) => { e.preventDefault(); history.length > 1 && location.hash ? history.back() : (location.hash = ""); });
  window.addEventListener("hashchange", route);

  // =====================================================================
  // Session model
  // =====================================================================
  function buildModel(events) {
    const start = events.find((e) => e.type === "session_start") || {};
    const end = events.find((e) => e.type === "session_end");
    const lastT = events.reduce((m, e) => Math.max(m, e.t_session_s || 0), 0);
    const duration = end ? end.t_session_s : lastT;

    // phases
    const phases = [];
    events.forEach((e) => {
      if (e.type === "phase_start") phases.push({ id: e.phase, kind: e.phase_kind, block: e.block, strategy: e.strategy, start: e.t_session_s, end: null });
      if (e.type === "phase_end") { const p = [...phases].reverse().find((x) => x.id === e.phase && x.end == null); if (p) p.end = e.t_session_s; }
    });
    phases.forEach((p, i) => { if (p.end == null) p.end = phases[i + 1] ? phases[i + 1].start : duration; });

    const affect = events.filter((e) => e.type === "affect_sample").map((e) => ({ t: e.t_session_s, v: e.valence, a: e.arousal }));
    const items = Object.fromEntries(C.probeItems.map((it) => [it.id, it]));
    const rescale = (id, x) => { const it = items[id]; if (!it || x == null) return null; const mid = (it.min + it.max) / 2; return (x - mid) / ((it.max - it.min) / 2); };

    const probes = events.filter((e) => e.type === "probe_response" || e.type === "probe_missed").map((e) => {
      const t = e.shown_session_s ?? e.t_session_s;
      const win = affect.filter((s) => s.t >= t - WINDOW_S && s.t <= t);
      const estV = mean(win.map((s) => s.v)), estA = mean(win.map((s) => s.a));
      const answered = e.type === "probe_response";
      const repV = answered ? rescale("valence", e.valence) : null;
      const repA = answered ? rescale("arousal", e.arousal) : null;
      let agreement = null;
      if (answered && estV != null && repV != null && repA != null) {
        agreement = 1 - (Math.abs(repV - estV) + Math.abs(repA - estA)) / 4;
      }
      return {
        id: e.probe_id, t, phase: e.phase, answered, status: e.status,
        valence: e.valence, arousal: e.arousal, awareness: e.awareness, rt_ms: e.rt_ms,
        repV, repA, estV, estA, agreement,
      };
    });
    const answered = probes.filter((p) => p.answered && p.estV != null);

    const transcript = [];
    events.forEach((e) => {
      if (e.type === "phase_start" && e.phase_kind === "chat") transcript.push({ kind: "divider", t: e.t_session_s, phase: e.phase });
      if (e.type === "phase_start" && e.phase_kind !== "chat") transcript.push({ kind: "divider", t: e.t_session_s, phase: e.phase });
      if (e.type === "bot_message") transcript.push({ kind: "bot", t: e.t_session_s, text: e.text, phase: e.phase });
      if (e.type === "user_message") transcript.push({ kind: "participant", t: e.t_session_s, text: e.text, phase: e.phase, cut: e.cut_reason });
      if (e.type === "bot_interrupted") transcript.push({ kind: "note", t: e.t_session_s, text: "Participant started talking, so Alex stopped and listened.", phase: e.phase });
      if (e.type === "probe_response") transcript.push({ kind: "note", t: e.t_session_s, text: "Check-in answered.", phase: e.phase });
    });

    return {
      start, end, duration, phases, affect, probes, transcript, events,
      pid: start.pid || "Unknown", condition: start.condition,
      interruptions: events.filter((e) => e.type === "bot_interrupted").length,
      turns: events.filter((e) => e.type === "user_message").length,
      rV: pearson(answered.map((p) => p.repV), answered.map((p) => p.estV)),
      rA: pearson(answered.map((p) => p.repA), answered.map((p) => p.estA)),
      meanAgreement: mean(answered.filter((p) => p.agreement != null).map((p) => p.agreement)),
    };
  }

  // =====================================================================
  // Detail view
  // =====================================================================
  function showDetail(model, file) {
    state.model = model;
    $("library").classList.add("hidden");
    $("detail").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    document.title = `${model.pid} | Affective Echoes`;

    $("dTitle").textContent = model.pid;
    const st = statusOf(model.end && model.end.reason);
    const s = model.start;
    $("dMeta").innerHTML = [
      `<span class="tag tag-cond">${esc(COND[model.condition] || model.condition || "Unknown condition")}</span>`,
      s.demo ? `<span class="tag tag-demo">${s.simulated ? "Simulated" : "Demo"}</span>` : "",
      `<span>${esc(fmtDate(s.start_epoch_ms))}</span>`,
      s.order ? `<span>Order: ${esc(s.order.split(">").map((x) => STRAT[x] || x).join(", "))}</span>` : "",
      `<span class="status status-${st.cls}">${st.text}</span>`,
      s.checklist && Object.values(s.checklist).some((v) => !v)
        ? `<span class="tag" title="Pre-session checklist">Checklist: ${Object.entries(s.checklist).filter(([, v]) => !v).map(([k]) => k).join(", ")} not ticked</span>` : "",
    ].filter(Boolean).join("");

    const answered = model.probes.filter((p) => p.answered).length;
    const agree = model.meanAgreement;
    const rText = (r) => (r == null ? "—" : r.toFixed(2));
    $("metrics").innerHTML = `
      <div><dt>Length</dt><dd>${esc(mmss(model.duration))}</dd></div>
      <div><dt>Check-ins answered</dt><dd>${answered}<small>of ${model.probes.length}</small></dd></div>
      <div><dt>Mean agreement</dt><dd>${agree == null ? "—" : Math.round(agree * 100) + "%"}</dd></div>
      <div><dt>Report–estimate r</dt><dd>${rText(model.rV)}<small>pleasant</small> ${rText(model.rA)}<small>activated</small></dd></div>
      <div><dt>Interruptions</dt><dd>${model.interruptions}<small>${model.turns} turns</small></dd></div>`;

    renderProbes(model);
    renderTranscript(model);
    renderChart(model);
  }

  function renderProbes(model) {
    const tb = $("probeRows");
    if (!model.probes.length) {
      tb.innerHTML = `<tr><td colspan="6" class="note-cell">No check-ins in this session.</td></tr>`;
      return;
    }
    const it = Object.fromEntries(C.probeItems.map((x) => [x.id, x]));
    tb.innerHTML = model.probes.map((p) => {
      if (!p.answered) {
        return `<tr class="missed" data-t="${p.t}">
          <td class="mono t-cell" data-label="Time">${mmss(p.t)}</td><td data-label="Part">${esc(phaseName(p.phase))}</td>
          <td class="num" data-label="Pleasant">—</td><td class="num" data-label="Activated">—</td><td class="num" data-label="Noticed">—</td>
          <td class="num" data-label="Agreement">${p.status === "timeout" ? "Timed out" : "Not answered"}</td></tr>`;
      }
      const ag = p.agreement == null ? "—" :
        `<span class="agree"><span class="agree-bar"><b style="width:${Math.round(p.agreement * 100)}%"></b></span>${Math.round(p.agreement * 100)}%</span>`;
      return `<tr data-t="${p.t}">
        <td class="mono t-cell" data-label="Time">${mmss(p.t)}</td>
        <td data-label="Part">${esc(phaseName(p.phase))}</td>
        <td class="num" data-label="Pleasant" title="Estimate before: ${signed(p.estV)}">${p.valence}<span class="of">/${it.valence ? it.valence.max : 9}</span></td>
        <td class="num" data-label="Activated" title="Estimate before: ${signed(p.estA)}">${p.arousal}<span class="of">/${it.arousal ? it.arousal.max : 9}</span></td>
        <td class="num" data-label="Noticed">${p.awareness ?? "—"}<span class="of">/${it.awareness ? it.awareness.max : 7}</span></td>
        <td class="num" data-label="Agreement">${ag}</td></tr>`;
    }).join("");
    tb.querySelectorAll("tr[data-t]").forEach((tr) => tr.addEventListener("click", () => jumpTranscript(+tr.dataset.t)));
  }

  function renderTranscript(model) {
    const sel = $("trFilter");
    const parts = model.phases.filter((p) => p.kind === "chat");
    sel.innerHTML = `<option value="all">All parts</option>` + parts.map((p) => `<option value="${esc(p.id)}">${esc(phaseName(p.id))}</option>`).join("");
    sel.onchange = () => drawTranscript(model, sel.value);
    drawTranscript(model, "all");
  }
  function drawTranscript(model, filter) {
    const items = model.transcript.filter((x) => filter === "all" || x.phase === filter);
    $("transcript").innerHTML = items.length ? items.map((x) => {
      if (x.kind === "divider") return `<li class="divider" data-t="${x.t}">${esc(phaseName(x.phase))}</li>`;
      if (x.kind === "note") return `<li data-t="${x.t}"><span class="t">${mmss(x.t)}</span><span class="note">${esc(x.text)}</span></li>`;
      const who = x.kind === "bot" ? "Alex" : model.pid;
      const cut = x.cut ? ` <span class="note">(cut off by ${x.cut === "checkin" ? "a check-in" : "the end of the part"})</span>` : "";
      return `<li class="${x.kind}" data-t="${x.t}"><span class="t">${mmss(x.t)}</span><span><span class="who">${esc(who)}</span>${esc(x.text)}${cut}</span></li>`;
    }).join("") : `<li><span></span><span class="note">Nothing was said in this part.</span></li>`;
  }
  function jumpTranscript(t) {
    if ($("trFilter").value !== "all") { $("trFilter").value = "all"; drawTranscript(state.model, "all"); }
    const lis = [...$("transcript").querySelectorAll("li[data-t]:not(.divider)")];
    if (!lis.length) return;
    let best = lis[0];
    for (const li of lis) { if (+li.dataset.t <= t + 1) best = li; else break; }
    const box = $("transcript");
    box.scrollTop = best.offsetTop - box.offsetTop - box.clientHeight / 3;
    best.classList.remove("flash"); void best.offsetWidth; best.classList.add("flash");
    setTimeout(() => best.classList.remove("flash"), 1600);
  }

  // =====================================================================
  // Chart (hand-built SVG: thin lines, ringed dots, recessive grid, crosshair)
  // =====================================================================
  let chartGeom = null;
  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function renderChart(model) {
    const svg = $("chartSvg");
    svg.innerHTML = "";
    const W = svg.clientWidth || 800, H = svg.clientHeight || 320;
    const m = { l: 34, r: 10, t: 34, b: 24 };
    const w = W - m.l - m.r, h = H - m.t - m.b;
    const D = Math.max(1, model.duration);
    const X = (t) => m.l + (t / D) * w;
    const Y = (v) => m.t + (1 - (v + 1) / 2) * h;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    const defs = el("defs", {}, svg);
    const pat = el("pattern", { id: "hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    el("rect", { width: 6, height: 6, fill: "#f2f5f6" }, pat);
    el("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "#dfe5e8", "stroke-width": 3 }, pat);

    // phase bands
    const bands = el("g", {}, svg);
    model.phases.forEach((p) => {
      const x0 = X(p.start), x1 = X(p.end), bw = Math.max(0, x1 - x0);
      const isCond = /_condition_/.test(p.id);
      if (p.kind === "break" || p.kind === "rest" || isCond) {
        el("rect", { x: x0, y: m.t, width: bw, height: h, class: p.kind === "break" ? "band band-break" : "band" }, bands);
      }
      if ((isCond || p.kind === "rest") && bw > 44) {
        const t1 = el("text", { x: x0 + 6, y: m.t - 18, class: "band-label" }, bands);
        t1.textContent = isCond ? (STRAT[p.strategy] || p.strategy) : "Rest";
        if (isCond && p.block) { const t2 = el("text", { x: x0 + 6, y: m.t - 5, class: "band-sub" }, bands); t2.textContent = `Part ${p.block}`; }
      }
    });

    // grid + y axis
    const grid = el("g", { class: "grid" }, svg);
    const axis = el("g", { class: "axis" }, svg);
    [-1, -0.5, 0, 0.5, 1].forEach((v) => {
      el("line", { x1: m.l, x2: m.l + w, y1: Y(v), y2: Y(v), class: v === 0 ? "zero" : "" }, v === 0 ? svg : grid);
      const tx = el("text", { x: m.l - 8, y: Y(v) + 4, "text-anchor": "end" }, axis);
      tx.textContent = v === 0 ? "0" : (v > 0 ? "+" : "−") + Math.abs(v);
    });
    // x ticks: pick a step that gives at most ~8 labels
    const steps = [30, 60, 120, 300, 600, 900];
    const step = steps.find((s) => D / s <= Math.max(3, Math.floor(w / 90))) || 1800;
    for (let t = 0; t <= D + 0.1; t += step) {
      const tx = el("text", { x: X(t), y: H - 6, "text-anchor": t === 0 ? "start" : "middle" }, axis);
      tx.textContent = step < 60 ? mmss(t) : `${Math.round(t / 60)}m`;
    }

    // estimated series: bucket-average to ~1 point per 2px, break the line across gaps
    const bucket = Math.max(0.5, (D / w) * 2);
    const series = (key) => {
      const pts = []; let acc = [], b0 = null, lastT = null;
      for (const s of model.affect) {
        const b = Math.floor(s.t / bucket);
        if (b0 !== null && b !== b0) { pts.push({ t: (b0 + 0.5) * bucket, y: mean(acc), gap: lastT != null && s.t - lastT > 4 }); acc = []; }
        b0 = b; acc.push(s[key]); lastT = s.t;
      }
      if (acc.length) pts.push({ t: (b0 + 0.5) * bucket, y: mean(acc) });
      let d = "";
      pts.forEach((p, i) => { d += `${i === 0 || pts[i - 1].gap ? "M" : "L"}${X(Math.min(p.t, D)).toFixed(1)},${Y(Math.max(-1, Math.min(1, p.y))).toFixed(1)}`; });
      return d;
    };
    el("path", { d: series("v"), class: "series s1" }, svg);
    el("path", { d: series("a"), class: "series s2" }, svg);

    // reported values (check-ins): ringed dots
    const dots = el("g", {}, svg);
    model.probes.filter((p) => p.answered).forEach((p) => {
      el("circle", { cx: X(p.t), cy: Y(p.repV), r: 5, class: "dot s1" }, dots);
      el("circle", { cx: X(p.t), cy: Y(p.repA), r: 5, class: "dot s2" }, dots);
    });

    const cross = el("line", { y1: m.t, y2: m.t + h, class: "cross", visibility: "hidden" }, svg);
    chartGeom = { X, Y, m, w, h, D, cross, W };
  }

  // crosshair + tooltip
  function nearestSample(t) {
    const a = state.model.affect; if (!a.length) return null;
    let lo = 0, hi = a.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (a[mid].t < t) lo = mid; else hi = mid; }
    return Math.abs(a[lo].t - t) < Math.abs(a[hi].t - t) ? a[lo] : a[hi];
  }
  function pointerT(evt) {
    const g = chartGeom, r = $("chartSvg").getBoundingClientRect();
    const x = ((evt.clientX - r.left) / r.width) * g.W;
    if (x < g.m.l || x > g.m.l + g.w) return null;
    return { t: ((x - g.m.l) / g.w) * g.D, x, px: evt.clientX - r.left, py: evt.clientY - r.top, rw: r.width };
  }
  $("chartSvg").addEventListener("pointermove", (evt) => {
    if (!chartGeom || !state.model) return;
    const p = pointerT(evt), tip = $("tip");
    if (!p) { chartGeom.cross.setAttribute("visibility", "hidden"); tip.classList.add("hidden"); return; }
    chartGeom.cross.setAttribute("x1", p.x); chartGeom.cross.setAttribute("x2", p.x);
    chartGeom.cross.setAttribute("visibility", "visible");
    const s = nearestSample(p.t);
    const ph = state.model.phases.find((x) => p.t >= x.start && p.t < x.end);
    const near = state.model.probes.find((q) => q.answered && Math.abs(chartGeom.X(q.t) - p.x) < 8);
    tip.innerHTML = `<div class="t-time">${mmss(p.t)}</div><div class="t-phase">${esc(ph ? phaseName(ph.id) : "")}</div>` +
      (s ? `<div class="t-row"><span><i style="background:var(--s1)"></i>Est. pleasantness</span><b>${signed(s.v)}</b></div>
            <div class="t-row"><span><i style="background:var(--s2)"></i>Est. activation</span><b>${signed(s.a)}</b></div>` : "") +
      (near ? `<div class="t-sep"></div>
            <div class="t-row"><span><i style="background:var(--s1)"></i>Reported pleasant</span><b>${near.valence}/9</b></div>
            <div class="t-row"><span><i style="background:var(--s2)"></i>Reported activated</span><b>${near.arousal}/9</b></div>
            <div class="t-row"><span>Noticed a change</span><b>${near.awareness}/7</b></div>` : "");
    tip.classList.remove("hidden");
    const tw = tip.offsetWidth, left = p.px + 14 + tw > p.rw ? p.px - tw - 14 : p.px + 14;
    tip.style.left = Math.max(0, left) + "px";
    tip.style.top = Math.max(0, p.py - tip.offsetHeight - 10) + "px";
  });
  $("chartSvg").addEventListener("pointerleave", () => {
    if (chartGeom) chartGeom.cross.setAttribute("visibility", "hidden");
    $("tip").classList.add("hidden");
  });
  $("chartSvg").addEventListener("click", (evt) => { const p = chartGeom && pointerT(evt); if (p) jumpTranscript(p.t); });
  let rz;
  new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => state.model && !$("detail").classList.contains("hidden") && renderChart(state.model), 120); }).observe($("chart"));

  // exports
  $("btnProbesCsv").addEventListener("click", () => {
    const m = state.model; if (!m) return;
    download(`${m.pid}_checkins_review.csv`, toCSV(m.probes.map((p) => ({
      probe_id: p.id, t_session_s: p.t, phase: p.phase, status: p.answered ? "answered" : p.status,
      valence: p.valence, arousal: p.arousal, awareness: p.awareness, rt_ms: p.rt_ms,
      reported_valence_rescaled: p.repV?.toFixed(3), reported_arousal_rescaled: p.repA?.toFixed(3),
      estimated_valence_30s: p.estV?.toFixed(3), estimated_arousal_30s: p.estA?.toFixed(3),
      agreement: p.agreement?.toFixed(3),
    }))));
  });
  $("btnAffectCsv").addEventListener("click", () => {
    const m = state.model; if (!m) return;
    download(`${m.pid}_affect_samples.csv`, toCSV(m.affect.map((s) => ({ t_session_s: s.t, valence: s.v, arousal: s.a }))));
  });

  route();
})();
