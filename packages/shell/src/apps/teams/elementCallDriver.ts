// Widget driver that bridges Element Call (running embedded in an iframe) to
// the parent app's already-authenticated matrix-js-sdk client. Element Call
// in "matryoshka" mode does not have its own Matrix client — it routes every
// Matrix RPC through the Widget API postMessage transport, and this driver
// executes them against `getMatrixClient()`. Only the methods Element Call
// actually invokes are overridden; the rest fall back to the no-op base
// implementations in `WidgetDriver`.

import {
  Capability,
  IOpenIDUpdate,
  IRoomEvent,
  ISendDelayedEventDetails,
  ITurnServer,
  OpenIDRequestState,
  SimpleObservable,
  WidgetDriver,
  type ISendEventDetails,
} from "matrix-widget-api";

import { getMatrixClient, isCryptoEnabled } from "./matrixClient";

// Convert a matrix-js-sdk MatrixEvent into the IRoomEvent shape the Widget API
// expects to feed into the iframe. The event types from the SDK have a few
// extra fields, but the widget side only relies on these.
function toIRoomEvent(ev: any): IRoomEvent {
  return {
    type: ev.getType(),
    sender: ev.getSender() ?? "",
    event_id: ev.getId() ?? "",
    room_id: ev.getRoomId() ?? "",
    state_key: ev.getStateKey(),
    origin_server_ts: ev.getTs(),
    content: ev.getContent() ?? {},
    unsigned: ev.getUnsigned() ?? {},
  };
}

export class ElementCallWidgetDriver extends WidgetDriver {
  constructor(private readonly defaultRoomId: string) {
    super();
  }

  // Trust Element Call (first-party, own host from the domain registry). The default
  // base implementation rejects all capabilities, which would prevent Element
  // Call from doing anything at all — including reading the room state needed
  // to render the call.
  public override validateCapabilities(
    requested: Set<Capability>
  ): Promise<Set<Capability>> {
    return Promise.resolve(new Set(requested));
  }

  // Critical: without this there is no video and no audio.
  //
  // The path to the media server does NOT go through Matrix but through an
  // OpenID token: Element Call obtains a short-lived credential from the
  // homeserver (`client.getOpenIdToken()`), presents it to the lk-jwt service
  // and receives a LiveKit JWT in return. In matryoshka mode EC has no
  // homeserver access of its own — it asks US via the widget bridge, and the
  // default answer of `WidgetDriver` is a flat "Blocked"
  // ("By default, the widget driver will block all OIDC requests", WidgetDriver.d.ts).
  //
  // Symptom without it: the lk-jwt service only sees health checks, never a
  // token request, and no participant ever joins in LiveKit — even though the
  // UI shows a running call. The call UI proves nothing about the media path.
  //
  // We deliberately do NOT prompt: Element Call is not a third-party widget
  // but our own service on our own domain — the same reasoning by which
  // `validateCapabilities` above allows everything. The token is valid for a
  // few minutes and only tells the media server who the caller is.
  public override askOpenID(observer: SimpleObservable<IOpenIDUpdate>): void {
    const client = getMatrixClient();
    if (!client) {
      observer.update({ state: OpenIDRequestState.Blocked });
      return;
    }
    client
      .getOpenIdToken()
      .then((token) => {
        observer.update({ state: OpenIDRequestState.Allowed, token });
      })
      .catch((e) => {
        console.error("[elementCallDriver] OpenID-Token nicht erhalten", e);
        observer.update({ state: OpenIDRequestState.Blocked });
      });
  }

  public override async sendEvent(
    eventType: string,
    content: unknown,
    stateKey?: string | null,
    roomId?: string | null
  ): Promise<ISendEventDetails> {
    const client = getMatrixClient();
    if (!client) throw new Error("matrix client not initialised");
    const targetRoom = roomId || this.defaultRoomId;
    let res;
    if (stateKey != null) {
      res = await client.sendStateEvent(
        targetRoom,
        eventType as any,
        content as any,
        stateKey
      );
    } else {
      res = await client.sendEvent(targetRoom, eventType as any, content as any);
    }
    return { roomId: targetRoom, eventId: res.event_id };
  }

