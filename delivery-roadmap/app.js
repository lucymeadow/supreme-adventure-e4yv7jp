// Delivery Roadmap — front-end orchestration.
//
// Accepts an Objective (Jira "Key Result", e.g. MLSTN1-5603) OR a Milestone
// (Jira "Objective", e.g. MLSTN1-5679) as input. Detects the level from the
// issue's issuetype and runs the appropriate traversal:
//
//   Objective mode  : Objective -> Strategy (via outward Implements)
//                                -> Milestones (via linkedIssues + project=MLSTN1 + type=Objective)
//                                -> Initiatives (via Jira parent field)
//
//   Milestone mode  : Milestone -> parent Objective (via outward Implements)
//                                -> Strategy (via the parent Objective)
//                                -> [single milestone row]
//                                -> Initiatives (via Jira parent field)
//
// See README.md for the full Jira hierarchy mapping. Custom field IDs were
// discovered against MLSTN1-5679 (a milestone under MLSTN1-5603); see the
// FIELDS constants below.

/* ---------- constants ---------- */

const DEFAULT_OBJECTIVE = "MLSTN1-5603";
const JIRA_HOST = "https://expediagroup.atlassian.net";
const SETTINGS_KEY = "delivery-roadmap.settings.v1";

const FIELDS = {
  // "Product Lead(s)" — a multi-user picker. EG also has a legacy single-user
  // field "Product Lead" at customfield_10293 that is uniformly null across the
  // MLSTN1/PRODPLAN1 issues this tool queries, so we read the multi field
  // directly. See userDisplay() for array handling.
  productLead: "customfield_11654",
  functionalArea: "customfield_10274",
  startDate: "customfield_10015"
};

const ISSUE_FIELDS = [
  "summary",
  "issuetype",
  "status",
  "assignee",
  "duedate",
  "project",
  "parent",
  "issuelinks",
  FIELDS.productLead,
  FIELDS.functionalArea,
  FIELDS.startDate
].join(",");

const GRID_COLUMNS = 6;

/* ---------- settings ---------- */

function loadSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); }
  catch { s = {}; }
  return {
    proxyBase: (s.proxyBase || "http://127.0.0.1:8766").replace(/\/$/, ""),
    sharedToken: s.sharedToken || ""
  };
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/* ---------- proxy fetchers ---------- */

async function proxyFetch(path) {
  const { proxyBase, sharedToken } = loadSettings();
  const headers = { "Accept": "application/json" };
  if (sharedToken) headers["X-Roadmap-Token"] = sharedToken;
  const res = await fetch(proxyBase + path, { headers });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || !body.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body.data;
}

function jiraIssue(key, opts = {}) {
  const params = new URLSearchParams({ fields: opts.fields || ISSUE_FIELDS });
  if (opts.expand) params.set("expand", opts.expand);
  return proxyFetch(`/api/jira/issue/${encodeURIComponent(key)}?${params.toString()}`);
}

function jiraSearch(jql, fields = ISSUE_FIELDS) {
  const params = new URLSearchParams({ jql, fields, maxResults: "200" });
  return proxyFetch(`/api/jira/search?${params.toString()}`);
}

/* ---------- traversal ---------- */

// Walks issuelinks looking for an outward "Implements" target whose key matches
// the supplied regex (e.g. /^STRAT/ for Strategy, /^MLSTN1-/ for Objective).
// Falls back to any outward link with a matching key prefix if the link type
// isn't named "Implements".
function extractOutwardImplementsTarget(issue, keyRegex) {
  const links = issue.fields?.issuelinks || [];
  for (const link of links) {
    const out = link.outwardIssue;
    if (!out) continue;
    if (link.type?.name === "Implements" && keyRegex.test(out.key)) {
      return out.key;
    }
  }
  for (const link of links) {
    const out = link.outwardIssue;
    if (out && keyRegex.test(out.key)) return out.key;
  }
  return null;
}

function extractStrategyKey(objectiveIssue) {
  return extractOutwardImplementsTarget(objectiveIssue, /^STRAT/);
}

async function findParentObjective(milestoneIssue) {
  // Prefer the direct outward "Implements" link if Jira returned it.
  const directKey = extractOutwardImplementsTarget(milestoneIssue, /^MLSTN1-/);
  if (directKey) {
    try {
      const full = await jiraIssue(directKey);
      if (full.fields?.issuetype?.name === "Key Result") return full;
    } catch { /* fall through */ }
  }
  // Fallback: JQL via linkedIssues to find the Key Result that owns this milestone.
  try {
    const res = await jiraSearch(
      `issue in linkedIssues("${milestoneIssue.key}") AND project = MLSTN1 AND issuetype = "Key Result"`
    );
    return (res.issues && res.issues[0]) || null;
  } catch {
    return null;
  }
}

// Type-name strings as Jira returns them. Centralised so we don't typo-drift.
const TYPE_KEY_RESULT = "Key Result";   // portfolio "Objective"
const TYPE_OBJECTIVE = "Objective";     // portfolio "Milestone"

