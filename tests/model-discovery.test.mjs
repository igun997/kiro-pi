import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const buildDir = process.env.PI_KIRO_PROVIDER_BUILD_DIR;
if (!buildDir) throw new Error("PI_KIRO_PROVIDER_BUILD_DIR is required.");
const fromBuild = (path) => pathToFileURL(join(buildDir, path)).href;
const { normalizeDiscoveredModels, readKiroCliAuth } = await import(fromBuild("src/model-discovery.js"));

test("normalizeDiscoveredModels maps Kiro catalog metadata to Pi models", () => {
  const models = normalizeDiscoveredModels({
    models: [
      {
        modelId: "claude-sonnet-4.7",
        modelName: "Claude Sonnet 4.7",
        modelProvider: "Anthropic",
        rateMultiplier: 1.3,
        rateUnit: "Credit",
        tokenLimits: { maxInputTokens: 250000 },
        additionalModelRequestFieldsSchema: {
          properties: { reasoning: { properties: { effort: { enum: ["low", "high"], default: "low" } } } },
        },
      },
    ],
    defaultModel: { modelId: "claude-sonnet-4.7" },
  });

  assert.equal(models.length, 1);
  assert.deepEqual(models[0], {
    id: "claude-sonnet-4.7",
    name: "Claude Sonnet 4.7",
    api: "kiro",
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high" },
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 250000,
    maxTokens: 32000,
    rateMultiplier: 1.3,
    rateUnit: "Credit",
    importOwnership: "model-discovery",
  });
});

test("readKiroCliAuth reads token and profile from injected SQLite rows without exposing storage paths", () => {
  const auth = readKiroCliAuth({
    tokenValue: JSON.stringify({ access_token: "secret", expires_at: new Date(Date.now() + 60_000).toISOString(), region: "eu-west-1" }),
    profileValue: JSON.stringify({ arn: "arn:aws:codewhisperer:eu-west-1:123:profile/x" }),
  });

  assert.deepEqual(auth, {
    accessToken: "secret",
    region: "eu-west-1",
    profileArn: "arn:aws:codewhisperer:eu-west-1:123:profile/x",
  });
});

test("readKiroCliAuth reads Kiro CLI SQLite auth when AWS cache file is absent", () => {
  const auth = readKiroCliAuth({
    authKvValue: JSON.stringify({
      access_token: "secret",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      region: "us-east-1",
      auth_method: "IdC",
    }),
    profileValue: JSON.stringify({ arn: "arn:aws:codewhisperer:us-east-1:123:profile/x" }),
  });

  assert.deepEqual(auth, {
    accessToken: "secret",
    region: "us-east-1",
    profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/x",
    authMethod: "IdC",
  });
});

test("readKiroCliAuth falls back to social SQLite token shapes", () => {
  const auth = readKiroCliAuth({
    authKvValues: {
      "kirocli:social:token": JSON.stringify({
        accessToken: "social-secret",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        region: "us-west-2",
        profileArn: "arn:aws:codewhisperer:us-west-2:123:profile/social",
      }),
    },
  });

  assert.deepEqual(auth, {
    accessToken: "social-secret",
    region: "us-west-2",
    profileArn: "arn:aws:codewhisperer:us-west-2:123:profile/social",
    authMethod: "social",
  });
});

test("readKiroCliAuth rejects expired or incomplete cache", () => {
  assert.equal(readKiroCliAuth({ tokenValue: JSON.stringify({ access_token: "secret", expires_at: "2000-01-01T00:00:00.000Z" }) }), undefined);
  assert.equal(readKiroCliAuth({ expiresAt: new Date(Date.now() + 60_000).toISOString() }), undefined);
});
