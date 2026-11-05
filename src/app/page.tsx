"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  KeyRound,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  Square,
  SquareTerminal,
  Terminal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

/* ------------------------------------------------------------------ */
/* Types & helpers                                                     */
/* ------------------------------------------------------------------ */

type LineKind = "cmd" | "stdout" | "stderr" | "sys" | "err" | "file";

interface TermLine {
  id: number;
  kind: LineKind;
  text: string;
  href?: string;
  name?: string;
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

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const fmtSize = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Relay websocket query string. Override with NEXT_PUBLIC_RELAY_QUERY when you
 *  are not running behind the bundled Caddy-style gateway (e.g. plain nginx). */
const RELAY_QUERY = process.env.NEXT_PUBLIC_RELAY_QUERY ?? "?XTransformPort=3030";

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Page() {
  const [token, setToken] = useState("");
  const [relayStatus, setRelayStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [agentOnline, setAgentOnline] = useState(false);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [lines, setLines] = useState<TermLine[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [cwd, setCwd] = useState("");
  const [confirmMode, setConfirmMode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [origin, setOrigin] = useState("");
  const [history, setHistory] = useState<string[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const runningIdRef = useRef("");
  const prevOnlineRef = useRef(false);
  const histIdxRef = useRef(-1);

  const addLine = useCallback((kind: LineKind, text: string, extra?: Partial<TermLine>) => {
    setLines((prev) => {
      const next = [...prev, { id: ++idRef.current, kind, text, ...extra }];
      return next.length > 800 ? next.slice(next.length - 800) : next;
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  /* Relay websocket lifecycle ---------------------------------------- */
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | null = null;

    setOrigin(window.location.origin);
    const proto = window.location.protocol === "https:" ? "wss" : "ws";

    const handleRaw = (raw: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === "ping") {
        wsRef.current?.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type === "error") {
        addLine("err", String(msg.error ?? "relay error"));
        return;
      }
      if (msg.type === "agent_status") {
        const online = !!msg.online;
        setAgentOnline(online);
        setAgentInfo((msg.info as AgentInfo) ?? null);
        if (online !== prevOnlineRef.current) {
          prevOnlineRef.current = online;
          if (online) {
            const i = (msg.info as AgentInfo) ?? {};
            addLine(
              "sys",
              `agent connected — ${i.hostname ?? i.name ?? "unknown"} · ${i.os ?? "?"} ${i.release ?? ""} · user: ${i.user ?? "?"}`,
            );
          } else {
            addLine("sys", "agent disconnected — run the Python script to restore access");
            setRunning(false);
          }
        }
        return;
      }
      if (msg.type !== "result") return;

      const ev = msg.event;
      if (ev === "stdout") addLine("stdout", String(msg.data ?? ""));
      else if (ev === "stderr") addLine("stderr", String(msg.data ?? ""));
      else if (ev === "error") {
        addLine("err", String(msg.data ?? "command failed"));
        setRunning(false);
      } else if (ev === "exit") {
        if (typeof msg.cwd === "string" && msg.cwd) setCwd(msg.cwd);
        if (msg.note) addLine("sys", String(msg.note));
        setRunning(false);
      } else if (ev === "file") {
        try {
          const b64 = String(msg.b64 ?? "");
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const href = URL.createObjectURL(new Blob([bytes]));
          addLine(
            "file",
            `file received: ${msg.name} (${fmtSize(Number(msg.size ?? bytes.length))}) — click to save`,
            { href, name: String(msg.name ?? "file") },
          );
        } catch {
          addLine("err", "failed to decode received file");
        }
      }
    };

    const connect = async () => {
      if (disposed) return;
      try {
        const res = await fetch("/api/relay-info", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        setToken(String(data.token ?? ""));
        ws = new WebSocket(
          `${proto}://${window.location.host}/${RELAY_QUERY}&role=controller&token=${encodeURIComponent(
            String(data.token),
          )}`,
        );
        wsRef.current = ws;
        ws.onopen = () => setRelayStatus("online");
        ws.onmessage = (e) => handleRaw(String(e.data));
        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null;
          setRelayStatus("offline");
          if (!disposed) reconnectTimer = setTimeout(connect, 2000);
        };
        ws.onerror = () => {
          try {
            ws?.close();
          } catch {
            /* noop */
          }
        };
      } catch {
        setRelayStatus("offline");
        if (!disposed) reconnectTimer = setTimeout(connect, 3000);
      }
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    };
  }, [addLine]);

  /* Commands ---------------------------------------------------------- */
  const sendCommand = useCallback(
    (raw?: string) => {
      const cmd = (raw ?? input).trim();
      if (!cmd) return;
      if (!agentOnline) {
        addLine("sys", "no agent connected — start the Python agent on your computer first");
        return;
      }
      if (running) {
        addLine("sys", "a command is already running — press Stop first");
        return;
      }
      addLine("cmd", cmd);
      setHistory((h) => [cmd, ...h.filter((c) => c !== cmd)].slice(0, 100));
      histIdxRef.current = -1;
      const id = uid();
      runningIdRef.current = id;
      setRunning(true);
      setInput("");
      wsRef.current?.send(JSON.stringify({ type: "exec", command: cmd }));
    },
    [agentOnline, running, input, addLine],
  );

  const stopCommand = useCallback(() => {
    if (!runningIdRef.current) return;
    wsRef.current?.send(JSON.stringify({ type: "kill", id: runningIdRef.current }));
    addLine("sys", "stop requested…");
  }, [addLine]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const next = Math.min(histIdxRef.current + 1, history.length - 1);
      histIdxRef.current = next;
      setInput(history[next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdxRef.current <= 0) {
        histIdxRef.current = -1;
        setInput("");
        return;
      }
      histIdxRef.current -= 1;
      setInput(history[histIdxRef.current]);
    }
  };

  /* Derived values ----------------------------------------------------- */
  const relayUrl = origin ? `${origin.replace(/^http/, "ws")}/${RELAY_QUERY}` : "";
  const runCmd = relayUrl && token
    ? `python agent.py --server ${relayUrl} --token ${token}${confirmMode ? " --confirm" : ""}`
    : "";

  const copyRun = async () => {
    if (!runCmd) return;
    try {
      await navigator.clipboard.writeText(runCmd);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = runCmd;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const regenerate = async () => {
    setRegenerating(true);
    try {
      const res = await fetch("/api/relay-info", { method: "POST" });
      const data = await res.json();
      if (data.token) setToken(String(data.token));
    } finally {
      setRegenerating(false);
    }
  };

  const chips =
    agentInfo?.os === "Windows"
      ? ["sysinfo", "whoami", "dir", "ipconfig", "tasklist"]
      : ["sysinfo", "whoami", "ls -la", "uname -a", "df -h"];

  const shortCwd = (cwd || agentInfo?.cwd || "~").replace(/^\/home\/[^/]+/, "~").replace(/^C:\\Users\\[^\\]+/i, "~");

  const renderLine = (l: TermLine) => {
    switch (l.kind) {
      case "cmd":
        return (
          <div key={l.id} className="font-semibold whitespace-pre-wrap break-words text-emerald-400">
            <span className="text-emerald-700">❯</span> {l.text}
          </div>
        );
      case "stdout":
        return <div key={l.id} className="whitespace-pre-wrap break-words text-zinc-200">{l.text}</div>;
      case "stderr":
        return <div key={l.id} className="whitespace-pre-wrap break-words text-rose-400">{l.text}</div>;
      case "sys":
        return <div key={l.id} className="whitespace-pre-wrap break-words text-amber-400">※ {l.text}</div>;
      case "err":
        return <div key={l.id} className="font-medium whitespace-pre-wrap break-words text-rose-500">✖ {l.text}</div>;
      case "file":
        return (
          <div key={l.id} className="whitespace-pre-wrap break-words text-emerald-300">
            ⤓ {l.text}{" "}
            {l.href && (
              <a
                href={l.href}
                download={l.name ?? "file"}
                className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-emerald-200"
              >
                save <Download className="h-3 w-3" />
              </a>
            )}
          </div>
        );
    }
  };

  /* ------------------------------------------------------------------ */
  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-zinc-800/80 bg-zinc-900/70 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-emerald-500/30 bg-emerald-500/10">
              <SquareTerminal className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-none sm:text-base">AI Remote Terminal</h1>
              <p className="mt-0.5 hidden text-[11px] text-zinc-500 sm:block">
                secure shell access to your computer — only while the agent runs
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {relayStatus !== "online" ? (
              <Badge variant="outline" className="gap-1.5 border-amber-500/40 text-amber-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                relay {relayStatus}
              </Badge>
            ) : agentOnline ? (
              <Badge className="gap-1.5 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                </span>
                agent online
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1.5 border-zinc-700 text-zinc-400">
                waiting for agent
              </Badge>
            )}
            {agentInfo?.hostname && (
              <Badge variant="outline" className="hidden border-zinc-700 font-mono text-[11px] text-zinc-400 md:inline-flex">
                {String(agentInfo.hostname)} · {String(agentInfo.os ?? "?")} · {String(agentInfo.user ?? "?")}
              </Badge>
            )}
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* Terminal card */}
          <Card className="flex flex-col border-zinc-800 bg-zinc-900/50">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <div className="flex min-w-0 items-center gap-2">
                <CardTitle className="text-base">Terminal</CardTitle>
                {agentOnline && (
                  <span className="truncate font-mono text-[11px] text-zinc-500">{shortCwd}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <div className="hidden flex-wrap items-center gap-1.5 md:flex">
                  {chips.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => sendCommand(c)}
                      disabled={!agentOnline || running}
                      className="h-7 rounded-md border border-zinc-800 bg-zinc-950 px-2 font-mono text-[11px] text-zinc-400 transition-colors hover:border-emerald-500/40 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-zinc-500 hover:text-zinc-300"
                  onClick={() => setLines([])}
                >
                  clear
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3 pt-0">
              <div
                ref={scrollRef}
                className="h-[52vh] min-h-[300px] overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[13px] leading-relaxed [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700 [&::-webkit-scrollbar-thumb:hover]:bg-zinc-600 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-2"
                aria-live="polite"
                aria-label="Terminal output"
              >
                {lines.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-600">
                    <Terminal className="h-8 w-8" />
                    <p className="text-xs">Terminal idle — connect an agent to begin.</p>
                  </div>
                ) : (
                  lines.map(renderLine)
                )}
              </div>
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendCommand();
                }}
              >
                <span className="hidden shrink-0 font-mono text-xs text-emerald-500 sm:block">❯</span>
                <Input
                  className="border-zinc-800 bg-zinc-950 font-mono text-sm focus-visible:ring-emerald-500/40"
                  placeholder={agentOnline ? "type a command…" : "waiting for agent — run the script on your PC"}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  disabled={!agentOnline}
                  aria-label="Command input"
                />
                {running ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={stopCommand}
                    className="shrink-0 gap-1.5 bg-rose-600 hover:bg-rose-500"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" /> Stop
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!agentOnline}
                    className="shrink-0 gap-1.5 bg-emerald-600 hover:bg-emerald-500"
                  >
                    Run
                  </Button>
                )}
              </form>
            </CardContent>
          </Card>

          {/* Right column */}
          <div className="flex flex-col gap-6">
            <Card className="border-zinc-800 bg-zinc-900/50">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <MonitorSmartphone className="h-4 w-4 text-emerald-400" />
                  Connect your computer
                </CardTitle>
                <CardDescription>Three steps, nothing gets installed.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500/15 text-[11px] font-semibold text-emerald-400">
                      1
                    </span>
                    <span className="text-xs text-zinc-400">Download the agent script</span>
                  </div>
                  <Button asChild variant="outline" size="sm" className="w-full border-zinc-700 bg-zinc-950 hover:bg-zinc-800">
                    <a href="/agent.py" download>
                      <Download className="h-4 w-4" /> agent.py
                    </a>
                  </Button>
                </div>
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500/15 text-[11px] font-semibold text-emerald-400">
                      2
                    </span>
                    <span className="text-xs text-zinc-400">Run it on your PC</span>
                  </div>
                  <div className="break-all rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-emerald-300">
                    {runCmd || "…"}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400">
                      <Checkbox
                        checked={confirmMode}
                        onCheckedChange={(v) => setConfirmMode(v === true)}
                        className="border-zinc-700"
                      />
                      Ask before each command (safest)
                    </label>
                    <Button size="sm" variant="outline" className="h-7 border-zinc-700 bg-zinc-950 hover:bg-zinc-800" onClick={copyRun}>
                      {copied ? <span className="text-emerald-400">copied ✓</span> : "copy command"}
                    </Button>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
                    Requires Python 3.9+ and <code className="font-mono text-zinc-500">pip install websockets</code>.
                    On Windows use <code className="font-mono text-zinc-500">py</code> instead of{" "}
                    <code className="font-mono text-zinc-500">python</code> if needed.
                  </p>
                </div>
                <Separator className="bg-zinc-800" />
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500/15 text-[11px] font-semibold text-emerald-400">
                      3
                    </span>
                    <span className="text-xs text-zinc-400">Watch the badge turn green</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5">
                    <KeyRound className="h-4 w-4 shrink-0 text-amber-400" />
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400" title={token}>
                      {token || "…"}
                    </code>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 gap-1 px-2 text-[11px] text-zinc-500 hover:text-amber-400"
                      onClick={regenerate}
                      disabled={regenerating}
                    >
                      {regenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      regenerate
                    </Button>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
                    Anyone with this token can control the connected computer. Treat it like a password — regenerate it
                    if it leaks.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-zinc-900/50">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="h-4 w-4 text-amber-400" />
                  How it stays safe
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2.5 text-xs leading-relaxed text-zinc-400">
                  <li className="flex gap-2">
                    <span className="text-emerald-400">•</span>
                    <span>
                      <strong className="text-zinc-200">Transparent:</strong> every command is echoed in the agent
                      window on your PC before it runs.
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-emerald-400">•</span>
                    <span>
                      <strong className="text-zinc-200">Ephemeral:</strong> no install, no autostart, no persistence —
                      Ctrl+C in the agent window instantly ends all access.
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-emerald-400">•</span>
                    <span>
                      <strong className="text-zinc-200">Authenticated &amp; encrypted:</strong> the relay rejects every
                      connection without your token; traffic runs over TLS (wss).
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-emerald-400">•</span>
                    <span>
                      <strong className="text-zinc-200">Approval mode:</strong> tick the box in step 2 to add{" "}
                      <code className="font-mono text-zinc-500">--confirm</code> and y/n every command locally.
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-emerald-400">•</span>
                    <span>
                      <strong className="text-zinc-200">Kill switch:</strong> the Stop button terminates a running
                      command; the script refuses plain ws:// URLs on the public internet.
                    </span>
                  </li>
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      {/* Footer — sticks to the bottom, respects safe areas */}
      <footer className="mt-auto border-t border-zinc-800/80 bg-zinc-900/70 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex h-12 w-full max-w-7xl items-center justify-between gap-3 px-4 text-[11px] text-zinc-500 sm:px-6">
          <span className="truncate">
            Access exists only while the agent script is running on your computer. Keep your token private.
          </span>
          <span className="shrink-0 font-mono">relay: {relayStatus}</span>
        </div>
      </footer>
    </div>
  );
}
