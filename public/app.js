import { applyToneDigit, pinyinMatches } from "./pinyin.js";

let segmentLookup = null;
try {
  ({ segmentLookup } = await import("/lookup.js"));
} catch {
  // The chat still works when the generated segmenter is missing.
}

const lookup = {
  words: null,
  readings: null,
};

const learnerInput = document.querySelector("#learner");
const messages = document.querySelector("#messages");
const dueList = document.querySelector("#due");
const nextList = document.querySelector("#next");
const counts = document.querySelector("#counts");
const traceBox = document.querySelector("#trace");
const status = document.querySelector("#status");
const backend = document.querySelector("#backend");
const text = document.querySelector("#text");
const send = document.querySelector("#send");
const form = document.querySelector("#composer");
const chatPanel = document.querySelector("#chat-panel");
const practicePanel = document.querySelector("#practice-panel");
const practiceStage = document.querySelector("#practice-stage");
const practiceStatus = document.querySelector("#practice-status");
const tabChat = document.querySelector("#tab-chat");
const tabPractice = document.querySelector("#tab-practice");
const showDebug = document.querySelector("#show-debug");
const debugSection = document.querySelector("#debug");
const scheduleSection = document.querySelector("#schedule");
const debugNow = document.querySelector("#debug-now");
const debugLast = document.querySelector("#debug-last");
const debugQueue = document.querySelector("#debug-queue");
const debugModel = document.querySelector("#debug-model");

const PRACTICE_HISTORY_LIMIT = 10;
const PRACTICE_SETTLE_MS = 320;

const practice = {
  prompt: null,
  index: 0,
  answers: [],
  revealed: new Set(),
  pending: false,
  error: "",
  loadedFor: "",
  history: [],
  /** Scheduler internals sent with each practice response. */
  debug: null,
};

/** Glyph box of the sentence that just finished, used once for the settle animation. */
let practiceArrival = null;
let practiceGhost = null;

let practiceEpoch = 0;

/** Spoken audio for the current sentence, fetched while the student types. */
const speech = { hanzi: "", audio: null };

function speechUrl(hanzi) {
  return `/api/speech?text=${encodeURIComponent(hanzi)}`;
}

function preloadSpeech(hanzi) {
  if (!hanzi || speech.hanzi === hanzi) return;
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = speechUrl(hanzi);
  speech.hanzi = hanzi;
  speech.audio = audio;
}

function playSpeech(hanzi) {
  if (!hanzi) return;
  const audio =
    speech.hanzi === hanzi && speech.audio ? speech.audio : new Audio(speechUrl(hanzi));
  audio.currentTime = 0;
  // Playback is a nicety: a blocked autoplay or a missing key must not break practice.
  void audio.play().catch(() => {});
}

const state = {
  messages: [],
  systemPrompt: "",
  preview: null,
  trace: null,
  pending: false,
  writing: false,
  error: "",
  backend: "",
  tutorModel: "",
};

