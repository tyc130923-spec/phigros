
(() => {
  "use strict";
  const audit = { attempts: [], blocked: 0 };
  const remote = (value) => { try { const u = new URL(String(value?.url || value || ""), location.href); return u.protocol === "ws:" || u.protocol === "wss:" || ((u.protocol === "http:" || u.protocol === "https:") && u.origin !== location.origin); } catch { return false; } };
  const deny = (api, value) => { const target = String(value?.url || value || ""); audit.attempts.push({ api, target, at: performance.now() }); audit.blocked++; return new TypeError("Offline policy blocked " + api); };
  const nativeFetch = globalThis.fetch?.bind(globalThis);
  if (nativeFetch) globalThis.fetch = (input, init) => remote(input) ? Promise.reject(deny("fetch", input)) : nativeFetch(input, init);
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { if (remote(url)) throw deny("XMLHttpRequest", url); return open.call(this, method, url, ...rest); };
  if (navigator.sendBeacon) navigator.sendBeacon = (url) => { if (remote(url)) { deny("sendBeacon", url); return false; } return false; };
  for (const name of ["WebSocket", "EventSource"]) { const Native = globalThis[name]; if (!Native) continue; globalThis[name] = class OfflineTransport extends Native { constructor(url, ...rest) { if (remote(url)) throw deny(name, url); super(url, ...rest); } }; }
  Object.defineProperty(globalThis, "__phiNetworkAudit", { value: audit, enumerable: false });
})();
