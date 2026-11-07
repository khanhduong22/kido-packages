/**
 * @kido/wallet-ledger - Portfolio NAV Valuation, WACB Transaction Engine,
 * Quantitative Risk Metrics (Sharpe, Beta, Max Drawdown, Alpha) & L1 Quote Cache
 *
 * Self-contained slice with zero cross-slice coupling.
 */

export type MarketAssetClass = 'STOCK' | 'CRYPTO' | 'INDEX' | 'FOREX' | 'COMMODITY';

export interface PortfolioHoldingState {
  symbol: string;
  assetType: MarketAssetClass;
  quantity: number;
  avgCostPrice: number;
  name?: string;
  color?: string;
}

export interface PortfolioTransactionInput {
  symbol: string;
  assetType?: MarketAssetClass;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  fee?: number;
}

export interface PortfolioState {
  cashBalance: number;
  holdings: PortfolioHoldingState[];
}

export interface ValuedHoldingItem extends PortfolioHoldingState {
  currentPrice: number;
  marketValue: number;
  totalCost: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
  weightPct: number;
}

export interface PortfolioValuationSummary {
  cashBalance: number;
  marketValue: number;
  totalValue: number;
  totalCost: number;
  totalPnL: number;
  totalPnLPct: number;
  holdings: ValuedHoldingItem[];
}

export interface NavTimeSeriesPoint {
  date: string;
  navValue: number;
  portfolioReturnPct: number;
  benchmarkReturnPct: number;
}

export interface PortfolioRiskMetrics {
  sharpeRatio: number;
  beta: number;
  maxDrawdownPct: number;
  volatilityPct: number;
  totalReturnPct: number;
  benchmarkReturnPct: number;
  alphaPct: number;
}

export interface RiskCalculationOptions {
  tradingDaysPerYear?: number;
  annualRiskFreeRate?: number;
}

/**
 * Normalizes ticker/index symbols by stripping whitespace, hyphens, and underscores.
 * E.g. " vn-index " -> "VNINDEX", "hpg " -> "HPG"
 */
export function normalizeMarketSymbolKey(symbol: string): string {
  return symbol
    .trim()
    .replace(/[\s\-_]/g, '')
    .toUpperCase();
}

/**
 * Executes a BUY or SELL transaction using Weighted Average Cost Basis (WACB)
 * accounting, updating cash balance and holdings state deterministically.
 */
export function executeWacbTransaction(
  state: PortfolioState,
  tx: PortfolioTransactionInput,
): PortfolioState {
  const symbol = tx.symbol.trim().toUpperCase();
  const assetType: MarketAssetClass = tx.assetType ?? 'STOCK';
  const quantity = Number(tx.quantity);
  const price = Number(tx.price);
  const fee = Math.max(0, Number(tx.fee ?? 0));

  if (!symbol) {
    throw new Error('Transaction symbol is required');
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Transaction quantity must be a positive number');
  }
  if (!Number.isFinite(price) || price < 0) {
    throw new Error('Transaction price must be a non-negative number');
  }

  const holdings = state.holdings.map((h) => ({ ...h }));
  const existingIdx = holdings.findIndex(
    (h) => h.symbol.toUpperCase() === symbol && h.assetType === assetType,
  );
  const existing = existingIdx >= 0 ? holdings[existingIdx] : undefined;
  const oldQty = existing ? Number(existing.quantity) : 0;
  const oldAvgCost = existing ? Number(existing.avgCostPrice) : 0;

  if (tx.side === 'BUY') {
    const newQty = oldQty + quantity;
    const newAvgCostPrice =
      (oldQty * oldAvgCost + quantity * price + fee) / newQty;
    const buyTotal = quantity * price + fee;
    const newCashBalance = Math.max(0, Number(state.cashBalance) - buyTotal);

    if (existing && existingIdx >= 0) {
      holdings[existingIdx] = {
        ...existing,
        quantity: newQty,
        avgCostPrice: Number(newAvgCostPrice.toFixed(4)),
      };
    } else {
      holdings.push({
        symbol,
        assetType,
        quantity: newQty,
        avgCostPrice: Number(newAvgCostPrice.toFixed(4)),
      });
    }

    return {
      cashBalance: Number(newCashBalance.toFixed(2)),
      holdings,
    };
  }

  // SELL side
  if (!existing || oldQty < quantity) {
    throw new Error(
      `Insufficient holding quantity for ${symbol}: have ${oldQty}, requested ${quantity}`,
    );
  }

  const newQty = oldQty - quantity;
  const netProceeds = quantity * price - fee;
  const newCashBalance = Number(state.cashBalance) + netProceeds;

  if (newQty === 0) {
    holdings.splice(existingIdx, 1);
  } else {
    holdings[existingIdx] = {
      ...existing,
      quantity: newQty,
      // WACB invariant: selling shares does not change avgCostPrice of remaining shares
      avgCostPrice: oldAvgCost,
    };
  }

  return {
    cashBalance: Number(newCashBalance.toFixed(2)),
    holdings,
  };
}

