import { useQuery } from "@tanstack/react-query";

import { getFlywheelWorkbench } from "../api";

export const WORKBENCH_QUERY_KEY = ["dashboard", "workbench"] as const;

export function useWorkbench() {
  return useQuery({
    queryKey: WORKBENCH_QUERY_KEY,
    queryFn: getFlywheelWorkbench,
    refetchInterval: 5000,
  });
}
