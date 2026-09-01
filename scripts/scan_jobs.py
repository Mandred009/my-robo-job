#!/usr/bin/env python3
"""
Robotics Job Radar — daily scanner.

Pulls current postings from a set of public applicant-tracking-system (ATS)
APIs for companies in Mandred's target list (manipulation / physical-AI
research, humanoid & legged robotics, surgical & medical robotics, and
defense / public-safety robotics), filters them against his specialty and
level keywords, and writes the result to data/jobs.json for the static
site to render.

Design notes:
- Every network call is wrapped so one broken source never kills the run.
- Greenhouse / Lever / Ashby expose small, stable, public JSON APIs — those
  boards are fetched in full and filtered locally (their boards are small
  enough that this is cheap and precise).
- Large corporate boards (Workday) are queried directly with each specialty
  term via their search endpoint, then filtered locally for level, because
  fetching their entire board would be thousands of irrelevant postings.
- "first_seen" is carried forward from the previous run so the site can
  badge postings that appeared since the last scan.
"""

import hashlib
import json
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "jobs.json"
USER_AGENT = "robotics-job-radar/1.0 (personal job tracker; contact via GitHub repo)"

# ---------------------------------------------------------------------------
# Target companies
# ---------------------------------------------------------------------------
# category: manipulation_research | humanoid_legged | medical_surgical |
#           defense_public_safety | other

GREENHOUSE_COMPANIES = [
    {"name": "Anduril Industries", "token": "andurilindustries", "category": "defense_public_safety"},
    {"name": "Skild AI", "token": "skildai-careers", "category": "manipulation_research"},
    {"name": "Apptronik", "token": "apptronik", "category": "humanoid_legged"},
    {"name": "Kodiak Robotics", "token": "kodiak", "category": "other"},
]

LEVER_COMPANIES = [
    {"name": "Capstan Medical", "site": "capstan-medical", "category": "medical_surgical"},
]

ASHBY_COMPANIES = [
    {"name": "Physical Intelligence", "board": "physicalintelligence", "category": "manipulation_research"},
    {"name": "GrayMatter Robotics", "board": "graymatter-robotics", "category": "defense_public_safety"},
]

# Workday is queried by search term rather than fetched whole (boards are huge).
WORKDAY_COMPANIES = [
    {"name": "NVIDIA", "host": "nvidia.wd5.myworkdayjobs.com", "tenant": "nvidia",
     "site": "nvidiaexternalcareersite", "category": "manipulation_research"},
    {"name": "Medtronic", "host": "medtronic.wd1.myworkdayjobs.com", "tenant": "medtronic",
     "site": "MedtronicCareers", "category": "medical_surgical"},
    {"name": "GE Aerospace", "host": "geaerospace.wd5.myworkdayjobs.com", "tenant": "geaerospace",
     "site": "ge_externalsite", "category": "other"},
    {"name": "Johnson & Johnson", "host": "jj.wd5.myworkdayjobs.com", "tenant": "jj",
     "site": "jj", "category": "medical_surgical"},
    {"name": "Philips", "host": "philips.wd3.myworkdayjobs.com", "tenant": "philips",
     "site": "jobs-and-careers", "category": "medical_surgical"},
]

WORKDAY_SEARCH_TERMS = [
    "robotics", "surgical robot", "manipulation", "autonomy", "controls engineer",
]

# ---------------------------------------------------------------------------
# Broad-net sources — crowd-maintained trackers, not a fixed company list.
# ---------------------------------------------------------------------------
# The direct GREENHOUSE/LEVER/ASHBY/WORKDAY sources above only cover companies
# someone (me) already thought to add — that structurally can't catch a robotics
# startup nobody's heard of yet. There is no public "search every ATS at once"
# API (that's what paid aggregators like LinkedIn/Indeed/Simplify sell), but a
# couple of large, actively-maintained community trackers already do that
# scanning across hundreds of companies and publish the result as raw JSON.
# Pulling from those and filtering locally for robotics/manipulation keywords
# gets the benefit of that wider net without hand-maintaining hundreds of board
# tokens. These are community conventions, not an officially documented API,
# so each fetch is wrapped defensively — if a repo restructures its data file,
# that one source just contributes zero rows instead of breaking the run.
AGGREGATOR_SOURCES = [
    {
        "label": "simplifyjobs-newgrad",
        "display": "SimplifyJobs · New-Grad-Positions",
        "url": "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
    },
    {
        "label": "simplifyjobs-internships",
        "display": "SimplifyJobs · Summer2027-Internships",
        "url": "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
    },
]

# Companies with no public job-board API (Figure AI, Boston Dynamics, Agility
# Robotics, 1X, Unitree, Toyota Research Institute, Intuitive Surgical,
# Vicarious Surgical, Shield AI, Mach Industries, etc.) aren't tracked here —
# that list now lives entirely in data/watchlist.txt, which the site reads
# directly and you edit without touching this script. Keeping one list
# instead of two avoids them drifting out of sync.

