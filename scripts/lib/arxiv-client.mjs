const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_HEADERS = Object.freeze({
  Accept: 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
  'User-Agent': 'Study-ML-paper-collector/1.0 (+https://github.com/mincia1110/Study-ML)',
});

function retryAfterMs(response, nowMs) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return 0;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : 0;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function disposeResponse(response) {
  try {
    await response?.body?.cancel?.();
  } catch (_) {
    // The body may already be locked or closed; the response is still disposable.
  }
}

export function createArxivClient(options = {}) {
  const fetcher = options.fetcher || fetch;
  const sleep = options.sleep || wait;
  const now = options.now || Date.now;
  const logger = options.logger || console;
  const headers = { ...DEFAULT_HEADERS, ...options.headers };
  const minIntervalMs = options.minIntervalMs ?? 3000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const maxRetries = options.maxRetries ?? 4;
  const baseRetryMs = options.baseRetryMs ?? 5000;
  const rateLimitRetryMs = options.rateLimitRetryMs ?? 30_000;
  let nextRequestAt = 0;

  async function requestWithRetry(url, context, consumeBody) {
    let lastError;
    let rateLimited = false;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const rateLimitWait = Math.max(0, nextRequestAt - now());
      if (rateLimitWait > 0) await sleep(rateLimitWait);
      nextRequestAt = now() + minIntervalMs;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response;
      let body;
      let attemptError;
      try {
        response = await fetcher(url, { signal: controller.signal, headers });
        if (response?.ok && consumeBody) body = await response.text();
      } catch (error) {
        attemptError = controller.signal.aborted
          ? new Error(`arXiv API timed out after ${requestTimeoutMs}ms for ${context}`, { cause: error })
          : new Error(`arXiv API network failure for ${context}`, { cause: error });
        attemptError.code = controller.signal.aborted ? 'ARXIV_TIMEOUT' : 'ARXIV_NETWORK';
        lastError = attemptError;
      } finally {
        clearTimeout(timeout);
      }

      if (response?.ok && (!consumeBody || body !== undefined)) return consumeBody ? body : response;

      const status = response?.status;
      if (status === 429) rateLimited = true;
      const serverWait = response ? retryAfterMs(response, now()) : 0;
      // Keep the final response's cooldown when the caller tries another feed.
      if (serverWait > 0 || status === 429) {
        nextRequestAt = Math.max(nextRequestAt, now() + Math.max(serverWait, status === 429 ? rateLimitRetryMs : 0));
      }
      const retryable = response ? (attemptError ? true : RETRYABLE_STATUS.has(status)) : true;
      if (!retryable || attempt === maxRetries) {
        if (response && body === undefined) await disposeResponse(response);
        if (response && attemptError) throw attemptError;
        if (response) {
          const error = new Error(`arXiv API error ${status} for ${context}`);
          error.status = status;
          throw error;
        }
        throw lastError;
      }

      if (response && body === undefined) await disposeResponse(response);

      // A 429 on the first request usually means the runner's shared IP is
      // already rate-limited. Give that window substantially longer to clear
      // than a transient network or server failure.
      // A timeout following a 429 does not mean the rate limit has cleared.
      const retryBaseMs = rateLimited ? Math.max(rateLimitRetryMs, baseRetryMs) : baseRetryMs;
      const exponentialWait = retryBaseMs * (2 ** attempt);
      const retryWait = Math.max(minIntervalMs, exponentialWait, serverWait);
      const reason = attemptError?.code === 'ARXIV_TIMEOUT'
        ? ` (timeout after ${requestTimeoutMs}ms)`
        : (status ? ` with HTTP ${status}` : ' (network error)');
      logger.warn(`arXiv request failed${reason}; retrying ${context} in ${Math.ceil(retryWait / 1000)}s (${attempt + 1}/${maxRetries})`);
      nextRequestAt = Math.max(nextRequestAt, now() + retryWait);
    }

    throw lastError;
  }

  return {
    fetch: (url, context = url) => requestWithRetry(url, context, false),
    fetchText: (url, context = url) => requestWithRetry(url, context, true),
  };
}
