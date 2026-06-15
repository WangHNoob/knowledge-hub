/**
 * Tauri 环境检测与原生 API 封装
 *
 * 浏览器中运行时所有方法返回 null/false，前端代码应做降级处理。
 */

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function selectFolder(title = "选择目录"): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}