async function fetchObjectiveMode(objective) {
  const strategyKey = extractStrategyKey(objective);
  const strategyPromise = strategyKey
    ? jiraIssue(strategyKey).catch(() => null)
    : Promise.resolve(null);

  const milestonesSearch = await jiraSearch(
    `issue in linkedIssues("${objective.key}") AND project = MLSTN1 AND issuetype = Objective AND status != Cancelled`
  );
  const milestones = (milestonesSearch.issues || []).filter(m => !isCancelled(m));

  const initiativeBatches = await Promise.all(milestones.map(async m => {
    try {
      const res = await jiraSearch(`parent = ${m.key} AND status != Cancelled`);
      return (res.issues || []).filter(i => !isCancelled(i));
    } catch {
      return [];
    }
  }));

  const milestonesWithInitiatives = milestones.map((m, i) => ({
    issue: m,
    initiatives: initiativeBatches[i]
  }));

  const strategy = await strategyPromise;
  return { strategy, objective, milestones: milestonesWithInitiatives, mode: "objective" };
}

async function fetchMilestoneMode(milestone) {
  const parentObjective = await findParentObjective(milestone);
  let strategy = null;
  if (parentObjective) {
    const strategyKey = extractStrategyKey(parentObjective);
    if (strategyKey) {
      strategy = await jiraIssue(strategyKey).catch(() => null);
    }
  }

  let initiatives = [];
  try {
    const res = await jiraSearch(`parent = ${milestone.key} AND status != Cancelled`);
    initiatives = (res.issues || []).filter(i => !isCancelled(i));
  } catch { /* leave empty */ }

  return {
    strategy,
    objective: parentObjective,
    milestones: [{ issue: milestone, initiatives }],
    mode: "milestone",
    focusedMilestoneKey: milestone.key
  };
}

async function fetchHierarchy(inputKey) {
  const input = await jiraIssue(inputKey);
  const typeName = input.fields?.issuetype?.name || "";

  if (typeName === TYPE_KEY_RESULT) return fetchObjectiveMode(input);
  if (typeName === TYPE_OBJECTIVE) return fetchMilestoneMode(input);

  throw new Error(
    `Issue type "${typeName || "unknown"}" not supported for ${input.key}. ` +
    `Use an Objective (Jira "Key Result", e.g. MLSTN1-5603) or a Milestone ` +
    `(Jira "Objective", e.g. MLSTN1-5679).`
  );
}

/* ---------- quarter math ---------- */

function quarterOf(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  return { year: d.getFullYear(), quarter: Math.floor(d.getMonth() / 3) + 1 };
}

function quarterLabel(q) {
  if (!q) return "Unscheduled";
  return `Q${q.quarter} ${q.year}`;
}

function quarterKey(q) {
  return q ? `${q.year}-${q.quarter}` : "unscheduled";
}

function currentQuarter() {
  const now = new Date();
  return { year: now.getFullYear(), quarter: Math.floor(now.getMonth() / 3) + 1 };
}

function compareQuarters(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  return a.quarter - b.quarter;
}

function addQuarters(q, n) {
  let total = q.year * 4 + (q.quarter - 1) + n;
  return { year: Math.floor(total / 4), quarter: (total % 4) + 1 };
}

function quarterBucketClass(q) {
  if (!q) return "q-unscheduled";
  const cur = currentQuarter();
  const c = compareQuarters(q, cur);
  if (c < 0) return "q-past";
  if (c === 0) return "q-current";
  if (c === 1) return "q-next";
  return "q-future";
}

/* ---------- formatting helpers ---------- */

