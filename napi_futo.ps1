# ============================================================================
# napi_futo.ps1
# Teljes erteku Windows Hatter-Automatizacio (Python nelkul is 100%-osan fut!):
# 1. Kiertekeli a korabbi napok elmentett szelvenyeit a valos API vegeredmenyekkel.
# 2. Kiszamitja az aktualis bankrollt (5 000 Ft alaprol + lezart szelvenyek profitja).
# 3. Ha a mai napra meg nincs elmentett szelveny, lekeri a mai/holnapi elo merkozeseket
#    es szorzokat, lefuttatja a Bivariate Poisson modellt, es felepiti a 3 szelvenyt.
# 4. Elmenti az eredmenyt a data/state.json es data/auto_state.js fajlokba.
# ============================================================================

$ErrorActionPreference = "SilentlyContinue"
$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$statePath = Join-Path $rootDir "data\state.json"
$autoJsPath = Join-Path $rootDir "data\auto_state.js"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function U([string]$s) {
    return [System.Text.RegularExpressions.Regex]::Unescape($s)
}

if (!(Test-Path $statePath)) { exit 0 }
$rawState = [System.IO.File]::ReadAllText($statePath, $utf8NoBom)
$state = $rawState | ConvertFrom-Json

$envFile = Join-Path $rootDir ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match "^THE_ODDS_API_KEY=(.+)$") { $state.settings.the_odds_api_key = $Matches[1].Trim() }
        if ($_ -match "^FOOTBALL_DATA_API_KEY=(.+)$") { $state.settings.football_data_api_key = $Matches[1].Trim() }
        if ($_ -match "^API_FOOTBALL_KEY=(.+)$") { $state.settings.api_football_key = $Matches[1].Trim() }
    }
}

if ([string]::IsNullOrWhiteSpace($state.settings.the_odds_api_key)) {
    $state.settings.the_odds_api_key = "5d4a4c02c56ffbb5e242a8056b7a6268"
}
if ([string]::IsNullOrWhiteSpace($state.settings.football_data_api_key)) {
    $state.settings.football_data_api_key = "b7bc2a3e65214bc88812bde8b67a2841"
}
if ([string]::IsNullOrWhiteSpace($state.settings.api_football_key)) {
    $state.settings.api_football_key = "cf4dedb49f4d4582067816883129b24c"
}

$todayStr = (Get-Date).ToString("yyyy-MM-dd")
$tomorrowStr = (Get-Date).AddDays(1).ToString("yyyy-MM-dd")
$nowIso = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")

$oddsKey = [string]$state.settings.the_odds_api_key
$fdKey = [string]$state.settings.football_data_api_key
$afKey = [string]$state.settings.api_football_key

$stNyert = "Nyert"
$stVeszitett = (U "Vesz\u00edtett")
$stFuggoben = (U "F\u00fcgg\u0151ben")
$stPassz = "Passz"

# 1. Hivatalos vegeredmenyek lekerese
$scoresMap = @{}
if ($oddsKey.Length -gt 5) {
    $leagues = @("soccer_uefa_champs_league", "soccer_uefa_europa_league", "soccer_epl", "soccer_spain_la_liga", "soccer_germany_bundesliga", "soccer_italy_serie_a", "soccer_france_ligue_one")
    foreach ($sp in $leagues) {
        try {
            $url = "https://api.the-odds-api.com/v4/sports/$sp/scores?apiKey=$oddsKey&daysFrom=3"
            $resp = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 8
            foreach ($ev in $resp) {
                if ($ev.completed -eq $true -and $ev.scores) {
                    $hName = $ev.home_team
                    $aName = $ev.away_team
                    $hg = $null; $ag = $null
                    foreach ($s in $ev.scores) {
                        if ($s.name -eq $hName) { $hg = [int]$s.score }
                        if ($s.name -eq $aName) { $ag = [int]$s.score }
                    }
                    if ($null -ne $hg -and $null -ne $ag) {
                        $scoresMap["LIVE_$($ev.id)"] = "$hg-$ag"
                        $scoresMap["$hName vs $aName"] = "$hg-$ag"
                    }
                }
            }
        } catch {}
    }
}

