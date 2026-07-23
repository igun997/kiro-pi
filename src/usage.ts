import type { Credential } from "@earendil-works/pi-ai";

import type { ExtensionConfig } from "./config.js";
import { redactSensitiveString } from "./debug-logger.js";
import { kiroTokenTypeHeader, readKiroCliAuth, readKiroCliProfileArn, type KiroCliAuth } from "./model-discovery.js";
import { isRecord, nonEmptyString, profileArnFromCredentials, readJsonResponse, type JsonRecord } from "./shared/index.js";

const DEFAULT_REGION = "us-east-1";
const USAGE_TARGET = "AmazonCodeWhispererService.GetUsageLimits";
const USAGE_RESOURCE_TYPE = "AGENTIC_REQUEST";
const USAGE_NON_OBJECT_MESSAGE = "Kiro usage lookup returned a non-object JSON response.";
const EPOCH_SECONDS_CEILING = 10_000_000_000;
const PROGRESS_BAR_WIDTH = 24;

/** Bearer identity used to authorize a usage lookup. */
export interface KiroUsageAuth {
  accessToken: string;
  region: string;
  profileArn?: string;
  authMethod?: string;
}

/** Where the usage lookup credential came from. */
export type KiroUsageAuthSource = "managed" | "kiro-cli";

/** A single metered resource line (e.g. monthly credits). */
export interface KiroUsageResource {
  resourceType: string;
  displayName?: string;
  currentUsage: number;
  usageLimit?: number;
  percentUsed?: number;
  remaining?: number;
  overageCap?: number;
  overageRate?: number;
  currentOverages?: number;
  currency?: string;
  nextDateReset?: number;
}

/** Free-trial / bonus credit pool. */
export interface KiroUsageFreeTrial {
  status?: string;
  currentUsage?: number;
  usageLimit?: number;
  expiry?: number;
  daysRemaining?: number;
}

/** Normalized Kiro account usage, independent of the raw wire shape. */
export interface KiroUsage {
  subscriptionTitle?: string;
  subscriptionType?: string;
  overageCapable?: boolean;
  overageStatus?: string;
  resources: KiroUsageResource[];
  freeTrial?: KiroUsageFreeTrial;
  nextDateReset?: number;
  daysUntilReset?: number;
  userEmail?: string;
  userId?: string;
}

function firstNumber(source: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function firstString(source: JsonRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(source[key]);
    if (value) return value;
  }
  return undefined;
}

function firstRecord(source: JsonRecord, keys: readonly string[]): JsonRecord | undefined {
  for (const key of keys) {
    if (isRecord(source[key])) return source[key] as JsonRecord;
  }
  return undefined;
}

/**
 * Normalize a Kiro reset timestamp to epoch milliseconds.
 *
 * Kiro emits this field inconsistently: integer epoch seconds, scientific
 * notation floats (`1.780272E9`), epoch milliseconds, and occasionally ISO
 * strings. Values at or below the seconds ceiling are scaled to ms.
 */
