import { expect, test } from "bun:test";
import { isPostgresDisconnect, withSqlRetry } from "./reconnect";

const closed = (message = "Connection closed") => {
  const err = new Error(message) as Error & { code: string };
  err.code = "ERR_POSTGRES_CONNECTION_CLOSED";
  return err;
};

test("isPostgresDisconnect matches Bun close/timeout codes and startup fatals", () => {
  expect(isPostgresDisconnect(closed())).toBe(true);
  expect(isPostgresDisconnect(Object.assign(new Error("Idle timeout reached after 2m"), { code: "ERR_POSTGRES_IDLE_TIMEOUT" }))).toBe(true);
  expect(isPostgresDisconnect(new Error("the database system is starting up"))).toBe(true);
  expect(isPostgresDisconnect(new Error("the database system is shutting down"))).toBe(true);
  expect(isPostgresDisconnect(new Error("duplicate key value violates unique constraint"))).toBe(false);
  expect(isPostgresDisconnect(null)).toBe(false);
});

test("withSqlRetry reconnects after a closed connection and then returns", async () => {
  let n = 0;
  const reconnects: number[] = [];
  const result = await withSqlRetry(
    async () => {
      n++;
      if (n < 3) throw closed();
      return "ok";
    },
    async () => {
      reconnects.push(n);
    },
    { delayMs: 0 },
  );
  expect(result).toBe("ok");
  expect(n).toBe(3);
  expect(reconnects).toEqual([1, 2]);
});

test("withSqlRetry does not retry application errors", async () => {
  let reconnects = 0;
  await expect(
    withSqlRetry(
      async () => {
        throw new Error("duplicate key value violates unique constraint");
      },
      async () => {
        reconnects++;
      },
      { delayMs: 0 },
    ),
  ).rejects.toThrow(/duplicate key/);
  expect(reconnects).toBe(0);
});
