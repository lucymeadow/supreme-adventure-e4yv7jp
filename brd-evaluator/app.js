// BRD Evaluator — single-page app.
// Loads docs/brd-evaluator/data/bundle.json, accepts a .docx/.md/.txt drop,
// fans out 8 parallel calls to the Cloudflare Worker proxy, and renders the
// aggregated brd-evaluation as in-page markdown + .md download.

const BUNDLE_URL = "./data/bundle.json";
const LS_KEY = "brd-evaluator.settings.v1";
const DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

const state = {
  bundle: null,
  brd: null,            // { name, content, sourceType, mammothMessages? }
  strategyKey: null,
  results: {},          // criterion_key -> { status, score, payload?, error? }
  settings: loadSettings()
};

// ---------- Settings ----------

function loadSettings() {
  try {
    return Object.assign({ endpoint: "", token: "", model: DEFAULT_MODEL },
      JSON.parse(localStorage.getItem(LS_KEY) || "{}"));
  } catch { return { endpoint: "", token: "", model: DEFAULT_MODEL }; }
}

function saveSettings(s) {
  state.settings = { ...state.settings, ...s };
  localStorage.setItem(LS_KEY, JSON.stringify(state.settings));
}

// ---------- Bootstrap ----------

async function bootstrap() {
  wireUI();
  try {
    const res = await fetch(BUNDLE_URL);
    if (!res.ok) throw new Error(`Bundle fetch failed: ${res.status}`);
    state.bundle = await res.json();
    hydrateStrategyPicker();
  } catch (e) {
    setStrategyHint(`Could not load data bundle: ${e.message}`, true);
  }
}

function hydrateStrategyPicker() {
  const sel = document.getElementById("strategy");
  sel.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = ""; blank.textContent = "Choose a strategy…";
  sel.appendChild(blank);
  for (const s of state.bundle.strategies) {
    const opt = document.createElement("option");
    opt.value = s.key;
    opt.textContent = s.name;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  sel.addEventListener("change", () => {
    state.strategyKey = sel.value || null;
    updateRunReady();
  });
}

function setStrategyHint(msg, isError = false) {
  const h = document.getElementById("strategy-hint");
  h.textContent = msg;
  h.style.color = isError ? "var(--error)" : "var(--muted)";
}

// ---------- UI wiring ----------

function wireUI() {
  const dz = document.getElementById("dropzone");
  const fi = document.getElementById("file-input");
  const browse = document.getElementById("browse-btn");

  dz.addEventListener("click", e => { if (e.target.tagName !== "BUTTON") fi.click(); });
  dz.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); }});
  browse.addEventListener("click", e => { e.stopPropagation(); fi.click(); });
  ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("drag-over"); }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("drag-over"); }));
  dz.addEventListener("drop", e => { if (e.dataTransfer?.files?.[0]) handleFile(e.dataTransfer.files[0]); });
  fi.addEventListener("change", e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); });

  document.getElementById("run-btn").addEventListener("click", runEvaluation);
  document.getElementById("reset-btn").addEventListener("click", () => location.reload());
  document.getElementById("copy-btn").addEventListener("click", copyMarkdown);
  document.getElementById("download-btn").addEventListener("click", downloadMarkdown);

  const dlg = document.getElementById("settings-dialog");
  document.getElementById("settings-btn").addEventListener("click", () => openSettings(dlg));
  document.getElementById("settings-cancel").addEventListener("click", () => dlg.close());
  document.getElementById("settings-form").addEventListener("submit", e => {
    saveSettings({
      endpoint: document.getElementById("endpoint-url").value.trim(),
      token: document.getElementById("endpoint-token").value.trim(),
      model: document.getElementById("model-name").value.trim() || DEFAULT_MODEL
    });
    dlg.close();
    updateRunReady();
  });
}

function openSettings(dlg) {
  document.getElementById("endpoint-url").value = state.settings.endpoint || "";
  document.getElementById("endpoint-token").value = state.settings.token || "";
  document.getElementById("model-name").value = state.settings.model || DEFAULT_MODEL;
  dlg.showModal();
}

// ---------- File handling ----------

