/**
 * Security regression test for the browser-mode server (#51).
 *
 * Spawns server/index.ts with a known port + token, then checks the lockdown:
 * /edit needs the token, and the WebSocket only serves an existing .md file to
 * a caller with the right token AND Origin. Guards against the arbitrary local
 * file read/write hole coming back.
 * (No build needed — /edit and /ws don't touch dist/.)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";

const PORT = 38971;
const TOKEN = "test-secret-token";
const ORIGIN = `http://localhost:${PORT}`;
const encode = (p: string) => Buffer.from(p).toString("base64url");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  ok ? passed++ : failed++;
}

/** Open the WS, send "ready", and report what came back:
 *  the file's text on success, or "rejected" if the socket was refused. */
function openWs(filePath: string, token: string | null, origin: string): Promise<string> {
  const url = `ws://localhost:${PORT}/ws/${encode(filePath)}${token ? `?t=${token}` : ""}`;
  const ws = new WebSocket(url, { headers: { Origin: origin } });
  return new Promise((done) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "ready" })));
    ws.on("message", (raw) => { ws.close(); done(JSON.parse(raw.toString()).content); });
    ws.on("error", () => done("rejected"));
    ws.on("close", () => done("rejected"));
    setTimeout(() => done("timeout"), 3000);
  });
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${ORIGIN}/`); return; } catch { await sleep(250); }
  }
  throw new Error("server did not start");
}

async function main() {
  // A markdown file the server may serve, and a secret it must never serve.
  const dir = mkdtempSync(join(tmpdir(), "prosedown-sec-"));
  const doc = join(dir, "doc.md");
  const secret = join(dir, "secret.txt");
  writeFileSync(doc, "hello");
  writeFileSync(secret, "TOPSECRET");

  const server = spawn("npx", ["tsx", resolve(__dirname, "..", "server", "index.ts")], {
    env: { ...process.env, PORT: String(PORT), PROSEDOWN_TOKEN: TOKEN },
    stdio: "ignore",
  });

  console.log("Server-security tests (#51)");
  try {
    await waitForServer();

    // /edit is gated by the capability token
    check("/edit without token -> 403", (await fetch(`${ORIGIN}/edit/${encode(doc)}`)).status === 403);
    check("/edit with token -> 200", (await fetch(`${ORIGIN}/edit/${encode(doc)}?t=${TOKEN}`)).status === 200);

    // the WebSocket only serves an existing .md to the right token + Origin
    check("WS right token + origin + .md -> serves file", (await openWs(doc, TOKEN, ORIGIN)) === "hello");
    check("WS no token -> rejected", (await openWs(doc, null, ORIGIN)) === "rejected");
    check("WS wrong origin -> rejected", (await openWs(doc, TOKEN, "http://evil.com")) === "rejected");
    check("WS non-.md file -> rejected", (await openWs(secret, TOKEN, ORIGIN)) === "rejected");
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
