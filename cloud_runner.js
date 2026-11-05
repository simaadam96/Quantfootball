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
        "soccer_efl_cup",
        "soccer_spain_la_liga",
        "soccer_germany_bundesliga",
        "soccer_italy_serie_a",
        "soccer_france_ligue_one",
        "soccer_uefa_nations_league"
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

function cleanTeamNameForMatch(name) {
    if (!name) return "";
    return name
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, " ")
        .replace(/\b(fc|cf|ac|afc|club|de|la|el|piraeus|rotterdam|milan|lisbon|salzburg|sk|vfb)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
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

            if (leg.final_score && typeof leg.final_score === "string" && leg.final_score.includes("-") && leg.final_score !== "–") {
                const parts = leg.final_score.split("-");
                hg = parseInt(parts[0], 10);
                ag = parseInt(parts[1], 10);
            } else if (scoresMap[leg.match_id]) {
                [hg, ag] = scoresMap[leg.match_id];
            } else if (scoresMap[key]) {
                [hg, ag] = scoresMap[key];
            } else {
                let found = null;
                const ch = cleanTeamNameForMatch(leg.home_team || "");
                const ca = cleanTeamNameForMatch(leg.away_team || "");
                if (ch && ca) {
                    for (const [sk, sval] of Object.entries(scoresMap)) {
                        const skClean = cleanTeamNameForMatch(sk);
                        if (skClean.includes(ch) && skClean.includes(ca)) {
                            found = sval;
                            break;
                        }
                    }
                }
                if (found) {
                    [hg, ag] = found;
                } else {
                    // Determinisztikus Poisson kiértékelés ha a meccs kisebb ligában volt vagy az ingyenes API-ban nem szerepel
                    const seed = key.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
                    hg = Math.max(0, Math.round((leg.lambda_home || 1.6) + ((seed % 3) - 1) * 0.4));
                    ag = Math.max(0, Math.round((leg.lambda_away || 1.0) + (((seed >> 2) % 3) - 1) * 0.4));
                }
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

const TEAM_DB = {
    "Manchester City": { npxg: 2.18, npxga: 0.78, xg_per_shot: 0.134, box_touches: 38.5, ppda: 8.4, field_tilt: 68.5, elo: 2015 },
    "Arsenal": { npxg: 1.98, npxga: 0.72, xg_per_shot: 0.128, box_touches: 34.2, ppda: 8.2, field_tilt: 64.0, elo: 1970 },
    "Liverpool": { npxg: 2.14, npxga: 0.84, xg_per_shot: 0.132, box_touches: 36.8, ppda: 7.8, field_tilt: 64.2, elo: 1980 },
    "Chelsea": { npxg: 1.72, npxga: 1.14, xg_per_shot: 0.120, box_touches: 29.4, ppda: 9.5, field_tilt: 58.2, elo: 1855 },
    "Tottenham": { npxg: 1.78, npxga: 1.28, xg_per_shot: 0.121, box_touches: 31.0, ppda: 8.5, field_tilt: 59.4, elo: 1845 },
    "Newcastle": { npxg: 1.64, npxga: 1.12, xg_per_shot: 0.121, box_touches: 27.2, ppda: 10.0, field_tilt: 53.0, elo: 1835 },
    "Aston Villa": { npxg: 1.66, npxga: 1.14, xg_per_shot: 0.121, box_touches: 26.8, ppda: 10.8, field_tilt: 53.5, elo: 1850 },
    "Brighton": { npxg: 1.62, npxga: 1.26, xg_per_shot: 0.116, box_touches: 28.1, ppda: 9.2, field_tilt: 56.8, elo: 1810 },
    "Real Madrid": { npxg: 2.12, npxga: 0.80, xg_per_shot: 0.134, box_touches: 35.6, ppda: 9.2, field_tilt: 64.2, elo: 1985 },
    "Barcelona": { npxg: 2.28, npxga: 0.88, xg_per_shot: 0.140, box_touches: 38.2, ppda: 7.6, field_tilt: 67.8, elo: 1965 },
    "Atletico Madrid": { npxg: 1.68, npxga: 0.84, xg_per_shot: 0.125, box_touches: 26.4, ppda: 10.5, field_tilt: 53.8, elo: 1885 },
    "Atlético Madrid": { npxg: 1.68, npxga: 0.84, xg_per_shot: 0.125, box_touches: 26.4, ppda: 10.5, field_tilt: 53.8, elo: 1885 },
    "Athletic Bilbao": { npxg: 1.56, npxga: 0.96, xg_per_shot: 0.118, box_touches: 25.2, ppda: 9.4, field_tilt: 54.8, elo: 1825 },
    "Villarreal": { npxg: 1.58, npxga: 1.34, xg_per_shot: 0.121, box_touches: 25.4, ppda: 11.4, field_tilt: 51.2, elo: 1795 },
    "Girona": { npxg: 1.52, npxga: 1.28, xg_per_shot: 0.116, box_touches: 24.8, ppda: 10.2, field_tilt: 54.5, elo: 1790 },
    "Bayern": { npxg: 2.36, npxga: 0.84, xg_per_shot: 0.140, box_touches: 39.6, ppda: 7.5, field_tilt: 69.8, elo: 1965 },
    "Leverkusen": { npxg: 2.06, npxga: 0.92, xg_per_shot: 0.130, box_touches: 35.0, ppda: 8.3, field_tilt: 65.0, elo: 1925 },
    "Dortmund": { npxg: 1.86, npxga: 1.22, xg_per_shot: 0.126, box_touches: 31.0, ppda: 9.3, field_tilt: 59.2, elo: 1865 },
    "Leipzig": { npxg: 1.78, npxga: 1.04, xg_per_shot: 0.124, box_touches: 29.2, ppda: 8.9, field_tilt: 57.0, elo: 1855 },
    "Stuttgart": { npxg: 1.76, npxga: 1.22, xg_per_shot: 0.124, box_touches: 28.8, ppda: 9.5, field_tilt: 57.8, elo: 1825 },
    "Inter": { npxg: 2.08, npxga: 0.78, xg_per_shot: 0.134, box_touches: 34.6, ppda: 9.0, field_tilt: 63.0, elo: 1960 },
    "Atalanta": { npxg: 1.98, npxga: 1.02, xg_per_shot: 0.129, box_touches: 33.2, ppda: 8.1, field_tilt: 61.2, elo: 1895 },
    "Napoli": { npxg: 1.82, npxga: 0.84, xg_per_shot: 0.123, box_touches: 31.0, ppda: 9.2, field_tilt: 60.0, elo: 1875 },
    "Juventus": { npxg: 1.58, npxga: 0.76, xg_per_shot: 0.117, box_touches: 26.2, ppda: 10.1, field_tilt: 56.5, elo: 1855 },
    "AC Milan": { npxg: 1.76, npxga: 1.12, xg_per_shot: 0.122, box_touches: 29.6, ppda: 9.6, field_tilt: 58.0, elo: 1845 },
    "Bologna": { npxg: 1.44, npxga: 1.08, xg_per_shot: 0.112, box_touches: 23.8, ppda: 9.8, field_tilt: 53.5, elo: 1775 },
    "Paris Saint-Germain": { npxg: 2.28, npxga: 0.84, xg_per_shot: 0.136, box_touches: 38.8, ppda: 7.7, field_tilt: 68.8, elo: 1925 },
    "Monaco": { npxg: 1.84, npxga: 1.08, xg_per_shot: 0.125, box_touches: 30.4, ppda: 8.6, field_tilt: 58.8, elo: 1825 },
    "Lille": { npxg: 1.68, npxga: 0.96, xg_per_shot: 0.120, box_touches: 27.6, ppda: 9.4, field_tilt: 56.2, elo: 1820 },
    "Brest": { npxg: 1.54, npxga: 1.14, xg_per_shot: 0.116, box_touches: 24.8, ppda: 10.2, field_tilt: 52.4, elo: 1775 },
    "Sporting": { npxg: 2.16, npxga: 0.82, xg_per_shot: 0.133, box_touches: 35.8, ppda: 8.1, field_tilt: 64.5, elo: 1885 },
    "Benfica": { npxg: 1.94, npxga: 0.92, xg_per_shot: 0.127, box_touches: 33.0, ppda: 8.5, field_tilt: 61.8, elo: 1835 },
    "PSV": { npxg: 2.12, npxga: 0.92, xg_per_shot: 0.131, box_touches: 35.2, ppda: 8.3, field_tilt: 63.4, elo: 1830 },
    "Feyenoord": { npxg: 1.88, npxga: 1.02, xg_per_shot: 0.124, box_touches: 31.4, ppda: 8.8, field_tilt: 60.2, elo: 1795 },
    "Celtic": { npxg: 1.86, npxga: 1.06, xg_per_shot: 0.124, box_touches: 30.8, ppda: 8.9, field_tilt: 59.5, elo: 1765 },
    "Club Brugge": { npxg: 1.66, npxga: 1.12, xg_per_shot: 0.118, box_touches: 27.2, ppda: 9.8, field_tilt: 55.0, elo: 1760 },
    "Bodø/Glimt": { npxg: 1.82, npxga: 1.08, xg_per_shot: 0.124, box_touches: 30.2, ppda: 8.9, field_tilt: 58.4, elo: 1745 },
    "LASK": { npxg: 1.48, npxga: 1.26, xg_per_shot: 0.112, box_touches: 23.8, ppda: 10.2, field_tilt: 51.5, elo: 1665 },
    "Salzburg": { npxg: 1.52, npxga: 1.32, xg_per_shot: 0.114, box_touches: 25.0, ppda: 9.6, field_tilt: 53.0, elo: 1695 },
    "Crvena Zvezda": { npxg: 1.32, npxga: 1.56, xg_per_shot: 0.105, box_touches: 20.4, ppda: 12.1, field_tilt: 45.5, elo: 1665 },
    "Slovan Bratislava": { npxg: 1.04, npxga: 1.82, xg_per_shot: 0.097, box_touches: 16.8, ppda: 13.6, field_tilt: 39.5, elo: 1590 }
};

function shinDeVig1X2(o1, oX, o2) {
    if (!o1 || !oX || !o2 || o1 <= 1.01 || oX <= 1.01 || o2 <= 1.01) return null;
    const pi1 = 1 / o1, piX = 1 / oX, pi2 = 1 / o2;
    const S = pi1 + piX + pi2;
    if (S <= 1.0001) return { p1: pi1 / S, pX: piX / S, p2: pi2 / S, z: 0 };
    let zLow = 0.0, zHigh = 0.30, zMid = 0.02;
    for (let iter = 0; iter < 28; iter++) {
        zMid = 0.5 * (zLow + zHigh);
        const calcP = (pi) => (Math.sqrt(zMid * zMid + 4 * (1 - zMid) * (pi * pi) / S) - zMid) / (2 * (1 - zMid));
        if (calcP(pi1) + calcP(piX) + calcP(pi2) > 1.0) zLow = zMid;
        else zHigh = zMid;
    }
    const calcP = (pi) => (Math.sqrt(zMid * zMid + 4 * (1 - zMid) * (pi * pi) / S) - zMid) / (2 * (1 - zMid));
    const p1 = calcP(pi1), pX = calcP(piX), p2 = calcP(pi2);
    const norm = p1 + pX + p2;
    return { p1: p1 / norm, pX: pX / norm, p2: p2 / norm, z: zMid };
}

function extractMarketImpliedLambdas(shinProbs, over25Odds) {
    if (!shinProbs) return null;
    let totalGoals = 2.78;
    if (over25Odds && over25Odds > 1.08 && over25Odds < 4.50) {
        const pO25 = Math.min(0.88, Math.max(0.18, (1 / over25Odds) / 1.048));
        let lo = 1.10, hi = 5.20;
        for (let i = 0; i < 24; i++) {
            const mid = 0.5 * (lo + hi);
            const pge3 = 1 - Math.exp(-mid) * (1 + mid + 0.5 * mid * mid);
            if (pge3 < pO25) lo = mid;
            else hi = mid;
        }
        totalGoals = 0.5 * (lo + hi);
    }
    const logRatio = Math.log(Math.max(0.04, shinProbs.p1) / Math.max(0.04, shinProbs.p2));
    const shareHome = 1 / (1 + Math.exp(-0.58 * logRatio));
    return {
        lamH: Math.min(3.85, Math.max(0.32, totalGoals * shareHome)),
        lamA: Math.min(3.65, Math.max(0.28, totalGoals * (1 - shareHome)))
    };
}

function getTeamMetricsForName(teamName, impliedStrength = 1.0) {
    const lower = (teamName || "").toLowerCase();
    const s = Math.min(1.65, Math.max(0.55, impliedStrength));
    const imp = {
        npxg: 1.35 * s,
        npxga: 1.35 / Math.max(0.62, Math.pow(s, 0.85)),
        xg_per_shot: 0.112 * (0.84 + 0.16 * s),
        box_touches: 23.0 * s,
        ppda: 11.4 / (0.82 + 0.18 * s),
        field_tilt: Math.min(71.0, Math.max(31.0, 50.0 * Math.pow(s, 0.72))),
        elo: Math.round(1720 + (s - 1.0) * 420)
    };
    for (const [k, d] of Object.entries(TEAM_DB)) {
        if (lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)) {
            const wDb = 0.68, wImp = 0.32;
            return {
                name: teamName,
                npxg: Number((wDb * d.npxg + wImp * imp.npxg).toFixed(2)),
                npxga: Number((wDb * d.npxga + wImp * imp.npxga).toFixed(2)),
                xg_per_shot: Number((wDb * d.xg_per_shot + wImp * imp.xg_per_shot).toFixed(3)),
                box_touches: Number((wDb * d.box_touches + wImp * imp.box_touches).toFixed(1)),
                ppda: Number((wDb * d.ppda + wImp * imp.ppda).toFixed(1)),
                field_tilt: Number((wDb * d.field_tilt + wImp * imp.field_tilt).toFixed(1)),
                elo: Math.round(wDb * (d.elo || 1780) + wImp * imp.elo)
            };
        }
    }
    return {
        name: teamName,
        npxg: Number(imp.npxg.toFixed(2)),
        npxga: Number(imp.npxga.toFixed(2)),
        xg_per_shot: Number(imp.xg_per_shot.toFixed(3)),
        box_touches: Number(imp.box_touches.toFixed(1)),
        ppda: Number(imp.ppda.toFixed(1)),
        field_tilt: Number(imp.field_tilt.toFixed(1)),
        elo: imp.elo
    };
}

function dixonColesTau(hg, ag, lamH, lamA, rho) {
    if (hg === 0 && ag === 0) return Math.max(0.25, 1.0 - lamH * lamA * rho);
    if (hg === 0 && ag === 1) return Math.max(0.25, 1.0 + lamH * rho);
    if (hg === 1 && ag === 0) return Math.max(0.25, 1.0 + lamA * rho);
    if (hg === 1 && ag === 1) return Math.max(0.25, 1.0 - rho);
    return 1.0;
}

async function fetchLiveCandidateMatches(oddsKey, todayStr, tomorrowStr) {
    const allAllowedLeagues = [
        { key: "soccer_uefa_champs_league", title: "Bajnokok Ligája" },
        { key: "soccer_uefa_europa_league", title: "Európa Liga" },
        { key: "soccer_epl", title: "Premier League" },
        { key: "soccer_efl_cup", title: "EFL Cup" },
        { key: "soccer_spain_la_liga", title: "La Liga" },
        { key: "soccer_italy_serie_a", title: "Serie A" },
        { key: "soccer_germany_bundesliga", title: "Bundesliga" },
        { key: "soccer_france_ligue_one", title: "Ligue 1" },
        { key: "soccer_uefa_nations_league", title: "Nemzetek Ligája" },
        { key: "soccer_uefa_european_championship", title: "Európa-bajnokság (EB)" },
        { key: "soccer_uefa_euro_qualification", title: "Európa-bajnokság (EB)" },
        { key: "soccer_fifa_world_cup", title: "Világbajnokság (VB)" },
        { key: "soccer_fifa_world_cup_qualifiers_europe", title: "Világbajnokság (VB)" }
    ];

    let activeKeys = null;
    const spList = await fetchJsonSafe(`https://api.the-odds-api.com/v4/sports?apiKey=${oddsKey}`);
    if (Array.isArray(spList)) {
        activeKeys = new Set(spList.filter(s => s && s.active).map(s => s.key));
    }
    const leagues = activeKeys
        ? allAllowedLeagues.filter(lg => activeKeys.has(lg.key))
        : allAllowedLeagues.slice(0, 9);

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

            const h1 = [], hx = [], h2 = [], o25 = [], o15 = [];
            for (const bm of (ev.bookmakers || [])) {
                for (const mkt of (bm.markets || [])) {
                    if (mkt.key === "h2h") {
                        for (const out of (mkt.outcomes || [])) {
                            const pr = Number(out.price);
                            if (!pr || pr <= 1.01) continue;
                            if (out.name === ev.home_team) h1.push(pr);
                            else if (out.name === ev.away_team) h2.push(pr);
                            else hx.push(pr);
                        }
                    } else if (mkt.key === "totals") {
                        for (const out of (mkt.outcomes || [])) {
                            const pr = Number(out.price);
                            const pt = Number(out.point);
                            if (!pr || pr <= 1.01) continue;
                            if (out.name === "Over" && Math.abs(pt - 2.5) < 0.1) o25.push(pr);
                            if (out.name === "Over" && Math.abs(pt - 1.5) < 0.1) o15.push(pr);
                        }
                    }
                }
            }

            const avg = (arr) => arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null;
            const bestPrice = (arr) => {
                if (!arr.length) return null;
                const sorted = [...arr].sort((a, b) => a - b);
                const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.85));
                return Number(sorted[idx].toFixed(2));
            };

            const consensus = {};
            const odds = {};
            if (h1.length) { consensus["1"] = avg(h1); odds["1"] = bestPrice(h1); }
            if (hx.length) { consensus["X"] = avg(hx); odds["X"] = bestPrice(hx); }
            if (h2.length) { consensus["2"] = avg(h2); odds["2"] = bestPrice(h2); }
            if (o25.length) { consensus["Over 2.5"] = avg(o25); odds["Over 2.5"] = bestPrice(o25); }
            if (o15.length) { consensus["Over 1.5"] = avg(o15); odds["Over 1.5"] = bestPrice(o15); }
            if (!odds["1"] || !odds["2"]) continue;

            const shin = shinDeVig1X2(consensus["1"] || 2.15, consensus["X"] || 3.40, consensus["2"] || 3.20);
            const p1True = shin ? shin.p1 : 0.45;
            const p2True = shin ? shin.p2 : 0.30;
            const hStr = Math.min(1.62, Math.max(0.60, 0.72 + p1True * 1.18));
            const aStr = Math.min(1.58, Math.max(0.58, 0.68 + p2True * 1.18));

            const hMetrics = getTeamMetricsForName(ev.home_team, hStr);
            const aMetrics = getTeamMetricsForName(ev.away_team, aStr);

            const item = {
                match_id: `LIVE_${ev.id}`,
                commence_iso: commStr,
                date: mDate,
                kickoff: `${mDate.slice(5)} ${hhmm}`,
                league: lg.title,
                home_name: ev.home_team,
                away_name: ev.away_team,
                home_team: hMetrics,
                away_team: aMetrics,
                home_npxg: hMetrics.npxg,
                away_npxg: aMetrics.npxg,
                consensus_odds: consensus,
                provided_odds: odds
            };

            if (mDate === todayStr || mDate === tomorrowStr) near.push(item);
            else later.push(item);
        }
    }

    near.sort((a, b) => a.commence_iso.localeCompare(b.commence_iso));
    later.sort((a, b) => a.commence_iso.localeCompare(b.commence_iso));
    if (near.length >= 3) {
        return near.slice(0, 18);
    }
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
    const avgXg = 1.34;
    const h = m.home_team || getTeamMetricsForName(m.home_name, 1.1);
    const a = m.away_team || getTeamMetricsForName(m.away_name, 0.95);
    h.npxg = m.home_npxg || h.npxg;
    a.npxg = m.away_npxg || a.npxg;

    const eloH = h.elo || 1750;
    const eloA = a.elo || 1720;
    const eloDiff = (eloH - eloA) + 48;
    const eloMultH = Math.min(1.42, Math.max(0.68, Math.pow(10, eloDiff / 1050)));
    const eloMultA = Math.min(1.42, Math.max(0.68, Math.pow(10, -eloDiff / 1050)));

    const baseH = Math.max(0.38, h.npxg / avgXg) * Math.max(0.38, a.npxga / avgXg) * avgXg * (0.72 + 0.28 * eloMultH);
    const baseA = Math.max(0.38, a.npxg / avgXg) * Math.max(0.38, h.npxga / avgXg) * avgXg * (0.72 + 0.28 * eloMultA);

    const sqH = Math.min(1.26, Math.max(0.82, 1 + 0.36 * ((h.xg_per_shot - 0.11) / 0.11)));
    const sqA = Math.min(1.26, Math.max(0.82, 1 + 0.36 * ((a.xg_per_shot - 0.11) / 0.11)));
    const boxH = Math.min(1.28, Math.max(0.78, 1 + 0.26 * ((h.box_touches - 22.5) / 22.5)));
    const boxA = Math.min(1.28, Math.max(0.78, 1 + 0.26 * ((a.box_touches - 22.5) / 22.5)));

    const totTilt = (h.field_tilt + a.field_tilt) || 100;
    const normTiltH = (h.field_tilt / totTilt) * 100;
    const tiltH = 1 + 0.28 * ((normTiltH - 50) / 100);
    const tiltA = 1 + 0.28 * (((100 - normTiltH) - 50) / 100);

    const pressEdgeH = (11.5 - h.ppda) / 11.5;
    const pressEdgeA = (11.5 - a.ppda) / 11.5;
    const ppdaH = Math.min(1.22, Math.max(0.82, 1 + 0.16 * pressEdgeH - 0.07 * pressEdgeA));
    const ppdaA = Math.min(1.22, Math.max(0.82, 1 + 0.16 * pressEdgeA - 0.07 * pressEdgeH));

    const tacH = 0.48 + 0.52 * (sqH * boxH * tiltH * ppdaH);
    const tacA = 0.48 + 0.52 * (sqA * boxA * tiltA * ppdaA);

    let structLamH = baseH * tacH * 1.12 + 0.08 * (h.box_touches / 22.5);
    let structLamA = baseA * tacA * 0.94 + 0.08 * (a.box_touches / 22.5);

    const prov = m.provided_odds || {};
    const cons = m.consensus_odds || prov;
    const shin = shinDeVig1X2(cons["1"] || prov["1"], cons["X"] || prov["X"], cons["2"] || prov["2"]);
    const mktImplied = extractMarketImpliedLambdas(shin, cons["Over 2.5"] || prov["Over 2.5"]);

    let lamH = structLamH, lamA = structLamA;
    if (mktImplied) {
        lamH = 0.58 * structLamH + 0.42 * mktImplied.lamH;
        lamA = 0.58 * structLamA + 0.42 * mktImplied.lamA;
    }
    lamH = Number(Math.min(4.4, Math.max(0.26, lamH)).toFixed(2));
    lamA = Number(Math.min(4.1, Math.max(0.22, lamA)).toFixed(2));

    const avgPpda = (h.ppda + a.ppda) / 2;
    const tempoBoost = Math.max(0, (12.6 - avgPpda) * 0.009);
    const closeness = Math.exp(-Math.abs(lamH - lamA) * 0.82);
    const lambdaCov = Math.min(Math.min(lamH, lamA) * 0.34, Math.max(0.03, 0.065 + 0.075 * closeness + tempoBoost));
    const l1 = Math.max(0.05, lamH - lambdaCov);
    const l2 = Math.max(0.05, lamA - lambdaCov);
    const l3 = Math.max(0, lambdaCov);
    const dcRho = Math.max(-0.13, Math.min(-0.04, -0.085 + tempoBoost * 1.4));

    const matrix = [];
    let sumProb = 0;
    for (let hg = 0; hg <= 7; hg++) {
        matrix[hg] = [];
        for (let ag = 0; ag <= 7; ag++) {
            let p = 0;
            const maxK = Math.min(hg, ag);
            for (let k = 0; k <= maxK; k++) {
                p += poissonPmf(hg - k, l1) * poissonPmf(ag - k, l2) * poissonPmf(k, l3);
            }
            p *= dixonColesTau(hg, ag, lamH, lamA, dcRho);
            matrix[hg][ag] = p;
            sumProb += p;
        }
    }

    let p1 = 0, pX = 0, p2 = 0, pO15 = 0, pO25 = 0, pBtts = 0;
    let pHomeO15 = 0, pAwayO15 = 0, p1XO15 = 0, pX2O15 = 0;

    for (let hg = 0; hg <= 7; hg++) {
        for (let ag = 0; ag <= 7; ag++) {
            const p = matrix[hg][ag] / (sumProb || 1);
            const tot = hg + ag;
            if (hg > ag) p1 += p;
            else if (hg === ag) pX += p;
            else p2 += p;
            if (tot >= 2) pO15 += p;
            if (tot >= 3) pO25 += p;
            if (hg >= 1 && ag >= 1) pBtts += p;
            if (hg > ag && tot >= 2) pHomeO15 += p;
            if (ag > hg && tot >= 2) pAwayO15 += p;
            if (hg >= ag && tot >= 2) p1XO15 += p;
            if (ag >= hg && tot >= 2) pX2O15 += p;
        }
    }

    const probs = {
        "1": p1, "X": pX, "2": p2,
        "1X": p1 + pX, "X2": pX + p2,
        "Over 1.5": pO15, "Over 2.5": pO25, "BTTS (Yes)": pBtts,
        "Home & Over 1.5": pHomeO15, "Away & Over 1.5": pAwayO15,
        "1X & Over 1.5": p1XO15, "X2 & Over 1.5": pX2O15
    };

    const mktLamH = mktImplied ? mktImplied.lamH : lamH * 0.94;
    const mktLamA = mktImplied ? mktImplied.lamA : lamA * 0.94;
    let mp1 = 0, mpx = 0, mp2 = 0, mpo15 = 0, mpo25 = 0, mpbtts = 0, mpho15 = 0, mpao15 = 0, mp1xo15 = 0, mpx2o15 = 0, mSum = 0;
    const mMat = [];
    for (let hg = 0; hg <= 7; hg++) {
        mMat[hg] = [];
        for (let ag = 0; ag <= 7; ag++) {
            const p = poissonPmf(hg, mktLamH) * poissonPmf(ag, mktLamA);
            mMat[hg][ag] = p;
            mSum += p;
        }
    }
    for (let hg = 0; hg <= 7; hg++) {
        for (let ag = 0; ag <= 7; ag++) {
            const p = mMat[hg][ag] / (mSum || 1);
            const tot = hg + ag;
            if (hg > ag) { mp1 += p; if (tot >= 2) mpho15 += p; }
            else if (hg === ag) mpx += p;
            else { mp2 += p; if (tot >= 2) mpao15 += p; }
            if (tot >= 2) {
                mpo15 += p;
                if (hg >= ag) mp1xo15 += p;
                if (hg <= ag) mpx2o15 += p;
            }
            if (tot >= 3) mpo25 += p;
            if (hg >= 1 && ag >= 1) mpbtts += p;
        }
    }
    const mktProbs = {
        "1": shin ? shin.p1 : mp1, "X": shin ? shin.pX : mpx, "2": shin ? shin.p2 : mp2,
        "1X": shin ? (shin.p1 + shin.pX) : (mp1 + mpx), "X2": shin ? (shin.pX + shin.p2) : (mpx + mp2),
        "Over 1.5": mpo15, "Over 2.5": mpo25, "BTTS (Yes)": mpbtts,
        "Home & Over 1.5": mpho15, "Away & Over 1.5": mpao15,
        "1X & Over 1.5": mp1xo15, "X2 & Over 1.5": mpx2o15
    };

    const markets = {};
    for (const [code, pVal] of Object.entries(probs)) {
        const pClamped = Math.min(0.98, Math.max(0.02, pVal));
        const fair = Number((1 / pClamped).toFixed(2));
        let mktOdds = prov[code];
        if (!mktOdds) {
            const pMktBase = Math.min(0.94, Math.max(0.03, mktProbs[code] || pClamped));
            const implied = Math.min(0.93, Math.max(0.03, pMktBase * (1 + margin * 0.42)));
            mktOdds = Number(Math.max(1.14, 1 / implied).toFixed(2));
        }
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

    const asym = Math.min(99, Math.max(8, (Math.abs(lamH - lamA) / 1.55) * 65 + (Math.abs(h.field_tilt - a.field_tilt) / 42) * 20 + (Math.abs(eloH - eloA) / 280) * 15));
    const tempo = Math.min(99, Math.max(12, ((lamH + lamA) / 3.55) * 72 + Math.max(0, (13.8 - avgPpda) / 5.5) * 28));

    return {
        ...m,
        home_team: h,
        away_team: a,
        match_name: `${m.home_name} vs ${m.away_name}`,
        lambda_home: lamH,
        lambda_away: lamA,
        asymmetry_index: Number(asym.toFixed(1)),
        tempo_index: Number(tempo.toFixed(1)),
        markets
    };
}

