import { getJson, putJson } from "./http";
import type { QualityGateProfile, TrustPolicy } from "./types";

export async function getQualityProfile(): Promise<QualityGateProfile> {
  return (await getJson<{ profile: QualityGateProfile }>("/api/quality-gate/profile")).profile;
}

export async function getTrustPolicy(): Promise<TrustPolicy> {
  return (await getJson<{ policy: TrustPolicy }>("/api/quality-gate/trust-policy")).policy;
}

export async function updateQualityProfile(config: Record<string, unknown>): Promise<QualityGateProfile> {
  return (await putJson<{ profile: QualityGateProfile }>("/api/quality-gate/profile", { config })).profile;
}
