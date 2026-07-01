// Minimal Server-Sent-Events-style encoder for streaming pipeline progress
// over a plain fetch() POST (not the native EventSource, which is GET-only).
// The client reads the response body as a stream and splits on "\n\n".

export function sseEncode(event: string, data: unknown): Uint8Array {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return new TextEncoder().encode(payload);
}

export interface SseController {
  send: (event: string, data: unknown) => void;
  close: () => void;
}

export function createSseStream(
  run: (controller: SseController) => Promise<void>
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const sseController: SseController = {
        send: (event, data) => {
          if (closed) return;
          try {
            controller.enqueue(sseEncode(event, data));
          } catch {
            // controller already closed elsewhere; ignore
          }
        },
        close: () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
      };

      try {
        await run(sseController);
      } catch (err) {
        sseController.send('error', {
          message: err instanceof Error ? err.message : 'Unknown pipeline error',
        });
      } finally {
        sseController.close();
      }
    },
  });
}

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};
