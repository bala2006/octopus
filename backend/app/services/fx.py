"""USD → display-currency exchange rates for cost display.

Costs are always computed and stored in USD (Azure prices are USD). For display, the UI converts with real rates:

1. Frankfurter (European Central Bank reference rates, ~30 currencies, no key)
2. open.er-api.com (exchangerate-api, ~160 currencies incl. AED, SAR, …, no key)

Rates are cached in memory and in ``~/.octopus/fx.json`` for 6 hours; when offline the last known rate is used.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass

import httpx

from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger("fx")
TTL_S = 6 * 3600
_CODE = re.compile(r"^[A-Z]{3}$")


@dataclass
class Rate:
    currency: str
    rate: float  # 1 USD = rate × currency
    date: str
    source: str
    fetched_at: float
    stale: bool = False


def _cache_file():  # type: ignore[no-untyped-def]
    return get_settings().octopus_home / "fx.json"


def _load() -> dict[str, dict]:
    try:
        return json.loads(_cache_file().read_text())
    except (OSError, ValueError):
        return {}


def _store(cache: dict[str, dict]) -> None:
    try:
        _cache_file().write_text(json.dumps(cache))
    except OSError:
        pass


async def _fetch(code: str) -> Rate:
    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as c:
        try:
            r = await c.get("https://api.frankfurter.dev/v1/latest", params={"base": "USD", "symbols": code})
            if r.status_code == 200 and code in (r.json().get("rates") or {}):
                d = r.json()
                return Rate(code, float(d["rates"][code]), d.get("date", ""), "European Central Bank (via Frankfurter)", time.time())
        except (httpx.HTTPError, ValueError, KeyError):
            pass
        r = await c.get("https://open.er-api.com/v6/latest/USD")
        d = r.json()
        if d.get("result") != "success" or code not in (d.get("rates") or {}):
            raise ValueError(f"No exchange rate for {code}")
        date = (d.get("time_last_update_utc") or "")[5:16].strip()
        return Rate(code, float(d["rates"][code]), date, "ExchangeRate-API (open.er-api.com)", time.time())


async def usd_to(code: str) -> Rate:
    code = code.upper()
    if not _CODE.match(code):
        raise ValueError("Currency must be a 3-letter ISO code, e.g. INR")
    if code == "USD":
        return Rate("USD", 1.0, "", "", time.time())
    cache = _load()
    hit = cache.get(code)
    if hit and time.time() - hit.get("fetched_at", 0) < TTL_S:
        return Rate(**{**hit, "stale": False})
    try:
        rate = await _fetch(code)
    except (httpx.HTTPError, ValueError) as exc:
        if hit:  # offline: keep showing the last known rate, marked stale
            log.warning("fx_stale", currency=code, error=str(exc))
            return Rate(**{**hit, "stale": True})
        raise
    cache[code] = asdict(rate)
    _store(cache)
    return rate