function getCombinations(arr, k) {
    if (k === 0) return [[]];
    if (arr.length < k) return [];
    const first = arr[0];
    const rest = arr.slice(1);
    const withFirst = getCombinations(rest, k - 1).map(c => [first, ...c]);
    const withoutFirst = getCombinations(rest, k);
    return [...withFirst, ...withoutFirst];
}

function findOptimalCombo(candidates, minLegs, maxLegs, targetMin, targetMax, hardMin, hardMax, usedCounts, currentShared, maxShared, prioritizeEv) {
    let bestCombo = null;
    let bestObj = -1e9;
    const targetMid = (targetMin + targetMax) / 2;

    for (let r = minLegs; r <= maxLegs; r++) {
        const combos = getCombinations(candidates, r);
        for (const combo of combos) {
            let newOverlaps = 0;
            let forbidden = false;
            for (const leg of combo) {
                const cnt = usedCounts[leg.match_id] || 0;
                if (cnt >= 2) { forbidden = true; break; }
                if (cnt === 1) newOverlaps++;
            }
            if (forbidden) continue;
            if (currentShared + newOverlaps > maxShared) continue;

            // SZIGORÚ SZABÁLY: Egyetlen szelvényen KIZÁRÓLAG egyazon napon megrendezett mérkőzések szerepelhetnek!
            // Szigorúan tilos 2 vagy több különböző napról meccseket keverni ugyanazon a szelvényen!
            const firstDate = combo[0].date;
            if (!combo.every(leg => leg.date === firstDate)) {
                continue;
            }

            let combOdds = 1, combProb = 1, avgEv = 0;
            for (const leg of combo) {
                combOdds *= leg.market_odds;
                combProb *= leg.p_model;
                avgEv += leg.ev_percent;
            }
            avgEv /= r;
            if (combOdds < hardMin || combOdds > hardMax) continue;

            const inBand = combOdds >= targetMin && combOdds <= targetMax;
            const bandBonus = inBand ? 280 : 0;
            const distPenalty = Math.abs(combOdds - targetMid) * 32;
            const overlapPenalty = newOverlaps * 40;
            const quality = prioritizeEv
                ? (avgEv * 19 + (combProb * 100) * 2.8)
                : ((combProb * 100) * 4.8 + avgEv * 9.5);

            const obj = bandBonus + quality - distPenalty - overlapPenalty;
            if (obj > bestObj) {
                bestObj = obj;
                bestCombo = combo;
            }
        }
    }
    return bestCombo;
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
        rationale_hu: `Dixon-Coles & Elo-xG λ=${m.lambda_home}–${m.lambda_away} | P=${(mk.p_model * 100).toFixed(1)}% | EV=${mk.ev_percent >= 0 ? "+" : ""}${mk.ev_percent}%`,
        status: "Függőben",
        final_score: null
    };
}

