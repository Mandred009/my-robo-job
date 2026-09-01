const CATEGORY_META = {
  manipulation_research: { label: "Manipulation & Physical AI", rail: "MANIP" },
  humanoid_legged: { label: "Humanoid & Legged Robotics", rail: "HMND" },
  medical_surgical: { label: "Surgical & Medical Robotics", rail: "SURG" },
  defense_public_safety: { label: "Defense & Public-Safety Robotics", rail: "DFNS" },
  other: { label: "Adjacent & Autonomy", rail: "ADJ" },
};
const CATEGORY_ORDER = [
  "manipulation_research",
  "humanoid_legged",
  "medical_surgical",
  "defense_public_safety",
  "other",
];

const LEVEL_LABEL = { entry: "New grad / intern", experienced: "Experienced", unspecified: "Level unspecified" };
const SOURCE_LABEL = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workday: "Workday", manual: "manual" };

function sourceLabel(job) {
  if (job.source && job.source.startsWith("aggregator:")) return job.source_display || "community tracker";
  return SOURCE_LABEL[job.source] || job.source || "";
}

let DATA = { generated_at: null, jobs: [] };
let WATCHLIST = []; // [{ company, url, note }]
let ACTIVE_TAB = "all";

const panelAll = document.getElementById("panel-all");
const panelCompanies = document.getElementById("panel-companies");
const searchEl = document.getElementById("search");
const levelEl = document.getElementById("level-filter");
const tabAllBtn = document.getElementById("tab-all");
const tabCompaniesBtn = document.getElementById("tab-companies");

async function load() {
  try {
    const res = await fetch("./data/jobs.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (err) {
    panelAll.innerHTML = emptyState(
      `Couldn't load today's scan (${escapeHtml(String(err.message || err))}). ` +
      `If this is a fresh deploy, the first scheduled run hasn't happened yet — ` +
      `trigger it manually from the Actions tab, or wait for the next scheduled run.`
    );
    return;
  }

  try {
    const wRes = await fetch("./data/watchlist.txt", { cache: "no-store" });
    if (wRes.ok) WATCHLIST = parseWatchlist(await wRes.text());
  } catch (err) {
    // Non-fatal — the "My companies" tab will just say the list couldn't load.
    console.warn("watchlist load failed", err);
  }

  renderStats();
  renderAll();
  renderCompanies();
  renderGhStatus();
}

function parseWatchlist(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [company, url, note] = line.split("|").map((s) => (s || "").trim());
      return { company, url: url || null, note: note || null };
    })
    .filter((entry) => entry.company);
}

function scanDateOf(generatedAt) {
  return generatedAt ? generatedAt.slice(0, 10) : null;
}

