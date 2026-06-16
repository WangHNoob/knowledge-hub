import { getJson } from "./http";
import type { AssetPackage, EvidenceCoverage, EvidenceRecord, PackageDetail } from "./types";

export async function listPackages(): Promise<AssetPackage[]> {
  return (await getJson<{ packages: AssetPackage[] }>("/api/packages")).packages;
}

export async function getPackage(packageId: string): Promise<PackageDetail> {
  return getJson(`/api/packages/${encodeURIComponent(packageId)}`);
}

export async function listEvidence(packageId: string): Promise<{ records: EvidenceRecord[]; coverage: EvidenceCoverage }> {
  return getJson(`/api/evidence?packageId=${encodeURIComponent(packageId)}`);
}
