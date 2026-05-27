import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, ".data");
const localHistoryFile = path.join(dataDir, "history.json");

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_MATERIAL_CHARS = 42000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/generate") {
      return json(res, 200, await handleGenerate(req));
    }

    if (req.method === "POST" && url.pathname === "/api/extract") {
      return json(res, 200, await handleExtract(req));
    }

    if (req.method === "GET" && url.pathname === "/api/history") {
      return json(res, 200, await handleGetHistory(url));
    }

    if (req.method === "POST" && url.pathname === "/api/history") {
      return json(res, 200, await handleSaveHistory(req));
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    return json(res, 405, { error: "Method not allowed." });
  } catch (error) {
    console.error(error);
    return json(res, 500, {
      error: error instanceof Error ? error.message : "Unexpected server error."
    });
  }
});

server.listen(PORT, () => {
  console.log(`Scholarship Forge is running at http://localhost:${PORT}`);
});

async function handleGenerate(req) {
  const body = await readJson(req);
  const materialText = String(body.materialText || "").trim();
  const documentType = normalizeDocumentType(body.documentType);
  const targetSchool = cleanField(body.targetSchool, 120);
  const targetProgram = cleanField(body.targetProgram, 160);
  const applicationStage = cleanField(body.applicationStage, 80);
  const tone = cleanField(body.tone, 80);
  const extraNotes = cleanField(body.extraNotes, 3000);

  if (!materialText && !extraNotes) {
    throw new Error("Please upload or paste student materials before generating.");
  }

  const compactMaterials = truncate(materialText, MAX_MATERIAL_CHARS);
  const prompt = buildPrompt({
    documentType,
    targetSchool,
    targetProgram,
    applicationStage,
    tone,
    extraNotes,
    materialText: compactMaterials
  });

  const content = await callDashScope(prompt);
  return {
    content,
    title: buildTitle(documentType, targetSchool, targetProgram),
    inputSummary: summarizeInput({ documentType, targetSchool, targetProgram, applicationStage })
  };
}

async function handleExtract(req) {
  const body = await readJson(req, Math.ceil(MAX_UPLOAD_BYTES * 1.45));
  const fileName = String(body.fileName || "materials.txt");
  const mediaType = String(body.mediaType || "");
  const base64 = String(body.contentBase64 || "");

  if (!base64) {
    throw new Error("No file content was received.");
  }

  const buffer = Buffer.from(base64, "base64");
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("File is too large. Please keep uploads under 8 MB.");
  }

  const ext = path.extname(fileName).toLowerCase();
  let text = "";

  if (ext === ".txt" || mediaType.startsWith("text/")) {
    text = buffer.toString("utf8");
  } else if (ext === ".docx") {
    text = extractDocxText(buffer);
  } else if (ext === ".pdf") {
    text = extractPdfText(buffer);
  } else {
    throw new Error("Unsupported file type. Please upload TXT, PDF, or Word DOCX.");
  }

  text = normalizeText(text);
  if (!text) {
    throw new Error("No readable text was found in this file. Try exporting it as text or DOCX.");
  }

  return {
    fileName,
    characters: text.length,
    text: truncate(text, MAX_MATERIAL_CHARS)
  };
}

async function handleGetHistory(url) {
  const visitorId = cleanVisitorId(url.searchParams.get("visitorId"));
  if (!visitorId) {
    throw new Error("Missing visitor id.");
  }

  const rows = await historyList(visitorId);
  return { items: rows.slice(0, 5) };
}

async function handleSaveHistory(req) {
  const body = await readJson(req);
  const item = {
    visitor_id: cleanVisitorId(body.visitorId),
    document_type: normalizeDocumentType(body.documentType),
    title: cleanField(body.title, 180) || "Generated application draft",
    input_summary: cleanField(body.inputSummary, 400),
    generated_content: String(body.generatedContent || "").trim()
  };

  if (!item.visitor_id) {
    throw new Error("Missing visitor id.");
  }
  if (!item.generated_content) {
    throw new Error("Nothing to save.");
  }

  await historyInsert(item);
  const items = await historyList(item.visitor_id);
  return { items: items.slice(0, 5) };
}

async function callDashScope(prompt) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    return demoDraft(prompt);
  }

  const baseUrl = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const model = process.env.DASHSCOPE_MODEL || "qwen-plus";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.58,
      messages: [
        {
          role: "system",
          content:
            "You are a senior university admissions writing advisor. Write polished, specific, ethical English application materials. Do not invent unverifiable achievements. Mark missing details clearly."
        },
        { role: "user", content: prompt }
      ]
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `DashScope request failed with ${response.status}.`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("The AI service returned an empty response.");
  }

  return String(content).trim();
}