function renderStats() {
  const scanDate = scanDateOf(DATA.generated_at);
  const newCount = DATA.jobs.filter((j) => j.first_seen === scanDate).length;
  document.getElementById("stat-total").textContent = DATA.jobs.length;
  document.getElementById("stat-new").textContent = newCount;
  document.getElementById("stat-scan").textContent = DATA.generated_at
    ? DATA.generated_at.replace("T", " ").replace("Z", "")
    : "—";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function emptyState(msg) {
  return `<div class="empty-state">${msg}</div>`;
}

function matchesFilters(job, query, level) {
  if (level !== "all" && job.level !== level) return false;
  if (!query) return true;
  const hay = `${job.company} ${job.title} ${job.location}`.toLowerCase();
  return hay.includes(query);
}

function currentQuery() {
  return searchEl.value.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Tab 1: all postings, grouped by category
// ---------------------------------------------------------------------------

function renderAll() {
  const query = currentQuery();
  const level = levelEl.value;
  const scanDate = scanDateOf(DATA.generated_at);

  panelAll.innerHTML = "";

  for (const cat of CATEGORY_ORDER) {
    const meta = CATEGORY_META[cat];
    const all = DATA.jobs.filter((j) => j.category === cat);
    const rows = all.filter((j) => matchesFilters(j, query, level));

    const section = document.createElement("section");
    section.className = "channel";
    section.innerHTML = `
      <div class="channel-head">
        <span class="channel-rail">${meta.rail}</span>
        <h2>${meta.label}</h2>
        <span class="channel-count">${rows.length} shown / ${all.length} tracked</span>
      </div>
      <div class="channel-body"></div>
    `;

    const body = section.querySelector(".channel-body");
    if (rows.length === 0) {
      body.innerHTML = emptyState(
        all.length === 0 ? "No open matches right now — check back after the next scan." : "Nothing matches the current filters."
      );
    } else {
      for (const j of rows) body.appendChild(renderRow(j, scanDate));
    }

    panelAll.appendChild(section);
  }
}

function renderRow(job, scanDate) {
  const row = document.createElement("div");
  row.className = "job-row";
  const isNew = job.first_seen === scanDate;
  row.innerHTML = `
    <div class="job-main">
      <div class="job-title"><a href="${job.url}" target="_blank" rel="noopener">${escapeHtml(job.title)}</a></div>
      <div class="job-meta"><span class="company">${escapeHtml(job.company)}</span>${job.location ? " · " + escapeHtml(job.location) : ""}${sourceLabel(job) ? " · via " + escapeHtml(sourceLabel(job)) : ""}</div>
    </div>
    <span class="badge level-${job.level}">${LEVEL_LABEL[job.level] || job.level}</span>
    ${isNew ? '<span class="badge new">NEW</span>' : "<span></span>"}
  `;
  return row;
}

// ---------------------------------------------------------------------------
// Tab 2: grouped by the user-maintained watchlist
// ---------------------------------------------------------------------------

function renderCompanies() {
  const query = currentQuery();
  const level = levelEl.value;
  const scanDate = scanDateOf(DATA.generated_at);
  const listEl = document.getElementById("company-list");

  listEl.innerHTML = "";

  if (WATCHLIST.length === 0) {
    listEl.innerHTML = emptyState(
      "No watchlist loaded — add a company above, or edit data/watchlist.txt directly."
    );
    return;
  }

  // Companies with open matches float to the top; rest stay alphabetical.
  const entries = [...WATCHLIST].sort((a, b) => {
    const aHas = DATA.jobs.some((j) => sameCompany(j.company, a.company));
    const bHas = DATA.jobs.some((j) => sameCompany(j.company, b.company));
    if (aHas !== bHas) return aHas ? -1 : 1;
    return a.company.localeCompare(b.company);
  });

  let anyShown = false;

  for (const entry of entries) {
    const all = DATA.jobs.filter((j) => sameCompany(j.company, entry.company));
    const rows = all.filter((j) => matchesFilters(j, query, level));
    if (query && rows.length === 0 && !entry.company.toLowerCase().includes(query)) continue;
    anyShown = true;

    const section = document.createElement("section");
    section.className = "channel";
    section.innerHTML = `
      <div class="channel-head">
        <span class="channel-rail">${rows.length > 0 ? "●" : "○"}</span>
        <h2>${escapeHtml(entry.company)}</h2>
        <span class="channel-count">${all.length} open match${all.length === 1 ? "" : "es"}</span>
        <button type="button" class="remove-btn" data-company="${escapeHtml(entry.company)}" title="Remove from watchlist">✕</button>
      </div>
      <div class="channel-body"></div>
    `;
    if (entry.note) {
      const note = document.createElement("p");
      note.className = "manual-note";
      note.style.padding = "10px 16px 0";
      note.textContent = entry.note;
      section.querySelector(".channel-head").after(note);
    }

    const body = section.querySelector(".channel-body");
    if (rows.length > 0) {
      for (const j of rows) body.appendChild(renderRow(j, scanDate));
    } else if (entry.url) {
      body.innerHTML = emptyState(
        `No matches from the scan yet. <a href="${entry.url}" target="_blank" rel="noopener">Check their careers page directly →</a>`
      );
    } else {
      body.innerHTML = emptyState("No matches from the scan yet, and no careers URL on file for this entry.");
    }

    listEl.appendChild(section);
  }

  if (!anyShown) {
    listEl.innerHTML = emptyState("Nothing on your watchlist matches the current filters.");
  }

  listEl.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => onRemoveCompany(btn.dataset.company));
  });
}

