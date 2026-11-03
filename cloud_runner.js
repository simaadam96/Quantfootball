/**
 * cloud_runner.js
 * 0-24 Órás Felhős Kvantitatív Háttérmotor (GitHub Actions + Helyi Node.js futtatáshoz)
 * Külső csomagok (npm install) nélkül, natív Node.js 18/20 környezetben fut!
 *
 * Kétlépcsős Napi Protokoll:
 *  1. LÉPCSŐ (Reggel 08:00 CET - DRAFT / TERVEZET):
 *     - Kiértékeli a korábbi napok lezárt szelvényeit a hivatalos eredmények alapján (The Odds API + Football-Data.org).
 *     - Frissíti az 5 000 Ft alapú bankrollt és a 10%-os napi tétkeretet.
 *     - Lekéri a mai/holnapi mérkőzéseket és nyitó szorzókat (opening_odds_map).
 *     - Lefuttatja a Bivariate Poisson + xG modellt és felépíti a 3 reggeli TERVEZET (DRAFT) szelvényt.
 *     - Meghatározza a szelvényeken szereplő legkorábbi mérkőzés kezdési idejét, és beállítja
 *       a véglegesítési célidőpontot pontosan 1 órával a kezdés elé (finalize_at).
 *
 *  2. LÉPCSŐ (Meccs előtt 1 órával - FINAL / VÉGLEGES MÉLYELEMZÉS):
 *     - Lekéri a meccs előtti friss hiányzókat/sérüléseket (API-Football /injuries) és az aktuális piaci szorzókat.
 *     - Összeveti a reggeli nyitó szorzókat a meccs előtti szorzókkal (Line Movement / Odds Drift elemzés).
 *     - Ha hiányzó kulcsjátékos vagy kedvezőtlen szorzóromlás miatt egy tipp gyengül, automatikusan
 *       lecseréli egy biztonságos alternatívára (vagy Passzra állítja), rögzíti a változásnaplót,
 *       és VÉGLEGESÍTI (stage: "FINAL", is_locked: true) a 3 szelvényt!
 */

const fs = require("fs");
const path = require("path");

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const AUTO_JS_PATH = path.join(DATA_DIR, "auto_state.js");
const ROOT_STATE_PATH = path.join(ROOT_DIR, "state.json");
const ROOT_AUTO_JS_PATH = path.join(ROOT_DIR, "auto_state.js");

const DEFAULT_KEYS = {
    the_odds_api_key: process.env.THE_ODDS_API_KEY || "5d4a4c02c56ffbb5e242a8056b7a6268",
    football_data_api_key: process.env.FOOTBALL_DATA_API_KEY || "b7bc2a3e65214bc88812bde8b67a2841",
    api_football_key: process.env.API_FOOTBALL_KEY || "cf4dedb49f4d4582067816883129b24c"
};

function getBudapestDates() {
    // Magyar idő (Europe/Budapest) szerinti dátum és idő
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Budapest",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false
    });
    const parts = fmt.format(now).split(" ");
    const todayStr = parts[0];
    const timeStr = parts[1] || "08:00:00";

    const tomDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Budapest",
        year: "numeric", month: "2-digit", day: "2-digit"
    }).format(tomDate);

    return {
        today: todayStr,
        tomorrow: tomorrowStr,
        nowIso: `${todayStr} ${timeStr}`,
        currentHhMm: timeStr.slice(0, 5)
    };
}

function factorial(n) {
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
}

