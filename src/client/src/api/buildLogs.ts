import { authHeaders } from "./http";

export interface BuildLogRecord {
  logId: string;
  level: string;
  category: string;
  message: string;
  status: string;
  runId: string;
  entityType: string;
  createdAt: string;
}

// Streams diagnostic log records for a run. Returns an AbortController; call .abort() to stop.
export function streamBuildLogs(
  runId: string,
  onRecord: (record: BuildLogRecord) => void,
  onEnd?: () => void,
): AbortController {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(`/api/build-runs/${encodeURIComponent(runId)}/stream`, {
        headers: authHeaders(),
        signal: controller.signal,
      });
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const isEnd = frame.includes("event: end");
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine) {
            try {
              const parsed = JSON.parse(dataLine.slice("data: ".length));
              if (isEnd) onEnd?.();
              else onRecord(parsed as BuildLogRecord);
            } catch { /* ignore malformed/heartbeat */ }
          }
        }
      }
      onEnd?.();
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") onEnd?.();
    }
  })();
  return controller;
}
