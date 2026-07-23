import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const buildDir = process.env.PI_KIRO_PROVIDER_BUILD_DIR;
if (!buildDir) throw new Error("PI_KIRO_PROVIDER_BUILD_DIR is required.");
const fromBuild = (path) => pathToFileURL(join(buildDir, path)).href;
const {
  parseKiroUsage,
  formatKiroUsage,
  primaryUsageResource,
  epochMsFrom,
  fetchKiroUsage,
  getKiroUsage,
  resolveKiroUsageAuth,
  KiroUsageError,
} = await import(fromBuild("src/usage.js"));

const CODEWHISPERER_CONFIG = {
  upstreamUrl: "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
  endpoint: "codewhisperer",
};

test("parseKiroUsage maps the current usageBreakdownList response shape", () => {
  const usage = parseKiroUsage({
    subscriptionInfo: { subscriptionTitle: "KIRO PRO", type: "Q_DEVELOPER_STANDALONE_PRO", overageCapability: "OVERAGE_CAPABLE" },
    overageConfiguration: { overageStatus: "ENABLED" },
    usageBreakdownList: [
      {
        resourceType: "CREDIT",
        currentUsage: 132,
        currentUsageWithPrecision: 132.29,
        usageLimit: 1000,
        overageCap: 10000,
        overageRate: 0.04,
        currentOverages: 0,
        currency: "USD",
        nextDateReset: 1.780272e9,
      },
    ],
    userInfo: { email: "dev@example.com", userId: "sso-uuid" },
    daysUntilReset: 12,
  });

  assert.equal(usage.subscriptionTitle, "KIRO PRO");
  assert.equal(usage.subscriptionType, "Q_DEVELOPER_STANDALONE_PRO");
  assert.equal(usage.overageCapable, true);
  assert.equal(usage.overageStatus, "ENABLED");
  assert.equal(usage.userEmail, "dev@example.com");
  assert.equal(usage.daysUntilReset, 12);

  const credit = primaryUsageResource(usage);
  assert.equal(credit.resourceType, "CREDIT");
  assert.equal(credit.currentUsage, 132.29);
  assert.equal(credit.usageLimit, 1000);
  assert.equal(credit.remaining, 867.71);
  assert.equal(credit.overageRate, 0.04);
  assert.equal(credit.overageCap, 10000);
  // 1.780272e9 seconds -> milliseconds
  assert.equal(credit.nextDateReset, 1_780_272_000_000);
  assert.ok(Math.abs(credit.percentUsed - 0.13229) < 1e-9);
});

test("parseKiroUsage tolerates the legacy limits[] shape", () => {
  const usage = parseKiroUsage({
    limits: [
      { type: "AGENTIC_REQUEST", currentUsage: 25, totalUsageLimit: 50, percentUsed: 0.5 },
    ],
    nextDateReset: 1780272000,
  });

  const primary = primaryUsageResource(usage);
  assert.equal(primary.resourceType, "AGENTIC_REQUEST");
  assert.equal(primary.currentUsage, 25);
  assert.equal(primary.usageLimit, 50);
  assert.equal(primary.percentUsed, 0.5);
  assert.equal(primary.remaining, 25);
  assert.equal(usage.nextDateReset, 1_780_272_000_000);
});

test("parseKiroUsage reads free-trial pools from both layouts", () => {
  const topLevel = parseKiroUsage({
    usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: 0, usageLimit: 50 }],
    freeTrialInfo: { freeTrialStatus: "ACTIVE", currentUsage: 106.11, usageLimit: 500, daysRemaining: 27 },
  });
  assert.deepEqual(topLevel.freeTrial, { status: "ACTIVE", currentUsage: 106.11, usageLimit: 500, daysRemaining: 27 });

  const nested = parseKiroUsage({
    usageBreakdowns: [
      {
        resourceType: "CREDIT",
        currentUsage: 0,
        usageLimit: 50,
        freeTrialUsage: { currentUsage: 10, usageLimit: 100, expiryDate: "2026-05-03T15:09:55.196Z", daysRemaining: 27 },
      },
    ],
  });
  assert.equal(nested.freeTrial.currentUsage, 10);
  assert.equal(nested.freeTrial.usageLimit, 100);
  assert.equal(nested.freeTrial.daysRemaining, 27);
  assert.equal(nested.freeTrial.expiry, Date.parse("2026-05-03T15:09:55.196Z"));
});

test("epochMsFrom normalizes seconds, milliseconds, scientific notation, and ISO", () => {
  assert.equal(epochMsFrom(1_780_272_000), 1_780_272_000_000);
  assert.equal(epochMsFrom(1_780_272_000_000), 1_780_272_000_000);
  assert.equal(epochMsFrom(1.780272e9), 1_780_272_000_000);
  assert.equal(epochMsFrom("1.780272E9"), 1_780_272_000_000);
  assert.equal(epochMsFrom("2026-06-01T00:00:00.000Z"), Date.parse("2026-06-01T00:00:00.000Z"));
  assert.equal(epochMsFrom(0), undefined);
  assert.equal(epochMsFrom("nope"), undefined);
  assert.equal(epochMsFrom(undefined), undefined);
});