/**
 * Computes portfolio mark-to-market valuation, unrealized PnL, and holding weights.
 */
export function calculatePortfolioValuation(
  state: PortfolioState,
  liveQuotes: Record<string, number> | Map<string, number>,
  options?: { filterAssetType?: MarketAssetClass },
): PortfolioValuationSummary {
  const quoteLookup = (symbol: string, assetType: MarketAssetClass): number | null => {
    const norm = normalizeMarketSymbolKey(symbol);
    const upper = symbol.trim().toUpperCase();
    const candidates = [`${assetType}:${norm}`, `${assetType}:${upper}`, norm, upper];

    for (const key of candidates) {
      const val =
        liveQuotes instanceof Map ? liveQuotes.get(key) : liveQuotes[key];
      if (val !== undefined && Number.isFinite(val) && val > 0) {
        return val;
      }
    }
    return null;
  };

  const filteredHoldings = options?.filterAssetType
    ? state.holdings.filter((h) => h.assetType === options.filterAssetType)
    : state.holdings;

  const intermediate = filteredHoldings.map((h) => {
    const qty = Math.max(0, Number(h.quantity));
    const avgCost = Math.max(0, Number(h.avgCostPrice));
    const totalCost = qty * avgCost;
    const resolvedPrice = quoteLookup(h.symbol, h.assetType);
    const currentPrice = resolvedPrice !== null ? resolvedPrice : avgCost;
    const marketValue = qty * currentPrice;
    const unrealizedPnL = marketValue - totalCost;
    const unrealizedPnLPct =
      totalCost > 0
        ? Number(((unrealizedPnL / totalCost) * 100).toFixed(2))
        : 0;

    return {
      ...h,
      quantity: qty,
      avgCostPrice: avgCost,
      currentPrice,
      marketValue,
      totalCost,
      unrealizedPnL,
      unrealizedPnLPct,
    };
  });

  const totalMarketValue = intermediate.reduce((sum, h) => sum + h.marketValue, 0);
  const totalCost = intermediate.reduce((sum, h) => sum + h.totalCost, 0);
  const cashBalance = Math.max(0, Number(state.cashBalance));
  const totalValue = totalMarketValue + cashBalance;
  const totalPnL = totalMarketValue - totalCost;
  const totalPnLPct =
    totalCost > 0 ? Number(((totalPnL / totalCost) * 100).toFixed(2)) : 0;

  const denominator = totalMarketValue > 0 ? totalMarketValue : totalValue;
  const holdings: ValuedHoldingItem[] = intermediate.map((item) => ({
    ...item,
    marketValue: Number(item.marketValue.toFixed(2)),
    totalCost: Number(item.totalCost.toFixed(2)),
    unrealizedPnL: Number(item.unrealizedPnL.toFixed(2)),
    weightPct:
      denominator > 0
        ? Number(((item.marketValue / denominator) * 100).toFixed(2))
        : 0,
  }));

  return {
    cashBalance: Number(cashBalance.toFixed(2)),
    marketValue: Number(totalMarketValue.toFixed(2)),
    totalValue: Number(totalValue.toFixed(2)),
    totalCost: Number(totalCost.toFixed(2)),
    totalPnL: Number(totalPnL.toFixed(2)),
    totalPnLPct,
    holdings,
  };
}

/**
 * Computes Peak-to-Trough Maximum Drawdown percentage across a NAV series.
 */
export function calculateMaxDrawdownPct(points: NavTimeSeriesPoint[]): number {
  let peak = -Infinity;
  let maxDrawdown = 0;

  for (const pt of points) {
    if (pt.navValue > peak) {
      peak = pt.navValue;
    }
    if (peak > 0) {
      const dd = ((peak - pt.navValue) / peak) * 100;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
      }
    }
  }
  return Number(maxDrawdown.toFixed(2));
}

/**
 * Computes quantitative portfolio risk & performance metrics:
 * Sharpe Ratio, Beta vs Benchmark, Max Drawdown %, Annualized Volatility %,
 * Total Return %, Benchmark Return %, and Excess Alpha %.
 */
