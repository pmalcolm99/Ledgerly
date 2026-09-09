import { ProjectList } from "../../components/ProjectList";

/**
 * The landing screen (brief §2). Deliberately the project list rather than a
 * dashboard: on a phone, the first tap should be the project you are about to
 * photograph a receipt into.
 */
export default function HomePage() {
  return <ProjectList />;
}
