import { DurableObject } from "cloudflare:workers";

// One Durable Object per room. The host sends binary audio packets,
// the object relays them to every listener. Text messages are clock pings.
export class Room extends DurableObject {
  async fetch(req) {
    const role = new URL(req.url).searchParams.get("role") === "host" ? "host" : "listener";
    if (role === "host") {
      for (const w of this.ctx.getWebSockets("host")) {
        try { w.close(1000, "replaced by a new host"); } catch {}
      }
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role]);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    if (typeof msg === "string") {
      let j;
      try { j = JSON.parse(msg); } catch { return; }
      if (j.t === "p") ws.send(JSON.stringify({ t: "q", c: j.c, s: Date.now() }));
      return;
    }
    if (!this.ctx.getTags(ws).includes("host")) return;
    for (const w of this.ctx.getWebSockets()) {
      if (w === ws) continue;
      try { w.send(msg); } catch {}
    }
  }

  webSocketClose(ws) {
    try { ws.close(1000); } catch {}
  }
}

export default {
  fetch(req, env) {
    const m = new URL(req.url).pathname.match(/^\/ws\/([\w-]{1,40})$/);
    if (!m || req.headers.get("Upgrade") !== "websocket") {
      return new Response("Not found", { status: 404 });
    }
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
  },
};
