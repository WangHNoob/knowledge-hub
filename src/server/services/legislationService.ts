import { createHash } from "node:crypto";
import { nanoid } from "nanoid";

import type { DatabaseHandle, KnowledgeRuleConfig, KnowledgeRuleProfile } from "../types";

export function createLegislationService(db: DatabaseHandle): LegislationService {
  return new LegislationService(db);
}

export class LegislationService {
  private readonly adapter;

  constructor(private readonly db: DatabaseHandle) {
    this.adapter = db.adapter;
  }

  async getActiveProfile(): Promise<KnowledgeRuleProfile> {
    const { rows } = await this.adapter.query("SELECT * FROM knowledge_rule_profiles WHERE active = true ORDER BY updated_at DESC LIMIT 1");
    if (!rows.length) throw new Error("No active knowledge rule profile.");
    return this.mapAndPersistHash(rows[0]);
  }

  async listProfiles(): Promise<KnowledgeRuleProfile[]> {
    const { rows } = await this.adapter.query("SELECT * FROM knowledge_rule_profiles ORDER BY updated_at DESC");
    return Promise.all(rows.map((row) => this.mapAndPersistHash(row)));
  }

  async createProfile(input: { name: string; config: KnowledgeRuleConfig; createdBy: string; activate?: boolean }): Promise<KnowledgeRuleProfile> {
    const profileId = `krp_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${nanoid(6)}`;
    const config = normalizeRuleConfig(input.config);
    const hash = hashRuleConfig(config);
    const now = new Date().toISOString();

    await this.adapter.query("BEGIN");
    try {
      if (input.activate) {
        await this.adapter.query("UPDATE knowledge_rule_profiles SET active = false WHERE active = true");
      }
      await this.adapter.query(
        `INSERT INTO knowledge_rule_profiles (profile_id, name, active, hash, config_json, created_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [profileId, input.name, Boolean(input.activate), hash, JSON.stringify(config), input.createdBy, now],
      );
      await this.adapter.query("COMMIT");
    } catch (error) {
      await this.adapter.query("ROLLBACK");
      throw error;
    }

    const profile = await this.getProfile(profileId);
    if (!profile) throw new Error("Failed to create knowledge rule profile.");
    return profile;
  }

  async activateProfile(profileId: string, activatedBy: string): Promise<KnowledgeRuleProfile> {
    const profile = await this.getProfile(profileId);
    if (!profile) throw new Error(`Unknown knowledge rule profile: ${profileId}`);
    const now = new Date().toISOString();
    await this.adapter.query("BEGIN");
    try {
      await this.adapter.query("UPDATE knowledge_rule_profiles SET active = false WHERE active = true");
      await this.adapter.query(
        "UPDATE knowledge_rule_profiles SET active = true, updated_at = $2, created_by = COALESCE(NULLIF(created_by, ''), $3) WHERE profile_id = $1",
        [profileId, now, activatedBy],
      );
      await this.adapter.query("COMMIT");
    } catch (error) {
      await this.adapter.query("ROLLBACK");
      throw error;
    }
    return this.getActiveProfile();
  }

  async getProfile(profileId: string): Promise<KnowledgeRuleProfile | null> {
    const { rows } = await this.adapter.query("SELECT * FROM knowledge_rule_profiles WHERE profile_id = $1", [profileId]);
    return rows.length ? this.mapAndPersistHash(rows[0]) : null;
  }

  private async mapAndPersistHash(row: Record<string, unknown>): Promise<KnowledgeRuleProfile> {
    const profile = mapProfile(row);
    if (profile.hash) return profile;
    const hash = hashRuleConfig(profile.config);
    await this.adapter.query("UPDATE knowledge_rule_profiles SET hash = $2 WHERE profile_id = $1", [profile.profileId, hash]);
    return { ...profile, hash };
  }
}

export function hashRuleConfig(config: KnowledgeRuleConfig): string {
  return `sha256:${createHash("sha256").update(stableStringify(normalizeRuleConfig(config))).digest("hex")}`;
}

export function normalizeRuleConfig(input: KnowledgeRuleConfig): KnowledgeRuleConfig {
  return {
    pageTypes: Object.fromEntries(
      Object.entries(input.pageTypes ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, value]) => [id, {
          id: value.id || id,
          label: value.label || id,
          dir: value.dir || `${id}s`,
          template: value.template || `${id}.md`,
          requiredSections: [...(value.requiredSections ?? [])].map(String),
          requiredFacts: [...(value.requiredFacts ?? [])].map(String),
          evidenceRequired: Boolean(value.evidenceRequired),
          publishable: value.publishable !== false,
        }]),
    ),
    entityTypes: [...(input.entityTypes ?? [])]
      .map((item) => ({ id: item.id, label: item.label || item.id, publishable: item.publishable !== false }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    relationTypes: [...(input.relationTypes ?? [])]
      .map((item) => ({
        id: item.id,
        label: item.label || item.id,
        direction: item.direction === "bidirectional" ? "bidirectional" as const : "source_to_target" as const,
        publishable: item.publishable !== false,
        autoGenerated: Boolean(item.autoGenerated),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    tableRules: {
      autoConfirmFieldIdSuffixes: [...(input.tableRules?.autoConfirmFieldIdSuffixes ?? [])].map(String),
      candidateFieldIdSuffixes: [...(input.tableRules?.candidateFieldIdSuffixes ?? [])].map(String),
    },
    qualityRules: Object.fromEntries(Object.entries(input.qualityRules ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function mapProfile(row: Record<string, unknown>): KnowledgeRuleProfile {
  return {
    profileId: String(row.profile_id),
    name: String(row.name),
    active: Boolean(row.active),
    hash: String(row.hash ?? ""),
    config: normalizeRuleConfig(jsonObject(row.config_json) as unknown as KnowledgeRuleConfig),
    createdBy: String(row.created_by ?? ""),
    updatedAt: String(row.updated_at),
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.length > 0) {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  }
  return {};
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
