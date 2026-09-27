import type { ProjectWorkspace } from "@/lib/types";
import ActivityTimeline from "./ActivityTimeline";

export default function ActivityTab({ workspace }: { workspace: ProjectWorkspace }) {
  return <ActivityTimeline workspace={workspace} />;
}
