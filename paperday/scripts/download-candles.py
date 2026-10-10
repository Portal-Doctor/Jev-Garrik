#!/usr/bin/env python3
"""Download Coinbase Exchange public 1-minute candles. No API key."""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

PAIRS = [
    "UNI-USD",
    "NEAR-USD",
    "BCH-USD",
    "SUI-USD",
    "AVAX-USD",
    "ARB-USD",
    "VVV-USD",
    "ZEC-USD",
]
START = 1774483200  # 2026-03-26T00:00:00Z
END = 1791504000  # 2026-10-09T00:00:00Z
GRANULARITY = 60
OUT = Path(__file__).resolve().parent.parent / "cache" / "candles"
OUT.mkdir(parents=True, exist_ok=True)

_LOCK = threading.Lock()
_NEXT = 0.0


def _pace() -> None:
    global _NEXT
    with _LOCK:
        now = time.monotonic()
        wait = _NEXT - now
        if wait > 0:
            time.sleep(wait)
            now = time.monotonic()
        _NEXT = now + 0.08


def fetch(pair: str, start: int, end: int) -> list:
    url = (
        "https://api.exchange.coinbase.com/products/"
        f"{pair}/candles?granularity={GRANULARITY}&start={start}&end={end}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "paperday-backtest"})
    for attempt in range(8):
        _pace()
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                rows = json.loads(res.read())
            if not isinstance(rows, list):
                raise RuntimeError(f"unexpected payload for {pair}")
            return rows
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 7:
                time.sleep(1.2 * (attempt + 1))
                continue
            raise
        except Exception:
            if attempt < 7:
                time.sleep(1.2 * (attempt + 1))
                continue
            raise
    return []


def download_pair(pair: str) -> int:
    dest = OUT / f"{pair}-1m.csv"
    rows_by_ts: dict[int, tuple[str, str, str, str, str, str]] = {}
    cursor = START
    chunk = 299 * GRANULARITY
    calls = 0
    while cursor < END:
        end = min(END, cursor + chunk)
        batch = fetch(pair, cursor, end)
        calls += 1
        for row in batch:
            if not isinstance(row, list) or len(row) < 6:
                continue
            ts = int(row[0])
            close = float(row[4])
            if ts <= 0 or close <= 0:
                continue
            rows_by_ts[ts] = (str(ts), str(row[3]), str(row[2]), str(row[1]), str(row[4]), str(row[5]))
        cursor = end
        if calls % 100 == 0:
            print(f"{pair} calls={calls} bars={len(rows_by_ts)}", flush=True)
    ordered = [rows_by_ts[k] for k in sorted(rows_by_ts)]
    with dest.open("w") as f:
        for rec in ordered:
            f.write(",".join(rec) + "\n")
    print(f"{pair} DONE bars={len(ordered)} calls={calls}", flush=True)
    return len(ordered)


def main() -> None:
    total = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        futs = {pool.submit(download_pair, pair): pair for pair in PAIRS}
        for fut in as_completed(futs):
            total += fut.result()
    print(f"ALL_DONE bars={total}", flush=True)


if __name__ == "__main__":
    main()