function learnerId() {
  const value = learnerInput.value.trim() || "local";
  localStorage.setItem("erudify-learner", value);
  return value;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function addText(parent, tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  parent.append(node);
  return node;
}

function appendSegmented(parent, source) {
  if (!segmentLookup || !lookup.words) {
    parent.append(document.createTextNode(source));
    return;
  }
  for (const piece of segmentLookup(source, lookup.words)) {
    if (piece.kind !== "word") {
      parent.append(document.createTextNode(piece.text));
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lookup";
    button.textContent = piece.hanzi;
    button.dataset.hanzi = piece.hanzi;
    parent.append(button);
  }
}

function appendInline(parent, source) {
  let index = 0;
  let plain = "";
  const flush = () => {
    if (!plain) return;
    appendSegmented(parent, plain);
    plain = "";
  };
  while (index < source.length) {
    if (source.startsWith("**", index) || source.startsWith("__", index)) {
      const mark = source.slice(index, index + 2);
      const end = source.indexOf(mark, index + 2);
      if (end !== -1) {
        flush();
        const strong = document.createElement("strong");
        appendInline(strong, source.slice(index + 2, end));
        parent.append(strong);
        index = end + 2;
        continue;
      }
    }
    if (source[index] === "`") {
      const end = source.indexOf("`", index + 1);
      if (end !== -1 && !source.slice(index + 1, end).includes("\n")) {
        flush();
        const code = document.createElement("code");
        code.textContent = source.slice(index + 1, end);
        parent.append(code);
        index = end + 1;
        continue;
      }
    }
    if (source[index] === "[") {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/u.exec(source.slice(index));
      if (link) {
        flush();
        const anchor = document.createElement("a");
        anchor.href = link[2];
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.textContent = link[1];
        parent.append(anchor);
        index += link[0].length;
        continue;
      }
    }
    if (
      (source[index] === "*" || source[index] === "_") &&
      source[index + 1] !== source[index]
    ) {
      const mark = source[index];
      const end = source.indexOf(mark, index + 1);
      if (end !== -1 && !source.slice(index + 1, end).includes("\n")) {
        flush();
        const em = document.createElement("em");
        appendInline(em, source.slice(index + 1, end));
        parent.append(em);
        index = end + 1;
        continue;
      }
    }
    plain += source[index];
    index += 1;
  }
  flush();
}

function appendMarkdown(parent, source) {
  const lines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  let index = 0;
  const isFence = (line) => line.trim().startsWith("```");
  const isHeading = (line) => /^#{1,3}\s+\S/u.test(line);
  const isItem = (line) => /^(\s*[-*+]|\s*\d+\.)\s+\S/u.test(line);
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (isFence(line)) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !isFence(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      parent.append(pre);
      continue;
    }
    if (isHeading(line)) {
      const heading = document.createElement("p");
      heading.className = "md-heading";
      appendInline(heading, line.replace(/^#{1,3}\s+/u, ""));
      parent.append(heading);
      index += 1;
      continue;
    }
    if (isItem(line)) {
      const ordered = /^\s*\d+\./u.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length && isItem(lines[index])) {
        const item = document.createElement("li");
        appendInline(item, lines[index].replace(/^(\s*[-*+]|\s*\d+\.)\s+/u, ""));
        list.append(item);
        index += 1;
      }
      parent.append(list);
      continue;
    }
    const paragraph = document.createElement("p");
    let first = true;
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !isFence(lines[index]) &&
      !isHeading(lines[index]) &&
      !isItem(lines[index])
    ) {
      if (!first) paragraph.append(document.createElement("br"));
      appendInline(paragraph, lines[index]);
      first = false;
      index += 1;
    }
    parent.append(paragraph);
  }
}

function collapsedMessage(className, key, label, content, openKeys) {
  const item = document.createElement("li");
  item.className = `message ${className}`;
  const details = document.createElement("details");
  details.dataset.key = key;
  if (openKeys.has(key)) details.open = true;
  const summary = document.createElement("summary");
  summary.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = content;
  details.append(summary, pre);
  item.append(details);
  return item;
}

function renderMessages() {
  const openKeys = new Set(
    [...messages.querySelectorAll("details[open]")].map((node) => node.dataset.key),
  );
  const follow =
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  clear(messages);
  if (state.systemPrompt) {
    messages.append(
      collapsedMessage(
        "system",
        "system",
        "System prompt",
        state.systemPrompt,
        openKeys,
      ),
    );
  }
  const spoken = state.messages.some(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (!spoken) {
    addText(
      messages,
      "li",
      "empty",
      "The schedule on the right is already loaded. Say hello, or ask what a word means. The tutor answers you first.",
    );
  }
  state.messages.forEach((message, index) => {
    if (message.role === "state") {
      messages.append(
        collapsedMessage(
          "state",
          `state-${index}`,
          "Learner state",
          message.content,
          openKeys,
        ),
      );
      return;
    }
    if (message.role !== "user" && message.role !== "assistant") return;
    const item = document.createElement("li");
    item.className = `message ${message.role}${message.streaming ? " streaming" : ""}`;
    addText(item, "span", "role", message.role === "user" ? "Student" : "Tutor");
    const body = document.createElement("div");
    body.className = "body";
    if (message.role === "assistant") appendMarkdown(body, message.content);
    else appendSegmented(body, message.content);
    item.append(body);
    messages.append(item);
  });
  if (follow) messages.scrollTop = messages.scrollHeight;
  syncLookup();
}

function nearBottom() {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
}

function paintAssistant() {
  const follow = nearBottom();
  const message = state.messages[state.messages.length - 1];
  const item = messages.lastElementChild;
  if (
    !message ||
    message.role !== "assistant" ||
    !item ||
    !item.classList.contains("assistant")
  ) {
    render();
    return;
  }
  item.classList.toggle("streaming", Boolean(message.streaming));
  const body = item.querySelector(".body");
  clear(body);
  appendMarkdown(body, message.content);
  if (follow) messages.scrollTop = messages.scrollHeight;
  syncLookup();
}

function parseSse(raw) {
  let event = "message";
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: JSON.parse(dataLines.join("\n")) };
}

async function readTurn(response) {
  const type = response.headers.get("content-type") || "";
  if (!response.ok || !type.includes("text/event-stream")) {
    let message = "The turn failed.";
    try {
      const body = await response.json();
      if (body.error) message = body.error;
    } catch {
      // The error body was not JSON.
    }
    throw new Error(message);
  }
  const assistant = { role: "assistant", content: "", streaming: true };
  state.messages.push(assistant);
  render();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const handle = async (raw) => {
    const parsed = raw.trim() ? parseSse(raw) : null;
    if (!parsed) return;
    if (parsed.event === "meta") {
      state.trace = parsed.data.trace;
      state.preview = parsed.data.preview;
      const brief = parsed.data.trace?.brief;
      if (brief && !assistant.learnerState) {
        const at = state.messages.indexOf(assistant);
        const userAt = at > 0 ? at - 1 : -1;
        const insertAt =
          userAt >= 0 && state.messages[userAt].role === "user"
            ? userAt
            : Math.max(at, 0);
        state.messages.splice(insertAt, 0, { role: "state", content: brief });
        assistant.learnerState = true;
      }
      render();
      return;
    }
    if (parsed.event === "delta") {
      assistant.content += parsed.data.text || "";
      state.writing = true;
      status.textContent = "";
      paintAssistant();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return;
    }
    if (parsed.event === "done") {
      assistant.content = (parsed.data.reply || assistant.content).trim();
      assistant.streaming = false;
      state.writing = false;
      finished = true;
      paintAssistant();
      return;
    }
    if (parsed.event === "error")
      throw new Error(parsed.data.error || "The turn failed.");
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    let splitAt = buffer.indexOf("\n\n");
    while (splitAt !== -1) {
      const raw = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      await handle(raw);
      splitAt = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) await handle(buffer);
  if (!finished) throw new Error("The reply was cut off.");
}

function debugOn() {
  return showDebug.checked;
}

function relative(at, now = Date.now()) {
  const delta = at - now;
  const size = Math.round(Math.abs(delta) / 60_000);
  if (size < 1) return delta > 0 ? "in <1 min" : "now";
  let text;
  if (size < 60) text = `${size} min`;
  else if (size < 48 * 60) text = `${Math.round(size / 60)} h`;
  else text = `${Math.round(size / 1440)} d`;
  return delta < 0 ? `${text} ago` : `in ${text}`;
}

function fixed(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "–";
}

function pct(value) {
  const share = value * 100;
  return share > 99 && share < 99.95 ? `${share.toFixed(1)}%` : `${Math.round(share)}%`;
}

function renderDebugNow(debug, prompt) {
  clear(debugNow);
  const why = debug?.why;
  if (!prompt) {
    addText(debugNow, "p", "muted", "No sentence. The curriculum may be finished.");
    return;
  }
  const head = document.createElement("p");
  head.className = `debug-mode ${prompt.purpose}`;
  head.textContent = prompt.purpose === "introduce" ? "Introducing" : "Reviewing";
  debugNow.append(head);
  if (!why) {
    addText(
      debugNow,
      "p",
      "muted",
      "This sentence was picked before reasons were recorded. The next one will have them.",
    );
    return;
  }
  const reasons = document.createElement("ol");
  reasons.className = "debug-reasons";
  for (const reason of why.reasons) addText(reasons, "li", "", reason);
  debugNow.append(reasons);
  addText(debugNow, "p", "muted", `Decided ${relative(why.decidedAt)}.`);
  if (why.candidates.length > 1) {
    const details = document.createElement("details");
    addText(
      details,
      "summary",
      "",
      `Sentences weighed (${why.candidates.length} shown)`,
    );
    const list = document.createElement("ul");
    for (const row of why.candidates) {
      const li = document.createElement("li");
      li.className = row.chosen ? "item debug-chosen" : "item";
      addText(li, "b", "", row.hanzi);
      const notes = [`tier ${row.tier}`];
      if (row.newWords.length) notes.push(`new: ${row.newWords.join("、")}`);
      notes.push(row.shownAt === null ? "unseen" : `shown ${relative(row.shownAt)}`);
      if (row.chosen) notes.push("picked");
      addText(li, "span", "gloss", ` ${notes.join(" · ")}`);
      list.append(li);
    }
    details.append(list);
    addText(
      details,
      "p",
      "muted",
      "Tier 1: every other word stable. Tier 2: every other word known. Tier 3: anything else.",
    );
    debugNow.append(details);
  }
}

function renderDebugLast(trace) {
  clear(debugLast);
  if (!trace || trace.backend !== "practice" || !trace.events?.length) {
    addText(debugLast, "p", "muted", "No practice answer yet.");
    return;
  }
  const list = document.createElement("ul");
  for (const event of trace.events) {
    const li = document.createElement("li");
    li.className = "event";
    addText(li, "b", "", event.hanzi);
    const pass = event.outcome !== "unknown" && event.outcome !== "misunderstood";
    addText(li, "span", pass ? "debug-pass" : "debug-miss", pass ? " ✓ " : " ✗ ");
    const before = event.before;
    const stability = before
      ? `S ${fixed(before.stability)} → ${fixed(event.stability)} d`
      : `S ${fixed(event.stability)} d`;
    addText(
      li,
      "span",
      "gloss",
      `${event.ratingName} · ${stability} · ${before ? `${before.state} → ` : ""}${event.state} · due ${relative(event.dueAt)}`,
    );
    list.append(li);
  }
  debugLast.append(list);
  addText(
    debugLast,
    "p",
    "muted",
    "Every word in the sentence is graded. Showing the answer is a miss; anything else is a pass.",
  );
}

function renderDebugQueue(debug) {
  clear(debugQueue);
  const rows = debug?.knowledge || [];
  const now = debug?.now ?? Date.now();
  const due = rows
    .filter((row) => row.state !== "new" && row.due <= now)
    .sort((a, b) => a.retrievability - b.retrievability);
  const soon = rows.filter((row) => row.due > now).slice(0, 5);
  if (due.length === 0) {
    addText(
      debugQueue,
      "p",
      "muted",
      "Nothing is due, so the next sentence introduces a new word.",
    );
  } else {
    addText(
      debugQueue,
      "p",
      "muted",
      "Due words, lowest recall chance first. The top one is reviewed next.",
    );
    const list = document.createElement("ol");
    list.className = "debug-queue";
    for (const row of due) {
      const li = document.createElement("li");
      addText(li, "b", "", row.hanzi);
      addText(
        li,
        "span",
        "gloss",
        ` recall ${pct(row.retrievability)} · due ${relative(row.due, now)}`,
      );
      list.append(li);
    }
    debugQueue.append(list);
  }
  if (soon.length) {
    addText(
      debugQueue,
      "p",
      "muted",
      `Coming up: ${soon.map((row) => `${row.hanzi} ${relative(row.due, now)}`).join(", ")}.`,
    );
  }
}

function renderDebugModel(debug, prompt) {
  clear(debugModel);
  const rows = debug?.knowledge || [];
  if (rows.length === 0) {
    addText(debugModel, "p", "muted", "No cards yet. Every word starts unknown.");
    return;
  }
  const now = debug.now;
  const tally = { stable: 0, known: 0, fragile: 0 };
  for (const row of rows) tally[row.standing] += 1;
  addText(
    debugModel,
    "p",
    "muted",
    `${rows.length} words with cards: ${tally.stable} stable, ${tally.known} known, ${tally.fragile} fragile. Stable means reviewed twice and recall still at least 90%.`,
  );
  const inSentence = new Set(
    (prompt?.pieces || [])
      .filter((piece) => piece.kind === "word")
      .map((piece) => piece.hanzi),
  );
  const wrap = document.createElement("div");
  wrap.className = "debug-table-wrap";
  const table = document.createElement("table");
  table.className = "debug-table";
  const head = document.createElement("tr");
  for (const [label, title] of [
    ["Word", ""],
    ["Standing", "stable, known or fragile"],
    ["Recall", "Chance of recall right now"],
    ["S", "Stability: days until recall falls to 90%"],
    ["D", "Difficulty, 1 to 10"],
    ["Due", ""],
  ]) {
    const th = addText(head, "th", "", label);
    if (title) th.title = title;
  }
  const thead = document.createElement("thead");
  thead.append(head);
  table.append(thead);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    if (row.due <= now) tr.classList.add("due");
    if (row.hanzi === prompt?.focus) tr.classList.add("focus");
    else if (inSentence.has(row.hanzi)) tr.classList.add("in-sentence");
    const word = addText(tr, "td", "zh", row.hanzi);
    word.title = `${row.pinyin} · ${row.gloss}\n${row.reps} reviews, ${row.lapses} misses`;
    addText(tr, "td", `standing ${row.standing}`, `${row.standing} · ${row.state}`);
    addText(tr, "td", "num", pct(row.retrievability));
    addText(tr, "td", "num", fixed(row.stability));
    addText(tr, "td", "num", fixed(row.difficulty));
    addText(tr, "td", "num", relative(row.due, now));
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  debugModel.append(wrap);
  addText(
    debugModel,
    "p",
    "muted",
    "Highlighted: due rows; bold is the word this sentence is for; marked rows are its other words.",
  );
}

function renderDebug() {
  const visible = debugOn() && !practicePanel.hidden;
  debugSection.hidden = !visible;
  scheduleSection.hidden = visible;
  document.body.classList.toggle("debugging", visible);
  if (!visible) return;
  renderDebugNow(practice.debug, practice.prompt);
  renderDebugLast(state.trace);
  renderDebugQueue(practice.debug);
  renderDebugModel(practice.debug, practice.prompt);
}

function renderList(node, items, renderItem, empty) {
  clear(node);
  if (!items || items.length === 0) {
    addText(node, "li", "muted", empty);
    return;
  }
  for (const item of items) node.append(renderItem(item));
}

function renderLedger() {
  const preview = state.preview;
  clear(counts);
  const pairs = [
    ["Stable words", preview ? String(preview.stableCount) : "–"],
    ["Due now", preview ? String(preview.due.length) : "–"],
    ["Curriculum left", preview ? String(preview.curriculumRemaining) : "–"],
  ];
  for (const [label, value] of pairs) {
    addText(counts, "dt", "", label);
    addText(counts, "dd", "", value);
  }
  renderList(
    dueList,
    preview?.due,
    (item) => {
      const li = document.createElement("li");
      li.className = "item";
      addText(li, "b", "", item.hanzi);
      addText(li, "span", "gloss", ` ${item.gloss} · ${item.state}`);
      return li;
    },
    "Nothing is due.",
  );
  renderList(
    nextList,
    preview?.nextNew,
    (item) => {
      const li = document.createElement("li");
      li.className = "item";
      addText(li, "b", "", item.hanzi);
      addText(li, "span", "gloss", ` ${item.gloss}`);
      return li;
    },
    "The curriculum on file is exhausted.",
  );
  clear(traceBox);
  const trace = state.trace;
  if (!trace) {
    addText(traceBox, "p", "muted", "No turn yet.");
    return;
  }
  if (trace.backend === "practice") {
    addText(traceBox, "p", "muted", "Pinyin practice.");
  }
  if (!trace.events || trace.events.length === 0) {
    addText(traceBox, "p", "muted", "No memory evidence in that message.");
  } else {
    const list = document.createElement("ul");
    for (const event of trace.events) {
      const li = document.createElement("li");
      li.className = "event";
      addText(li, "b", "", event.hanzi);
      addText(
        li,
        "span",
        "gloss",
        ` ${event.outcome} → ${event.ratingName}, next ${event.state}`,
      );
      list.append(li);
    }
    traceBox.append(list);
  }
  if (trace.suggestions?.length) {
    const offered = document.createElement("p");
    offered.className = "muted";
    offered.textContent = `Offered, not required: ${trace.suggestions.map((item) => item.hanzi).join("、")}`;
    traceBox.append(offered);
  }
  if (trace.brief) {
    const details = document.createElement("details");
    addText(details, "summary", "", "Brief sent to the tutor");
    addText(details, "pre", "brief", trace.brief);
    traceBox.append(details);
  }
}

function render() {
  renderMessages();
  renderLedger();
  renderDebug();
  send.disabled = state.pending;
  text.disabled = state.pending;
  status.className = state.error ? "error" : "";
  status.textContent =
    state.error ||
    (state.writing
      ? ""
      : state.pending
        ? "Reading the message, then updating the schedule…"
        : "");
  const model = state.tutorModel ? ` · ${state.tutorModel}` : "";
  backend.textContent = state.backend ? `${state.backend}${model}` : "";
}

let viewEpoch = 0;

function invalidateView() {
  viewEpoch += 1;
}

async function loadSession() {
  const epoch = ++viewEpoch;
  state.error = "";
  try {
    const response = await fetch(
      `/api/session?learner=${encodeURIComponent(learnerId())}`,
    );
    const body = await response.json();
    if (epoch !== viewEpoch) return;
    if (!response.ok) throw new Error(body.error || "Could not load the session.");
    state.systemPrompt = body.systemPrompt || "";
    state.messages = body.messages || [];
    state.preview = body.preview;
    state.trace = body.trace;
    state.backend = body.backend || "";
    state.tutorModel = body.tutorModel || "";
    render();
  } catch (error) {
    if (epoch !== viewEpoch) return;
    state.error =
      error instanceof Error ? error.message : "Could not load the session.";
    render();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = text.value.trim();
  if (!content || state.pending) return;
  invalidateView();
  state.pending = true;
  state.writing = false;
  state.error = "";
  const userMessage = { role: "user", content };
  state.messages.push(userMessage);
  text.value = "";
  render();
  try {
    const response = await fetch("/api/turn", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ learner: learnerId(), text: content }),
    });
    await readTurn(response);
  } catch (error) {
    const last = state.messages[state.messages.length - 1];
    if (last && last !== userMessage && last.role === "assistant") state.messages.pop();
    const userAt = state.messages.indexOf(userMessage);
    if (userAt > 0 && state.messages[userAt - 1].role === "state") {
      state.messages.splice(userAt - 1, 1);
    }
    if (state.messages[state.messages.length - 1] === userMessage) state.messages.pop();
    text.value = content;
    state.error = error instanceof Error ? error.message : "The turn failed.";
  } finally {
    state.pending = false;
    state.writing = false;
    render();
  }
});

