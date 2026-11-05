#!/usr/bin/env python3
"""
AI Remote Agent
===============
A small, transparent agent that connects YOUR computer to YOUR AI web
terminal. Run it, and the terminal in the browser can execute shell
commands on this machine. Stop it (Ctrl+C) and all access is gone.

    python agent.py --server wss://<your-preview-host>/?XTransformPort=3030 --token <TOKEN>

Options:
    --confirm     Ask y/n locally before running EVERY command (safest).
    --name NAME   Friendly machine name shown in the web terminal.
    --insecure    Allow plain ws:// (local testing only - never over internet).

Design principles (read this!):
    * TRANSPARENT  - every command is printed in this window before it runs.
    * EPHEMERAL    - nothing is installed, nothing autostarts, no persistence.
                     Closing this script = access closed, instantly.
    * AUTHENTICATED- the relay requires your secret token; without it the
                     server refuses every connection.
    * CONSENT      - use --confirm if you want to approve each command.

Requires: Python 3.9+ and one dependency:
    pip install websockets
"""

import argparse
import asyncio
import base64
import codecs
import getpass
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
from urllib.parse import urlencode

try:
    import websockets
except ImportError:
    print("Missing dependency 'websockets'. Install it with:\n\n    pip install websockets\n")
    sys.exit(1)

MAX_OUTPUT_BYTES = 1_000_000          # per-command output cap sent upstream
MAX_FILE_BYTES = 10 * 1024 * 1024     # download cap (10 MB)
RECV_CHUNK = 8192
DEFAULT_TIMEOUT = 1800                # seconds; a runaway command is killed after this

IS_WINDOWS = platform.system() == "Windows"

FATAL_CLOSE = {
    4001: "Invalid or missing token - copy the exact run command from the web terminal.",
    4002: "Bad role configuration.",
}


def collect_sysinfo(cwd=None):
    """Basic, non-sensitive machine facts shown in the web terminal."""
    return {
        "hostname": socket.gethostname(),
        "user": getpass.getuser(),
        "os": platform.system(),
        "release": platform.release(),
        "version": platform.platform(),
        "arch": platform.machine(),
        "python": platform.python_version(),
        "cpus": os.cpu_count() or 1,
        "cwd": cwd or os.getcwd(),
        "home": os.path.expanduser("~"),
    }


