import { spawn } from "node:child_process";
import { careerOpsRoot } from "@/lib/career-ops";
import { locateTailoredPdf } from "@/lib/cv-pdf-file";
import { revealCvRequest } from "@/lib/cv-reveal.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req) {
  const result = await revealCvRequest({
    searchParams: req.nextUrl.searchParams,
    locate: locateTailoredPdf,
    platform: process.platform,
    spawn,
    root: careerOpsRoot(),
  });
  return new Response(result.body || null, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