async function handleFile(file) {
  const hint = document.getElementById("file-hint");
  const dz = document.getElementById("dropzone");
  hint.style.color = "var(--muted)";
  hint.textContent = `Parsing ${file.name}…`;
  if (file.size > 10 * 1024 * 1024) {
    hint.style.color = "var(--error)";
    hint.textContent = `File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max 10 MB)`;
    return;
  }
  try {
    let content, sourceType, mammothMessages;
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "docx") {
      const buf = await file.arrayBuffer();
      const r = await window.mammoth.convertToMarkdown({ arrayBuffer: buf });
      content = r.value;
      mammothMessages = r.messages;
      sourceType = "docx";
    } else if (ext === "md" || ext === "txt") {
      content = await file.text();
      sourceType = ext;
    } else {
      throw new Error(`Unsupported file type: .${ext}`);
    }
    if (!content || content.trim().length < 50) {
      throw new Error("Document appears empty or too short to evaluate.");
    }
    state.brd = { name: file.name.replace(/\.[^.]+$/, ""), content, sourceType, mammothMessages };
    dz.classList.add("has-file");
    hint.textContent = `${file.name} loaded (${content.length.toLocaleString()} chars).${mammothMessages?.length ? " " + mammothMessages.length + " docx-conversion notes." : ""}`;
    updateRunReady();
  } catch (e) {
    state.brd = null;
    dz.classList.remove("has-file");
    hint.style.color = "var(--error)";
    hint.textContent = `Failed to load: ${e.message}`;
  }
}

function updateRunReady() {
  const ready = !!state.bundle && !!state.brd && !!state.strategyKey && !!state.settings.endpoint;
  const btn = document.getElementById("run-btn");
  btn.disabled = !ready;
  btn.title = ready ? "" :
    !state.bundle ? "Bundle still loading" :
    !state.brd ? "Drop a BRD file first" :
    !state.strategyKey ? "Pick a strategy" :
    "Set the proxy endpoint in Settings";
}

// ---------- Prompt assembly ----------

const EXEC_PREAMBLE = `## Execution Context

You are running in a stateless evaluation pipeline, NOT in an agentic environment. You do NOT have access to file-system tools (Read, Glob), nor to web search.

All content you need has been embedded directly into this prompt:
- The strategy context appears under "## Strategy Context" below.
- The BRD content appears under "## BRD Content" below.
- The expert AVATAR profile (if available) appears at the very end under "## Embedded AVATAR Profile".

Where the prompt below tells you to "Use the Read tool to load AVATAR.md at {{AVATAR_PATH}}", read the embedded AVATAR profile instead. If {{AVATAR_PATH}} is rendered as the literal string "null" below, no avatar is available — follow the graceful-degradation instructions in the criterion prompt.

Where the prompt below says web search is REQUIRED, do your best with your training-data knowledge of the market and clearly flag in 'weaknesses' that live web data was unavailable. Do not invent specific numeric figures.

Return ONLY the JSON block specified at the end of the criterion prompt. No prose around it. No code fence other than the one wrapping the JSON.

`;

function assembleStrategyContext(strat) {
  return strat.sources.map(s => `=== Source: ${s.filename} ===\n\n${s.content}`).join("\n\n");
}

function assemblePromptFor(criterion, strat, brdContent) {
  const avatarContent = state.bundle.avatars[criterion.avatar_slug] || null;
  const avatarPathLiteral = avatarContent ? "the embedded AVATAR profile" : "null";
  let p = criterion.prompt;
  // Replace ALL mentions of {{AVATAR_PATH}} — the prompt only uses it as an
  // inline path token, not in prose-quoting context.
  p = p.replaceAll("{{AVATAR_PATH}}", avatarPathLiteral);
  // For STRATEGY_CONTEXT and BRD_CONTENT the prompt also quotes the literal
  // token in its explanatory prose (e.g. "the `{{STRATEGY_CONTEXT}}` block").
  // Only substitute the standalone-line occurrence — the placeholder itself.
  p = p.replace(/^\{\{STRATEGY_CONTEXT\}\}\s*$/m, () => assembleStrategyContext(strat));
  p = p.replace(/^\{\{BRD_CONTENT\}\}\s*$/m, () => brdContent);
  let assembled = EXEC_PREAMBLE + p;
  if (avatarContent) {
    assembled += `\n\n---\n\n## Embedded AVATAR Profile\n\n${avatarContent}\n`;
  }
  return assembled;
}

// ---------- Run ----------

async function runEvaluation() {
  document.getElementById("run-btn").disabled = true;
  document.getElementById("reset-btn").hidden = false;
  document.getElementById("results").hidden = true;
  document.getElementById("progress").hidden = false;
  state.results = {};
  renderProgress("pending");

  const strat = state.bundle.strategies.find(s => s.key === state.strategyKey);
  const tasks = state.bundle.criteria.map(c => evalCriterion(c, strat, state.brd.content));
  await Promise.allSettled(tasks);
  finalize();
}

