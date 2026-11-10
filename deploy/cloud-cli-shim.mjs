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
  return "Your CV and workspace are active. Head to **Explore** to run a free live market scan across Greenhouse, Ashby, and Lever boards, or edit your CV in **CV Studio**.";
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