function applyComposerTone(event) {
  const el = event.currentTarget;
  if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return;
  if (event.isComposing || event.key === "Process") return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (!/^[1-5]$/.test(event.key)) return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (start === null || end === null || start !== end) return;
  const edit = applyToneDigit(el.value, start, Number(event.key));
  if (!edit) return;
  event.preventDefault();
  if (el.value.slice(edit.start, edit.end) !== edit.replacement) {
    el.setRangeText(edit.replacement, edit.start, edit.end, "end");
  }
  el.setSelectionRange(edit.cursor, edit.cursor);
}

text.addEventListener("keydown", (event) => {
  if (event.isComposing || event.key === "Process") return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
    return;
  }
  applyComposerTone(event);
});

function wordPieces(prompt) {
  return (prompt?.pieces || []).filter((piece) => piece.kind === "word");
}

function rememberExercise(prompt) {
  practice.history.push({ hanzi: prompt.hanzi, english: prompt.english || "" });
  if (practice.history.length > PRACTICE_HISTORY_LIMIT) {
    practice.history.splice(0, practice.history.length - PRACTICE_HISTORY_LIMIT);
  }
}

function motionOk() {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function clearFlight() {
  practiceGhost?.remove();
  practiceGhost = null;
}

/** Tight box around the characters, ignoring the full-width line they sit in. */
function inkBox(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const box = range.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return node.getBoundingClientRect();
  return box;
}

/** Union of the large characters, so the flight starts on the sentence itself. */
function measureGlyphs(sentence) {
  const nodes = sentence.querySelectorAll(".practice-hanzi, .practice-gap");
  let top = Infinity;
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let fontSize = 0;
  for (const node of nodes) {
    const box = node.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    top = Math.min(top, box.top);
    left = Math.min(left, box.left);
    right = Math.max(right, box.right);
    bottom = Math.max(bottom, box.bottom);
    if (!fontSize) fontSize = parseFloat(getComputedStyle(node).fontSize) || 0;
  }
  if (top === Infinity) return null;
  return { top, left, width: right - left, height: bottom - top, fontSize };
}

function currentInFrame() {
  const active = practiceStage.querySelector(".practice-current");
  if (!active) return true;
  const frame = practiceStage.getBoundingClientRect();
  const box = active.getBoundingClientRect();
  return box.top >= frame.top - 8 && box.bottom <= frame.bottom + 8;
}

/** Keep the exercise on screen. A short window scrolls instead of covering the sentence. */
function pinPractice() {
  const active = practiceStage.querySelector(".practice-current");
  if (!active) return;
  const frame = practiceStage.getBoundingClientRect();
  let box = active.getBoundingClientRect();
  if (box.bottom > frame.bottom - 8) {
    practiceStage.scrollTop += box.bottom - frame.bottom + 12;
    box = active.getBoundingClientRect();
  }
  if (box.top < frame.top + 8) {
    practiceStage.scrollTop -= frame.top + 8 - box.top;
  }
}

function releaseOpacity(node) {
  if (node?.isConnected) node.style.opacity = "";
}

function fadeIn(node, duration, delay) {
  if (!node) return;
  const fade = node.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration,
    delay,
    easing: "ease-out",
    fill: "both",
  });
  void fade.finished.then(
    () => releaseOpacity(node),
    () => releaseOpacity(node),
  );
}