export function epochMsFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > EPOCH_SECONDS_CEILING ? Math.round(value) : Math.round(value * 1000);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > EPOCH_SECONDS_CEILING ? Math.round(numeric) : Math.round(numeric * 1000);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function positiveOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseResource(raw: unknown): KiroUsageResource | undefined {
  if (!isRecord(raw)) return undefined;
  const resourceType = firstString(raw, ["resourceType", "type", "resource_type"]) ?? "UNKNOWN";
  const currentUsage = firstNumber(raw, ["currentUsageWithPrecision", "currentUsage", "current_usage"]) ?? 0;
  const usageLimit = positiveOrUndefined(firstNumber(raw, ["usageLimit", "totalUsageLimit", "usage_limit", "total_usage_limit"]));
  const explicitPercent = firstNumber(raw, ["percentUsed", "percent_used"]);
  const percentUsed = explicitPercent !== undefined
    ? (explicitPercent > 1 ? explicitPercent / 100 : explicitPercent)
    : usageLimit
      ? currentUsage / usageLimit
      : undefined;
  const remaining = usageLimit !== undefined ? Math.max(0, usageLimit - currentUsage) : undefined;
  const resource: KiroUsageResource = { resourceType, currentUsage };
  const displayName = firstString(raw, ["displayName", "display_name"]);
  if (displayName) resource.displayName = displayName;
  if (usageLimit !== undefined) resource.usageLimit = usageLimit;
  if (percentUsed !== undefined) resource.percentUsed = percentUsed;
  if (remaining !== undefined) resource.remaining = remaining;
  const overageCap = positiveOrUndefined(firstNumber(raw, ["overageCap", "overage_cap"]));
  if (overageCap !== undefined) resource.overageCap = overageCap;
  const overageRate = positiveOrUndefined(firstNumber(raw, ["overageRate", "overage_rate"]));
  if (overageRate !== undefined) resource.overageRate = overageRate;
  const currentOverages = firstNumber(raw, ["currentOverages", "overageCharges", "current_overages", "overage_charges"]);
  if (currentOverages !== undefined && currentOverages > 0) resource.currentOverages = currentOverages;
  const currency = firstString(raw, ["currency"]);
  if (currency) resource.currency = currency;
  const nextDateReset = epochMsFrom(raw.nextDateReset ?? raw.next_date_reset ?? raw.resetDate);
  if (nextDateReset !== undefined) resource.nextDateReset = nextDateReset;
  return resource;
}

function parseFreeTrial(raw: unknown): KiroUsageFreeTrial | undefined {
  if (!isRecord(raw)) return undefined;
  const freeTrial: KiroUsageFreeTrial = {};
  const status = firstString(raw, ["freeTrialStatus", "free_trial_status", "status"]);
  if (status) freeTrial.status = status;
  const currentUsage = firstNumber(raw, ["currentUsage", "current_usage"]);
  if (currentUsage !== undefined) freeTrial.currentUsage = currentUsage;
  const usageLimit = positiveOrUndefined(firstNumber(raw, ["usageLimit", "usage_limit"]));
  if (usageLimit !== undefined) freeTrial.usageLimit = usageLimit;
  const expiry = epochMsFrom(raw.expiryDate ?? raw.freeTrialExpiry ?? raw.free_trial_expiry ?? raw.expiry);
  if (expiry !== undefined) freeTrial.expiry = expiry;
  const daysRemaining = firstNumber(raw, ["daysRemaining", "days_remaining"]);
  if (daysRemaining !== undefined) freeTrial.daysRemaining = daysRemaining;
  return Object.keys(freeTrial).length > 0 ? freeTrial : undefined;
}

/**
 * Parse a `GetUsageLimits` response into a normalized {@link KiroUsage}.
 *
 * Tolerant of the two documented wire shapes: the current
 * `usageBreakdownList[]` + `subscriptionInfo` layout and the legacy
 * `limits[]`/`usageLimitList[]` layout. Missing fields yield a sparse
 * result rather than an error so shape drift never breaks the lookup.
 */
