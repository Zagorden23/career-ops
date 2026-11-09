import { addOffersToPipeline } from "@/lib/core/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Free + reversible: append chosen discovered offers to data/pipeline.md AND
// record them in data/scan-history.tsv, via the core's CANONICAL exported writers
// (no parallel writer). No tokens spent.
export async function POST(req) {
  let offers = [];
  try {
    const body = (await req.json());
    offers = Array.isArray(body.offers) ? body.offers : [];
  } catch {
    return Response.json({ added: 0, error: "bad request" }, { status: 400 });
  }
  if (offers.length === 0) return Response.json({ added: 0 });

  const result = await addOffersToPipeline(offers);
  return Response.json(result);
}
