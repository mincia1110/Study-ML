const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

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
  const minIntervalMs = options.minIntervalMs ?? 3000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const maxRetries = options.maxRetries ?? 3;
  const baseRetryMs = options.baseRetryMs ?? 5000;
  let nextRequestAt = 0;

  async function requestWithRetry(url, context, consumeBody) {
    let lastError;

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
        response = await fetcher(url, { signal: controller.signal });
        if (response?.ok && consumeBody) body = await response.text();
      } catch (error) {
        attemptError = controller.signal.aborted
          ? new Error(`arXiv API timed out after ${requestTimeoutMs}ms for ${context}`, { cause: error })
          : error;
        lastError = attemptError;
      } finally {
        clearTimeout(timeout);
      }

      if (response?.ok && (!consumeBody || body !== undefined)) return consumeBody ? body : response;

      const status = response?.status;
      const retryable = response ? (attemptError ? true : RETRYABLE_STATUS.has(status)) : true;
      if (!retryable || attempt === maxRetries) {
        if (response && body === undefined) await disposeResponse(response);
        if (response && attemptError) throw attemptError;
        if (response) throw new Error(`arXiv API error ${status} for ${context}`);
        throw new Error(`arXiv API request failed for ${context}: ${lastError?.message || 'unknown error'}`, { cause: lastError });
      }

      if (response && body === undefined) await disposeResponse(response);

      const exponentialWait = baseRetryMs * (2 ** attempt);
      const serverWait = response ? retryAfterMs(response, now()) : 0;
      const retryWait = Math.max(minIntervalMs, exponentialWait, serverWait);
      logger.warn(`arXiv request failed${status ? ` with HTTP ${status}` : ''}; retrying ${context} in ${Math.ceil(retryWait / 1000)}s (${attempt + 1}/${maxRetries})`);
      nextRequestAt = Math.max(nextRequestAt, now() + retryWait);
    }

    throw lastError;
  }

  return {
    fetch: (url, context = url) => requestWithRetry(url, context, false),
    fetchText: (url, context = url) => requestWithRetry(url, context, true),
  };
}