function buildPrompt(data) {
  const documentName = {
    sop: "Statement of Purpose",
    ps: "Personal Statement",
    resume: "English Resume/CV"
  }[data.documentType];

  const rules =
    data.documentType === "resume"
      ? "Create an ATS-friendly English resume/CV draft with concise bullet points, action verbs, quantified impact where supported, and sections for Education, Research/Projects, Experience, Skills, Awards, and Additional Information."
      : "Create a compelling English application essay with a clear narrative arc, specific evidence, academic fit, career goals, and a refined but authentic voice. Include a short 'Details to verify or add' section at the end if information is missing.";

  return [
    `Task: Draft a ${documentName} for a university application.`,
    `Target school: ${data.targetSchool || "Not specified"}`,
    `Target program/major: ${data.targetProgram || "Not specified"}`,
    `Application stage: ${data.applicationStage || "Not specified"}`,
    `Preferred tone: ${data.tone || "academic, confident, sincere"}`,
    "",
    "Writing rules:",
    rules,
    "Use English as the output language. The input materials may be in Chinese or English.",
    "Do not fabricate awards, grades, publications, internships, or school names.",
    "If the source material is thin, produce a strong editable draft and label missing facts.",
    "",
    `Additional student notes:\n${data.extraNotes || "None"}`,
    "",
    `Student source materials:\n${data.materialText || "No uploaded material provided."}`
  ].join("\n");
}

function demoDraft(prompt) {
  const kind = prompt.includes("English Resume/CV") ? "resume" : "essay";
  if (kind === "resume") {
    return [
      "# English Resume/CV Draft",
      "",
      "Note: This is a local demo draft because `DASHSCOPE_API_KEY` is not configured on the server.",
      "",
      "## Education",
      "- University / School Name, Degree or Program, Graduation Year",
      "- Relevant coursework: add courses that support the target program.",
      "",
      "## Research and Projects",
      "- Project Title: describe the problem, method, tools, and measurable outcome.",
      "- Emphasize academic fit with the target department.",
      "",
      "## Experience",
      "- Organization, Role: use action verbs and evidence from the student's materials.",
      "",
      "## Skills",
      "- Technical: add software, lab, research, or analytical skills.",
      "- Languages: add verified proficiency.",
      "",
      "## Details to verify or add",
      "- GPA, dates, institution names, awards, publications, and exact project outcomes."
    ].join("\n");
  }

  return [
    "# Application Essay Draft",
    "",
    "Note: This is a local demo draft because `DASHSCOPE_API_KEY` is not configured on the server.",
    "",
    "My academic interests have developed through a combination of sustained curiosity, practical exploration, and the desire to solve meaningful problems. The experiences in my background have helped me understand not only what I want to study, but also why this field matters to the communities and questions I hope to serve.",
    "",
    "In my previous work, I learned to connect classroom knowledge with hands-on investigation. The strongest version of this essay should insert one concrete project, research experience, internship, or leadership example here, explaining the challenge, the student's role, the methods used, and the result.",
    "",
    "I am especially drawn to the target program because of its academic depth, research environment, and fit with my long-term goals. With further detail about the university, this section should connect the student's interests to specific courses, labs, faculty, or institutional strengths.",
    "",
    "Details to verify or add: target school fit, exact program name, one signature academic experience, measurable outcomes, and career plan."
  ].join("\n");
}

async function historyList(visitorId) {
  if (hasSupabase()) {
    const table = encodeURIComponent(process.env.SUPABASE_TABLE || "student_generations");
    const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?visitor_id=eq.${encodeURIComponent(visitorId)}&select=id,document_type,title,input_summary,generated_content,created_at&order=created_at.desc&limit=5`;
    const response = await supabaseFetch(url, { method: "GET" });
    return normalizeHistoryRows(await response.json());
  }

  const store = await readLocalHistory();
  return normalizeHistoryRows((store[visitorId] || []).sort((a, b) => b.created_at.localeCompare(a.created_at))).slice(0, 5);
}

async function historyInsert(item) {
  const row = {
    ...item,
    created_at: new Date().toISOString()
  };

  if (hasSupabase()) {
    const table = encodeURIComponent(process.env.SUPABASE_TABLE || "student_generations");
    await supabaseFetch(`${process.env.SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(row)
    });

    const latest = await historyList(item.visitor_id);
    if (latest.length >= 5) {
      const keepIds = new Set(latest.map((entry) => entry.id).filter(Boolean));
      const oldRows = await supabaseFetch(
        `${process.env.SUPABASE_URL}/rest/v1/${table}?visitor_id=eq.${encodeURIComponent(item.visitor_id)}&select=id&order=created_at.desc&offset=5`,
        { method: "GET" }
      ).then((r) => r.json());
      const idsToDelete = oldRows.map((entry) => entry.id).filter((id) => id && !keepIds.has(id));
      if (idsToDelete.length) {
        await supabaseFetch(
          `${process.env.SUPABASE_URL}/rest/v1/${table}?id=in.(${idsToDelete.join(",")})`,
          { method: "DELETE", headers: { prefer: "return=minimal" } }
        );
      }
    }
    return;
  }

  const store = await readLocalHistory();
  const rows = store[item.visitor_id] || [];
  rows.unshift({ id: randomUUID(), ...row });
  store[item.visitor_id] = rows.slice(0, 5);
  await mkdir(dataDir, { recursive: true });
  await writeFile(localHistoryFile, JSON.stringify(store, null, 2), "utf8");
}

