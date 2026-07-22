import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const buildDir = process.env.PI_KIRO_PROVIDER_BUILD_DIR;
if (!buildDir) throw new Error("PI_KIRO_PROVIDER_BUILD_DIR is required.");

const fromBuild = (path) => pathToFileURL(join(buildDir, path)).href;
const { ByteQueue, crc32, parseEventFrame } = await import(fromBuild("src/eventstream.js"));

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

function encodeHeader(name, value) {
  const encoder = new TextEncoder();
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

function createFrame({ headers = {}, payload = "" } = {}) {
  const encoder = new TextEncoder();
  const headerBytes = concatBytes(Object.entries(headers).map(([name, value]) => encodeHeader(name, value)));
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

test("parseEventFrame decodes valid headers and JSON payload", () => {
  const logger = createLogger();
  const frame = createFrame({
    headers: { ":event-type": "chunk" },
    payload: JSON.stringify({ message: "hello" }),
  });

  assert.deepEqual(parseEventFrame(frame, logger), {
    headers: { ":event-type": "chunk" },
    payload: { message: "hello" },
  });
  assert.deepEqual(logger.warnings, []);
});

test("ByteQueue reads frames across chunk boundaries", () => {
  const frame = createFrame({ payload: JSON.stringify({ ok: true }) });
  const queue = new ByteQueue();

  queue.push(frame.subarray(0, 3));
  assert.equal(queue.peekUint32BE(), null);
  queue.push(frame.subarray(3, 11));
  assert.equal(queue.peekUint32BE(), frame.length);
  assert.equal(queue.read(frame.length), null);
  queue.push(frame.subarray(11));

  const readFrame = queue.read(frame.length);
  assert.ok(readFrame);
  assert.deepEqual(Array.from(readFrame), Array.from(frame));
  assert.equal(queue.length, 0);
});

test("parseEventFrame rejects invalid prelude CRC", () => {
  const logger = createLogger();
  const frame = createFrame({ payload: JSON.stringify({ ok: true }) });
  frame[8] ^= 0xff;

  assert.equal(parseEventFrame(frame, logger), null);
  assert.equal(logger.warnings[0]?.event, "eventstream_prelude_crc_mismatch");
});

test("parseEventFrame rejects invalid message CRC", () => {
  const logger = createLogger();
  const frame = createFrame({ payload: JSON.stringify({ ok: true }) });
  frame[frame.length - 1] ^= 0xff;

  assert.equal(parseEventFrame(frame, logger), null);
  assert.equal(logger.warnings[0]?.event, "eventstream_message_crc_mismatch");
});

test("parseEventFrame preserves non-JSON payload as raw text", () => {
  const logger = createLogger();
  const frame = createFrame({ payload: "not json" });

  assert.deepEqual(parseEventFrame(frame, logger), {
    headers: {},
    payload: { raw: "not json" },
  });
  assert.equal(logger.warnings[0]?.event, "eventstream_payload_parse_failed");
});
