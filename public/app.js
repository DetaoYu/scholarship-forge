const form = document.querySelector("#generatorForm");
const materialText = document.querySelector("#materialText");
const fileInput = document.querySelector("#fileInput");
const fileStatus = document.querySelector("#fileStatus");
const resultText = document.querySelector("#resultText");
const historyList = document.querySelector("#historyList");
const connectionStatus = document.querySelector("#connectionStatus");
const copyButton = document.querySelector("#copyButton");
const downloadTxtButton = document.querySelector("#downloadTxtButton");
const downloadMdButton = document.querySelector("#downloadMdButton");

const visitorId = getVisitorId();
let currentMeta = {
  title: "application-draft",
  documentType: "sop",
  inputSummary: ""
};

loadHistory();

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  setStatus("Extracting");
  fileStatus.textContent = `正在读取 ${file.name}...`;

  try {
    const contentBase64 = await fileToBase64(file);
    const payload = await api("/api/extract", {
      fileName: file.name,
      mediaType: file.type,
      contentBase64
    });

    materialText.value = [materialText.value.trim(), payload.text].filter(Boolean).join("\n\n");
    fileStatus.textContent = `${payload.fileName} 已提取 ${payload.characters.toLocaleString()} 个字符`;
    setStatus("Ready");
  } catch (error) {
    fileStatus.textContent = error.message;
    setStatus("File needs review");
  } finally {
    fileInput.value = "";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = form.querySelector("button[type='submit']");
  submitButton.disabled = true;
  submitButton.textContent = "Generating...";
  setStatus("Writing");

  const data = new FormData(form);
  const documentType = data.get("documentType");

  try {
    const payload = await api("/api/generate", {
      documentType,
      targetSchool: data.get("targetSchool"),
      targetProgram: data.get("targetProgram"),
      applicationStage: data.get("applicationStage"),
      tone: data.get("tone"),
      extraNotes: data.get("extraNotes"),
      materialText: materialText.value
    });

    resultText.value = payload.content;
    currentMeta = {
      title: payload.title,
      documentType,
      inputSummary: payload.inputSummary
    };

    const saved = await api("/api/history", {
      visitorId,
      documentType,
      title: payload.title,
      inputSummary: payload.inputSummary,
      generatedContent: payload.content
    });
    renderHistory(saved.items);
    setStatus("Saved");
  } catch (error) {
    resultText.value = `Unable to generate this draft.\n\n${error.message}`;
    setStatus("Needs attention");
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = '<span class="button-icon">AI</span>Generate Application Draft';
  }
});

copyButton.addEventListener("click", async () => {
  if (!resultText.value.trim()) return;
  await navigator.clipboard.writeText(resultText.value);
  setStatus("Copied");
});

downloadTxtButton.addEventListener("click", () => download("txt"));
downloadMdButton.addEventListener("click", () => download("md"));

async function loadHistory() {
  try {
    const response = await fetch(`/api/history?visitorId=${encodeURIComponent(visitorId)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load history.");
    renderHistory(payload.items || []);
  } catch {
    renderHistory([]);
  }
}

function renderHistory(items) {
  historyList.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "还没有历史记录。生成后这里会保留最近 5 条。";
    historyList.append(empty);
    return;
  }

  for (const item of items) {
    const button = document.createElement("button");
    button.className = "history-item";
    button.type = "button";
    button.innerHTML = `
      <strong>${escapeHtml(item.title || "Application draft")}</strong>
      <small>${escapeHtml(item.inputSummary || "")}</small>
      <small>${formatDate(item.createdAt)}</small>
    `;
    button.addEventListener("click", () => {
      resultText.value = item.generatedContent || "";
      currentMeta = {
        title: item.title || "application-draft",
        documentType: item.documentType || "sop",
        inputSummary: item.inputSummary || ""
      };
      setStatus("Loaded");
    });
    historyList.append(button);
  }
}

async function api(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

function getVisitorId() {
  const key = "scholarship_forge_visitor_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = `visitor_${crypto.randomUUID().replace(/-/g, "")}`;
    localStorage.setItem(key, id);
  }
  return id;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read this file."));
    reader.readAsDataURL(file);
  });
}

function download(ext) {
  if (!resultText.value.trim()) return;
  const blob = new Blob([resultText.value], { type: ext === "md" ? "text/markdown" : "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(currentMeta.title)}.${ext}`;
  link.click();
  URL.revokeObjectURL(url);
}

function setStatus(value) {
  connectionStatus.textContent = value;
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function slugify(value) {
  return String(value || "application-draft")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "application-draft";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}
