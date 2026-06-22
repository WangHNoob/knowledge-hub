import { useEffect, useRef, useState } from "react";
import { streamBuildLogs, type BuildLogRecord } from "../api/buildLogs";
import { formatClock } from "../utils/format";

export function BuildLogConsole({ runId }: { runId: string }) {
  const [lines, setLines] = useState<BuildLogRecord[]>([]);
  const [live, setLive] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLines([]);
    setLive(true);
    const controller = streamBuildLogs(
      runId,
      (record) => setLines((current) => [...current.slice(-999), record]),
      () => setLive(false),
    );
    return () => controller.abort();
  }, [runId]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [lines]);

  return (
    <div className="build-console">
      <div className="build-console-head">
        <span>构建日志 · {runId}</span>
        <span className={live ? "live" : "ended"}>{live ? "● live" : "○ ended"}</span>
      </div>
      <div className="build-console-body">
        {lines.map((line) => (
          <div key={line.logId} className={`log-line lvl-${line.level} st-${line.status}`}>
            <span className="log-time">{formatClock(line.createdAt)}</span>
            <span className="log-cat">{line.category}</span>
            <span className="log-msg">{line.message}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
