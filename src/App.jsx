import { useState, useMemo, useCallback } from "react";

// ============================================
// Yahoo Finance API（Vercel経由）
// ============================================
function toYahooSymbol(code) {
  if (/^\d{4}$/.test(code)) return `${code}.T`;
  return code.toUpperCase();
}

async function fetchYahooStock(code) {
  const symbol = toYahooSymbol(code);
  try {
    // チャートデータ取得（6ヶ月分）
    const chartRes = await fetch(`/api/yahoo?symbol=${encodeURIComponent(symbol)}`);
    if (!chartRes.ok) return null;
    const chartData = await chartRes.json();
    if (!chartData.chart?.result?.[0]) return null;

    const result = chartData.chart.result[0];
    const meta = result.meta;
    const quotes = result.indicators.quote[0];
    const closes = quotes.close.filter(c => c != null);
    const volumes = quotes.volume.filter(v => v != null);
    if (closes.length < 2) return null;

    const price = meta.regularMarketPrice || closes[closes.length - 1];
    const prevClose = meta.previousClose || meta.chartPreviousClose || closes[closes.length - 2];
    const change = prevClose ? ((price - prevClose) / prevClose * 100) : 0;

    // 移動平均計算
    const calcMA = (arr, period) => {
      if (arr.length < period) return price;
      return arr.slice(-period).reduce((a, b) => a + b, 0) / period;
    };
    const ma5 = calcMA(closes, 5);
    const ma25 = calcMA(closes, 25);
    const ma50 = calcMA(closes, 50);
    const ma75 = calcMA(closes, 75);
    const ma200 = closes.length >= 200 ? calcMA(closes, 200) : calcMA(closes, closes.length);

    // RSI計算（14日）
    const calcRSI = (arr, period = 14) => {
      if (arr.length < period + 1) return 50;
      const changes = [];
      for (let i = arr.length - period - 1; i < arr.length - 1; i++) {
        changes.push(arr[i + 1] - arr[i]);
      }
      const gains = changes.filter(c => c > 0);
      const losses = changes.filter(c => c < 0).map(c => Math.abs(c));
      const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
      const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
      if (avgLoss === 0) return 100;
      return Math.round(100 - (100 / (1 + avgGain / avgLoss)));
    };

    // MACD計算
    const calcEMA = (arr, period) => {
      const k = 2 / (period + 1);
      let ema = arr[0];
      for (let i = 1; i < arr.length; i++) ema = arr[i] * k + ema * (1 - k);
      return ema;
    };
    const ema12 = calcEMA(closes.slice(-30), 12);
    const ema26 = calcEMA(closes.slice(-30), 26);
    const macdVal = ema12 - ema26;

    // Stochastic
    const last14 = closes.slice(-14);
    const high14 = Math.max(...last14);
    const low14 = Math.min(...last14);
    const stochK = high14 !== low14 ? Math.round((price - low14) / (high14 - low14) * 100) : 50;

    const volume = volumes[volumes.length - 1] || 0;
    const avgVolume = volumes.length >= 20
      ? Math.round(volumes.slice(-20).reduce((a, b) => a + b, 0) / 20) : volume;

    const name = meta.shortName || meta.longName || meta.symbol || code;
    const market = /^\d{4}$/.test(code) ? "JP" : "US";
    const currency = market === "JP" ? "¥" : "$";

    const stockData = {
      code: code.toUpperCase(),
      name,
      market,
      sector: "",
      price: Math.round(price * 100) / 100,
      change: Math.round(change * 100) / 100,
      currency,
      technical: {
        rsi: calcRSI(closes), macd: Math.round(macdVal * 100) / 100,
        macdSignal: macdVal > 0.5 ? "bullish" : macdVal < -0.5 ? "bearish" : "neutral",
        ma5: Math.round(ma5 * 100) / 100, ma25: Math.round(ma25 * 100) / 100,
        ma50: Math.round(ma50 * 100) / 100, ma75: Math.round(ma75 * 100) / 100,
        ma200: Math.round(ma200 * 100) / 100,
        volume, avgVolume, stochK, stochD: Math.max(stochK - 5, 10),
      },
      fundamental: { per: 0, pbr: 0, roe: 0, divYield: 0, epsGrowth: 0, revenueGrowth: 0, marketCap: "" },
      earnings: null,
      news: [],
    };

    // ファンダメンタルデータも取得
    try {
      const fundRes = await fetch(`/api/yahoo?symbol=${encodeURIComponent(symbol)}&modules=defaultKeyStatistics,financialData,summaryDetail,assetProfile`);
      if (fundRes.ok) {
        const fundData = await fundRes.json();
        const r = fundData.quoteSummary?.result?.[0];
        if (r) {
          const ks = r.defaultKeyStatistics || {};
          const fd = r.financialData || {};
          const sd = r.summaryDetail || {};
          const ap = r.assetProfile || {};
          stockData.sector = ap.sector || ap.industry || "";
          stockData.fundamental = {
            per: sd.trailingPE?.raw || sd.forwardPE?.raw || 0,
            pbr: ks.priceToBook?.raw || 0,
            roe: fd.returnOnEquity?.raw ? Math.round(fd.returnOnEquity.raw * 10000) / 100 : 0,
            divYield: sd.dividendYield?.raw ? Math.round(sd.dividendYield.raw * 10000) / 100 : 0,
            epsGrowth: ks.earningsQuarterlyGrowth?.raw ? Math.round(ks.earningsQuarterlyGrowth.raw * 10000) / 100 : 0,
            revenueGrowth: fd.revenueGrowth?.raw ? Math.round(fd.revenueGrowth.raw * 10000) / 100 : 0,
            marketCap: fd.marketCap?.fmt || sd.marketCap?.fmt || "",
          };
        }
      }
    } catch (e) { /* ファンダメンタルは取れなくてもOK */ }

    return stockData;
  } catch (err) {
    console.error("Yahoo Finance error:", err);
    return null;
  }
}