function fmtDate(d) {
  if (!d) return null;
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function statusCategory(issue) {
  return issue.fields?.status?.statusCategory?.key || "new";
}

function statusName(issue) {
  return issue.fields?.status?.name || "";
}

// Cancelled milestones/initiatives are excluded from the tree and grid. The
// server-side JQL filter (`status != Cancelled`) does most of the work; this
// client-side check catches alt spellings ("Canceled") and any case-mismatch
// edge cases so a stray cancelled item can't slip through.
function isCancelled(issue) {
  const name = statusName(issue).toLowerCase();
  return name === "cancelled" || name === "canceled";
}

function readField(issue, fieldId) {
  return issue.fields?.[fieldId] ?? null;
}

function userDisplay(user) {
  if (!user) return null;
  // Multi-user picker fields (e.g. Product Lead(s)) return an array of user
  // objects; flatten to "Name 1, Name 2" so the meta line stays one row.
  if (Array.isArray(user)) {
    const names = user
      .map(u => u?.displayName || u?.emailAddress)
      .filter(Boolean);
    return names.length ? names.join(", ") : null;
  }
  return user.displayName || user.emailAddress || null;
}

function optionDisplay(opt) {
  if (!opt) return null;
  if (typeof opt === "string") return opt;
  return opt.value || opt.name || null;
}

function rowMetadata(issue) {
  const lead = userDisplay(readField(issue, FIELDS.productLead));
  const start = readField(issue, FIELDS.startDate);
  const end = readField(issue, "duedate");
  const fa = optionDisplay(readField(issue, FIELDS.functionalArea));
  const assignee = userDisplay(readField(issue, "assignee"));

  return [
    { label: "Product Lead", value: lead },
    { label: "Start", value: start ? fmtDate(start) : null },
    { label: "End", value: end ? fmtDate(end) : null },
    { label: "Functional Area", value: fa },
    { label: "Assignee", value: assignee }
  ];
}

function jiraUrl(key) {
  return `${JIRA_HOST}/browse/${encodeURIComponent(key)}`;
}

function normalizeKey(input) {
  const trimmed = (input || "").trim();
  const m = trimmed.match(/([A-Z][A-Z0-9_]+-\d+)/);
  return m ? m[1] : trimmed;
}

/* ---------- DOM helpers ---------- */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function show(node, on = true) {
  if (on) node.removeAttribute("hidden");
  else node.setAttribute("hidden", "");
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg || "";
}

/* ---------- rendering: headers ---------- */

function renderStrategy(strategy) {
  const card = document.getElementById("strategy-card");
  if (!strategy) { show(card, false); return; }
  const link = document.getElementById("strategy-key");
  link.textContent = strategy.key;
  link.href = jiraUrl(strategy.key);
  document.getElementById("strategy-title").textContent = strategy.fields?.summary || "";
  const pill = document.getElementById("strategy-status");
  pill.textContent = statusName(strategy);
  pill.className = "status-pill status-cat-" + statusCategory(strategy);
  show(card, true);
}

function renderObjective(objective) {
  const card = document.getElementById("objective-card");
  if (!objective) { show(card, false); return; }
  const link = document.getElementById("objective-key-link");
  link.textContent = objective.key;
  link.href = jiraUrl(objective.key);
  document.getElementById("objective-title").textContent = objective.fields?.summary || "";
  const pill = document.getElementById("objective-status");
  pill.textContent = statusName(objective);
  pill.className = "status-pill status-cat-" + statusCategory(objective);
  const start = objective.fields?.[FIELDS.startDate];
  const end = objective.fields?.duedate;
  const dates = [];
  if (start) dates.push(`Start ${fmtDate(start)}`);
  if (end) dates.push(`End ${fmtDate(end)}`);
  document.getElementById("objective-dates").textContent = dates.join(" \u00b7 ");
  show(card, true);
}

function renderModeBadge(result) {
  const slot = document.getElementById("mode-badge");
  if (!slot) return;
  const mode = result?.mode;
  if (!mode || mode === "objective") { slot.hidden = true; return; }
  slot.hidden = false;
  if (mode === "program") {
    slot.textContent = `Program: ${result.programDef?.name || result.programDef?.key || ""}`.trim();
    slot.classList.add("mode-badge-program");
  } else {
    slot.textContent = `Scoped to milestone ${result.focusedMilestoneKey || ""}`.trim();
    slot.classList.remove("mode-badge-program");
  }
}

function renderProgram(programDef, milestones) {
  const card = document.getElementById("program-card");
  if (!card) return;
  if (!programDef) { show(card, false); return; }
  document.getElementById("program-key").textContent = programDef.key || "";
  document.getElementById("program-title").textContent = programDef.name || programDef.key || "";
  document.getElementById("program-description").textContent =
    programDef.description || programDef.value_prop || "";
  const ms = milestones?.length || 0;
  const inits = (milestones || []).reduce((n, m) => n + (m.initiatives?.length || 0), 0);
  document.getElementById("program-counts").textContent =
    `${ms} milestone${ms === 1 ? "" : "s"} \u00b7 ${inits} initiative${inits === 1 ? "" : "s"}`;
  show(card, true);
}

function renderCounts(milestones) {
  const total = milestones.length;
  const initiativeCount = milestones.reduce((n, m) => n + m.initiatives.length, 0);

  // Tally items by quarter (milestones + initiatives, combined).
  const tally = new Map();
  function bump(q) {
    const k = quarterKey(q);
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  for (const { issue, initiatives } of milestones) {
    bump(quarterOf(issue.fields?.duedate));
    for (const init of initiatives) bump(quarterOf(init.fields?.duedate));
  }

  document.getElementById("count-milestones").innerHTML = `<strong>${total}</strong> milestone${total === 1 ? "" : "s"}`;
  document.getElementById("count-initiatives").innerHTML = `<strong>${initiativeCount}</strong> initiative${initiativeCount === 1 ? "" : "s"}`;

  // Quarter tally: from current quarter forward, capped to 4 quarters of detail.
  const cur = currentQuarter();
  const summary = [];
  for (let i = 0; i < 4; i++) {
    const q = addQuarters(cur, i);
    const n = tally.get(quarterKey(q)) || 0;
    summary.push(`<span class="quarter-tally"><strong>${n}</strong> ${quarterLabel(q)}</span>`);
  }
  const unscheduled = tally.get("unscheduled") || 0;
  if (unscheduled) summary.push(`<span class="quarter-tally"><strong>${unscheduled}</strong> Unscheduled</span>`);
  document.getElementById("count-by-quarter").innerHTML = summary.join(' <span class="dot"></span> ');

  show(document.getElementById("counts-bar"), true);
}

/* ---------- rendering: tree view ---------- */

function metadataLine(issue) {
  const items = rowMetadata(issue);
  return el("div", { class: "meta-line" }, items.map(item => {
    const cls = item.value ? "meta-value" : "meta-value missing";
    return el("span", {}, [
      el("span", { class: "meta-label" }, [`${item.label}: `]),
      el("span", { class: cls }, [item.value || "\u2014"])
    ]);
  }));
}

function quarterBadge(dateStr) {
  const q = quarterOf(dateStr);
  return el("span", {
    class: "quarter-badge " + quarterBucketClass(q),
    title: dateStr ? `Due ${fmtDate(dateStr)}` : "No due date"
  }, [quarterLabel(q)]);
}

function rowTitle(issue, kind) {
  const badge = el("span", { class: `badge badge-${kind}` }, [kind]);
  const key = el("a", { class: "key", href: jiraUrl(issue.key), target: "_blank", rel: "noopener" }, [issue.key]);
  const status = el("span", { class: "status-pill status-cat-" + statusCategory(issue) }, [statusName(issue)]);
  const name = el("span", { class: "name" }, [issue.fields?.summary || "(no summary)"]);
  const children = [
    el("div", { class: "title-line" }, [badge, key, status, name]),
    metadataLine(issue)
  ];
  const changelog = renderChangeHistory(issue);
  if (changelog) children.push(changelog);
  return el("div", { class: "row-title" }, children);
}

// Renders the "N changes" badge plus a collapsed popover with the recent
// date/start-date/status changes for this issue. Returns null when there's no
// captured change data (e.g. live mode, or no recent changes). Stops click
// propagation so toggling the popover doesn't also fold a parent milestone.
function renderChangeHistory(issue) {
  const hist = issue.changeHistory;
  if (!Array.isArray(hist) || hist.length === 0) return null;

  const fmtWhen = w => {
    const d = new Date(w);
    return isNaN(d.getTime()) ? w : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  };

  const list = el("ol", { class: "changelog-list" }, hist.map(h =>
    el("li", { class: "changelog-entry" }, [
      el("span", { class: "changelog-when" }, [fmtWhen(h.when)]),
      el("span", { class: "changelog-who" }, [h.who || "Unknown"]),
      el("span", { class: "changelog-field" }, [h.field]),
      el("span", { class: "changelog-change" }, [
        el("span", { class: "changelog-from" }, [h.from || "(empty)"]),
        el("span", { class: "changelog-arrow" }, ["\u2192"]),
        el("span", { class: "changelog-to" }, [h.to || "(empty)"])
      ])
    ])
  ));

  const popover = el("div", { class: "changelog-popover", hidden: true }, [list]);
  const btn = el("button", {
    type: "button",
    class: "changelog-toggle",
    "aria-expanded": "false",
    title: "Show recent date / start-date / status changes (last 90 days)"
  }, [`${hist.length} change${hist.length === 1 ? "" : "s"}`]);

  btn.addEventListener("click", e => {
    e.stopPropagation();
    e.preventDefault();
    const opening = popover.hidden;
    popover.hidden = !opening;
    btn.setAttribute("aria-expanded", opening ? "true" : "false");
    btn.classList.toggle("open", opening);
  });

  return el("div", { class: "changelog" }, [btn, popover]);
}

function renderInitiativeRow(initiative) {
  return el("li", { class: "initiative" }, [
    rowTitle(initiative, "initiative"),
    quarterBadge(initiative.fields?.duedate)
  ]);
}

function renderMilestone({ issue, initiatives }) {
  const sorted = [...initiatives].sort(sortByDueDate);

  const list = sorted.length
    ? el("ol", { class: "initiative-list" }, sorted.map(renderInitiativeRow))
    : el("div", { class: "initiative-empty" }, ["No initiatives linked to this milestone yet."]);

  return el("details", { class: "milestone", open: true }, [
    el("summary", {}, [
      el("span", { class: "disclosure" }),
      rowTitle(issue, "milestone"),
      quarterBadge(issue.fields?.duedate),
      el("span", { class: "count-chip" }, [`${initiatives.length} initiative${initiatives.length === 1 ? "" : "s"}`])
    ]),
    list
  ]);
}

function sortByDueDate(a, b) {
  const da = a.fields?.duedate || "9999-99-99";
  const db = b.fields?.duedate || "9999-99-99";
  if (da !== db) return da < db ? -1 : 1;
  return (a.key || "").localeCompare(b.key || "");
}

function renderTree(milestones, mode) {
  const ol = document.getElementById("milestone-list");
  clear(ol);
  if (mode === "program") {
    renderTreeGroupedByStrategy(ol, milestones);
  } else {
    const sorted = [...milestones].sort((a, b) => sortByDueDate(a.issue, b.issue));
    for (const m of sorted) ol.appendChild(renderMilestone(m));
  }
  if (!ol.childElementCount) {
    ol.appendChild(el("li", { class: "hint" }, [
      "No milestones or initiatives match the current quarter filter."
    ]));
  }
  show(document.getElementById("tree-view"), true);
}

// Program mode: bucket milestones by their parentStrategy and render a small
// strategy banner before each bucket so it's obvious the program crosses
// multiple strategies. Within a bucket, milestones are sorted by due date as
// usual. Buckets with a known strategy come first (in stable key order), then
// the "no parent strategy" bucket at the bottom.
function renderTreeGroupedByStrategy(ol, milestones) {
  const groups = new Map();
  for (const m of milestones) {
    const key = m.parentStrategy?.key || "__no_strategy__";
    if (!groups.has(key)) {
      groups.set(key, { strategy: m.parentStrategy || null, items: [] });
    }
    groups.get(key).items.push(m);
  }
  const ordered = [...groups.entries()]
    .filter(([k]) => k !== "__no_strategy__")
    .sort(([a], [b]) => a.localeCompare(b));
  if (groups.has("__no_strategy__")) ordered.push(["__no_strategy__", groups.get("__no_strategy__")]);

  for (const [key, group] of ordered) {
    const strat = group.strategy;
    const headerChildren = [
      el("span", { class: "badge badge-strategy" }, ["Strategy"])
    ];
    if (strat) {
      headerChildren.push(el("a", {
        class: "key", href: jiraUrl(strat.key), target: "_blank", rel: "noopener"
      }, [strat.key]));
      headerChildren.push(el("span", { class: "strategy-group-title" }, [strat.fields?.summary || ""]));
    } else {
      headerChildren.push(el("span", { class: "strategy-group-title" }, ["(no parent strategy resolved)"]));
    }
    headerChildren.push(el("span", { class: "count-chip" }, [
      `${group.items.length} milestone${group.items.length === 1 ? "" : "s"}`
    ]));
    ol.appendChild(el("div", { class: "strategy-group-header" }, headerChildren));
    const sorted = [...group.items].sort((a, b) => sortByDueDate(a.issue, b.issue));
    for (const m of sorted) ol.appendChild(renderMilestone(m));
  }
}

/* ---------- rendering: quarter grid view ---------- */

function metaLineCompact(issue) {
  const items = rowMetadata(issue);
  return el("div", { class: "grid-card-meta" }, items.map(item =>
    el("div", {}, [
      el("span", { class: "meta-label" }, [`${item.label}: `]),
      item.value || "\u2014"
    ])
  ));
}

function gridCard(issue, kind) {
  const headerChildren = [
    el("span", { class: `badge badge-${kind}` }, [kind]),
    el("a", { class: "key", href: jiraUrl(issue.key), target: "_blank", rel: "noopener" }, [issue.key])
  ];
  const cardChildren = [
    el("div", { class: "grid-card-header" }, headerChildren),
    el("p", { class: "grid-card-title" }, [issue.fields?.summary || ""]),
    metaLineCompact(issue)
  ];
  const changelog = renderChangeHistory(issue);
  if (changelog) cardChildren.push(changelog);
  return el("div", { class: `grid-card kind-${kind}` }, cardChildren);
}

function renderGrid(milestones) {
  const container = document.getElementById("grid-container");
  clear(container);

  const cur = currentQuarter();
  const columns = [];
  for (let i = 0; i < GRID_COLUMNS; i++) columns.push(addQuarters(cur, i));

  // Bucket each milestone by its own duedate quarter, then place initiatives
  // by their own duedate quarter, with a fallback to the milestone's quarter
  // when an initiative lacks a duedate.
  const byKey = new Map();
  const ensure = key => {
    if (!byKey.has(key)) byKey.set(key, { milestones: [], initiatives: [] });
    return byKey.get(key);
  };
  let hasUnscheduled = false;

  for (const { issue, initiatives } of milestones) {
    const mQ = quarterOf(issue.fields?.duedate);
    const mKey = quarterKey(mQ);
    ensure(mKey).milestones.push(issue);
    if (!mQ) hasUnscheduled = true;

    for (const init of initiatives) {
      const iQ = quarterOf(init.fields?.duedate) || mQ;
      const iKey = quarterKey(iQ);
      ensure(iKey).initiatives.push({ issue: init, anchorKey: mKey });
      if (!iQ) hasUnscheduled = true;
    }
  }

  const renderColumn = (label, key, headerCls) => {
    const bucket = byKey.get(key) || { milestones: [], initiatives: [] };
    const total = bucket.milestones.length + bucket.initiatives.length;
    const col = el("div", { class: "grid-column" }, [
      el("div", { class: "grid-column-header " + (headerCls || "") }, [
        label,
        el("span", { class: "count" }, [`${total} item${total === 1 ? "" : "s"}`])
      ])
    ]);
    for (const ms of bucket.milestones.sort(sortByDueDate)) col.appendChild(gridCard(ms, "milestone"));
    for (const { issue } of bucket.initiatives.sort((a, b) => sortByDueDate(a.issue, b.issue))) {
      col.appendChild(gridCard(issue, "initiative"));
    }
    if (!total) col.appendChild(el("p", { class: "hint" }, ["(empty)"]));
    return col;
  };

  // A column is only drawn if its quarter key is currently selected by the
  // chip filter (or if no filter UI has been initialized yet — which is the
  // case before any data has loaded). This is what hides Q4+ when the user
  // narrows the filter to e.g. only Q2.
  const isSelected = key => !quarterFilterInitialized || selectedQuarters.has(key);

  let renderedAny = false;
  for (let i = 0; i < columns.length; i++) {
    const q = columns[i];
    const key = quarterKey(q);
    if (!isSelected(key)) continue;
    const headerCls = i === 0 ? "col-current" : "";
    container.appendChild(renderColumn(quarterLabel(q), key, headerCls));
    renderedAny = true;
  }
  if ((hasUnscheduled || byKey.has("unscheduled")) && isSelected("unscheduled")) {
    container.appendChild(renderColumn("Unscheduled", "unscheduled"));
    renderedAny = true;
  }
  if (!renderedAny) {
    container.appendChild(el("p", { class: "hint" }, [
      "No quarters selected. Pick at least one chip above to see the grid."
    ]));
  }
  show(document.getElementById("grid-view"), true);
}

/* ---------- view toggle ---------- */

function applyView(view) {
  show(document.getElementById("tree-view"), view === "tree");
  show(document.getElementById("grid-view"), view === "grid");
}

/* ---------- quarter filter ---------- */

// Set of quarter keys currently selected (e.g. "2026-3", "unscheduled").
// Empty = nothing selected = show nothing. We default to "all selected" the
// first time data lands so existing snapshots open with no apparent filter.
const selectedQuarters = new Set();
let quarterFilterInitialized = false;

// Collect every quarter that appears in the loaded data, plus the next
// GRID_COLUMNS calendar quarters from the current one. This way the filter
// surfaces upcoming quarters even when nothing is scheduled there yet — handy
// when you're looking forward.
function collectQuartersWithCounts(milestones) {
  const counts = new Map();
  const bump = (key, weight = 1) => counts.set(key, (counts.get(key) || 0) + weight);

  for (const { issue, initiatives } of milestones) {
    bump(quarterKey(quarterOf(issue.fields?.duedate)));
    for (const init of initiatives) {
      bump(quarterKey(quarterOf(init.fields?.duedate)));
    }
  }

  // Make sure the standard rolling window of upcoming quarters is always
  // available as a chip, even if it has zero items in this dataset.
  const cur = currentQuarter();
  for (let i = 0; i < GRID_COLUMNS; i++) {
    const q = addQuarters(cur, i);
    const key = quarterKey(q);
    if (!counts.has(key)) counts.set(key, 0);
  }

  // Build entries with a sortable timestamp. "Unscheduled" always sorts last.
  const entries = [];
  for (const [key, count] of counts) {
    if (key === "unscheduled") {
      entries.push({ key, q: null, label: "Unscheduled", count, sort: Number.POSITIVE_INFINITY });
    } else {
      const [year, quarter] = key.split("-").map(Number);
      const q = { year, quarter };
      entries.push({ key, q, label: quarterLabel(q), count, sort: year * 4 + quarter });
    }
  }
  entries.sort((a, b) => a.sort - b.sort);
  return entries;
}

function renderQuarterFilter(milestones) {
  const entries = collectQuartersWithCounts(milestones);
  const container = document.getElementById("quarter-chips");
  if (!container) return;

  // First time we render the filter for a given load: select everything so
  // the page looks identical to the pre-filter behavior.
  if (!quarterFilterInitialized) {
    selectedQuarters.clear();
    for (const entry of entries) selectedQuarters.add(entry.key);
    quarterFilterInitialized = true;
  }

  clear(container);
  for (const entry of entries) {
    const bucketCls = entry.q ? quarterBucketClass(entry.q) : "q-unscheduled";
    const selected = selectedQuarters.has(entry.key);
    const chip = el("button", {
      type: "button",
      class: `quarter-chip ${bucketCls}${selected ? " selected" : ""}`,
      "data-quarter-key": entry.key,
      "aria-pressed": selected ? "true" : "false"
    }, [
      entry.label,
      el("span", { class: "chip-count" }, [`· ${entry.count}`])
    ]);
    chip.addEventListener("click", () => {
      if (selectedQuarters.has(entry.key)) selectedQuarters.delete(entry.key);
      else selectedQuarters.add(entry.key);
      applyQuarterFilter();
    });
    container.appendChild(chip);
  }

  show(document.getElementById("quarter-filter"), true);
}

// Returns the milestones (and per-milestone initiative arrays) the user
// should see given the current chip selection. A milestone survives if its
// own quarter is selected or at least one of its initiatives is. When it
// survives via its own quarter only, we still hide initiatives outside the
// selection so the on-screen rows match what the chips claim.
function filterMilestonesByQuarter(milestones) {
  const result = [];
  for (const m of milestones) {
    const mq = quarterKey(quarterOf(m.issue.fields?.duedate));
    const mSelected = selectedQuarters.has(mq);
    const visibleInits = m.initiatives.filter(i =>
      selectedQuarters.has(quarterKey(quarterOf(i.fields?.duedate)))
    );
    if (mSelected || visibleInits.length > 0) {
      result.push({ issue: m.issue, initiatives: visibleInits });
    }
  }
  return result;
}

function applyQuarterFilter() {
  if (!lastResult) return;
  // Re-paint chips (so the .selected class flips) without rebuilding the list.
  for (const chip of document.querySelectorAll("#quarter-chips .quarter-chip")) {
    const k = chip.getAttribute("data-quarter-key");
    const on = selectedQuarters.has(k);
    chip.classList.toggle("selected", on);
    chip.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const filtered = filterMilestonesByQuarter(lastResult.milestones);
  renderTree(filtered, lastResult.mode);
  renderGrid(filtered);
  renderCounts(filtered);
}

function wireQuarterFilterControls() {
  const allBtn = document.getElementById("quarter-filter-all");
  const noneBtn = document.getElementById("quarter-filter-none");
  if (allBtn && !allBtn.dataset.wired) {
    allBtn.dataset.wired = "1";
    allBtn.addEventListener("click", () => {
      for (const chip of document.querySelectorAll("#quarter-chips .quarter-chip")) {
        selectedQuarters.add(chip.getAttribute("data-quarter-key"));
      }
      applyQuarterFilter();
    });
  }
  if (noneBtn && !noneBtn.dataset.wired) {
    noneBtn.dataset.wired = "1";
    noneBtn.addEventListener("click", () => {
      selectedQuarters.clear();
      applyQuarterFilter();
    });
  }
}

/* ---------- top-level load ---------- */

let lastResult = null;

function isSnapshotMode() {
  return typeof window !== "undefined" && window.__SNAPSHOT_DATA__;
}

function renderResult(result) {
  lastResult = result;
  // Each fresh load gets a fresh "everything selected" filter state. Without
  // this reset, switching from one Objective to another would carry over the
  // previous chip selection and silently hide most of the new view.
  quarterFilterInitialized = false;
  if (result.mode === "program") {
    // Program view replaces the Strategy/Objective header pair with a single
    // Program card. The tree renders strategy-grouped headers inline.
    renderProgram(result.programDef, result.milestones);
    renderStrategy(null);
    renderObjective(null);
  } else {
    renderProgram(null);
    renderStrategy(result.strategy);
    renderObjective(result.objective);
  }
  renderModeBadge(result);
  renderCounts(result.milestones);
  renderQuarterFilter(result.milestones);
  wireQuarterFilterControls();
  renderTree(result.milestones, result.mode);
  renderGrid(result.milestones);
  const view = document.querySelector('input[name=view]:checked')?.value || "tree";
  applyView(view);
  const btn = document.getElementById("snapshot-btn");
  if (btn) btn.disabled = false;
}

async function loadKey(key) {
  setStatus("Loading " + key + "...");
  show(document.getElementById("error-card"), false);
  show(document.getElementById("strategy-card"), false);
  show(document.getElementById("objective-card"), false);
  show(document.getElementById("counts-bar"), false);
  show(document.getElementById("tree-view"), false);
  show(document.getElementById("grid-view"), false);

  try {
    const result = await fetchHierarchy(key);
    renderResult(result);
    const initTotal = result.milestones.reduce((n, m) => n + m.initiatives.length, 0);
    const summary = result.mode === "milestone"
      ? `Loaded milestone ${result.focusedMilestoneKey} \u00b7 ${initTotal} initiative${initTotal === 1 ? "" : "s"}.`
      : `Loaded ${result.milestones.length} milestone${result.milestones.length === 1 ? "" : "s"} \u00b7 ${initTotal} initiative${initTotal === 1 ? "" : "s"}.`;
    setStatus(summary);
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("key") !== key) {
      urlParams.set("key", key);
      const newUrl = window.location.pathname + "?" + urlParams.toString();
      window.history.replaceState({}, "", newUrl);
    }
  } catch (e) {
    setStatus("");
    const msg = document.getElementById("error-message");
    msg.textContent = e.message || String(e);
    show(document.getElementById("error-card"), true);
  }
}

function applySnapshot() {
  const snap = window.__SNAPSHOT_DATA__;
  if (!snap) return;
  // Snapshot mode: hide live controls + settings, show banner.
  show(document.getElementById("controls"), false);
  const settingsBtn = document.getElementById("settings-btn");
  if (settingsBtn) settingsBtn.hidden = true;

  const banner = document.getElementById("snapshot-banner");
  const meta = document.getElementById("snapshot-meta");
  const link = document.getElementById("snapshot-source-link");
  const taken = new Date(snap.timestamp);
  const fmtTaken = taken.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short"
  });
  const scope = snap.mode === "milestone" && snap.focusedMilestoneKey
    ? `Scoped to milestone ${snap.focusedMilestoneKey}. `
    : "";
  meta.textContent = `${scope}Taken ${fmtTaken}. Data was correct at that moment and may now be stale.`;
  const focusKey = snap.mode === "milestone" && snap.focusedMilestoneKey
    ? snap.focusedMilestoneKey
    : (snap.objective && snap.objective.key);
  if (focusKey) {
    link.href = jiraUrl(focusKey);
    link.textContent = `Open ${focusKey} in Jira`;
  } else {
    link.hidden = true;
  }
  show(banner, true);

  renderResult({
    strategy: snap.strategy,
    objective: snap.objective,
    milestones: snap.milestones,
    mode: snap.mode || "objective",
    focusedMilestoneKey: snap.focusedMilestoneKey || null
  });
}

