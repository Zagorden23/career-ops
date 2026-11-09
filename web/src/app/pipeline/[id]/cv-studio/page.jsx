import { CvStudio } from "@/components/cv-studio/cv-studio";

export const dynamic = "force-dynamic";

export default async function CvStudioPage({ params }) {
  const { id } = await params;
  return <CvStudio n={id} />;
}
