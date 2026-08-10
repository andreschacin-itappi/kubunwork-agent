/**
 * Thin client for the tracking backend's agent surface.
 *
 * Endpoints mirrored from backend/src/routes/agent.routes.ts and
 * backend/src/routes/activity.routes.ts. Every call carries the agent JWT,
 * which the server issues with role "agent" (30d by default) — see
 * AuthService.generateAgentToken.
 */

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    /** Network/DNS/timeout failures have no status: those are retryable. */
    this.isNetwork = status === 0;
  }
}

/** Accept "10.0.0.5:3000" or "miservidor.com" and still produce a valid URL. */
function normalizeBaseUrl(input) {
  let url = String(input || "").trim().replace(/\/+$/, "");
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url;
}

class Api {
  constructor() {
    this.baseUrl = "";
    this.token = null;
  }

  configure({ baseUrl, token }) {
    if (baseUrl !== undefined) this.baseUrl = normalizeBaseUrl(baseUrl);
    if (token !== undefined) this.token = token;
  }

  async #request(method, pathname, { body, auth = true, timeoutMs = 20000 } = {}) {
    if (!this.baseUrl) throw new ApiError("No hay servidor configurado", 0, null);

    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
      if (!this.token) throw new ApiError("No hay sesión iniciada", 401, null);
      headers.Authorization = `Bearer ${this.token}`;
    }

    let res;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Offline, DNS failure, TLS error, timeout — all retryable, so they get
      // status 0 and the caller keeps the queue instead of discarding it.
      throw new ApiError(err.name === "TimeoutError" ? "El servidor no respondió" : "Sin conexión con el servidor", 0, null);
    }

    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      const msg = parsed?.error?.message || parsed?.message || parsed?.error || `Error ${res.status}`;
      throw new ApiError(msg, res.status, parsed);
    }
    return parsed;
  }

  login(email, password) {
    return this.#request("POST", "/api/agent/login", {
      body: { email, password },
      auth: false,
    });
  }

  me() {
    return this.#request("GET", "/api/agent/me");
  }

  config() {
    return this.#request("GET", "/api/config");
  }

  /**
   * Push buckets plus the day's wall-clock timer.
   *
   * `tracked_seconds` is absolute for the employee's local day, not a delta:
   * the server stores GREATEST(existing - idle_subtracted, tracked), so
   * resending the same total is idempotent and a lost batch self-heals on the
   * next sync. It returns its own total back for convergence.
   */
  postActivity({ records, trackedSeconds, idleSubtractedSeconds }) {
    const body = { records };
    if (trackedSeconds != null) body.tracked_seconds = Math.max(0, Math.floor(trackedSeconds));
    if (idleSubtractedSeconds != null) {
      body.idle_subtracted_seconds = Math.max(0, Math.floor(idleSubtractedSeconds));
    }
    return this.#request("POST", "/api/activity", { body, timeoutMs: 30000 });
  }
}

module.exports = { Api, ApiError, normalizeBaseUrl };
