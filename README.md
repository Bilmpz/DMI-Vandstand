# DMI Vandstand

Version 2.0 · [bilmpz.github.io/DMI-Vandstand](https://bilmpz.github.io/DMI-Vandstand/)

DMI vandstand bygget med Claude

## Formål

Skriv et postnummer, og få de fem nærmeste steder med seneste måling. Siden giver adgang til alt, hvad DMI's `oceanObs` har: alle stationer, også de nedlagte, alle parametre og hele historikken. Intet sorteres fra. Det, der er usikkert, mærkes i stedet, fx et nulpunkt, som DMI ikke dokumenterer.

For et valgt sted viser siden alle måleserier i en tabel. Grafen viser én serie ad gangen sammen med DMI's prognose for de næste fem døgn, og de valgte serier kan hentes som en fil, der åbner direkte i dansk Excel.

Siden har samme opbygning som [Bilmpz/DMI](https://github.com/Bilmpz/DMI): et C#-program bygger en stationsliste, og en statisk side på GitHub Pages henter data direkte fra DMI i browseren.

![Stationsvisning på en bred skærm](screenshots/station-1280.png)

## Sådan virker det

1. Postnummeret slås op i `docs/data/postnumre.json` og bliver til en koordinat.
2. Stationerne samles i steder (se nedenfor). Afstanden til hvert sted beregnes med haversine-formlen fra postnummerets koordinat til hovedseriens station, og de fem nærmeste steder med mindst én aktiv station vises. Linket "Vis også nedlagte steder" tager steder med, der kun har nedlagte stationer.
3. Stedets side viser tabellen "Måleserier". Grafen viser den valgte serie, og fluebenet "Med i Excel" vælger serierne til filen.
4. Seneste måling, målinger i perioden og prognosen hentes direkte fra DMI, hver gang man åbner, søger eller henter.
5. Graf og tabel bygger på et datasæt med ét punkt pr. kvarter. Excel-filen kan også have rå målinger.

### Steder og måleserier

- **Sted:** alle stationer med samme navn under 3 km fra hinanden, på tværs af ejer og status. Navnene sammenlignes uden store/små bogstaver og uden " I", " II", " III" og " (Old)" til sidst. Et sted kan altså have både en nedlagt station fra 1891 og dens aktive afløser.
- **Måleserie:** én station med én parameter, fx `30018 sealev_ln`.
- **Hovedserie:** bruges til seneste måling og vises først i grafen. Den vælges blandt stedets aktive stationer i rækkefølgen `sealev_dvr`, `sea_reg` fra Kystdirektoratet, `sea_reg` fra andre og `sealev_ln`. Har stedet ingen aktiv station, vælges der på samme måde blandt de nedlagte.

### Parametre og nulpunkter

| Parameter | Hvad | Nulpunkt på siden |
| --- | --- | --- |
| `sealev_dvr` | Vandstand i cm | DVR90 |
| `sea_reg` | Vandstand i cm, som stationen registrerer den | "DVR90 ifølge DMI" for Kystdirektoratets stationer, ellers "nulpunkt ikke dokumenteret" |
| `sealev_ln` | Vandstand i cm | "lokalt nulpunkt" |
| `tw` | Vandtemperatur | "°C, vandtemperatur" |

DVR90 er Dansk Vertikal Reference 1990. Siden skriver kun "DVR90" ved serier, der er i DVR90. Er nulpunktet lokalt eller ikke dokumenteret, står der "cm" sammen med nulpunktet, også i graf, tabel og Excel-fil. To serier med forskelligt nulpunkt kan ikke sammenlignes direkte.

## Datakilder

| Data | Kilde |
| --- | --- |
| Målinger | DMI's Frie Data, `oceanObs`. Målingerne kommer fra DMI, Kystdirektoratet og havne/kommuner via DMI's Frie Data. |
| Prognose | DMI's stormflodsmodel DKSS via `forecastedr`, parameteren `sea-mean-deviation`. |
| Postnumre | [GeoNames](https://www.geonames.org/), CC BY 4.0. |

Kilde: DMI. DMI's Frie Data er udgivet under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode.da). DMI's vilkår kræver teksten "Kilde: DMI" ved rå data og "Baseret på data fra DMI og efterfølgende bearbejdet" ved bearbejdede data, og at tidspunktet for hentningen oplyses. Siden skriver begge dele i sidefoden sammen med tidspunktet. Rækker mærket "beregnet" er de bearbejdede data. DMI's API kræver ingen nøgle.

DMI skriver, at observationerne er rå data, som ikke er kvalitetssikrede og kan indeholde fejl.

## De 7 beslutninger

1. **Alt data.** Alle stationer i DMI's stationsliste er med, aktive og nedlagte, med alle ejere og alle parametre. Ejeren skrives som "DMI", "Kystdirektoratet", "Havn/kommune" (DMI skriver "Kommuner/Havne" eller "Harbours & municipalities") eller "Ikke oplyst". Usikkert nulpunkt mærkes i stedet for at blive sorteret fra.
2. **15 minutter.** Datasættet har altid punkter kl. :00, :15, :30 og :45. DMI måler hvert 10. minut, så :15 og :45 beregnes mellem nabomålingerne og mærkes "beregnet". Excel-filen kan i stedet have rå målinger.
3. **Historik.** Så langt tilbage, som serien har data. Der er ingen fast nedre grænse. De ældste målinger er fra 1889.
4. **Altid nyeste data.** Målinger og prognose hentes direkte fra DMI i browseren.
5. **Flere nulpunkter.** Hver serie viser sit eget nulpunkt, og prognosen er afvigelse fra middelvandstand. Siden viser forskellen mellem måling og prognose og retter aldrig prognosen. Prognosen vises kun sammen med en aktiv vandstandsserie.
6. **Dansk tid.** Alle tider vises i Europe/Copenhagen, også når browseren står i en anden tidszone.
7. **Ingen filtrering til hele timer.** Alle kvarterer er med.

### Regler for 15-minutters datasættet

- Findes der en måling præcis på kvarteret, bruges den: type "målt", `qcStatus` fra DMI.
- Ellers findes nærmeste måling før og efter. Ligger de højst 20 minutter fra hinanden, beregnes værdien lineært mellem dem og afrundes til 1 decimal: type "beregnet", tom `qcStatus`.
- Ellers er der ingen række for det kvarter. Siden tæller hullerne og skriver antallet under grafen.
- Målinger kl. :10, :20, :40 og :50 indgår kun i beregningen og får ikke egne rækker.

Reglerne gælder for hver serie for sig.

### Excel-filen

CSV med semikolon, decimalkomma, CRLF og UTF-8 med BOM. Én række pr. tidspunkt. For hver valgt serie er der tre kolonner, og prognosen har sin egen kolonne til sidst:

`Tid UTC; Tid dansk; {id} {parameter} ({nulpunkt}); {id} {parameter} type; {id} {parameter} qcStatus; ...; Prognose cm (middelvandstand)`

For eksempel `30017 sealev_dvr (DVR90)`. Er kun hovedserien valgt, har filen samme kolonner som før version 2.0.

- **Opløsning "15 minutter"** (standard): reglerne ovenfor, for hver serie. Type er "målt", "beregnet" eller "prognose".
- **Opløsning "Rå målinger":** alle målte tidspunkter og ingen beregnede værdier. Type er altid "målt".
- Prognosen står på hele timer, når Til er i dag. Efter seneste måling kommer der kun timerækker med type "prognose" i den første series type-kolonne.
- Serierne hentes én ad gangen i kalenderkvartaler med højst 3 kald ad gangen. Fremdriften viser serie og år.
- Har filen over 1.000.000 rækker, deles den i flere på hele år.

Filnavn: `vandstand_{sted}_{antal}-serier_{15min|raa}_{fra}_{til}.csv`, fx `vandstand_hornbaek-havn_8-serier_15min_1991-01-01_1991-12-31.csv`.

## Målt 26.11.2026

### Version 2.0

- DMI's stationsliste har 233 records for 178 stationer: 211 records med status Active og 22 med status Inactive.
- 157 stationer er aktive, og 21 er nedlagte. Pr. ejer: DMI 58 aktive og 21 nedlagte, Kystdirektoratet 48 aktive, Havn/kommune 50 aktive og Ikke oplyst 1 aktiv (28068 ODENSE FJORD).
- 22 records har status Inactive, men kun 21 stationer er nedlagte. Station 28086 har en gammel record som "ODENSE FJORD" uden ejer, men den gældende record er aktiv og hedder "Odense Kanal Stige Ø" med ejer "Kommuner/Havne".
- Stationerne har 315 måleserier: `sea_reg` på 178 stationer, `tw` på 68, `sealev_dvr` på 36 og `sealev_ln` på 33.
- Stationerne udgør 111 steder. 110 har mindst én aktiv station. Kun Nordre Røse Fyr har udelukkende en nedlagt station.
- Steder med mere end 3 stationer: Esbjerg Havn (6), Københavns Havn (6), Hirtshals Havn (4) og Slipshavn (4).
- API'et har data helt tilbage: Esbjerg Havn 25148 `sealev_ln` fra 01.01.1889 kl. 00:00 UTC, Hornbæk Havn 30018 `sealev_ln` og `sea_reg` fra 01.01.1891 og Gedser Havn 31618 `sealev_ln` fra 01.09.1891. De gamle målinger er timeværdier med `qcStatus` "manual".
- En serie kan begynde senere end stationen: 30017 `sealev_dvr` har ingen målinger i 1991, selv om stationen er fra 08.11.1991. Tabellen "Måleserier" viser stationens periode.

### Version 1.0

- 80 stationer var med i version 1.0: 32 fra DMI med `sealev_dvr` og 48 fra Kystdirektoratet med `sea_reg`.
- DKSS-modellernes gitter fra finest til grovest: `dkss_lf` ca. 170 x 185 m, `dkss_lb` og `dkss_if` ca. 175 x 309 m, `dkss_idw` ca. 877 x 927 m, `dkss_ws` ca. 1,8 km og `dkss_nsbs` ca. 5,2 x 5,6 km.
- Tre måneders målinger for Københavns Havn (30336) er 12.747 rækker og 3,7 MB JSON og tog 1,0 sekund. Et år er 51.604 rækker og 15,0 MB og tog 2,7 til 3,9 sekunder.
- Perioden hentes i kalenderkvartaler med 3 kald ad gangen. Tre år tog 4,9 sekunder i kvartaler, 6,3 i halvår og 6,6 i hele år.
- "Alt" for Københavns Havn (fra 24.06.1999) tog 40 sekunder på den deployede side. Excel-filen fik 906.429 rækker og fylder 45,7 MB.
- "Alt" for Thyborøn Havn (fra 03.10.1990) tog 47 sekunder og gav 1.228.201 rækker. Filen blev delt i to: 1990 til 2018 med 972.662 rækker og 2019 til 2026 med 255.539 rækker.
- Alle tre endpoints svarer med `Access-Control-Allow-Origin: *`, så browseren kan kalde dem direkte.

## Kør lokalt

Kræver .NET 10 SDK.

```
dotnet run --project DmiVandstand
```

Programmet skriver `docs/data/stations.json` med alle stationer: id, navn, ejer, status ("aktiv" eller "nedlagt"), koordinat, `from`, `to`, parametre og prognosepunkt. Kun aktive stationer får et prognosepunkt. Prognosepunkter genbruges fra den eksisterende fil, og stationer i samme koordinat deler punkt. Alle beregnes forfra med:

```
dotnet run --project DmiVandstand -- --refresh-forecast
```

Programmet leder efter nye prognosepunkter i højst 5 minutter. Resten skrives i `forecastPending` og prøves igen ved næste kørsel. Uden tidsgrænse:

```
dotnet run --project DmiVandstand -- --forecast-minutes=0
```

Siden skal åbnes gennem en lokal server, for eksempel:

```
npx http-server docs -p 8080
```

Åbn derefter `http://localhost:8080/`.

## Sådan virker workflowet

`.github/workflows/update-dmi.yml` kører hver halve time, ved push til `main` og manuelt. Det henter koden, installerer .NET 10, kører programmet og deployer mappen `docs/` til GitHub Pages. Den nye `stations.json` bliver ikke committet. Den ligger kun i den deployede side. Nye prognosepunkter skal derfor beregnes lokalt og committes, ellers ledes der efter dem i hver kørsel.

Svarer DMI ikke, eller finder programmet under 30 stationer, overskriver det ikke filen. Det skriver en advarsel i workflowet og afslutter med kode 0, så siden stadig deployes med den committede fil.

GitHub slår planlagte workflows fra i et offentligt repo, når der ikke har været aktivitet i repoet i 60 dage. Så bliver stationslisten ikke længere opdateret, men siden virker stadig, og målinger og prognose hentes fortsat live fra DMI. Workflowet slås til igen under Actions med "Enable workflow" eller med `gh workflow enable update-dmi.yml`. GitHub oplyser også, at planlagte kørsler kan blive forsinket eller sprunget over, når der er travlt.

## Kendte begrænsninger

- **Rå data med fejl.** Siden viser DMI's målinger uden at filtrere dem. Københavns Havn har for eksempel +325 cm den 25.12.2025 kl. 21:30 mellem to målinger på −18 og −19 cm, og +777 cm den 24.11.2015. En fejlmåling kl. :10 eller :20 påvirker også den beregnede værdi kl. :15.
- **Nulpunkter.** Prognosen er afvigelse fra middelvandstand og er ikke omregnet. `sealev_ln` er i et lokalt nulpunkt, og DMI dokumenterer ikke nulpunktet for `sea_reg` fra andre end Kystdirektoratet. Siden skriver nulpunktet ved hver serie og den gennemsnitlige forskel mellem måling og prognose.
- **Seriens periode er stationens.** DMI's stationsliste har ingen periode pr. parameter. Tabellen "Måleserier" viser derfor stationens periode, og en serie kan begynde senere.
- **Prognosepunktet kan ligge langt væk.** Punktet er det nærmeste gitterpunkt med værdier i den fineste model, der dækker stationen. Ringkøbing Havn (14,4 km), Nees (8,1 km) og Thorsminde Fjord (5,2 km) ligger i fjorde bag sluser og får et punkt i Nordsøen. Siden skriver afstanden og advarer, når den er over 5 km.
- **DMI svarer nogle gange 429 ("Server is busy").** Det er set på både prognoser og målinger. En bid af perioden, der fejler, prøves igen 2 gange med 3 og 8 sekunders pause, og de andre kald venter imens. Bidder, der stadig mangler, prøves en sidste gang, når resten er hentet. Mangler der derefter noget, skriver siden, hvilken periode og serie det er. Prognosen prøves igen 2 gange. Browseren skriver et 429-svar som en fejl i konsollen, også når det næste forsøg lykkes.
- **Ældre data er grovere.** Før midten af 2001 er der målt hvert 15., 30. eller 60. minut. Timedata giver kun rækker på hele timer, og de øvrige kvarterer tælles som huller.
- **Lange perioder er tunge.** "Alt" henter over en million målinger for de ældste serier. Med alle serier valgt kan det være for meget for en telefon.
- **De nyeste kvarterer.** DMI's målinger kommer med 5 til 20 minutters forsinkelse. Kvarterer uden måling tælles derfor kun frem til 30 minutter før nu.
- **Datoer skrives i hånden** som dd.mm.åååå. Der er ingen kalender.
- **Afstanden er i fugleflugt** fra postnummerets koordinat til stedets hovedserie.
- **Tabeller på smalle skærme.** Tabellerne "Måleserier" og "Seneste rækker" kan rulles vandret inde i deres ramme. Siden selv ruller ikke vandret.
- **Ikke med:** søer og vandløb, kort, login, database og notifikationer.

## Filer

| Sti | Indhold |
| --- | --- |
| `DmiVandstand/` | C#-konsolprogram (.NET 10), der bygger stationslisten |
| `docs/index.html`, `docs/style.css`, `docs/app.js` | Siden. Ingen byggeværktøjer og ingen frameworks |
| `docs/data/stations.json` | Alle stationer med ejer, status, koordinat, periode, parametre og prognosepunkt |
| `docs/data/postnumre.json` | 1.154 postnumre med koordinater |
| `docs/vendor/` | Chart.js 4.6.2 (MIT-licens) |
| `docs/fonts/` | Source Sans 3 (SIL Open Font License) |
| `screenshots/` | Skærmbilleder i 390 px og 1280 px bredde fra version 1.0 |
| `.github/workflows/update-dmi.yml` | Workflow, der opdaterer stationslisten og deployer siden |

Made by Oliver Lobel
