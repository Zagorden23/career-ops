// The cloud CLI shim stands in for `agy -p` on Render. These tests pin the
// assistant's routing so greetings, product how-tos and off-topic chatter are
// not mistaken for CV / salary / job intents (the "assistant isn't helping" bug).
//
// Run: node --test tests/cloud-cli-shim-assistant.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAssistantResponse,
  convertCvSourceToMarkdown,
  cleanLatexCvSource,
} from "../deploy/cloud-cli-shim.mjs";

function emptyWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shim-ws-"));
}

function workspaceWithCv() {
  const dir = emptyWorkspace();
  fs.writeFileSync(
    path.join(dir, "cv.md"),
    "# CV -- Priya Sharma\n**Location:** Pune, India\n\n## Skills\nPython, SQL, React\n\n### Dashboard Platform\n- Cut report time by 40%\n",
  );
  return dir;
}

test("greeting gets a friendly menu, not a profile dump", () => {
  const r = buildAssistantResponse("hi", emptyWorkspace());
  assert.match(r, /Career-Ops co-pilot/);
  assert.doesNotMatch(r, /Regarding your question/);
});

test("'explain the A-F score' explains evaluation and does not demand a CV", () => {
  const r = buildAssistantResponse("explain the A-F score", emptyWorkspace());
  assert.match(r, /How evaluation works/);
  assert.doesNotMatch(r, /Load Your CV First/);
});

test("'what is career-ops' and export-PDF questions get product answers", () => {
  assert.match(buildAssistantResponse("what is career-ops?", emptyWorkspace()), /What Career-Ops does/);
  assert.match(buildAssistantResponse("how to export pdf", emptyWorkspace()), /Exporting a CV as PDF/);
});

test("off-topic chatter is politely redirected", () => {
  for (const q of ["tell me a joke", "what's the weather"]) {
    const r = buildAssistantResponse(q, emptyWorkspace());
    assert.match(r, /outside what I can help with/, q);
  }
});

test("unrecognised input falls back honestly instead of faking a profile", () => {
  const r = buildAssistantResponse("asdfgh", emptyWorkspace());
  assert.match(r, /not sure I understood/);
  assert.doesNotMatch(r, /Software Engineer \/ Full-Stack Developer/);
});

test("'how do I upload my cv' explains uploading even when a CV exists", () => {
  const r = buildAssistantResponse("how do I upload my cv", workspaceWithCv());
  assert.match(r, /Uploading your CV/);
});

test("cover letter honours the named role and company; no awkward 'at your engineering team'", () => {
  const r = buildAssistantResponse("write a cover letter for a data analyst at Stripe", workspaceWithCv());
  assert.match(r, /Dear Hiring Team at Stripe,/);
  assert.match(r, /apply for the Data Analyst role/);
  const noCompany = buildAssistantResponse("write a cover letter for a data analyst", workspaceWithCv());
  assert.match(noCompany, /Dear Hiring Manager,/);
  assert.doesNotMatch(noCompany, /your engineering team/);
});

test("personalised templates are flagged as generic when no CV is saved", () => {
  const r = buildAssistantResponse("write a cover letter for a data analyst", emptyWorkspace());
  assert.match(r, /No CV saved yet/);
  const withCv = buildAssistantResponse("write a cover letter for a data analyst", workspaceWithCv());
  assert.doesNotMatch(withCv, /No CV saved yet/);
});

test("interview prep names the company when one is given", () => {
  const r = buildAssistantResponse("how do I prepare for an interview at Google", workspaceWithCv());
  assert.match(r, /Google/);
  assert.match(r, /Interview Preparation Guide/);
});

test("location queries still launch a filtered Explore scan", () => {
  const r = buildAssistantResponse("find jobs in Pune", workspaceWithCv());
  assert.match(r, /<<act:explore /);
  assert.match(r, /Pune/);
});

test("CV converters keep working on LaTeX and plain text", () => {
  const tex = String.raw`\documentclass{article}\begin{document}\section*{Skills} Python, SQL\end{document}`;
  assert.match(cleanLatexCvSource(tex), /## Skills/);
  const { markdown, seed } = convertCvSourceToMarkdown(
    "Priya Sharma\npriya@x.com | Bengaluru, India\n\nSKILLS\nPython, SQL",
  );
  assert.equal(typeof markdown, "string");
  assert.ok(seed && typeof seed === "object");
});
