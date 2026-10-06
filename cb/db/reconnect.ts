import { SQL } from "bun";

/** Codes Bun.SQL reports when the socket or pool slot is dead and a new client is required. */
const DISCONNECT_CODES = new Set([
  "ERR_POSTGRES_CONNECTION_CLOSED",
  "ERR_POSTGRES_CONNECTION_TIMEOUT",
  "ERR_POSTGRES_CONNECTION_FAILED",
  "ERR_POSTGRES_CONNECTION_REFUSED",
  "ERR_POSTGRES_IDLE_TIMEOUT",
  "ERR_POSTGRES_LIFETIME_TIMEOUT",
]);

const DISCONNECT_MESSAGE =
  /connection closed|connection terminated|connection reset|server closed the connection|the database system is starting up|the database system is shutting down|the database system is not yet accepting connections|too many clients|econnreset|econnrefused|57P03|57P01/i;

export function isPostgresDisconnect(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  if (DISCONNECT_CODES.has(code)) return true;
  const message = typeof e.message === "string" ? e.message : "";
  return DISCONNECT_MESSAGE.test(message);
}

export async function withSqlRetry<T>(
  op: () => T | Promise<T>,
  reconnect: () => Promise<void>,
  opts?: { attempts?: number; delayMs?: number },
): Promise<T> {
  const attempts = opts?.attempts ?? 4;
  const delayMs = opts?.delayMs ?? 200;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      if (i > 0) {
        if (delayMs > 0) await Bun.sleep(delayMs * 2 ** (i - 1));
        await reconnect();
      }
      return await op();
    } catch (err) {
      last = err;
      if (!isPostgresDisconnect(err) || i === attempts - 1) throw err;
    }
  }
  throw last;
}

/**
 * Bun.SQL client for the paper store. `onclose` swallows the uncaught
 * `ERR_POSTGRES_CONNECTION_CLOSED` Bun otherwise throws from `#onClose` when
 * Postgres restarts or the container network drops. `idleTimeout: 0` keeps
 * Bun from idle-killing in-flight queries (Bun 1.3.14).
 */
export function createPaperSql(url: string, onClose?: (err: Error | null) => void): SQL {
  return new SQL({
    url,
    max: 4,
    idleTimeout: 0,
    maxLifetime: 0,
    connectionTimeout: 15,
    onclose: (...args: unknown[]) => {
      const err = args.find((a): a is Error => a instanceof Error) ?? null;
      onClose?.(err);
    },
  });
}

function isThenable(v: unknown): v is Promise<unknown> {
  return v != null && typeof v === "object" && typeof (v as Promise<unknown>).then === "function";
}

/**
 * Tagged-template / method proxy that retries on a dead connection and always
 * talks to the current client (after `reconnect` replaces it).
 *
 * Sync helpers (`sql(ids)`, `sql.array`) pass through. Queries are awaited and
 * remade on a new client after a disconnect.
 */
export function resilientSql(getClient: () => SQL, reconnect: () => Promise<void>): SQL {
  const retryQuery = (failed: unknown, make: () => unknown): Promise<unknown> => {
    if (!isPostgresDisconnect(failed)) return Promise.reject(failed);
    return (async () => {
      await reconnect();
      return await withSqlRetry(async () => {
        const next = make();
        return isThenable(next) ? await next : next;
      }, reconnect);
    })();
  };

  const invoke = (make: () => unknown): unknown => {
    let first: unknown;
    try {
      first = make();
    } catch (err) {
      return retryQuery(err, make);
    }
    if (!isThenable(first)) return first;
    return Promise.resolve(first).catch((err) => retryQuery(err, make));
  };

  return new Proxy(function sqlProxy() {} as unknown as SQL, {
    apply(_target, _thisArg, args) {
      return invoke(() => (getClient() as unknown as (...a: unknown[]) => unknown)(...args));
    },
    get(_target, prop) {
      if (prop === "then") return undefined;
      const value = Reflect.get(getClient(), prop) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        invoke(() => (Reflect.get(getClient(), prop) as (...a: unknown[]) => unknown)(...args));
    },
  });
}
