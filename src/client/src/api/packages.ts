import { getJson } from "./http";
import type { AssetPackage, ComponentContent, EvidenceCoverage, EvidenceRecord, PackageDetail } from "./types";

export async function listPackages(): Promise<AssetPackage[]> {
  return (await getJson<{ packages: AssetPackage[] }>("/api/packages")).packages;
}

export async function getPackage(packageId: string): Promise<PackageDetail> {
  return getJson(`/api/packages/${encodeURIComponent(packageId)}`);
}

export async function listEvidence(packageId: string): Promise<{ records: EvidenceRecord[]; coverage: EvidenceCoverage }> {
  return getJson(`/api/evidence?packageId=${encodeURIComponent(packageId)}`);
}

export async function getComponentContent(packageId: string, componentId: string): Promise<ComponentContent> {
  return getJson(`/api/packages/${encodeURIComponent(packageId)}/components/${encodeURIComponent(componentId)}/content`);
}
