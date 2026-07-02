import { useQuery } from "@tanstack/react-query";

import { getFlywheelWorkbench } from "../api";

export const WORKBENCH_QUERY_KEY = ["dashboard", "workbench"] as const;

export function useWorkbench(projectId?: string) {
  return useQuery({
    queryKey: projectId ? [...WORKBENCH_QUERY_KEY, projectId] : WORKBENCH_QUERY_KEY,
    queryFn: () => getFlywheelWorkbench(projectId),
    refetchInterval: 5000,
  });
}
