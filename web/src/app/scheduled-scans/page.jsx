import { ScheduledJobsView } from "@/components/scheduled-jobs-view";

export const metadata = { title: "Scheduled scans" };

export const dynamic = "force-dynamic";

export default function ScheduledScansPage() {
  return <ScheduledJobsView />;
}
