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

  panelCompanies.innerHTML = "";

  if (WATCHLIST.length === 0) {
    panelCompanies.innerHTML = emptyState(
      "No watchlist loaded — add companies to data/watchlist.txt (one per line: Company Name | careers URL | note)."
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

    panelCompanies.appendChild(section);
  }

  if (!anyShown) {
    panelCompanies.innerHTML = emptyState("Nothing on your watchlist matches the current filters.");
  }
}

function sameCompany(a, b) {
  return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
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
