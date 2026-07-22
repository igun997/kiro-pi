import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const buildDir = process.env.PI_KIRO_PROVIDER_BUILD_DIR;
if (!buildDir) throw new Error("PI_KIRO_PROVIDER_BUILD_DIR is required.");

const fromBuild = (path) => pathToFileURL(join(buildDir, path)).href;
const { createKiroStream } = await import(fromBuild("src/kiro.js"));
const { crc32 } = await import(fromBuild("src/eventstream.js"));

const encoder = new TextEncoder();

function createLogger() {
  return { debug() {}, warn() {}, error() {} };
}

function createModel() {
  return {
    id: "kiro-test",
    name: "Kiro Test",
    api: "kiro",
    provider: "kiro",
    baseUrl: "https://kiro.example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  };
}

function encodeHeader(name, value) {
  const nameBytes = encoder.encode(name);
  const valueBytes = encoder.encode(value);
  const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let offset = 0;
  header[offset] = nameBytes.length;
  offset += 1;
  header.set(nameBytes, offset);
  offset += nameBytes.length;
  header[offset] = 7;
  offset += 1;
  header[offset] = (valueBytes.length >>> 8) & 0xff;
  header[offset + 1] = valueBytes.length & 0xff;
  offset += 2;
  header.set(valueBytes, offset);
  return header;
}

function concatBytes(chunks) {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function createFrame(eventType, payload) {
  const headerBytes = encodeHeader(":event-type", eventType);
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const totalLength = 12 + headerBytes.length + payloadBytes.length + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headerBytes.length, false);
  view.setUint32(8, crc32(frame.subarray(0, 8)), false);
  frame.set(headerBytes, 12);
  frame.set(payloadBytes, 12 + headerBytes.length);
  view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
  return frame;
}

function createResponse(events) {
  const body = concatBytes(events.map(([eventType, payload]) => createFrame(eventType, payload)));
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  }), { status: 200 });
}

test("Kiro toolUseEvent updates same-id tool calls with latest complete arguments", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => createResponse([
      ["toolUseEvent", { toolUseId: "tooluse_find", name: "find", input: {} }],
      ["toolUseEvent", { toolUseId: "tooluse_find", name: "find", input: { path: "src", pattern: "*.ts" } }],
      ["metricsEvent", { inputTokens: 1, outputTokens: 1 }],
    ]);

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
    }, {}, createLogger())(createModel(), {
      messages: [{ role: "user", content: "find TypeScript files" }],
      tools: [{ name: "find", description: "Find files", parameters: { type: "object" } }],
    });

    const events = [];
    for await (const event of stream) events.push(event);
    const toolStarts = events.filter((event) => event.type === "toolcall_start");
    const toolEnds = events.filter((event) => event.type === "toolcall_end");
    const message = await stream.result();

    assert.equal(toolStarts.length, 1);
    assert.equal(toolEnds.length, 1);
    assert.equal(message.stopReason, "toolUse");
    assert.deepEqual(toolEnds[0].toolCall, {
      type: "toolCall",
      id: "tooluse_find",
      name: "find",
      arguments: { path: "src", pattern: "*.ts" },
    });
    assert.deepEqual(message.content, [toolEnds[0].toolCall]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kiro forwards model profile ARN into request payload", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  try {
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return createResponse([]);
    };

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
    }, {}, createLogger())({
      ...createModel(),
      headers: { "x-kiro-profile-arn": "arn:aws:codewhisperer:us-east-1:123:profile/test" },
    }, {
      messages: [{ role: "user", content: "Reply OK" }],
    });

    for await (const _event of stream) {}
    assert.equal(requestBody.profileArn, "arn:aws:codewhisperer:us-east-1:123:profile/test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kiro serializes Pi image content using CodeWhisperer image blocks", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  try {
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return createResponse([]);
    };

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
    }, {}, createLogger())(createModel(), {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      }],
    });

    for await (const _event of stream) {}
    assert.deepEqual(requestBody.conversationState.currentMessage.userInputMessage.images, [
      { format: "png", source: { bytes: "aGVsbG8=" } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kiro preserves image-only user turns and normalizes JPG MIME", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  try {
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return createResponse([]);
    };

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
    }, {}, createLogger())(createModel(), {
      messages: [{
        role: "user",
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpg" }],
      }],
    });

    for await (const _event of stream) {}
    assert.deepEqual(requestBody.conversationState.currentMessage.userInputMessage, {
      content: "continue",
      modelId: "kiro-test",
      origin: "AI_EDITOR",
      images: [{ format: "jpeg", source: { bytes: "aGVsbG8=" } }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kiro preserves redacted reasoning signatures without visible reasoning text", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => createResponse([
      ["reasoningContentEvent", { redactedContent: "c2VjcmV0", signature: "sig" }],
    ]);

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
    }, {}, createLogger())({ ...createModel(), reasoning: true }, {
      messages: [{ role: "user", content: "Explain" }],
    });

    for await (const _event of stream) {}
    const message = await stream.result();
    assert.deepEqual(message.content, [{
      type: "thinking",
      thinking: "",
      thinkingSignature: "kiro-redacted-v1:eyJyZWRhY3RlZENvbnRlbnQiOiJjMlZqY21WMCIsInNpZ25hdHVyZSI6InNpZyJ9",
      redacted: true,
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kiro replays redacted reasoning content and signature on follow-up turns", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  try {
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return createResponse([]);
    };

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
    }, {}, createLogger())({ ...createModel(), reasoning: true }, {
      messages: [
        { role: "assistant", content: [{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "sig" }] },
        { role: "user", content: "Continue" },
      ],
    });

    for await (const _event of stream) {}
    assert.deepEqual(requestBody.conversationState.history[0].assistantResponseMessage.reasoningContent, {
      redactedContent: "",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kiro exposes reasoning content and token usage metadata", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => createResponse([
      ["reasoningContentEvent", { text: "think", signature: "sig" }],
      ["assistantResponseEvent", { content: "answer" }],
      ["metadataEvent", { tokenUsage: { uncachedInputTokens: 12, outputTokens: 9, cacheReadInputTokens: 3, cacheWriteInputTokens: 4 } }],
    ]);

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
    }, {}, createLogger())({ ...createModel(), reasoning: true }, {
      messages: [{ role: "user", content: "Explain" }],
    });

    for await (const _event of stream) {}
    const message = await stream.result();
    assert.deepEqual(message.content, [
      { type: "thinking", thinking: "think", thinkingSignature: "sig" },
      { type: "text", text: "answer" },
    ]);
    assert.deepEqual(message.usage, {
      input: 12,
      output: 9,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 28,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kiro fragmented same-id string inputs are accumulated before tool call end", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => createResponse([
      ["toolUseEvent", { toolUseId: "tooluse_grep", name: "grep", input: "{\"path\":" }],
      ["toolUseEvent", { toolUseId: "tooluse_grep", name: "grep", input: "\"src\",\"pattern\":\"toolUseEvent\"}" }],
    ]);

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
    }, {}, createLogger())(createModel(), {
      messages: [{ role: "user", content: "grep tool events" }],
      tools: [{ name: "grep", description: "Search files", parameters: { type: "object" } }],
    });

    const events = [];
    for await (const event of stream) events.push(event);
    const toolStarts = events.filter((event) => event.type === "toolcall_start");
    const toolEnds = events.filter((event) => event.type === "toolcall_end");

    assert.equal(toolStarts.length, 1);
    assert.equal(toolEnds.length, 1);
    assert.deepEqual(toolEnds[0].toolCall.arguments, { path: "src", pattern: "toolUseEvent" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
