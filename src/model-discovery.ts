import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Credential } from "@earendil-works/pi-ai";

import { KIRO_API, type ExtensionConfig, type KiroProviderModelConfig } from "./config.js";
import { profileArnFromCredentials } from "./shared/credentials.js";

export interface RefreshModelsContext {
  credential?: Credential;
  profileArn?: string;
  allowNetwork: boolean;
  force?: boolean;
  signal?: AbortSignal;
  store: { read(): Promise<unknown>; write(entry: unknown): Promise<void> };
}
import { isRecord, nonEmptyString } from "./shared/index.js";

const DEFAULT_REGION = "us-east-1";
const MAX_PAGES = 10;
const MAX_OUTPUT_TOKENS = 32_000;
const MODEL_LIST_ORIGIN = "KIRO_CLI";
const KIRO_TOKEN_CACHE = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json");
const KIRO_PROFILE_DB = join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3");

export interface KiroCliAuth {
  accessToken: string;
  region: string;
  profileArn?: string;
  authMethod?: string;
}

interface DiscoveredModel {
  modelId?: unknown;
  modelName?: unknown;
  modelProvider?: unknown;
  rateMultiplier?: unknown;
  rateUnit?: unknown;
  tokenLimits?: { maxInputTokens?: unknown };
  additionalModelRequestFieldsSchema?: unknown;
}

interface ModelCatalogResponse {
  models?: unknown;
  defaultModel?: { modelId?: unknown };
  nextToken?: unknown;
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function profileArnFromValue(value: string | undefined): string | undefined {
  const parsed = parseJson(value);
  return nonEmptyString(parsed?.arn) ?? nonEmptyString(parsed?.profileArn);
}

function tokenFromValue(value: string | undefined, fallbackAuthMethod?: string): KiroCliAuth | undefined {
  const parsed = parseJson(value);
  const accessToken = nonEmptyString(parsed?.accessToken) ?? nonEmptyString(parsed?.access_token);
  const expiresAt = parseExpiry(parsed?.expiresAt ?? parsed?.expires_at);
  if (!accessToken || (expiresAt !== undefined && expiresAt <= Date.now())) return undefined;
  const region = nonEmptyString(parsed?.region) ?? DEFAULT_REGION;
  const authMethod = nonEmptyString(parsed?.authMethod) ?? nonEmptyString(parsed?.auth_method) ?? nonEmptyString(parsed?.oauth_flow) ?? fallbackAuthMethod;
  const profileArn = nonEmptyString(parsed?.profileArn) ?? nonEmptyString(parsed?.profile_arn);
  return {
    accessToken,
    region,
    ...(profileArn ? { profileArn } : {}),
    ...(authMethod ? { authMethod } : {}),
  };
}

/**
 * Read Kiro CLI's current local credential cache. Token values never leave this
 * function except as the returned in-memory credential used by discovery.
 * `input` is injectable so parsing stays deterministic and testable.
 */
interface LocalKiroAuthValues {
  tokenValue?: string;
  authKvValues?: Record<string, string | undefined>;
  profileValue?: string;
}

const KIRO_TOKEN_KEYS: Array<{ key: string; authMethod: string }> = [
  { key: "kirocli:odic:token", authMethod: "IdC" },
  { key: "kirocli:social:token", authMethod: "social" },
  { key: "kirocli:external-idp:token", authMethod: "external_idp" },
];

function readSqliteAuthValues(): LocalKiroAuthValues {
  const databaseModule = requireNodeSqlite();
  if (!databaseModule) return {};
  let database: InstanceType<typeof databaseModule.DatabaseSync> | undefined;
  try {
    database = new databaseModule.DatabaseSync(KIRO_PROFILE_DB, { readOnly: true });
    const tokenRows = database.prepare("SELECT key, value FROM auth_kv WHERE key IN (?, ?, ?)").all(...KIRO_TOKEN_KEYS.map(({ key }) => key)) as Array<{ key?: string; value?: string }>;
    const authKvValues = Object.fromEntries(tokenRows.flatMap((row) => row.key ? [[row.key, row.value]] : []));
    const profileRow = database.prepare("SELECT value FROM state WHERE key = 'api.codewhisperer.profile'").get() as { value?: string } | undefined;
    return { authKvValues, profileValue: profileRow?.value };
  } catch {
    return {};
  } finally {
    database?.close();
  }
}

export function readKiroCliAuth(input?: { tokenValue?: string; authKvValue?: string; authKvValues?: Record<string, string | undefined>; profileValue?: string }): KiroCliAuth | undefined {
  const sqliteValues = input === undefined ? readSqliteAuthValues() : {};
  const profileArn = profileArnFromValue(input?.profileValue ?? sqliteValues.profileValue);
  const explicitToken = input?.tokenValue ?? input?.authKvValue;
  if (explicitToken !== undefined) {
    const auth = tokenFromValue(explicitToken);
    if (!auth) return undefined;
    return profileArn ? { ...auth, profileArn } : auth;
  }

  const authKvValues = input?.authKvValues ?? sqliteValues.authKvValues;
  for (const { key, authMethod } of KIRO_TOKEN_KEYS) {
    const auth = tokenFromValue(authKvValues?.[key], authMethod);
    if (!auth) continue;
    return profileArn && !auth.profileArn ? { ...auth, profileArn } : auth;
  }

  let tokenValue: string;
  try {
    tokenValue = readFileSync(KIRO_TOKEN_CACHE, "utf8");
  } catch {
    return undefined;
  }
  const auth = tokenFromValue(tokenValue);
  if (!auth) return undefined;
  return profileArn ? { ...auth, profileArn } : auth;
}

function effortDetails(schema: unknown): { levels: string[]; defaultLevel?: string; path: "reasoning" | "output_config" } | undefined {
  if (!isRecord(schema)) return undefined;
  const candidates = [
    { value: isRecord(schema.properties) && isRecord(schema.properties.reasoning) ? schema.properties.reasoning : undefined, path: "reasoning" as const },
    { value: isRecord(schema.properties) && isRecord(schema.properties.output_config) ? schema.properties.output_config : undefined, path: "output_config" as const },
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate.value) || !isRecord(candidate.value.properties)) continue;
    const effort = candidate.value.properties.effort;
    if (!isRecord(effort) || !Array.isArray(effort.enum)) continue;
    const levels = effort.enum.filter((level): level is string => typeof level === "string" && level.length > 0);
    if (levels.length > 0) return { levels, defaultLevel: nonEmptyString(effort.default), path: candidate.path };
  }
  return undefined;
}