export function parseKiroUsage(payload: JsonRecord): KiroUsage {
  const usage: KiroUsage = { resources: [] };

  const subscription = firstRecord(payload, ["subscriptionInfo", "subscription_info"]);
  if (subscription) {
    usage.subscriptionTitle = firstString(subscription, ["subscriptionTitle", "subscription_title"]);
    usage.subscriptionType = firstString(subscription, ["type", "subscriptionType"]);
    const overageCapability = firstString(subscription, ["overageCapability", "overage_capability"]);
    if (overageCapability) usage.overageCapable = overageCapability.toUpperCase() === "OVERAGE_CAPABLE";
    if (typeof subscription.overageCapable === "boolean") usage.overageCapable = subscription.overageCapable;
  }

  const overageConfig = firstRecord(payload, ["overageConfiguration", "overage_configuration"]);
  const overageStatus = overageConfig ? firstString(overageConfig, ["overageStatus", "overage_status"]) : undefined;
  if (overageStatus) usage.overageStatus = overageStatus;

  const breakdownList = payload.usageBreakdownList ?? payload.usageBreakdowns ?? payload.usage_breakdown_list ?? payload.limits ?? payload.usageLimitList ?? payload.usage_limit_list;
  if (Array.isArray(breakdownList)) {
    for (const entry of breakdownList) {
      const resource = parseResource(entry);
      if (resource) usage.resources.push(resource);
      const nestedFreeTrial = isRecord(entry) ? parseFreeTrial(entry.freeTrialUsage ?? entry.free_trial_usage) : undefined;
      if (nestedFreeTrial && !usage.freeTrial) usage.freeTrial = nestedFreeTrial;
    }
  }

  const topFreeTrial = parseFreeTrial(firstRecord(payload, ["freeTrialInfo", "free_trial_info"]));
  if (topFreeTrial) usage.freeTrial = topFreeTrial;

  const userInfo = firstRecord(payload, ["userInfo", "user_info"]);
  if (userInfo) {
    usage.userEmail = firstString(userInfo, ["email"]);
    usage.userId = firstString(userInfo, ["userId", "user_id"]);
  }

  const nextDateReset = epochMsFrom(payload.nextDateReset ?? payload.next_date_reset);
  if (nextDateReset !== undefined) usage.nextDateReset = nextDateReset;
  const daysUntilReset = firstNumber(payload, ["daysUntilReset", "days_until_reset"]);
  if (daysUntilReset !== undefined) usage.daysUntilReset = daysUntilReset;

  return usage;
}

/** Pick the resource line most representative of chat/agent spend. */
export function primaryUsageResource(usage: KiroUsage): KiroUsageResource | undefined {
  const byType = (type: string): KiroUsageResource | undefined =>
    usage.resources.find((resource) => resource.resourceType.toUpperCase() === type);
  return byType("CREDIT") ?? byType("AGENTIC_REQUEST") ?? usage.resources[0];
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "");
}

function formatResetDate(epochMs: number): string {
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 10);
}

function daysUntil(epochMs: number): number {
  return Math.max(0, Math.ceil((epochMs - Date.now()) / 86_400_000));
}

function progressBar(percent: number): string {
  const clamped = Math.max(0, Math.min(1, percent));
  const filled = Math.round(clamped * PROGRESS_BAR_WIDTH);
  return `[${"█".repeat(filled)}${"░".repeat(PROGRESS_BAR_WIDTH - filled)}]`;
}