/** Hide the resting copy before paint so the flight is the only thing that moves. */
function prepareArrival(from) {
  if (!from || !motionOk()) return;
  const item = practiceStage.querySelector(".practice-history li:last-child");
  const zh = item?.querySelector(".practice-history-zh");
  const english = item?.querySelector(".practice-history-en");
  const sentence = practiceStage.querySelector(".practice-sentence");
  if (zh) zh.style.opacity = "0";
  if (english) english.style.opacity = "0";
  if (sentence) sentence.style.opacity = "0";
}

function settlePractice(from) {
  if (!from || !motionOk()) return;
  requestAnimationFrame(() => {
    pinPractice();
    const item = practiceStage.querySelector(".practice-history li:last-child");
    const zh = item?.querySelector(".practice-history-zh");
    const english = item?.querySelector(".practice-history-en");
    const sentence = practiceStage.querySelector(".practice-sentence");
    if (zh && zh.style.opacity === "0") {
      const words = zh.querySelector(".practice-history-text") ?? zh;
      const to = inkBox(words);
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + from.height / 2 - (to.top + to.height / 2);
      const toSize = parseFloat(getComputedStyle(zh).fontSize) || from.fontSize || 1;
      const scale = Math.min(1.7, Math.max(1, (from.fontSize || toSize) / toSize));
      const ghost = document.createElement("p");
      ghost.className = "practice-history-zh practice-flight";
      ghost.lang = "zh-Hans";
      ghost.textContent = words.textContent;
      ghost.style.left = `${to.left}px`;
      ghost.style.top = `${to.top}px`;
      ghost.style.width = `${Math.max(to.width, 1)}px`;
      document.body.append(ghost);
      practiceGhost = ghost;
      const flight = ghost.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
          { transform: "translate(0px, 0px) scale(1)" },
        ],
        { duration: PRACTICE_SETTLE_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
      const land = () => {
        if (practiceGhost === ghost) practiceGhost = null;
        ghost.remove();
        releaseOpacity(zh);
      };
      void flight.finished.then(land, land);
    } else {
      releaseOpacity(zh);
    }
    fadeIn(english, 200, 90);
    fadeIn(sentence, 220, 80);
  });
}

