"""Token pricing for Azure OpenAI deployments, applied to the exact usage Azure returns.

Rates are USD per 1M tokens. gpt-6-luna Standard (Global) rates, from the OpenAI model page, which Azure Global
Standard matches:

* input $0.10 · cached input $0.01 (10% of input) · cache writes $0.125 (1.25x input) · output $0.50
* prompts over 272K input tokens: 2x input / cache rates and 1.5x output for the whole request
* Data Zone / regional deployments: +10%

Users can override the rates per deployment in Settings, under Model > Advanced > Pricing.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.llm.base import Usage


@dataclass(frozen=True)
class Rates:
    input: float
    cached_input: float
    cache_write: float
    output: float
    long_context_threshold: int = 272_000
    long_input_multiplier: float = 2.0
    long_output_multiplier: float = 1.5


DEFAULT_RATES: dict[str, Rates] = {
    "gpt-6-luna": Rates(input=0.10, cached_input=0.01, cache_write=0.125, output=0.50),
}
REGIONAL_PREMIUM = {"global": 1.0, "data_zone": 1.10, "regional": 1.10}


@dataclass
class CostBreakdown:
    input: float = 0.0
    cached_input: float = 0.0
    cache_write: float = 0.0
    output: float = 0.0
    long_context: bool = False
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def total(self) -> float:
        return self.input + self.cached_input + self.cache_write + self.output


def rates_for(model: str, options: dict[str, Any] | None = None) -> Rates | None:
    """Default rates for the deployment, with user overrides (options["pricing"]) and the deployment-type premium."""
    options = options or {}
    base = DEFAULT_RATES.get(model) or DEFAULT_RATES.get(model.lower())
    override = options.get("pricing") or {}
    if base is None and not override:
        return None
    base = base or Rates(0.0, 0.0, 0.0, 0.0)
    vals = {k: float(override[k]) for k in ("input", "cached_input", "cache_write", "output") if override.get(k) not in (None, "")}
    r = Rates(**{**base.__dict__, **vals})
    mult = REGIONAL_PREMIUM.get(str(options.get("deployment_type") or "global"), 1.0)
    if mult != 1.0:
        r = Rates(r.input * mult, r.cached_input * mult, r.cache_write * mult, r.output * mult,
                  r.long_context_threshold, r.long_input_multiplier, r.long_output_multiplier)
    return r


def price(usage: Usage, rates: Rates | None) -> CostBreakdown:
    """Cost of one request. ``prompt_tokens`` counts every input token, including cached and cache-write tokens."""
    if rates is None:
        return CostBreakdown()
    cached = max(0, usage.cached_tokens)
    written = max(0, usage.cache_write_tokens)
    uncached = max(0, usage.prompt_tokens - cached - written)
    long_ctx = usage.prompt_tokens > rates.long_context_threshold
    im = rates.long_input_multiplier if long_ctx else 1.0
    om = rates.long_output_multiplier if long_ctx else 1.0
    m = 1_000_000
    return CostBreakdown(
        input=uncached * rates.input * im / m,
        cached_input=cached * rates.cached_input * im / m,
        cache_write=written * rates.cache_write * im / m,
        output=usage.completion_tokens * rates.output * om / m,  # completion tokens include reasoning tokens
        long_context=long_ctx,
    )


def apply(usage: Usage, model: str, options: dict[str, Any] | None = None) -> Usage:
    b = price(usage, rates_for(model, options))
    usage.cost_usd = b.total
    usage.cost_breakdown = {"input": b.input, "cached_input": b.cached_input, "cache_write": b.cache_write, "output": b.output}
    usage.priced = rates_for(model, options) is not None
    return usage
