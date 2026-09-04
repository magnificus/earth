import type { GameConnection } from "./GameConnection";
import type {
  GameAction,
  GameEvent,
  GameEventListener,
  GameSnapshot,
  JoinGameRequest,
  PlayerLeftEvent,
  PlayerPoseChangedEvent,
  PlayerState,
} from "./GameProtocol";
import { isValidPlayerPose } from "./GameProtocol";
import { GameServer } from "./GameServer";
import type { GameStateRepository } from "./GameStateRepository";

const ACTOR_ID_STORAGE_KEY = "earth.tab-actor-id.v1";
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

interface BroadcastChannelLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

type ChannelMessage =
  | { version: 1; type: "session.joined"; request: JoinGameRequest }
  | { version: 1; type: "player.pose"; event: PlayerPoseChangedEvent }
  | { version: 1; type: "session.left"; event: PlayerLeftEvent };

interface KnownSession {
  worldId: string;
  actorId: string;
}

/** Local browser transport that synchronizes independent tabs on the same origin. */
export class BrowserBroadcastGameConnection implements GameConnection {
  private readonly listeners = new Set<GameEventListener>();
  private readonly knownSessions = new Map<string, KnownSession>();
  private readonly server: GameServer;
  private readonly channel: BroadcastChannelLike;
  private readonly now: () => number;
  private request?: JoinGameRequest;
  private ownState?: PlayerState;

  constructor(
    repository: GameStateRepository,
    channel: BroadcastChannelLike,
    now: () => number = Date.now,
  ) {
    this.server = new GameServer(repository, now);
    this.channel = channel;
    this.now = now;
    this.channel.onmessage = (message) => this.handleMessage(message.data);
  }

  async connect(request: JoinGameRequest): Promise<GameSnapshot> {
    if (this.request) throw new Error("This game connection is already open.");
    this.request = { ...request };
    this.knownSessions.set(request.sessionId, {
      worldId: request.worldId,
      actorId: request.actorId,
    });
    const snapshot = await this.server.connect(request, (event) => this.handleLocalEvent(event));
    this.ownState = snapshot.players.find((player) => player.actorId === request.actorId);
    this.post({ version: 1, type: "session.joined", request });
    return {
      worldId: request.worldId,
      players: this.ownState ? [{ ...this.ownState, pose: { ...this.ownState.pose } }] : [],
    };
  }

  dispatch(action: GameAction): Promise<void> {
    const request = this.request;
    if (!request) return Promise.reject(new Error("The game connection is not open."));
    return this.server.dispatch(request.sessionId, action);
  }

  subscribe(listener: GameEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.request) {
      const event: PlayerLeftEvent = {
        type: "player.left",
        worldId: this.request.worldId,
        actorId: this.request.actorId,
        originSessionId: this.request.sessionId,
        occurredAt: this.now(),
      };
      this.post({ version: 1, type: "session.left", event });
      this.server.disconnect(this.request.sessionId);
    }
    this.request = undefined;
    this.listeners.clear();
    this.knownSessions.clear();
    this.channel.onmessage = null;
    this.channel.close();
  }

  private handleMessage(candidate: unknown): void {
    const request = this.request;
    if (!request || !isChannelMessage(candidate)) return;

    if (candidate.type === "session.joined") {
      const joined = candidate.request;
      if (joined.worldId !== request.worldId || joined.sessionId === request.sessionId) return;
      this.knownSessions.set(joined.sessionId, {
        worldId: joined.worldId,
        actorId: joined.actorId,
      });
      if (this.ownState) {
        this.post({
          version: 1,
          type: "player.pose",
          event: stateToPoseEvent(this.ownState, request.sessionId),
        });
      }
      return;
    }

    const event = candidate.event;
    if (event.worldId !== request.worldId || event.originSessionId === request.sessionId) return;
    if (candidate.type === "player.pose") {
      this.knownSessions.set(event.originSessionId, {
        worldId: event.worldId,
        actorId: event.actorId,
      });
      this.emit(event);
      return;
    }

    this.knownSessions.delete(event.originSessionId);
    const actorStillConnected = [...this.knownSessions.values()].some(
      (session) => session.worldId === event.worldId && session.actorId === event.actorId,
    );
    if (!actorStillConnected) this.emit(event);
  }

  private handleLocalEvent(event: GameEvent): void {
    if (event.type === "player.pose.changed") {
      this.ownState = {
        worldId: event.worldId,
        actorId: event.actorId,
        revision: event.revision,
        updatedAt: event.occurredAt,
        pose: { ...event.pose },
        temperature: 37,
        hunger: 100,
        thirst: 100,
      };
      this.post({ version: 1, type: "player.pose", event });
    }
    this.emit(event);
  }

  private emit(event: GameEvent): void {
    for (const listener of this.listeners) listener(cloneEvent(event));
  }

  private post(message: ChannelMessage): void {
    this.channel.postMessage(message);
  }
}

/** Browser transport for the real game backend. Game state never touches browser storage. */
export class WebSocketGameConnection implements GameConnection {
  private readonly url: string;
  private readonly listeners = new Set<GameEventListener>();
  private socket?: WebSocket;
  private dispatchQueue: Promise<void> = Promise.resolve();
  private resolveConnect?: (snapshot: GameSnapshot) => void;
  private rejectConnect?: (error: Error) => void;
  private connectTimeout?: ReturnType<typeof setTimeout>;
  private readonly connectTimeoutMilliseconds: number;

  constructor(url: string, connectTimeoutMilliseconds = DEFAULT_CONNECTION_TIMEOUT_MS) {
    this.url = url;
    this.connectTimeoutMilliseconds = connectTimeoutMilliseconds;
  }