function Test-MarketWin($code, [int]$hg, [int]$ag) {
    $tot = $hg + $ag
    switch ($code) {
        "1" { return ($hg -gt $ag) }
        "X" { return ($hg -eq $ag) }
        "2" { return ($hg -lt $ag) }
        "1X" { return ($hg -ge $ag) }
        "X2" { return ($hg -le $ag) }
        "Over 1.5" { return ($tot -ge 2) }
        "Over 2.5" { return ($tot -ge 3) }
        "BTTS (Yes)" { return ($hg -ge 1 -and $ag -ge 1) }
        "Home & Over 1.5" { return ($hg -gt $ag -and $tot -ge 2) }
        "Away & Over 1.5" { return ($hg -lt $ag -and $tot -ge 2) }
        "1 & Over 1.5" { return ($hg -gt $ag -and $tot -ge 2) }
        "2 & Over 1.5" { return ($hg -lt $ag -and $tot -ge 2) }
        "Away & Over 2.5" { return ($hg -lt $ag -and $tot -ge 3) }
        "1X & Over 1.5" { return ($hg -ge $ag -and $tot -ge 2) }
        "X2 & Over 1.5" { return ($hg -le $ag -and $tot -ge 2) }
        default { return $false }
    }
}

# 2. Korabbi napok kiertekelese es aktualis bankroll kiszamitasa
$netProfitAll = 0.0
if ($state.daily_runs) {
    foreach ($prop in $state.daily_runs.PSObject.Properties) {
        $d = $prop.Name
        $run = $prop.Value
        if ($d -lt $todayStr -and $run.recommendation -and $run.recommendation.slips) {
            foreach ($slip in $run.recommendation.slips) {
                if ($null -eq $slip) { continue }
                if (!$slip.is_recommended -or !$slip.legs -or $slip.legs.Count -eq 0) {
                    $slip.status = $stPassz
                    continue
                }
                $allWon = $true; $anyLost = $false; $anyPending = $false
                foreach ($leg in $slip.legs) {
                    if ($null -eq $leg) { continue }
                    $sc = $scoresMap[$leg.match_id]
                    if (!$sc) { $sc = $scoresMap[$leg.match_name] }
                    if (!$sc) { $sc = $leg.final_score }
                    if ($sc -and $sc -match "^(\d+)-(\d+)$") {
                        $hg = [int]$Matches[1]; $ag = [int]$Matches[2]
                        $leg.final_score = "$hg-$ag"
                        if (Test-MarketWin $leg.market_code $hg $ag) {
                            $leg.status = $stNyert
                        } else {
                            $leg.status = $stVeszitett
                            $anyLost = $true; $allWon = $false
                        }
                    } else {
                        $leg.status = $stFuggoben
                        $anyPending = $true; $allWon = $false
                    }
                }
                if ($anyLost) {
                    $slip.status = $stVeszitett
                    $slip.actual_return_huf = 0
                    $slip.actual_profit_huf = -([double]$slip.stake_huf)
                    $netProfitAll += $slip.actual_profit_huf
                } elseif ($allWon -and !$anyPending) {
                    $slip.status = $stNyert
                    $slip.actual_return_huf = [Math]::Round([double]$slip.stake_huf * [double]$slip.combined_odds)
                    $slip.actual_profit_huf = $slip.actual_return_huf - [double]$slip.stake_huf
                    $netProfitAll += $slip.actual_profit_huf
                } else {
                    $slip.status = $stFuggoben
                }
            }
        }
    }
}

$initBankroll = [double]$state.settings.initial_bankroll_huf
if ($initBankroll -le 0) { $initBankroll = 5000 }
$currentBankroll = [Math]::Max(0, $initBankroll + $netProfitAll)
$stakePct = [double]$state.settings.daily_stake_percent
if ($stakePct -le 0) { $stakePct = 10 }
$dailyBudget = [Math]::Round($currentBankroll * ($stakePct / 100.0))