/* ---------- settings dialog ---------- */

function openSettings() {
  const s = loadSettings();
  document.getElementById("proxy-base").value = s.proxyBase;
  document.getElementById("endpoint-token").value = s.sharedToken;
  document.getElementById("settings-dialog").showModal();
}

function bindSettings() {
  document.getElementById("settings-btn").addEventListener("click", openSettings);
  document.getElementById("settings-cancel").addEventListener("click", () => {
    document.getElementById("settings-dialog").close();
  });
  document.getElementById("settings-form").addEventListener("submit", () => {
    saveSettings({
      proxyBase: document.getElementById("proxy-base").value.trim().replace(/\/$/, ""),
      sharedToken: document.getElementById("endpoint-token").value.trim()
    });
  });
}

/* ---------- snapshot export ---------- */

function escapeForScript(s) {
  // Make a JSON payload safe to embed inside a <script> tag.
  return s.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

function buildSnapshotHtml({ pageHtml, css, js, data }) {
  // Strip the live-controls section from the snapshot HTML to keep the file
  // self-contained and prevent confused "Load" clicks. The applySnapshot()
  // path also hides controls at runtime as a belt-and-braces measure.
  const cleanedHtml = pageHtml
    .replace(/<link[^>]*rel=["']stylesheet["'][^>]*>/i, "")
    .replace(/<script[^>]*src=["']app\.js["'][^>]*><\/script>/i, "");

  const dataJson = escapeForScript(JSON.stringify(data));
  const inlineHead = `<style>\n${css}\n</style>`;
  const inlineTail = `<script>window.__SNAPSHOT_DATA__ = ${dataJson};</script>\n<script type="module">${js}</script>`;

  return cleanedHtml
    .replace("</head>", `${inlineHead}\n</head>`)
    .replace("</body>", `${inlineTail}\n</body>`);
}

async function downloadSnapshot() {
  if (!lastResult) return;
  const btn = document.getElementById("snapshot-btn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Packaging...";

  try {
    const [pageHtml, css, js] = await Promise.all([
      fetch("index.html").then(r => r.text()),
      fetch("styles.css").then(r => r.text()),
      fetch("app.js").then(r => r.text())
    ]);

    // Trim issuelinks. They were only needed during the live fetch to resolve
    // the parent Strategy; we don't render them so dropping them shrinks the
    // snapshot from ~1.7 MB to under 200 KB.
    const trim = issue => {
      if (!issue?.fields) return issue;
      const { issuelinks, ...keep } = issue.fields;
      return { ...issue, fields: keep };
    };
    const data = {
      timestamp: new Date().toISOString(),
      generator: "delivery-roadmap snapshot v2",
      mode: lastResult.mode || "objective",
      focusedMilestoneKey: lastResult.focusedMilestoneKey || null,
      objective: trim(lastResult.objective),
      strategy: trim(lastResult.strategy),
      milestones: lastResult.milestones.map(m => ({
        issue: trim(m.issue),
        initiatives: m.initiatives.map(trim)
      }))
    };

    const html = buildSnapshotHtml({ pageHtml, css, js, data });
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dateSlug = data.timestamp.slice(0, 10);
    // Filename anchors on the "focus" of the snapshot: in milestone mode that's
    // the milestone itself, in objective mode the parent objective.
    const focusKey = data.mode === "milestone" && data.focusedMilestoneKey
      ? data.focusedMilestoneKey
      : data.objective.key;
    a.href = url;
    a.download = `delivery-roadmap-${focusKey}-${dateSlug}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    setStatus(`Snapshot failed: ${e.message}`);
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

/* ---------- wire up ---------- */

function bindControls() {
  const input = document.getElementById("objective-key");
  document.getElementById("load-btn").addEventListener("click", () => {
    const key = normalizeKey(input.value);
    if (!key) return;
    input.value = key;
    loadKey(key);
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("load-btn").click();
    }
  });
  for (const r of document.querySelectorAll('input[name=view]')) {
    r.addEventListener("change", e => applyView(e.target.value));
  }
  const snapBtn = document.getElementById("snapshot-btn");
  if (snapBtn) snapBtn.addEventListener("click", downloadSnapshot);
}

function initialKey() {
  const fromUrl = new URLSearchParams(window.location.search).get("key");
  if (fromUrl) return normalizeKey(fromUrl);
  return DEFAULT_OBJECTIVE;
}

window.addEventListener("DOMContentLoaded", () => {
  if (isSnapshotMode()) {
    bindControls();
    applySnapshot();
    return;
  }
  bindSettings();
  bindControls();
  const key = initialKey();
  document.getElementById("objective-key").value = key;
  loadKey(key);
});