async function supabaseFetch(url, options) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase request failed: ${text || response.status}`);
  }

  return response;
}

async function readLocalHistory() {
  if (!existsSync(localHistoryFile)) {
    return {};
  }
  return JSON.parse(await readFile(localHistoryFile, "utf8"));
}

function hasSupabase() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function normalizeHistoryRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    documentType: row.document_type,
    title: row.title,
    inputSummary: row.input_summary,
    generatedContent: row.generated_content,
    createdAt: row.created_at
  }));
}

function extractDocxText(buffer) {
  const files = unzipFiles(buffer);
  const documentXml = files.get("word/document.xml");
  if (!documentXml) {
    throw new Error("This DOCX does not contain a readable document body.");
  }

  return documentXml
    .toString("utf8")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function unzipFiles(buffer) {
  const files = new Map();
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Invalid DOCX archive.");
  }

  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let cursor = centralDirOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const compression = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const fileName = buffer.slice(cursor + 46, cursor + 46 + fileNameLength).toString("utf8");

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);

    if (compression === 0) {
      files.set(fileName, compressed);
    } else if (compression === 8) {
      files.set(fileName, zlib.inflateRawSync(compressed));
    }

    cursor += 46 + fileNameLength + extraLength + commentLength;
  }

  return files;
}

function extractPdfText(buffer) {
  const raw = buffer.toString("latin1");
  const chunks = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = streamRegex.exec(raw))) {
    const before = raw.slice(Math.max(0, match.index - 220), match.index);
    const streamBuffer = Buffer.from(match[1], "latin1");
    if (/\/FlateDecode/.test(before)) {
      try {
        chunks.push(zlib.inflateSync(streamBuffer).toString("latin1"));
      } catch {
        chunks.push(match[1]);
      }
    } else {
      chunks.push(match[1]);
    }
  }

  const source = chunks.length ? chunks.join("\n") : raw;
  const textRuns = [];
  const literalRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
  while ((match = literalRegex.exec(source))) {
    textRuns.push(unescapePdfString(match[1]));
  }

  const arrayRegex = /\[((?:\s*\([^()\\]*(?:\\.[^()\\]*)*\)\s*-?\d*)+)\]\s*TJ/g;
  while ((match = arrayRegex.exec(source))) {
    const inner = match[1];
    const pieces = [];
    let part;
    const partRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
    while ((part = partRegex.exec(inner))) {
      pieces.push(unescapePdfString(part[1]));
    }
    textRuns.push(pieces.join(""));
  }

  return textRuns.join("\n");
}

function unescapePdfString(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

async function serveStatic(urlPath, res) {
  const safePath = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    return json(res, 403, { error: "Forbidden." });
  }

  try {
    const file = await readFile(filePath);
    const type = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(file);
  } catch {
    const fallback = await readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(fallback);
  }
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new Error("Request payload is too large.");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function normalizeDocumentType(value) {
  const type = String(value || "sop").toLowerCase();
  if (["sop", "ps", "resume"].includes(type)) return type;
  return "sop";
}

function cleanVisitorId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{12,80}$/.test(id) ? id : "";
}

function cleanField(value, maxLength) {
  return truncate(String(value || "").trim(), maxLength);
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n[Truncated for length]` : value;
}

function normalizeText(value) {
  return value.replace(/\r/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function buildTitle(type, school, program) {
  const label = { sop: "SOP", ps: "Personal Statement", resume: "Resume/CV" }[type];
  return [label, school, program].filter(Boolean).join(" - ");
}

function summarizeInput({ documentType, targetSchool, targetProgram, applicationStage }) {
  return [
    `Type: ${documentType.toUpperCase()}`,
    targetSchool ? `School: ${targetSchool}` : "",
    targetProgram ? `Program: ${targetProgram}` : "",
    applicationStage ? `Stage: ${applicationStage}` : ""
  ]
    .filter(Boolean)
    .join(" | ");
}

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  const env = readFileSync(envPath, "utf8");
  for (const line of env.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) {
      process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
    }
  }
}