  // Warning: "delayed events" (MSC4140). When joining a call, Element Call
  // registers and at the same time deposits a prepared leave event with a delay
  // at the homeserver. While the app is alive it keeps refreshing it; if the tab
  // dies, it fires on its own — so nobody stays in the call as a ghost. Without
  // this the MembershipManager aborts the call:
  //   "Could not send delayed event, even though delayed events are supported"
  // and the call ends immediately with "Connection lost".
  //
  // "Supported" meant here: **we** promised the capability
  // (`validateCapabilities` allows everything) but could not serve it — the
  // base class answers all four methods with "Failed to override function".
  // A promise without an implementation is worse than a refusal: the caller
  // relies on it. Synapse supports it (`org.matrix.msc4140: true` under
  // /_matrix/client/versions).
  public override async sendDelayedEvent(
    delay: number | null,
    parentDelayId: string | null,
    eventType: string,
    content: unknown,
    stateKey?: string | null,
    roomId?: string | null
  ): Promise<ISendDelayedEventDetails> {
    const client = getMatrixClient();
    if (!client) throw new Error("matrix client not initialised");
    const targetRoom = roomId || this.defaultRoomId;
    // Either a delay in ms OR placement under an already existing parent
    // event — the js-sdk types are mutually exclusive.
    const delayOpts: any =
      delay !== null
        ? { delay, ...(parentDelayId ? { parent_delay_id: parentDelayId } : {}) }
        : { parent_delay_id: parentDelayId };
    const res =
      stateKey != null
        ? await (client as any)._unstable_sendDelayedStateEvent(
            targetRoom,
            delayOpts,
            eventType,
            content,
            stateKey
          )
        : await (client as any)._unstable_sendDelayedEvent(
            targetRoom,
            delayOpts,
            null,
            eventType,
            content
          );
    return { roomId: targetRoom, delayId: res.delay_id };
  }

  public override async cancelScheduledDelayedEvent(delayId: string): Promise<void> {
    await this.updateDelayed(delayId, "cancel");
  }

  public override async restartScheduledDelayedEvent(delayId: string): Promise<void> {
    await this.updateDelayed(delayId, "restart");
  }

  public override async sendScheduledDelayedEvent(delayId: string): Promise<void> {
    await this.updateDelayed(delayId, "send");
  }

  private async updateDelayed(delayId: string, action: string): Promise<void> {
    const client = getMatrixClient();
    if (!client) throw new Error("matrix client not initialised");
    await (client as any)._unstable_updateDelayedEvent(delayId, action);
  }

  public override async sendToDevice(
    eventType: string,
    encrypted: boolean,
    contentMap: { [userId: string]: { [deviceId: string]: object } }
  ): Promise<void> {
    const client = getMatrixClient();
    if (!client) throw new Error("matrix client not initialised");

    // Encrypted to-device messages (E2EE call rooms): since Rust crypto is
    // initialised, sent via encryptAndSendToDevice instead of silently
    // sending them unencrypted.
    if (encrypted && isCryptoEnabled()) {
      const targets: { userId: string; deviceId: string }[] = [];
      let payload: object = {};
      for (const [userId, devs] of Object.entries(contentMap)) {
        for (const [deviceId, body] of Object.entries(devs)) {
          targets.push({ userId, deviceId });
          payload = body; // EC sends an identical payload to all devices
        }
      }
      await (client as any).encryptAndSendToDevice(eventType, targets, payload);
      return;
    }

    // matrix-js-sdk wants Map<userId, Map<deviceId, content>>; the widget
    // hands us a nested plain object.
    const m = new Map<string, Map<string, Record<string, any>>>();
    for (const [userId, devs] of Object.entries(contentMap)) {
      const inner = new Map<string, Record<string, any>>();
      for (const [deviceId, body] of Object.entries(devs)) {
        inner.set(deviceId, body as Record<string, any>);
      }
      m.set(userId, inner);
    }
    await client.sendToDevice(eventType, m);
  }

