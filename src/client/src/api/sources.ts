import { authHeaders, getJson, parseResponse, patchJson, postJson } from "./http";
import type {
  ImportBundleResult,
  LocalBrowseResult,
  SourceBundle,
  SourceBuildPlan,
  SourceFilePreview,
  SourceBundleVersion,
  SourceFileChange,
  SourceFileEntry,
  SourcePreviewNode
} from "./types";

export async function listSourceBundles(projectId?: string): Promise<SourceBundle[]> {
  return (await getJson<{ bundles: SourceBundle[] }>(projectId ? `/api/projects/${encodeURIComponent(projectId)}/source-bundles` : "/api/source-bundles")).bundles;
}

export async function listBundleVersions(bundleId: string, projectId?: string): Promise<SourceBundleVersion[]> {
  const prefix = sourcePrefix(bundleId, projectId);
  return (
    await getJson<{ versions: SourceBundleVersion[] }>(
      `${prefix}/versions`
    )
  ).versions;
}

export async function getBundleVersion(
  bundleId: string,
  versionId: string,
  projectId?: string
): Promise<{ version: SourceBundleVersion; files: SourceFileEntry[]; changes: SourceFileChange[] }> {
  return getJson(
    `${sourcePrefix(bundleId, projectId)}/versions/${encodeURIComponent(versionId)}`
  );
}

export async function getSourceVersionPreview(
  bundleId: string,
  versionId: string,
  projectId: string
): Promise<{ version: SourceBundleVersion; tree: SourcePreviewNode[]; files: SourcePreviewNode[]; changes: SourceFileChange[] }> {
  return getJson(`${sourcePrefix(bundleId, projectId)}/versions/${encodeURIComponent(versionId)}/preview`);
}

export async function getSourceFilePreview(
  bundleId: string,
  versionId: string,
  logicalPath: string,
  projectId: string
): Promise<SourceFilePreview> {
  return (await getJson<{ file: SourceFilePreview }>(
    `${sourcePrefix(bundleId, projectId)}/versions/${encodeURIComponent(versionId)}/files/${encodePath(logicalPath)}`
  )).file;
}

export async function getBundleBuildPlan(
  bundleId: string,
  versionId: string,
  projectId: string
): Promise<SourceBuildPlan> {
  return (await getJson<{ plan: SourceBuildPlan }>(
    `${sourcePrefix(bundleId, projectId)}/versions/${encodeURIComponent(versionId)}/build-plan`
  )).plan;
}

export async function importSourceBundle(
  bundleId: string,
  rootPath: string,
  note?: string,
  projectId?: string
): Promise<ImportBundleResult> {
  return postJson<ImportBundleResult>(
    `${sourcePrefix(bundleId, projectId)}/versions`,
    { rootPath, note }
  );
}

export async function uploadSourceBundle(
  bundleId: string,
  files: File[],
  note?: string,
  projectId?: string
): Promise<ImportBundleResult> {
  const form = new FormData();
  if (note) form.set("note", note);
  for (const file of files) {
    const relativePath = webkitRelativePath(file) || file.name;
    form.append("files", file, relativePath);
  }
  const response = await fetch(`${sourcePrefix(bundleId, projectId)}/uploads`, {
    method: "POST",
    headers: authHeaders(),
    body: form
  });
  return parseResponse(response);
}

export async function updateSourceBundle(
  bundleId: string,
  patch: { name?: string; description?: string },
  projectId?: string
): Promise<SourceBundle> {
  return (await patchJson<{ bundle: SourceBundle }>(sourcePrefix(bundleId, projectId), patch)).bundle;
}

export async function updateBundleVersion(
  bundleId: string,
  versionId: string,
  patch: { label?: string; note?: string }
): Promise<SourceBundleVersion> {
  return (
    await patchJson<{ version: SourceBundleVersion }>(
      `/api/source-bundles/${encodeURIComponent(bundleId)}/versions/${encodeURIComponent(versionId)}`,
      patch
    )
  ).version;
}

function sourcePrefix(bundleId: string, projectId?: string): string {
  const encodedBundle = encodeURIComponent(bundleId);
  return projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/source-bundles/${encodedBundle}`
    : `/api/source-bundles/${encodedBundle}`;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
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
