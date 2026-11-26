# DMI Vandstand

Version 3.0 · [bilmpz.github.io/DMI-Vandstand](https://bilmpz.github.io/DMI-Vandstand/)

Skriv et postnummer, og se vandstanden ved de fem nærmeste målesteder og havne. Siden viser seneste måling, historik og DMI's prognose for de næste fem døgn, og alt kan hentes som en fil til Excel.

## Kilder

| Kilde | Land | Hvad | Nøgle | Nulpunkt på siden | Historik |
| --- | --- | --- | --- | --- | --- |
| DMI, `oceanObs` | Danmark | 178 målere fra DMI, Kystdirektoratet og havne/kommuner | Nej | DVR90, DVR90 ifølge DMI, lokalt nulpunkt eller "nulpunkt ikke dokumenteret" | Fra 1889 |
| SMHI | Sverige | 60 aktive målere fra SMHI og Sjöfartsverket | Nej | cm RH2000 (hovedserie) og cm, middelvandstand (SMHI) | Timeværdier fra 1886, minutværdier fx fra 2009 i Helsingborg |
| PEGELONLINE (WSV) | Tyskland | 50 målere i Østersøen og Nordsøen | Nej | cm NHN (omregnet fra pegelnul) | Ca. 30 dage |
| Kystatlas (Kystdirektoratet) | Danmark | 2 målere, som DMI ikke har: Thyborøn Havn (radar) og Hvide Sande Indsejling (tryk) | Nej | DVR90 | 30 dage på siden |
| DMI, tidevand | Danmark | Beregnet tidevand for 112 danske steder | Nej | Nulpunkt ikke oplyst af DMI | 31.12.2025 til udgangen af 2027 |
| DMI, DKSS | Danmark | Prognose for fem døgn, også i havne uden måler | Nej | Afvigelse fra middelvandstand | Kun prognose |
| Open-Meteo | Global model | Valgfri ekstra model med groft gitter (ca. 8 km) | Nej | cm, middelvandstand | Fra 23.11.2022 og 7 døgn frem |

Alle kilder undtagen Kystatlas hentes direkte i browseren. Kystatlas sender ingen CORS-header, så workflowet henter de seneste 30 døgn hver halve time til `docs/data/obs/kystatlas/`.

Havne uden måler står i `docs/data/havne.json` med koordinater fra OpenStreetMap. Tilføj en havn med id, navn og koordinat, så finder programmet selv et prognosepunkt i DKSS.

## Målt 26.11.2026

- **CORS:** DMI, SMHI, PEGELONLINE og Open-Meteo svarer med `Access-Control-Allow-Origin: *`. Kystatlas gør ikke.
- **SMHI:** parameter 6 (timeværdier) og 13 (minutværdier) er i RH 2000. Arkivfilen skriver "Höjdsystem: RH2000". 12 og 14 ("RW") har ikke den linje og er i forhold til middelvandstand. Minutværdier ældre end et døgn findes kun i arkivfilen for hele stationen, for Helsingborg 19 MB komprimeret. Siden læser den linje for linje og stopper, når perioden er nået. Perioder, der slutter mere end 92 dage tilbage, hentes som timeværdier fra det mindre timearkiv. SMHI leverer nye målinger i timeblokke, så seneste måling kan være op til ca. 75 minutter gammel. Ældste måling: Kungsholmsfort 01.12.1886.
- **DMI's tidevand:** 220 steder, heraf 112 danske. Der er en værdi hvert 10. minut samt høj- og lavvande. DMI oplyser ikke nulpunktet i API'et.
- **Open-Meteo:** giver værdier i Øresund, men gitterpunktet kan ligge 13–18 km fra havnen. Open-Meteo skriver, at data ikke egner sig til sejlads tæt på kysten.
- **PEGELONLINE:** minutværdier ca. 31 døgn tilbage. Alle 50 målere har et pegelnul i NHN, så siden omregner til cm NHN.
- **Kystatlas:** 49 målere, hvoraf 46 også er hos DMI. Esbjerg (Zodiak Spulefelt) stod stille på 349–350 cm og kommer ikke med. Arkivet har historik fra 1972 for nogle vestkyststationer, som DMI først har fra 1990. Den er ikke med, fordi plan B kun giver 30 døgn.
- **EMODnet Physics:** sender kun DMI's og Kystdirektoratets data videre, og de levende data stoppede i november 2024. Ikke med.

## Kør lokalt

```
dotnet run --project DmiVandstand
npx http-server docs -p 8080
```

Programmet skriver `docs/data/stations.json` og Kystatlas-filerne. Nye prognosepunkter kan tage lang tid, fordi DMI's prognose-API ofte svarer 429. Uden tidsgrænse: `dotnet run --project DmiVandstand -- --forecast-minutes=0`.

## Licenser

- Kilde: DMI. DMI's Frie Data, CC BY 4.0.
- SMHI er kilden til de svenske målinger, CC BY 4.0. Værdierne er bearbejdet til 15 minutter.
- WSV, PEGELONLINE, Datenlizenz Deutschland Zero 2.0.
- Kystdirektoratet, Kystatlas, CC BY 4.0.
- Open-Meteo.com, CC BY 4.0, baseret på E.U. Copernicus Marine Service Information.
- Havnenes placering: © OpenStreetMap-bidragydere, ODbL. `docs/data/havne.json` er derfor også under ODbL.
- Postnumre: GeoNames, CC BY 4.0.
