import { test, expect } from "bun:test";
import { verify } from "node:crypto";
import { config } from "./config";
import { buildJwt, decodeJwt, generateTestEcKey, hasCredentials } from "./auth";

test("buildJwt signs an ES256 token with kid, iss=cdp, and a 2-minute exp", async () => {
  const { privateKey, publicKey } = generateTestEcKey();
  const prevName = config.apiKeyName;
  const prevKey = config.apiPrivateKey;
  config.apiKeyName = "organizations/test/apiKeys/test";
  config.apiPrivateKey = privateKey;
  try {
    expect(hasCredentials()).toBe(true);
    const uri = "GET api.coinbase.com/api/v3/brokerage/market/products/MON-USD";
    const token = await buildJwt(uri);
    const { header, payload, sig } = decodeJwt(token);
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe(config.apiKeyName);
    expect(header.typ).toBe("JWT");
    expect(payload.iss).toBe("cdp");
    expect(payload.sub).toBe(config.apiKeyName);
    expect(payload.uri).toBe(uri);
    expect((payload.uris as string[])[0]).toBe(uri);
    expect(Number(payload.exp) - Number(payload.nbf)).toBe(120);
    const signingInput = token.split(".").slice(0, 2).join(".");
    const ok = verify("SHA256", Buffer.from(signingInput), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig);
    expect(ok).toBe(true);
  } finally {
    config.apiKeyName = prevName;
    config.apiPrivateKey = prevKey;
  }
});

test("buildJwt without credentials throws", async () => {
  const prevName = config.apiKeyName;
  const prevKey = config.apiPrivateKey;
  config.apiKeyName = undefined;
  config.apiPrivateKey = undefined;
  try {
    expect(hasCredentials()).toBe(false);
    await expect(buildJwt()).rejects.toThrow(/COINBASE_API/);
  } finally {
    config.apiKeyName = prevName;
    config.apiPrivateKey = prevKey;
  }
});