function sameCompany(a, b) {
  return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// GitHub write-back — lets "Add company" save straight to watchlist.txt
// ---------------------------------------------------------------------------
// GitHub Pages only serves static files, so there's no server this page can
// write to. The only way an "Add company" button can persist anything is to
// call GitHub's own API directly from the browser, authenticated with a
// token you paste in yourself. That token lives only in this browser's
// localStorage — it's never in the site's code and never goes anywhere but
// api.github.com. Use a fine-grained token scoped to just this repo with
// only "Contents: Read and write" permission, so a leaked token can't do
// anything beyond editing this one file.

const GH_STORE_KEY = "rjr:gh";

function ghAutoDetect() {
  const host = location.hostname; // e.g. yourname.github.io
  const owner = host.endsWith(".github.io") ? host.split(".")[0] : "";
  const repo = location.pathname.split("/").filter(Boolean)[0] || "";
  return { owner, repo };
}

function ghConfig() {
  try {
    const raw = localStorage.getItem(GH_STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function ghSaveConfig(cfg) {
  localStorage.setItem(GH_STORE_KEY, JSON.stringify(cfg));
}

function ghClearConfig() {
  localStorage.removeItem(GH_STORE_KEY);
}

function isConnected() {
  const cfg = ghConfig();
  return !!(cfg && cfg.token && cfg.owner && cfg.repo);
}

async function ghApi(path, options = {}) {
  const cfg = ghConfig();
  if (!cfg || !cfg.token) throw new Error("Not connected — click ⚙ Connect GitHub first.");
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = `GitHub API ${res.status}`;
    if (res.status === 401) msg = "Token rejected — check it's valid and not expired.";
    if (res.status === 404) msg = "Repo or file not found — check the owner/repo fields.";
    if (res.status === 403) msg = "Forbidden — token may lack write permission on this repo.";
    throw new Error(`${msg} ${body.slice(0, 150)}`);
  }
  return res.json();
}

function b64EncodeUnicode(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}
function b64DecodeUnicode(str) {
  return new TextDecoder().decode(Uint8Array.from(atob(str.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
}

async function ghGetWatchlistFile() {
  const data = await ghApi("/contents/data/watchlist.txt");
  return { text: b64DecodeUnicode(data.content), sha: data.sha };
}

async function ghPutWatchlistFile(text, sha, message) {
  return ghApi("/contents/data/watchlist.txt", {
    method: "PUT",
    body: JSON.stringify({ message, content: b64EncodeUnicode(text), sha }),
  });
}

async function addCompanyToWatchlist(company, url, note) {
  const { text, sha } = await ghGetWatchlistFile();
  const lines = text.split("\n");
  const idx = lines.findIndex((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return false;
    return sameCompany(trimmed.split("|")[0].trim(), company);
  });
  const newLine = [company, url, note].filter((v) => v).join(" | ");
  if (idx >= 0) {
    lines[idx] = newLine; // already on the list — update it instead of duplicating
  } else {
    lines.push(newLine);
  }
  const newText = lines.join("\n");
  await ghPutWatchlistFile(newText, sha, `Add ${company} to watchlist`);
  return newText;
}

async function removeCompanyFromWatchlist(company) {
  const { text, sha } = await ghGetWatchlistFile();
  const lines = text.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return true;
    return !sameCompany(trimmed.split("|")[0].trim(), company);
  });
  const newText = lines.join("\n");
  await ghPutWatchlistFile(newText, sha, `Remove ${company} from watchlist`);
  return newText;
}

function renderGhStatus() {
  const statusEl = document.getElementById("gh-status");
  const cfg = ghConfig();
  if (cfg && cfg.token) {
    statusEl.textContent = `writing to ${cfg.owner}/${cfg.repo}`;
    statusEl.classList.add("connected");
  } else {
    statusEl.textContent = "not connected — additions won't save";
    statusEl.classList.remove("connected");
  }
}

async function onRemoveCompany(company) {
  if (!isConnected()) {
    alert("Connect a GitHub token first (⚙ Connect GitHub) so removals can be saved.");
    return;
  }
  if (!confirm(`Remove ${company} from your watchlist?`)) return;
  try {
    const newText = await removeCompanyFromWatchlist(company);
    WATCHLIST = parseWatchlist(newText);
    renderCompanies();
  } catch (err) {
    alert(`Couldn't remove: ${err.message}`);
  }
}

function wireGhControls() {
  const auto = ghAutoDetect();
  document.getElementById("gh-owner-input").placeholder = `GitHub username (${auto.owner || "auto-detect failed"})`;
  document.getElementById("gh-repo-input").placeholder = `Repo name (${auto.repo || "auto-detect failed"})`;

  document.getElementById("gh-connect-btn").addEventListener("click", () => {
    const panel = document.getElementById("gh-connect-panel");
    panel.hidden = !panel.hidden;
  });

  document.getElementById("gh-connect-save").addEventListener("click", () => {
    const token = document.getElementById("gh-token-input").value.trim();
    const owner = document.getElementById("gh-owner-input").value.trim() || auto.owner;
    const repo = document.getElementById("gh-repo-input").value.trim() || auto.repo;
    if (!token || !owner || !repo) {
      alert("Need a token, and an owner/repo (auto-detect couldn't fill one in — enter it manually).");
      return;
    }
    ghSaveConfig({ token, owner, repo });
    document.getElementById("gh-token-input").value = "";
    renderGhStatus();
    document.getElementById("gh-connect-panel").hidden = true;
  });

  document.getElementById("gh-connect-forget").addEventListener("click", () => {
    ghClearConfig();
    renderGhStatus();
  });

  document.getElementById("add-company-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const nameEl = document.getElementById("add-company-name");
    const urlEl = document.getElementById("add-company-url");
    const noteEl = document.getElementById("add-company-note");
    const company = nameEl.value.trim();
    if (!company) return;
    if (!isConnected()) {
      alert("Connect a GitHub token first (⚙ Connect GitHub) so this can be saved.");
      return;
    }
    const submitBtn = ev.target.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    try {
      const newText = await addCompanyToWatchlist(company, urlEl.value.trim(), noteEl.value.trim());
      WATCHLIST = parseWatchlist(newText);
      nameEl.value = "";
      urlEl.value = "";
      noteEl.value = "";
      renderCompanies();
    } catch (err) {
      alert(`Couldn't save: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Add";
    }
  });
}

// ---------------------------------------------------------------------------
// Tabs + filters
// ---------------------------------------------------------------------------

function setTab(tab) {
  ACTIVE_TAB = tab;
  const isAll = tab === "all";
  panelAll.hidden = !isAll;
  panelCompanies.hidden = isAll;
  tabAllBtn.classList.toggle("active", isAll);
  tabCompaniesBtn.classList.toggle("active", !isAll);
  tabAllBtn.setAttribute("aria-selected", String(isAll));
  tabCompaniesBtn.setAttribute("aria-selected", String(!isAll));
}

tabAllBtn.addEventListener("click", () => setTab("all"));
tabCompaniesBtn.addEventListener("click", () => setTab("companies"));

searchEl.addEventListener("input", () => {
  renderAll();
  renderCompanies();
});
levelEl.addEventListener("change", () => {
  renderAll();
  renderCompanies();
});

load();
wireGhControls();
