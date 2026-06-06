const WORKER_BASE  = "https://cheapiho.gabrx.eu.org/v3";
const AUTH_PATH    = "/auth-p7/app/default/AuthApi4.php?a=aLoginPwd";
const BASE_API     = "/rest/w1";
const GRADES_YEAR  = 26; // da aggiornare ogni anno scolastico, penso

const state = {
  cookies:   null,   // { PHPSESSID, webidentity, webrole }
  studentId: null,
  gradesAvr: null,
};

async function cvFetch(path, opts = {}) {
  const url = `${WORKER_BASE}/proxy?path=${encodeURIComponent(path)}`;
  const headers = { ...(opts.headers || {}) };

  if (state.cookies) {
    headers["X-CV-Cookie"] = Object.entries(state.cookies)
      .map(([k, v]) => `${k}=${v}`).join("; ");
  }

  const res = await fetch(url, { ...opts, headers });

  if (!res.ok && res.status !== 302) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body: text });
  }
  return res;
}

async function cvJSON(path, opts = {}) {
  const res = await cvFetch(path, opts);
  return res.json();
}

async function login(uid, pwd) {
  const params = new URLSearchParams({ cid: "", uid, pwd, pin: "", target: "" });

  const res = await fetch(`${WORKER_BASE}/login`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    params.toString(),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "credenziali non valide");
  }

  const { cookies, studentId } = await res.json();

  if (!cookies?.PHPSESSID) {
    throw new Error("credenziali non valide");
  }

  state.cookies   = cookies;
  state.studentId = studentId;
  sessionStorage.setItem("cv_session", JSON.stringify({ cookies, studentId }));
}

function loadSession() {
  try {
    const saved = sessionStorage.getItem("cv_session");
    if (!saved) return false;
    const { cookies, studentId } = JSON.parse(saved);
    if (!cookies?.PHPSESSID || !studentId) return false;
    state.cookies   = cookies;
    state.studentId = studentId;
    return true;
  } catch { return false; }
}

function clearSession() {
  state.cookies   = null;
  state.studentId = null;
  state.gradesAvr = null;
  sessionStorage.removeItem("cv_session");
}

async function fetchGrades() {
  const data = await cvJSON(`${BASE_API}/students/${state.studentId}/grades${GRADES_YEAR}`);
  return data.grades || [];
}

function calcAvr(gradesList) {
  const avr = {};

  for (const g of gradesList) {
    const dec = g.decimalValue;
    if (dec == null || g.noAverage) continue;

    let period = String(g.periodPos - 1);
    if (period < "1") period = "1";

    if (!avr[period]) avr[period] = {};
    if (!avr[period][g.subjectDesc]) {
      avr[period][g.subjectDesc] = { avr: 0, grades: [] };
    }

    avr[period][g.subjectDesc].grades.push({
      decimalValue:   dec,
      displayValue:   g.displayValue,
      evtDate:        g.evtDate,
      componentDesc:  g.componentDesc,
      notesForFamily: g.notesForFamily,
      teacherName:    g.teacherName,
      isBlue:         g.color === "blue",
    });
  }

  for (const period of Object.keys(avr)) {
    const periodAll = [];
    for (const subj of Object.keys(avr[period])) {
      const eff = effectiveGrades(avr[period][subj].grades);
      avr[period][subj].avr = eff.length
        ? eff.reduce((a, b) => a + b, 0) / eff.length
        : 0;
      periodAll.push(...eff);
    }
    avr[period]._periodAvr = periodAll.length
      ? periodAll.reduce((a, b) => a + b, 0) / periodAll.length
      : 0;
  }

  const all = [];
  for (const period of Object.keys(avr)) {
    for (const subj of Object.keys(avr[period])) {
      if (subj === "_periodAvr") continue;
      all.push(...effectiveGrades(avr[period][subj].grades));
    }
  }
  avr._allAvr = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;

  return avr;
}

function effectiveGrades(gradesList) {
  const standalone = [];
  const groups = {};
  for (const g of gradesList) {
    if (g.componentDesc) {
      (groups[g.evtDate] = groups[g.evtDate] || []).push(g.decimalValue);
    } else {
      standalone.push(g.decimalValue);
    }
  }
  return [
    ...standalone,
    ...Object.values(groups).map(arr => arr.reduce((a, b) => a + b, 0) / arr.length),
  ];
}

function calcGoalGrade(currentAvr, currentCount, target, numGrades) {
  if (currentAvr >= target) return null;
  return (target * (currentCount + numGrades) - currentAvr * currentCount) / numGrades;
}