function renderHistory(stack) {
  if (practice.history.length === 0) return;
  const list = document.createElement("ol");
  list.className = "practice-history";
  list.setAttribute("aria-label", "Completed exercises");
  for (const item of practice.history) {
    const row = document.createElement("li");
    const chinese = addText(row, "p", "practice-history-zh", "");
    chinese.lang = "zh-Hans";
    // Only finished sentences get the popup dictionary; the live one is the exercise.
    const words = addText(chinese, "span", "practice-history-text", "");
    appendSegmented(words, item.hanzi);
    const replay = document.createElement("button");
    replay.type = "button";
    replay.className = "practice-speak";
    replay.textContent = "▶";
    replay.title = "Play pronunciation";
    replay.setAttribute("aria-label", `Play pronunciation of ${item.hanzi}`);
    replay.addEventListener("click", () => playSpeech(item.hanzi));
    chinese.append(replay);
    if (item.english) {
      const english = addText(row, "p", "practice-history-en", item.english);
      english.lang = "en";
    }
    list.append(row);
  }
  stack.append(list);
}

function renderPractice() {
  const from = practiceArrival;
  practiceArrival = null;
  const keepPlace = !from && !currentInFrame();
  const keptScroll = practiceStage.scrollTop;
  clearFlight();
  clear(practiceStage);
  practiceStatus.className = practice.error ? "error" : "";
  practiceStatus.textContent =
    practice.error || (practice.pending ? "Saving this sentence…" : "");
  const stack = document.createElement("div");
  stack.className = "practice-stack";
  renderHistory(stack);
  const current = document.createElement("div");
  current.className = "practice-current";
  stack.append(current);
  practiceStage.append(stack);
  if (keepPlace) practiceStage.scrollTop = keptScroll;
  else pinPractice();
  const prompt = practice.prompt;
  if (!prompt) {
    if (practice.loadedFor) {
      addText(
        current,
        "p",
        "practice-empty",
        "Nothing is due, and the curriculum on file is finished.",
      );
    }
    prepareArrival(from);
    settlePractice(from);
    syncLookup();
    return;
  }
  const words = wordPieces(prompt);
  if (debugOn() && prompt.focus) {
    const badge = document.createElement("p");
    badge.className = `practice-purpose ${prompt.purpose}`;
    const focusGloss = practice.debug?.knowledge
      ?.find((row) => row.hanzi === prompt.focus)
      ?.gloss?.split(/[;/]/u)[0]
      .replace(/\s*\([^)]*\)/gu, "")
      .trim();
    badge.textContent =
      prompt.purpose === "introduce"
        ? `New word · ${prompt.focus}`
        : `Review · ${prompt.focus}${focusGloss ? ` (${focusGloss})` : ""}`;
    current.append(badge);
  }
  const sentence = document.createElement("div");
  sentence.className = "practice-sentence";
  sentence.lang = "zh-Hans";
  let wordIndex = 0;
  for (const piece of prompt.pieces) {
    if (piece.kind === "gap") {
      addText(sentence, "span", "practice-gap", piece.text);
      continue;
    }
    const slotIndex = wordIndex;
    const slot = document.createElement("div");
    slot.className = "practice-slot";
    if (debugOn() && piece.hanzi === prompt.focus) slot.classList.add("practice-focus");
    addText(slot, "span", "practice-hanzi", piece.hanzi);
    const field = document.createElement("div");
    field.className = "practice-field";
    const sizer = addText(field, "span", "practice-sizer", piece.pinyin || piece.hanzi);
    sizer.setAttribute("aria-hidden", "true");
    const reading = addText(field, "span", "practice-reading", "");
    const revealed = practice.revealed.has(slotIndex);
    if (slotIndex < practice.index) {
      reading.textContent = practice.answers[slotIndex] || "";
      reading.classList.add("filled");
      if (revealed) reading.classList.add("shown");
    } else if (slotIndex === practice.index) {
      if (revealed) {
        reading.textContent = piece.pinyin;
        reading.classList.add("shown");
      }
      const input = document.createElement("input");
      input.type = "text";
      input.spellcheck = false;
      input.autocomplete = "off";
      input.setAttribute("autocapitalize", "off");
      input.setAttribute("autocorrect", "off");
      input.setAttribute("aria-label", `Pinyin for ${piece.hanzi}`);
      input.disabled = practice.pending;
      const consider = () => {
        if (!input.isConnected || practice.pending) return;
        if (!pinyinMatches(input.value, piece.pinyin)) return;
        practice.answers[slotIndex] = input.value;
        practice.index = slotIndex + 1;
        if (practice.index >= words.length) {
          void submitPractice();
          return;
        }
        renderPractice();
      };
      input.addEventListener("keydown", (event) => {
        if (event.isComposing || event.key === "Process") return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          hideLookup();
          if (practice.revealed.has(slotIndex) || practice.pending) return;
          const draft = input.value;
          practice.revealed.add(slotIndex);
          renderPractice();
          const next = practiceStage.querySelector("input");
          if (next instanceof HTMLInputElement) {
            next.value = draft;
            const end = next.value.length;
            next.setSelectionRange(end, end);
            next.focus();
          }
          return;
        }
        applyComposerTone(event);
        consider();
      });
      input.addEventListener("input", (event) => {
        if (event.isComposing) return;
        consider();
      });
      field.append(input);
    }
    slot.append(field);
    sentence.append(slot);
    wordIndex += 1;
  }
  current.append(sentence);
  if (practice.error && practice.index >= words.length && !practice.pending) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Save again";
    retry.addEventListener("click", () => void submitPractice());
    current.append(retry);
  }
  const input = practiceStage.querySelector("input");
  if (input instanceof HTMLInputElement && !practicePanel.hidden && !practice.pending) {
    input.focus({ preventScroll: true });
  }
  prepareArrival(from);
  settlePractice(from);
  syncLookup();
}

