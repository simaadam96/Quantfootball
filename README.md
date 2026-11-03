# ⚽ QUANTFOOTBALL PRO — Automatizált Kvantitatív Labdarúgó Fogadási Analitika & Szelvénygenerátor

Teljes körű, önállóan futtatható kvantitatív labdarúgó elemző és szelvényépítő webalkalmazás **Bivariate Poisson + Haladó xG (`npxG`, `npxGA`, `xG/shot`, `Box Touches`, `PPDA`, `Field Tilt`)** matematikai modellel, a **„Working Formula” (65% / 25% / 10%)** bankroll-allokációval, **„No-Bet Nap / Passz”** védelemmel, automatikus **tegnapi színkódolt kiértékeléssel** és élő képleteket tartalmazó **3 munkalapos Excel (`.xlsx`) naplóval**.

---

## 🚀 1. Gyors Indítás (2 féle módon)

### A) Teljes Python FastAPI Szerver + Élő Excel Generátor Indítása (Ajánlott)
Kattints duplán az **`inditas.bat`** fájlra, vagy futtasd terminálból:
```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```
Ezután nyisd meg a böngésződben: **`http://127.0.0.1:8000`**

### B) Azonnali Megnyitás Telepítés Nélkül (Standalone Mód)
A `static/index.html` fájl közvetlenül böngészőben megnyitva is tartalmazza a teljes kliensoldali **Bivariate Poisson + Working Formula** számítási motort, így szerver indítása nélkül is azonnal kipróbálható minden funkciója!

---

## 🔑 2. Hogyan szerezz 100%-ban INGYENES API kulcsokat (0 Ft költség, bankkártya nélkül)?

A rendszer **API kulcsok megadása nélkül is azonnal működik** (a beépített Hibrid xG / Understat tudásbázis és a valósághű Szimulációs Mód segítségével). Ha élő napi piaci szorzókat és hivatalos menetrendet szeretnél bekötni **0 Ft-ért**, az alábbi 3 szolgáltató örökös ingyenes (**Free Tier**) csomagot biztosít bankkártya nélkül:

