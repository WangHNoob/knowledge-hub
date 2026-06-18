import { deleteJson, getJson } from "./http";
import type { AssetPackage, ComponentContent, EvidenceCoverage, EvidenceRecord, PackageDetail } from "./types";

export interface PackageFilter {
  q?: string;
  status?: string;
  kind?: string;
}

export async function listPackages(filter: PackageFilter = {}): Promise<AssetPackage[]> {
  const params = new URLSearchParams();
  if (filter.q) params.set("q", filter.q);
  if (filter.status) params.set("status", filter.status);
  if (filter.kind) params.set("kind", filter.kind);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return (await getJson<{ packages: AssetPackage[] }>(`/api/packages${suffix}`)).packages;
}

export async function getPackage(packageId: string): Promise<PackageDetail> {
  return getJson(`/api/packages/${encodeURIComponent(packageId)}`);
}

export async function deletePackage(packageId: string): Promise<boolean> {
  return (await deleteJson<{ deleted: boolean }>(`/api/packages/${encodeURIComponent(packageId)}`)).deleted;
}

export async function listEvidence(packageId: string): Promise<{ records: EvidenceRecord[]; coverage: EvidenceCoverage }> {
  return getJson(`/api/evidence?packageId=${encodeURIComponent(packageId)}`);
}

export async function getComponentContent(packageId: string, componentId: string): Promise<ComponentContent> {
  return getJson(`/api/packages/${encodeURIComponent(packageId)}/components/${encodeURIComponent(componentId)}/content`);
}

export async function getComponentOwner(componentId: string): Promise<string> {
  return (await getJson<{ packageId: string }>(`/api/components/${encodeURIComponent(componentId)}/owner`)).packageId;
}
