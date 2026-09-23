/**
 * AnalogDesk - optional HTTP(S) proxy support, because the network this project is built on resets
 * every *.bitget.com connection at the TCP layer.
 *
 * This is not a workaround to hide a failure. It is a measurement instrument: bitget.mjs probes the
 * Bitget endpoints BOTH ways - direct, and via a local proxy when one is present - and records which
 * route produced the answer. A reviewer reading the provenance panel can therefore see exactly what
 * was reachable from where, instead of a single ambiguous "Bitget: down".
 *
 * Zero dependencies. Node's global fetch does not honour the system proxy, and undici's ProxyAgent is
 * not exposed as an importable module, so the CONNECT tunnel is implemented directly on node:net +
 * node:tls and handed to node:https through createConnection.
 */

import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import http from "node:http";

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

/** Parse a proxy out of the environment. Returns null when nothing is configured. */
export function detectProxy(env = process.env) {
  for (const name of PROXY_VARS) {
    const raw = env[name];
    if (!raw) continue;
    const m = String(raw).trim().match(/^(?:https?:\/\/)?([^:\/\s@]+)(?::(\d+))?/);
    if (!m) continue;
    const port = m[2] ? Number(m[2]) : 80;
    if (Number.isFinite(port) && port > 0) return { host: m[1], port, source: name + "=" + String(raw).trim() };
  }
  return null;
}

/** Common local proxy ports, used only when the environment says nothing. */
export const LOCAL_PROXY_PORTS = [7890, 7897, 7891, 10809, 10808, 1080, 8888, 8118, 2080, 1087];

/** Probe 127.0.0.1 for a listening local proxy. Cheap: one TCP connect per port, short timeout. */
export async function detectLocalProxy({ ports = LOCAL_PROXY_PORTS, timeoutMs = 350 } = {}) {
  for (const port of ports) {
    const open = await new Promise((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
      const timer = setTimeout(() => done(false), timeoutMs);
      sock.once("error", () => { clearTimeout(timer); done(false); });
      sock.once("connect", () => { clearTimeout(timer); done(true); });
    });
    if (open) return { host: "127.0.0.1", port, source: "auto-detected listening local proxy 127.0.0.1:" + port };
  }
  return null;
}

/** Open a CONNECT tunnel through an HTTP proxy and resolve the raw socket. */
function tunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    let buf = "";
    let settled = false;
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch {} reject(e); };
    const timer = setTimeout(() => fail(new Error("proxy CONNECT timed out after " + timeoutMs + "ms")), timeoutMs);
    sock.once("error", fail);
    sock.once("connect", () => {
      sock.write("CONNECT " + host + ":" + port + " HTTP/1.1\r\nHost: " + host + ":" + port + "\r\nProxy-Connection: keep-alive\r\n\r\n");
    });
    const onData = (d) => {
      buf += d.toString("latin1");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      sock.removeListener("data", onData);
      const head = buf.slice(0, idx).split("\r\n")[0];
      // Only a 200 means the tunnel exists; anything else is the proxy refusing the target.
      if (!/\s200\b/.test(head)) return fail(new Error("proxy CONNECT refused: " + head));
      clearTimeout(timer);
      settled = true;
      // Bytes of the real response can ride in the same chunk as the CONNECT header.
      if (idx + 4 < buf.length) sock.unshift(Buffer.from(buf.slice(idx + 4), "latin1"));
      resolve(sock);
    };
    sock.on("data", onData);
  });
}

/**
 * One HTTP(S) request through a CONNECT tunnel.
 * @returns {Promise<{status:number,headers:object,body:string,ms:number}>}
 */
export async function proxyRequest(url, { proxy, method = "GET", headers = {}, body = null, timeoutMs = 45000 } = {}) {
  const u = new URL(url);
  const t0 = Date.now();
  const sock = await tunnel(proxy, u.hostname, Number(u.port) || 443, Math.min(timeoutMs, 20000));
  const tlsSock = tls.connect({ socket: sock, servername: u.hostname, ALPNProtocols: ["http/1.1"] });
  const lib = u.protocol === "http:" ? http : https;
  const payload = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname,
      port: Number(u.port) || (u.protocol === "http:" ? 80 : 443),
      path: (u.pathname || "/") + (u.search || ""),
      method,
      headers: Object.assign({ Host: u.host }, payload != null ? { "Content-Length": Buffer.byteLength(payload) } : {}, headers),
      createConnection: () => tlsSock,
      servername: u.hostname
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - t0 }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timed out after " + timeoutMs + "ms")));
    req.once("error", (e) => { try { tlsSock.destroy(); } catch {} reject(e); });
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** The event: message / data: {...} framing an MCP HTTP transport replies with, plus SSE pings. */
export function parseSSE(text, id = null) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.startsWith("data:"));
  const parsed = [];
  for (const l of lines) {
    const p = l.slice(5).trim();
    if (!p) continue;
    try { parsed.push(JSON.parse(p)); } catch {}
  }
  if (id != null) {
    const hit = parsed.find((m) => m && m.id === id && (m.result !== undefined || m.error !== undefined));
    if (hit) return hit;
  }
  return parsed[parsed.length - 1] || null;
}