// ============================================
// 登録済みサンプル銘柄データ（フォールバック用）
// ============================================
const BUILTIN_STOCKS = [
  { code: "7203", name: "トヨタ自動車", market: "JP", sector: "輸送用機器", price: 2847, change: +1.2, currency: "¥",
    technical: { rsi: 58, macd: 12.5, macdSignal: "bullish", ma5: 2810, ma25: 2780, ma50: 2720, ma75: 2650, ma200: 2480, volume: 15200000, avgVolume: 12000000, stochK: 65, stochD: 58 },
    fundamental: { per: 10.5, pbr: 1.1, roe: 10.8, divYield: 2.8, epsGrowth: 8.2, revenueGrowth: 8.2, marketCap: "46.5兆円" },
    earnings: { quarter: "Q3 FY2025", result: "上方修正", surprise: "+5.2%", nextDate: "5/8", guidance: "通期営業利益5.8兆円に上方修正" },
    news: [
      { title: "全固体電池搭載EVを2027年発売へ", impact: "positive", type: "事業" },
      { title: "北米販売台数が前年比12%増", impact: "positive", type: "業績" },
      { title: "円安進行で輸出採算改善の見通し", impact: "positive", type: "為替" },
    ]
  },
  { code: "6758", name: "ソニーグループ", market: "JP", sector: "電気機器", price: 3215, change: +2.8, currency: "¥",
    technical: { rsi: 65, macd: 18.3, macdSignal: "bullish", ma5: 3180, ma25: 3100, ma50: 3020, ma75: 2900, ma200: 2700, volume: 8900000, avgVolume: 7500000, stochK: 72, stochD: 68 },
    fundamental: { per: 17.2, pbr: 2.3, roe: 13.5, divYield: 0.6, epsGrowth: 12.5, revenueGrowth: 12.5, marketCap: "19.8兆円" },
    earnings: { quarter: "Q3 FY2025", result: "コンセンサス上回る", surprise: "+3.8%", nextDate: "4/28", guidance: "ゲーム・音楽が牽引し堅調" },
    news: [
      { title: "PS5累計販売7000万台突破", impact: "positive", type: "事業" },
      { title: "CMOSセンサー需要回復", impact: "positive", type: "事業" },
      { title: "映画部門の大型タイトルが興行収入トップ", impact: "positive", type: "事業" },
    ]
  },
  { code: "6920", name: "レーザーテック", market: "JP", sector: "電気機器", price: 18200, change: +4.2, currency: "¥",
    technical: { rsi: 78, macd: 450, macdSignal: "bullish", ma5: 17500, ma25: 16800, ma50: 16200, ma75: 15500, ma200: 14000, volume: 6800000, avgVolume: 5500000, stochK: 88, stochD: 82 },
    fundamental: { per: 28.5, pbr: 12.1, roe: 42.5, divYield: 0.5, epsGrowth: 35.2, revenueGrowth: 35.2, marketCap: "1.7兆円" },
    earnings: { quarter: "Q2 FY2025", result: "大幅増収増益", surprise: "+12.5%", nextDate: "3/12", guidance: "受注残消化で下期も高成長" },
    news: [
      { title: "EUV検査装置の次世代品でASMLとの協業深化", impact: "positive", type: "事業" },
      { title: "受注残高が過去最高を更新", impact: "positive", type: "業績" },
      { title: "半導体サイクル底打ちで設備投資再開の動き", impact: "positive", type: "業界" },
    ]
  },
  { code: "8306", name: "三菱UFJ FG", market: "JP", sector: "銀行業", price: 1892, change: +0.5, currency: "¥",
    technical: { rsi: 52, macd: 5.2, macdSignal: "neutral", ma5: 1880, ma25: 1850, ma50: 1810, ma75: 1720, ma200: 1580, volume: 22100000, avgVolume: 20000000, stochK: 55, stochD: 52 },
    fundamental: { per: 12.1, pbr: 0.9, roe: 7.8, divYield: 3.2, epsGrowth: 5.1, revenueGrowth: 5.1, marketCap: "22.8兆円" },
    earnings: { quarter: "Q3 FY2025", result: "最高益更新", surprise: "+8.1%", nextDate: "5/15", guidance: "純利益1.8兆円見通し維持" },
    news: [
      { title: "日銀追加利上げ観測で銀行株に買い", impact: "positive", type: "金利" },
      { title: "自社株買い1000億円を追加発表", impact: "positive", type: "株主還元" },
      { title: "海外事業の利益構成比が過去最高", impact: "positive", type: "業績" },
    ]
  },
  { code: "8058", name: "三菱商事", market: "JP", sector: "卸売業", price: 2580, change: +1.0, currency: "¥",
    technical: { rsi: 56, macd: 8.1, macdSignal: "bullish", ma5: 2560, ma25: 2520, ma50: 2480, ma75: 2400, ma200: 2250, volume: 9200000, avgVolume: 8500000, stochK: 60, stochD: 55 },
    fundamental: { per: 9.8, pbr: 1.2, roe: 12.5, divYield: 3.5, epsGrowth: 6.8, revenueGrowth: 6.8, marketCap: "10.8兆円" },
    earnings: { quarter: "Q3 FY2025", result: "増益", surprise: "+4.3%", nextDate: "5/2", guidance: "資源高と非資源成長のバランス良好" },
    news: [
      { title: "バフェット氏が日本商社株の追加取得を示唆", impact: "positive", type: "需給" },
      { title: "資源価格上昇でエネルギー部門の利益拡大", impact: "positive", type: "業績" },
      { title: "ローソン完全子会社化のシナジーに期待", impact: "positive", type: "事業" },
    ]
  },
  { code: "4568", name: "第一三共", market: "JP", sector: "医薬品", price: 4850, change: +1.5, currency: "¥",
    technical: { rsi: 62, macd: 35, macdSignal: "bullish", ma5: 4800, ma25: 4700, ma50: 4600, ma75: 4400, ma200: 4100, volume: 7100000, avgVolume: 6200000, stochK: 68, stochD: 62 },
    fundamental: { per: 45.2, pbr: 6.8, roe: 15.1, divYield: 0.7, epsGrowth: 28.5, revenueGrowth: 28.5, marketCap: "9.4兆円" },
    earnings: { quarter: "Q3 FY2025", result: "大幅増益", surprise: "+9.2%", nextDate: "4/28", guidance: "エンハーツの売上拡大が加速" },
    news: [
      { title: "エンハーツの適応拡大、肺がん3次治療で承認", impact: "positive", type: "パイプライン" },
      { title: "ADC新候補薬がPhase2で良好な結果", impact: "positive", type: "パイプライン" },
      { title: "アストラゼネカとの提携深化", impact: "positive", type: "提携" },
    ]
  },
  { code: "7974", name: "任天堂", market: "JP", sector: "その他製品", price: 9180, change: -1.2, currency: "¥",
    technical: { rsi: 38, macd: -85, macdSignal: "bearish", ma5: 9300, ma25: 9500, ma50: 9400, ma75: 9200, ma200: 8800, volume: 4500000, avgVolume: 4000000, stochK: 25, stochD: 30 },
    fundamental: { per: 22.5, pbr: 4.8, roe: 21.3, divYield: 2.2, epsGrowth: -5.2, revenueGrowth: -5.2, marketCap: "11.9兆円" },
    earnings: { quarter: "Q3 FY2025", result: "減収減益", surprise: "-3.2%", nextDate: "5/7", guidance: "Switch末期、後継機に期待" },
    news: [
      { title: "Switch後継機の発表延期との報道", impact: "negative", type: "製品" },
      { title: "既存タイトルの売上減速", impact: "negative", type: "業績" },
      { title: "マリオ映画続編の制作発表", impact: "positive", type: "IP" },
    ]
  },
  { code: "AAPL", name: "Apple Inc.", market: "US", sector: "Technology", price: 227.48, change: +0.54, currency: "$",
    technical: { rsi: 61, macd: 0.23, macdSignal: "bullish", ma5: 225.8, ma25: 222.1, ma50: 219.5, ma75: 215.0, ma200: 198.5, volume: 52000000, avgVolume: 48000000, stochK: 64, stochD: 60 },
    fundamental: { per: 36, pbr: 2.6, roe: 17, divYield: 0.4, epsGrowth: 13.4, revenueGrowth: 6.1, marketCap: "$3.4T" },
    earnings: { quarter: "Q1 FY2025", result: "Beat", surprise: "+4.2%", nextDate: "4/30", guidance: "iPhone/Services堅調" },
    news: [
      { title: "Apple Intelligence搭載iPhoneの販売好調", impact: "positive", type: "製品" },
      { title: "Services部門の売上が過去最高を更新", impact: "positive", type: "業績" },
      { title: "中国市場でのシェア低下が懸念材料", impact: "negative", type: "市場" },
    ]
  },
  { code: "MSFT", name: "Microsoft Corp.", market: "US", sector: "Technology", price: 415.20, change: +1.1, currency: "$",
    technical: { rsi: 58, macd: 2.8, macdSignal: "bullish", ma5: 412, ma25: 408, ma50: 400, ma75: 395, ma200: 380, volume: 24000000, avgVolume: 22000000, stochK: 62, stochD: 58 },
    fundamental: { per: 34.5, pbr: 12.5, roe: 36.2, divYield: 0.7, epsGrowth: 18.5, revenueGrowth: 16.2, marketCap: "$3.1T" },
    earnings: { quarter: "Q2 FY2025", result: "Beat", surprise: "+5.8%", nextDate: "4/22", guidance: "Azure+AI需要で強い見通し" },
    news: [
      { title: "Azure売上がAI需要で前年比30%増", impact: "positive", type: "クラウド" },
      { title: "Copilot有料版の企業導入が加速", impact: "positive", type: "AI" },
      { title: "EU規制当局がTeams統合問題で調査", impact: "negative", type: "規制" },
    ]
  },
  { code: "NVDA", name: "NVIDIA Corp.", market: "US", sector: "Semiconductors", price: 138.50, change: +3.2, currency: "$",
    technical: { rsi: 73, macd: 5.5, macdSignal: "bullish", ma5: 134, ma25: 128, ma50: 122, ma75: 115, ma200: 98, volume: 380000000, avgVolume: 320000000, stochK: 85, stochD: 80 },
    fundamental: { per: 55.0, pbr: 42.0, roe: 76.3, divYield: 0.02, epsGrowth: 120.0, revenueGrowth: 95.0, marketCap: "$3.4T" },
    earnings: { quarter: "Q4 FY2025", result: "大幅Beat", surprise: "+12.0%", nextDate: "5/28", guidance: "Blackwell需要で過去最高更新見通し" },
    news: [
      { title: "Blackwell GPUの需要が供給を大幅に上回る", impact: "positive", type: "製品" },
      { title: "データセンター売上が前年比3倍の成長", impact: "positive", type: "業績" },
      { title: "中国向け輸出規制の影響は限定的", impact: "neutral", type: "規制" },
    ]
  },
  { code: "GOOGL", name: "Alphabet Inc.", market: "US", sector: "Technology", price: 178.50, change: +0.8, currency: "$",
    technical: { rsi: 55, macd: 1.2, macdSignal: "neutral", ma5: 177, ma25: 175, ma50: 172, ma75: 168, ma200: 158, volume: 28000000, avgVolume: 26000000, stochK: 58, stochD: 55 },
    fundamental: { per: 22.5, pbr: 7.2, roe: 32.0, divYield: 0.5, epsGrowth: 28.5, revenueGrowth: 15.2, marketCap: "$2.2T" },
    earnings: { quarter: "Q4 2024", result: "Beat", surprise: "+6.5%", nextDate: "4/22", guidance: "Cloud+AI広告が成長牽引" },
    news: [
      { title: "Google Cloud売上が前年比35%増", impact: "positive", type: "クラウド" },
      { title: "Gemini AIモデルの企業導入進む", impact: "positive", type: "AI" },
      { title: "独占禁止法訴訟で検索事業への影響懸念", impact: "negative", type: "規制" },
    ]
  },
  { code: "AMZN", name: "Amazon.com Inc.", market: "US", sector: "Consumer", price: 225.30, change: +1.5, currency: "$",
    technical: { rsi: 62, macd: 3.5, macdSignal: "bullish", ma5: 222, ma25: 218, ma50: 212, ma75: 205, ma200: 190, volume: 45000000, avgVolume: 42000000, stochK: 68, stochD: 62 },
    fundamental: { per: 38.5, pbr: 8.5, roe: 22.1, divYield: 0, epsGrowth: 55.0, revenueGrowth: 12.8, marketCap: "$2.4T" },
    earnings: { quarter: "Q4 2024", result: "Beat", surprise: "+8.2%", nextDate: "4/24", guidance: "AWS+広告事業が高成長維持" },
    news: [
      { title: "AWS売上が前年比19%増、AI機能が差別化要因", impact: "positive", type: "クラウド" },
      { title: "広告事業が前年比27%増と急成長", impact: "positive", type: "事業" },
      { title: "物流コスト増が小売部門の利益率を圧迫", impact: "negative", type: "コスト" },
    ]
  },
  { code: "TSLA", name: "Tesla Inc.", market: "US", sector: "Automotive", price: 338.50, change: -2.1, currency: "$",
    technical: { rsi: 45, macd: -8.5, macdSignal: "bearish", ma5: 345, ma25: 355, ma50: 360, ma75: 340, ma200: 280, volume: 95000000, avgVolume: 85000000, stochK: 32, stochD: 38 },
    fundamental: { per: 105.0, pbr: 18.5, roe: 17.6, divYield: 0, epsGrowth: -15.0, revenueGrowth: 2.1, marketCap: "$1.1T" },
    earnings: { quarter: "Q4 2024", result: "Miss", surprise: "-8.5%", nextDate: "4/22", guidance: "FSD/ロボタクシーに注力" },
    news: [
      { title: "中国でのEV販売台数がBYDに大差で敗退", impact: "negative", type: "市場" },
      { title: "マスク氏の政治活動がブランドイメージに影響", impact: "negative", type: "経営" },
      { title: "FSD v13ベータ版が好評、自動運転に前進", impact: "positive", type: "技術" },
    ]
  },
  { code: "META", name: "Meta Platforms", market: "US", sector: "Technology", price: 630.20, change: +1.8, currency: "$",
    technical: { rsi: 64, macd: 12, macdSignal: "bullish", ma5: 622, ma25: 610, ma50: 595, ma75: 575, ma200: 520, volume: 15000000, avgVolume: 14000000, stochK: 70, stochD: 65 },
    fundamental: { per: 25.8, pbr: 9.2, roe: 35.7, divYield: 0.3, epsGrowth: 42.0, revenueGrowth: 22.5, marketCap: "$1.6T" },
    earnings: { quarter: "Q4 2024", result: "Beat", surprise: "+7.8%", nextDate: "4/23", guidance: "AI広告最適化とReels収益化が加速" },
    news: [
      { title: "AI広告ターゲティング精度向上で広告単価上昇", impact: "positive", type: "AI" },
      { title: "Reelsのマネタイズが本格化し収益貢献", impact: "positive", type: "事業" },
      { title: "メタバース事業Reality Labsの赤字継続", impact: "negative", type: "事業" },
    ]
  },
  { code: "6702", name: "富士通", market: "JP", sector: "電気機器", price: 2895, change: +1.8, currency: "¥",
    technical: { rsi: 60, macd: 22, macdSignal: "bullish", ma5: 2860, ma25: 2810, ma50: 2750, ma75: 2650, ma200: 2400, volume: 4800000, avgVolume: 4200000, stochK: 66, stochD: 60 },
    fundamental: { per: 24.5, pbr: 3.2, roe: 13.1, divYield: 1.0, epsGrowth: 15.8, revenueGrowth: 7.5, marketCap: "5.9兆円" },
    earnings: { quarter: "Q3 FY2025", result: "増収増益", surprise: "+4.8%", nextDate: "4/25", guidance: "Uvance事業が成長牽引" },
    news: [
      { title: "Uvance事業の売上が前年比30%増と急成長", impact: "positive", type: "事業" },
      { title: "富岳後継の次世代スパコン開発が進展", impact: "positive", type: "技術" },
      { title: "英国郵便局問題の和解費用が重し", impact: "negative", type: "訴訟" },
    ]
  },
  { code: "9984", name: "ソフトバンクG", market: "JP", sector: "情報・通信", price: 9250, change: +3.5, currency: "¥",
    technical: { rsi: 72, macd: 180, macdSignal: "bullish", ma5: 9100, ma25: 8800, ma50: 8500, ma75: 8200, ma200: 7500, volume: 11500000, avgVolume: 9800000, stochK: 80, stochD: 75 },
    fundamental: { per: 15.8, pbr: 1.8, roe: 11.2, divYield: 0.5, epsGrowth: 22.0, revenueGrowth: 22.0, marketCap: "13.4兆円" },
    earnings: { quarter: "Q3 FY2025", result: "黒字転換", surprise: "+15%", nextDate: "5/12", guidance: "Arm株上昇でNAV大幅改善" },
    news: [
      { title: "Arm株急騰でNAV大幅改善、AI需要追い風", impact: "positive", type: "投資" },
      { title: "ビジョンファンドの投資先3社がIPO準備中", impact: "positive", type: "投資" },
      { title: "孫正義氏「AI革命はまだ始まったばかり」", impact: "neutral", type: "経営" },
    ]
  },
  { code: "4063", name: "信越化学工業", market: "JP", sector: "化学", price: 5620, change: +0.8, currency: "¥",
    technical: { rsi: 55, macd: 15, macdSignal: "bullish", ma5: 5580, ma25: 5500, ma50: 5400, ma75: 5300, ma200: 5000, volume: 3200000, avgVolume: 2800000, stochK: 60, stochD: 55 },
    fundamental: { per: 14.2, pbr: 2.5, roe: 17.6, divYield: 2.1, epsGrowth: 9.3, revenueGrowth: 9.3, marketCap: "11.2兆円" },
    earnings: { quarter: "Q3 FY2025", result: "増益", surprise: "+2.1%", nextDate: "4/25", guidance: "ウエハー値上げ交渉進展次第" },
    news: [
      { title: "半導体シリコンウエハーの値上げ交渉が進展", impact: "positive", type: "事業" },
      { title: "TSMC熊本第2工場向け供給契約を締結", impact: "positive", type: "事業" },
      { title: "塩ビ事業、米国住宅着工回復で恩恵期待", impact: "positive", type: "業績" },
    ]
  },
  { code: "6501", name: "日立製作所", market: "JP", sector: "電気機器", price: 3850, change: +1.8, currency: "¥",
    technical: { rsi: 63, macd: 28, macdSignal: "bullish", ma5: 3800, ma25: 3720, ma50: 3650, ma75: 3500, ma200: 3200, volume: 6200000, avgVolume: 5500000, stochK: 70, stochD: 64 },
    fundamental: { per: 18.5, pbr: 2.8, roe: 15.1, divYield: 1.3, epsGrowth: 10.5, revenueGrowth: 10.5, marketCap: "17.8兆円" },
    earnings: { quarter: "Q3 FY2025", result: "最高益更新", surprise: "+7.5%", nextDate: "4/25", guidance: "Lumada・エナジーが二桁成長" },
    news: [
      { title: "Lumada事業の売上が前年比25%増", impact: "positive", type: "事業" },
      { title: "日立エナジーの受注残高が過去最高", impact: "positive", type: "業績" },
      { title: "構造改革完了、高収益体質への転換進む", impact: "positive", type: "経営" },
    ]
  },
  { code: "9432", name: "NTT", market: "JP", sector: "情報・通信", price: 155, change: -0.2, currency: "¥",
    technical: { rsi: 42, macd: -1.2, macdSignal: "bearish", ma5: 155.5, ma25: 156, ma50: 157, ma75: 158, ma200: 160, volume: 45000000, avgVolume: 40000000, stochK: 35, stochD: 38 },
    fundamental: { per: 11.8, pbr: 1.4, roe: 12.0, divYield: 3.4, epsGrowth: 3.2, revenueGrowth: 3.2, marketCap: "14.0兆円" },
    earnings: { quarter: "Q3 FY2025", result: "計画線", surprise: "-0.5%", nextDate: "5/10", guidance: "成長投資の費用増を吸収" },
    news: [
      { title: "IOWN構想の商用化第1弾サービス開始", impact: "positive", type: "事業" },
      { title: "株式25分割後も株価低迷続く", impact: "negative", type: "市場" },
      { title: "データセンター事業の成長率が鈍化", impact: "negative", type: "業績" },
    ]
  },
  { code: "3382", name: "セブン&アイ", market: "JP", sector: "小売業", price: 2150, change: -0.8, currency: "¥",
    technical: { rsi: 35, macd: -25, macdSignal: "bearish", ma5: 2180, ma25: 2200, ma50: 2250, ma75: 2250, ma200: 2100, volume: 5600000, avgVolume: 5000000, stochK: 28, stochD: 32 },
    fundamental: { per: 21.5, pbr: 1.5, roe: 7.0, divYield: 2.5, epsGrowth: 2.1, revenueGrowth: 2.1, marketCap: "5.6兆円" },
    earnings: { quarter: "Q3 FY2025", result: "減益", surprise: "-4.5%", nextDate: "4/10", guidance: "構造改革費用が利益を圧迫" },
    news: [
      { title: "クシュタールからの買収提案を正式拒否", impact: "negative", type: "M&A" },
      { title: "国内コンビニ既存店売上が3ヶ月連続マイナス", impact: "negative", type: "業績" },
      { title: "イトーヨーカ堂の構造改革が難航", impact: "negative", type: "経営" },
    ]
  },
];

