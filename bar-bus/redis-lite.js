"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Минимальный Redis-клиент (RESP2) без внешних зависимостей — в духе проекта.
// Поддерживает ровно то, что нужно кэшу карты: GET, SET PX, DEL, PING, AUTH.
//
// Поведение при сбоях: клиент никогда не роняет вызывающий код — при
// недоступности Redis операции быстро завершаются null/false, и кэш карты
// прозрачно работает через память. Переподключение — автоматическое.
// ─────────────────────────────────────────────────────────────────────────────

const net = require("node:net");
const tls = require("node:tls");

const COMMAND_TIMEOUT_MS = 1500;
const RECONNECT_DELAY_MS = 10000;

class RedisLite {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.lastFailureAt = 0;
    this.buffer = Buffer.alloc(0);
    this.pending = []; // очередь ожидающих ответа {resolve}
  }

  // ── Подключение ──────────────────────────────────────────────────────────
  _connect() {
    if (this.connected || this.connecting) return;
    if (Date.now() - this.lastFailureAt < RECONNECT_DELAY_MS) return;
    this.connecting = true;

    const port = Number(this.url.port) || 6379;
    const host = this.url.hostname || "127.0.0.1";
    const useTls = this.url.protocol === "rediss:";
    const socket = useTls ? tls.connect({ host, port }) : net.connect({ host, port });
    this.socket = socket;

    const fail = () => {
      this.connected = false;
      this.connecting = false;
      this.lastFailureAt = Date.now();
      for (const item of this.pending.splice(0)) item.resolve(null);
      socket.destroy();
      if (this.socket === socket) this.socket = null;
    };

    socket.setTimeout(4000, fail);
    socket.on("error", fail);
    socket.on("close", fail);
    socket.on(useTls ? "secureConnect" : "connect", async () => {
      socket.setTimeout(0);
      this.connected = true;
      this.connecting = false;
      const password = this.url.password || "";
      const username = this.url.username || "";
      if (password) {
        await this._send(username ? ["AUTH", username, password] : ["AUTH", password]);
      }
      const dbMatch = this.url.pathname.match(/^\/(\d+)$/);
      if (dbMatch) await this._send(["SELECT", dbMatch[1]]);
    });
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._drain();
    });
  }

  // ── RESP2-парсер (только нужные типы ответов) ────────────────────────────
  _parseOne() {
    const buf = this.buffer;
    if (!buf.length) return undefined;
    const nl = buf.indexOf("\r\n");
    if (nl === -1) return undefined;
    const head = buf.slice(1, nl).toString();
    const type = String.fromCharCode(buf[0]);

    if (type === "+" || type === "-" || type === ":") {
      this.buffer = buf.slice(nl + 2);
      if (type === "-") return { value: null };
      if (type === ":") return { value: Number(head) };
      return { value: head };
    }
    if (type === "$") {
      const len = Number(head);
      if (len === -1) {
        this.buffer = buf.slice(nl + 2);
        return { value: null };
      }
      const end = nl + 2 + len;
      if (buf.length < end + 2) return undefined;
      const value = buf.slice(nl + 2, end).toString();
      this.buffer = buf.slice(end + 2);
      return { value };
    }
    if (type === "*") {
      // массивы нам не нужны — пропускаем элементы по одному
      const count = Number(head);
      this.buffer = buf.slice(nl + 2);
      const items = [];
      for (let i = 0; i < count; i++) {
        const item = this._parseOne();
        if (item === undefined) return undefined; // ждём данных (упрощение: не буферизуем частично)
        items.push(item.value);
      }
      return { value: items };
    }
    // неизвестный тип — сбрасываем буфер, чтобы не зациклиться
    this.buffer = Buffer.alloc(0);
    return { value: null };
  }

  _drain() {
    while (this.pending.length) {
      const parsed = this._parseOne();
      if (parsed === undefined) return;
      this.pending.shift().resolve(parsed.value);
    }
  }

  _send(args) {
    return new Promise((resolve) => {
      if (!this.connected || !this.socket) {
        resolve(null);
        return;
      }
      const parts = [`*${args.length}\r\n`];
      for (const arg of args) {
        const text = String(arg);
        parts.push(`$${Buffer.byteLength(text)}\r\n${text}\r\n`);
      }
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((item) => item.resolve === wrapped);
        if (index !== -1) this.pending.splice(index, 1);
        resolve(null);
      }, COMMAND_TIMEOUT_MS);
      const wrapped = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.pending.push({ resolve: wrapped });
      this.socket.write(parts.join(""), (error) => {
        if (error) wrapped(null);
      });
    });
  }

  // ── Публичный API ────────────────────────────────────────────────────────
  async get(key) {
    this._connect();
    if (!this.connected) return null;
    return this._send(["GET", key]);
  }

  async set(key, value, ttlMs) {
    this._connect();
    if (!this.connected) return false;
    const args = ttlMs ? ["SET", key, value, "PX", String(Math.max(1000, ttlMs))] : ["SET", key, value];
    return (await this._send(args)) === "OK";
  }

  async del(...keys) {
    this._connect();
    if (!this.connected) return 0;
    return this._send(["DEL", ...keys]);
  }

  async ping() {
    this._connect();
    if (!this.connected) return false;
    return (await this._send(["PING"])) === "PONG";
  }
}

module.exports = { RedisLite };
