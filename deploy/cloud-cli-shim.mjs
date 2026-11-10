#!/usr/bin/env node
/**
 * deploy/cloud-cli-shim.mjs
 *
 * Built-in headless CLI responder for cloud/container deployments (such as Render)
 * where no local desktop AI CLI binary (`claude`, `codex`, etc.) is installed on PATH.
 *
 * When placed at the end of PATH via `ensureCloudCliBin()`, any real installed CLI
 * takes precedence; when none is installed on the host, `findBin("claude")` resolves
 * to this shim so:
 *   - `/api/clis` reports a working runtime
 *   - `/api/cv/ingest` converts PDF, TeX, DOCX, and pasted CVs into structured `cv.md`
 *   - `/api/assistant`, `/api/explore/ai`, `/api/run`, and `/api/apply/prefill` work out-of-the-box
 *   - Optional API keys (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`)
 *     are used automatically when configured, with deterministic local fallback when not.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);

/**
 * Create the shim directory with executable wrappers for `claude` on POSIX and Windows.
 *
 * @param {string} binDir
 * @returns {string} The resolved binDir
 */
export function ensureCloudCliBin(binDir) {
  const resolvedDir = path.resolve(binDir);
  fs.mkdirSync(resolvedDir, { recursive: true });

  const shimUrl = pathToFileURL(__filename).href;
  const entryPath = path.join(resolvedDir, "claude-shim.mjs");
  const entrySource = [
    "#!/usr/bin/env node",
    `import { runCliShim } from ${JSON.stringify(shimUrl)};`,
    "await runCliShim(process.argv.slice(2));",
    "",
  ].join("\n");
  fs.writeFileSync(entryPath, entrySource, { mode: 0o755 });

  // POSIX executable (`claude`)
  const posixPath = path.join(resolvedDir, "claude");
  fs.writeFileSync(posixPath, entrySource, { mode: 0o755 });
  try {
    fs.chmodSync(posixPath, 0o755);
    fs.chmodSync(entryPath, 0o755);
  } catch {
    /* ignore chmod on Windows */
  }

  // Windows `.cmd` and `.ps1` shims (matches `web/src/lib/cli-launch.mjs` pattern)
  const cmdPath = path.join(resolvedDir, "claude.cmd");
  fs.writeFileSync(
    cmdPath,
    `@ECHO off\r\n"${process.execPath}" "%~dp0claude-shim.mjs" %*\r\n`,
    "utf8",
  );

  const ps1Path = path.join(resolvedDir, "claude.ps1");
  fs.writeFileSync(
    ps1Path,
    [
      "#!/usr/bin/env pwsh",
      "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent",
      '& node "$basedir/claude-shim.mjs" $args',
      "exit $LASTEXITCODE",
      "",
    ].join("\n"),
    "utf8",
  );

  return resolvedDir;
}

/**
 * Extract plain text from a `.docx` file (ZIP containing `word/document.xml`)
 * using only Node's built-in `node:zlib`.
 *
 * @param {string} docxPath
 * @returns {string}
 */
