/**
 * Portfolio Advisor — Cloudflare Worker
 *
 * Endpoints:
 *   GET  /price/:symbol           OHLCV + current price
 *   GET  /indicators/:symbol      Computed TA indicators
 *   GET  /sentiment/:symbol       Reddit + Google News + GDELT
 *   POST /analyze                 Body: { uid, symbol, holding, idToken }
 *                                 Runs full Claude analysis, writes to Firestore
 *   GET  /search?q=AAPL           Symbol autocomplete (Yahoo + CoinGecko)
 *   POST /cron/run                Internal: refresh all users' holdings
 *
 * Secrets (set in Cloudflare dashboard):
 *   ANTHROPIC_API_KEY
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_API_KEY
 *   ALLOWED_ORIGIN
 */

// ============================================================================
// SYMBOL MAPPING — convert short user symbols to fetchable identifiers
// ============================================================================

const SYMBOL_MAP = {
  // London-listed ETFs (Ahmed's holdings)
  SWRD: { yahoo: "SWRD.L", asset_class: "etf", currency: "GBp", name: "iShares MSCI World Swap UCITS ETF" },
  EIMI: { yahoo: "EIMI.L", asset_class: "etf", currency: "USD", name: "iShares Core MSCI EM IMI UCITS ETF" },
  ISLN: { yahoo: "ISLN.L", asset_class: "etf", currency: "USD", name: "iShares MSCI Israel UCITS ETF" },
  IGLN: { yahoo: "IGLN.L", asset_class: "metal", currency: "USD", name: "iShares Physical Gold ETC" },
  // US stocks
  MSTR: { yahoo: "MSTR", asset_class: "us_stock", currency: "USD", name: "Strategy (MicroStrategy)" },
  // Crypto (handled by CoinGecko)
  BTC:  { coingecko: "bitcoin",  asset_class: "crypto", currency: "USD", name: "Bitcoin" },
  ETH:  { coingecko: "ethereum", asset_class: "crypto", currency: "USD", name: "Ethereum" },
};

function resolveSymbol(userSymbol) {
  const key = userSymbol.toUpperCase();
  if (SYMBOL_MAP[key]) return { ...SYMBOL_MAP[key], display: key };
  // Fallback: assume US stock with same ticker
  return { yahoo: key, asset_class: "us_stock", currency: "USD", name: key, display: key };
}

// ============================================================================
// CORS
// ============================================================================

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// ============================================================================
// PRICE FETCHING
// ============================================================================

