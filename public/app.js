import { applyToneDigit } from "./pinyin.js";

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

text.addEventListener("keydown", (event) => {
  if (event.isComposing || event.key === "Process") return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (!/^[1-5]$/.test(event.key)) return;
  const start = text.selectionStart;
  const end = text.selectionEnd;
  if (start === null || end === null || start !== end) return;
  const edit = applyToneDigit(text.value, start, Number(event.key));
  if (!edit) return;
  event.preventDefault();
  if (text.value.slice(edit.start, edit.end) !== edit.replacement) {
    text.setRangeText(edit.replacement, edit.start, edit.end, "end");
  }
  text.setSelectionRange(edit.cursor, edit.cursor);
});

document.querySelector("#reset").addEventListener("click", async () => {
  if (!confirm("Clear this learner's messages and schedule?")) return;
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
  if (!button || !messages.contains(button)) return null;
  return button;
}

messages.addEventListener("pointerover", (event) => {
  const button = lookupButton(event.target);
  if (!button || lookupPinned) return;
  showLookup(button, false);
});

messages.addEventListener("pointerout", (event) => {
  if (lookupPinned) return;
  const button = lookupButton(event.target);
  if (!button) return;
  const next = event.relatedTarget;
  if (next instanceof Node && (button.contains(next) || popover.contains(next))) return;
  hideLookup();
});

messages.addEventListener("click", (event) => {
  const button = lookupButton(event.target);
  if (!button) return;
  event.preventDefault();
  if (lookupPinned && lookupAnchor === button) {
    hideLookup();
    return;
  }
  showLookup(button, true);
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

messages.addEventListener("scroll", () => {
  if (lookupAnchor) placeLookup();
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

learnerInput.value = localStorage.getItem("erudify-learner") || "local";
loadSession();
loadDictionary();