// ============================================
// マーケット指標データ
// ============================================
const MARKET_INDICES = {
  nikkei: { name: "日経平均株価", code: "NI225", value: 39420, change: +1.3, ytd: +8.5, high52w: 41200, low52w: 31500, currency: "¥" },
  topix: { name: "TOPIX", code: "TPX", value: 2785, change: +0.9, ytd: +10.2, high52w: 2920, low52w: 2200, currency: "¥" },
  sp500: { name: "S&P 500", code: "SPX", value: 6052, change: +0.7, ytd: +4.2, high52w: 6150, low52w: 4950, currency: "$" },
  nasdaq: { name: "NASDAQ 100", code: "NDX", value: 21580, change: +1.2, ytd: +5.8, high52w: 22100, low52w: 17200, currency: "$" },
  dow: { name: "ダウ平均", code: "DJI", value: 44250, change: +0.5, ytd: +3.1, high52w: 45100, low52w: 37800, currency: "$" },
};

const MARKET_ANALYSIS = {
  nikkei: {
    summary: "日経平均は39,400円台で堅調に推移。米ハイテク株高と円安が追い風となり、半導体関連や自動車株を中心に買いが優勢。",
    technical: "25日移動平均線（38,800円）を上回り、短期上昇トレンドを維持。RSI 62で過熱感はなく、上値余地あり。ボリンジャーバンド+1σ付近で推移しており、バンドウォークの可能性。",
    drivers: "半導体関連（レーザーテック、東京エレクトロン）がセクター牽引。日銀の金融政策正常化への期待から銀行株も堅調。円安（154円台）が輸出企業の収益を押し上げ。",
    outlook: "テクニカル的には40,000円の心理的節目が次のターゲット。下値は25日移動平均線の38,800円がサポート。米国の利下げ観測と半導体サイクル回復が中期的な追い風。リスク要因は急激な円高転換と米中関係の悪化。",
    keyEvents: ["3/14 日銀金融政策決定会合", "3/19 FOMC結果発表", "3月末 配当権利確定日"],
    sentiment: 72,
  },
  topix: {
    summary: "TOPIXは2,785ポイントで年初来高値圏。バリュー株とグロース株のバランスが取れた上昇で、相場の厚みがある。",
    technical: "200日移動平均線を大きく上回り、長期上昇トレンドが継続。NT倍率（日経/TOPIX）はやや低下傾向で、バリュー株への資金シフトが見られる。",
    drivers: "銀行・保険などの金融セクターが牽引。商社株はバフェット効果の継続で海外投資家の買いが入りやすい。不動産セクターは金利上昇への警戒感から上値重い。",
    outlook: "2,800ポイントの突破が焦点。海外投資家の買い越し基調が続けば、3,000ポイントへの道筋が見えてくる。PBR1倍割れの是正圧力が引き続き東証主導で進行中。",
    keyEvents: ["3月中 東証のPBR改善要請進捗報告", "4月 新年度入り機関投資家のリバランス"],
    sentiment: 68,
  },
  sp500: {
    summary: "S&P 500は6,050台で史上最高値圏。AI関連投資の拡大期待とFRBの利下げ観測が相場を下支え。",
    technical: "主要移動平均線をすべて上回る強い上昇トレンド。ただしRSI 68とやや過熱気味で、短期的な調整の可能性にも注意。出来高は平均を上回り、買い圧力は健在。",
    drivers: "マグニフィセント7（Apple, Microsoft, NVIDIA等）が指数を牽引。AI設備投資の拡大でテクノロジーセクターが好調。ヘルスケア・公益は相対的にアンダーパフォーム。",
    outlook: "6,000台の定着が焦点。企業決算は概ね好調で、EPS成長率はコンセンサス+10%前後。FRBの利下げペースが鍵。インフレの再加速がテールリスク。年末ターゲットは6,500〜6,800のレンジ。",
    keyEvents: ["3/19 FOMC（金利据え置き予想）", "3月下旬 PCEデフレーター発表", "4月 Q1決算シーズン開始"],
    sentiment: 70,
  },
  nasdaq: {
    summary: "NASDAQ 100は21,500台で高値圏を維持。AI・半導体銘柄への資金流入が続き、テクノロジー主導の上昇。",
    technical: "50日移動平均線からの乖離率が+5.8%とやや大きく、短期的な過熱リスクに注意。ただし、MACDは上昇シグナルを維持しており、トレンド自体は強い。",
    drivers: "NVIDIAのデータセンター向け需要爆発、Microsoft/AmazonのAIインフラ投資拡大がセクター全体を押し上げ。半導体関連ETF（SOX）も高値更新。Apple Intelligenceの展開もポジティブ材料。",
    outlook: "22,000ポイントが次のマイルストーン。AI投資テーマは2026年も継続見通し。リスクは金利上昇によるグロース株のバリュエーション圧縮と、AI投資の収益化への懐疑論台頭。",
    keyEvents: ["3/5 NVIDIA GTC 2026", "3/19 FOMC", "4月 GAFAM決算集中"],
    sentiment: 74,
  },
  dow: {
    summary: "ダウ平均は44,250ドルで横ばい圏。ハイテク以外のオールドエコノミー銘柄の上値が重く、NASDAQに対してアンダーパフォーム。",
    technical: "25日移動平均線と50日移動平均線が接近し、方向感が出にくい局面。RSI 52は中立圏で、上下どちらにも動きやすい。出来高は減少傾向で、投資家の様子見姿勢が鮮明。",
    drivers: "UnitedHealth、Goldmanなど金融・ヘルスケアが堅調な一方、Boeing、Nikeなど個別銘柄の悪材料が指数の重し。ホームデポなど消費関連は景気減速懸念で上値重い。",
    outlook: "45,000ドルの壁が意識される。構成銘柄の入替え（AI関連の追加）が進めば再評価の余地あり。景気のソフトランディング成功が前提条件。金利高止まりが長期化すれば、バリュエーション調整のリスク。",
    keyEvents: ["3/7 雇用統計", "3/19 FOMC", "3月 個人消費支出データ"],
    sentiment: 55,
  },
};

