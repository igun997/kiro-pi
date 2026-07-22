import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const buildDir = process.env.PI_KIRO_PROVIDER_BUILD_DIR;
if (!buildDir) throw new Error("PI_KIRO_PROVIDER_BUILD_DIR is required.");

const fromBuild = (path) => pathToFileURL(join(buildDir, path)).href;
const { crc32, parseEventFrame } = await import(fromBuild("src/eventstream.js"));

const encoder = new TextEncoder();

function createLogger() {
  const warnings = [];
  return {
    warnings,
    debug() {},
    error() {},
    warn(event, details) {
      warnings.push({ event, details });
    },
  };
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

function createFrameFromRaw({ headerBytes = new Uint8Array(), payload = "" } = {}) {
  const payloadBytes = encoder.encode(payload);
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

function stringHeaderWithType(name, type, value) {
  const nameBytes = encoder.encode(name);
  const valueBytes = encoder.encode(value);
  const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let offset = 0;
  header[offset] = nameBytes.length;
  offset += 1;
  header.set(nameBytes, offset);
  offset += nameBytes.length;
  header[offset] = type;
  offset += 1;
  header[offset] = (valueBytes.length >>> 8) & 0xff;
  header[offset + 1] = valueBytes.length & 0xff;
  offset += 2;
  header.set(valueBytes, offset);
  return header;
}

test("parseEventFrame rejects unsupported header value types instead of accepting payload with missing event headers", () => {
  const logger = createLogger();
  const unsupportedBoolHeaderType = 0;
  const frame = createFrameFromRaw({
    headerBytes: stringHeaderWithType(":event-type", unsupportedBoolHeaderType, "assistantResponseEvent"),
    payload: JSON.stringify({ content: "hello" }),
  });

  assert.equal(parseEventFrame(frame, logger), null);
  assert.ok(logger.warnings.some((warning) => warning.event === "eventstream_invalid_header"));
});

test("parseEventFrame rejects headers whose declared name length crosses the header section boundary", () => {
  const logger = createLogger();
  const malformedHeader = concatBytes([
    Uint8Array.from([20]),
    encoder.encode(":event-type"),
  ]);
  const frame = createFrameFromRaw({
    headerBytes: malformedHeader,
    payload: JSON.stringify({ content: "hello" }),
  });

  assert.equal(parseEventFrame(frame, logger), null);
  assert.ok(logger.warnings.some((warning) => warning.event === "eventstream_invalid_header"));
});