### 1. The Odds API — Élő Fogadóirodai Szorzók (`1X2`, `Over/Under`)
* **Költség:** **0 Ft (Ingyenes Free csomag: havi 500 API lekérés)** — bankkártyát NEM kér!
* **Regisztráció menete:**
  1. Nyisd meg a [https://the-odds-api.com/](https://the-odds-api.com/) weboldalt.
  2. Kattints a **„Get API Key”** gombra, majd a **Free ($0 / mo)** csomag alatt lévő **„Subscribe”** gombra.
  3. Add meg a keresztneved és az e-mail címed.
  4. Az e-mailben érkező 32 karakteres kulcsot illeszd be a webes felületen az **„🔑 Ingyenes API Kulcsok (0 Ft)”** ablakba (vagy a `.env` fájl `THE_ODDS_API_KEY=` sorába).
  * *Tipp:* Napi 1 reggeli szinkronizálással havonta csak ~30–120 kreditet használsz el az 500-ból!

### 2. Football-Data.org — Top 12 Európai Bajnokság Menetrendje és Hivatalos Végeredményei
* **Költség:** **0 Ft (Örökös Ingyenes Free Tier)** — bankkártyát NEM kér!
* **Lefedettség:** Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Bajnokok Ligája, Európa-bajnokság stb.
* **Regisztráció menete:**
  1. Nyisd meg a [https://www.football-data.org/client/register](https://www.football-data.org/client/register) oldalt.
  2. Töltsd ki a neved és e-mail címed, majd erősítsd meg a regisztrációt.
  3. Az e-mailben kapott API Tokent másold be a `FOOTBALL_DATA_API_KEY` mezőbe.

### 3. Understat (Haladó xG / PPDA / Deep Completions) & API-Football
* **Understat (`engine/data_fetcher.py`):** Teljesen nyilvános és ingyenes, **semmilyen regisztrációt vagy API kulcsot nem igényel**! A program automatikusan kinyeri belőle a csapatok `npxG`, `npxGA`, `PPDA` és `Box Touches` (Deep Completions) mutatóit.
* **API-Football (Opcionális kiegészítő — napi 100 ingyenes kérés):** Regisztrálhatsz a [https://dashboard.api-football.com/register](https://dashboard.api-football.com/register) oldalon (Free Plan, 0 Ft, bankkártya nélkül), és a kulcsot megadhatod az `API_FOOTBALL_KEY` mezőben.

---

## 🛡️ 3. Mikor NEM érdemes szelvényt megjátszani? („No-Bet Nap” és Szelektív Passz Védelem)

A rendszer egyik legfontosabb tőkevédelmi pillére, hogy **soha nem erőltet gyenge minőségű kényszer-szelvényt** (`engine/slip_builder.py`):

1. **Teljes Napi „NO-BET NAP” Riasztás (0 Ft kockázat):**
   * Ha egy adott napon (pl. uborkaszezonban vagy kiszámíthatatlan kupafordulók idején) a kínálatban **nincs legalább 2 olyan mérkőzés**, amely elérné a minimum **65%-os modell-valószínűséget ($P_{model} \ge 65\%$)** és a **2.00–3.00** közötti cél eredő szorzót az **1. Alap (Magszelvény)** számára, a rendszer piros **`⚠️ MA NEM AJÁNLOTT FOGADNI (NO-BET NAP)`** riasztást ad, és a napi tét **100%-át a bankrollban tartja**.
2. **Szelvényenkénti „PASSZ (Nem ajánlott)” Védelem:**
   * Ha a Magszelvény (65% tét) biztonságosan kiállítható, de a **2. A Szelvényhez** (min. 4 láb $P_{model} \ge 62\%$) vagy a **3. B Szelvényhez** (pozitív várható érték: $EV > 0$) nincs elég olyan mérkőzés, amely a korreláció-védelmi korlátot (`max_shared_matches = 1`) is teljesíti, akkor **csak az adott gyenge szelvényt passzolja el**, a rá szánt 25% vagy 10% tét pedig megmarad a bankrollodban!
   * *Kipróbálás a felületen:* A felső menüsáv **„Napi Kínálat Teszt”** választójával 1 kattintással válthatsz az **1. Aktív Nap**, a **2. Szelektív Nap (Részleges Passz)** és a **3. Gyenge Kínálat / No-Bet Nap** között!

---

## 📂 4. Projekt Architektúra

* `engine/model.py` — **Bivariate Poisson (`scipy.stats.poisson`) + Haladó xG Modell**: Kiszámítja a $\lambda_{home}$, $\lambda_{away}$ és $\lambda_{cov}$ paramétereket, a $8 \times 8$-as (0–7 gól) eredmény-mátrixot, valamint mind a 12 fogadási piac ($1, X, 2, 1X, X2, \text{Over } 1.5, \text{Over } 2.5, \text{BTTS}, \text{Home \& Over } 1.5, \text{Away \& Over } 1.5, 1X \text{ \& Over } 1.5, X2 \text{ \& Over } 1.5$) pontos valószínűségét ($P_{model}$), Fair Oddsát és $EV$-jét.
* `engine/slip_builder.py` — **„Working Formula” Szelvényépítő**: Felépíti a 3 napi szelvényt (65% / 25% / 10%), betartatja a `max_shared_matches = 1` korreláció-védelmet, és kezeli a No-Bet / Passz szabályokat.
* `engine/evaluator.py` — **Tegnapi Kiértékelő Motor**: Ellenőrzi a tegnapi végeredményeket, színkódolja a nyertes (`#D9EAD3` / `#274E13`) és vesztes (`#F4CCCC` / `#783F04`) sorokat, és frissíti a bankrollt.
* `engine/excel_export.py` — **Mester Excel (`.xlsx`) Szinkronizáló (`openpyxl`)**: Karbantartja a `data/kvantitativ_fogadasi_naplo.xlsx` munkafüzetet a `Tippek_Naplo`, `Szelveny_Osszesito` és `Statisztika_KPI` munkalapokkal, élő `COUNTIF`, `COUNTIFS` és `SUMIF` Excel képletekkel.
* `engine/data_fetcher.py` — **100% Ingyenes Hibrid Adatbekötő és Szimulációs Motor**.
* `engine/database.py` & `engine/scheduler.py` — **SQLite Perzisztencia és `APScheduler` Automatizált Napi Időzítő**.
* `app.py` & `static/` — **FastAPI Backend és Magyar Nyelvű Sötét Módú (Dark Mode) Analitikai Dashboard**.
