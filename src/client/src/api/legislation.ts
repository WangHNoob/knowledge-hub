import { getJson, postJson } from "./http";
import type { AnnotationExample, KnowledgeRuleConfig, KnowledgeRuleProfile } from "./types";

export async function getLegislationProfile(): Promise<{ profile: KnowledgeRuleProfile; profiles: KnowledgeRuleProfile[] }> {
  return getJson<{ profile: KnowledgeRuleProfile; profiles: KnowledgeRuleProfile[] }>("/api/legislation/profile");
}

export async function createLegislationProfile(input: { name: string; config: KnowledgeRuleConfig; activate: boolean }): Promise<KnowledgeRuleProfile> {
  return (await postJson<{ profile: KnowledgeRuleProfile }>("/api/legislation/profile", input)).profile;
}

export async function activateLegislationProfile(profileId: string): Promise<KnowledgeRuleProfile> {
  return (await postJson<{ profile: KnowledgeRuleProfile }>("/api/legislation/profile/activate", { profileId })).profile;
}

export async function listAnnotationExamples(): Promise<AnnotationExample[]> {
  return (await getJson<{ examples: AnnotationExample[] }>("/api/legislation/annotation-examples")).examples;
}

export async function setAnnotationExampleActive(exampleId: string, active: boolean): Promise<AnnotationExample> {
  return (await postJson<{ example: AnnotationExample }>(
    `/api/legislation/annotation-examples/${encodeURIComponent(exampleId)}/active`,
    { active },
  )).example;
}