async function fetchYahooPrice(yahooSymbol) {
  // Range = 1 year, interval = 1 day
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1y&interval=1d&includePrePost=false`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PortfolioAdvisor/1.0)" }
  });
  if (!r.ok) throw new Error(`Yahoo fetch failed: ${r.status}`);
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo returned no data");

  const meta = result.meta;
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const ohlcv = ts.map((t, i) => ({
    t: t * 1000,
    o: q.open?.[i],
    h: q.high?.[i],
    l: q.low?.[i],
    c: q.close?.[i],
    v: q.volume?.[i],
  })).filter(d => d.c != null);

  return {
    current_price: meta.regularMarketPrice,
    prev_close: meta.chartPreviousClose,
    currency: meta.currency,
    ohlcv,
    fifty_two_week_high: meta.fiftyTwoWeekHigh,
    fifty_two_week_low: meta.fiftyTwoWeekLow,
  };
}

async function fetchCoinGeckoPrice(coinId) {
  // Current price + market data
  const priceUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`;
  // 1Y daily OHLC — CoinGecko free tier returns daily for ranges > 90 days
  const histUrl = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=365&interval=daily`;

  const [priceR, histR] = await Promise.all([fetch(priceUrl), fetch(histUrl)]);
  if (!priceR.ok || !histR.ok) throw new Error("CoinGecko fetch failed");
  const priceJ = await priceR.json();
  const histJ = await histR.json();

  const prices = histJ.prices || [];
  const vols = histJ.total_volumes || [];
  // CoinGecko market_chart gives close-only; we approximate OHLC as close=open=high=low for daily
  const ohlcv = prices.map((p, i) => ({
    t: p[0],
    o: p[1],
    h: p[1],
    l: p[1],
    c: p[1],
    v: vols[i]?.[1] || 0,
  }));

  const closes = ohlcv.map(d => d.c);
  return {
    current_price: priceJ[coinId]?.usd,
    prev_close: closes[closes.length - 2],
    currency: "USD",
    ohlcv,
    fifty_two_week_high: Math.max(...closes),
    fifty_two_week_low: Math.min(...closes),
  };
}

async function fetchPrice(userSymbol) {
  const sym = resolveSymbol(userSymbol);
  let data;
  if (sym.coingecko) {
    data = await fetchCoinGeckoPrice(sym.coingecko);
  } else {
    data = await fetchYahooPrice(sym.yahoo);
    // London ETFs return GBp (pence). Convert to USD using current GBPUSD.
    // For simplicity in v1, we use a Yahoo-fetched GBPUSD rate.
    // EIMI/ISLN/IGLN are USD-denominated even on .L? Actually they price in USD on LSE.
    // Yahoo reports the listed currency. We trust meta.currency.
    if (data.currency === "GBp") {
      // pence → pounds, then pounds → USD
      const gbpusd = await fetchGbpUsd();
      const factor = gbpusd / 100; // 1 GBp = 0.01 GBP, then × GBPUSD
      data.ohlcv = data.ohlcv.map(d => ({
        ...d,
        o: d.o * factor, h: d.h * factor, l: d.l * factor, c: d.c * factor,
      }));
      data.current_price *= factor;
      data.prev_close *= factor;
      data.fifty_two_week_high *= factor;
      data.fifty_two_week_low *= factor;
      data.currency = "USD";
    }
  }
  return { ...data, symbol_info: sym };
}

let _gbpUsdCache = { value: null, ts: 0 };
async function fetchGbpUsd() {
  const now = Date.now();
  if (_gbpUsdCache.value && now - _gbpUsdCache.ts < 3600000) return _gbpUsdCache.value;
  const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/GBPUSD=X?range=5d&interval=1d", {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  const j = await r.json();
  const v = j?.chart?.result?.[0]?.meta?.regularMarketPrice || 1.27;
  _gbpUsdCache = { value: v, ts: now };
  return v;
}

// ============================================================================
// TECHNICAL INDICATORS
// ============================================================================

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) gains += ch; else losses -= ch;
  }
  const avgG = gains / period;
  const avgL = losses / period;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

function macd(values) {
  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);
  if (ema12 == null || ema26 == null) return null;
  const macdLine = ema12 - ema26;

  // Build MACD series for signal line
  const macdSeries = [];
  for (let i = 26; i <= values.length; i++) {
    const slice = values.slice(0, i);
    const e12 = ema(slice, 12);
    const e26 = ema(slice, 26);
    if (e12 != null && e26 != null) macdSeries.push(e12 - e26);
  }
  const signalLine = ema(macdSeries, 9);
  const histogram = signalLine != null ? macdLine - signalLine : null;

  // Detect recent crossover (last 3 days)
  let crossover = "none";
  if (macdSeries.length >= 5) {
    const recent = macdSeries.slice(-5);
    const sigSeries = [];
    for (let i = 9; i <= macdSeries.length; i++) {
      const e = ema(macdSeries.slice(0, i), 9);
      if (e != null) sigSeries.push(e);
    }
    const recSig = sigSeries.slice(-5);
    if (recent.length === recSig.length && recent.length >= 2) {
      for (let i = 1; i < recent.length; i++) {
        const prevDiff = recent[i - 1] - recSig[i - 1];
        const curDiff = recent[i] - recSig[i];
        if (prevDiff <= 0 && curDiff > 0) crossover = `bullish_${recent.length - 1 - i}d_ago`;
        if (prevDiff >= 0 && curDiff < 0) crossover = `bearish_${recent.length - 1 - i}d_ago`;
      }
    }
  }

  return { macd: macdLine, signal: signalLine, histogram, crossover };
}

function bollinger(values, period = 20, mult = 2) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd };
}

function atr(ohlcv, period = 14) {
  if (ohlcv.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const h = ohlcv[i].h, l = ohlcv[i].l, pc = ohlcv[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return sma(trs, period);
}

function findSupportResistance(ohlcv, currentPrice) {
  // Simple swing-pivot detection over last 6 months
  const recent = ohlcv.slice(-126);
  const pivots = [];
  for (let i = 5; i < recent.length - 5; i++) {
    const win = recent.slice(i - 5, i + 6);
    const high = recent[i].h, low = recent[i].l;
    if (high === Math.max(...win.map(d => d.h))) pivots.push({ price: high, type: "resistance" });
    if (low === Math.min(...win.map(d => d.l)))  pivots.push({ price: low, type: "support" });
  }
  // Cluster nearby pivots (within 1%)
  const clustered = [];
  pivots.sort((a, b) => a.price - b.price);
  for (const p of pivots) {
    const last = clustered[clustered.length - 1];
    if (last && Math.abs(p.price - last.price) / last.price < 0.01) {
      last.weight += 1;
    } else {
      clustered.push({ ...p, weight: 1 });
    }
  }
  const supports = clustered.filter(p => p.price < currentPrice).sort((a, b) => b.price - a.price);
  const resistances = clustered.filter(p => p.price > currentPrice).sort((a, b) => a.price - b.price);
  return {
    nearest_support: supports[0]?.price || null,
    nearest_resistance: resistances[0]?.price || null,
    all_supports: supports.slice(0, 3).map(s => s.price),
    all_resistances: resistances.slice(0, 3).map(r => r.price),
  };
}

function computeIndicators(priceData) {
  const closes = priceData.ohlcv.map(d => d.c);
  const cur = priceData.current_price;
  const ind = {
    rsi14: rsi(closes, 14),
    macd: macd(closes),
    ma20: sma(closes, 20),
    ma50: sma(closes, 50),
    ma200: sma(closes, 200),
    bollinger: bollinger(closes, 20, 2),
    atr14: atr(priceData.ohlcv, 14),
    fifty_two_week_high: priceData.fifty_two_week_high,
    fifty_two_week_low: priceData.fifty_two_week_low,
    pct_from_52w_high: priceData.fifty_two_week_high ? (cur - priceData.fifty_two_week_high) / priceData.fifty_two_week_high * 100 : null,
    pct_from_52w_low:  priceData.fifty_two_week_low  ? (cur - priceData.fifty_two_week_low)  / priceData.fifty_two_week_low  * 100 : null,
    volume_avg_20: sma(priceData.ohlcv.slice(-20).map(d => d.v), 20),
    volume_current: priceData.ohlcv[priceData.ohlcv.length - 1]?.v,
    support_resistance: findSupportResistance(priceData.ohlcv, cur),
    trend: cur > sma(closes, 200) ? "above_200ma" : "below_200ma",
  };
  // Golden/death cross
  const ma50 = ind.ma50, ma200 = ind.ma200;
  if (ma50 && ma200) {
    ind.cross_status = ma50 > ma200 ? "golden_cross_active" : "death_cross_active";
  }
  return ind;
}

// ============================================================================
// SENTIMENT — Reddit + Google News + GDELT
// ============================================================================

async function fetchRedditSentiment(symbol, name) {
  const subs = ["stocks", "investing", "wallstreetbets", "ETFs", "CryptoCurrency"];
  const query = encodeURIComponent(symbol);
  const results = [];
  for (const sub of subs) {
    try {
      const url = `https://www.reddit.com/r/${sub}/search.json?q=${query}&restrict_sr=1&sort=new&t=day&limit=10`;
      const r = await fetch(url, { headers: { "User-Agent": "PortfolioAdvisor/1.0" } });
      if (!r.ok) continue;
      const j = await r.json();
      const posts = j?.data?.children || [];
      for (const p of posts) {
        results.push({
          title: p.data.title,
          score: p.data.score,
          num_comments: p.data.num_comments,
          subreddit: sub,
          created: p.data.created_utc,
        });
      }
    } catch (e) { /* skip sub on error */ }
  }
  // Naive sentiment: count bullish/bearish keywords in titles
  const bullishKw = /\b(buy|moon|rally|bull|long|breakout|pump|surge|rip|squeeze)\b/i;
  const bearishKw = /\b(sell|dump|crash|bear|short|puts|tank|collapse|rug|dead)\b/i;
  let bull = 0, bear = 0, totalScore = 0;
  for (const r of results) {
    if (bullishKw.test(r.title)) bull++;
    if (bearishKw.test(r.title)) bear++;
    totalScore += r.score || 0;
  }
  const sentiment = results.length === 0 ? 0
    : (bull - bear) / Math.max(results.length, 1);
  return {
    mention_count_24h: results.length,
    sentiment_score: sentiment,
    bullish_count: bull,
    bearish_count: bear,
    avg_post_score: results.length ? totalScore / results.length : 0,
    top_posts: results.sort((a, b) => b.score - a.score).slice(0, 5).map(p => ({
      title: p.title,
      score: p.score,
      sub: p.subreddit,
    })),
  };
}

