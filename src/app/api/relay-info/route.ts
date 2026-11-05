import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Reads (or lazily creates) the shared relay token.
 * The relay mini-service uses the same file, so both sides agree.
 */
const TOKEN_FILE = join(process.cwd(), "mini-services", "remote-relay", "token.txt");

function readToken(): string {
  try {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 16) return t;
  } catch {
    /* create below */
  }
  const t = randomBytes(24).toString("hex");
  try {
    writeFileSync(TOKEN_FILE, t);
  } catch {
    /* read-only fs: relay may still hold the token itself */
  }
  return t;
}

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ token: readToken(), port: 3030 });
}

/** Regenerate the token. Old connections stay alive; new ones need the new token. */
export async function POST() {
  const token = randomBytes(24).toString("hex");
  try {
    writeFileSync(TOKEN_FILE, token);
  } catch {
    return NextResponse.json({ error: "could not persist token" }, { status: 500 });
  }
  return NextResponse.json({ token });
}
