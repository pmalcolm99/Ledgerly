import { ProjectDashboard } from "../../../../components/ProjectDashboard";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectDashboard projectId={id} />;
}
