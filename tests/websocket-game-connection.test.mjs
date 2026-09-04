import assert from "node:assert/strict";
import test from "node:test";

const { WebSocketGameConnection } = await import(
  "../src/integration/BrowserGameConnection.ts"
);

const request = {
  worldId: "earth",
  actorId: "alice",
  sessionId: "session-a",
};

test("rejects and closes a backend connection that never sends a snapshot", async () => {
  const originalWebSocket = globalThis.WebSocket;
  try {
    globalThis.WebSocket = FakeWebSocket;
    const connection = new WebSocketGameConnection("ws://example.test/game", 5);

    await assert.rejects(
      connection.connect(request),
      /did not respond in time/,
    );
    assert.equal(FakeWebSocket.last.closeCalled, true);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("keeps a connection open after receiving its snapshot", async () => {
  const originalWebSocket = globalThis.WebSocket;
  try {
    globalThis.WebSocket = FakeWebSocket;
    const connection = new WebSocketGameConnection("ws://example.test/game", 10);
    const connected = connection.connect(request);
    FakeWebSocket.last.receive({
      type: "snapshot",
      snapshot: { worldId: "earth", players: [] },
    });

    assert.deepEqual(await connected, { worldId: "earth", players: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(FakeWebSocket.last.closeCalled, false);
    await connection.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

class FakeWebSocket {
  static OPEN = 1;
  static last;

  readyState = FakeWebSocket.OPEN;
  closeCalled = false;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor() {
    FakeWebSocket.last = this;
  }

  send() {}

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close() {
    this.closeCalled = true;
    this.onclose?.();
  }
}
