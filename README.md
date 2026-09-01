# Robotics Job Radar

A small, self-updating website that scans a set of company job boards every
day for postings matching your specialty (manipulation research, humanoid &
legged robotics, surgical robotics, defense/public-safety robotics) and
publishes them as a static page.

It's plain HTML/CSS/JS + one Python script — no build step, no server to
maintain. GitHub runs the scan on a schedule and GitHub Pages hosts the
result for free.

## 1. Get this into a GitHub repo

1. Go to github.com and create a **new, public** repository (e.g.
   `robotics-job-radar`). Public keeps GitHub Actions minutes and Pages
   free with no limits worth worrying about at this scale.
2. Upload everything in this folder into that repo — easiest way if you're
   not comfortable with git yet: on the repo's page, use **Add file → Upload
   files**, drag in the whole folder contents (keeping the `.github/`,
   `data/`, and `scripts/` subfolders intact), and commit.
   (If you do use git: `git init`, `git add .`, `git commit -m "init"`,
   `git remote add origin <your-repo-url>`, `git push -u origin main`.)

## 2. Turn on GitHub Pages

1. In the repo, go to **Settings → Pages**.
2. Under "Build and deployment," set **Source: Deploy from a branch**.
3. Branch: **main**, folder: **/ (root)**. Save.
4. GitHub will give you a URL like `https://<your-username>.github.io/robotics-job-radar/`.
   That's your permanent link — bookmark it.

## 3. Run the first scan

The scheduled workflow runs once a day on its own, but don't wait for it the
first time:

1. Go to the **Actions** tab of the repo.
2. Click **Daily job scan** in the left sidebar.
3. Click **Run workflow** → **Run workflow** (green button).
4. Wait ~30 seconds, refresh, and you should see a green checkmark. That run
   commits a fresh `data/jobs.json`, and your Pages site picks it up within
   a minute or two.

After that, it runs automatically every day at 13:00 UTC (~9am ET / 6am PT)
with no action needed from you. You can re-trigger it manually anytime the
same way.

## How it decides what to show

There are two tiers of source, because there's no single API that searches
"every job board" — that's a paid-aggregator product (LinkedIn, Indeed,
Simplify), not something publicly open. This gets close to that for free:

- **Curated, direct sources** — Greenhouse/Lever/Ashby (Anduril, Skild AI,
  Apptronik, Kodiak Robotics, Capstan Medical, Physical Intelligence,
  GrayMatter Robotics) are pulled and filtered by specialty keyword in full;
  their boards are small enough that this is cheap. **Workday** boards
  (NVIDIA, Medtronic, GE Aerospace, J&J, Philips) are huge, so those get
  searched directly by role keyword instead of pulled whole, then filtered
  to early-career-only so they don't flood the page. These are companies
  I already knew belonged in your list, hand-configured with an explicit
  category — the most reliable tier, but bounded by what I thought to add.
- **Broad-net sources** — the script also pulls the raw data behind two
  actively-maintained, crowd-sourced trackers (SimplifyJobs'
  `New-Grad-Positions` and `Summer2027-Internships` repos on GitHub, updated
  by a bot roughly every 30 minutes from postings the community submits
  across hundreds of companies) and filters *that* for the same specialty
  keywords. This is what catches a robotics startup neither of us has heard
  of yet — it inherits their scanning reach instead of me hand-listing every
  company. Their category gets *guessed* from the title/company text
  (labeled "via SimplifyJobs..." in the job row) rather than hand-assigned,
  so it's occasionally rougher than the curated tier — treat a surprising
  category there as a hint to double check, not gospel.
- Companies with **no public API at all**, that also don't reliably surface
  through those trackers (Figure AI, Boston Dynamics, Agility Robotics, 1X,
  Unitree, Toyota Research Institute, Intuitive Surgical, Vicarious
  Surgical, Shield AI, Mach Industries, and anything else you add) live in
  `data/watchlist.txt` and surface on the **My companies** tab instead —
  see below.
- A posting is badged **NEW** if it first appeared in the most recent scan.