function gradeClass(v) {
  if (v >= 6.5) return "excellent";
  if (v >= 5.5) return "pass";
  return "fail";
}

function fmtAvr(v) {
  return typeof v === "number" ? v.toFixed(2) : "—";
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;");
}

function escAttr(s) {
  return escHtml(s).replace(/'/g, "&#39;");
}

function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.getElementById("logoutBtn").classList.toggle("hidden", id === "view-login");
}

function renderGrades(avr) {
  const container = document.getElementById("gradesContainer");
  const overallEl = document.getElementById("overallAvg");

  const overall = avr._allAvr || 0;
  overallEl.textContent = fmtAvr(overall);
  overallEl.className   = `summary-avg ${gradeClass(overall)}`;

  const periods = Object.keys(avr).filter(k => !k.startsWith("_")).sort();
  let html = "";

  for (const period of periods) {
    const subjects  = avr[period];
    const periodAvr = subjects._periodAvr || 0;

    html += `
      <div class="period-block">
        <div class="period-label">
          periodo ${period}
          <span class="period-avg ${gradeClass(periodAvr)}">${fmtAvr(periodAvr)}</span>
        </div>`;

    const subjNames = Object.keys(subjects).filter(k => !k.startsWith("_")).sort();
    for (const subj of subjNames) {
      const sd    = subjects[subj];
      const cls   = gradeClass(sd.avr);
      const chips = sd.grades.map(g => {
        const gc = g.isBlue ? "blue" : gradeClass(g.decimalValue);
        return `<span class="chip ${gc}" data-grade='${escAttr(JSON.stringify(g))}'>${g.displayValue || g.decimalValue}</span>`;
      }).join("");

      html += `
        <div class="subject-row" data-subject="${escAttr(subj)}" data-period="${period}">
          <div class="subject-name">${escHtml(subj)}</div>
          <div class="grade-chips">${chips}</div>
          <div class="subject-avg ${cls}">${fmtAvr(sd.avr)}</div>
        </div>`;
    }
    html += `</div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll(".subject-row").forEach(row => {
    row.addEventListener("click", e => {
      if (e.target.classList.contains("chip")) return;
      openSubject(row.dataset.subject);
    });
  });

  container.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", e => {
      e.stopPropagation();
      openGradeModal(JSON.parse(chip.dataset.grade));
    });
  });
}

function buildChart(container, grades) {
  if (grades.length < 1) return;

  const W = 300, H = 110;
  const PAD = { top: 12, right: 16, bottom: 20, left: 26 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top  - PAD.bottom;

  const vals  = grades.map(g => g.decimalValue);
  const minV  = Math.max(1, Math.floor(Math.min(...vals)) - 1);
  const maxV  = Math.min(10, Math.ceil(Math.max(...vals))  + 1);

  const xScale = i => PAD.left + (grades.length < 2 ? innerW / 2 : (i / (grades.length - 1)) * innerW);
  const yScale = v => PAD.top  + innerH - ((v - minV) / (maxV - minV)) * innerH;

  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const lineColor = avg >= 6.5
    ? "var(--green)"
    : avg >= 5.5 ? "var(--yellow)" : "var(--red)";

  function smoothPath(pts) {
    if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const cp1x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) / 2;
      const cp1y = pts[i - 1].y;
      const cp2x = pts[i].x   - (pts[i].x - pts[i - 1].x) / 2;
      const cp2y = pts[i].y;
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${pts[i].x} ${pts[i].y}`;
    }
    return d;
  }

  const pts = grades.map((g, i) => ({ x: xScale(i), y: yScale(g.decimalValue) }));
  const linePath = smoothPath(pts);

  const areaPath = linePath +
    ` L ${pts[pts.length - 1].x} ${PAD.top + innerH}` +
    ` L ${pts[0].x} ${PAD.top + innerH} Z`;

  let gridLines = "", yLabels = "";
  for (let v = Math.ceil(minV); v <= Math.floor(maxV); v++) {
    const y = yScale(v);
    const isSuff = v === 6;
    gridLines += `<line class="chart-grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y}" y2="${y}"
      ${isSuff ? 'stroke-dasharray="none" style="stroke:var(--muted);opacity:.4"' : ""}/>`;
    yLabels += `<text class="chart-y-label" x="${PAD.left - 5}" y="${y + 3}" text-anchor="end">${v}</text>`;
  }

  let dots = "";
  grades.forEach((g, i) => {
    const gc = g.isBlue ? "var(--blue)" : (g.decimalValue >= 6.5 ? "var(--green)" : g.decimalValue >= 5.5 ? "var(--yellow)" : "var(--red)");
    dots += `<circle class="chart-dot"
      cx="${pts[i].x}" cy="${pts[i].y}"
      r="4"
      fill="${gc}"
      data-val="${escAttr(g.displayValue || String(g.decimalValue))}"
      data-date="${escAttr(g.evtDate || "")}"
    />
    <circle class="chart-dot-hit"
      cx="${pts[i].x}" cy="${pts[i].y}"
      r="12"
      fill="transparent"
      data-idx="${i}"
    />`;
  });

  const gid = "cg" + Math.random().toString(36).slice(2, 7);

  const svgMarkup = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="${lineColor}" stop-opacity=".9"/>
          <stop offset="100%" stop-color="${lineColor}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      ${yLabels}
      <path class="chart-area" d="${areaPath}" fill="url(#${gid})"/>
      <path class="chart-line" d="${linePath}" stroke="${lineColor}"/>
      ${dots}
    </svg>
    <div class="chart-tooltip" id="chartTip"></div>`;

  container.innerHTML = svgMarkup;

  const tip = container.querySelector("#chartTip");
  const dotEls = container.querySelectorAll(".chart-dot");

  function activateDot(idx) {
    dotEls.forEach((d, j) => { d.setAttribute("r", j === idx ? "6" : "4"); });
  }
  function resetDots() {
    dotEls.forEach(d => d.setAttribute("r", "4"));
  }

  container.querySelectorAll(".chart-dot-hit").forEach(hit => {
    const i   = parseInt(hit.dataset.idx);
    const dot = dotEls[i];

    function showTip() {
      const val  = dot.dataset.val;
      const date = dot.dataset.date;
      tip.innerHTML = `<strong>${val}</strong><span class="tt-date">${date}</span>`;
      tip.classList.add("show");
      activateDot(i);

      const rect = container.getBoundingClientRect();
      const cx   = pts[i].x / W * rect.width;
      const cy   = pts[i].y / H * rect.height;
      tip.style.left = "0px";
      tip.style.top  = "0px";
      requestAnimationFrame(() => {
        let left = cx - tip.offsetWidth / 2;
        left = Math.max(0, Math.min(left, rect.width - tip.offsetWidth - 4));
        tip.style.left = left + "px";
        tip.style.top  = (cy - 46) + "px";
      });
    }
    function hideTip() {
      tip.classList.remove("show");
      resetDots();
    }

    hit.addEventListener("mouseenter", showTip);
    hit.addEventListener("mouseleave", hideTip);
    hit.addEventListener("touchstart", e => { e.preventDefault(); showTip(); }, { passive: false });
    hit.addEventListener("touchend",   hideTip);
  });
}

function openSubject(subjName) {
  const avr     = state.gradesAvr;
  const periods = Object.keys(avr).filter(k => !k.startsWith("_")).sort();

  let allGrades = [];
  for (const p of periods) {
    if (avr[p][subjName]) allGrades.push(...avr[p][subjName].grades);
  }

  const vals    = allGrades.map(g => g.decimalValue).filter(v => v != null);
  const subjAvr = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const highest = vals.length ? Math.max(...vals) : null;
  const lowest  = vals.length ? Math.min(...vals) : null;

  let html = `
    <div class="subject-header">
      <div class="subject-header-name">${escHtml(subjName)}</div>
      <div class="subject-stats">
        <div class="stat">
          <div class="stat-value ${gradeClass(subjAvr)}">${fmtAvr(subjAvr)}</div>
          <div class="stat-label">media</div>
        </div>
        <div class="stat">
          <div class="stat-value">${allGrades.length}</div>
          <div class="stat-label">voti</div>
        </div>
        ${highest != null ? `
        <div class="stat">
          <div class="stat-value ${gradeClass(highest)}">${fmtAvr(highest)}</div>
          <div class="stat-label">massimo</div>
        </div>` : ""}
        ${lowest != null ? `
        <div class="stat">
          <div class="stat-value ${gradeClass(lowest)}">${fmtAvr(lowest)}</div>
          <div class="stat-label">minimo</div>
        </div>` : ""}
      </div>
      <div class="chart-section">
        <div class="chart-title">andamento vot</div>
        <div class="chart-wrap" id="subjectChartContainer"></div>
      </div>
    </div>`;

  for (const p of periods) {
    if (!avr[p][subjName]) continue;
    const grades = avr[p][subjName].grades;

    html += `
      <div class="period-grades">
        <div class="period-label" style="padding-top:0">periodo ${p}</div>`;

    for (const g of grades) {
      const gc = g.isBlue ? "blue" : gradeClass(g.decimalValue);
      html += `
        <div class="grade-card" data-grade='${escAttr(JSON.stringify(g))}'>
          <div class="grade-big ${gc}">${g.displayValue || fmtAvr(g.decimalValue)}</div>
          <div class="grade-meta">
            <div class="grade-date">${g.evtDate || "—"}</div>
            ${g.componentDesc ? `<div class="grade-component">${escHtml(g.componentDesc)}</div>` : ""}
            ${g.notesForFamily ? `<div class="grade-note">${escHtml(g.notesForFamily)}</div>` : ""}
          </div>
          ${g.teacherName ? `<div style="font-size:11px;color:var(--muted);text-align:right;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(g.teacherName)}</div>` : ""}
        </div>`;
    }
    html += `</div>`;
  }

  html += `
    <div class="goal-section">
      <div class="goal-title">simulatore voto</div>
      <div class="goal-row">
        <span style="font-size:13px;color:var(--muted)">obiettivo</span>
        <input class="goal-input" id="goalTarget" type="number" min="1" max="10" step="0.25" placeholder="es. 7" />
        <span style="font-size:13px;color:var(--muted)">in</span>
        <input class="goal-input" id="goalNumGrades" type="number" min="1" max="10" step="1" value="1" style="width:54px" />
        <span style="font-size:13px;color:var(--muted)">voti</span>
        <button class="goal-btn" id="goalCalcBtn">calcola</button>
      </div>
      <div class="goal-result" id="goalResult"></div>
    </div>

    <div class="goal-section">
      <div class="goal-title">previsione media</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px">inserisci i voti futuri (separati da virgola o spazio)</div>
      <div class="goal-row" style="flex-wrap:nowrap;gap:8px">
        <input class="goal-input" id="forecastGrades" type="text" placeholder="es. 7, 8, 6.5" style="width:100%;flex:1" />
        <button class="goal-btn" id="forecastCalcBtn">simula</button>
      </div>
      <div class="goal-result" id="forecastResult"></div>
    </div>`;

  document.getElementById("subjectContent").innerHTML = html;
  const chartContainer = document.getElementById("subjectChartContainer");
  if (chartContainer) {
    const sortedGrades = [...allGrades].sort((a, b) => new Date(a.evtDate) - new Date(b.evtDate));
    buildChart(chartContainer, sortedGrades);
  }

  document.querySelectorAll(".grade-card").forEach(card => {
    card.addEventListener("click", () => openGradeModal(JSON.parse(card.dataset.grade)));
  });

  document.getElementById("goalCalcBtn").addEventListener("click", () => {
    const target    = parseFloat(document.getElementById("goalTarget").value);
    const numGrades = parseInt(document.getElementById("goalNumGrades").value) || 1;
    const res       = document.getElementById("goalResult");

    if (isNaN(target) || target < 1 || target > 10) {
      res.textContent = "inserisci un obiettivo valido (1–10)";
      return;
    }

    const needed = calcGoalGrade(subjAvr, vals.length, target, numGrades);
    if (needed === null) {
      res.innerHTML = `media attuale già ≥ <strong>${target}</strong> 🎉`;
    } else if (needed > 10) {
      res.innerHTML = `non raggiungibile con ${numGrades} vot${numGrades === 1 ? "o" : "i"} (servirebbe <strong>${fmtAvr(needed)}</strong>)`;
    } else {
      res.innerHTML = `con ${numGrades} vot${numGrades === 1 ? "o" : "i"} da <strong>${fmtAvr(needed)}</strong> raggiungi <strong>${target}</strong>`;
    }
  });

  document.getElementById("forecastCalcBtn").addEventListener("click", () => {
    const raw = document.getElementById("forecastGrades").value;
    const res = document.getElementById("forecastResult");

    const parsed = raw.split(/[,\s]+/).map(s => parseFloat(s.replace(",", "."))).filter(v => !isNaN(v) && v >= 1 && v <= 10);
    if (!parsed.length) {
      res.textContent = "inserisci almeno un voto valido (1–10)";
      return;
    }

    const newCount = vals.length + parsed.length;
    const newSum   = vals.reduce((a, b) => a + b, 0) + parsed.reduce((a, b) => a + b, 0);
    const newAvr   = newSum / newCount;
    const delta    = newAvr - subjAvr;
    const deltaStr = (delta >= 0 ? "+" : "") + fmtAvr(delta);
    const cls      = gradeClass(newAvr);

    res.innerHTML = `con ${parsed.length} vot${parsed.length === 1 ? "o" : "i"} aggiunt${parsed.length === 1 ? "o" : "i"}: media → <strong class="${cls}">${fmtAvr(newAvr)}</strong> <span style="color:var(--muted)">(${deltaStr})</span>`;
  });

  showView("view-subject");
}

function openGradeModal(g) {
  const gc = g.isBlue ? "blue" : gradeClass(g.decimalValue);
  document.getElementById("modalGrade").textContent = g.displayValue || fmtAvr(g.decimalValue);
  document.getElementById("modalGrade").className   = `modal-grade-big ${gc}`;

  const rows = [
    ["data",       g.evtDate || "—"],
    g.componentDesc  ? ["componente", g.componentDesc]  : null,
    g.teacherName    ? ["docente",    g.teacherName]     : null,
    g.notesForFamily ? ["note",       g.notesForFamily]  : null,
    g.isBlue         ? ["tipo",       "voto blu (orale)"] : null,
  ].filter(Boolean);

  document.getElementById("modalRows").innerHTML = rows
    .map(([label, val]) =>
      `<div class="modal-row">
        <span class="modal-row-label">${label}</span>
        <span>${escHtml(String(val))}</span>
      </div>`
    ).join("");

  document.getElementById("gradeModal").classList.add("show");
}

function initTheme() {
  const saved  = localStorage.getItem("theme");
  const system = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  applyTheme(saved || system);
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t === "light" ? "light" : "";
  document.getElementById("themeIconSun").classList.toggle("hidden",  t === "light");
  document.getElementById("themeIconMoon").classList.toggle("hidden", t !== "light");
  localStorage.setItem("theme", t);
}

async function loadAndRender() {
  try {
    const grades    = await fetchGrades();
    state.gradesAvr = calcAvr(grades);
    renderGrades(state.gradesAvr);
    showView("view-grades");
  } catch (err) {
    if (err.status === 401) {
      clearSession();
      showView("view-login");
    } else {
      document.getElementById("gradesContainer").innerHTML =
        `<div style="padding:20px;color:var(--red);font-size:13px">
          errore nel caricamento dei voti: ${escHtml(err.message)}
        </div>`;
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initTheme();

  document.getElementById("themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    applyTheme(cur === "light" ? "dark" : "light");
  });

  document.getElementById("modalClose").addEventListener("click", () =>
    document.getElementById("gradeModal").classList.remove("show"));
  document.getElementById("gradeModal").addEventListener("click", e => {
    if (e.target === document.getElementById("gradeModal"))
      document.getElementById("gradeModal").classList.remove("show");
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") document.getElementById("gradeModal").classList.remove("show");
  });

  document.getElementById("backBtn").addEventListener("click", () => showView("view-grades"));

  document.getElementById("logoutBtn").addEventListener("click", () => {
    clearSession();
    showView("view-login");
  });

  document.getElementById("refreshBtn").addEventListener("click", async () => {
    const btn = document.getElementById("refreshBtn");
    btn.classList.add("spinning");
    btn.disabled = true;
    try {
      await loadAndRender();
    } finally {
      btn.classList.remove("spinning");
      btn.disabled = false;
    }
  });

  const loginBtn = document.getElementById("loginBtn");
  const errorEl  = document.getElementById("loginError");
  const uidInput = document.getElementById("inp-uid");
  const pwdInput = document.getElementById("inp-pwd");

  async function doLogin() {
    const uid = uidInput.value.trim();
    const pwd = pwdInput.value;
    if (!uid || !pwd) { errorEl.textContent = "inserisci credenziali"; return; }

    loginBtn.disabled    = true;
    loginBtn.textContent = "accesso in corso...";
    errorEl.textContent  = "";

    try {
      await login(uid, pwd);
      await loadAndRender();
    } catch (err) {
      errorEl.textContent  = err.message || "errore di login";
      loginBtn.disabled    = false;
      loginBtn.textContent = "Accedi";
    }
  }

  loginBtn.addEventListener("click", doLogin);
  pwdInput.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
  uidInput.addEventListener("keydown", e => { if (e.key === "Enter") pwdInput.focus(); });

  if (loadSession()) {
    showView("view-grades");
    loadAndRender();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
});