# ---------------------------------------------------------------------------
# Keyword filters
# ---------------------------------------------------------------------------

SPECIALTY_KEYWORDS = [
    "robot", "robotics", "manipulation", "humanoid", "autonomy", "autonomous",
    "physical ai", "embodied", "controls", "slam", "locomotion", "dexterous",
    "loco-manipulation", "mechatron", "perception", "motion planning",
    "surgical robot", "surgical robotics",
]

LEVEL_KEYWORDS_ENTRY = [
    "new grad", "university grad", "college grad", "intern", "internship",
    "co-op", "coop", "entry level", "entry-level", "early career", "early-career",
    "rise program", "rotational", "2027", "graduate program",
]

LEVEL_KEYWORDS_SENIOR = [
    "senior", "staff", "lead", "principal", "director", "vp ", "head of",
    "manager", "iii", " ii ",
]


def matches_specialty(title: str) -> bool:
    t = title.lower()
    return any(k in t for k in SPECIALTY_KEYWORDS)


def classify_level(title: str) -> str:
    t = title.lower()
    if any(k in t for k in LEVEL_KEYWORDS_ENTRY):
        return "entry"
    if any(k in t for k in LEVEL_KEYWORDS_SENIOR):
        return "experienced"
    return "unspecified"


def guess_category(company: str, title: str) -> str:
    """Best-effort bucket for aggregator rows, which don't come pre-labeled.
    Hand-configured sources above set their category explicitly and skip this."""
    text = f"{company} {title}".lower()
    if any(k in text for k in ["surg", "medical device", "catheter", "cardiac", "endoscop"]):
        return "medical_surgical"
    if any(k in text for k in ["defense", "military", "national security", "government", " dod ", "aerospace"]):
        return "defense_public_safety"
    if any(k in text for k in ["humanoid", "legged", "quadruped", "bipedal", "exoskeleton"]):
        return "humanoid_legged"
    return "manipulation_research"


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------

def fetch_json(url: str, method: str = "GET", body: dict | None = None, timeout: int = 20):
    data = None
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def safe(label, fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001 — one bad source must not kill the run
        print(f"[warn] {label} failed: {exc}", file=sys.stderr)
        return []


# ---------------------------------------------------------------------------
# Per-source fetchers — each returns a list of normalized job dicts
# ---------------------------------------------------------------------------

def fetch_greenhouse(company: dict) -> list[dict]:
    url = f"https://boards-api.greenhouse.io/v1/boards/{company['token']}/jobs?content=true"
    payload = fetch_json(url)
    out = []
    for j in payload.get("jobs", []):
        title = j.get("title", "")
        if not matches_specialty(title):
            continue
        loc = (j.get("location") or {}).get("name", "")
        out.append({
            "id": f"greenhouse-{company['token']}-{j.get('id')}",
            "company": company["name"],
            "title": title,
            "location": loc,
            "url": j.get("absolute_url", ""),
            "category": company["category"],
            "level": classify_level(title),
            "source": "greenhouse",
            "posted_at": (j.get("updated_at") or "")[:10] or None,
        })
    return out


def fetch_lever(company: dict) -> list[dict]:
    url = f"https://api.lever.co/v0/postings/{company['site']}?mode=json"
    payload = fetch_json(url)
    out = []
    for j in payload:
        title = j.get("text", "")
        if not matches_specialty(title):
            continue
        loc = ((j.get("categories") or {}).get("location")) or ""
        posted = None
        ts = j.get("createdAt")
        if isinstance(ts, (int, float)):
            posted = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        out.append({
            "id": f"lever-{company['site']}-{j.get('id')}",
            "company": company["name"],
            "title": title,
            "location": loc,
            "url": j.get("hostedUrl", ""),
            "category": company["category"],
            "level": classify_level(title),
            "source": "lever",
            "posted_at": posted,
        })
    return out


def fetch_ashby(company: dict) -> list[dict]:
    url = f"https://api.ashbyhq.com/posting-api/job-board/{company['board']}"
    payload = fetch_json(url)
    out = []
    for j in payload.get("jobs", []):
        title = j.get("title", "")
        if not matches_specialty(title):
            continue
        loc = j.get("locationName") or j.get("location") or ""
        out.append({
            "id": f"ashby-{company['board']}-{j.get('id')}",
            "company": company["name"],
            "title": title,
            "location": loc,
            "url": j.get("jobUrl") or j.get("applyUrl") or "",
            "category": company["category"],
            "level": classify_level(title),
            "source": "ashby",
            "posted_at": (j.get("publishedAt") or "")[:10] or None,
        })
    return out


def fetch_workday(company: dict) -> list[dict]:
    base = f"https://{company['host']}/wday/cxs/{company['tenant']}/{company['site']}/jobs"
    seen_ids = set()
    out = []
    for term in WORKDAY_SEARCH_TERMS:
        body = {"appliedFacets": {}, "limit": 20, "offset": 0, "searchText": term}
        try:
            payload = fetch_json(base, method="POST", body=body)
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] workday {company['name']} / '{term}' failed: {exc}", file=sys.stderr)
            continue
        for j in payload.get("jobPostings", []):
            title = j.get("title", "")
            path = j.get("externalPath", "")
            job_id = path or title
            if job_id in seen_ids or not matches_specialty(title):
                continue
            level = classify_level(title)
            if level != "entry":
                # Corporate boards are huge — only keep clearly entry/early-career
                # postings plus anything unspecified-but-freshly-titled "2027".
                if "2027" not in title.lower():
                    continue
            seen_ids.add(job_id)
            out.append({
                "id": f"workday-{company['tenant']}-{path}",
                "company": company["name"],
                "title": title,
                "location": j.get("locationsText", ""),
                "url": f"https://{company['host']}/en-US/{company['site']}{path}",
                "category": company["category"],
                "level": level,
                "source": "workday",
                "posted_at": j.get("postedOn") or None,
            })
        time.sleep(0.5)  # be polite between queries against the same board
    return out