**Being upfront about the broad-net tier:** the SimplifyJobs `listings.json`
path the script points at is a community-known convention, not an
officially documented API — if they restructure their repo, that source
will start contributing 0 rows (the run won't break; check the Actions log,
which prints how many specialty matches each source found and flags any
entries it couldn't parse). If you want more coverage than that, the
straightforward addition is more direct company sources — see below — since
those are the ones that won't silently degrade.

## The two tabs

- **All postings** — everything the scanner matched, grouped by category
  (manipulation, humanoid, surgical, defense). This is the firehose: every
  curated source plus everything the broad-net trackers turned up.
- **My companies** — grouped by the list in `data/watchlist.txt` instead,
  which you maintain directly and which has nothing to do with what the
  scanner is technically capable of reaching. A company on your watchlist
  shows its actual open matches if the scanner found any (from either
  tier above); if it found none, the panel shows a direct link to that
  company's careers page instead of just disappearing. Companies with
  current matches float to the top.

Editing `data/watchlist.txt` is the whole workflow for "I want to
personally track this company." You can do it two ways — through the site
itself (see below) or by hand — but either way the format is one company
per line:

```
Company Name | careers URL (optional) | note (optional)
```

Lines starting with `#` and blank lines are ignored. The careers URL is
only used as a fallback when there are currently zero matches for that
company — it doesn't cause the company to get scanned; matching against
`data/jobs.json` is purely by name. If you want a watchlist company's
postings to actually show up automatically (not just as a fallback link),
it also needs to be one of the scanned sources — see the next section.

## Adding companies from the site itself

The **My companies** tab has an "Add" form right on the page, so day-to-day
list maintenance doesn't require opening GitHub at all. Under the hood it
writes straight to `data/watchlist.txt` via GitHub's API, because a GitHub
Pages site can't run its own backend to save anything — that's also why it
needs a one-time authentication step:

1. Click **⚙ Connect GitHub** on the My companies tab.
2. Follow the link to create a **fine-grained personal access token** —
   scope it to just this one repository, with only **Contents: Read and
   write** permission checked, and give it an expiration date.
3. Paste the token in. Owner/repo are auto-filled from the page's own URL
   (override them if you're on a custom domain instead of the default
   `*.github.io` one), then click Save.

The token is stored in that browser's `localStorage` only — never written
into the site's code or the repo, never sent anywhere but
`api.github.com` from your own browser. For a personal, single-user tool
that's a reasonable trade-off; just don't paste in a broader-scoped token
than you need, and hit "Forget token" if you're ever on a shared machine.

Once connected, submitting the form does a get-current-file →
append-or-update-the-line → write-it-back round trip and re-renders
immediately — no waiting for a scan or a redeploy. Each company row also
gets a small **✕** to remove it the same way. Editing `data/watchlist.txt`
by hand through GitHub's web editor still works exactly as before if you'd
rather skip the token setup — the form is a convenience, not a requirement.

## Adding or removing scanned companies

Open `scripts/scan_jobs.py`. Near the top there are four lists —
`GREENHOUSE_COMPANIES`, `LEVER_COMPANIES`, `ASHBY_COMPANIES`,
`WORKDAY_COMPANIES` — plus `AGGREGATOR_SOURCES` for the broad-net trackers.

To add a Greenhouse/Lever/Ashby company, find their board token from their
careers page URL:
- Greenhouse: `job-boards.greenhouse.io/<token>/...` → that's the token.
- Lever: `jobs.lever.co/<site>/...` → that's the site.
- Ashby: `jobs.ashbyhq.com/<board>/...` → that's the board.

Add an entry to the matching list with a `name` and a `category` (one of
`manipulation_research`, `humanoid_legged`, `medical_surgical`,
`defense_public_safety`, `other`). Commit the change — the next scan (or a
manual trigger) will pick it up.

Workday is reverse-engineered and occasionally needs the `host`/`tenant`/
`site` values re-checked if a company migrates their careers site — if one
stops returning results, open their careers page in a browser, open dev
tools → Network tab, search for something, and look for a request to
`.../wday/cxs/.../jobs` to read off the correct values.

To add another broad-net tracker, append an entry to `AGGREGATOR_SOURCES`
with a `label`, a `display` name, and the raw JSON `url`. The parser reads
several plausible field names per entry (`title`/`role`, `company_name`/
`company`, etc.) rather than one exact schema, so most similarly-shaped
trackers should work without further changes — check the Actions log after
the next run to see how many rows it pulled in and whether anything got
skipped as unparsed.

## Files

```
index.html              the page (two tabs: all postings, my companies)
style.css                styling
app.js                   fetches jobs.json + watchlist.txt, renders both tabs,
                         and writes back to watchlist.txt via GitHub's API
data/jobs.json            the current scan results (overwritten daily)
data/watchlist.txt        companies you're personally tracking — edit via
                         the site's "Add" form or by hand
scripts/scan_jobs.py      the scanner
.github/workflows/daily-scan.yml   the daily schedule
```