// ============================================
// AI分析エンジン
// ============================================
function analyzeStock(stock) {
  const t = stock.technical;
  const f = stock.fundamental;
  const news = stock.news || [];
  const earn = stock.earnings;
  const posNews = news.filter(n => n.impact === "positive").length;
  const negNews = news.filter(n => n.impact === "negative").length;
  const newsScore = (posNews - negNews) * 12;
  const techScore =
    (t.macdSignal === "bullish" ? 10 : t.macdSignal === "bearish" ? -10 : 0) +
    (t.rsi < 30 ? 15 : t.rsi < 45 ? 8 : t.rsi > 80 ? -15 : t.rsi > 70 ? -8 : 3) +
    (stock.price > t.ma25 ? 5 : -5) + (stock.price > t.ma75 ? 5 : -5) +
    (stock.price > t.ma200 ? 5 : -3) + (t.volume > t.avgVolume * 1.15 ? 5 : 0) +
    (t.stochK > t.stochD ? 3 : -3);
  const fundScore =
    (f.per < 15 ? 8 : f.per < 25 ? 3 : f.per > 40 ? -3 : 0) +
    (f.pbr < 1.5 ? 8 : f.pbr < 3 ? 3 : 0) +
    (f.roe > 15 ? 10 : f.roe > 10 ? 5 : 0) +
    (f.epsGrowth > 20 ? 10 : f.epsGrowth > 10 ? 6 : f.epsGrowth > 0 ? 3 : -5) +
    (f.divYield > 3 ? 5 : f.divYield > 2 ? 3 : 0);
  const earnScore = earn?.surprise ? parseFloat(earn.surprise) * 2 : 0;
  const mktSentiment = 68;
  const mktScore = mktSentiment > 60 ? 5 : mktSentiment < 40 ? -5 : 0;

  const dailyRaw = techScore * 0.55 + newsScore * 0.3 + mktScore * 0.15;
  const weeklyRaw = techScore * 0.4 + newsScore * 0.25 + earnScore * 0.2 + mktScore * 0.15;
  const monthlyRaw = fundScore * 0.4 + techScore * 0.2 + newsScore * 0.15 + earnScore * 0.15 + mktScore * 0.1;
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const toSentiment = (raw) => clamp(50 + raw, 10, 95);
  const ds = toSentiment(dailyRaw), ws = toSentiment(weeklyRaw), ms = toSentiment(monthlyRaw);
  const label = (s) => s >= 65 ? "強気" : s >= 50 ? "やや強気" : s >= 40 ? "やや弱気" : "弱気";
  const dir = (s) => s >= 60 ? "買い" : s >= 45 ? "中立" : "売り";
  const tag = (p, s) => {
    if (p === "daily") return s >= 55 ? "スイング" : "様子見";
    if (p === "weekly") return s >= 55 ? "スイング〜長期" : "様子見";
    return s >= 55 ? "ファンダメンタル" : "リスク管理";
  };

  const genDaily = () => {
    let s = "";
    if (t.rsi < 40) s += `RSI ${t.rsi}は売られすぎゾーンに近く、反発余地がある。`;
    else if (t.rsi < 55) s += `RSI ${t.rsi}は過売りゾーンを脱し、`;
    else if (t.rsi > 75) s += `RSI ${t.rsi}は買われすぎ水準で、短期的な調整リスクに注意。`;
    else s += `RSI ${t.rsi}は中立圏で、`;
    if (t.macdSignal === "bullish") s += `MACDがゴールデンクロス直前。短期モメンタムが上向きに転換しており、翌日の上昇余地がある。`;
    else if (t.macdSignal === "bearish") s += `MACDがデッドクロス圏内。短期的な下押し圧力が続く可能性。`;
    else s += `MACDは横ばいで方向感に乏しい。明確なシグナル待ち。`;
    if (t.volume > t.avgVolume * 1.2) s += `出来高が平均比${Math.round(t.volume / t.avgVolume * 100)}%と増加しトレンドの信頼性が高い。`;
    return s;
  };
  const genWeekly = () => {
    let s = `50日移動平均線から${((stock.price - t.ma50) / t.ma50 * 100).toFixed(1)}%の位置で、`;
    if (t.macdSignal === "bullish") s += `週足MACDは上昇転換シグナル。来週にかけてトレンドフォロー狙いが有効。`;
    else if (t.macdSignal === "bearish") s += `週足MACDは下降トレンドを示唆。戻り売り優勢の展開。`;
    else s += `週足MACDはニュートラル。方向感が出るまで待機が賢明。`;
    if (earn && parseFloat(earn.surprise) > 3) s += `直近決算のサプライズ（${earn.surprise}）が好感され買い圧力持続。`;
    if (posNews >= 2) s += `ニュースフローも良好でセンチメント改善が期待。`;
    if (negNews >= 2) s += `ネガティブニュースが複数あり下値警戒が必要。`;
    return s;
  };
  const genMonthly = () => {
    let s = `PER ${f.per}倍・PBR ${f.pbr}倍は`;
    if (f.per < 15 && f.pbr < 1.5) s += `同業他社比で割安水準。`;
    else if (f.per < 25) s += `適正水準。`;
    else s += `やや割高だが成長性を考慮すると許容範囲。`;
    s += `EPS成長率${f.epsGrowth}%・ROE ${f.roe}%と収益力`;
    if (f.roe > 15 && f.epsGrowth > 10) s += `も堅調。`;
    else if (f.roe > 10) s += `はまずまず。`;
    else s += `には改善余地あり。`;
    if (ms >= 55) s += `1ヶ月スパンでの押し目買い戦略が有望。`;
    else if (ms >= 45) s += `1ヶ月スパンでは慎重にエントリータイミングを見極めたい。`;
    else s += `リスク管理を優先しポジション縮小も検討。`;
    if (f.divYield >= 3) s += `配当利回り${f.divYield}%と高配当で長期保有の下支え。`;
    return s;
  };

  return {
    daily: { sentiment: ds, label: label(ds), direction: dir(ds), tag: tag("daily", ds), analysis: genDaily() },
    weekly: { sentiment: ws, label: label(ws), direction: dir(ws), tag: tag("weekly", ws), analysis: genWeekly() },
    monthly: { sentiment: ms, label: label(ms), direction: dir(ms), tag: tag("monthly", ms), analysis: genMonthly() },
  };
}