async function fetchGoogleNews(symbol, name) {
  // Google News RSS
  const query = encodeURIComponent(`${symbol} ${name || ""}`.trim());
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { headlines: [] };
    const xml = await r.text();
    // Parse RSS without DOMParser (Workers don't have it)
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 8) {
      const block = match[1];
      const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || "";
      const link  = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
      const pub   = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
      const src   = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || "";
      items.push({
        title: title.replace(/<[^>]+>/g, "").trim(),
        link: link.trim(),
        published: pub,
        source: src.trim(),
      });
    }
    return { headlines: items };
  } catch (e) {
    return { headlines: [] };
  }
}

async function fetchGdeltFlags(symbol, name) {
  // GDELT free API — broad geopolitical context, last 24h
  const q = encodeURIComponent(`"${name || symbol}"`);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=ArtList&format=json&maxrecords=10&timespan=24h`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { flags: [] };
    const j = await r.json();
    const articles = j.articles || [];
    return {
      flags: articles.slice(0, 5).map(a => ({
        title: a.title,
        source: a.domain,
        url: a.url,
        date: a.seendate,
      })),
    };
  } catch (e) {
    return { flags: [] };
  }
}

async function fetchSentiment(userSymbol) {
  const sym = resolveSymbol(userSymbol);
  const [reddit, news, gdelt] = await Promise.all([
    fetchRedditSentiment(userSymbol, sym.name),
    fetchGoogleNews(userSymbol, sym.name),
    fetchGdeltFlags(userSymbol, sym.name),
  ]);
  return { reddit, news, geopolitical: gdelt };
}

// ============================================================================
// CLAUDE ANALYSIS
// ============================================================================

const SYSTEM_PROMPT = `You are a market analysis assistant. You receive technical indicators, sentiment data, and news for a single asset, and produce a structured JSON analysis.

Hard rules:
- You NEVER recommend "buy now" or "sell now."
- You provide directional bias, key levels to watch, risks, and confidence.
- You acknowledge uncertainty. If indicators conflict or data is thin, say so and lower confidence.
- You are not a financial advisor. The user makes their own decisions.
- Treat Reddit sentiment cautiously: high bullish chatter is often a CONTRARIAN signal, especially from r/wallstreetbets. Flag pump-style language as a risk, not as bullish confirmation.
- Geopolitical headlines should inform broad risk, not specific buy/sell calls on individual assets.

Output ONLY valid JSON matching this schema. No markdown, no preamble, no code fences:

{
  "signal": "bearish" | "neutral-bearish" | "neutral" | "neutral-bullish" | "bullish",
  "confidence": "low" | "medium" | "high",
  "ta_summary": "string, max 280 chars, plain English summary of technicals",
  "sentiment_summary": "string, max 200 chars, summary of news/Reddit",
  "watch_levels": {
    "support": <number or null>,
    "resistance": <number or null>,
    "stop_loss_idea": <number or null>,
    "rationale": "string explaining why these levels"
  },
  "key_risks": ["risk1", "risk2", "risk3"],
  "position_context": "string referencing user's specific P&L situation",
  "data_quality_notes": "string flagging any thin or missing inputs"
}`;

async function callClaude(env, payload) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(payload, null, 2) }],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude API error ${resp.status}: ${errText}`);
  }
  const j = await resp.json();
  const text = j.content?.[0]?.text || "{}";
  // Strip code fences if model added them despite instructions
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    return { error: "parse_failed", raw: text };
  }
}

