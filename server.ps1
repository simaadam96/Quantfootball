# ============================================================================
# server.ps1
# Telepites nelkuli helyi webszerver (127.0.0.1:8000) Windows PowerShell-ben.
# Kiszolgalja a feluletet, szinkronizalja a beallitasokat/API kulcsokat/szelvenyeket
# a data/state.json es data/auto_state.js fajlokba, es futtatja a napi automatizaciot.
# ============================================================================

$ErrorActionPreference = "SilentlyContinue"
$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$staticDir = Join-Path $rootDir "static"
$dataDir = Join-Path $rootDir "data"
$statePath = Join-Path $dataDir "state.json"
$autoJsPath = Join-Path $dataDir "auto_state.js"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$port = 8000
$endpoint = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Loopback, $port)
$listener = New-Object System.Net.Sockets.TcpListener($endpoint)

try {
    $listener.Start()
} catch {
    Write-Host "[INFO] A 8000-es port foglalt, megnyitjuk kozvetlenul a feluletet..." -ForegroundColor Yellow
    Start-Process (Join-Path $staticDir "index.html")
    exit 0
}

Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host "  QUANTFOOTBALL PRO // Helyi Kvantitativ Szerver elindult!" -ForegroundColor Green
Write-Host "  Webes felulet cime: http://127.0.0.1:$port" -ForegroundColor Yellow
Write-Host "  Adatmentes helye:   $statePath" -ForegroundColor Gray
Write-Host "============================================================================" -ForegroundColor Cyan

Start-Process "http://127.0.0.1:$port"

while ($true) {
    if (!$listener.Pending()) {
        Start-Sleep -Milliseconds 80
        continue
    }
    $client = $listener.AcceptTcpClient()
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, $utf8NoBom)

    $requestLine = $reader.ReadLine()
    if (!$requestLine) { $client.Close(); continue }
    $parts = $requestLine.Split(" ")
    $method = $parts[0]
    $urlPath = $parts[1].Split("?")[0]

    $contentLength = 0
    while ($true) {
        $headerLine = $reader.ReadLine()
        if ([string]::IsNullOrEmpty($headerLine)) { break }
        if ($headerLine -match "^Content-Length:\s*(\d+)") {
            $contentLength = [int]$Matches[1]
        }
    }

    $bodyText = ""
    if ($contentLength -gt 0) {
        $buf = New-Object char[] $contentLength
        $readTotal = 0
        while ($readTotal -lt $contentLength) {
            $r = $reader.Read($buf, $readTotal, $contentLength - $readTotal)
            if ($r -le 0) { break }
            $readTotal += $r
        }
        $bodyText = New-Object string($buf, 0, $readTotal)
    }

    $statusCode = "200 OK"
    $contentType = "text/html; charset=utf-8"
    $respBytes = [byte[]]@()

    if ($method -eq "POST" -and $urlPath -eq "/api/sync-state") {
        if ($bodyText.Length -gt 10) {
            try {
                $incomingState = $bodyText | ConvertFrom-Json
                if ($incomingState -and $incomingState.settings) {
                    $existingState = $null
                    if (Test-Path $statePath) {
                        try {
                            $rawOld = [System.IO.File]::ReadAllText($statePath, $utf8NoBom)
                            $existingState = $rawOld | ConvertFrom-Json
                        } catch {}
                    }
                    if ($existingState -and $existingState.settings) {
                        if ([string]::IsNullOrWhiteSpace($incomingState.settings.the_odds_api_key) -and !([string]::IsNullOrWhiteSpace($existingState.settings.the_odds_api_key))) {
                            $incomingState.settings.the_odds_api_key = $existingState.settings.the_odds_api_key
                        }
                        if ([string]::IsNullOrWhiteSpace($incomingState.settings.football_data_api_key) -and !([string]::IsNullOrWhiteSpace($existingState.settings.football_data_api_key))) {
                            $incomingState.settings.football_data_api_key = $existingState.settings.football_data_api_key
                        }
                        if ([string]::IsNullOrWhiteSpace($incomingState.settings.api_football_key) -and !([string]::IsNullOrWhiteSpace($existingState.settings.api_football_key))) {
                            $incomingState.settings.api_football_key = $existingState.settings.api_football_key
                        }
                    }
                    if ([string]::IsNullOrWhiteSpace($incomingState.settings.the_odds_api_key)) {
                        $incomingState.settings.the_odds_api_key = "5d4a4c02c56ffbb5e242a8056b7a6268"
                    }
                    if ([string]::IsNullOrWhiteSpace($incomingState.settings.football_data_api_key)) {
                        $incomingState.settings.football_data_api_key = "b7bc2a3e65214bc88812bde8b67a2841"
                    }
                    if ([string]::IsNullOrWhiteSpace($incomingState.settings.api_football_key)) {
                        $incomingState.settings.api_football_key = "cf4dedb49f4d4582067816883129b24c"
                    }
                    $bodyText = $incomingState | ConvertTo-Json -Depth 12
                }
            } catch {}
            [System.IO.File]::WriteAllText($statePath, $bodyText, $utf8NoBom)
            [System.IO.File]::WriteAllText($autoJsPath, "window.__AUTO_DISK_STATE__ = $bodyText;", $utf8NoBom)
        }
        $contentType = "application/json; charset=utf-8"
        $respBytes = $utf8NoBom.GetBytes('{"ok":true}')
    }
    elseif ($method -eq "GET" -and $urlPath -eq "/api/load-state") {
        $contentType = "application/json; charset=utf-8"
        if (Test-Path $statePath) {
            $respBytes = [System.IO.File]::ReadAllBytes($statePath)
        } else {
            $respBytes = $utf8NoBom.GetBytes('{}')
        }
    }
    elseif ($urlPath -eq "/api/export-excel" -or $urlPath -eq "/data/kvantitativ_fogadasi_naplo.xlsx") {
        $xlsxPath = Join-Path $dataDir "kvantitativ_fogadasi_naplo.xlsx"
        if (Test-Path $xlsxPath) {
            $contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            $respBytes = [System.IO.File]::ReadAllBytes($xlsxPath)
        }
    }
    elseif ($urlPath -eq "/data/auto_state.js") {
        $contentType = "application/javascript; charset=utf-8"
        if (Test-Path $autoJsPath) {
            $respBytes = [System.IO.File]::ReadAllBytes($autoJsPath)
        } else {
            $respBytes = $utf8NoBom.GetBytes("window.__AUTO_DISK_STATE__ = {};")
        }
    }
    else {
        $relFile = "index.html"
        if ($urlPath -match "styles\.css$") { $relFile = "styles.css"; $contentType = "text/css; charset=utf-8" }
        elseif ($urlPath -match "app\.js$") { $relFile = "app.js"; $contentType = "application/javascript; charset=utf-8" }
        $fullPath = Join-Path $staticDir $relFile
        if (Test-Path $fullPath) {
            $respBytes = [System.IO.File]::ReadAllBytes($fullPath)
        } else {
            $statusCode = "404 Not Found"
            $respBytes = $utf8NoBom.GetBytes("Not found")
        }
    }

    $headerStr = "HTTP/1.1 $statusCode`r`nContent-Type: $contentType`r`nContent-Length: $($respBytes.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
    $headerBytes = $utf8NoBom.GetBytes($headerStr)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($respBytes.Length -gt 0) {
        $stream.Write($respBytes, 0, $respBytes.Length)
    }
    $stream.Flush()
    $client.Close()
}