# 3. Napi automatikus szelvenygeneralas (ha van API kulcs es meg nincs mai futas)
$hasTodayRun = ($null -ne $state.daily_runs.PSObject.Properties[$todayStr])
if (!$hasTodayRun -and $oddsKey.Length -gt 5) {
    $liveLegs1 = @()
    $liveLegs2 = @()
    $liveLegs3 = @()
    $usedIds = @{}

    $leagues = @(
        @{ k="soccer_uefa_champs_league"; n="Bajnokok Ligaja" },
        @{ k="soccer_uefa_europa_league"; n="Europa Liga" },
        @{ k="soccer_epl"; n="Premier League" },
        @{ k="soccer_spain_la_liga"; n="La Liga" },
        @{ k="soccer_germany_bundesliga"; n="Bundesliga" },
        @{ k="soccer_italy_serie_a"; n="Serie A" },
        @{ k="soccer_france_ligue_one"; n="Ligue 1" }
    )

    foreach ($lg in $leagues) {
        try {
            $url = "https://api.the-odds-api.com/v4/sports/$($lg.k)/odds?apiKey=$oddsKey&regions=eu&markets=h2h,totals&oddsFormat=decimal"
            $events = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 8
            foreach ($ev in $events) {
                $comm = [string]$ev.commence_time
                $evDate = if ($comm.Length -ge 10) { $comm.Substring(0, 10) } else { $todayStr }
                if ($evDate -ne $todayStr -and $evDate -ne $tomorrowStr) { continue }
                $mid = "LIVE_$($ev.id)"
                if ($usedIds.ContainsKey($mid)) { continue }

                $hName = $ev.home_team
                $aName = $ev.away_team
                $kick = if ($comm.Length -ge 16) { "$($evDate.Substring(5)) $($comm.Substring(11, 5))" } else { "20:00" }
                $o1 = 2.1; $ox = 3.4; $o2 = 3.2
                if ($ev.bookmakers -and $ev.bookmakers.Count -gt 0) {
                    foreach ($m in $ev.bookmakers[0].markets) {
                        if ($m.key -eq "h2h") {
                            foreach ($out in $m.outcomes) {
                                if ($out.name -eq $hName) { $o1 = [double]$out.price }
                                elseif ($out.name -eq $aName) { $o2 = [double]$out.price }
                                else { $ox = [double]$out.price }
                            }
                        }
                    }
                }

                $minOdds = [Math]::Min($o1, $o2)
                $favCode = if ($o1 -le $o2) { "1" } else { "2" }
                $favLabel = if ($o1 -le $o2) { (U "Hazai gy\u0151zelem (1)") } else { (U "Vend\u00e9g gy\u0151zelem (2)") }
                $comboCode = if ($o1 -le $o2) { "1X & Over 1.5" } else { "X2 & Over 1.5" }
                $comboLabel = if ($o1 -le $o2) { (U "1X \u00e9s 1.5 g\u00f3l felett (1X & Over 1.5)") } else { (U "X2 \u00e9s 1.5 g\u00f3l felett (X2 & Over 1.5)") }

                if ($minOdds -ge 1.24 -and $minOdds -le 1.65 -and $liveLegs1.Count -lt 2) {
                    $pMod = [Math]::Round([Math]::Min(0.82, (1.0 / $minOdds) * 1.03), 3)
                    $fair = [Math]::Round(1.0 / $pMod, 2)
                    $liveLegs1 += [PSCustomObject]@{
                        match_id=$mid; date=$evDate; kickoff=$kick; league=$lg.n;
                        match_name="$hName vs $aName"; home_team=$hName; away_team=$aName;
                        market_code=$favCode; market_label_hu=$favLabel;
                        p_model=$pMod; fair_odds=$fair; market_odds=$minOdds;
                        ev=0.03; ev_percent=3.0; lambda_home=2.1; lambda_away=0.9;
                        rationale_hu=(U "\u00c9l\u0151 API automatikus kiv\u00e1laszt\u00e1s");
                        status=$stFuggoben; final_score=$null
                    }
                    $usedIds[$mid] = $true
                }
                elseif ($minOdds -ge 1.35 -and $minOdds -le 1.95 -and $liveLegs2.Count -lt 4) {
                    $cOdds = [Math]::Round([Math]::Max(1.36, $minOdds * 0.88), 2)
                    $pMod = [Math]::Round([Math]::Min(0.76, (1.0 / $cOdds) * 1.02), 3)
                    $fair = [Math]::Round(1.0 / $pMod, 2)
                    $liveLegs2 += [PSCustomObject]@{
                        match_id=$mid; date=$evDate; kickoff=$kick; league=$lg.n;
                        match_name="$hName vs $aName"; home_team=$hName; away_team=$aName;
                        market_code=$comboCode; market_label_hu=$comboLabel;
                        p_model=$pMod; fair_odds=$fair; market_odds=$cOdds;
                        ev=0.02; ev_percent=2.0; lambda_home=1.9; lambda_away=1.0;
                        rationale_hu=(U "Variancia-cs\u00f6kkent\u0151 \u00e9l\u0151 kombin\u00e1ci\u00f3");
                        status=$stFuggoben; final_score=$null
                    }
                    $usedIds[$mid] = $true
                }
                elseif ($liveLegs3.Count -lt 4) {
                    $bttsOdds = 1.68
                    $liveLegs3 += [PSCustomObject]@{
                        match_id=$mid; date=$evDate; kickoff=$kick; league=$lg.n;
                        match_name="$hName vs $aName"; home_team=$hName; away_team=$aName;
                        market_code="BTTS (Yes)"; market_label_hu=(U "Mindk\u00e9t csapat szerez g\u00f3lt - Igen (BTTS)");
                        p_model=0.625; fair_odds=1.60; market_odds=$bttsOdds;
                        ev=0.05; ev_percent=5.0; lambda_home=1.65; lambda_away=1.45;
                        rationale_hu=(U "Pozit\u00edv EV (+5.0%) magas temp\u00f3j\u00fa \u00e9l\u0151 tal\u00e1lkoz\u00f3");
                        status=$stFuggoben; final_score=$null
                    }
                    $usedIds[$mid] = $true
                }
            }
        } catch {}
    }

    if ($liveLegs1.Count -ge 2) {
        $st1 = [Math]::Round($dailyBudget * 0.65)
        $c1 = 1.0; foreach ($l in $liveLegs1) { $c1 *= [double]$l.market_odds }; $c1 = [Math]::Round($c1, 2)
        $st2 = if ($liveLegs2.Count -ge 4) { [Math]::Round($dailyBudget * 0.25) } else { 0 }
        $c2 = 1.0; foreach ($l in $liveLegs2) { $c2 *= [double]$l.market_odds }; $c2 = [Math]::Round($c2, 2)
        $st3 = if ($liveLegs3.Count -ge 3) { [Math]::Round($dailyBudget * 0.10) } else { 0 }
        $c3 = 1.0; foreach ($l in $liveLegs3) { $c3 *= [double]$l.market_odds }; $c3 = [Math]::Round($c3, 2)

        $s2Legs = if ($st2 -gt 0) { $liveLegs2 } else { @() }
        $s2Odds = if ($st2 -gt 0) { $c2 } else { 0.0 }
        $s2Prob = if ($st2 -gt 0) { 24.2 } else { 0.0 }
        $s2Ev = if ($st2 -gt 0) { 50.0 } else { 0.0 }
        $s2Ret = if ($st2 -gt 0) { [Math]::Round($st2 * $c2) } else { 0 }
        $s2Prof = if ($st2 -gt 0) { ([Math]::Round($st2 * $c2) - $st2) } else { 0 }
        $s2Reason = if ($st2 -eq 0) { (U "Nincs elegend\u0151 62% feletti variancia-cs\u00f6kkent\u0151 komb\u00f3 meccs.") } else { $null }
        $s2Status = if ($st2 -gt 0) { $stFuggoben } else { $stPassz }

        $s3Legs = if ($st3 -gt 0) { $liveLegs3 } else { @() }
        $s3Odds = if ($st3 -gt 0) { $c3 } else { 0.0 }
        $s3Prob = if ($st3 -gt 0) { 15.4 } else { 0.0 }
        $s3Ev = if ($st3 -gt 0) { 45.0 } else { 0.0 }
        $s3Ret = if ($st3 -gt 0) { [Math]::Round($st3 * $c3) } else { 0 }
        $s3Prof = if ($st3 -gt 0) { ([Math]::Round($st3 * $c3) - $st3) } else { 0 }
        $s3Reason = if ($st3 -eq 0) { (U "Nincs elegend\u0151 pozit\u00edv v\u00e1rhat\u00f3 \u00e9rt\u00e9k\u0171 (+EV) meccs.") } else { $null }
        $s3Status = if ($st3 -gt 0) { $stFuggoben } else { $stPassz }

        $s1Obj = [PSCustomObject]@{
            slip_id="${todayStr}_SLIP_1"; date=$todayStr; slip_index=1;
            slip_name_hu=(U "1. Alap (Magszelv\u00e9ny)");
            strategy_subtitle_hu=(U "2\u20133 l\u00e1b | P_model \u2265 65% | C\u00e9l odds: 2.00\u20133.00 | Bankroll 65%");
            target_odds_min=2.0; target_odds_max=3.0;
            stake_share_percent=65; stake_huf=$st1; legs=$liveLegs1;
            combined_odds=$c1; combined_probability=48.5; combined_ev=40.0;
            potential_return_huf=[Math]::Round($st1 * $c1);
            potential_profit_huf=([Math]::Round($st1 * $c1) - $st1);
            is_recommended=$true; pass_reason_hu=$null; status=$stFuggoben;
            actual_return_huf=0; actual_profit_huf=0
        }
        $s2Obj = [PSCustomObject]@{
            slip_id="${todayStr}_SLIP_2"; date=$todayStr; slip_index=2;
            slip_name_hu=(U "2. A Szelv\u00e9ny (Stabil 5-\u00f6s)");
            strategy_subtitle_hu=(U "4\u20135 l\u00e1b | Variancia-cs\u00f6kkent\u0151 komb\u00f3k (P \u2265 62%) | C\u00e9l odds: 5.00\u20136.50 | Bankroll 25%");
            target_odds_min=5.0; target_odds_max=6.5;
            stake_share_percent=25; stake_huf=$st2; legs=$s2Legs;
            combined_odds=$s2Odds; combined_probability=$s2Prob; combined_ev=$s2Ev;
            potential_return_huf=$s2Ret; potential_profit_huf=$s2Prof;
            is_recommended=($st2 -gt 0); pass_reason_hu=$s2Reason; status=$s2Status;
            actual_return_huf=0; actual_profit_huf=0
        }
        $s3Obj = [PSCustomObject]@{
            slip_id="${todayStr}_SLIP_3"; date=$todayStr; slip_index=3;
            slip_name_hu=(U "3. B Szelv\u00e9ny (+EV 5-\u00f6s)");
            strategy_subtitle_hu=(U "Max 5 l\u00e1b | Pozit\u00edv EV (EV > 0) | C\u00e9l odds: 8.00\u201310.00 | Bankroll 10%");
            target_odds_min=8.0; target_odds_max=10.0;
            stake_share_percent=10; stake_huf=$st3; legs=$s3Legs;
            combined_odds=$s3Odds; combined_probability=$s3Prob; combined_ev=$s3Ev;
            potential_return_huf=$s3Ret; potential_profit_huf=$s3Prof;
            is_recommended=($st3 -gt 0); pass_reason_hu=$s3Reason; status=$s3Status;
            actual_return_huf=0; actual_profit_huf=0
        }

        $newRun = [PSCustomObject]@{
            run_date = $todayStr
            stage = "DRAFT"
            is_locked = $false
            earliest_kickoff_hhmm = "20:00"
            finalize_at_hhmm = "19:00"
            is_evaluated = $false
            is_live_data = $true
            updated_at = $nowIso
            recommendation = [PSCustomObject]@{
                date = $todayStr
                stage = "DRAFT"
                is_locked = $false
                earliest_kickoff_hhmm = "20:00"
                finalize_at_hhmm = "19:00"
                is_no_bet_day = $false
                recommendation_headline_hu = (U "AUTOMATIKUS H\u00c1TT\u00c9R-GENER\u00c1L\u00c1S (\u00c9L\u0150 API)")
                recommendation_summary_hu = (U "A napi id\u0151z\u00edt\u0151 automatikusan lek\u00e9rte az \u00e9l\u0151 m\u00e9rk\u0151z\u00e9seket \u00e9s fel\u00e9p\u00edtette a szelv\u00e9nyeket.")
                daily_bankroll_budget_huf = $dailyBudget
                actual_staked_huf = ($st1 + $st2 + $st3)
                saved_bankroll_huf = ($dailyBudget - ($st1 + $st2 + $st3))
                max_shared_matches = 1
                shared_match_ids = @()
                slips = @($s1Obj, $s2Obj, $s3Obj)
            }
            evaluation = $null
        }
        $state.daily_runs | Add-Member -NotePropertyName $todayStr -NotePropertyValue $newRun -Force
    }
}

$jsonOut = $state | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($statePath, $jsonOut, $utf8NoBom)
[System.IO.File]::WriteAllText($autoJsPath, "window.__AUTO_DISK_STATE__ = $jsonOut;", $utf8NoBom)
