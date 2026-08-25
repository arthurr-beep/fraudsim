import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sseStream } from '../../src/streaming/sse.js';

function fakeResponse({ writeReturns = true } = {}) {
  const res = new EventEmitter();
  res.headers = {};
  res.written = [];
  res.ended = false;
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    Object.assign(res.headers, headers);
  };
  res.write = (chunk) => {
    res.written.push(chunk);
    return writeReturns;
  };
  res.end = () => {
    res.ended = true;
  };
  return res;
}

test('sseStream sets SSE headers', () => {
  const res = fakeResponse();
  sseStream(res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.headers['Cache-Control'], 'no-cache');
  assert.equal(res.headers.Connection, 'keep-alive');
});

test('send() writes correctly framed SSE data', () => {
  const res = fakeResponse();
  const stream = sseStream(res);

  stream.send({ type: 'attempt', round: 1 });

  assert.equal(res.written.length, 1);
  assert.equal(res.written[0], `data: ${JSON.stringify({ type: 'attempt', round: 1 })}\n\n`);
});

test('close() sends the done sentinel and ends the response', () => {
  const res = fakeResponse();
  const stream = sseStream(res);

  stream.send({ type: 'attempt', round: 1 });
  stream.close();

  assert.equal(res.written.length, 2);
  assert.equal(res.written[1], 'data: {"type":"done"}\n\n');
  assert.equal(res.ended, true);
});

test('close() is a no-op if called twice', () => {
  const res = fakeResponse();
  const stream = sseStream(res);

  stream.close();
  const writtenAfterFirstClose = res.written.length;
  stream.close();

  assert.equal(res.written.length, writtenAfterFirstClose);
});

test('send() after close() is ignored', () => {
  const res = fakeResponse();
  const stream = sseStream(res);

  stream.close();
  const writtenAfterClose = res.written.length;
  stream.send({ type: 'attempt', round: 1 });

  assert.equal(res.written.length, writtenAfterClose);
});

test('queues events under backpressure and flushes on drain', () => {
  const res = fakeResponse({ writeReturns: false });
  const stream = sseStream(res);

  stream.send({ type: 'attempt', round: 1 });
  stream.send({ type: 'attempt', round: 2 });

  // Only the first write is attempted; write() returned false so the rest
  // wait for 'drain' rather than being written out of order.
  assert.equal(res.written.length, 1);

  res.write = (chunk) => {
    res.written.push(chunk);
    return true;
  };
  res.emit('drain');

  assert.equal(res.written.length, 2);
  assert.equal(res.written[1], `data: ${JSON.stringify({ type: 'attempt', round: 2 })}\n\n`);
});

test('close() during backpressure waits for drain before ending', () => {
  const res = fakeResponse({ writeReturns: false });
  const stream = sseStream(res);

  stream.send({ type: 'attempt', round: 1 });
  stream.close();

  assert.equal(res.ended, false, 'must not end before the queue is flushed');

  res.write = (chunk) => {
    res.written.push(chunk);
    return true;
  };
  res.emit('drain');

  assert.equal(res.ended, true);
  assert.equal(res.written.at(-1), 'data: {"type":"done"}\n\n');
});

test('throws if res is missing write/end', () => {
  assert.throws(() => sseStream({}), /write\(\) and end\(\)/);
});