function acceptPrompt(prompt) {
  practice.prompt = prompt;
  practice.index = 0;
  practice.answers = [];
  practice.revealed = new Set();
  practice.pending = false;
  practice.error = "";
  practice.loadedFor = learnerId();
  preloadSpeech(prompt?.hanzi);
  renderPractice();
}

async function loadPractice() {
  const epoch = ++practiceEpoch;
  const learner = learnerId();
  practice.pending = false;
  practice.error = "";
  practice.prompt = null;
  practice.loadedFor = "";
  renderPractice();
  practiceStatus.className = "";
  practiceStatus.textContent = "Loading a sentence…";
  try {
    const response = await fetch(
      `/api/practice?learner=${encodeURIComponent(learner)}`,
    );
    const body = await response.json();
    if (epoch !== practiceEpoch) return;
    if (!response.ok) throw new Error(body.error || "Could not load pinyin practice.");
    if (body.preview) state.preview = body.preview;
    if (body.trace) state.trace = body.trace;
    practice.debug = body.debug || null;
    acceptPrompt(body.prompt);
    render();
  } catch (error) {
    if (epoch !== practiceEpoch) return;
    practice.error =
      error instanceof Error ? error.message : "Could not load pinyin practice.";
    practice.loadedFor = "";
    renderPractice();
  }
}