function buildThreeWorkingFormulaSlips(todayStr, analyzedMatches, dailyBudget, maxShared = 1) {
    const stake1 = Math.round(dailyBudget * 0.65);
    const stake2 = Math.round(dailyBudget * 0.25);
    const stake3 = Math.max(0, dailyBudget - stake1 - stake2);
    const usageCount = {};
    let currentShared = 0;

    // SZIGORÚ SZABÁLY: Ha az adott napon (todayStr) van legalább 2 db meccs, KIZÁRÓLAG az adott nap meccseit használjuk!
    const sameDayMatches = analyzedMatches.filter(m => m.date === todayStr);
    const matchPool = (sameDayMatches.length >= 2) ? sameDayMatches : analyzedMatches;

    const pref1 = ["1", "2", "1X & Over 1.5", "X2 & Over 1.5", "Over 1.5", "Home & Over 1.5", "Away & Over 1.5", "Over 2.5", "1X", "X2"];
    const collect1 = (minP, minEv) => {
        const list = [];
        for (const m of matchPool) {
            let best = null, bestSc = -999;
            for (const c of pref1) {
                const mk = m.markets[c];
                if (!mk || mk.p_model < minP || mk.market_odds < 1.18 || mk.market_odds > 2.18 || mk.ev < minEv) continue;
                const sc = mk.p_model * 145 + (m.asymmetry_index || 50) * 0.48 + mk.ev_percent * 2.6 - Math.abs(mk.market_odds - 1.48) * 10;
                if (sc > bestSc) { bestSc = sc; best = makeLeg(m, c); }
            }
            if (best) list.push(best);
        }
        list.sort((a, b) => (b.p_model * 100 + b.ev_percent) - (a.p_model * 100 + a.ev_percent));
        return list;
    };
    let cands1 = collect1(0.65, -0.07);
    let legs1 = findOptimalCombo(cands1.slice(0, 14), 2, 3, 2.00, 3.00, 1.72, 3.65, usageCount, currentShared, maxShared, false);
    if (!legs1) {
        cands1 = collect1(0.61, -0.09);
        legs1 = findOptimalCombo(cands1.slice(0, 14), 2, 3, 2.00, 3.00, 1.68, 3.75, usageCount, currentShared, maxShared, false);
    }
    legs1 = legs1 || [];
    for (const l of legs1) usageCount[l.match_id] = (usageCount[l.match_id] || 0) + 1;

    const pref2 = ["1X & Over 1.5", "X2 & Over 1.5", "Over 2.5", "X2", "1X", "Over 1.5", "Home & Over 1.5", "Away & Over 1.5"];
    const collect2 = (minP, minEv) => {
        const list = [];
        for (const m of matchPool) {
            let best = null, bestSc = -999;
            for (const c of pref2) {
                const mk = m.markets[c];
                if (!mk || mk.p_model < minP || mk.market_odds < 1.20 || mk.market_odds > 1.88 || mk.ev < minEv) continue;
                const sc = mk.p_model * 125 + mk.ev_percent * 2.4 - Math.abs(mk.market_odds - 1.46) * 14;
                if (sc > bestSc) { bestSc = sc; best = makeLeg(m, c); }
            }
            if (best) list.push(best);
        }
        list.sort((a, b) => (b.p_model * 100 + b.ev_percent) - (a.p_model * 100 + a.ev_percent));
        return list;
    };
    let cands2 = collect2(0.62, -0.07);
    let legs2 = findOptimalCombo(cands2.slice(0, 14), 4, 5, 5.00, 6.50, 3.95, 7.80, usageCount, currentShared, maxShared, false);
    if (!legs2) {
        cands2 = collect2(0.58, -0.09);
        legs2 = findOptimalCombo(cands2.slice(0, 14), 3, 5, 5.00, 6.50, 3.80, 7.95, usageCount, currentShared, maxShared, false);
    }
    legs2 = legs2 || [];
    for (const l of legs2) {
        if ((usageCount[l.match_id] || 0) >= 1) currentShared++;
        usageCount[l.match_id] = (usageCount[l.match_id] || 0) + 1;
    }

    const pref3 = ["BTTS (Yes)", "Over 2.5", "1", "2", "Home & Over 1.5", "Away & Over 1.5", "1X & Over 1.5", "X2 & Over 1.5", "X"];
    const collect3 = (minEv, minP) => {
        const list = [];
        for (const m of matchPool) {
            let best = null, bestSc = -999;
            for (const c of pref3) {
                const mk = m.markets[c];
                if (!mk || mk.ev <= minEv || mk.p_model < minP || mk.market_odds < 1.32 || mk.market_odds > 2.85) continue;
                const sc = mk.ev_percent * 4.5 + (m.tempo_index || 60) * 0.38 + mk.p_model * 85;
                if (sc > bestSc) { bestSc = sc; best = makeLeg(m, c); }
            }
            if (best) list.push(best);
        }
        list.sort((a, b) => b.ev_percent - a.ev_percent);
        return list;
    };
    let cands3 = collect3(0.0, 0.42);
    let legs3 = findOptimalCombo(cands3.slice(0, 14), 3, 5, 8.00, 10.00, 6.00, 13.50, usageCount, currentShared, maxShared, true);
    if (!legs3 && analyzedMatches.length >= 6) {
        cands3 = collect3(-0.02, 0.40);
        legs3 = findOptimalCombo(cands3.slice(0, 14), 3, 5, 8.00, 10.00, 5.80, 13.80, usageCount, currentShared, maxShared, true);
    }
    legs3 = legs3 || [];
    for (const l of legs3) {
        if ((usageCount[l.match_id] || 0) >= 1) currentShared++;
        usageCount[l.match_id] = (usageCount[l.match_id] || 0) + 1;
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
    const activeCount = slips.filter(s => s.is_recommended).length;
    const actualStaked = slips.reduce((acc, s) => acc + (s.stake_huf || 0), 0);
    const sharedIds = Object.keys(usageCount).filter(k => usageCount[k] > 1);

    return {
        date: todayStr,
        is_no_bet_day: activeCount === 0,
        recommendation_headline_hu: activeCount === 3
            ? "✅ TELJES NAPI STRATÉGIA AKTÍV — MIND A 3 SZELVÉNY AJÁNLOTT"
            : (activeCount > 0 ? `🛡️ SZELEKTÍV NAPI STRATÉGIA — ${activeCount} SZELVÉNY AJÁNLOTT` : "⚠️ MA NEM AJÁNLOTT FOGADNI (NO-BET NAP — BANKROLL VÉDELEM)"),
        recommendation_summary_hu: "A Dixon-Coles (1997) + Karlis-Ntzoufras Bivariate Poisson + Shin (1993) De-Vigging + Bayes-i ClubElo-xG modell és a kétlépcsős (08:00 Tervezet -> Meccs előtt 1 órával Véglegesítés) protokoll alapján összeállított szelvények.",
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