// ============================================
// UIコンポーネント
// ============================================
function SentimentBar({ value, label }) {
  const color = value >= 65 ? "#22c55e" : value >= 50 ? "#4ade80" : value >= 40 ? "#eab308" : "#ef4444";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
      <span style={{ fontSize: 12, color, fontWeight: 600, minWidth: 48 }}>{label}</span>
      <div style={{ flex: 1, height: 8, borderRadius: 4, background: "rgba(148,163,184,0.1)", overflow: "hidden" }}>
        <div style={{ height: "100%", borderRadius: 4, width: `${value}%`, background: `linear-gradient(90deg, ${color}cc, ${color})`, transition: "width 0.6s cubic-bezier(0.4,0,0.2,1)", boxShadow: `0 0 8px ${color}40` }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 800, color, minWidth: 36, textAlign: "right" }}>{value}%</span>
    </div>
  );
}

function DirectionTag({ direction, tag }) {
  const d = { "買い": { bg: "rgba(34,197,94,0.18)", color: "#4ade80", icon: "▲" }, "売り": { bg: "rgba(239,68,68,0.18)", color: "#f87171", icon: "▼" }, "中立": { bg: "rgba(234,179,8,0.18)", color: "#eab308", icon: "●" } }[direction] || { bg: "rgba(234,179,8,0.18)", color: "#eab308", icon: "●" };
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6, marginBottom: 8 }}>
      <span style={{ padding: "3px 10px", borderRadius: 5, fontSize: 11, fontWeight: 700, background: d.bg, color: d.color }}>{d.icon} {direction}</span>
      <span style={{ padding: "3px 10px", borderRadius: 5, fontSize: 11, fontWeight: 600, background: "rgba(99,102,241,0.12)", color: "#a5b4fc" }}>{tag}</span>
    </div>
  );
}