class Agent:
    def __init__(self, server, token, confirm=False, name=None):
        self.server = server.rstrip("/")
        self.token = token
        self.confirm = confirm
        self.name = name
        self.cwd = os.getcwd()
        self.proc = None          # currently running shell subprocess
        self.kill_requested = False
        self.ws = None

    # ------------------------------------------------------------------ #
    # Connection plumbing                                                #
    # ------------------------------------------------------------------ #

    async def run_forever(self):
        info = collect_sysinfo(self.cwd)
        if self.name:
            info["name"] = self.name
        backoff = 1
        try:
            while True:
                ws = None
                try:
                    url = self.server + ("&" if "?" in self.server else "?") + urlencode(
                        {"token": self.token, "role": "agent"}
                    )
                    print(f"[*] Connecting to {self.server} ...")
                    async with websockets.connect(
                        url, ping_interval=20, ping_timeout=20, close_timeout=5
                    ) as ws:
                        self.ws = ws
                        backoff = 1
                        await self.send({"type": "hello", "info": info})
                        print("[+] Connected. The web terminal can now reach this computer.")
                        print("    Every incoming command is printed below. Ctrl+C quits.\n")
                        await self.recv_loop()
                except asyncio.CancelledError:
                    raise
                except KeyboardInterrupt:
                    raise
                except Exception as exc:  # noqa: BLE001 - report and retry
                    print(f"[!] Connection error: {exc}")

                self.ws = None
                code = getattr(ws, "close_code", None) or 0
                reason = str(getattr(ws, "close_reason", "") or "")
                if code in FATAL_CLOSE:
                    print(f"\n[!] {FATAL_CLOSE[code]}")
                    return
                if code == 1000 and "replaced" in reason:
                    print("\n[!] Another agent instance took over this connection - exiting.")
                    return
                print(f"[*] Reconnecting in {backoff}s ...")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 15)
        finally:
            self.kill_current(silent=True)

    async def send(self, obj):
        if self.ws is None:
            return
        try:
            await self.ws.send(json.dumps(obj))
        except Exception:
            pass  # connection dropped; the reconnect loop will handle it

    async def recv_loop(self):
        async for raw in self.ws:
            try:
                msg = json.loads(raw)
            except (TypeError, ValueError):
                continue
            mtype = msg.get("type")
            if mtype == "ping":
                await self.send({"type": "pong"})
            elif mtype == "pong":
                pass
            elif mtype == "exec":
                asyncio.ensure_future(self.handle_exec(msg))
            elif mtype == "kill":
                if self.proc is not None:
                    print("[!] Stop requested from web terminal - killing running command")
                    self.kill_requested = True
                    self.kill_current()

    # ------------------------------------------------------------------ #
    # Command handling                                                   #
    # ------------------------------------------------------------------ #

    async def handle_exec(self, msg):
        cmd_id = msg.get("id")
        command = str(msg.get("command", ""))
        try:
            timeout = float(msg.get("timeout")) if msg.get("timeout") else None
        except (TypeError, ValueError):
            timeout = None
        timeout = timeout or DEFAULT_TIMEOUT

        print(f"\n[cmd] $ {command}")

        if self.proc is not None:
            await self.send({
                "type": "result", "id": cmd_id, "event": "error",
                "data": "agent busy - another command is still running. Press Stop first.",
            })
            return

        if self.confirm:
            answer = await asyncio.to_thread(
                input, ">>> Run this command on this machine? [y/N] "
            )
            if answer.strip().lower() not in ("y", "yes"):
                print("[!] Declined locally (--confirm mode)")
                await self.send({
                    "type": "result", "id": cmd_id, "event": "error",
                    "data": "declined locally (--confirm mode)",
                })
                return

        self.kill_requested = False
        stripped = command.strip()
        try:
            if stripped == "sysinfo":
                await self.run_sysinfo(cmd_id)
            elif stripped.startswith("download "):
                await self.run_download(cmd_id, stripped[len("download "):])
            elif stripped == "cd" or stripped.startswith("cd "):
                await self.run_cd(cmd_id, stripped[2:].strip())
            else:
                await self.run_shell(cmd_id, command, timeout)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - surface anything unexpected
            await self.send({
                "type": "result", "id": cmd_id, "event": "error",
                "data": f"agent error: {exc}",
            })

    async def run_shell(self, cmd_id, command, timeout):
        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.cwd,
            )
        except Exception as exc:
            await self.send({"type": "result", "id": cmd_id, "event": "error", "data": str(exc)})
            return

        self.proc = proc
        truncated = False

        async def pump(stream, kind):
            nonlocal truncated
            if stream is None:
                return
            dec = codecs.getincrementaldecoder("utf-8")("replace")
            while True:
                chunk = await stream.read(RECV_CHUNK)
                if not chunk:
                    break
                text = dec.decode(chunk)
                if not text:
                    continue
                if truncated:
                    continue
                if len(text.encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
                    truncated = True
                    await self.send({
                        "type": "result", "id": cmd_id, "event": kind,
                        "data": f"\n[output truncated - exceeded {MAX_OUTPUT_BYTES // 1000} KB]",
                    })
                    continue
                await self.send({"type": "result", "id": cmd_id, "event": kind, "data": text})
            tail = dec.decode(b"", True)
            if tail and not truncated:
                await self.send({"type": "result", "id": cmd_id, "event": kind, "data": tail})

        t_out = asyncio.create_task(pump(proc.stdout, "stdout"))
        t_err = asyncio.create_task(pump(proc.stderr, "stderr"))

        timed_out = False
        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            timed_out = True
            print(f"[!] Timeout after {int(timeout)}s - killing process tree")
            self.kill_current()
            await proc.wait()

        # Streams close (or hit EOF) when the process dies; cap the drain wait.
        done = asyncio.gather(t_out, t_err, return_exceptions=True)
        try:
            await asyncio.wait_for(done, timeout=10)
        except asyncio.TimeoutError:
            t_out.cancel()
            t_err.cancel()

        rc = await proc.wait()
        self.proc = None

        payload = {"type": "result", "id": cmd_id, "event": "exit", "code": rc, "cwd": self.cwd}
        if timed_out:
            payload["note"] = f"command killed after {int(timeout)}s timeout"
        elif self.kill_requested:
            payload["note"] = "stopped by user"
        await self.send(payload)
        state = " (timeout)" if timed_out else (" (stopped)" if self.kill_requested else "")
        print(f"[done] exit {rc}{state}")
        self.kill_requested = False

    async def run_cd(self, cmd_id, target):
        """Change the persistent working directory (shell semantics respected)."""
        if not target:
            new_cwd = os.path.expanduser("~")
        else:
            if IS_WINDOWS:
                shell_cmd = f"cd /d {target} && cd"
            else:
                shell_cmd = f"cd {target} && pwd"
            try:
                out = subprocess.run(
                    shell_cmd, shell=True, capture_output=True,
                    cwd=self.cwd, timeout=10,
                )
            except Exception as exc:
                await self.send({"type": "result", "id": cmd_id, "event": "error", "data": f"cd: {exc}"})
                return
            if out.returncode != 0:
                err = out.stderr.decode("utf-8", "replace").strip() or f"cd: failed: {target}"
                await self.send({"type": "result", "id": cmd_id, "event": "stderr", "data": err})
                await self.send({
                    "type": "result", "id": cmd_id, "event": "exit",
                    "code": out.returncode, "cwd": self.cwd,
                })
                return
            stdout = out.stdout.decode("utf-8", "replace").strip()
            new_cwd = stdout.splitlines()[-1] if stdout else self.cwd

        if os.path.isdir(new_cwd):
            self.cwd = new_cwd
            await self.send({"type": "result", "id": cmd_id, "event": "stdout", "data": self.cwd})
            await self.send({
                "type": "result", "id": cmd_id, "event": "exit", "code": 0, "cwd": self.cwd,
            })
            print(f"[cd] now in {self.cwd}")
        else:
            await self.send({
                "type": "result", "id": cmd_id, "event": "stderr",
                "data": f"cd: no such directory: {target}",
            })
            await self.send({"type": "result", "id": cmd_id, "event": "exit", "code": 1, "cwd": self.cwd})

    async def run_sysinfo(self, cmd_id):
        info = collect_sysinfo(self.cwd)
        try:
            disk = shutil.disk_usage(self.cwd)
            disk_line = (
                f"disk     : {disk.used // (1024 ** 3)} GB used / "
                f"{disk.total // (1024 ** 3)} GB total"
            )
        except Exception:
            disk_line = "disk     : n/a"
        lines = [
            f"hostname : {info['hostname']}",
            f"user     : {info['user']}",
            f"os       : {info['os']} {info['release']} ({info['arch']})",
            f"version  : {info['version']}",
            f"python   : {info['python']}",
            f"cpus     : {info['cpus']}",
            f"cwd      : {info['cwd']}",
            f"home     : {info['home']}",
            disk_line,
        ]
        await self.send({
            "type": "result", "id": cmd_id, "event": "stdout", "data": "\n".join(lines),
        })
        await self.send({"type": "result", "id": cmd_id, "event": "exit", "code": 0, "cwd": self.cwd})

    async def run_download(self, cmd_id, raw_path):
        path = raw_path.strip().strip('"').strip("'")
        path = os.path.expandvars(os.path.expanduser(path))
        print(f"[file] sending: {path}")
        try:
            if os.path.isdir(path):
                await self.send({
                    "type": "result", "id": cmd_id, "event": "error",
                    "data": f"download: '{path}' is a directory - pack it first (e.g. zip it)",
                })
                return
            if not os.path.isfile(path):
                await self.send({
                    "type": "result", "id": cmd_id, "event": "error",
                    "data": f"download: file not found: {path}",
                })
                return
            size = os.path.getsize(path)
            if size > MAX_FILE_BYTES:
                await self.send({
                    "type": "result", "id": cmd_id, "event": "error",
                    "data": f"download: file too large ({size} bytes; cap is {MAX_FILE_BYTES})",
                })
                return
            with open(path, "rb") as fh:
                b64 = base64.b64encode(fh.read()).decode("ascii")
            await self.send({
                "type": "result", "id": cmd_id, "event": "file",
                "name": os.path.basename(path), "size": size, "b64": b64,
            })
            print(f"[file] sent {size} bytes")
        finally:
            await self.send({"type": "result", "id": cmd_id, "event": "exit", "code": 0, "cwd": self.cwd})

    # ------------------------------------------------------------------ #
    # Process control                                                    #
    # ------------------------------------------------------------------ #

    def kill_current(self, silent=False):
        proc = self.proc
        if proc is None:
            return
        try:
            if IS_WINDOWS:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                    capture_output=True,
                )
            else:
                proc.kill()
        except Exception:
            pass
        if not silent:
            print("[!] Running command killed")