  public override async readRoomTimeline(
    roomId: string,
    eventType: string,
    msgtype: string | undefined,
    stateKey: string | undefined,
    limit: number,
    _since: string | undefined
  ): Promise<IRoomEvent[]> {
    const client = getMatrixClient();
    if (!client) return [];
    const room = client.getRoom(roomId);
    if (!room) return [];

    // EC's matryoshka client (matrix-js-sdk RoomWidgetClient.startClient)
    // calls widgetApi.readStateEvents(...) which the parent's ClientWidgetApi
    // routes here when room_ids is set. State events live in
    // room.currentState — they don't appear in getLiveTimeline().getEvents()
    // unless they were emitted during this session. For EC to bootstrap (read
    // historical members, m.call.member from prior calls, m.room.encryption
    // state, etc.) we must merge both sources.
    const dedupe = new Map<string, any>();

    // 1. Live timeline (recent events including state echoes)
    for (const ev of room.getLiveTimeline().getEvents()) {
      if (ev.getType() !== eventType) continue;
      if (msgtype && ev.getContent()?.msgtype !== msgtype) continue;
      if (stateKey !== undefined && ev.getStateKey() !== stateKey) continue;
      const id = ev.getId();
      if (id) dedupe.set(id, ev);
    }

    // 2. Current room state (historical state events for the requested type)
    const stateEvts =
      stateKey === undefined
        ? room.currentState.getStateEvents(eventType)
        : (() => {
            const e = room.currentState.getStateEvents(eventType, stateKey);
            return e ? [e] : [];
          })();
    for (const ev of stateEvts) {
      const id = ev.getId();
      if (id && !dedupe.has(id)) dedupe.set(id, ev);
    }

    const merged = Array.from(dedupe.values());
    const sliced = limit > 0 ? merged.slice(-limit) : merged;
    return sliced.map(toIRoomEvent);
  }

  public override async readRoomState(
    roomId: string,
    eventType: string,
    stateKey: string | undefined
  ): Promise<IRoomEvent[]> {
    const client = getMatrixClient();
    if (!client) return [];
    const room = client.getRoom(roomId);
    if (!room) return [];
    const evts = stateKey === undefined
      ? room.currentState.getStateEvents(eventType)
      : (() => {
          const e = room.currentState.getStateEvents(eventType, stateKey);
          return e ? [e] : [];
        })();
    return evts.map(toIRoomEvent);
  }

  public override getKnownRooms(): string[] {
    const client = getMatrixClient();
    if (!client) return [];
    return client
      .getRooms()
      .filter((r: any) => r.getMyMembership() === "join")
      .map((r: any) => r.roomId);
  }

  // Base impl throws "readStickyEvents is not implemented"; empty array is
  // a valid response — sticky events are an experimental MSC and EC just
  // wants to know whether any are present (none → call proceeds normally).
  public override async readStickyEvents(_roomId: string): Promise<any[]> {
    return [];
  }

  // Same — base impl throws. EC reads room account data for some optional
  // settings (audio prefs etc); empty list means "use defaults".
  public override async readRoomAccountData(
    _eventType: string,
    _roomIds?: string[] | null
  ): Promise<any[]> {
    return [];
  }

  // Yields TURN credentials initially and then again whenever they expire.
  // matrix-js-sdk auto-refreshes the cached set; we re-poll just before TTL
  // hits zero. If Synapse can't issue TURN (e.g. no shared secret configured),
  // yield an empty set so Element Call falls back to direct ICE — that works
  // fine on a local network, only break-out across NAT would need real TURN.
  public override async *getTurnServers(): AsyncGenerator<ITurnServer> {
    const client = getMatrixClient();
    if (!client) return;
    while (true) {
      let resp: any;
      try {
        resp = await client.turnServer();
      } catch {
        yield { urls: [], username: "", credential: "" };
        // Don't busy-loop on a misconfigured homeserver
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      yield {
        urls: resp.uris ?? [],
        username: resp.username ?? "",
        credential: resp.password ?? "",
      };
      const ttlMs = (resp.ttl ?? 3600) * 1000;
      // Refresh slightly before expiry
      await new Promise((r) => setTimeout(r, Math.max(60_000, ttlMs - 60_000)));
    }
  }
}
