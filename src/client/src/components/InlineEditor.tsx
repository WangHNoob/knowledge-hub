import { Pencil } from "lucide-react";
import { useState } from "react";

export interface InlineEditorField {
  key: string;
  label: string;
  value: string;
  /** 多行（备注）用 textarea，单行（名称）用 input。 */
  multiline?: boolean;
  placeholder?: string;
  required?: boolean;
}

/**
 * 通用「重命名 + 备注」内联编辑器。
 *
 * 默认显示一个铅笔按钮；点开后渲染受控的名称/备注输入框，
 * 保存时把变更字段以 `{ key: value }` 回调给上层（上层负责调用对应 PATCH 接口）。
 */
export function InlineEditor({
  fields,
  onSave,
  saving = false,
  title = "编辑名称与备注"
}: {
  fields: InlineEditorField[];
  onSave: (patch: Record<string, string>) => Promise<unknown> | void;
  saving?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const start = () => {
    setDraft(Object.fromEntries(fields.map((field) => [field.key, field.value])));
    setError("");
    setOpen(true);
  };

  const submit = async () => {
    const patch: Record<string, string> = {};
    for (const field of fields) {
      const next = draft[field.key] ?? "";
      if (field.required && !next.trim()) {
        setError(`${field.label}不能为空。`);
        return;
      }
      if (next !== field.value) patch[field.key] = next;
    }
    if (Object.keys(patch).length === 0) {
      setOpen(false);
      return;
    }
    try {
      await onSave(patch);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败。");
    }
  };

  if (!open) {
    return (
      <button type="button" className="icon-button" title={title} onClick={start}>
        <Pencil size={15} />
      </button>
    );
  }

  return (
    <div className="inline-editor">
      {fields.map((field) => (
        <label key={field.key} className="field-label">
          {field.label}
          {field.multiline ? (
            <textarea
              rows={2}
              value={draft[field.key] ?? ""}
              placeholder={field.placeholder}
              onChange={(event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.value }))}
            />
          ) : (
            <input
              value={draft[field.key] ?? ""}
              placeholder={field.placeholder}
              onChange={(event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.value }))}
            />
          )}
        </label>
      ))}
      {error && <p className="error">{error}</p>}
      <div className="detail-actions">
        <button type="button" className="primary-action" disabled={saving} onClick={submit}>
          {saving ? "保存中..." : "保存"}
        </button>
        <button type="button" className="secondary-action" disabled={saving} onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </div>
  );
}
