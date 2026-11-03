# ☁️ QUANTFOOTBALL PRO — 0–24 Órás Ingyenes Felhős Weboldal Útmutató (2 perc)

A rendszered mostantól tartalmazza a teljes **GitHub Actions + GitHub Pages** felhős automatikát, amely **100%-ban ingyenes (0 Ft)**, és **akkor is minden nap magától fut a felhőben, ha a számítógéped ki van kapcsolva**.

---

## ⚙️ Hogyan működik a Kétlépcsős Napi Automatika?

1. **1. Lépcső — Minden reggel 08:00-kor (`📝 REGGELI TERVEZET / DRAFT`):**
   - A felhős motor ([`cloud_runner.js`](file:///c:/Users/Sima%20%C3%81d%C3%A1m/Desktop/Sportsbetting/cloud_runner.js)) automatikusan lekéri az előző napi mérkőzések hivatalos végeredményeit (**The Odds API** + **Football-Data.org**).
   - Zöld (`#D9EAD3` — **Nyert**) és piros (`#F4CCCC` — **Veszített**) színkódolással kiértékeli az előző napi szelvényeket, és frissíti az **5 000 Ft**-os kezdő bankrollodat.
   - Lekéri a mai és holnapi mérkőzéseket, elmenti a reggeli nyitó szorzókat (`opening_odds_map`), és felépíti a 3 napi **TERVEZET (DRAFT)** szelvényt (`65% / 25% / 10%`).
   - Megnézi a szelvényeken szereplő legkorábbi mérkőzés kezdési időpontját, és beállítja a véglegesítési időpontot **pontosan 1 órával a legkorábbi meccs kezdete elé**.

2. **2. Lépcső — Meccs kezdete előtt 1 órával (`🔒 VÉGLEGESÍTŐ MÉLYELEMZÉS / FINAL`):**
   - Pontosan 1 órával a legkorábbi szelvény-mérkőzés kezdete előtt a rendszer újra lefut:
     - **Hiányzók és sérülések ellenőrzése (`API-Football /injuries`):** Megvizsgálja, került-e fel kulcsjátékos a sérült/hiányzó listára.
     - **Meccs előtti szorzómozgás (`Closing Line Movement`):** Összehasonlítja a reggel 08:00-as nyitó szorzót a meccs előtti 1 órás szorzóval. Ha a piac a csapatunk ellen mozdult el (pl. váratlan hiányzó a kezdőcsapatból), a modell csökkenti a várható gólokat ($\lambda$).
   - **Automatikus csere & Változásnapló:** Ha egy reggeli Tervezet-meccs a hiányzók vagy szorzóromlás miatt a biztonsági küszöb alá esik, a rendszer **automatikusan lecseréli** egy biztonságos alternatívára (vagy `Passz`-ra állítja a szelvényt), kiírja a felületre a **Tervezet ➔ Végleges változásnaplót**, és **VÉGLEGESÍTI (`🔒 VÉGLEGES`)** a 3 szelvényt.

---

## 🚀 Hogyan tedd ki élő weboldalként 2 perc alatt (0 Ft)?

### A) Ha van Git a gépeden (1 kattintás):
1. Hozz létre egy ingyenes fiókot a [https://github.com](https://github.com) oldalon, majd kattints a jobb felső **`+` ➔ `New repository`** gombra (nevezd el pl. `quantfootball`-nak).
2. Kattints duplán a mappádban lévő **[`FELHO_FELTOLTES.bat`](file:///c:/Users/Sima%20%C3%81d%C3%A1m/Desktop/Sportsbetting/FELHO_FELTOLTES.bat)** fájlra, és illeszd be a tárolód linkjét!

### B) Böngészőből (Git telepítése nélkül):
1. A [https://github.com/new](https://github.com/new) oldalon hozz létre egy új tárolót (`quantfootball`), és pipáld be az **`Add a README file`** opciót.
2. Kattints az **`Add file` ➔ `Upload files`** gombra, és húzd bele a `Sportsbetting` mappád összes fájlját és almappáját (`.github`, `data`, `static`, `engine`, `index.html`, `cloud_runner.js`), majd nyomj a zöld **`Commit changes`** gombra.

### Weboldal-link bekapcsolása (GitHub Pages):
1. A GitHub tárolódban kattints a felső **`Settings`** fülre, majd bal oldalt a **`Pages`** menüpontra.
2. A **Branch** résznél válaszd ki a **`main`** ágat és a **`/ (root)`** mappát, majd kattints a **`Save`** gombra.
3. **Kész!** 1 percen belül megjelenik a saját élő weboldalad linkje (`https://<felhasznaloneved>.github.io/quantfootball/`), amelyet telefonról vagy bármelyik gépről bármikor megnyithatsz, a **GitHub Actions** ([`.github/workflows/daily_quant_cloud.yml`](file:///c:/Users/Sima%20%C3%81d%C3%A1m/Desktop/Sportsbetting/.github/workflows/daily_quant_cloud.yml)) pedig minden nap **08:00-kor** és **meccs előtt 1 órával** automatikusan frissíti!