def _get(d: dict, *keys, default=None):
    """Pull the first present, non-empty key — aggregator schemas drift, so
    every field is looked up by a few plausible names rather than one exact one."""
    for k in keys:
        v = d.get(k)
        if v not in (None, "", []):
            return v
    return default


def _coerce_date(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc).strftime("%Y-%m-%d")
    if isinstance(value, str):
        if value.isdigit():
            return datetime.fromtimestamp(int(value), tz=timezone.utc).strftime("%Y-%m-%d")
        return value[:10]
    return None


def fetch_aggregator(source: dict) -> list[dict]:
    payload = fetch_json(source["url"])
    # Most of these bots publish either a bare list or {"jobs": [...]}.
    entries = payload if isinstance(payload, list) else payload.get("jobs", payload.get("listings", []))

    out = []
    skipped_unparsed = 0
    for e in entries:
        if not isinstance(e, dict):
            continue
        title = _get(e, "title", "role", "position")
        company = _get(e, "company_name", "company", "employer")
        url = _get(e, "url", "application_link", "link", "job_url", "applyUrl")
        if not title or not company or not url:
            skipped_unparsed += 1
            continue

        is_active = _get(e, "active", "is_active", "is_visible", default=True)
        if is_active is False:
            continue

        if not matches_specialty(title):
            continue

        locations = _get(e, "locations", "location", default="")
        if isinstance(locations, list):
            locations = ", ".join(str(loc) for loc in locations)

        category = guess_category(company, title)
        job_id = "aggregator-" + hashlib.md5(f"{company}|{title}|{url}".encode()).hexdigest()[:12]

        out.append({
            "id": job_id,
            "company": company,
            "title": title,
            "location": locations,
            "url": url,
            "category": category,
            "level": classify_level(title),
            "source": f"aggregator:{source['label']}",
            "source_display": source["display"],
            "posted_at": _coerce_date(_get(e, "date_posted", "posted_at", "date_updated")),
        })

    if skipped_unparsed:
        print(f"[info] {source['display']}: skipped {skipped_unparsed} entries with an unrecognized shape", file=sys.stderr)
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def load_previous() -> dict:
    if DATA_PATH.exists():
        try:
            return json.loads(DATA_PATH.read_text())
        except Exception:  # noqa: BLE001
            return {}
    return {}


def main():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    previous = load_previous()
    previous_first_seen = {j["id"]: j.get("first_seen", today) for j in previous.get("jobs", [])}

    jobs: list[dict] = []
    for c in GREENHOUSE_COMPANIES:
        jobs += safe(f"greenhouse:{c['name']}", fetch_greenhouse, c)
    for c in LEVER_COMPANIES:
        jobs += safe(f"lever:{c['name']}", fetch_lever, c)
    for c in ASHBY_COMPANIES:
        jobs += safe(f"ashby:{c['name']}", fetch_ashby, c)
    for c in WORKDAY_COMPANIES:
        jobs += safe(f"workday:{c['name']}", fetch_workday, c)
    for s in AGGREGATOR_SOURCES:
        result = safe(f"aggregator:{s['label']}", fetch_aggregator, s)
        print(f"[info] {s['display']}: {len(result)} specialty matches", file=sys.stderr)
        jobs += result

    for j in jobs:
        j["first_seen"] = previous_first_seen.get(j["id"], today)

    # De-dupe defensively (a company could theoretically appear via two sources)
    dedup = {}
    for j in jobs:
        dedup[j["id"]] = j
    jobs = list(dedup.values())

    jobs.sort(key=lambda j: (j["category"], j["level"] != "entry", j["company"], j["title"]))

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "jobs": jobs,
    }

    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_PATH.write_text(json.dumps(output, indent=2))
    print(f"Wrote {len(jobs)} matching jobs to {DATA_PATH}")


if __name__ == "__main__":
    main()