/** Render a normalized usage snapshot as a kiro-cli-style text card. */
export function formatKiroUsage(usage: KiroUsage, options: { source?: KiroUsageAuthSource } = {}): string {
  const lines: string[] = [];
  const planParts = [usage.subscriptionTitle, usage.subscriptionType && usage.subscriptionType !== usage.subscriptionTitle ? `(${usage.subscriptionType})` : undefined].filter(Boolean);
  lines.push(`Kiro usage${planParts.length ? ` — ${planParts.join(" ")}` : ""}`);

  const primary = primaryUsageResource(usage);
  if (primary) {
    const label = primary.displayName ?? (primary.resourceType === "CREDIT" ? "Credits" : primary.resourceType);
    if (primary.usageLimit !== undefined) {
      const percent = primary.percentUsed ?? primary.currentUsage / primary.usageLimit;
      const segments = [
        `${progressBar(percent)} ${(percent * 100).toFixed(1)}%`,
        `${formatNumber(primary.currentUsage)} / ${formatNumber(primary.usageLimit)}`,
      ];
      if (primary.remaining !== undefined) segments.push(`${formatNumber(primary.remaining)} left`);
      lines.push(`${label}: ${segments.join(" · ")}`);
    } else {
      lines.push(`${label}: ${formatNumber(primary.currentUsage)} used`);
    }

    const resetEpoch = primary.nextDateReset ?? usage.nextDateReset;
    if (resetEpoch !== undefined) {
      const days = usage.daysUntilReset ?? daysUntil(resetEpoch);
      lines.push(`Resets: ${formatResetDate(resetEpoch)} (in ${days}d)`);
    } else if (usage.daysUntilReset !== undefined) {
      lines.push(`Resets: in ${usage.daysUntilReset}d`);
    }

    if (usage.overageStatus || usage.overageCapable !== undefined || primary.overageRate !== undefined) {
      const status = usage.overageStatus ?? (usage.overageCapable ? "capable" : "disabled");
      const overageParts = [`Overage: ${status.toLowerCase()}`];
      if (primary.overageRate !== undefined) overageParts.push(`${primary.currency ? `${primary.currency} ` : "$"}${formatNumber(primary.overageRate)}/credit`);
      if (primary.currentOverages !== undefined) overageParts.push(`${formatNumber(primary.currentOverages)} used`);
      if (primary.overageCap !== undefined) overageParts.push(`cap ${formatNumber(primary.overageCap)}`);
      lines.push(overageParts.join(" · "));
    }
  } else {
    lines.push("No metered resources reported for this account.");
  }

  if (usage.freeTrial) {
    const trial = usage.freeTrial;
    const trialParts: string[] = [];
    if (trial.currentUsage !== undefined && trial.usageLimit !== undefined) {
      trialParts.push(`${formatNumber(trial.currentUsage)} / ${formatNumber(trial.usageLimit)} used`);
    } else if (trial.usageLimit !== undefined) {
      trialParts.push(`${formatNumber(trial.usageLimit)} credits`);
    }
    if (trial.status) trialParts.push(trial.status.toLowerCase());
    if (trial.daysRemaining !== undefined) trialParts.push(`expires in ${formatNumber(trial.daysRemaining)}d`);
    else if (trial.expiry !== undefined) trialParts.push(`expires ${formatResetDate(trial.expiry)}`);
    if (trialParts.length) lines.push(`Bonus credits: ${trialParts.join(" · ")}`);
  }

  if (usage.userEmail) lines.push(`Account: ${usage.userEmail}`);
  if (options.source === "kiro-cli") lines.push("Source: Kiro CLI credentials (read-only fallback).");

  return lines.join("\n");
}

function usageEndpoint(config: ExtensionConfig, auth: KiroUsageAuth): string {
  try {
    return `${new URL(config.upstreamUrl).origin}/`;
  } catch {
    const region = nonEmptyString(auth.region) ?? DEFAULT_REGION;
    return config.endpoint === "amazonq"
      ? `https://q.${region}.amazonaws.com/`
      : `https://codewhisperer.${region}.amazonaws.com/`;
  }
}

function usageAuthFromCredential(credential: Credential | undefined, config: ExtensionConfig, cliAuth?: KiroCliAuth): KiroUsageAuth | undefined {
  if (credential?.type !== "oauth" || !nonEmptyString(credential.access)) return undefined;
  const profileArn = profileArnFromCredentials(credential) ?? nonEmptyString(config.profileArn) ?? cliAuth?.profileArn ?? readKiroCliProfileArn();
  const auth: KiroUsageAuth = {
    accessToken: credential.access,
    region: nonEmptyString(credential.region) ?? cliAuth?.region ?? DEFAULT_REGION,
  };
  if (profileArn) auth.profileArn = profileArn;
  const authMethod = nonEmptyString(credential.authMethod) ?? cliAuth?.authMethod;
  if (authMethod) auth.authMethod = authMethod;
  return auth;
}

