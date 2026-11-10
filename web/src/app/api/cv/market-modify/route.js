import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { readJsonObject } from "@/lib/json-body";
import {
  analyzeCvAndSuggestMarketJobs,
  modifyCvForMarketJobs,
} from "@/lib/cv/market-modifier.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readDiskCv() {
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), "cv.md"), "utf8");
  } catch {
    return "";
  }
}

function readProfileInterests() {
  try {
    const profilePath = path.join(careerOpsRoot(), "config", "profile.yml");
    const raw = fs.readFileSync(profilePath, "utf8");
    const rolesMatch = raw.match(/target_roles\s*:\s*\[([^\]]*)\]/i);
    if (rolesMatch) {
      return rolesMatch[1]
        .split(",")
        .map((s) => s.replace(/["']/g, "").trim())
        .filter(Boolean)
        .join(", ");
    }
    return "";
  } catch {
    return "";
  }
}

export async function GET() {
  const cvMarkdown = readDiskCv();
  const defaultInterests = readProfileInterests();
  const analysis = analyzeCvAndSuggestMarketJobs(cvMarkdown, defaultInterests);
  return NextResponse.json({
    ok: true,
    hasCv: Boolean(cvMarkdown.trim()),
    defaultInterests,
    analysis,
    suggestions: analysis.suggestions,
  });
}

export async function POST(req) {
  const body = await readJsonObject(req);
  if (!body) {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const mode = body.mode === "analyze" ? "analyze" : "modify";
  const cvMarkdown =
    typeof body.cvContent === "string" && body.cvContent.trim()
      ? body.cvContent
      : readDiskCv();
  const interests =
    typeof body.interests === "string" ? body.interests.trim().slice(0, 600) : "";
  const selectedRoleIds = Array.isArray(body.selectedRoleIds)
    ? body.selectedRoleIds.filter((id) => typeof id === "string").slice(0, 5)
    : [];

  if (!cvMarkdown.trim()) {
    return NextResponse.json(
      { error: "Add or upload your CV first so the AI modifier can analyze and optimize it." },
      { status: 400 },
    );
  }

  if (mode === "analyze") {
    const analysis = analyzeCvAndSuggestMarketJobs(cvMarkdown, interests);
    return NextResponse.json({
      ok: true,
      analysis,
      suggestions: analysis.suggestions,
    });
  }

  const result = modifyCvForMarketJobs({
    cvMarkdown,
    interests,
    selectedRoleIds,
  });

  return NextResponse.json({
    ok: true,
    ...result,
  });
}
