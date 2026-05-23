// Bridge Node 20 built-ins into the jsdom environment so fetch / Response /
// ReadableStream / TextEncoder behave the same as in Next.js Route Handlers.
// Order matters: TextEncoder must exist BEFORE undici is required.
if (typeof globalThis.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util');
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}

const nodeWebStreams = require('node:stream/web');
if (typeof globalThis.ReadableStream === 'undefined') {
  globalThis.ReadableStream = nodeWebStreams.ReadableStream;
  globalThis.WritableStream = nodeWebStreams.WritableStream;
  globalThis.TransformStream = nodeWebStreams.TransformStream;
}

if (typeof globalThis.Response === 'undefined') {
  const undici = require('undici');
  globalThis.Response = undici.Response;
  globalThis.Request = undici.Request;
  globalThis.Headers = undici.Headers;
}