function PredictionCard({ label, dot, data }) {
  return (
    <div style={{ background: "rgba(15,20,35,0.7)", borderRadius: 12, padding: "16px 18px", marginBottom: 10, border: "1px solid rgba(148,163,184,0.06)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, boxShadow: `0 0 6px ${dot}80` }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{label}</span>
      </div>
      <SentimentBar value={data.sentiment} label={data.label} />
      <DirectionTag direction={data.direction} tag={data.tag} />
      <p style={{ fontSize: 13, lineHeight: 1.75, color: "#c8d0dc", margin: 0 }}>{data.analysis}</p>
    </div>
  );
}

function StockCard({ stock, analysis, isFav, onToggleFav, expanded, onToggleExpand }) {
  const mBadge = stock.market === "US" ? { bg: "rgba(59,130,246,0.2)", c: "#60a5fa", l: "US" } : { bg: "rgba(239,68,68,0.15)", c: "#f87171", l: "JP" };
  const techItems = [
    { label: "RSI(14)", value: stock.technical.rsi, color: stock.technical.rsi > 70 ? "#f87171" : stock.technical.rsi < 30 ? "#4ade80" : "#e2e8f0" },
    { label: "MACD", value: stock.technical.macd > 0 ? `${Number(stock.technical.macd).toFixed(2)}` : `${Number(stock.technical.macd).toFixed(2)}`, color: stock.technical.macd > 0 ? "#4ade80" : "#f87171" },
    { label: "PER", value: `${stock.fundamental.per}x`, color: "#e2e8f0" },
    { label: "PBR", value: `${stock.fundamental.pbr}x`, color: "#e2e8f0" },
    { label: "ROE", value: `${stock.fundamental.roe}%`, color: stock.fundamental.roe >= 15 ? "#4ade80" : "#e2e8f0" },
    { label: "EPS成長", value: `${stock.fundamental.epsGrowth}%`, color: stock.fundamental.epsGrowth > 10 ? "#4ade80" : stock.fundamental.epsGrowth < 0 ? "#f87171" : "#e2e8f0" },
  ];

  return (
    <div style={{ background: "rgba(16,22,40,0.8)", borderRadius: 16, marginBottom: 14, border: "1px solid rgba(148,163,184,0.06)", overflow: "hidden", boxShadow: "0 2px 20px rgba(0,0,0,0.3)" }}>
      {/* ヘッダー */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "18px 18px 14px", background: "linear-gradient(180deg, rgba(22,30,52,0.9), rgba(15,20,35,0.6))" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 20, fontWeight: 900, color: "#f1f5f9", letterSpacing: "0.04em" }}>{stock.code}</span>
            <span style={{ padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 700, background: mBadge.bg, color: mBadge.c }}>{mBadge.l}</span>
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>{stock.name}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 28, fontWeight: 900, color: "#f1f5f9", fontVariantNumeric: "tabular-nums" }}>{stock.currency}{stock.price.toLocaleString()}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: stock.change >= 0 ? "#4ade80" : "#f87171" }}>
              {stock.change >= 0 ? "+" : ""}{stock.change.toFixed(2)}%
            </span>
          </div>
        </div>
        <button onClick={onToggleFav} style={{
          width: 36, height: 36, borderRadius: 10,
          background: isFav ? "rgba(251,191,36,0.15)" : "rgba(148,163,184,0.08)",
          border: `1px solid ${isFav ? "rgba(251,191,36,0.3)" : "rgba(148,163,184,0.12)"}`,
          color: isFav ? "#fbbf24" : "#475569", fontSize: 16, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>{isFav ? "★" : "☆"}</button>
      </div>

      {/* テクニカル指標 */}
      <div style={{ padding: "0 18px 14px" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", marginBottom: 8, letterSpacing: "0.06em" }}>テクニカル指標</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {techItems.map(item => (
            <div key={item.label} style={{ background: "rgba(15,20,35,0.7)", borderRadius: 10, padding: "10px 14px", border: "1px solid rgba(148,163,184,0.05)" }}>
              <div style={{ fontSize: 10, color: "#475569", marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: item.color, fontVariantNumeric: "tabular-nums" }}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 予測 */}
      <div style={{ padding: "0 18px" }}>
        <PredictionCard label="翌日 予想" dot="#3b82f6" data={analysis.daily} />
        <PredictionCard label="翌週 予想" dot="#f59e0b" data={analysis.weekly} />
        <PredictionCard label="今月 予想" dot="#a855f7" data={analysis.monthly} />
      </div>

      {/* 展開ボタン */}
      <div style={{ padding: "8px 18px 4px" }}>
        <button onClick={onToggleExpand} style={{
          width: "100%", padding: "8px", borderRadius: 8,
          background: "rgba(148,163,184,0.05)", border: "1px solid rgba(148,163,184,0.08)",
          color: "#64748b", fontSize: 11, fontWeight: 600, cursor: "pointer",
        }}>{expanded ? "▲ ニュース・決算を閉じる" : "▼ ニュース・決算を表示"}</button>
      </div>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          {/* ニュース */}
          {stock.news?.length > 0 && (
            <div style={{ padding: "0 18px 14px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", marginBottom: 8 }}>直近ニュース</div>
              {stock.news.map((n, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6, padding: "8px 12px", borderRadius: 8, background: "rgba(15,20,35,0.5)" }}>
                  <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700, flexShrink: 0, background: n.impact === "positive" ? "rgba(34,197,94,0.15)" : n.impact === "negative" ? "rgba(239,68,68,0.15)" : "rgba(148,163,184,0.1)", color: n.impact === "positive" ? "#4ade80" : n.impact === "negative" ? "#f87171" : "#94a3b8" }}>{n.type}</span>
                  <span style={{ fontSize: 12, color: "#c8d0dc", lineHeight: 1.5 }}>{n.title}</span>
                </div>
              ))}
            </div>
          )}
          {/* 決算 */}
          {stock.earnings && (
            <div style={{ padding: "0 18px 16px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", marginBottom: 8 }}>決算情報</div>
              <div style={{ background: "rgba(15,20,35,0.7)", borderRadius: 10, padding: "12px 14px", border: "1px solid rgba(148,163,184,0.05)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0" }}>{stock.earnings.quarter}</span>
                  <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: parseFloat(stock.earnings.surprise) > 0 ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)", color: parseFloat(stock.earnings.surprise) > 0 ? "#4ade80" : "#f87171" }}>サプライズ {stock.earnings.surprise}</span>
                </div>
                <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>{stock.earnings.result}</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>{stock.earnings.guidance}</div>
                <div style={{ marginTop: 8, fontSize: 10, color: "#475569" }}>次回決算: <span style={{ color: "#eab308", fontWeight: 700 }}>{stock.earnings.nextDate}</span></div>
              </div>
            </div>
          )}
        </div>
      )}
      <div style={{ height: 8 }} />
    </div>
  );
}