export function calculatePortfolioRiskMetrics(
  points: NavTimeSeriesPoint[],
  options?: RiskCalculationOptions,
): PortfolioRiskMetrics {
  const tradingDays = options?.tradingDaysPerYear ?? 252;
  const annualRiskFree = options?.annualRiskFreeRate ?? 0.045;

  if (!points || points.length === 0) {
    return {
      sharpeRatio: 0,
      beta: 1.0,
      maxDrawdownPct: 0,
      volatilityPct: 0,
      totalReturnPct: 0,
      benchmarkReturnPct: 0,
      alphaPct: 0,
    };
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const totalReturnPct = Number(
    (last.portfolioReturnPct - first.portfolioReturnPct).toFixed(2),
  );
  const benchmarkReturnPct = Number(
    (last.benchmarkReturnPct - first.benchmarkReturnPct).toFixed(2),
  );
  const alphaPct = Number((totalReturnPct - benchmarkReturnPct).toFixed(2));
  const maxDrawdownPct = calculateMaxDrawdownPct(points);

  if (points.length < 2) {
    return {
      sharpeRatio: 0,
      beta: 1.0,
      maxDrawdownPct,
      volatilityPct: 0,
      totalReturnPct,
      benchmarkReturnPct,
      alphaPct,
    };
  }

  const dailyPortReturns: number[] = [];
  const dailyBenchReturns: number[] = [];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;

    const rPort =
      prev.navValue > 0
        ? (cur.navValue - prev.navValue) / prev.navValue
        : (cur.portfolioReturnPct - prev.portfolioReturnPct) / 100;
    dailyPortReturns.push(rPort);

    const prevB = 1 + prev.benchmarkReturnPct / 100;
    const curB = 1 + cur.benchmarkReturnPct / 100;
    const rBench = prevB > 0 ? (curB - prevB) / prevB : 0;
    dailyBenchReturns.push(rBench);
  }

  const k = dailyPortReturns.length;
  const meanPort = dailyPortReturns.reduce((acc, r) => acc + r, 0) / k;
  const meanBench = dailyBenchReturns.reduce((acc, r) => acc + r, 0) / k;

  let portVariance = 0;
  let benchVariance = 0;
  let covariance = 0;

  if (k > 1) {
    let sumPortSq = 0;
    let sumBenchSq = 0;
    let sumCross = 0;

    for (let i = 0; i < k; i++) {
      const diffP = dailyPortReturns[i]! - meanPort;
      const diffB = dailyBenchReturns[i]! - meanBench;
      sumPortSq += diffP * diffP;
      sumBenchSq += diffB * diffB;
      sumCross += diffP * diffB;
    }

    portVariance = sumPortSq / (k - 1);
    benchVariance = sumBenchSq / (k - 1);
    covariance = sumCross / (k - 1);
  }

  const dailyStdDev = Math.sqrt(portVariance);
  const annualizedVol = dailyStdDev * Math.sqrt(tradingDays);
  const volatilityPct = Number((annualizedVol * 100).toFixed(2));

  const rfDaily = annualRiskFree / tradingDays;
  let sharpeRatio = 0;
  if (dailyStdDev > 1e-7) {
    sharpeRatio = ((meanPort - rfDaily) * Math.sqrt(tradingDays)) / dailyStdDev;
  }
  sharpeRatio = Number(sharpeRatio.toFixed(2));

  let beta = 1.0;
  if (benchVariance > 1e-8) {
    beta = covariance / benchVariance;
  }
  beta = Number(beta.toFixed(2));

  return {
    sharpeRatio,
    beta,
    maxDrawdownPct,
    volatilityPct,
    totalReturnPct,
    benchmarkReturnPct,
    alphaPct,
  };
}

/**
 * Downsamples an array of X-axis chart labels to at most `maxTicks` evenly spaced
 * labels (preserving the exact first and last label) to prevent mobile label overlap.
 */
export function downsampleChartLabels(
  rawLabels: string[],
  maxTicks = 6,
): string[] {
  if (maxTicks < 2 || rawLabels.length <= maxTicks) {
    return [...rawLabels];
  }
  const downsampled: string[] = [];
  const step = (rawLabels.length - 1) / (maxTicks - 1);
  for (let i = 0; i < maxTicks; i++) {
    const idx = Math.min(Math.round(i * step), rawLabels.length - 1);
    const label = rawLabels[idx];
    if (label !== undefined) {
      downsampled.push(label);
    }
  }
  return downsampled;
}

export interface QuoteSnapshotEntry {
  symbol: string;
  price: number;
  changePct?: number;
  updatedAt: number;
}

/**
 * Synchronous L1 Live Quote Snapshot Cache with TTL guard.
 * Eliminates Flash of Sample Data (FOUC) and Layout Shift (CLS) on page reload
 * by hydrating the UI with the latest known live quote at 0ms before background SWR.
 */
export class L1QuoteSnapshotCache {
  private readonly memory = new Map<string, QuoteSnapshotEntry>();
  private readonly ttlMs: number;

  constructor(options?: { ttlMs?: number }) {
    this.ttlMs = options?.ttlMs ?? 24 * 60 * 60 * 1000; // Default 24h SWR snapshot TTL
  }

  setQuote(
    symbol: string,
    price: number,
    changePct?: number,
    now = Date.now(),
  ): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const key = normalizeMarketSymbolKey(symbol);
    if (!key) return;
    this.memory.set(key, {
      symbol: key,
      price,
      changePct,
      updatedAt: now,
    });
  }

  getQuote(symbol: string, now = Date.now()): QuoteSnapshotEntry | null {
    const key = normalizeMarketSymbolKey(symbol);
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (now - entry.updatedAt > this.ttlMs) {
      this.memory.delete(key);
      return null;
    }
    return entry;
  }

  hydratePricesMap(now = Date.now()): Map<string, number> {
    const map = new Map<string, number>();
    for (const [key, entry] of this.memory.entries()) {
      if (now - entry.updatedAt <= this.ttlMs) {
        map.set(key, entry.price);
        map.set(`STOCK:${key}`, entry.price);
      }
    }
    return map;
  }
}