async function submitPractice() {
  const prompt = practice.prompt;
  if (!prompt || practice.pending) return;
  const epoch = ++practiceEpoch;
  practice.pending = true;
  practice.error = "";
  renderPractice();
  try {
    const response = await fetch("/api/practice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        learner: learnerId(),
        hanzi: prompt.hanzi,
        revealed: [...practice.revealed],
      }),
    });
    const body = await response.json();
    if (epoch !== practiceEpoch) return;
    if (response.status === 409) {
      await loadPractice();
      return;
    }
    if (!response.ok) throw new Error(body.error || "Could not save this sentence.");
    const finished = practiceStage.querySelector(".practice-sentence");
    rememberExercise(prompt);
    playSpeech(prompt.hanzi);
    practiceArrival = finished ? measureGlyphs(finished) : null;
    state.preview = body.preview;
    state.trace = body.trace;
    state.error = "";
    practice.debug = body.debug || null;
    acceptPrompt(body.prompt);
    render();
  } catch (error) {
    if (epoch !== practiceEpoch) return;
    practice.pending = false;
    practice.error =
      error instanceof Error ? error.message : "Could not save this sentence.";
    renderPractice();
  }
}

function forgetPractice() {
  practiceEpoch += 1;
  practice.prompt = null;
  practice.index = 0;
  practice.answers = [];
  practice.revealed = new Set();
  practice.pending = false;
  practice.error = "";
  practice.loadedFor = "";
  practice.history = [];
  practice.debug = null;
  practiceArrival = null;
  if (practicePanel.hidden) renderPractice();
  else void loadPractice();
}

function selectTab(mode) {
  const practiceOn = mode === "practice";
  chatPanel.hidden = practiceOn;
  practicePanel.hidden = !practiceOn;
  tabChat.setAttribute("aria-selected", practiceOn ? "false" : "true");
  tabPractice.setAttribute("aria-selected", practiceOn ? "true" : "false");
  tabChat.tabIndex = practiceOn ? -1 : 0;
  tabPractice.tabIndex = practiceOn ? 0 : -1;
  renderDebug();
  if (!practiceOn) return;
  if (practice.loadedFor !== learnerId()) void loadPractice();
  else renderPractice();
}

tabChat.addEventListener("click", () => selectTab("chat"));
tabPractice.addEventListener("click", () => selectTab("practice"));
for (const tab of [tabChat, tabPractice]) {
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const toPractice = tabPractice.getAttribute("aria-selected") !== "true";
    selectTab(toPractice ? "practice" : "chat");
    (toPractice ? tabPractice : tabChat).focus();
  });
}

