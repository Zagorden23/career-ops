import path from "node:path";
import { careerOpsRoot, isRegularContainedFile, pdfPathStatusForReport } from "@/lib/career-ops";
import { cvDiskState } from "@/lib/cv-disk-state.mjs";
import { listOutputPdfNames } from "@/lib/output-pdf-names.mjs";
import { tailoredCvOnDisk } from "@/lib/tailored-cv-ready.mjs";

export async function readCvDiskForRows(rows) {
  const filenames = listOutputPdfNames(path.join(careerOpsRoot(), "output"), isRegularContainedFile);
  const pairs = await Promise.all(
    rows.map(async (row) => {
      // The tracker row and the report are different counters. The caller
      // passes the report number. A missing one is not the tracker row.
      const indexStatus = row.reportNumber == null
        ? "not-found"
        : (await pdfPathStatusForReport(String(row.reportNumber))).status;
      const onDisk = tailoredCvOnDisk({ indexStatus, filenames, company: row.company });
      return [row.n, cvDiskState({ onDisk, trackerMarked: Boolean(row.trackerMarked) })];
    }),
  );
  return Object.fromEntries(pairs);
}

export async function readCvDiskState(n, company, trackerMarked = false, reportNumber = null) {
  const all = await readCvDiskForRows([{ n, company, trackerMarked, reportNumber }]);
  return all[n] ?? cvDiskState({ onDisk: false, trackerMarked });
}
