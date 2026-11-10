import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKET_JOB_ARCHETYPES,
  analyzeCvAndSuggestMarketJobs,
  modifyCvForMarketJobs,
} from "../../src/lib/cv/market-modifier.mjs";
import { cvReadiness } from "../../src/lib/cv/readiness.mjs";

const SAMPLE_CV = `# CV -- Priya Sharma

**Location:** Bengaluru, India
**Email:** priya.sharma@example.com

## Professional Summary
Software engineer working on web applications and APIs.

## Work Experience
### Acme Cloud Technologies -- Bengaluru
**Senior Software Engineer**
2021 - Present
- Worked on multi-tenant authentication and reduced p95 API latency by 42%.
- Built 18 microservices using Node.js, React, Next.js, TypeScript, and PostgreSQL.
- Used Python and FastAPI to automate internal evaluation workflows.

## Education
- B.Tech in Computer Science, IIT Delhi (2021)

## Skills
- **Languages:** JavaScript, TypeScript, Python, SQL, React, Next.js, Node.js, PostgreSQL, Docker
`;

test("analyzeCvAndSuggestMarketJobs detects candidate skills, metrics, and ranks relevant high-demand roles", () => {
  const analysis = analyzeCvAndSuggestMarketJobs(
    SAMPLE_CV,
    "Generative AI, LLM Agents, Full-Stack Next.js",
  );
  assert.equal(analysis.candidateName, "Priya Sharma");
  assert.ok(analysis.readinessScore >= 50 && analysis.readinessScore <= 98);
  assert.ok(analysis.metricsCount >= 1);
  assert.ok(analysis.detectedSkills.includes("TypeScript"));
  assert.ok(analysis.detectedSkills.includes("Next.js"));
  assert.ok(analysis.detectedSkills.includes("Python"));
  assert.equal(analysis.suggestions.length, MARKET_JOB_ARCHETYPES.length);

  // Top suggestions should reflect both CV skills and stated AI/Full-Stack interests
  const topIds = analysis.suggestions.slice(0, 3).map((s) => s.id);
  assert.ok(
    topIds.includes("applied-ai-engineer") || topIds.includes("fullstack-cloud-engineer"),
    `Expected AI or Full-Stack archetype in top 3, got ${topIds.join(", ")}`,
  );
  for (const s of analysis.suggestions) {
    assert.ok(s.projectedMatchPct > s.currentMatchPct);
    assert.ok(Array.isArray(s.searchRoles) && s.searchRoles.length > 0);
  }
});

test("modifyCvForMarketJobs rewrites summary, upgrades weak bullet verbs, preserves all metrics/employers, and boosts readiness", () => {
  const res = modifyCvForMarketJobs({
    cvMarkdown: SAMPLE_CV,
    interests: "Applied AI, Agentic Workflows, Full-Stack Cloud",
    selectedRoleIds: ["applied-ai-engineer", "fullstack-cloud-engineer"],
  });

  assert.ok(res.afterScore > res.beforeScore);
  assert.ok(res.changesSummary.length >= 3);
  assert.ok(res.targetRoles.length >= 2);

  // Must preserve candidate name, employer, degree, and quantified metrics (no fabrication or data loss)
  assert.match(res.modifiedCv, /^# CV -- Priya Sharma/m);
  assert.match(res.modifiedCv, /Acme Cloud Technologies -- Bengaluru/);
  assert.match(res.modifiedCv, /42%/);
  assert.match(res.modifiedCv, /IIT Delhi/);

  // Must upgrade weak verb "Worked on" -> "Engineered and delivered" and "Built" -> "Architected and built"
  assert.match(res.modifiedCv, /Engineered and delivered multi-tenant authentication/);
  assert.match(res.modifiedCv, /Architected and built 18 microservices/);

  // Must remain scoreable according to cvReadiness
  assert.equal(cvReadiness(res.modifiedCv).scoreable, true);
});