// ============================================================================
// FIRESTORE REST API
// ============================================================================

function fsBaseUrl(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

// Convert plain JS to Firestore typed value format
function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === "object") {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = toFsValue(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function toFsDoc(obj) {
  const fields = {};
  for (const k of Object.keys(obj)) fields[k] = toFsValue(obj[k]);
  return { fields };
}

async function fsWrite(env, path, idToken, doc) {
  const url = `${fsBaseUrl(env)}/${path}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${idToken}`,
    },
    body: JSON.stringify(toFsDoc(doc)),
  });
  if (!r.ok) {
    const e = await r.text();
    throw new Error(`Firestore write failed: ${r.status} ${e}`);
  }
  return r.json();
}

// ============================================================================
// REQUEST HANDLERS
// ============================================================================

async function handlePrice(symbol, origin) {
  const data = await fetchPrice(symbol);
  return jsonResponse(data, 200, origin);
}

async function handleIndicators(symbol, origin) {
  const price = await fetchPrice(symbol);
  const ind = computeIndicators(price);
  return jsonResponse({ symbol, current_price: price.current_price, indicators: ind }, 200, origin);
}

async function handleSentiment(symbol, origin) {
  const sent = await fetchSentiment(symbol);
  return jsonResponse({ symbol, ...sent }, 200, origin);
}