BANNER = """==============================================================
  AI REMOTE AGENT
  Transparent remote shell for your AI web terminal.
  Every command is printed HERE before it runs.
  Ctrl+C  ->  disconnect, all access closed instantly.
=============================================================="""


def main():
    parser = argparse.ArgumentParser(
        description="Connect this computer to your AI web terminal (transparent remote shell)."
    )
    parser.add_argument(
        "--server", required=True,
        help="relay websocket URL, e.g. wss://<host>/?XTransformPort=3030",
    )
    parser.add_argument("--token", required=True, help="access token (shown in the web terminal)")
    parser.add_argument("--confirm", action="store_true", help="ask y/n before every command")
    parser.add_argument("--name", help="friendly name for this machine")
    parser.add_argument(
        "--insecure", action="store_true",
        help="allow ws:// (non-TLS). Only for localhost testing - never over the internet.",
    )
    args = parser.parse_args()

    if args.server.startswith("wss://"):
        pass
    elif args.server.startswith("ws://") and args.insecure:
        pass
    elif args.server.startswith("ws://"):
        print("[!] Refusing insecure ws:// URL. Use the wss:// URL from the web terminal")
        print("    (or pass --insecure when testing against localhost).")
        sys.exit(1)
    else:
        print("[!] --server must start with wss:// (or ws:// together with --insecure).")
        sys.exit(1)

    print(BANNER)
    agent = Agent(args.server, args.token, confirm=args.confirm, name=args.name)
    try:
        asyncio.run(agent.run_forever())
    except KeyboardInterrupt:
        pass
    print("\n[*] Disconnected. Access to this computer is now closed.")


if __name__ == "__main__":
    main()
