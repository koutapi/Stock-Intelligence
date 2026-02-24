export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const { symbol, type } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: "symbol is required" });
  }

  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  try {
    let url;
    if (type === "quote") {
      url = `https://query1.finance.yahoo.com/v6/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    } else if (type === "quoteSummary") {
      url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=defaultKeyStatistics,financialData,summaryDetail,assetProfile`;
    } else {
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d&includePrePost=false`;
    }

    let response = await fetch(url, { headers: { "User-Agent": ua } });

    // v6が失敗 → v7にフォールバック
    if (!response.ok && type === "quote") {
      const fb = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
      response = await fetch(fb, { headers: { "User-Agent": ua } });
    }

    // quoteSummaryが失敗 → v6/quoteにフォールバック
    if (!response.ok && type === "quoteSummary") {
      const fb = `https://query1.finance.yahoo.com/v6/finance/quote?symbols=${encodeURIComponent(symbol)}`;
      response = await fetch(fb, { headers: { "User-Agent": ua } });
      if (response.ok) {
        const data = await response.json();
        // quoteレスポンスをquoteSummary風に変換
        const q = data.quoteResponse?.result?.[0] || {};
        return res.status(200).json({
          _source: "quote_fallback",
          quote: q,
        });
      }
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: `Yahoo Finance returned ${response.status}` });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