  connect(request: JoinGameRequest): Promise<GameSnapshot> {
    if (this.socket) return Promise.reject(new Error("This game connection is already open."));
    return new Promise<GameSnapshot>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.onopen = () => socket.send(JSON.stringify({ type: "join", request }));
      socket.onmessage = (message) => this.handleMessage(message.data);
      socket.onerror = () => this.failConnect(new Error("Could not connect to the game backend."));
      socket.onclose = () => {
        this.failConnect(new Error("The game backend connection closed."));
        if (this.socket === socket) this.socket = undefined;
      };
      this.connectTimeout = setTimeout(() => {
        this.failConnect(new Error("The game backend did not respond in time."));
        socket.close();
      }, this.connectTimeoutMilliseconds);
    });
  }

  dispatch(action: GameAction): Promise<void> {
    const dispatched = this.dispatchQueue.then(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        throw new Error("The game connection is not open.");
      }
      this.socket.send(JSON.stringify({ type: "action", action }));
    });
    this.dispatchQueue = dispatched.catch(() => undefined);
    return dispatched;
  }

  subscribe(listener: GameEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.dispatchQueue;
    this.clearConnectTimeout();
    this.socket?.close();
    this.socket = undefined;
    this.listeners.clear();
  }

  private handleMessage(raw: unknown): void {
    let message: { type?: string; snapshot?: GameSnapshot; event?: GameEvent; message?: string };
    try {
      message = JSON.parse(String(raw));
    } catch {
      this.failConnect(new Error("The game backend sent invalid data."));
      return;
    }
    if (message.type === "snapshot" && message.snapshot) {
      this.clearConnectTimeout();
      this.resolveConnect?.(message.snapshot);
      this.resolveConnect = undefined;
      this.rejectConnect = undefined;
    } else if (message.type === "event" && message.event) {
      for (const listener of this.listeners) listener(message.event);
    } else if (message.type === "error") {
      this.failConnect(new Error(message.message ?? "Game backend request failed."));
    }
  }

  private failConnect(error: Error): void {
    this.clearConnectTimeout();
    this.rejectConnect?.(error);
    this.resolveConnect = undefined;
    this.rejectConnect = undefined;
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout === undefined) return;
    clearTimeout(this.connectTimeout);
    this.connectTimeout = undefined;
  }
}

export interface BrowserGameConnection {
  connection: GameConnection;
  actorId: string;
  sessionId: string;
}

export function createBrowserLocalGameConnection(): BrowserGameConnection {
  const configuredUrl = new URLSearchParams(window.location.search).get("game-backend");
  const url = configuredUrl ?? `ws://${window.location.hostname || "localhost"}:3001/game`;
  const connection = new WebSocketGameConnection(url);
  return {
    connection,
    actorId: loadOrCreateTabActorId(),
    sessionId: createId(),
  };
}

function loadOrCreateTabActorId(): string {
  try {
    const existing = window.sessionStorage.getItem(ACTOR_ID_STORAGE_KEY);
    const navigation = performance.getEntriesByType("navigation")[0] as
      PerformanceNavigationTiming | undefined;
    // Chrome can clone sessionStorage when a tab is duplicated. A fresh
    // navigation must become a distinct player; reload/back-forward retains
    // the identity so the tab can restore its persisted pose.
    if (existing && navigation?.type !== "navigate") return existing;
    const created = createId();
    window.sessionStorage.setItem(ACTOR_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return createId();
  }
}

function stateToPoseEvent(state: PlayerState, sessionId: string): PlayerPoseChangedEvent {
  return {
    type: "player.pose.changed",
    worldId: state.worldId,
    actorId: state.actorId,
    originSessionId: sessionId,
    revision: state.revision,
    occurredAt: state.updatedAt,
    pose: { ...state.pose },
  };
}

function isChannelMessage(candidate: unknown): candidate is ChannelMessage {
  if (!candidate || typeof candidate !== "object") return false;
  const message = candidate as Partial<ChannelMessage>;
  if (message.version !== 1) return false;
  if (message.type === "session.joined") return isJoinRequest(message.request);
  if (message.type === "player.pose") return isPoseEvent(message.event);
  if (message.type === "session.left") return isLeftEvent(message.event);
  return false;
}

function isJoinRequest(candidate: unknown): candidate is JoinGameRequest {
  if (!candidate || typeof candidate !== "object") return false;
  const request = candidate as Partial<JoinGameRequest>;
  return typeof request.worldId === "string" && request.worldId.length > 0
    && typeof request.actorId === "string" && request.actorId.length > 0
    && typeof request.sessionId === "string" && request.sessionId.length > 0;
}

function isPoseEvent(candidate: unknown): candidate is PlayerPoseChangedEvent {
  if (!candidate || typeof candidate !== "object") return false;
  const event = candidate as Partial<PlayerPoseChangedEvent>;
  return event.type === "player.pose.changed"
    && typeof event.worldId === "string"
    && typeof event.actorId === "string"
    && typeof event.originSessionId === "string"
    && Number.isSafeInteger(event.revision)
    && Number.isFinite(event.occurredAt)
    && event.pose !== undefined
    && isValidPlayerPose(event.pose);
}

function isLeftEvent(candidate: unknown): candidate is PlayerLeftEvent {
  if (!candidate || typeof candidate !== "object") return false;
  const event = candidate as Partial<PlayerLeftEvent>;
  return event.type === "player.left"
    && typeof event.worldId === "string"
    && typeof event.actorId === "string"
    && typeof event.originSessionId === "string"
    && Number.isFinite(event.occurredAt);
}

function cloneEvent(event: GameEvent): GameEvent {
  return event.type === "player.pose.changed"
    ? { ...event, pose: { ...event.pose } }
    : { ...event };
}

function createId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}
