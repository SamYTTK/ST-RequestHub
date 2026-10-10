function hubLog(...args) {
    console.log('[ST-RequestHub]', ...args);
}

function hubWarn(...args) {
    console.warn('[ST-RequestHub]', ...args);
}

export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run an async task with a timeout that actually aborts the underlying work.
 * taskFn receives a combined AbortSignal (caller signal + timeout) and must
 * pass it to fetch / Service calls. Rejects with Hub-style timeout error.
 */
export async function withAbortableTimeout(taskFn, ms, label = 'request', callerSignal = null) {
    if (!ms || ms <= 0) return await taskFn(callerSignal);
    const ctrl = new AbortController();
    const onCallerAbort = () => ctrl.abort(callerSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
    if (callerSignal) {
        if (callerSignal.aborted) ctrl.abort(callerSignal.reason);
        else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const t = setTimeout(() => {
        ctrl.abort(new DOMException(`${label} timed out after ${ms}ms`, 'TimeoutError'));
    }, ms);
    try {
        return await taskFn(ctrl.signal);
    } catch (e) {
        if (ctrl.signal.aborted && !callerSignal?.aborted) {
            const err = new Error(`${label} timed out after ${ms}ms`);
            err.code = 'TIMEOUT';
            err.retryable = true;
            throw err;
        }
        throw e;
    } finally {
        clearTimeout(t);
        callerSignal?.removeEventListener?.('abort', onCallerAbort);
    }
}

/** Retry only retryable errors (network / 429 / 5xx / timeout). */
export function isRetryable(e) {
    if (e?.retryable === true) return true;
    if (e?.retryable === false) return false;
    if (e?.code === 'TIMEOUT' || e?.name === 'TimeoutError') return true;
    if (e?.name === 'AbortError') return false;
    const msg = String(e?.message ?? e ?? '').toLowerCase();
    const cause = String(e?.cause?.message ?? '').toLowerCase();
    const all = `${msg} ${cause}`;
    if (/(timeout|network|econn|fetch failed|load failed)/.test(all)) return true;
    if (/\b429\b|\b5\d\d\b/.test(all)) return true;
    return false;
}

export async function retry(fn, { retries = 1, delayMs = 1000, label = 'request' } = {}) {
    let last;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (e) {
            last = e;
            if (e?.name === 'AbortError' || e?.code === 'ABORTED') throw e;
            if (i >= retries || !isRetryable(e)) throw e;
            hubWarn(`${label} retry ${i + 1}/${retries} after error:`, e?.message ?? e);
            await sleep(delayMs * (i + 1));
        }
    }
    throw last;
}

export { hubLog, hubWarn };