document.querySelector("#reset").addEventListener("click", async () => {
  if (!confirm("Clear this learner's messages, schedule, and pinyin progress?")) return;
  invalidateView();
  state.pending = true;
  render();
  try {
    const response = await fetch("/api/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learner: learnerId() }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Reset failed.");
    state.systemPrompt = body.systemPrompt || "";
    state.messages = body.messages || [];
    state.preview = body.preview;
    state.trace = body.trace;
    state.error = "";
    forgetPractice();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Reset failed.";
  } finally {
    state.pending = false;
    render();
  }
});

learnerInput.addEventListener("change", () => {
  state.messages = [];
  state.trace = null;
  state.preview = null;
  state.error = "";
  forgetPractice();
  render();
  loadSession();
});

const popover = document.createElement("div");
popover.className = "lookup-popover";
popover.hidden = true;
document.body.append(popover);

let lookupAnchor = null;
let lookupPinned = false;

function hideLookup() {
  popover.hidden = true;
  lookupAnchor = null;
  lookupPinned = false;
}

function placeLookup() {
  if (!lookupAnchor || popover.hidden) return;
  const word = lookupAnchor.getBoundingClientRect();
  popover.style.left = "8px";
  popover.style.top = "8px";
  const card = popover.getBoundingClientRect();
  let top = word.bottom + 6;
  let left = word.left;
  if (left + card.width > window.innerWidth - 8)
    left = window.innerWidth - 8 - card.width;
  if (left < 8) left = 8;
  if (top + card.height > window.innerHeight - 8) top = word.top - card.height - 6;
  if (top < 8) top = 8;
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}

function syncLookup() {
  if (!lookupAnchor) return;
  if (!lookupAnchor.isConnected) hideLookup();
  else placeLookup();
}

function readingsFor(hanzi) {
  const rows = lookup.readings?.[hanzi];
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => Array.isArray(row) && typeof row[0] === "string");
}

function showLookup(button, pin) {
  const hanzi = button.dataset.hanzi || "";
  const readings = readingsFor(hanzi);
  if (readings.length === 0) return;
  clear(popover);
  addText(popover, "p", "lookup-word", hanzi);
  for (const [pinyin, gloss] of readings) {
    const row = document.createElement("p");
    row.className = "lookup-reading";
    addText(row, "span", "lookup-pinyin", pinyin);
    addText(row, "span", "lookup-gloss", gloss || "");
    popover.append(row);
  }
  const credit = document.createElement("p");
  credit.className = "lookup-credit";
  const dictLink = document.createElement("a");
  dictLink.href = "https://cc-cedict.org/";
  dictLink.target = "_blank";
  dictLink.rel = "noopener noreferrer";
  dictLink.textContent = "CC-CEDICT";
  const license = document.createElement("a");
  license.href = "https://creativecommons.org/licenses/by-sa/4.0/";
  license.target = "_blank";
  license.rel = "noopener noreferrer";
  license.textContent = "CC BY-SA 4.0";
  credit.append(dictLink, document.createTextNode(", "), license);
  popover.append(credit);
  popover.hidden = false;
  lookupAnchor = button;
  if (pin) lookupPinned = true;
  placeLookup();
}

function lookupButton(target) {
  if (!(target instanceof Element)) return null;
  const button = target.closest(".lookup");
  if (!button) return null;
  if (!messages.contains(button) && !practiceStage.contains(button)) return null;
  return button;
}

for (const host of [messages, practiceStage]) {
  host.addEventListener("pointerover", (event) => {
    const button = lookupButton(event.target);
    if (!button || lookupPinned) return;
    showLookup(button, false);
  });

  host.addEventListener("pointerout", (event) => {
    if (lookupPinned) return;
    const button = lookupButton(event.target);
    if (!button) return;
    const next = event.relatedTarget;
    if (next instanceof Node && (button.contains(next) || popover.contains(next)))
      return;
    hideLookup();
  });

  host.addEventListener("click", (event) => {
    const button = lookupButton(event.target);
    if (!button) return;
    event.preventDefault();
    if (lookupPinned && lookupAnchor === button) {
      hideLookup();
      return;
    }
    showLookup(button, true);
  });

  host.addEventListener("scroll", () => {
    if (lookupAnchor) placeLookup();
  });
}

// Looking a word up in a finished sentence must not pull focus off the pinyin input.
practiceStage.addEventListener("mousedown", (event) => {
  if (lookupButton(event.target)) event.preventDefault();
});

popover.addEventListener("pointerout", (event) => {
  if (lookupPinned) return;
  const next = event.relatedTarget;
  if (next instanceof Node && (popover.contains(next) || lookupAnchor?.contains(next)))
    return;
  hideLookup();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideLookup();
});

document.addEventListener("pointerdown", (event) => {
  if (popover.hidden) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (popover.contains(target) || lookupButton(target)) return;
  hideLookup();
});

window.addEventListener("resize", () => {
  if (lookupAnchor) placeLookup();
});

async function loadDictionary() {
  if (!segmentLookup) return;
  try {
    const response = await fetch("/dict.json");
    if (!response.ok) return;
    const readings = await response.json();
    lookup.readings = readings;
    lookup.words = new Set(Object.keys(readings));
    render();
  } catch {
    // The chat works without the popup dictionary.
  }
}

try {
  showDebug.checked = localStorage.getItem("erudify-debug") !== "off";
} catch {
  showDebug.checked = true;
}
showDebug.addEventListener("change", () => {
  try {
    localStorage.setItem("erudify-debug", showDebug.checked ? "on" : "off");
  } catch {
    // The toggle still works for this page.
  }
  renderDebug();
  if (!practicePanel.hidden) renderPractice();
});

learnerInput.value = localStorage.getItem("erudify-learner") || "local";
loadSession();
loadDictionary();