async function handleAnalyze(req, env, origin) {
  const body = await req.json();
  const { uid, symbol, holding, idToken } = body;
  if (!uid || !symbol || !idToken) {
    return jsonResponse({ error: "missing_params" }, 400, origin);
  }

  const sym = resolveSymbol(symbol);

  // Gather all inputs in parallel
  const [price, sent] = await Promise.all([
    fetchPrice(symbol),
    fetchSentiment(symbol),
  ]);
  const ind = computeIndicators(price);

  // Build Claude payload
  const unrealizedPnL = holding && holding.avg_cost
    ? ((price.current_price - holding.avg_cost) / holding.avg_cost) * 100
    : null;

  const payload = {
    asset: { symbol, name: sym.name, asset_class: sym.asset_class },
    user_position: holding ? {
      quantity: holding.quantity,
      avg_cost: holding.avg_cost,
      unrealized_pnl_pct: unrealizedPnL?.toFixed(2),
    } : null,
    current_price: price.current_price,
    prev_close: price.prev_close,
    indicators: {
      rsi14: ind.rsi14?.toFixed(2),
      macd: {
        line: ind.macd?.macd?.toFixed(4),
        signal: ind.macd?.signal?.toFixed(4),
        histogram: ind.macd?.histogram?.toFixed(4),
        recent_crossover: ind.macd?.crossover,
      },
      moving_averages: {
        ma20: ind.ma20?.toFixed(2),
        ma50: ind.ma50?.toFixed(2),
        ma200: ind.ma200?.toFixed(2),
        cross_status: ind.cross_status,
      },
      bollinger: ind.bollinger,
      atr14: ind.atr14?.toFixed(2),
      pct_from_52w_high: ind.pct_from_52w_high?.toFixed(2),
      pct_from_52w_low: ind.pct_from_52w_low?.toFixed(2),
      volume_vs_avg: ind.volume_avg_20 ? (ind.volume_current / ind.volume_avg_20).toFixed(2) : null,
      trend: ind.trend,
    },
    support_resistance: ind.support_resistance,
    sentiment: {
      reddit: {
        mention_count_24h: sent.reddit.mention_count_24h,
        sentiment_score: sent.reddit.sentiment_score?.toFixed(2),
        bullish_count: sent.reddit.bullish_count,
        bearish_count: sent.reddit.bearish_count,
        top_posts: sent.reddit.top_posts.slice(0, 3),
      },
      news: sent.news.headlines.slice(0, 5),
      geopolitical: sent.geopolitical.flags.slice(0, 3),
    },
  };

  const analysis = await callClaude(env, payload);

  // Write to Firestore: /users/{uid}/analyses/{symbol}_{date}
  const today = new Date().toISOString().slice(0, 10);
  const docId = `${symbol}_${today}`;
  const doc = {
    symbol,
    date: today,
    generated_at: new Date().toISOString(),
    current_price: price.current_price,
    ...analysis,
    raw_inputs_summary: {
      rsi: ind.rsi14,
      macd_crossover: ind.macd?.crossover,
      reddit_mentions: sent.reddit.mention_count_24h,
      news_count: sent.news.headlines.length,
    },
  };
  try {
    await fsWrite(env, `users/${uid}/analyses/${docId}`, idToken, doc);
  } catch (e) {
    return jsonResponse({ analysis, write_error: e.message, payload_preview: payload }, 200, origin);
  }

  return jsonResponse({ analysis, current_price: price.current_price, indicators: ind, sentiment: sent, doc_id: docId }, 200, origin);
}

