import { authHeaders, getJson, parseResponse, postJson } from "./http";
import type {
  ImportBundleResult,
  LocalBrowseResult,
  SourceBundle,
  SourceBundleVersion,
  SourceFileChange,
  SourceFileEntry
} from "./types";

export async function listSourceBundles(): Promise<SourceBundle[]> {
  return (await getJson<{ bundles: SourceBundle[] }>("/api/source-bundles")).bundles;
}

export async function listBundleVersions(bundleId: string): Promise<SourceBundleVersion[]> {
  return (
    await getJson<{ versions: SourceBundleVersion[] }>(
      `/api/source-bundles/${encodeURIComponent(bundleId)}/versions`
    )
  ).versions;
}

export async function getBundleVersion(
  bundleId: string,
  versionId: string
): Promise<{ version: SourceBundleVersion; files: SourceFileEntry[]; changes: SourceFileChange[] }> {
  return getJson(
    `/api/source-bundles/${encodeURIComponent(bundleId)}/versions/${encodeURIComponent(versionId)}`
  );
}

export async function importSourceBundle(
  bundleId: string,
  rootPath: string,
  note?: string
): Promise<ImportBundleResult> {
  return postJson<ImportBundleResult>(
    `/api/source-bundles/${encodeURIComponent(bundleId)}/versions`,
    { rootPath, note }
  );
}

export async function uploadSourceBundle(
  bundleId: string,
  files: File[],
  note?: string
): Promise<ImportBundleResult> {
  const form = new FormData();
  if (note) form.set("note", note);
  for (const file of files) {
    const relativePath = webkitRelativePath(file) || file.name;
    form.append("files", file, relativePath);
  }
  const response = await fetch(`/api/source-bundles/${encodeURIComponent(bundleId)}/uploads`, {
    method: "POST",
    headers: authHeaders(),
    body: form
  });
  return parseResponse(response);
}

export async function browseLocalFiles(path?: string): Promise<LocalBrowseResult> {
  const suffix = path ? `?path=${encodeURIComponent(path)}` : "";
  return getJson(`/api/local-files/browse${suffix}`);
}

function webkitRelativePath(file: File): string {
  return typeof (file as File & { webkitRelativePath?: string }).webkitRelativePath === "string"
    ? (file as File & { webkitRelativePath: string }).webkitRelativePath
    : "";
}