test("formatKiroUsage renders a kiro-cli-style credit card", () => {
  const text = formatKiroUsage({
    subscriptionTitle: "KIRO PRO",
    subscriptionType: "Q_DEVELOPER_STANDALONE_PRO",
    overageStatus: "ENABLED",
    resources: [
      { resourceType: "CREDIT", currentUsage: 132.29, usageLimit: 1000, percentUsed: 0.13229, remaining: 867.71, overageRate: 0.04, overageCap: 10000, currency: "USD", nextDateReset: Date.parse("2026-06-01T00:00:00.000Z") },
    ],
    freeTrial: { status: "ACTIVE", currentUsage: 106.11, usageLimit: 500, daysRemaining: 27 },
    userEmail: "dev@example.com",
    daysUntilReset: 12,
  });

  assert.match(text, /KIRO PRO/);
  assert.match(text, /\(Q_DEVELOPER_STANDALONE_PRO\)/);
  assert.match(text, /13\.2%/);
  assert.match(text, /132\.29 \/ 1000/);
  assert.match(text, /867\.71 left/);
  assert.match(text, /Resets: 2026-06-01 \(in 12d\)/);
  assert.match(text, /Overage: enabled/);
  assert.match(text, /USD 0\.04\/credit/);
  assert.match(text, /Bonus credits: 106\.11 \/ 500 used · active · expires in 27d/);
  assert.match(text, /Account: dev@example\.com/);
});

test("formatKiroUsage degrades gracefully when no resources are present", () => {
  const text = formatKiroUsage({ resources: [] });
  assert.match(text, /Kiro usage/);
  assert.match(text, /No metered resources/);
});

test("fetchKiroUsage posts GetUsageLimits with bearer auth and parses the response", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  let capturedOptions;
  try {
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return new Response(
        JSON.stringify({
          subscriptionInfo: { subscriptionTitle: "KIRO FREE", type: "Q_DEVELOPER_STANDALONE_FREE" },
          usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: 5, usageLimit: 50 }],
        }),
        { status: 200 },
      );
    };

    const usage = await fetchKiroUsage(CODEWHISPERER_CONFIG, {
      accessToken: "secret-token",
      region: "us-east-1",
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/test",
      authMethod: "IdC",
    });

    assert.equal(capturedUrl, "https://codewhisperer.us-east-1.amazonaws.com/");
    assert.equal(capturedOptions.method, "POST");
    assert.equal(capturedOptions.headers["X-Amz-Target"], "AmazonCodeWhispererService.GetUsageLimits");
    assert.equal(capturedOptions.headers.Authorization, "Bearer secret-token");
    assert.equal(capturedOptions.headers["Content-Type"], "application/x-amz-json-1.0");
    assert.equal(capturedOptions.headers.TokenType, "SSO_OIDC");
    assert.deepEqual(JSON.parse(capturedOptions.body), {
      resourceType: "AGENTIC_REQUEST",
      isEmailRequired: true,
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/test",
    });
    assert.equal(usage.subscriptionTitle, "KIRO FREE");
    assert.equal(primaryUsageResource(usage).usageLimit, 50);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchKiroUsage raises a reauth error on HTTP 403", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ __type: "com.amazon.aws.codewhisperer#AccessDeniedException", message: "The bearer token included in the request is invalid." }), { status: 403 });

    await assert.rejects(
      () => fetchKiroUsage(CODEWHISPERER_CONFIG, { accessToken: "expired", region: "us-east-1" }),
      (error) => {
        assert.ok(error instanceof KiroUsageError);
        assert.equal(error.status, 403);
        assert.equal(error.reauth, true);
        assert.match(error.message, /HTTP 403/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getKiroUsage prefers a managed OAuth credential and derives the profile ARN", async () => {
  const originalFetch = globalThis.fetch;
  let capturedOptions;
  try {
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return new Response(JSON.stringify({ usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: 1, usageLimit: 50 }] }), { status: 200 });
    };

    const { usage, source } = await getKiroUsage(CODEWHISPERER_CONFIG, {
      type: "oauth",
      access: "managed-token",
      region: "us-east-1",
      profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/managed",
      authMethod: "builder-id",
    });

    assert.equal(source, "managed");
    assert.equal(capturedOptions.headers.Authorization, "Bearer managed-token");
    // builder-id has no TokenType header mapping
    assert.equal(capturedOptions.headers.TokenType, undefined);
    assert.equal(JSON.parse(capturedOptions.body).profileArn, "arn:aws:codewhisperer:us-east-1:123:profile/managed");
    assert.equal(primaryUsageResource(usage).usageLimit, 50);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveKiroUsageAuth returns the managed credential when present", () => {
  const resolved = resolveKiroUsageAuth(CODEWHISPERER_CONFIG, {
    type: "oauth",
    access: "managed-token",
    region: "us-west-2",
    profileArn: "arn:aws:codewhisperer:us-west-2:123:profile/managed",
    authMethod: "google",
  });

  assert.equal(resolved.source, "managed");
  assert.deepEqual(resolved.auth, {
    accessToken: "managed-token",
    region: "us-west-2",
    profileArn: "arn:aws:codewhisperer:us-west-2:123:profile/managed",
    authMethod: "google",
  });
});