// ============================================
// メインアプリ
// ============================================
export default function App() {
  const [activeTab, setActiveTab] = useState("watch");
  const [favorites, setFavorites] = useState(new Set(["7203", "6758", "6920", "AAPL", "MSFT", "NVDA"]));
  const [expandedCards, setExpandedCards] = useState(new Set());
  const [allStocks, setAllStocks] = useState(BUILTIN_STOCKS);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [favListOpen, setFavListOpen] = useState(false);
  const [marketExpanded, setMarketExpanded] = useState(new Set(["nikkei"]));

  const toggleFav = (code) => setFavorites(prev => { const n = new Set(prev); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  const toggleExpand = (code) => setExpandedCards(prev => { const n = new Set(prev); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  const toggleMarketExpand = (key) => setMarketExpanded(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const favStocks = useMemo(() => allStocks.filter(s => favorites.has(s.code)), [allStocks, favorites]);
  const analyses = useMemo(() => { const m = {}; favStocks.forEach(s => { m[s.code] = analyzeStock(s); }); return m; }, [favStocks]);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearchError("");
    setSearchLoading(true);
    const q = searchQuery.trim();
    const qLower = q.toLowerCase();

    // Yahoo Finance APIでリアルタイムデータ取得を試みる
    const result = await fetchYahooStock(q);
    if (result && result.price > 0) {
      // ローカルにある銘柄ならニュース・決算を保持しつつ株価を更新
      const local = allStocks.find(s => s.code.toLowerCase() === result.code.toLowerCase());
      if (local) {
        setAllStocks(prev => prev.map(s =>
          s.code.toLowerCase() === result.code.toLowerCase()
            ? { ...result, news: s.news || [], earnings: s.earnings || null, sector: result.sector || s.sector }
            : s
        ));
        setFavorites(prev => new Set(prev).add(local.code));
      } else {
        setAllStocks(prev => [...prev, result]);
        setFavorites(prev => new Set(prev).add(result.code));
      }
      setSearchQuery("");
      setSearchLoading(false);
      return;
    }

    // APIが失敗した場合、ローカルデータで探す（フォールバック）
    const local = allStocks.find(s =>
      s.code.toLowerCase() === qLower ||
      s.name.toLowerCase().includes(qLower) ||
      s.sector.toLowerCase().includes(qLower)
    );
    if (local) {
      setFavorites(prev => new Set(prev).add(local.code));
      setSearchQuery("");
    } else {
      setSearchError(`「${q}」のデータを取得できませんでした。ティッカー（例: AAPL）または証券コード（例: 7203）を確認してください。`);
    }
    setSearchLoading(false);
  }, [searchQuery, allStocks]);

  const tabs = [
    { key: "watch", label: "ウォッチ" },
    { key: "review", label: "デイリーレビュー" },
    { key: "market", label: "マーケット" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(170deg, #060b18 0%, #0d1328 50%, #080e1f 100%)", color: "#e2e8f0", fontFamily: "'Helvetica Neue', 'Noto Sans JP', -apple-system, sans-serif" }}>

      {/* ===== ヘッダー ===== */}
      <header style={{ padding: "14px 16px 12px", background: "rgba(8,12,28,0.95)", backdropFilter: "blur(20px)", borderBottom: "1px solid rgba(148,163,184,0.06)", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h1 style={{ fontSize: 17, fontWeight: 900, color: "#f1f5f9", margin: 0 }}>Stock Intelligence</h1>
          <span style={{ fontSize: 10, color: "#475569" }}>{new Date().toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" })}</span>
        </div>

        {/* タブ */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {tabs.map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
              padding: "8px 18px", borderRadius: 20,
              border: activeTab === tab.key ? "1.5px solid #38bdf8" : "1.5px solid rgba(148,163,184,0.15)",
              background: activeTab === tab.key ? "rgba(56,189,248,0.08)" : "transparent",
              color: activeTab === tab.key ? "#38bdf8" : "#64748b",
              fontSize: 12, fontWeight: 700, cursor: "pointer", transition: "all 0.2s",
            }}>{tab.label}</button>
          ))}
        </div>

        {/* 検索バー */}
        {(activeTab === "watch" || activeTab === "review") && (
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1, position: "relative" }}>
              <input
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setSearchError(""); }}
                onKeyDown={e => e.key === "Enter" && handleSearch()}
                placeholder="ティッカー / 証券コード（例: AAPL, 7203）"
                style={{
                  width: "100%", padding: "10px 14px", borderRadius: 10, boxSizing: "border-box",
                  background: "rgba(22,30,52,0.6)", border: "1px solid rgba(148,163,184,0.12)",
                  color: "#e2e8f0", fontSize: 13, outline: "none",
                }}
              />
            </div>
            <button onClick={handleSearch} disabled={searchLoading} style={{
              padding: "10px 20px", borderRadius: 10, border: "none",
              background: searchLoading ? "rgba(56,189,248,0.3)" : "linear-gradient(135deg, #0ea5e9, #38bdf8)",
              color: "#fff", fontSize: 13, fontWeight: 700, cursor: searchLoading ? "wait" : "pointer",
              flexShrink: 0,
            }}>{searchLoading ? "取得中..." : "追加"}</button>
          </div>
        )}
        {searchError && <div style={{ marginTop: 6, fontSize: 11, color: "#f87171" }}>{searchError}</div>}
      </header>

      {/* ===== ウォッチタブ ===== */}
      {activeTab === "watch" && (
        <div style={{ padding: "12px 12px 100px" }}>
          {/* 登録銘柄管理 */}
          <button onClick={() => setFavListOpen(!favListOpen)} style={{
            width: "100%", padding: "10px 16px", borderRadius: 10, marginBottom: 10,
            border: "1px solid rgba(148,163,184,0.1)",
            background: favListOpen ? "rgba(99,102,241,0.1)" : "rgba(22,30,52,0.4)",
            color: "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span>★ 登録銘柄 ({favorites.size})</span>
            <span style={{ fontSize: 10 }}>{favListOpen ? "▲ 閉じる" : "▼ 編集"}</span>
          </button>

          {favListOpen && (
            <div style={{ padding: 12, borderRadius: 12, background: "rgba(22,30,52,0.6)", border: "1px solid rgba(148,163,184,0.08)", marginBottom: 12, maxHeight: 280, overflowY: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 10, color: "#475569" }}>タップで登録 / 解除</span>
                <button onClick={async () => {
                  setSearchLoading(true);
                  for (const stock of favStocks) {
                    const result = await fetchYahooStock(stock.code);
                    if (result && result.price > 0) {
                      setAllStocks(prev => prev.map(s =>
                        s.code === stock.code
                          ? { ...result, news: s.news || [], earnings: s.earnings || null, sector: result.sector || s.sector }
                          : s
                      ));
                    }
                  }
                  setSearchLoading(false);
                }} disabled={searchLoading} style={{
                  padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(56,189,248,0.3)",
                  background: searchLoading ? "rgba(56,189,248,0.1)" : "rgba(56,189,248,0.15)",
                  color: "#38bdf8", fontSize: 10, fontWeight: 700, cursor: searchLoading ? "wait" : "pointer",
                }}>{searchLoading ? "更新中..." : "🔄 全銘柄を最新データに更新"}</button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {allStocks.map(stock => {
                  const isFav = favorites.has(stock.code);
                  return (
                    <button key={stock.code} onClick={() => toggleFav(stock.code)} style={{
                      padding: "6px 12px", borderRadius: 8, border: "1px solid",
                      borderColor: isFav ? "#6366f1" : "rgba(148,163,184,0.1)",
                      background: isFav ? "rgba(99,102,241,0.15)" : "rgba(15,20,35,0.5)",
                      color: isFav ? "#e2e8f0" : "#64748b",
                      fontSize: 11, fontWeight: 600, cursor: "pointer",
                      display: "flex", alignItems: "center", gap: 4,
                    }}>
                      <span style={{ color: isFav ? "#fbbf24" : "#475569", fontSize: 10 }}>{isFav ? "★" : "☆"}</span>
                      {stock.code}
                      <span style={{ color: "#475569", fontSize: 10 }}>{stock.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 銘柄一覧 */}
          {favStocks.length === 0 && (
            <div style={{ textAlign: "center", padding: 60, color: "#475569" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>☆</div>
              <div style={{ fontSize: 13 }}>上の検索バーから銘柄を追加してください</div>
            </div>
          )}
          {favStocks.map(stock => (
            <StockCard
              key={stock.code} stock={stock} analysis={analyses[stock.code] || analyzeStock(stock)}
              isFav={favorites.has(stock.code)} onToggleFav={() => toggleFav(stock.code)}
              expanded={expandedCards.has(stock.code)} onToggleExpand={() => toggleExpand(stock.code)}
            />
          ))}
        </div>
      )}

      {/* ===== デイリーレビュータブ ===== */}
      {activeTab === "review" && (
        <div style={{ padding: "12px 12px 100px" }}>
          <div style={{ background: "rgba(16,22,40,0.8)", borderRadius: 14, padding: "16px 18px", marginBottom: 14, border: "1px solid rgba(148,163,184,0.06)" }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#f1f5f9", marginBottom: 4 }}>📊 本日のサマリー</div>
            <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.7 }}>
              登録 {favorites.size} 銘柄のうち、翌日予想が「買い」判定: {favStocks.filter(s => analyses[s.code]?.daily.direction === "買い").length} 銘柄、
              「中立」: {favStocks.filter(s => analyses[s.code]?.daily.direction === "中立").length} 銘柄、
              「売り」: {favStocks.filter(s => analyses[s.code]?.daily.direction === "売り").length} 銘柄
            </div>
          </div>

          {/* 各銘柄のコンパクトレビュー */}
          {favStocks.map(stock => {
            const a = analyses[stock.code];
            if (!a) return null;
            const isExpanded = expandedCards.has(`review-${stock.code}`);
            return (
              <div key={stock.code} style={{ background: "rgba(16,22,40,0.8)", borderRadius: 14, marginBottom: 10, border: "1px solid rgba(148,163,184,0.06)", overflow: "hidden" }}>
                <div onClick={() => toggleExpand(`review-${stock.code}`)} style={{ padding: "14px 18px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 15, fontWeight: 800, color: "#f1f5f9" }}>{stock.code}</span>
                        <span style={{ fontSize: 11, color: "#64748b" }}>{stock.name}</span>
                      </div>
                      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                        {[
                          { label: "日", s: a.daily },
                          { label: "週", s: a.weekly },
                          { label: "月", s: a.monthly },
                        ].map(p => {
                          const c = p.s.direction === "買い" ? "#4ade80" : p.s.direction === "売り" ? "#f87171" : "#eab308";
                          return (
                            <span key={p.label} style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: `${c}18`, color: c }}>
                              {p.label}: {p.s.direction}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "#f1f5f9" }}>{stock.currency}{stock.price.toLocaleString()}</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: stock.change >= 0 ? "#4ade80" : "#f87171" }}>
                      {stock.change >= 0 ? "+" : ""}{stock.change.toFixed(2)}%
                    </div>
                  </div>
                </div>
                {isExpanded && (
                  <div style={{ padding: "0 18px 16px", borderTop: "1px solid rgba(148,163,184,0.06)" }}>
                    <PredictionCard label="翌日 予想" dot="#3b82f6" data={a.daily} />
                    <PredictionCard label="翌週 予想" dot="#f59e0b" data={a.weekly} />
                    <PredictionCard label="今月 予想" dot="#a855f7" data={a.monthly} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ===== マーケットタブ ===== */}
      {activeTab === "market" && (
        <div style={{ padding: "12px 12px 100px" }}>
          {/* 指標サマリー */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
            {Object.entries(MARKET_INDICES).map(([key, idx]) => (
              <div key={key} onClick={() => toggleMarketExpand(key)} style={{
                background: marketExpanded.has(key) ? "rgba(56,189,248,0.06)" : "rgba(16,22,40,0.8)",
                borderRadius: 12, padding: "14px 16px", cursor: "pointer",
                border: `1px solid ${marketExpanded.has(key) ? "rgba(56,189,248,0.2)" : "rgba(148,163,184,0.06)"}`,
                transition: "all 0.2s",
              }}>
                <div style={{ fontSize: 10, color: "#475569", marginBottom: 2 }}>{idx.name}</div>
                <div style={{ fontSize: 18, fontWeight: 900, color: "#f1f5f9", fontVariantNumeric: "tabular-nums" }}>
                  {idx.value.toLocaleString()}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: idx.change >= 0 ? "#4ade80" : "#f87171" }}>
                    {idx.change >= 0 ? "+" : ""}{idx.change}%
                  </span>
                  <span style={{ fontSize: 10, color: "#64748b" }}>
                    YTD {idx.ytd >= 0 ? "+" : ""}{idx.ytd}%
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* 詳細分析 */}
          {Object.entries(MARKET_INDICES).map(([key, idx]) => {
            const ma = MARKET_ANALYSIS[key];
            if (!ma || !marketExpanded.has(key)) return null;
            const sentColor = ma.sentiment >= 65 ? "#22c55e" : ma.sentiment >= 50 ? "#4ade80" : ma.sentiment >= 40 ? "#eab308" : "#ef4444";
            const sentLabel = ma.sentiment >= 65 ? "強気" : ma.sentiment >= 50 ? "やや強気" : ma.sentiment >= 40 ? "やや弱気" : "弱気";

            return (
              <div key={key} style={{ background: "rgba(16,22,40,0.8)", borderRadius: 14, marginBottom: 12, border: "1px solid rgba(148,163,184,0.06)", overflow: "hidden" }}>
                <div style={{ padding: "18px 18px 0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 900, color: "#f1f5f9" }}>{idx.name}</div>
                      <div style={{ fontSize: 11, color: "#64748b" }}>52週: {idx.low52w.toLocaleString()} 〜 {idx.high52w.toLocaleString()}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 40, height: 6, borderRadius: 3, background: "rgba(148,163,184,0.1)", overflow: "hidden" }}>
                        <div style={{ width: `${ma.sentiment}%`, height: "100%", borderRadius: 3, background: sentColor }} />
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: sentColor }}>{sentLabel} {ma.sentiment}%</span>
                    </div>
                  </div>
                </div>

                {/* 分析セクション */}
                {[
                  { title: "📊 サマリー", content: ma.summary },
                  { title: "📈 テクニカル", content: ma.technical },
                  { title: "🔍 注目材料", content: ma.drivers },
                  { title: "🔮 見通し", content: ma.outlook },
                ].map(section => (
                  <div key={section.title} style={{ padding: "0 18px", marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", marginBottom: 6, letterSpacing: "0.04em" }}>{section.title}</div>
                    <div style={{ background: "rgba(15,20,35,0.7)", borderRadius: 10, padding: "12px 14px", border: "1px solid rgba(148,163,184,0.04)" }}>
                      <p style={{ fontSize: 13, lineHeight: 1.75, color: "#c8d0dc", margin: 0 }}>{section.content}</p>
                    </div>
                  </div>
                ))}

                {/* 注目イベント */}
                <div style={{ padding: "0 18px 18px" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", marginBottom: 6 }}>📅 注目イベント</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {ma.keyEvents.map((ev, i) => (
                      <span key={i} style={{
                        padding: "5px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600,
                        background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.15)",
                        color: "#7dd3fc",
                      }}>{ev}</span>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}

          {/* 免責 */}
          <div style={{ padding: "14px 16px", borderRadius: 12, background: "rgba(16,22,40,0.5)", border: "1px solid rgba(148,163,184,0.04)" }}>
            <p style={{ fontSize: 10, color: "#374151", margin: 0, lineHeight: 1.7 }}>
              ⚠️ 本レポートはサンプルデータに基づくデモです。実際の投資判断はご自身の責任で行ってください。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