async function evalCriterion(criterion, strat, brdContent) {
  setCriterionStatus(criterion.key, "running");
  const prompt = assemblePromptFor(criterion, strat, brdContent);
  try {
    const res = await fetch(state.settings.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(state.settings.token ? { "X-Evaluator-Token": state.settings.token } : {})
      },
      body: JSON.stringify({
        criterion_key: criterion.key,
        model: state.settings.model || DEFAULT_MODEL,
        prompt
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Proxy returned ok=false");
    const payload = parseModelOutput(data.text);
    state.results[criterion.key] = { status: "done", score: payload.score, payload, expert: criterion.expert };
    setCriterionStatus(criterion.key, "done", payload.score);
  } catch (e) {
    state.results[criterion.key] = { status: "error", error: e.message, expert: criterion.expert };
    setCriterionStatus(criterion.key, "error", null, e.message);
  }
}

function parseModelOutput(text) {
  // Strip optional ```json fences. Then JSON.parse.
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // Some models prefix with "Here is the evaluation:" — find the first {.
  const idx = t.indexOf("{");
  if (idx > 0) t = t.slice(idx);
  return JSON.parse(t);
}

// ---------- Progress UI ----------

function renderProgress() {
  const ul = document.getElementById("criterion-list");
  ul.innerHTML = "";
  for (const c of state.bundle.criteria) {
    const li = document.createElement("li");
    li.dataset.key = c.key;
    li.innerHTML = `
      <span class="status" aria-hidden="true"></span>
      <span><span class="title">${c.title}</span> · <span class="expert">${c.expert}${c.avatar_available ? "" : " (no avatar)"}</span></span>
      <span class="score"></span>
      <span class="error-msg"></span>
    `;
    ul.appendChild(li);
  }
}

function setCriterionStatus(key, status, score = null, errorMsg = "") {
  const li = document.querySelector(`#criterion-list li[data-key="${key}"]`);
  if (!li) return;
  li.classList.remove("running", "done", "error");
  li.classList.add(status);
  li.querySelector(".score").textContent = score != null ? `${score}/10` : "";
  li.querySelector(".error-msg").textContent = errorMsg ? `· ${errorMsg}` : "";
}

// ---------- Aggregate + render ----------

function finalize() {
  const done = state.bundle.criteria.map(c => state.results[c.key]).filter(r => r?.status === "done");
  const errored = state.bundle.criteria.map(c => state.results[c.key]).filter(r => r?.status === "error");
  const summary = document.getElementById("run-summary");
  summary.hidden = false;
  summary.textContent = `${done.length} of ${state.bundle.criteria.length} criteria scored${errored.length ? `; ${errored.length} failed` : ""}.`;

  if (done.length === 0) {
    summary.style.color = "var(--error)";
    return;
  }

  const overall = done.reduce((s, r) => s + r.score, 0) / done.length;
  const strategicScore = state.results.strategic_alignment?.score ?? null;
  const recommendation = computeRecommendation(overall, strategicScore, done);
  const confidence = computeConfidence(overall, errored.length, state.bundle.criteria);

  const md = renderMarkdown({ overall, recommendation, confidence, errored });
  state.lastMarkdown = md;

  document.getElementById("results").hidden = false;
  document.getElementById("results-meta").innerHTML = renderMeta(overall, recommendation, confidence);
  document.getElementById("results-body").innerHTML = renderMarkdownToHTML(md);
  document.getElementById("run-btn").disabled = false;
}

function computeRecommendation(overall, strategicScore, done) {
  const rules = state.bundle.scoring_rules;
  if (overall >= rules.go_threshold_overall && (strategicScore ?? 10) >= rules.go_threshold_strategic) return "GO";
  if (overall >= rules.go_with_revisions_threshold && done.every(r => r.score >= rules.go_with_revisions_min_criterion)) return "GO-WITH-REVISIONS";
  return "NO-GO";
}

function computeConfidence(overall, erroredCount, allCriteria) {
  const missingAvatars = allCriteria.filter(c => !c.avatar_available).length;
  if (erroredCount >= 2 || overall < 5.0) return "LOW";
  if (erroredCount >= 1 || missingAvatars >= 1 || overall < 7.0) return "MEDIUM";
  return "HIGH";
}

function renderMeta(overall, rec, conf) {
  return `
    <div class="meta-item"><span class="label">Overall</span><span class="value">${overall.toFixed(2)}/10</span></div>
    <div class="meta-item"><span class="label">Recommendation</span><span class="value rec-${rec}">${rec}</span></div>
    <div class="meta-item"><span class="label">Confidence</span><span class="value">${conf}</span></div>
    <div class="meta-item"><span class="label">Strategy</span><span class="value" style="font-size:14px">${escapeHtml(state.bundle.strategies.find(s => s.key === state.strategyKey).name)}</span></div>
  `;
}

function renderMarkdown({ overall, recommendation, confidence, errored }) {
  const today = new Date().toISOString().slice(0, 10);
  const strat = state.bundle.strategies.find(s => s.key === state.strategyKey);
  const shortName = state.brd.name.replace(/[^A-Za-z0-9 ]/g, "").trim();
  const evalName = `${shortName} ${today}`;
  const lines = [];

  lines.push("---");
  lines.push("type: brd-evaluation");
  lines.push(`name: "${evalName}"`);
  lines.push(`brd-id: ${shortName.toUpperCase().replace(/\s+/g, "-")}`);
  lines.push(`title: "${state.brd.name}"`);
  lines.push(`evaluation-date: ${today}`);
  lines.push(`evaluator: "BRD Evaluator (web)"`);
  lines.push(`overall-score: ${overall.toFixed(3)}`);
  lines.push(`recommendation: ${recommendation}`);
  lines.push(`confidence: ${confidence}`);
  lines.push(`strategy: "${strat.name}"`);
  lines.push("status: draft");
  lines.push("---\n");

  lines.push("## Executive Summary\n");
  lines.push(`This BRD was evaluated against the **${strat.name}** strategy using the eight standard EG criteria, each scored through a designated industry-expert lens. The overall weighted score is **${overall.toFixed(2)}/10** with a recommendation of **${recommendation}** at **${confidence}** confidence.\n`);
  if (errored.length) {
    lines.push(`Note: ${errored.length} criterion call(s) failed during this run and were excluded from the overall score. Re-run if needed.\n`);
  }

  lines.push("## Scores Breakdown\n");
  lines.push("| Criterion | Score | Expert Lens |");
  lines.push("|---|---:|---|");
  for (const c of state.bundle.criteria) {
    const r = state.results[c.key];
    const score = r?.status === "done" ? `${r.score}/10` : (r?.status === "error" ? "—" : "—");
    const expert = r?.status === "done" && r.payload?.expert_lens_applied ? r.payload.expert_lens_applied : c.expert + (c.avatar_available ? "" : " (no avatar)");
    lines.push(`| ${c.title} | ${score} | ${expert} |`);
  }
  lines.push(`| **Overall (unweighted mean)** | **${overall.toFixed(2)}** | |\n`);

  lines.push("## Recommendation with Reasoning\n");
  lines.push(`**${recommendation}** — confidence ${confidence}.\n`);
  const convergence = findConvergence();
  if (convergence.length) {
    lines.push("### Cross-expert convergence themes\n");
    for (const theme of convergence) lines.push(`- ${theme}`);
    lines.push("");
  }

  lines.push("## Strategic Alignment Analysis\n");
  lines.push("Per-criterion detail.\n");
  for (const c of state.bundle.criteria) {
    const r = state.results[c.key];
    lines.push(`### ${c.title} — ${c.expert}\n`);
    if (!r) { lines.push("_Not evaluated._\n"); continue; }
    if (r.status === "error") { lines.push(`_Errored:_ ${r.error}\n`); continue; }
    const p = r.payload;
    lines.push(`**Score:** ${p.score}/10`);
    if (p.expert_lens_applied) lines.push(`**Expert lens applied:** ${p.expert_lens_applied}`);
    if (p.avatar_voice_quote) lines.push(`\n> ${p.avatar_voice_quote}\n`);
    if (p.reasoning) lines.push(`\n${p.reasoning}\n`);
    if (p.evidence?.length) { lines.push("**Evidence:**"); for (const e of p.evidence) lines.push(`- ${e}`); lines.push(""); }
    if (p.strengths?.length) { lines.push("**Strengths:**"); for (const e of p.strengths) lines.push(`- ${e}`); lines.push(""); }
    if (p.weaknesses?.length) { lines.push("**Weaknesses:**"); for (const e of p.weaknesses) lines.push(`- ${e}`); lines.push(""); }
  }

  const allWeak = state.bundle.criteria.flatMap(c => state.results[c.key]?.payload?.weaknesses || []);
  if (allWeak.length) {
    lines.push("## Weaknesses\n");
    for (const w of allWeak) lines.push(`- ${w}`);
    lines.push("");
  }
  const allStrong = state.bundle.criteria.flatMap(c => state.results[c.key]?.payload?.strengths || []);
  if (allStrong.length) {
    lines.push("## Strengths\n");
    for (const s of allStrong) lines.push(`- ${s}`);
    lines.push("");
  }

  lines.push("## Path Forward\n");
  if (recommendation === "GO") {
    lines.push("Proceed to PRD scoping. Use the per-criterion weaknesses above as a checklist to strengthen before formal PRD review.\n");
  } else if (recommendation === "GO-WITH-REVISIONS") {
    lines.push("Address the convergence themes and the lowest-scored criteria, then re-evaluate before promoting to PRD.\n");
  } else {
    lines.push("Do not promote to PRD until the convergence themes are resolved. The path forward is to rewrite the BRD around the depth-of-alignment, customer-problem, and financial gaps surfaced above.\n");
  }
  if (errored.length) {
    lines.push("\n### Evaluation caveats");
    for (const e of errored) lines.push(`- ${e.expert ?? "?"} criterion: ${e.error}`);
  }

  return lines.join("\n");
}

function findConvergence() {
  // Surface any phrase substring that appears in 2+ criteria's weaknesses.
  // Conservative: only flag short, distinctive phrases (3-8 words).
  const buckets = new Map();
  for (const c of state.bundle.criteria) {
    const ws = state.results[c.key]?.payload?.weaknesses || [];
    for (const w of ws) {
      const key = w.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).slice(0, 8).join(" ");
      if (key.length < 12) continue;
      const arr = buckets.get(key) || [];
      arr.push({ expert: c.expert, text: w });
      buckets.set(key, arr);
    }
  }
  const themes = [];
  for (const [, arr] of buckets) {
    if (arr.length >= 2) {
      const experts = [...new Set(arr.map(x => x.expert))];
      themes.push(`**${experts.join(" & ")}:** ${arr[0].text}`);
    }
  }
  return themes.slice(0, 5);
}

// ---------- Minimal markdown renderer ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderMarkdownToHTML(md) {
  const lines = md.split("\n");
  let html = ""; let inTable = false; let tableHeader = false; let inList = false; let inFence = false; let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line === "---") { inFrontmatter = true; html += '<pre style="background:#f1f5f9;color:#475569;font-size:12px;padding:10px;border-radius:6px;">'; continue; }
    if (inFrontmatter && line === "---") { inFrontmatter = false; html += "</pre>"; continue; }
    if (inFrontmatter) { html += escapeHtml(line) + "\n"; continue; }
    if (line.startsWith("```")) {
      html += inFence ? "</code></pre>" : '<pre><code>';
      inFence = !inFence;
      continue;
    }
    if (inFence) { html += escapeHtml(line) + "\n"; continue; }

    if (line.startsWith("|") && line.includes("|", 1)) {
      const cells = line.split("|").slice(1, -1).map(c => c.trim());
      const isDivider = cells.every(c => /^:?-+:?$/.test(c));
      if (isDivider) { tableHeader = true; continue; }
      if (!inTable) { html += "<table>"; inTable = true; }
      const tag = tableHeader && cells.length ? "th" : "td";
      html += "<tr>" + cells.map(c => `<${tag}>${inline(c)}</${tag}>`).join("") + "</tr>";
      tableHeader = false;
      continue;
    } else if (inTable) { html += "</table>"; inTable = false; }

    if (line.startsWith("### ")) { html += `<h3>${inline(line.slice(4))}</h3>`; continue; }
    if (line.startsWith("## ")) { html += `<h2>${inline(line.slice(3))}</h2>`; continue; }
    if (line.startsWith("# ")) { html += `<h1>${inline(line.slice(2))}</h1>`; continue; }
    if (line.startsWith("> ")) { html += `<blockquote>${inline(line.slice(2))}</blockquote>`; continue; }
    if (/^- /.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(line.slice(2))}</li>`;
      continue;
    }
    if (inList && !/^- /.test(line)) { html += "</ul>"; inList = false; }
    if (line.trim() === "") { html += ""; continue; }
    html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += "</ul>";
  if (inTable) html += "</table>";
  if (inFence) html += "</code></pre>";
  return html;
}

function inline(s) {
  let h = escapeHtml(s);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return h;
}

// ---------- Output actions ----------

async function copyMarkdown() {
  if (!state.lastMarkdown) return;
  await navigator.clipboard.writeText(state.lastMarkdown);
  const btn = document.getElementById("copy-btn");
  const orig = btn.textContent;
  btn.textContent = "Copied!";
  setTimeout(() => btn.textContent = orig, 1500);
}

function downloadMarkdown() {
  if (!state.lastMarkdown) return;
  const today = new Date().toISOString().slice(0, 10);
  const filename = `${state.brd.name} ${today}.md`;
  const blob = new Blob([state.lastMarkdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- Go ----------

bootstrap();