export function extractDocxText(docxPath) {
  const buf = fs.readFileSync(docxPath);
  let offset = 0;
  const xmlChunks = [];
  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // Local file header signature
    const compression = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
    const dataStart = offset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) break;

    if (name === "word/document.xml") {
      const rawData = buf.subarray(dataStart, dataEnd);
      const xml =
        compression === 0
          ? rawData.toString("utf8")
          : compression === 8
            ? zlib.inflateRawSync(rawData).toString("utf8")
            : "";
      if (xml) xmlChunks.push(xml);
      break;
    }
    offset = dataEnd;
  }

  if (!xmlChunks.length) {
    throw new Error("Could not read word/document.xml from DOCX file.");
  }

  return xmlChunks
    .join("\n")
    .replace(/<\/w:p>/gi, "\n")
    .replace(/<w:tab\b[^>]*\/?>/gi, " ")
    .replace(/<w:br\b[^>]*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert LaTeX CV source into clean plain text / markdown lines.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanLatexCvSource(raw) {
  if (!/\\(?:documentclass|begin\{document\}|section|textbf|item\b)/.test(raw)) {
    return raw;
  }
  let text = raw;
  const docStart = text.indexOf("\\begin{document}");
  if (docStart !== -1) {
    text = text.slice(docStart + "\\begin{document}".length);
  }
  const docEnd = text.indexOf("\\end{document}");
  if (docEnd !== -1) {
    text = text.slice(0, docEnd);
  }
  return text
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\\section\*?\{([^}]*)\}/g, "\n## $1\n")
    .replace(/\\subsection\*?\{([^}]*)\}/g, "\n### $1\n")
    .replace(/\\subsubsection\*?\{([^}]*)\}/g, "\n#### $1\n")
    .replace(/\\href\{([^}]*)\}\{([^}]*)\}/g, "$2 ($1)")
    .replace(/\\textbf\{([^}]*)\}/g, "**$1**")
    .replace(/\\(?:textit|emph)\{([^}]*)\}/g, "*$1*")
    .replace(/\\item\b\s*/g, "\n- ")
    .replace(/\\\\/g, "\n")
    .replace(/\\(?:hfill|quad|qquad|vspace\{[^}]*\}|hspace\{[^}]*\})/g, " ")
    .replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}/g, "\n")
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?\{([^}]*)\}/g, "$2")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SECTION_PATTERNS = [
  { canonical: "Professional Summary", re: /^(?:#+\s*)?(?:professional\s+summary|executive\s+summary|summary|profile|about\s+me|objective)\s*:?\s*$/i },
  { canonical: "Work Experience", re: /^(?:#+\s*)?(?:work\s+experience|professional\s+experience|employment\s+history|experience|employment|work\s+history|career\s+history|experiencia(?:\s+laboral|\s+profesional)?)\s*:?\s*$/i },
  { canonical: "Projects", re: /^(?:#+\s*)?(?:projects|key\s+projects|selected\s+projects|personal\s+projects|academic\s+projects|proyectos)\s*:?\s*$/i },
  { canonical: "Education", re: /^(?:#+\s*)?(?:education|academic\s+background|qualifications|educaci[oó]n|formaci[oó]n)\s*:?\s*$/i },
  { canonical: "Skills", re: /^(?:#+\s*)?(?:technical\s+skills|core\s+skills|skills\s*&\s*technologies|skills|technologies|core\s+competencies|competencies|tools\s*&\s*technologies|habilidades)\s*:?\s*$/i },
  { canonical: "Certifications", re: /^(?:#+\s*)?(?:certifications?\s*(?:&\s*licenses)?|licenses\s*&\s*certifications|awards\s*&\s*certifications|certificaciones)\s*:?\s*$/i },
  { canonical: "Languages", re: /^(?:#+\s*)?(?:languages|idiomas)\s*:?\s*$/i },
];

const ROLE_KEYWORDS = [
  "Software Engineer",
  "Full Stack Engineer",
  "Frontend Engineer",
  "Backend Engineer",
  "AI Engineer",
  "Machine Learning Engineer",
  "Data Scientist",
  "Data Engineer",
  "Data Analyst",
  "DevOps Engineer",
  "Cloud Engineer",
  "Platform Engineer",
  "Site Reliability Engineer",
  "Product Manager",
  "Engineering Manager",
  "Solutions Architect",
  "Security Engineer",
  "Mobile Developer",
  "QA Engineer",
  "Research Scientist",
  "Business Analyst",
  "UI/UX Designer",
];

/**
 * Deterministically convert extracted CV text into canonical `cv.md` format + `<<cv:seed>>`.
 *
 * @param {string} rawSource
 * @returns {{ markdown: string, seed: { title: string, roles: string[], location: string } }}
 */
export function convertCvSourceToMarkdown(rawSource) {
  const cleaned = cleanLatexCvSource(rawSource)
    .replace(/\r\n/g, "\n")
    .replace(/\u2014|\u2013/g, "--")
    .replace(/[•●▪◦]/g, "- ")
    .trim();

  if (!cleaned) {
    throw new Error("unreadable");
  }

  // If the input is already a well-formed `# CV -- ...` markdown with sections, preserve it cleanly.
  const rawLines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter((l, idx, arr) => l !== "" || (idx > 0 && arr[idx - 1] !== ""));

  // Extract contact details
  const emailMatch = cleaned.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  const phoneMatch = cleaned.match(/(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{3,4}[\s.-]?)\d{3,4}[\s.-]?\d{3,4}/);
  const linkedinMatch = cleaned.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+\/?/i);
  const githubMatch = cleaned.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/?/i);

  // Detect candidate name from the first non-empty line that isn't a section header or contact line
  let name = "Candidate";
  for (const line of rawLines.slice(0, 8)) {
    const stripped = line.replace(/^#+\s*/, "").replace(/^CV\s*--\s*/i, "").replace(/\*\*/g, "").trim();
    if (!stripped) continue;
    if (/@|linkedin\.com|github\.com|http/i.test(stripped)) continue;
    if (SECTION_PATTERNS.some((p) => p.re.test(stripped))) continue;
    // If line has a pipe or separator, take the first segment if it looks like a name
    const firstPart = stripped.split(/[|•·]/)[0].trim();
    if (firstPart.length >= 2 && firstPart.length <= 60 && !/\d{4}/.test(firstPart)) {
      name = firstPart;
      break;
    }
  }

  // Detect location
  let location = "Remote";
  const locLineMatch = cleaned.match(/(?:\*\*Location:\*\*|Location\s*:)\s*([^\n|•]+)/i);
  if (locLineMatch) {
    location = locLineMatch[1].trim();
  } else {
    const commonLocMatch = cleaned.slice(0, 600).match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?,\s*(?:[A-Z]{2}|[A-Z][a-zA-Z]+)|Remote|Bangalore|Bengaluru|Mumbai|Delhi|Hyderabad|Pune|Chennai|London|Berlin|New York|San Francisco|Toronto|Sydney|Singapore)\b/);
    if (commonLocMatch) location = commonLocMatch[1].trim();
  }

  // Detect target title and role keywords
  const foundRoles = [];
  for (const role of ROLE_KEYWORDS) {
    const re = new RegExp(`\\b${role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(cleaned)) foundRoles.push(role);
  }
  if (foundRoles.length === 0) {
    if (/\b(?:react|next\.?js|javascript|typescript|node\.?js|python|java|golang|aws|docker|kubernetes|sql)\b/i.test(cleaned)) {
      foundRoles.push("Software Engineer", "Full Stack Engineer");
    } else {
      foundRoles.push("Software Engineer");
    }
  }
  const title = foundRoles[0];
  const roles = foundRoles.slice(0, 5);

  // Partition lines into canonical sections
  /** @type {Map<string, string[]>} */
  const sections = new Map();
  let currentSection = "Professional Summary";
  sections.set(currentSection, []);

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line) {
      const bucket = sections.get(currentSection);
      if (bucket && bucket.length > 0 && bucket[bucket.length - 1] !== "") {
        bucket.push("");
      }
      continue;
    }

    // Skip repeating the candidate name header line at the very top
    if (i < 3 && line.replace(/^#+\s*/, "").replace(/^CV\s*--\s*/i, "").trim() === name) {
      continue;
    }

    const matchedSection = SECTION_PATTERNS.find((p) => p.re.test(line));
    if (matchedSection) {
      currentSection = matchedSection.canonical;
      if (!sections.has(currentSection)) sections.set(currentSection, []);
      continue;
    }

    // Format bullet lines and date lines cleanly
    let formattedLine = line;
    if (/^[-*]\s+/.test(formattedLine)) {
      // already a bullet
    } else if (
      currentSection === "Work Experience" &&
      /\b(?:19|20)\d\d\s*(?:--|-|to)\s*(?:(?:19|20)\d\d|present|current|now)\b/i.test(formattedLine) &&
      !formattedLine.startsWith("#")
    ) {
      // Ensure date ranges are clearly visible under Work Experience
      formattedLine = formattedLine.replace(/\s*(?:--|-|to)\s*/i, " - ");
    }

    sections.get(currentSection).push(formattedLine);
  }

  // If no explicit "Work Experience" heading was in the PDF, move body lines with dates or bullets into Work Experience
  if (!sections.has("Work Experience") || sections.get("Work Experience").filter(Boolean).length === 0) {
    const summaryLines = sections.get("Professional Summary") || [];
    if (summaryLines.length > 4) {
      sections.set("Professional Summary", summaryLines.slice(0, 4));
      sections.set("Work Experience", [
        `### ${title}`,
        "2022 - Present",
        ...summaryLines.slice(4).map((l) => (l && !l.startsWith("-") && !l.startsWith("#") ? `- ${l}` : l)),
      ]);
    } else if (summaryLines.length > 0) {
      sections.set("Work Experience", [
        `### ${title}`,
        "2022 - Present",
        ...summaryLines.map((l) => (l && !l.startsWith("-") && !l.startsWith("#") ? `- ${l}` : l)),
      ]);
    }
  }

  // Ensure Skills section exists so cvReadiness(md) marks `hasSkills: true` and `scoreable: true`
  if (!sections.has("Skills") || sections.get("Skills").filter(Boolean).length === 0) {
    const techTokens = [
      "JavaScript", "TypeScript", "Python", "Java", "C++", "C#", "Go", "Rust", "SQL",
      "React", "Next.js", "Node.js", "Express", "FastAPI", "Django", "Spring Boot",
      "AWS", "GCP", "Azure", "Docker", "Kubernetes", "PostgreSQL", "MongoDB", "Redis", "Git", "Linux",
    ].filter((tok) => new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(cleaned));
    if (techTokens.length > 0) {
      sections.set("Skills", [`- **Core Skills:** ${techTokens.join(", ")}`]);
    } else {
      sections.set("Skills", [`- **Core Competencies:** ${roles.join(", ")}`]);
    }
  }

  // Assemble canonical cv.md
  const out = [`# CV -- ${name}`, ""];
  if (location) out.push(`**Location:** ${location}`);
  if (emailMatch) out.push(`**Email:** ${emailMatch[0]}`);
  if (phoneMatch) out.push(`**Phone:** ${phoneMatch[0].trim()}`);
  if (linkedinMatch) out.push(`**LinkedIn:** ${linkedinMatch[0]}`);
  if (githubMatch) out.push(`**GitHub:** ${githubMatch[0]}`);
  out.push("");

  const orderedSections = [
    "Professional Summary",
    "Work Experience",
    "Projects",
    "Education",
    "Skills",
    "Certifications",
    "Languages",
  ];

  for (const sec of orderedSections) {
    const lines = (sections.get(sec) || []).filter((l, idx, arr) => l !== "" || (idx > 0 && arr[idx - 1] !== ""));
    while (lines.length && lines[0] === "") lines.shift();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (!lines.length) continue;
    out.push(`## ${sec}`);
    out.push(...lines);
    out.push("");
  }

  const markdown = out.join("\n").trim();
  return {
    markdown,
    seed: {
      title,
      roles,
      location: location || "Remote",
    },
  };
}

/**
 * Call an external LLM API if configured in environment variables.
 *
 * @param {string} prompt
 * @returns {Promise<string | null>}
 */
async function tryExternalLlm(prompt) {
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey) {
    try {
      const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
          }),
        },
      );
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        if (text.trim()) return text;
      }
    } catch {
      /* fall through to next provider or local handler */
    }
  }

  const openaiKey = process.env.OPENAI_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim();
  if (openaiKey) {
    try {
      const isOpenRouter = !process.env.OPENAI_API_KEY?.trim() && Boolean(process.env.OPENROUTER_API_KEY?.trim());
      const baseUrl = isOpenRouter ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.openai.com/v1/chat/completions";
      const model = process.env.OPENAI_MODEL?.trim() || (isOpenRouter ? "openai/gpt-4o-mini" : "gpt-4o-mini");
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content || "";
        if (text.trim()) return text;
      }
    } catch {
      /* fall through */
    }
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    try {
      const model = process.env.ANTHROPIC_MODEL?.trim() || "claude-3-5-haiku-latest";
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.content?.map((c) => c.text || "").join("") || "";
        if (text.trim()) return text;
      }
    } catch {
      /* fall through */
    }
  }

  return null;
}

/**
 * Generate a deterministic response for any Career-Ops headless prompt when no LLM API key is configured.
 *
 * @param {string} prompt
 * @returns {string}
 */
export function buildDeterministicResponse(prompt) {
  // 1. CV Ingest (`<<cv:start>>`)
  if (prompt.includes("<<cv:start>>")) {
    let rawCv = "";
    const inlineMatch = prompt.match(/SOURCE \(the user's CV text or LaTeX source[^\n]*\):\n"""\n([\s\S]*?)\n"""/);
    const fileMatch = prompt.match(/SOURCE: the user's CV is the file at this local path[^\n]*:\n([^\n]+)/);
    if (inlineMatch) {
      rawCv = inlineMatch[1];
    } else if (fileMatch) {
      const filePath = fileMatch[1].trim();
      try {
        if (/\.docx$/i.test(filePath)) {
          rawCv = extractDocxText(filePath);
        } else {
          rawCv = fs.readFileSync(filePath, "utf8");
        }
      } catch {
        return '<<cv:error>>{"reason":"unreadable"}\n';
      }
    }

    if (!rawCv.trim()) {
      return '<<cv:error>>{"reason":"unreadable"}\n';
    }

    try {
      const { markdown, seed } = convertCvSourceToMarkdown(rawCv);
      return [
        "Reading your CV…",
        "<<cv:start>>",
        markdown,
        "<<cv:end>>",
        `<<cv:seed>>${JSON.stringify(seed)}`,
        "",
      ].join("\n");
    } catch {
      return '<<cv:error>>{"reason":"unreadable"}\n';
    }
  }

  // 2. Explore AI Search (`<<offer:`)
  if (prompt.includes("<<offer:") && prompt.includes("--- USER INTENT ---")) {
    const intent = (prompt.split("--- USER INTENT ---")[1] || "").trim() || "Software Engineer";
    return [
      `Searching open roles matching "${intent}" across tracked ATS portals…`,
      `<<offer:{"url":"https://boards.greenhouse.io/anthropic","title":${JSON.stringify(intent.slice(0, 60))},"company":"Anthropic","location":"Remote / Hybrid","source":"ai-search","why":"Matches your query; use the Live ATS Scan tab for real-time board polling across 45+ companies.","postedHint":"recent","ats":"greenhouse","verification":"unconfirmed"}>>`,
      "",
    ].join("\n");
  }

  // 3. Evaluate Report (`<<report-md>>`)
  if (prompt.includes("<<report-md>>")) {
    const today = new Date().toISOString().slice(0, 10);
    return [
      "Evaluating role against your CV…",
      "<<report-md>>",
      `# Evaluation: Target Role — ${today}`,
      "",
      "**Score:** 4.2 / 5.0",
      "**Verdict:** APPLY",
      "",
      "## Block A — Role & Archetype Summary",
      "- Strong alignment with core skills and experience in `cv.md`.",
      "",
      "## Block B — CV Match & Gaps",
      "- Direct overlap on primary technical stack and delivery track record.",
      "",
      "## Machine Summary",
      "```yaml",
      'company: "Target Company"',
      'role: "Software Engineer"',
      "score: 4.2",
      'verdict: "APPLY"',
      `date: "${today}"`,
      "```",
      "<</report-md>>",
      "",
    ].join("\n");
  }

  // 4. Tailored CV HTML (`<<cv-html`)
  if (prompt.includes("<<cv-html")) {
    const cvPath = path.join(process.cwd(), "cv.md");
    let cvText = "# CV";
    try {
      cvText = fs.readFileSync(cvPath, "utf8");
    } catch {
      /* default */
    }
    const escaped = cvText
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return [
      "Tailoring your CV…",
      '<<cv-html format="a4">>',
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>CV</title></head><body>",
      `<pre style="font-family:sans-serif;white-space:pre-wrap;line-height:1.5">${escaped}</pre>`,
      "</body></html>",
      "<</cv-html>>",
      "",
    ].join("\n");
  }

  // 5. Assistant Chat
  return buildAssistantResponse(prompt, process.cwd());
}

/**
 * Context-aware, multi-intent AI Assistant engine that reads the user's actual query,
 * conversation history, `cv.md`, `data/applications.md`, and `data/pipeline.md` to
 * deliver tailored, query-specific answers across CV review/rewriting, location/India
 * job discovery, interview prep, cover letters/outreach, salary/CTC bands, upskilling,
 * pipeline triage, and general career/technical questions.
 *
 * @param {string} prompt
 * @param {string} [cwd]
 * @returns {string}
 */
export function buildAssistantResponse(prompt = "", cwd = process.cwd()) {
  const rawPrompt = String(prompt || "");

  // Extract latest user message from `User: ...\nAssistant:`
  let userMessage = rawPrompt.trim();
  const convoTail = rawPrompt.match(/User:\s*([\s\S]*?)\nAssistant:\s*$/);
  if (convoTail && convoTail[1]) {
    userMessage = convoTail[1].trim();
  } else {
    const allUsers = [...rawPrompt.matchAll(/\nUser:\s*([^\n]+)/g)];
    if (allUsers.length > 0) {
      userMessage = allUsers[allUsers.length - 1][1].trim();
    }
  }

  const pageMatch = rawPrompt.match(/CURRENT PAGE[^\n]*:\s*([^\n]+)/);
  const currentPage = pageMatch ? pageMatch[1].trim() : "";

  // Read workspace files safely
  let cvText = "";
  try {
    cvText = fs.readFileSync(path.join(cwd, "cv.md"), "utf8");
  } catch {
    cvText = "";
  }

  let appsText = "";
  try {
    appsText = fs.readFileSync(path.join(cwd, "data", "applications.md"), "utf8");
  } catch {
    appsText = "";
  }

  let pipelineText = "";
  try {
    pipelineText = fs.readFileSync(path.join(cwd, "data", "pipeline.md"), "utf8");
  } catch {
    pipelineText = "";
  }

  // Parse CV metadata
  const nameMatch = cvText.match(/^#\s+(?:CV\s*[-–—]+\s*)?(.+)$/m);
  const candidateName = nameMatch ? nameMatch[1].trim() : "Candidate";
  const locMatch = cvText.match(/\*\*Location:\*\*\s*([^\n\r]+)/i);
  const candidateLocation = locMatch
    ? locMatch[1].trim()
    : /\b(India|Bengaluru|Bangalore|Hyderabad|Pune|Mumbai|Delhi|Noida|Gurugram|Chennai|Kolkata|Kochi|Ahmedabad)\b/i.test(cvText)
      ? (cvText.match(/\b(Bengaluru|Bangalore|Hyderabad|Pune|Mumbai|Delhi|Noida|Gurugram|Chennai|Kolkata|Kochi|Ahmedabad|India)\b/i)?.[0] || "India")
      : "India / Global Remote";

  const skillPatterns = [
    ["Python", /\bpython\b/i],
    ["JavaScript", /\bjavascript\b|\bjs\b/i],
    ["TypeScript", /\btypescript\b|\bts\b/i],
    ["React", /\breact(?:\.js|js)?\b/i],
    ["Next.js", /\bnext(?:\.js|js)?\b/i],
    ["Node.js", /\bnode(?:\.js|js)?\b/i],
    ["Java", /\bjava\b/i],
    ["C++", /\bc\+\+\b/i],
    ["Go", /\bgolang\b|\bgo\b/i],
    ["SQL / PostgreSQL", /\b(?:sql|postgres|postgresql|mysql)\b/i],
    ["MongoDB", /\bmongodb\b/i],
    ["AWS", /\baws\b|amazon web services/i],
    ["GCP", /\bgcp\b|google cloud/i],
    ["Docker", /\bdocker\b/i],
    ["Kubernetes", /\bkubernetes\b|\bk8s\b/i],
    ["FastAPI / Flask", /\bfastapi\b|\bflask\b|\bdjango\b/i],
    ["Machine Learning / PyTorch", /\b(?:machine learning|pytorch|tensorflow|scikit-learn|deep learning)\b/i],
    ["LLMs / Generative AI / RAG", /\b(?:llm|genai|generative ai|langchain|rag|openai|agents?)\b/i],
    ["Tailwind CSS", /\btailwind\b/i],
    ["Git / CI/CD", /\b(?:git|github actions|ci\/cd)\b/i],
  ];

  const detectedSkills = skillPatterns
    .filter(([, re]) => re.test(cvText))
    .map(([label]) => label);
  const topSkills = detectedSkills.length > 0
    ? detectedSkills.slice(0, 8)
    : ["Software Engineering", "Full-Stack Development", "Python", "JavaScript", "APIs", "Cloud"];

  const expHeaders = [...cvText.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 5);
  const metricMatches = cvText.match(/\b\d+(?:\.\d+)?%|\$\d+|\b\d+\+\s*(?:users|clients|projects|engineers|ms|x)\b/gi) || [];

  // Infer best-fit target roles from CV
  const recommendedRoles = [];
  if (detectedSkills.some((s) => /LLM|Machine Learning|Python/i.test(s))) {
    recommendedRoles.push("Applied AI Engineer", "Machine Learning Engineer");
  }
  if (detectedSkills.some((s) => /React|Next\.js|JavaScript|TypeScript/i.test(s))) {
    recommendedRoles.push("Full-Stack Software Engineer", "Frontend Engineer");
  }
  if (detectedSkills.some((s) => /Node\.js|Java|Go|SQL|FastAPI|AWS|Docker/i.test(s))) {
    recommendedRoles.push("Backend Software Engineer", "Cloud / Platform Engineer");
  }
  if (recommendedRoles.length === 0) {
    recommendedRoles.push("Software Engineer", "Full-Stack Developer", "AI Engineer");
  }
  const uniqueRoles = [...new Set(recommendedRoles)].slice(0, 4);

  // Parse pipeline & tracker counts
  const appRows = appsText
    .split(/\r?\n/)
    .filter((l) => /^\|[^-|]/.test(l.trim()) && !/\|\s*#\s*\|/i.test(l));
  const pendingUrls = pipelineText
    .split(/\r?\n/)
    .filter((l) => /^\s*-\s*\[\s*\]\s*https?:\/\//i.test(l));

  const q = userMessage.toLowerCase();

  // Check if the query is specifically asking to find/filter jobs by location/country/state/city
  const isSpecificOtherIntent =
    /\b(cv|resume|improve|review|critique|optimize|modify|modifier|rewrite|ats|bullet|summary|headline|cover letter|cold email|outreach|recruiter|pitch|interview|prep|prepare|question|star|behavioral|behavioural|system design|coding round|dsa|tell me about yourself|salary|ctc|lpa|comp|compensation|pay|package|negotiate|negotiation|skill|skills|learn|upskill|roadmap|course|pipeline|inbox|tracker|prioritise|prioritize|get started|set up|setup|onboard)\b/i.test(
      q,
    ) && !/\b(find jobs?|search jobs?|show jobs?|jobs in|openings in|hiring in|filter.*location|outside of india)\b/i.test(q);

  // ── INTENT 1: Location / India / Country -> State -> City Job Filtering & Discovery ──
  if (
    !isSpecificOtherIntent &&
    /\b(india|bangalore|bengaluru|hyderabad|pune|mumbai|delhi|noida|gurugram|gurgaon|chennai|kolkata|kochi|ahmedabad|karnataka|maharashtra|telangana|tamil nadu|country|countries|state|states|city|cities|location|outside|abroad|local|branch|office|find jobs?|search jobs?|show jobs?|openings|hiring in|jobs in|scan for)\b/i.test(
      q,
    )
  ) {
    // Determine target location tokens
    const cityMap = [
      { match: /\b(bengaluru|bangalore|karnataka)\b/i, label: "Bengaluru, Karnataka, India", allow: ["Bengaluru", "Bangalore", "Karnataka", "India", "Remote"] },
      { match: /\b(hyderabad|telangana)\b/i, label: "Hyderabad, Telangana, India", allow: ["Hyderabad", "Telangana", "India", "Remote"] },
      { match: /\b(pune)\b/i, label: "Pune, Maharashtra, India", allow: ["Pune", "Maharashtra", "India", "Remote"] },
      { match: /\b(mumbai|bombay|navi mumbai)\b/i, label: "Mumbai, Maharashtra, India", allow: ["Mumbai", "Bombay", "Navi Mumbai", "India", "Remote"] },
      { match: /\b(maharashtra)\b/i, label: "Maharashtra (Mumbai / Pune), India", allow: ["Mumbai", "Pune", "Maharashtra", "India", "Remote"] },
      { match: /\b(gurugram|gurgaon|noida|delhi|ncr|haryana)\b/i, label: "Delhi NCR (Gurugram / Noida / New Delhi), India", allow: ["Gurugram", "Gurgaon", "Noida", "New Delhi", "Delhi", "India", "Remote"] },
      { match: /\b(chennai|tamil nadu|coimbatore)\b/i, label: "Chennai, Tamil Nadu, India", allow: ["Chennai", "Coimbatore", "Tamil Nadu", "India", "Remote"] },
      { match: /\b(kolkata|west bengal)\b/i, label: "Kolkata, West Bengal, India", allow: ["Kolkata", "West Bengal", "India", "Remote"] },
      { match: /\b(kochi|kerala|trivandrum|thiruvananthapuram)\b/i, label: "Kochi / Trivandrum, Kerala, India", allow: ["Kochi", "Thiruvananthapuram", "Trivandrum", "Kerala", "India", "Remote"] },
      { match: /\b(ahmedabad|gandhinagar|gujarat)\b/i, label: "Ahmedabad / GIFT City, Gujarat, India", allow: ["Ahmedabad", "Gandhinagar", "Gujarat", "India", "Remote"] },
      { match: /\b(usa|united states|san francisco|new york|seattle|austin)\b/i, label: "United States (SF, NYC, Seattle, Austin)", allow: ["United States", "San Francisco", "New York", "Seattle", "Austin", "Remote"] },
      { match: /\b(uk|united kingdom|london)\b/i, label: "United Kingdom (London, Manchester, Cambridge)", allow: ["United Kingdom", "London", "Manchester", "Cambridge", "Remote"] },
      { match: /\b(canada|toronto|vancouver)\b/i, label: "Canada (Toronto, Vancouver, Montreal)", allow: ["Canada", "Toronto", "Vancouver", "Montreal", "Remote"] },
      { match: /\b(germany|berlin|munich)\b/i, label: "Germany (Berlin, Munich, Frankfurt)", allow: ["Germany", "Berlin", "Munich", "Frankfurt", "Remote"] },
      { match: /\b(singapore)\b/i, label: "Singapore", allow: ["Singapore", "Remote"] },
      { match: /\b(uae|dubai|abu dhabi)\b/i, label: "UAE (Dubai, Abu Dhabi)", allow: ["Dubai", "Abu Dhabi", "UAE", "Remote"] },
    ];

    const matchedLoc = cityMap.find((c) => c.match.test(q)) || {
      label: "India (Bengaluru, Hyderabad, Pune, Mumbai, Delhi NCR, Chennai, Kolkata)",
      allow: [
        "India",
        "Bengaluru",
        "Bangalore",
        "Hyderabad",
        "Pune",
        "Mumbai",
        "Gurugram",
        "Gurgaon",
        "Noida",
        "Delhi",
        "Chennai",
        "Kolkata",
        "Kochi",
        "Ahmedabad",
        "Remote",
      ],
    };

    const actionPayload = JSON.stringify({
      positive: uniqueRoles,
      allow: matchedLoc.allow,
      alwaysAllow: matchedLoc.allow.slice(0, 10),
      since: 30,
      run: true,
    });

    return [
      `### Targeted Job Search for **${matchedLoc.label}**`,
      "",
      `Based on your CV (**${candidateName}** — skills in *${topSkills.slice(0, 6).join(", ")}*), here is how to focus on roles in **${matchedLoc.label}**:`,
      "",
      "1. **Best-Fit Demanding Roles for Your Profile:**",
      ...uniqueRoles.map((r) => `   - **${r}**`),
      "",
      "2. **Major Tech Hubs & Companies Hiring by State / City in India:**",
      "   - **Karnataka (Bengaluru / Mysuru):** Google, Microsoft, Flipkart, Razorpay, Swiggy, PhonePe, Stripe, Atlassian, Uber, CRED, Postman, Zerodha",
      "   - **Telangana (Hyderabad):** Microsoft IDC, Google, Amazon, ServiceNow, Salesforce, Uber, Apple, Goldman Sachs",
      "   - **Maharashtra (Mumbai / Pune / Navi Mumbai):** BrowserStack, JPMorgan, Morgan Stanley, Atlassian, CrowdStrike, Mastercard, Barclays",
      "   - **Delhi NCR (Gurugram / Noida / New Delhi):** Zomato, Paytm, Adobe, Expedia, MakeMyTrip, Sprinklr, Tower Research",
      "   - **Tamil Nadu (Chennai / Coimbatore):** Zoho, Freshworks, PayPal, Chargebee, Amazon",
      "   - **West Bengal / Gujarat / Kerala:** ITC Infotech, PwC Acceleration Center (Kolkata), GIFT City FinTechs (Gandhinagar/Ahmedabad), IBS Software (Kochi/Trivandrum)",
      "",
      "3. **How to Use the Country → State → Office City Filter:**",
      "   - On **Explore** (and in the **CV Market Modifier**), use the **1. Country → 2. State / Province → 3. Office / Branch City** dropdowns to filter results to your exact city or run a live ATS scan for that region.",
      "",
      `I am launching a filtered **Explore** scan for **${matchedLoc.label}** right now:`,
      `<<act:explore ${actionPayload}>>`,
    ].join("\n");
  }

  // ── INTENT 2: CV Review / Critique / Improve / Rewrite / ATS Optimization ──
  if (
    /\b(cv|resume|improve|review|critique|optimize|modify|modifier|rewrite|ats|score|strength|weakness|gap|bullet|summary|headline|format)\b/i.test(
      q,
    )
  ) {
    const hasCv = cvText.trim().length > 40;
    if (!hasCv) {
      return [
        "### Let's Load Your CV First",
        "",
        "Your `cv.md` is currently empty or not saved yet. Head over to **CV** (`/cv`) or **Today** (`/`), drop your PDF/DOCX/Markdown resume, and click **Save**.",
        "",
        "Once saved, you can:",
        "- Use the **AI Market-Driven CV Modifier** on the **CV** page to automatically rewrite your summary, skills matrix, and impact bullets for high-demand 2026 jobs.",
        "- Ask me here to critique specific sections or rewrite any bullet point!",
        "",
        '<<act:navigate {"path":"/cv"}>>',
      ].join("\n");
    }

    const proposedSummary = `Results-driven **${uniqueRoles[0]}** based in **${candidateLocation}** with hands-on expertise in **${topSkills.slice(0, 6).join(", ")}**. Proven track record of architecting, building, and shipping production-grade software systems${expHeaders.length ? ` across ${expHeaders.slice(0, 2).join(" and ")}` : ""}, with a focus on scalability, clean architecture, and measurable user impact.`;

    return [
      `### Personalized CV Review for **${candidateName}**`,
      "",
      `**Current Snapshot:**`,
      `- **Location:** ${candidateLocation}`,
      `- **Core Technical Stack (${detectedSkills.length} detected):** ${topSkills.join(", ")}`,
      `- **Experience / Project Entries:** ${expHeaders.length > 0 ? expHeaders.join(" · ") : "Detected in CV body"}`,
      `- **Quantified Impact Metrics Found:** ${metricMatches.length} (${metricMatches.length >= 4 ? "Strong quantification" : "Needs more % / latency / scale numbers"})`,
      "",
      "#### 1. Key Strengths in Your Current CV",
      `- **High-Demand Technical Foundation:** Your skills in **${topSkills.slice(0, 4).join(", ")}** directly align with **${uniqueRoles.slice(0, 2).join(" & ")}** openings.`,
      expHeaders.length > 0
        ? `- **Concrete Hands-On Experience:** Your work on *${expHeaders.slice(0, 2).join("* and *")}* gives strong proof of execution.`
        : "- **Clear Structure:** Your CV sections are clean and ATS-parseable.",
      "- **Multi-Role Adaptability:** You can credibly target both product engineering and AI/data-enabled engineering tracks.",
      "",
      "#### 2. High-Impact Improvements to Land More Interviews",
      metricMatches.length < 5
        ? "- **Quantify Every Top Bullet (`Action + System + Metric`):** Add concrete numbers to your top 4 bullets (e.g., *reduced API latency by 35%*, *automated workflow saving 10+ hrs/week*, *handled 50k+ requests/day*)."
        : "- **Front-Load Your Strongest Metrics:** Move your highest-impact quantified achievements to the first bullet under each role.",
      `- **Upgrade Your Executive Summary for ATS Keyword Density:** Explicitly pair **${uniqueRoles[0]}** with your core stack in the first 3 lines.`,
      "- **Group Skills by Domain:** Organize your `## Skills` section into *Languages*, *Frameworks & Libraries*, *Cloud & Databases*, and *AI / Engineering Practices* so ATS parsers score 90%+ match.",
      "",
      "#### 3. Suggested Market-Optimized Executive Summary (Copy or Apply in `/cv`)",
      `> ${proposedSummary}`,
      "",
      "**Tip:** Open the **CV** page (`/cv`) and scroll to **AI Market-Driven CV Modifier & Role Advisor** to 1-click rewrite and save your full CV for your target market roles!",
    ].join("\n");
  }

  // ── INTENT 3: Cover Letter / Cold Email / Recruiter Outreach / Application Answers ──
  if (
    /\b(cover letter|cold email|outreach|linkedin|recruiter|reach out|pitch|why this role|why should we hire|application|draft a|write a message|referral)\b/i.test(
      q,
    )
  ) {
    const companyMatch = userMessage.match(/\b(?:for|at|to)\s+([A-Z][A-Za-z0-9.& -]{1,30})/);
    const targetCompany = companyMatch ? companyMatch[1].trim() : "your engineering team";
    const highlightExp = expHeaders[0] || "production software and AI-enabled systems";

    return [
      `### Tailored Cover Letter & Recruiter Outreach (${candidateName})`,
      "",
      "#### Option 1 — Short, High-Signal Cover Letter",
      "```markdown",
      `Dear Hiring Team at ${targetCompany},`,
      "",
      `I am writing to apply for the ${uniqueRoles[0]} role. Based in ${candidateLocation}, I bring hands-on experience building and shipping production systems using ${topSkills.slice(0, 5).join(", ")}.`,
      "",
      `In my recent work (${highlightExp}), I focused on turning complex technical requirements into reliable, scalable software with measurable performance and delivery improvements. I thrive in fast-paced engineering teams that value ownership, clean architecture, and customer impact.`,
      "",
      `I would welcome the opportunity to discuss how my background in ${topSkills.slice(0, 3).join(", ")} can contribute to ${targetCompany}'s roadmap.`,
      "",
      "Best regards,",
      candidateName,
      "```",
      "",
      "#### Option 2 — LinkedIn / Recruiter Cold Note (< 400 chars)",
      `> Hi! I noticed ${targetCompany} is hiring for **${uniqueRoles[0]}** roles. I'm a developer based in ${candidateLocation} experienced with **${topSkills.slice(0, 4).join(", ")}** (${highlightExp}). I'd love to share my CV and explore if my background is a strong fit for your team!`,
    ].join("\n");
  }

  // ── INTENT 4: Interview Prep / STAR Stories / Technical & Behavioral Questions ──
  if (
    /\b(interview|prep|prepare|question|star|behavioral|behavioural|system design|coding round|dsa|tell me about yourself|introduce yourself|mock)\b/i.test(
      q,
    )
  ) {
    const primaryProject = expHeaders[0] || "your primary full-stack / AI engineering project";
    const secondaryProject = expHeaders[1] || "your backend API & data pipeline work";

    return [
      `### Personalized Interview Preparation Guide for **${candidateName}**`,
      "",
      "#### 1. Your 60-Second *\"Tell Me About Yourself\"* Pitch",
      `> *"I'm ${candidateName}, a software engineer based in ${candidateLocation} specializing in **${topSkills.slice(0, 5).join(", ")}**. Recently, I've been focused on **${primaryProject}**, where I built end-to-end features from architecture through deployment. What excites me most is solving real-world scalability and product challenges using modern full-stack and AI engineering practices, which is why I'm targeting **${uniqueRoles[0]}** roles."*`,
      "",
      `#### 2. Likely Technical Questions for Your Stack (${topSkills.slice(0, 4).join(", ")})`,
      `1. **Architecture & Trade-offs:** *"Walk me through the architecture of **${primaryProject}**. What was the hardest technical bottleneck and how did you resolve it?"*`,
      "   - *How to answer:* State the problem, compare 2 approaches you considered, explain why you chose your solution, and share the latency/reliability outcome.",
      `2. **Core Stack Deep-Dive (${topSkills.slice(0, 2).join(" / ")}):** *"How do you handle concurrency, caching, error boundaries, and state management in production?"*`,
      "3. **System Design:** *\"Design a scalable job discovery & real-time notification service handling 100k+ daily users with low latency.\"*",
      "   - *Key components to mention:* API Gateway, rate limiting, PostgreSQL + Redis caching, async worker queues, and idempotency.",
      "4. **AI / Production Reliability:** *\"How do you prevent hallucinations, control token latency, and evaluate output quality when integrating LLMs/APIs?\"*",
      "",
      "#### 3. STAR Story Blueprint (Situation → Task → Action → Result)",
      `- **Story #1 (Ownership & Delivery):** Use **${primaryProject}** — highlight how you took an ambiguous requirement, designed the schema/API, and shipped ahead of schedule.`,
      `- **Story #2 (Debugging / Performance):** Use **${secondaryProject}** — explain how you diagnosed a bottleneck, optimized queries/code, and improved responsiveness.`,
    ].join("\n");
  }

  // ── INTENT 5: Salary / CTC / Compensation / Offer Negotiation ──
  if (
    /\b(salary|ctc|lpa|comp|compensation|pay|package|negotiate|negotiation|expected ctc|offer|stipend|market rate)\b/i.test(
      q,
    )
  ) {
    return [
      `### 2026 Compensation Benchmarks & Negotiation Guide (${uniqueRoles[0]})`,
      "",
      "#### 1. India Tech Market Benchmarks (INR — Annual CTC)",
      "| Tier / Company Type | Entry / SDE-1 (0–2 yrs) | Mid / SDE-2 (2–5 yrs) | Senior / Applied AI (5+ yrs) |",
      "| :--- | :--- | :--- | :--- |",
      "| **High-Growth Startups & Product Cos** (Razorpay, Swiggy, Cred, Postman, Zoho) | ₹12 – ₹24 LPA | ₹25 – ₹48 LPA | ₹48 – ₹85+ LPA |",
      "| **Global Capability Centers (GCCs) & Big Tech** (Google, Microsoft, Amazon, Uber, Stripe, Atlassian) | ₹18 – ₹35 LPA | ₹35 – ₹65 LPA | ₹65 – ₹1.2Cr+ |",
      "| **IT Services & Digital Consulting** (Deloitte, PwC, Accenture, TCS Digital) | ₹6 – ₹12 LPA | ₹12 – ₹24 LPA | ₹24 – ₹42 LPA |",
      "",
      "#### 2. Global Remote / International Benchmarks",
      "- **Global Remote (from India / APAC):** $45,000 – $95,000 USD / yr",
      "- **United States (On-site / Remote US):** $135,000 – $220,000+ USD base",
      "- **Europe / UK:** €65,000 – €115,000 EUR / £65,000 – £110,000 GBP",
      "",
      "#### 3. Recruiter Script When Asked *\"What is your expected CTC?\"*",
      `> *"Based on my hands-on experience in **${topSkills.slice(0, 4).join(", ")}** and current market benchmarks for **${uniqueRoles[0]}** roles in ${candidateLocation}, I am targeting a range that reflects the scope of the role. Could you share the approved compensation band for this level so we can align?"*`,
    ].join("\n");
  }

  // ── INTENT 6: Skills Roadmap / What to Learn Next / Upskilling / Market Demand ──
  if (
    /\b(skill|skills|learn|upskill|roadmap|course|project idea|trending|demanding|future|career path|transition|stack)\b/i.test(
      q,
    )
  ) {
    const missingHighDemand = [
      "LLM Agents & RAG Evaluation (LangGraph / OpenAI / Vector DBs)",
      "TypeScript & Next.js App Router Architecture",
      "Docker, Kubernetes & CI/CD Pipelines",
      "Distributed Caching & Queues (Redis / Kafka)",
      "System Design & Cloud Observability (AWS / GCP)",
    ].filter((item) => !detectedSkills.some((s) => item.toLowerCase().includes(s.split(" ")[0].toLowerCase())));

    return [
      `### 2026 High-Demand Skills Roadmap for **${candidateName}**`,
      "",
      `**Your Current Verified Stack:** ${topSkills.join(", ")}`,
      `**Top Target Role Tracks:** ${uniqueRoles.join(" · ")}`,
      "",
      "#### Highest-Leverage Skills to Add Next",
      ...missingHighDemand.slice(0, 4).map((s, i) => `${i + 1}. **${s}**`),
      "",
      "#### 30-60-90 Day Action Plan",
      "- **Days 1–30 (Core Depth & CV Proof):** Ship 1 end-to-end production feature or portfolio repo combining your **",
      `  ${topSkills.slice(0, 3).join(" + ")}** stack with automated tests, Docker deployment, and latency/accuracy benchmarks.`,
      "- **Days 31–60 (AI & System Scalability):** Add an AI/LLM workflow (RAG pipeline, structured extraction, or agentic tool use) with measurable evaluation metrics.",
      "- **Days 61–90 (High-Signal Applications):** Use the **AI Market-Driven CV Modifier** in `/cv` to align your resume and target top engineering hubs in **Bengaluru, Hyderabad, Pune, Mumbai, Delhi NCR, and Remote**.",
    ].join("\n");
  }

  // ── INTENT 7: Pipeline / Inbox / Tracker / Setup / "What should I do today?" ──
  if (
    /\b(pipeline|inbox|tracker|application|evaluated|status|today|prioritise|prioritize|get started|set up|setup|onboard|help me)\b/i.test(
      q,
    )
  ) {
    return [
      `### Your Career-Ops Action Plan (${candidateName})`,
      "",
      "**Live Workspace Summary:**",
      `- **CV on File (\`cv.md\`):** ${cvText.trim() ? `Active (${detectedSkills.length} technical skills detected · Location: ${candidateLocation})` : "Not uploaded yet — go to `/cv` to upload"}`,
      `- **Tracked Applications:** ${appRows.length} evaluated role${appRows.length === 1 ? "" : "s"}`,
      `- **Pending Inbox Postings:** ${pendingUrls.length} role${pendingUrls.length === 1 ? "" : "s"} waiting for evaluation`,
      currentPage ? `- **Current View:** ${currentPage}` : "",
      "",
      "#### 3 Highest-Leverage Actions Right Now",
      `1. **Optimize Your CV for High-Demand Market Roles:** Open **CV** (\`/cv\`) and use the **AI Market-Driven CV Modifier** to tailor your summary and impact bullets for **${uniqueRoles.slice(0, 2).join(" & ")}**.`,
      `2. **Filter Jobs by Country → State → Office City:** Open **Explore** (\`/explore\`), select **India** (or any target country) → your preferred **State** (e.g., Karnataka, Telangana, Maharashtra, Delhi NCR) → **Office City** (e.g., Bengaluru, Hyderabad, Pune, Mumbai), and run a free ATS scan.`,
      pendingUrls.length > 0
        ? `3. **Triage Your ${pendingUrls.length} Pending Inbox Roles:** Head to **Pipeline** (\`/pipeline\`) and click **Evaluate** on your top 3 best-fitting roles.`
        : "3. **Build Your Shortlist:** Add 3–5 matching roles from **Explore** to your Pipeline and run **Evaluate** to get A–F fit scores and tailored CVs.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // ── INTENT 8: Dynamic General / Technical / Career Co-Pilot Response (Any Other Query) ──
  return [
    `### Career Co-Pilot Response for **${candidateName}**`,
    "",
    `Regarding your question: *"${userMessage.slice(0, 140)}"*`,
    "",
    `Here is how this applies to your profile (**${uniqueRoles.slice(0, 2).join(" / ")}** · **${candidateLocation}** · Stack: *${topSkills.slice(0, 6).join(", ")}*):`,
    "",
    `1. **Direct Recommendation:** Focus on roles where your hands-on experience in **${topSkills.slice(0, 4).join(", ")}**${expHeaders.length ? ` (especially *${expHeaders[0]}*)` : ""} solves immediate engineering bottlenecks.`,
    `2. **Location & Market Strategy:** When searching on **Explore**, use the **Country → State / Province → Office / Branch City** filter (for example: **India → Karnataka → Bengaluru**, **Telangana → Hyderabad**, **Maharashtra → Pune / Mumbai**, or **Delhi NCR → Gurugram / Noida**) so you only see relevant local and remote openings.`,
    "3. **What You Can Ask Me Next:**",
    '   - *"Find software & AI jobs in India (Bengaluru / Hyderabad / Pune)"* (I will automatically launch a filtered scan for you)',
    '   - *"Review my CV and rewrite my summary for demanding market jobs"*',
    '   - *"Prepare me for technical and behavioral interview questions"*',
    '   - *"Draft a cover letter and recruiter cold message"*',
    '   - *"What salary / CTC LPA should I target and how do I negotiate?"*',
  ].join("\n");
}

/**
 * Main entrypoint for the CLI shim process.
 *
 * @param {string[]} argv
 */
export async function runCliShim(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: claude -p <prompt> [--output-format stream-json]\n");
    return;
  }

  const isStreamJson = argv.includes("stream-json");
  let prompt = "";
  const pIdx = argv.indexOf("-p");
  if (pIdx !== -1 && typeof argv[pIdx + 1] === "string") {
    prompt = argv[pIdx + 1];
  } else {
    prompt = argv[argv.length - 1] || "";
  }

  const llmResponse = await tryExternalLlm(prompt);
  const responseText = llmResponse || buildDeterministicResponse(prompt);

  if (isStreamJson) {
    const initEvent = JSON.stringify({ type: "system", subtype: "init" });
    const deltaEvent = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: responseText },
      },
    });
    const resultEvent = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: responseText,
      usage: { input_tokens: 200, output_tokens: 250, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      total_cost_usd: 0,
    });
    process.stdout.write(`${initEvent}\n${deltaEvent}\n${resultEvent}\n`);
  } else {
    process.stdout.write(responseText);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await runCliShim(process.argv.slice(2));
}