function thinkingLevelMap(levels: string[]): Record<string, string | null> {
  const low = levels[0];
  const high = levels.at(-1) ?? low;
  return { off: null, minimal: low ?? null, low: low ?? null, medium: high ?? null, high: high ?? null, xhigh: high ?? null };
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function normalizeDiscoveredModels(response: { models?: unknown; defaultModel?: unknown }): KiroProviderModelConfig[] {
  if (!Array.isArray(response.models)) return [];
  return response.models.flatMap((raw): KiroProviderModelConfig[] => {
    if (!isRecord(raw)) return [];
    const model = raw as DiscoveredModel;
    const id = nonEmptyString(model.modelId);
    if (!id) return [];
    const name = nonEmptyString(model.modelName) ?? id;
    const effort = effortDetails(model.additionalModelRequestFieldsSchema);
    const contextWindow = positiveNumber(model.tokenLimits?.maxInputTokens) ?? 200_000;
    const output: KiroProviderModelConfig = {
      id,
      name,
      api: KIRO_API,
      reasoning: Boolean(effort),
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: MAX_OUTPUT_TOKENS,
      importOwnership: "model-discovery",
    };
    if (effort) output.thinkingLevelMap = thinkingLevelMap(effort.levels);
    const rateMultiplier = positiveNumber(model.rateMultiplier);
    if (rateMultiplier !== undefined) output.rateMultiplier = rateMultiplier;
    const rateUnit = nonEmptyString(model.rateUnit);
    if (rateUnit) output.rateUnit = rateUnit;
    return [output];
  });
}

function tokenType(authMethod: string | undefined): string | undefined {
  if (authMethod === "external_idp") return "EXTERNAL_IDP";
  if (authMethod === "machine_token") return "KIRO_MACHINE_TOKEN";
  if (authMethod === "api_key") return "API_KEY";
  if (authMethod === "IdC") return "SSO_OIDC";
  return undefined;
}

function profileFromSqlite(): string | undefined {
  try {
    // node:sqlite is available in the Node versions used by current Pi/Kiro.
    // Keep this dynamic so older Node versions can still use token discovery.
    const databaseModule = requireNodeSqlite();
    if (!databaseModule) return undefined;
    const database = new databaseModule.DatabaseSync(KIRO_PROFILE_DB, { readOnly: true });
    const row = database.prepare("SELECT value FROM state WHERE key = 'api.codewhisperer.profile'").get() as { value?: string } | undefined;
    database.close();
    return profileArnFromValue(row?.value);
  } catch {
    return undefined;
  }
}

function requireNodeSqlite(): typeof import("node:sqlite") | undefined {
  try {
    return (process.getBuiltinModule?.("node:sqlite") ?? undefined) as typeof import("node:sqlite") | undefined;
  } catch {
    return undefined;
  }
}

function authFromContext(context: RefreshModelsContext): KiroCliAuth | undefined {
  const credential = context.credential;
  if (credential?.type === "oauth" && nonEmptyString(credential.access)) {
    const localAuth = readKiroCliAuth();
    const profileArn = profileArnFromCredentials(credential) ?? nonEmptyString(context.profileArn) ?? localAuth?.profileArn ?? profileFromSqlite();
    return {
      accessToken: credential.access,
      region: nonEmptyString(credential.region) ?? localAuth?.region ?? DEFAULT_REGION,
      ...(profileArn ? { profileArn } : {}),
      authMethod: nonEmptyString(credential.authMethod) ?? localAuth?.authMethod,
    };
  }
  const auth = readKiroCliAuth();
  if (!auth) return undefined;
  return auth.profileArn ? auth : { ...auth, profileArn: profileFromSqlite() };
}

export async function discoverKiroModels(context: RefreshModelsContext): Promise<KiroProviderModelConfig[]> {
  if (!context.allowNetwork) return [];
  const auth = authFromContext(context);
  if (!auth) return [];
  const region = nonEmptyString(auth.region) ?? DEFAULT_REGION;
  const endpoint = `https://management.${region}.kiro.dev/`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-amz-json-1.0",
    "x-amz-target": "KiroControlPlaneBearerService.ListAvailableModels",
    Authorization: `Bearer ${auth.accessToken}`,
  };
  const type = tokenType(auth.authMethod);
  if (type) headers.TokenType = type;
  const models: KiroProviderModelConfig[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body: Record<string, unknown> = { origin: MODEL_LIST_ORIGIN };
    if (auth.profileArn) body.profileArn = auth.profileArn;
    if (nextToken) body.nextToken = nextToken;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: context.signal,
    });
    if (!response.ok) throw new Error(`Kiro model discovery failed with HTTP ${response.status}.`);
    const payload = (await response.json()) as ModelCatalogResponse;
    models.push(...normalizeDiscoveredModels(payload));
    const candidate = nonEmptyString(payload.nextToken);
    if (!candidate) break;
    nextToken = candidate;
  }
  return models;
}

export function createKiroModelRefresher(config: ExtensionConfig, fallbackModels: KiroProviderModelConfig[], logger: { warn(event: string, fields: Record<string, unknown>): void }): (context: RefreshModelsContext) => Promise<KiroProviderModelConfig[]> {
  return async (context) => {
    try {
      const discovered = await discoverKiroModels(context);
      if (discovered.length > 0) return discovered;
    } catch (error) {
      logger.warn("model_discovery_failed", { providerId: config.providerId, error: error instanceof Error ? error.message : String(error) });
    }
    return fallbackModels;
  };
}
