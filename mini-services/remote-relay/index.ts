/**
 * AI Remote Relay
 * ---------------
 * An authenticated WebSocket message relay with two client roles:
 *
 *   - "agent"      : the Python script running on the user's own computer.
 *                    Receives `exec` requests, streams back stdout/stderr results.
 *   - "controller" : the web terminal (Next.js UI). Sends commands, receives results.
 *
 * Security model:
 *   - Every connection must present the shared secret token (query param `token`).
 *   - The token lives in ./token.txt and is auto-generated on first start.
 *   - Re-reading the token file on every connection means regenerating it
 *     (via the web UI) takes effect immediately.
 *
 * Protocol (JSON text frames):
 *   client -> server : { type: "hello", info }                    (agent, after open)
 *                    | { type: "exec", command, timeout? }        (controller)
 *                    | { type: "kill", id }                       (controller)
 *                    | { type: "result", id, event, ... }         (agent)
 *                    | { type: "ping" | "pong" }
 *   server -> client : { type: "agent_status", online, info }
 *                    | { type: "exec", id, command, timeout }     (to agent)
 *                    | { type: "kill", id }                       (to agent)
 *                    | { type: "result", ... }                    (to controllers)
 *                    | { type: "error", error }
 *                    | { type: "ping" | "pong" }
 */

import { randomBytes, randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const PORT = 3030;
const TOKEN_FILE = join(import.meta.dir, "token.txt");
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024; // allow large file-transfer results

interface ClientData {
  role: "agent" | "controller" | null;
  token: string | null;
  authed: boolean;
}

interface AgentInfo {
  hostname?: string;
  name?: string;
  user?: string;
  os?: string;
  release?: string;
  arch?: string;
  cwd?: string;
  [key: string]: unknown;
}

type AnySocket = {
  data: ClientData;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

/** Load (or lazily create) the shared secret token. */
function loadToken(): string {
  try {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 16) return t;
  } catch {
    /* fall through and generate */
  }
  const t = randomBytes(24).toString("hex");
  try {
    writeFileSync(TOKEN_FILE, t);
  } catch (err) {
    console.error("[relay] failed to persist token:", err);
  }
  return t;
}

let agent: AnySocket | null = null;
let agentInfo: AgentInfo | null = null;
const controllers = new Set<AnySocket>();

function safeSend(ws: AnySocket | null, data: unknown) {
  if (!ws) return;
  try {
    ws.send(JSON.stringify(data));
  } catch {
    /* socket already gone */
  }
}

function agentStatusPayload() {
  return { type: "agent_status", online: !!agent, info: agentInfo };
}

function broadcastToControllers(data: unknown) {
  for (const c of controllers) safeSend(c, data);
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const data: ClientData = {
      role: (url.searchParams.get("role") as ClientData["role"]) ?? null,
      token: url.searchParams.get("token"),
      authed: false,
    };
    const upgraded = srv.upgrade(req, {
      data,
      maxMessageSize: MAX_MESSAGE_BYTES,
    });
    if (upgraded) return undefined; // handed off to the websocket handler
    return new Response(
      "AI Remote Relay websocket endpoint.\nConnect with ?role=agent|controller&token=<TOKEN>",
      { status: 426 }
    );
  },
  websocket: {
    open(ws: AnySocket) {
      const d = ws.data;
      const expected = loadToken();
      if (!d.token || d.token !== expected) {
        safeSend(ws, { type: "error", error: "invalid or missing token" });
        ws.close(4001, "invalid token");
        console.log("[relay] rejected connection: bad token");
        return;
      }
      d.authed = true;

      if (d.role === "agent") {
        // A newer agent replaces an older one (e.g. user restarted the script).
        if (agent && agent !== ws) {
          try {
            agent.close(1000, "replaced by a new agent instance");
          } catch {
            /* ignore */
          }
        }
        agent = ws;
        agentInfo = agentInfo ?? {};
        console.log("[relay] agent connected");
        broadcastToControllers(agentStatusPayload());
      } else if (d.role === "controller") {
        controllers.add(ws);
        safeSend(ws, agentStatusPayload());
        console.log(`[relay] controller connected (open: ${controllers.size})`);
      } else {
        ws.close(4002, "unknown role");
      }
    },

    message(ws: AnySocket, raw: string | Buffer) {
      const d = ws.data;
      if (!d?.authed) return;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      switch (msg.type) {
        case "ping":
          safeSend(ws, { type: "pong" });
          break;

        case "pong":
          break;

        case "hello":
          if (ws === agent) {
            agentInfo = (msg.info as AgentInfo) ?? {};
            console.log(
              `[relay] agent info: ${agentInfo.hostname ?? "?"} (${agentInfo.os ?? "?"}) user=${agentInfo.user ?? "?"}`
            );
            broadcastToControllers(agentStatusPayload());
          }
          break;

        case "exec":
          if (controllers.has(ws)) {
            if (!agent) {
              safeSend(ws, { type: "error", error: "no agent connected" });
              break;
            }
            const id = randomUUID();
            const command = String(msg.command ?? "");
            const timeout = Number(msg.timeout) > 0 ? Number(msg.timeout) : null;
            if (!command.trim()) {
              safeSend(ws, { type: "error", error: "empty command" });
              break;
            }
            safeSend(agent, { type: "exec", id, command, timeout });
          }
          break;

        case "kill":
          if (controllers.has(ws) && agent) {
            safeSend(agent, { type: "kill", id: String(msg.id ?? "") });
          }
          break;

        case "result":
          // Results flow strictly from the agent to all controllers.
          if (ws === agent) broadcastToControllers(msg);
          break;

        default:
          break;
      }
    },

    close(ws: AnySocket) {
      const d = ws.data;
      if (!d?.authed) return;
      if (ws === agent) {
        agent = null;
        agentInfo = null;
        console.log("[relay] agent disconnected");
        broadcastToControllers(agentStatusPayload());
      } else {
        controllers.delete(ws);
        console.log(`[relay] controller left (open: ${controllers.size})`);
      }
    },
  },
});

// App-level heartbeat keeps connections alive through proxies (Caddy / browsers
// do not need help, but the long-lived Python agent benefits from it).
setInterval(() => {
  safeSend(agent, { type: "ping" });
  for (const c of controllers) safeSend(c, { type: "ping" });
}, 20_000);

console.log(`[relay] AI Remote Relay listening on http://localhost:${PORT}`);