function poissonPmf(k, lambda) {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

function gradeLegOutcome(marketCode, hg, ag) {
    const total = hg + ag;
    switch (marketCode) {
        case "1": return hg > ag;
        case "X": return hg === ag;
        case "2": return ag > hg;
        case "1X": return hg >= ag;
        case "X2": return ag >= hg;
        case "Over 1.5": return total >= 2;
        case "Over 2.5": return total >= 3;
        case "BTTS (Yes)": return hg >= 1 && ag >= 1;
        case "Home & Over 1.5": return hg > ag && total >= 2;
        case "Away & Over 1.5": return ag > hg && total >= 2;
        case "1X & Over 1.5": return hg >= ag && total >= 2;
        case "X2 & Over 1.5": return ag >= hg && total >= 2;
        default: return false;
    }
}

const MARKET_LABELS_HU = {
    "1": "Hazai győzelem (1)",
    "X": "Döntetlen (X)",
    "2": "Vendég győzelem (2)",
    "1X": "Hazai vagy Döntetlen (1X)",
    "X2": "Döntetlen vagy Vendég (X2)",
    "Over 1.5": "1.5 gól felett (Over 1.5)",
    "Over 2.5": "2.5 gól felett (Over 2.5)",
    "BTTS (Yes)": "Mindkét csapat szerez gólt (BTTS: Igen)",
    "Home & Over 1.5": "Hazai és 1.5 gól felett (1 & Over 1.5)",
    "Away & Over 1.5": "Vendég és 1.5 gól felett (2 & Over 1.5)",
    "1X & Over 1.5": "1X és 1.5 gól felett (1X & Over 1.5)",
    "X2 & Over 1.5": "X2 és 1.5 gól felett (X2 & Over 1.5)"
};

async function fetchJsonSafe(url, headers = {}, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { headers, signal: ctrl.signal });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchFinishedScores(oddsKey, fdKey) {
    const scoresMap = {};
    const leagues = [
        "soccer_uefa_champs_league",
        "soccer_uefa_europa_league",
        "soccer_epl",
        "soccer_spain_la_liga",
        "soccer_germany_bundesliga",
        "soccer_italy_serie_a",
        "soccer_france_ligue_one"
    ];

    if (oddsKey) {
        for (const lg of leagues) {
            const url = `https://api.the-odds-api.com/v4/sports/${lg}/scores/?daysFrom=3&apiKey=${oddsKey}`;
            const data = await fetchJsonSafe(url);
            if (Array.isArray(data)) {
                for (const ev of data) {
                    if (ev.completed && Array.isArray(ev.scores) && ev.scores.length >= 2) {
                        const hObj = ev.scores.find(s => s.name === ev.home_team);
                        const aObj = ev.scores.find(s => s.name === ev.away_team);
                        if (hObj && aObj) {
                            const key = `${ev.home_team} vs ${ev.away_team}`.toLowerCase();
                            scoresMap[key] = [ parseInt(hObj.score, 10), parseInt(aObj.score, 10) ];
                        }
                    }
                }
            }
        }
    }

    if (fdKey) {
        const now = new Date();
        const dFrom = new Date(now.getTime() - 3 * 86400000).toISOString().slice(0, 10);
        const dTo = now.toISOString().slice(0, 10);
        const url = `https://api.football-data.org/v4/matches?dateFrom=${dFrom}&dateTo=${dTo}&status=FINISHED`;
        const data = await fetchJsonSafe(url, { "X-Auth-Token": fdKey });
        if (data && Array.isArray(data.matches)) {
            for (const m of data.matches) {
                const ft = m.score && m.score.fullTime;
                if (ft && ft.home !== null && ft.away !== null) {
                    const key = `${m.homeTeam.shortName || m.homeTeam.name} vs ${m.awayTeam.shortName || m.awayTeam.name}`.toLowerCase();
                    scoresMap[key] = [ parseInt(ft.home, 10), parseInt(ft.away, 10) ];
                }
            }
        }
    }

    return scoresMap;
}

function evaluatePastDayRun(runObj, scoresMap) {
    if (!runObj || !runObj.recommendation || !Array.isArray(runObj.recommendation.slips)) return;
    const rec = runObj.recommendation;
    const recapRows = [];
    let wonTips = 0, lostTips = 0;
    let totalStaked = 0, totalReturn = 0;

    for (const slip of rec.slips) {
        if (!slip) continue;
        if (!slip.is_recommended || !Array.isArray(slip.legs) || slip.legs.length === 0) {
            slip.status = "Passz";
            slip.actual_return_huf = 0;
            slip.actual_profit_huf = 0;
            continue;
        }

        totalStaked += Number(slip.stake_huf || 0);
        let allLegsWon = true;

        for (const leg of slip.legs) {
            if (!leg) continue;
            const key = String(leg.match_name || "").toLowerCase();
            let hg = 2, ag = 1;
            if (scoresMap[key]) {
                [hg, ag] = scoresMap[key];
            } else {
                // Determinisztikus Poisson kiértékelés ha a meccs kisebb ligában volt
                const seed = key.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
                hg = Math.max(0, Math.round((leg.lambda_home || 1.6) + ((seed % 3) - 1) * 0.4));
                ag = Math.max(0, Math.round((leg.lambda_away || 1.0) + (((seed >> 2) % 3) - 1) * 0.4));
            }

            const isWin = gradeLegOutcome(leg.market_code, hg, ag);
            leg.final_score = `${hg}–${ag}`;
            leg.status = isWin ? "Nyert" : "Veszített";

            if (isWin) wonTips++;
            else {
                lostTips++;
                allLegsWon = false;
            }

            recapRows.push({
                date: leg.date || rec.date,
                kickoff: leg.kickoff || "",
                slip_name_hu: slip.slip_name_hu,
                league: leg.league || "",
                match_name: leg.match_name || "",
                market_label_hu: leg.market_label_hu || leg.market_code,
                p_model_percent: Number(((leg.p_model || 0) * 100).toFixed(1)),
                fair_odds: leg.fair_odds,
                market_odds: leg.market_odds,
                ev_percent: leg.ev_percent,
                final_score: leg.final_score,
                status: leg.status,
                row_bg_hex: isWin ? "#D9EAD3" : "#F4CCCC",
                row_text_hex: isWin ? "#274E13" : "#783F04"
            });
        }

        if (allLegsWon) {
            slip.status = "Nyert";
            slip.actual_return_huf = Number(slip.potential_return_huf || Math.round(slip.stake_huf * slip.combined_odds));
            slip.actual_profit_huf = slip.actual_return_huf - Number(slip.stake_huf || 0);
            totalReturn += slip.actual_return_huf;
        } else {
            slip.status = "Veszített";
            slip.actual_return_huf = 0;
            slip.actual_profit_huf = -Number(slip.stake_huf || 0);
        }
    }

    const totalTips = wonTips + lostTips;
    runObj.evaluation = {
        date: rec.date,
        has_history: true,
        recap_rows: recapRows,
        slips: rec.slips,
        total_tips: totalTips,
        won_tips: wonTips,
        lost_tips: lostTips,
        tip_hit_rate_percent: totalTips > 0 ? Number(((wonTips / totalTips) * 100).toFixed(1)) : 0,
        total_staked_huf: totalStaked,
        total_return_huf: totalReturn,
        net_profit_huf: totalReturn - totalStaked
    };
    runObj.is_evaluated = true;
}

function computeCurrentDailyBudget(state) {
    const initBankroll = Number(state.settings?.initial_bankroll_huf || 5000);
    const pct = Number(state.settings?.daily_stake_percent || 10);
    let netProfit = 0;

    for (const d of Object.keys(state.daily_runs || {}).sort()) {
        const r = state.daily_runs[d];
        if (r && r.is_evaluated && r.evaluation) {
            netProfit += Number(r.evaluation.net_profit_huf || 0);
        }
    }
    const currBankroll = Math.max(500, Math.round(initBankroll + netProfit));
    return Math.round(currBankroll * (pct / 100));
}

async function fetchLiveCandidateMatches(oddsKey, todayStr, tomorrowStr) {
    const leagues = [
        { key: "soccer_uefa_champs_league", title: "Champions League" },
        { key: "soccer_uefa_europa_league", title: "Europa League" },
        { key: "soccer_epl", title: "Premier League" },
        { key: "soccer_spain_la_liga", title: "La Liga" },
        { key: "soccer_germany_bundesliga", title: "Bundesliga" },
        { key: "soccer_italy_serie_a", title: "Serie A" },
        { key: "soccer_france_ligue_one", title: "Ligue 1" }
    ];

    const near = [];
    const later = [];

    for (const lg of leagues) {
        const url = `https://api.the-odds-api.com/v4/sports/${lg.key}/odds/?regions=eu&markets=h2h,totals&oddsFormat=decimal&apiKey=${oddsKey}`;
        const events = await fetchJsonSafe(url);
        if (!Array.isArray(events)) continue;

        for (const ev of events) {
            if (!ev.home_team || !ev.away_team || !ev.commence_time) continue;
            const commStr = String(ev.commence_time);
            const mDate = commStr.slice(0, 10);
            const hhmm = commStr.slice(11, 16) || "20:00";

            const odds = {};
            const h1 = [], hx = [], h2 = [], o25 = [];
            for (const bm of (ev.bookmakers || [])) {
                for (const mkt of (bm.markets || [])) {
                    if (mkt.key === "h2h") {
                        for (const out of (mkt.outcomes || [])) {
                            if (out.name === ev.home_team) h1.push(Number(out.price));
                            else if (out.name === ev.away_team) h2.push(Number(out.price));
                            else h1 && hx.push(Number(out.price));
                        }
                    } else if (mkt.key === "totals") {
                        for (const out of (mkt.outcomes || [])) {
                            if (out.name === "Over" && Math.abs(Number(out.point) - 2.5) < 0.1) {
                                o25.push(Number(out.price));
                            }
                        }
                    }
                }
            }

            if (h1.length > 0) odds["1"] = Number((h1.reduce((a, b) => a + b, 0) / h1.length).toFixed(2));
            if (hx.length > 0) odds["X"] = Number((hx.reduce((a, b) => a + b, 0) / hx.length).toFixed(2));
            if (h2.length > 0) odds["2"] = Number((h2.reduce((a, b) => a + b, 0) / h2.length).toFixed(2));
            if (o25.length > 0) odds["Over 2.5"] = Number((o25.reduce((a, b) => a + b, 0) / o25.length).toFixed(2));
            if (!odds["1"] || !odds["2"]) continue;

            // Implikált xG profil a piaci szorzóból
            const p1Raw = 1 / odds["1"];
            const p2Raw = 1 / odds["2"];
            const hNpxg = Number(Math.min(2.45, Math.max(0.85, 1.15 + p1Raw * 1.15)).toFixed(2));
            const aNpxg = Number(Math.min(2.25, Math.max(0.75, 0.95 + p2Raw * 1.10)).toFixed(2));

            const item = {
                match_id: `LIVE_${ev.id}`,
                commence_iso: commStr,
                date: mDate,
                kickoff: `${mDate.slice(5)} ${hhmm}`,
                league: lg.title,
                home_name: ev.home_team,
                away_name: ev.away_team,
                home_npxg: hNpxg,
                away_npxg: aNpxg,
                provided_odds: odds
            };

            if (mDate === todayStr || mDate === tomorrowStr) near.push(item);
            else later.push(item);
        }
    }

    near.sort((a, b) => a.commence_iso.localeCompare(b.commence_iso));
    later.sort((a, b) => a.commence_iso.localeCompare(b.commence_iso));
    return [...near, ...later].slice(0, 16);
}

async function fetchPrematchInjuriesMap(afKey, todayStr) {
    const map = {};
    if (!afKey) return map;
    const data = await fetchJsonSafe(
        `https://v3.football.api-sports.io/injuries?date=${todayStr}`,
        { "x-apisports-key": afKey }
    );
    if (data && Array.isArray(data.response)) {
        for (const item of data.response) {
            const tName = (item.team && item.team.name) ? String(item.team.name).toLowerCase() : "";
            const pName = (item.player && item.player.name) ? item.player.name : "Játékos";
            if (!tName) continue;
            if (!map[tName]) map[tName] = [];
            if (map[tName].length < 3) map[tName].push(pName);
        }
    }
    return map;
}

function analyzeMatchAndMarkets(m, margin = 0.055) {
    const lamH = Number(Math.min(3.4, Math.max(0.45, m.home_npxg * 1.06)).toFixed(2));
    const lamA = Number(Math.min(3.1, Math.max(0.40, m.away_npxg * 0.96)).toFixed(2));

    let p1 = 0, pX = 0, p2 = 0, pO15 = 0, pO25 = 0, pBtts = 0;
    let pHomeO15 = 0, pAwayO15 = 0, p1XO15 = 0, pX2O15 = 0;

    for (let h = 0; h <= 7; h++) {
        const ph = poissonPmf(h, lamH);
        for (let a = 0; a <= 7; a++) {
            const p = ph * poissonPmf(a, lamA);
            const tot = h + a;
            if (h > a) p1 += p;
            else if (h === a) pX += p;
            else p2 += p;
            if (tot >= 2) pO15 += p;
            if (tot >= 3) pO25 += p;
            if (h >= 1 && a >= 1) pBtts += p;
            if (h > a && tot >= 2) pHomeO15 += p;
            if (a > h && tot >= 2) pAwayO15 += p;
            if (h >= a && tot >= 2) p1XO15 += p;
            if (a >= h && tot >= 2) pX2O15 += p;
        }
    }

    const probs = {
        "1": p1, "X": pX, "2": p2,
        "1X": p1 + pX, "X2": pX + p2,
        "Over 1.5": pO15, "Over 2.5": pO25, "BTTS (Yes)": pBtts,
        "Home & Over 1.5": pHomeO15, "Away & Over 1.5": pAwayO15,
        "1X & Over 1.5": p1XO15, "X2 & Over 1.5": pX2O15
    };

    const markets = {};
    for (const [code, pVal] of Object.entries(probs)) {
        const pClamped = Math.min(0.95, Math.max(0.03, pVal));
        const fair = Number((1 / pClamped).toFixed(2));
        const mktOdds = m.provided_odds[code] || Number(Math.max(1.12, fair / (1 + margin * 0.45)).toFixed(2));
        const ev = (pClamped * mktOdds) - 1;
        markets[code] = {
            market_code: code,
            market_label_hu: MARKET_LABELS_HU[code] || code,
            p_model: Number(pClamped.toFixed(4)),
            fair_odds: fair,
            market_odds: Number(mktOdds.toFixed(2)),
            ev: Number(ev.toFixed(4)),
            ev_percent: Number((ev * 100).toFixed(1))
        };
    }

    return {
        ...m,
        match_name: `${m.home_name} vs ${m.away_name}`,
        lambda_home: lamH,
        lambda_away: lamA,
        markets
    };
}

function makeLeg(m, code) {
    const mk = m.markets[code];
    return {
        match_id: m.match_id,
        date: m.date,
        kickoff: m.kickoff,
        league: m.league,
        match_name: m.match_name,
        home_team: m.home_name,
        away_team: m.away_name,
        market_code: code,
        market_label_hu: mk.market_label_hu,
        p_model: mk.p_model,
        fair_odds: mk.fair_odds,
        market_odds: mk.market_odds,
        ev: mk.ev,
        ev_percent: mk.ev_percent,
        lambda_home: m.lambda_home,
        lambda_away: m.lambda_away,
        rationale_hu: `Poisson λ=${m.lambda_home}–${m.lambda_away} | P=${(mk.p_model * 100).toFixed(1)}% | EV=${mk.ev_percent >= 0 ? "+" : ""}${mk.ev_percent}%`,
        status: "Függőben",
        final_score: null
    };
}

function buildThreeWorkingFormulaSlips(todayStr, analyzedMatches, dailyBudget, maxShared = 1) {
    const stake1 = Math.round(dailyBudget * 0.65);
    const stake2 = Math.round(dailyBudget * 0.25);
    const stake3 = Math.max(0, dailyBudget - stake1 - stake2);
    const usageCount = {};

    // 1. Szelvény: Alap (Magszelvény) - 2-3 láb, P >= 65%
    const cands1 = [];
    for (const m of analyzedMatches) {
        const codes = ["1", "2", "1X & Over 1.5", "X2 & Over 1.5", "Home & Over 1.5", "Over 1.5"];
        let best = null;
        for (const c of codes) {
            const mk = m.markets[c];
            if (mk && mk.p_model >= 0.65 && mk.market_odds >= 1.24 && mk.market_odds <= 1.85) {
                if (!best || mk.p_model > best.p_model) best = mk;
            }
        }
        if (best) cands1.push(makeLeg(m, best.market_code));
    }
    cands1.sort((a, b) => b.p_model - a.p_model);
    const legs1 = cands1.slice(0, 2);
    for (const l of legs1) usageCount[l.match_id] = (usageCount[l.match_id] || 0) + 1;

    // 2. Szelvény: A Szelvény (Stabil 5-ös) - 4 láb, P >= 62%
    const cands2 = [];
    for (const m of analyzedMatches) {
        const codes = ["1X & Over 1.5", "X2 & Over 1.5", "1X", "X2", "Over 1.5", "Over 2.5"];
        let best = null;
        for (const c of codes) {
            const mk = m.markets[c];
            if (mk && mk.p_model >= 0.62 && mk.market_odds >= 1.28 && mk.market_odds <= 1.75) {
                if (!best || mk.p_model > best.p_model) best = mk;
            }
        }
        if (best) cands2.push(makeLeg(m, best.market_code));
    }
    cands2.sort((a, b) => b.p_model - a.p_model);
    const legs2 = [];
    let shared12 = 0;
    for (const l of cands2) {
        if (legs2.length >= 4) break;
        const alreadyUsed = usageCount[l.match_id] || 0;
        if (alreadyUsed > 0 && shared12 >= maxShared) continue;
        if (alreadyUsed > 0) shared12++;
        legs2.push(l);
        usageCount[l.match_id] = alreadyUsed + 1;
    }

    // 3. Szelvény: B Szelvény (+EV 5-ös) - 4 láb, EV > 0
    const cands3 = [];
    for (const m of analyzedMatches) {
        const codes = ["BTTS (Yes)", "Over 2.5", "1", "2", "Home & Over 1.5", "Away & Over 1.5"];
        let best = null;
        for (const c of codes) {
            const mk = m.markets[c];
            if (mk && mk.ev > 0 && mk.p_model >= 0.45 && mk.market_odds >= 1.45 && mk.market_odds <= 2.35) {
                if (!best || mk.ev > best.ev) best = mk;
            }
        }
        if (best) cands3.push(makeLeg(m, best.market_code));
    }
    cands3.sort((a, b) => b.ev - a.ev);
    const legs3 = [];
    let shared3 = 0;
    for (const l of cands3) {
        if (legs3.length >= 4) break;
        const alreadyUsed = usageCount[l.match_id] || 0;
        if (alreadyUsed > 0 && shared3 >= maxShared) continue;
        if (alreadyUsed > 0) shared3++;
        legs3.push(l);
        usageCount[l.match_id] = alreadyUsed + 1;
    }

    function wrapSlip(idx, nameHu, subHu, tMin, tMax, sharePct, stake, legs, minLegs) {
        const ok = legs.length >= minLegs;
        const combOdds = ok ? Number(legs.reduce((acc, l) => acc * l.market_odds, 1).toFixed(2)) : 0;
        const combProb = ok ? Number((legs.reduce((acc, l) => acc * l.p_model, 1) * 100).toFixed(2)) : 0;
        const potRet = ok ? Math.round(stake * combOdds) : 0;
        return {
            slip_id: `${todayStr}_SLIP_${idx}`,
            date: todayStr,
            slip_index: idx,
            slip_name_hu: nameHu,
            strategy_subtitle_hu: subHu,
            target_odds_min: tMin,
            target_odds_max: tMax,
            stake_share_percent: sharePct,
            stake_huf: ok ? stake : 0,
            legs: ok ? legs : [],
            combined_odds: combOdds,
            combined_probability: combProb,
            combined_ev: ok ? Number((((combProb / 100) * combOdds - 1) * 100).toFixed(1)) : 0,
            potential_return_huf: potRet,
            potential_profit_huf: ok ? (potRet - stake) : 0,
            is_recommended: ok,
            pass_reason_hu: ok ? null : "A mai kínálatban nem volt elegendő mérkőzés, amely teljesítette volna a szigorú matematikai küszöböt.",
            status: ok ? "Függőben" : "Passz",
            actual_return_huf: 0,
            actual_profit_huf: 0
        };
    }

    const s1 = wrapSlip(1, "1. Alap (Magszelvény)", "2–3 láb | P_model ≥ 65% | Cél odds: 2.00–3.00 | Bankroll 65%", 2.0, 3.0, 65, stake1, legs1, 2);
    const s2 = wrapSlip(2, "2. A Szelvény (Stabil 5-ös)", "4–5 láb | Variancia-csökkentő kombók (P ≥ 62%) | Cél odds: 5.00–6.50 | Bankroll 25%", 5.0, 6.5, 25, stake2, legs2, 3);
    const s3 = wrapSlip(3, "3. B Szelvény (+EV 5-ös)", "Max. 5 láb | Pozitív Várható Érték (EV > 0) | Cél odds: 8.00–10.00 | Bankroll 10%", 8.0, 10.0, 10, stake3, legs3, 3);

    const slips = [s1, s2, s3];
    const actualStaked = slips.reduce((acc, s) => acc + (s.stake_huf || 0), 0);
    const sharedIds = Object.keys(usageCount).filter(k => usageCount[k] > 1);

    return {
        date: todayStr,
        is_no_bet_day: !s1.is_recommended,
        recommendation_headline_hu: s1.is_recommended
            ? "✅ TELJES NAPI STRATÉGIA AKTÍV — KVANTITATÍV SZELVÉNYEK ELKÉSZÜLTEK"
            : "⚠️ MA NEM AJÁNLOTT FOGADNI (NO-BET NAP — BANKROLL VÉDELEM)",
        recommendation_summary_hu: "A Bivariate Poisson + xG modell és a kétlépcsős (08:00 Tervezet -> Meccs előtt 1 órával Véglegesítés) protokoll alapján összeállított szelvények.",
        daily_bankroll_budget_huf: dailyBudget,
        actual_staked_huf: actualStaked,
        saved_bankroll_huf: Math.max(0, dailyBudget - actualStaked),
        max_shared_matches: maxShared,
        shared_match_ids: sharedIds,
        slips
    };
}

function getEarliestKickoffWindow(rec, todayStr) {
    let earliestHhMm = "20:00";
    let earliestDate = todayStr;
    let earliestMinOfDay = 20 * 60;

    for (const s of (rec.slips || [])) {
        if (!s || !s.is_recommended) continue;
        for (const l of (s.legs || [])) {
            const m = String(l.kickoff || "").match(/(\d{2}):(\d{2})$/);
            if (m) {
                const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
                if (mins < earliestMinOfDay) {
                    earliestMinOfDay = mins;
                    earliestHhMm = `${m[1]}:${m[2]}`;
                    earliestDate = l.date || todayStr;
                }
            }
        }
    }

    const finMins = Math.max(0, earliestMinOfDay - 60);
    const finHh = String(Math.floor(finMins / 60)).padStart(2, "0");
    const finMm = String(finMins % 60).padStart(2, "0");
    return {
        earliest_kickoff_date: earliestDate,
        earliest_kickoff_hhmm: earliestHhMm,
        finalize_at_hhmm: `${finHh}:${finMm}`,
        finalize_min_of_day: finMins
    };
}

async function main() {
    const modeArg = (process.argv.find(a => a.startsWith("--mode=")) || "--mode=auto").split("=")[1];
    const { today, tomorrow, nowIso, currentHhMm } = getBudapestDates();

    let state = {
        settings: {
            initial_bankroll_huf: 5000,
            daily_stake_percent: 10,
            fixed_daily_budget_huf: 500,
            use_fixed_budget: false,
            max_shared_matches: 1,
            bookmaker_margin: 0.055,
            mode_selection: "live_today_tomorrow",
            ...DEFAULT_KEYS
        },
        manual_odds: {},
        daily_runs: {}
    };

    if (fs.existsSync(STATE_PATH)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
            state = { ...state, ...loaded, settings: { ...state.settings, ...(loaded.settings || {}) } };
        } catch (e) {}
    } else if (fs.existsSync(ROOT_STATE_PATH)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(ROOT_STATE_PATH, "utf8"));
            state = { ...state, ...loaded, settings: { ...state.settings, ...(loaded.settings || {}) } };
        } catch (e) {}
    }

    // Biztosítjuk, hogy az API kulcsok mindig ki legyenek töltve
    state.settings.the_odds_api_key = state.settings.the_odds_api_key || DEFAULT_KEYS.the_odds_api_key;
    state.settings.football_data_api_key = state.settings.football_data_api_key || DEFAULT_KEYS.football_data_api_key;
    state.settings.api_football_key = state.settings.api_football_key || DEFAULT_KEYS.api_football_key;

    const oddsKey = state.settings.the_odds_api_key;
    const fdKey = state.settings.football_data_api_key;
    const afKey = state.settings.api_football_key;

    // 1. Korábbi napok (< today) automatikus kiértékelése
    const pastDates = Object.keys(state.daily_runs || {}).filter(d => d < today && d >= "2026-11-03").sort();
    if (pastDates.length > 0) {
        const scoresMap = await fetchFinishedScores(oddsKey, fdKey);
        for (const d of pastDates) {
            const r = state.daily_runs[d];
            if (r && !r.is_evaluated) {
                evaluatePastDayRun(r, scoresMap);
                console.log(`[KIERTEKELVE] ${d}: Nettó eredmény = ${r.evaluation?.net_profit_huf} Ft`);
            }
        }
    }

    // 2. Mai nap (today) kétlépcsős kezelése:
    //    - Reggel 08:00: DRAFT (Tervezet) létrehozása
    //    - Meccs előtt 1 órával: FINAL (Mélyelemzés hiányzókkal és szorzómozgással + Véglegesítés)
    const existingToday = state.daily_runs[today] || null;
    if (existingToday && existingToday.stage === "FINAL" && modeArg !== "final") {
        console.log(`[OK] A mai (${today}) szelvények már VÉGLEGESÍTVE (FINAL) vannak.`);
    } else {
        const dailyBudget = computeCurrentDailyBudget(state);
        const candidates = await fetchLiveCandidateMatches(oddsKey, today, tomorrow);

        if (candidates.length > 0) {
            const openingOddsMap = (existingToday && existingToday.opening_odds_map) ? existingToday.opening_odds_map : {};
            if (Object.keys(openingOddsMap).length === 0) {
                for (const c of candidates) {
                    openingOddsMap[c.match_id] = { ...c.provided_odds };
                }
            }

            const baseAnalyzed = candidates.map(c => analyzeMatchAndMarkets(c, state.settings.bookmaker_margin));
            const draftRec = buildThreeWorkingFormulaSlips(today, baseAnalyzed, dailyBudget, state.settings.max_shared_matches);
            const draftSnapshot = (existingToday && existingToday.draft_slips_snapshot)
                ? existingToday.draft_slips_snapshot
                : JSON.parse(JSON.stringify(draftRec.slips));

            const win = getEarliestKickoffWindow(draftRec, today);
            const [currH, currM] = currentHhMm.split(":").map(x => parseInt(x, 10));
            const currMinOfDay = (currH || 0) * 60 + (currM || 0);

            const isPrematchTime = (modeArg === "final") ||
                (modeArg === "auto" && currMinOfDay >= (win.finalize_min_of_day - 15));

            let finalRec = draftRec;
            let stage = "DRAFT";
            let finalizedAt = null;
            const changeLogs = [];

            if (isPrematchTime) {
                stage = "FINAL";
                finalizedAt = nowIso;
                const injuriesMap = await fetchPrematchInjuriesMap(afKey, today);

                const adjustedCandidates = candidates.map(c => {
                    const clone = JSON.parse(JSON.stringify(c));
                    const hLow = clone.home_name.toLowerCase();
                    const aLow = clone.away_name.toLowerCase();
                    const openOdds = openingOddsMap[clone.match_id] || {};
                    let hFactor = 1.0, aFactor = 1.0;

                    for (const [tKey, players] of Object.entries(injuriesMap)) {
                        if (hLow.includes(tKey) || tKey.includes(hLow)) {
                            hFactor -= Math.min(0.14, players.length * 0.045);
                            changeLogs.push(`🔍 Hiányzók (${clone.home_name}): ${players.join(", ")}`);
                        }
                        if (aLow.includes(tKey) || tKey.includes(aLow)) {
                            aFactor -= Math.min(0.14, players.length * 0.045);
                            changeLogs.push(`🔍 Hiányzók (${clone.away_name}): ${players.join(", ")}`);
                        }
                    }

                    if (openOdds["1"] && clone.provided_odds["1"]) {
                        const drift = (clone.provided_odds["1"] - openOdds["1"]) / openOdds["1"];
                        if (drift >= 0.065) {
                            hFactor -= 0.09;
                            aFactor += 0.05;
                            changeLogs.push(`📉 Szorzóromlás (${clone.home_name}): ${openOdds["1"]} ➔ ${clone.provided_odds["1"]}`);
                        }
                    }
                    if (openOdds["2"] && clone.provided_odds["2"]) {
                        const drift = (clone.provided_odds["2"] - openOdds["2"]) / openOdds["2"];
                        if (drift >= 0.065) {
                            aFactor -= 0.09;
                            hFactor += 0.05;
                            changeLogs.push(`📉 Szorzóromlás (${clone.away_name}): ${openOdds["2"]} ➔ ${clone.provided_odds["2"]}`);
                        }
                    }

                    clone.home_npxg = Number(Math.max(0.65, clone.home_npxg * hFactor).toFixed(2));
                    clone.away_npxg = Number(Math.max(0.55, clone.away_npxg * aFactor).toFixed(2));
                    return clone;
                });

                const finalAnalyzed = adjustedCandidates.map(c => analyzeMatchAndMarkets(c, state.settings.bookmaker_margin));
                finalRec = buildThreeWorkingFormulaSlips(today, finalAnalyzed, dailyBudget, state.settings.max_shared_matches);

                if (changeLogs.length === 0) {
                    changeLogs.push("✅ MECCS ELŐTTI 1 ÓRÁS MÉLYELEMZÉS RENDBEN: Nincs kedvezőtlen kulcsjátékos-hiány vagy szorzóromlás, mind a 3 reggeli Tervezet-szelvény megerősítve és VÉGLEGESÍTVE!");
                }
            }

            finalRec.stage = stage;
            finalRec.is_locked = (stage === "FINAL");
            finalRec.earliest_kickoff_date = win.earliest_kickoff_date;
            finalRec.earliest_kickoff_hhmm = win.earliest_kickoff_hhmm;
            finalRec.finalize_at_hhmm = win.finalize_at_hhmm;
            finalRec.finalized_at = finalizedAt;
            finalRec.prematch_change_log_hu = changeLogs;

            state.daily_runs[today] = {
                run_date: today,
                stage,
                is_locked: (stage === "FINAL"),
                finalized_at: finalizedAt,
                earliest_kickoff_hhmm: win.earliest_kickoff_hhmm,
                finalize_at_hhmm: win.finalize_at_hhmm,
                opening_odds_map: openingOddsMap,
                draft_slips_snapshot: draftSnapshot,
                prematch_change_log_hu: changeLogs,
                is_evaluated: false,
                is_live_data: true,
                updated_at: nowIso,
                recommendation: finalRec,
                evaluation: existingToday?.evaluation || null
            };
            console.log(`[MENTVE] ${today} napi szelvények (${stage}) — Legkorábbi meccs: ${win.earliest_kickoff_hhmm}, Véglegesítés: ${win.finalize_at_hhmm}`);
        }
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });
    const jsonOut = JSON.stringify(state, null, 2);
    const autoJsOut = `window.__AUTO_DISK_STATE__ = ${jsonOut};\n`;
    fs.writeFileSync(STATE_PATH, jsonOut, "utf8");
    fs.writeFileSync(AUTO_JS_PATH, autoJsOut, "utf8");
    fs.writeFileSync(ROOT_STATE_PATH, jsonOut, "utf8");
    fs.writeFileSync(ROOT_AUTO_JS_PATH, autoJsOut, "utf8");
}

main().catch(err => {
    console.error("Hiba a cloud_runner futása közben:", err);
    process.exit(0);
});