/**
 * Resolve the credential used to look up usage.
 *
 * Prefers Pi's managed `kiro` OAuth credential and falls back to read-only
 * local Kiro CLI state, mirroring how model discovery selects auth. Returns
 * `undefined` when no valid credential is available.
 */
export function resolveKiroUsageAuth(config: ExtensionConfig, credential?: Credential): { auth: KiroUsageAuth; source: KiroUsageAuthSource } | undefined {
  const cliAuth = readKiroCliAuth();
  const managed = usageAuthFromCredential(credential, config, cliAuth);
  if (managed) return { auth: managed, source: "managed" };
  if (!cliAuth) return undefined;
  const auth: KiroUsageAuth = {
    accessToken: cliAuth.accessToken,
    region: nonEmptyString(cliAuth.region) ?? DEFAULT_REGION,
  };
  const profileArn = cliAuth.profileArn ?? nonEmptyString(config.profileArn) ?? readKiroCliProfileArn();
  if (profileArn) auth.profileArn = profileArn;
  if (cliAuth.authMethod) auth.authMethod = cliAuth.authMethod;
  return { auth, source: "kiro-cli" };
}

/** Error thrown when a usage lookup cannot complete. */
export class KiroUsageError extends Error {
  readonly status?: number;
  readonly reauth: boolean;

  constructor(message: string, options: { status?: number; reauth?: boolean; cause?: unknown } = {}) {
    super(redactSensitiveString(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "KiroUsageError";
    if (options.status !== undefined) this.status = options.status;
    this.reauth = options.reauth ?? false;
  }
}

function usageErrorMessage(status: number, body: JsonRecord): string {
  const detail = nonEmptyString(body.message) ?? nonEmptyString(body.__type);
  const base = `Kiro usage lookup failed with HTTP ${status}`;
  return detail ? `${base}: ${detail}` : `${base}.`;
}

/**
 * Call `GetUsageLimits` for the given credential and return normalized usage.
 *
 * The bearer token is sent only to the configured Kiro management endpoint;
 * it is never logged. Throws {@link KiroUsageError} on HTTP failure.
 */
export async function fetchKiroUsage(config: ExtensionConfig, auth: KiroUsageAuth, options: { signal?: AbortSignal } = {}): Promise<KiroUsage> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-amz-json-1.0",
    "X-Amz-Target": USAGE_TARGET,
    Authorization: `Bearer ${auth.accessToken}`,
  };
  const tokenType = kiroTokenTypeHeader(auth.authMethod);
  if (tokenType) headers.TokenType = tokenType;

  const body: JsonRecord = { resourceType: USAGE_RESOURCE_TYPE, isEmailRequired: true };
  if (auth.profileArn) body.profileArn = auth.profileArn;

  let response: Response;
  try {
    response = await fetch(usageEndpoint(config, auth), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    throw new KiroUsageError("Kiro usage lookup request failed before a response was received.", { cause: error });
  }

  const payload = await readJsonResponse(response, USAGE_NON_OBJECT_MESSAGE);
  if (!response.ok) {
    const reauth = response.status === 401 || response.status === 403;
    throw new KiroUsageError(usageErrorMessage(response.status, payload), { status: response.status, reauth });
  }
  return parseKiroUsage(payload);
}

/**
 * Resolve auth and fetch usage in one step.
 *
 * Returns the normalized usage plus the credential source, or throws a
 * {@link KiroUsageError} describing why the lookup could not run.
 */
export async function getKiroUsage(config: ExtensionConfig, credential?: Credential, options: { signal?: AbortSignal } = {}): Promise<{ usage: KiroUsage; source: KiroUsageAuthSource }> {
  const resolved = resolveKiroUsageAuth(config, credential);
  if (!resolved) {
    throw new KiroUsageError("No Kiro credential available. Run /login kiro or authenticate with kiro-cli, then try again.", { reauth: true });
  }
  const usage = await fetchKiroUsage(config, resolved.auth, options);
  return { usage, source: resolved.source };
}
