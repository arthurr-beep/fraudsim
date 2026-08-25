/**
 * Server-Sent Events streaming helper.
 *
 * Wraps an Express-style response object to stream simulation events to a
 * browser dashboard as they happen, instead of waiting for the full report.
 *
 * @example
 *   import { sseStream } from 'fraud-sim/streaming';
 *
 *   app.get('/simulate/:scenario/stream', async (req, res) => {
 *     const stream = sseStream(res);
 *     await run(req.params.scenario, {
 *       target,
 *       onEvent: (event) => stream.send(event),
 *     });
 *     stream.close();
 *   });
 */

/**
 * Set up SSE headers on `res` and return a `{ send, close }` handle.
 *
 * Handles backpressure: if `res.write` reports the internal buffer is full
 * (returns `false`), further events queue in memory until the response
 * emits `drain`, then flush in order.
 *
 * @param {object} res - Any Express-style response with `write`, `end`,
 *   `writeHead` (or settable `.statusCode`/`.setHeader`), and an
 *   EventEmitter-style `on('drain', ...)`.
 * @returns {{ send: (event: object) => void, close: () => void }}
 */
export function sseStream(res) {
  if (typeof res?.write !== 'function' || typeof res?.end !== 'function') {
    throw new Error('sseStream(res) requires a response object with write() and end() methods');
  }

  if (typeof res.writeHead === 'function') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  } else {
    res.statusCode = 200;
    res.setHeader?.('Content-Type', 'text/event-stream');
    res.setHeader?.('Cache-Control', 'no-cache');
    res.setHeader?.('Connection', 'keep-alive');
  }

  const queue = [];
  let draining = false;
  let closed = false;
  let closing = false;

  function frame(event) {
    return `data: ${JSON.stringify(event)}\n\n`;
  }

  function flush() {
    while (queue.length > 0) {
      // write() sends the chunk regardless of its return value — a `false`
      // return just signals "the internal buffer is full, pause before
      // writing more", matching Node's own Writable stream contract. So the
      // chunk is dequeued either way; only further writes wait for drain.
      const next = queue.shift();
      const ok = res.write(next);
      if (!ok) {
        if (!draining) {
          draining = true;
          res.once?.('drain', () => {
            draining = false;
            flush();
          });
        }
        return;
      }
    }
    // Everything queued so far has been flushed — safe to end now.
    if (closing && !closed) {
      closed = true;
      res.end();
    }
  }

  function write(raw) {
    if (closed || closing) return;
    queue.push(raw);
    if (!draining) flush();
  }

  return {
    /** Send one event to the client as an SSE `data:` frame. */
    send(event) {
      write(frame(event));
    },

    /** Send the done sentinel, flush any pending backpressure, then end. */
    close() {
      if (closing || closed) return;
      queue.push(frame({ type: 'done' }));
      closing = true;
      if (!draining) flush();
    },
  };
}
