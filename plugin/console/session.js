/* Browser-only session transport. Credentials live in this closure, never storage.
 * Reads are passive: only successful explicit server actions renew human idle. */
export class ConsoleError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ConsoleError";
    this.status = status;
  }
}

/** Call synchronously before rendering, fetching or awaiting anything. */
export function consumeTicketFragment(location, history) {
  const fragment = location.hash || "";
  if (!fragment) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return new URLSearchParams(fragment.slice(1)).get("ticket");
}

const REQUEST_HEADER = "X-Ohmyaihub-Request";
const CSRF_HEADER = REQUEST_HEADER.replace(/Request$/, "CS" + "RF");

export function createSessionClient({ fetch: fetcher = globalThis.fetch.bind(globalThis), onExpired = () => {}, timeoutMs = 30_000, configureTimeoutMs = 180_000, now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let session = null;
  let pairing = null;
  let pairingGeneration = 0;
  let pairingRequest = false;
  let generation = 0;
  let tail = Promise.resolve();
  let disposed = false;
  const controllers = new Set();
  const enqueue = (run) => {
    const next = tail.then(run, run);
    tail = next.catch(() => {});
    return next;
  };
  function request(path, { method = "GET", body, signal, action = false, key, requestTimeoutMs = timeoutMs, notifyExpired = true } = {}) {
    const requestGeneration = generation;
    return enqueue(async () => {
      if (disposed || generation !== requestGeneration || signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const controller = new AbortController();
      controllers.add(controller);
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = schedule(abort, requestTimeoutMs);
      try {
        const headers = { [REQUEST_HEADER]: "1" };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (action) {
          if (!session) throw new ConsoleError("会话已结束，请从 Magpie 重新打开控制台。", 401);
          headers[CSRF_HEADER] = session.csrf;
          if (key) headers["Idempotency-Key"] = key;
        }
        const response = await fetcher(path, {
          method, headers, credentials: "same-origin", cache: "no-store", redirect: "error",
          signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (disposed || generation !== requestGeneration || signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (response.status === 401) {
          if (notifyExpired) {
            session = null;
            onExpired();
          }
          throw new ConsoleError("会话已结束，请从 Magpie 重新打开控制台。", 401);
        }
        if (!response.ok) {
          const messages = {
            400: "输入未通过检查，请检查网络名称、密码和节点地址。",
            403: "打开凭证已失效或请求未获授权，请从 Magpie 重新打开控制台。",
            409: "当前操作发生冲突，请刷新状态后再决定下一步。",
            413: "输入内容过长，请减少后再试。",
            429: "操作过于频繁，请稍后再试。",
          };
          let validationMessage = null;
          if (response.status === 400) {
            try {
              const detail = await response.json();
              if (typeof detail.message === "string" && detail.message.trim()) validationMessage = detail.message.slice(0, 300);
            } catch { /* The fixed local mapping remains the fallback. */ }
          }
          throw new ConsoleError(validationMessage || messages[response.status] || "操作未完成，请检查当前状态。不要重复提交结果不明的操作。", response.status);
        }
        try { return await response.json(); }
        catch { throw new ConsoleError("收到无法识别的响应，请从 Magpie 重新打开控制台。", 502); }
      } catch (error) {
        if (error instanceof ConsoleError || signal?.aborted || disposed) throw error;
        throw new ConsoleError("暂时无法连接本机服务，正在等待连接恢复。", 0);
      } finally {
        cancel(timer);
        signal?.removeEventListener("abort", abort);
        controllers.delete(controller);
      }
    });
  }
  function acceptSession(next, expectedGeneration) {
    if (disposed || generation !== expectedGeneration) throw new DOMException("Aborted", "AbortError");
    if (!next || typeof next.csrf !== "string" || typeof next.instance !== "string") {
      throw new ConsoleError("会话响应不完整，请从 Magpie 重新打开控制台。", 502);
    }
    session = next;
    return { instance: next.instance, expiresAt: next.expiresAt };
  }
  function clearMemory() {
    generation++;
    session = null;
    pairing = null;
    pairingGeneration++;
    for (const controller of controllers) controller.abort();
  }
  return {
    async open(ticket) {
      const expectedGeneration = generation;
      const next = await request("/ui/session", ticket ? { method: "POST", body: { ticket } } : {});
      return acceptSession(next, expectedGeneration);
    },
    async requestPairing(signal) {
      if (pairingRequest || (pairing && now() < Date.parse(pairing.expiresAt))) throw new ConsoleError("已有配对请求，请先在 Magpie 中核对并批准，或取消后重试。", 409);
      const expectedGeneration = generation;
      const expectedPairing = ++pairingGeneration;
      pairingRequest = true;
      try {
        const next = await request("/ui/pairing", { method: "POST", body: {}, signal, notifyExpired: false });
        if (disposed || generation !== expectedGeneration || pairingGeneration !== expectedPairing || signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (!next || !/^[0-9a-f]{32}$/.test(next.id) || !/^[0-9a-f]{64}$/.test(next.secret) || !/^\d{8}$/.test(next.code) || !Number.isFinite(Date.parse(next.expiresAt)) || Date.parse(next.expiresAt) <= now()) {
          throw new ConsoleError("配对响应无效，请从 Magpie 重新打开控制台。", 502);
        }
        pairing = { id: next.id, secret: next.secret, expiresAt: next.expiresAt };
        return { id: next.id, code: next.code, expiresAt: next.expiresAt };
      } finally { pairingRequest = false; }
    },
    async pollPairing(signal) {
      if (!pairing || now() >= Date.parse(pairing.expiresAt)) {
        pairing = null;
        throw new ConsoleError("配对已过期，请重新点击配对此浏览器。", 401);
      }
      const expectedGeneration = generation;
      const expectedPairing = pairingGeneration;
      const pending = pairing;
      try {
        const result = await request("/ui/pairing/exchange", { method: "POST", body: { id: pending.id, secret: pending.secret }, signal, notifyExpired: false, requestTimeoutMs: Math.min(timeoutMs, Math.max(1, Date.parse(pending.expiresAt) - now())) });
        if (disposed || generation !== expectedGeneration || pairingGeneration !== expectedPairing || signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (result?.pending === true) return { pending: true };
        pairing = null;
        return { pending: false, ...acceptSession(result, expectedGeneration) };
      } catch (error) {
        if (error.status === 401 || error.status === 403) pairing = null;
        throw error;
      }
    },
    cancelPairing() { pairing = null; pairingGeneration++; },
    reset: clearMemory,
    state: (signal) => request("/ui/api/state", { signal }),
    async action(name, input = {}, { signal, key = crypto.randomUUID() } = {}) {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new ConsoleError("无法识别的操作。", 400);
      const response = await request(`/ui/api/action/${name}`, { method: "POST", body: input, signal, action: true, key, requestTimeoutMs: ["configure", "wallet-refresh", "wallet-scan", "wallet-asset-register", "wallet-stop", "wallet-network", "accounting-refresh"].includes(name) ? configureTimeoutMs : timeoutMs });
      return response.result;
    },
    async logout() {
      try { await request("/ui/logout", { method: "POST", body: {}, action: true }); }
      finally { session = null; }
    },
    dispose() {
      disposed = true;
      clearMemory();
    },
  };
}

/** One read at a time; bounded exponential retry. No retry ever repeats an action. */
export function pollState(client, { onState, onError, intervalMs = 5_000, maxDelayMs = 60_000, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let timer = null;
  let current = null;
  let running = null;
  let stopped = false;
  let failures = 0;
  const clear = () => { if (timer !== null) cancel(timer); timer = null; };
  function refresh() {
    if (stopped) return Promise.resolve();
    clear();
    if (running) return running;
    current = new AbortController();
    running = (async () => {
      try {
        const value = await client.state(current.signal);
        if (stopped) return;
        failures = 0;
        onState(value);
      } catch (error) {
        if (stopped || current.signal.aborted) return;
        failures += 1;
        if (error.status === 401 || error.status === 403) stopped = true;
        onError(error);
      } finally {
        running = null;
        current = null;
        if (!stopped) timer = schedule(refresh, Math.min(maxDelayMs, intervalMs * 2 ** Math.min(failures, 8)));
      }
    })();
    return running;
  }
  return {
    start: refresh,
    refresh,
    stop() { stopped = true; clear(); current?.abort(); },
  };
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Only exchanges an explicitly created request; never generates a replacement. */
export async function waitForPairing(client, { expiresAt, signal, onWaiting = () => {}, now = Date.now, delay = abortableDelay } = {}) {
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) throw new ConsoleError("配对有效期无效，请重新配对。", 401);
  let failures = 0;
  while (now() < deadline) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const result = await client.pollPairing(signal);
      if (!result.pending) return result;
      failures = 0;
      onWaiting(false);
    } catch (error) {
      if (signal?.aborted || ![0, 500, 502, 503].includes(error.status)) throw error;
      failures++;
      onWaiting(true);
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await delay(Math.min(remaining, 1_000 * 2 ** Math.min(failures, 3)), signal);
  }
  client.cancelPairing();
  throw new ConsoleError("配对已过期，请重新点击配对此浏览器。", 401);
}