async function handleSearch(query, origin) {
  // Quick autocomplete via Yahoo Finance
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const j = await r.json();
    const quotes = (j.quotes || []).map(q => ({
      symbol: q.symbol,
      name: q.shortname || q.longname || q.symbol,
      type: q.quoteType,
      exchange: q.exchange,
    }));
    return jsonResponse({ results: quotes }, 200, origin);
  } catch (e) {
    return jsonResponse({ results: [] }, 200, origin);
  }
}

// ============================================================================
// ROUTER
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      const path = url.pathname;

      if (path === "/") {
        return jsonResponse({ ok: true, name: "portfolio-advisor", version: env.APP_VERSION }, 200, origin);
      }

      if (path.startsWith("/price/")) {
        return await handlePrice(decodeURIComponent(path.slice(7)), origin);
      }
      if (path.startsWith("/indicators/")) {
        return await handleIndicators(decodeURIComponent(path.slice(12)), origin);
      }
      if (path.startsWith("/sentiment/")) {
        return await handleSentiment(decodeURIComponent(path.slice(11)), origin);
      }
      if (path === "/search") {
        const q = url.searchParams.get("q") || "";
        if (!q) return jsonResponse({ results: [] }, 200, origin);
        return await handleSearch(q, origin);
      }
      if (path === "/analyze" && request.method === "POST") {
        return await handleAnalyze(request, env, origin);
      }

      return jsonResponse({ error: "not_found", path }, 404, origin);
    } catch (e) {
      return jsonResponse({ error: e.message, stack: e.stack }, 500, origin);
    }
  },

  // Daily cron — wakes once a day, currently a no-op stub.
  // Phase 2: iterate users, refresh analyses. For now, just log.
  async scheduled(event, env, ctx) {
    console.log("Daily cron triggered:", new Date().toISOString());
    // Future: pull list of active users, iterate holdings, call handleAnalyze
    // We leave this as a stub for v1 — user runs analyses on-demand from the app.
  },
};
