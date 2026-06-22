import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getQualityProfile, updateQualityProfile } from "../api";
import { Badge, ErrorState, Loading } from "./Atoms";
import { formatTime } from "../utils/format";

export function QualityGateAdmin() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["quality-profile"], queryFn: getQualityProfile });
  const [draft, setDraft] = useState("");
  const mutation = useMutation({
    mutationFn: () => updateQualityProfile(JSON.parse(draft)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["quality-profile"] });
    }
  });

  useEffect(() => {
    if (data) setDraft(JSON.stringify(data.config, null, 2));
  }, [data]);

  if (isLoading) return <Loading title="读取质量门禁" />;
  if (error) return <ErrorState error={error} />;

  return (
    <section className="quality-gate-panel">
      <div className="detail-head">
        <div>
          <h2>知识质量门禁</h2>
          <p>{data?.name}　·　更新于 {data?.updatedAt ? formatTime(data.updatedAt) : "—"}</p>
        </div>
        <Badge label={data?.active ? "active" : "inactive"} tone={data?.active ? "ok" : "warn"} />
      </div>
      <textarea
        className="code-editor"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
      />
      <div className="detail-actions">
        <button
          className="primary-action"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? "保存中..." : "保存门禁配置"}
        </button>
      </div>
      {mutation.error && <p className="error">{mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}</p>}
    </section>
  );
}
