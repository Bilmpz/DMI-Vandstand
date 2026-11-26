using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Unicode;

// DMI Vandstand: bygger docs/data/stations.json med alle stationer fra DMI (aktive og nedlagte), aktive svenske
// stationer fra SMHI, tyske stationer fra PEGELONLINE, DMI's tidevandssteder og havnene i havne.json.
// Til hver aktiv station og havn findes et prognosepunkt i DMI's stormflodsmodel DKSS.
//
// Kør fra repoets rod:   dotnet run --project DmiVandstand
// Beregn alle prognosepunkter forfra:   dotnet run --project DmiVandstand -- --refresh-forecast
// Uden tidsgrænse for prognosepunkter:  dotnet run --project DmiVandstand -- --forecast-minutes=0

internal static class Program
{
    private const int StationsLimit = 10000;

    // Både aktive og nedlagte stationer hentes. Uden status-filter giver DMI også begge, men hver for sig er tydeligst.
    private static readonly string[] StationsUrls =
    [
        "https://opendataapi.dmi.dk/v2/oceanObs/collections/station/items?status=Active&limit=10000",
        "https://opendataapi.dmi.dk/v2/oceanObs/collections/station/items?status=Inactive&limit=10000",
    ];
    private const string ForecastBase = "https://opendataapi.dmi.dk/v1/forecastedr/collections";
    private const string OceanBase = "https://opendataapi.dmi.dk/v2/oceanObs/collections";
    private const string SmhiBase = "https://opendata-download-ocobs.smhi.se/api/version/latest";
    private const string PegelBase = "https://www.pegelonline.wsv.de/webservices/rest-api/v2";

    private const string SourceDmi = "DMI";
    private const string SourceSmhi = "SMHI";
    private const string SourcePegel = "PEGELONLINE";
    private const string SourceTide = "DMI tidevand";
    private const string SourceKystatlas = "Kystatlas";
    private const string KystatlasBase = "https://kystatlas.kyst.dk/data/vandstand";
    private const int KystatlasDays = 30;
    private const string ForecastParameter = "sea-mean-deviation";

    // Parametrene vises i denne rækkefølge. Andre parametre kommer bagefter i alfabetisk orden.
    private static readonly string[] ParameterOrder = ["sealev_dvr", "sea_reg", "sealev_ln", "tw"];

    private const string StatusActive = "aktiv";
    private const string StatusClosed = "nedlagt";

    // DMI skriver havnenes og kommunernes ejer på dansk eller engelsk.
    private static readonly HashSet<string> HarbourOwners =
        new(["Kommuner/Havne", "Harbours & municipalities"], StringComparer.OrdinalIgnoreCase);

    // DMI's prognose-API svarer nogle gange 429 i lang tid. Så må en kørsel i workflowet ikke hænge.
    private const int DefaultForecastMinutes = 5;

    // Under dette antal stationer er svaret fra DMI ikke til at stole på, og filen overskrives ikke.
    private const int MinStations = 30;

    // DKSS-modeller fra finest til grovest. Gitterafstanden er målt 26.11.2026 med cube-kald:
    // lf ca. 170 x 185 m, lb og if ca. 175 x 309 m, idw ca. 877 x 927 m, ws ca. 1,8 km, nsbs ca. 5,2 x 5,6 km.
    // Områderne (venstre, bund, højre, top) er reserve, hvis collection-metadata ikke kan hentes.
    private static readonly ModelInfo[] DefaultModels =
    [
        new("dkss_lf", 8.138, 56.461, 10.385, 57.109),
        new("dkss_lb", 9.493, 55.246, 10.018, 55.710),
        new("dkss_if", 11.613, 55.654, 12.124, 55.976),
        new("dkss_idw", 9.340, 53.587, 14.826, 57.596),
        new("dkss_ws", 6.181, 53.225, 10.486, 55.692),
        new("dkss_nsbs", -4.125, 48.525, 30.292, 65.875),
    ];

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        NewLine = "\n", // samme fil på Windows og Linux
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        // Tal i loggen skrives med punktum, uanset maskinens sprog. JSON-filen er altid uafhængig af sprog.
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        bool refreshForecast = args.Contains("--refresh-forecast");
        // Prognosepunkter ledes efter i højst så mange minutter (0 = ingen grænse). Resten prøves igen ved næste kørsel.
        int forecastMinutes = DefaultForecastMinutes;
        foreach (string arg in args.Where(a => a.StartsWith("--forecast-minutes=", StringComparison.Ordinal)))
            forecastMinutes = int.Parse(arg["--forecast-minutes=".Length..], CultureInfo.InvariantCulture);

        try
        {
            return await RunAsync(refreshForecast, TimeSpan.FromMinutes(forecastMinutes));
        }
        catch (Exception ex)
        {
            // Siden skal stadig kunne deployes med den committede stations.json.
            Warn($"DMI svarede ikke, eller svaret kunne ikke bruges: {ex.Message} stations.json er ikke ændret.");
            return 0;
        }
    }

    private static async Task<int> RunAsync(bool refreshForecast, TimeSpan forecastBudget)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(120) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("DmiVandstand/3.0");
        var dmi = new DmiClient(http);

        string dataDir = ResolveDocsDataDirectory();
        string stationsFile = Path.Combine(dataDir, "stations.json");
        string harboursFile = Path.Combine(dataDir, "havne.json");
        Console.WriteLine($"Fil: {stationsFile}");
        var existing = ReadExisting(stationsFile);
        var now = DateTimeOffset.UtcNow;
        var sources = new List<SourceOut>();

        // 1. DMI. Uden DMI's stationer skrives filen ikke.
        List<StationOut> dmiStations;
        try
        {
            dmiStations = await BuildDmiStationsAsync(dmi, now);
            if (dmiStations.Count < MinStations)
                throw new InvalidOperationException($"Kun {dmiStations.Count} stationer fundet (mindst {MinStations} forventet).");
            sources.Add(new SourceOut { Name = SourceDmi, Ok = true, Stations = dmiStations.Count });
        }
        catch (Exception ex)
        {
            dmiStations = Kept(existing, SourceDmi);
            if (dmiStations.Count < MinStations)
            {
                Warn($"DMI svarede ikke, eller svaret kunne ikke bruges: {ex.Message} stations.json er ikke ændret.");
                return 0;
            }
            Warn($"DMI's stationsliste kunne ikke hentes: {ex.Message} De {dmiStations.Count} stationer fra den eksisterende fil beholdes.");
            sources.Add(new SourceOut { Name = SourceDmi, Ok = false, Stations = dmiStations.Count, Message = ex.Message });
        }

        // 2. SMHI og PEGELONLINE. Fejler en kilde, beholdes dens stationer fra den eksisterende fil.
        var smhi = await TrySourceAsync(SourceSmhi, () => BuildSmhiStationsAsync(dmi, now), existing, sources);
        var pegel = await TrySourceAsync(SourcePegel, () => BuildPegelStationsAsync(dmi), existing, sources);
        // Kystatlas sender ingen CORS-header. Workflowet henter derfor de seneste 30 døgn til docs/data/obs/kystatlas.
        var kystatlas = await TrySourceAsync(
            SourceKystatlas, () => BuildKystatlasAsync(dmi, dmiStations, Path.Combine(dataDir, "obs", "kystatlas")), existing, sources);

        var danish = StringComparer.Create(CultureInfo.GetCultureInfo("da-DK"), ignoreCase: false);
        var selected = dmiStations.Concat(smhi).Concat(pegel).Concat(kystatlas)
            .OrderBy(s => s.Name, danish)
            .ThenBy(s => s.Id, StringComparer.Ordinal)
            .ToList();

        foreach (var g in selected.GroupBy(s => (s.Source, s.Owner, s.Status)).OrderBy(g => g.Key.Source).ThenBy(g => g.Key.Owner).ThenBy(g => g.Key.Status))
            Console.WriteLine($"  {g.Key.Source}, {g.Key.Owner}, {g.Key.Status}: {g.Count()} stationer, {g.Sum(s => s.Parameters.Count)} måleserier");

        // 3. DMI's tidevand (kun danske steder)
        List<TideOut> tides;
        try
        {
            tides = await BuildTidesAsync(dmi);
            sources.Add(new SourceOut { Name = SourceTide, Ok = true, Stations = tides.Count });
            Console.WriteLine($"  Tidevand: {tides.Count} danske steder");
        }
        catch (Exception ex)
        {
            tides = existing?.Tides ?? [];
            Warn($"DMI's tidevandssteder kunne ikke hentes: {ex.Message} De {tides.Count} steder fra den eksisterende fil beholdes.");
            sources.Add(new SourceOut { Name = SourceTide, Ok = false, Stations = tides.Count, Message = ex.Message });
        }

        // 4. Havne uden måler fra havne.json
        var harbours = ReadHarbours(harboursFile);
        Console.WriteLine($"  Havne uden måler: {harbours.Count}");

        // 5. Prognosepunkter. Danske aktive stationer og havne får et punkt i den fineste model.
        //    Udenlandske stationer får kun et punkt i de fine modeller, ikke i den grove dkss_nsbs.
        var pending = await AssignForecastsAsync(dmi, selected, harbours, existing, refreshForecast, forecastBudget);

        foreach (var g in selected.Where(s => s.Status == StatusActive).GroupBy(s => (s.Source, s.Forecast?.Model ?? "ingen")).OrderBy(g => g.Key))
            Console.WriteLine($"  Prognosemodel {g.Key.Source} {g.Key.Item2}: {g.Count()} stationer");

        // 6. Skriv filen (UTF-8 uden BOM).
        var output = new StationsFile
        {
            GeneratedUtc = now.UtcDateTime.ToString("yyyy-MM-dd'T'HH':'mm':'ss'Z'", CultureInfo.InvariantCulture),
            Sources = sources,
            Stations = selected,
            Tides = tides,
            Harbours = harbours,
            ForecastChecked = ForecastCheckedOut,
            ForecastPending = pending.Distinct().OrderBy(id => id, StringComparer.Ordinal).ToList(),
        };

        Directory.CreateDirectory(Path.GetDirectoryName(stationsFile)!);
        string temp = stationsFile + ".tmp";
        await File.WriteAllTextAsync(
            temp,
            JsonSerializer.Serialize(output, JsonOptions) + "\n",
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        File.Move(temp, stationsFile, overwrite: true);

        Console.WriteLine(
            $"Skrevet {selected.Count} stationer, {tides.Count} tidevandssteder og {harbours.Count} havne til {stationsFile} ({dmi.Calls} kald).");
        return 0;
    }

    // Stationer fra den eksisterende fil for én kilde. Filer fra før version 3.0 har kun DMI og intet source-felt.
    private static List<StationOut> Kept(StationsFile? existing, string source)
    {
        var list = new List<StationOut>();
        foreach (var s in existing?.Stations ?? [])
        {
            if (string.IsNullOrEmpty(s.Source))
            {
                s.Source = SourceDmi;
                s.Country = "DK";
            }
            if (s.Source == source) list.Add(s);
        }
        return list;
    }

    private static async Task<List<StationOut>> TrySourceAsync(
        string name, Func<Task<List<StationOut>>> build, StationsFile? existing, List<SourceOut> sources)
    {
        try
        {
            var list = await build();
            if (list.Count == 0) throw new InvalidOperationException("ingen stationer i svaret.");
            sources.Add(new SourceOut { Name = name, Ok = true, Stations = list.Count });
            return list;
        }
        catch (Exception ex)
        {
            var kept = Kept(existing, name);
            Warn($"{name} kunne ikke hentes: {ex.Message} De {kept.Count} stationer fra den eksisterende fil beholdes.");
            sources.Add(new SourceOut { Name = name, Ok = false, Stations = kept.Count, Message = ex.Message });
            return kept;
        }
    }

    // ---------- DMI ----------

    private static async Task<List<StationOut>> BuildDmiStationsAsync(DmiClient dmi, DateTimeOffset now)
    {
        Console.WriteLine("Henter stationsliste fra DMI ...");
        var records = new List<StationRecord>();
        foreach (string url in StationsUrls)
            records.AddRange(await FetchStationRecordsAsync(dmi, url));
        var byStation = records.GroupBy(r => r.StationId).ToList();
        Console.WriteLine($"Records: {records.Count}. Unikke stationer: {byStation.Count}.");

        var selected = new List<StationOut>();
        foreach (var group in byStation)
        {
            var current = group.FirstOrDefault(r => r.ValidTo is null)
                          ?? group.OrderByDescending(r => r.ValidFrom ?? DateTimeOffset.MinValue).First();

            // Uden koordinat kan stationen ikke findes fra et postnummer. Det er ikke set 26.11.2026.
            var positioned = current.Lat is not null && current.Lon is not null
                ? current
                : group.Where(r => r.Lat is not null && r.Lon is not null)
                       .OrderByDescending(r => r.ValidFrom ?? DateTimeOffset.MinValue)
                       .FirstOrDefault();
            if (positioned is null)
            {
                Warn($"Station {current.StationId} {current.Name} har ingen koordinat og kommer ikke med.");
                continue;
            }

            bool closed = current.Status.Equals("Inactive", StringComparison.OrdinalIgnoreCase) ||
                          (current.OperationTo is { } operationTo && operationTo < now);

            var fromDates = group
                .SelectMany(r => new[] { r.OperationFrom, r.ValidFrom })
                .Where(d => d.HasValue)
                .Select(d => d!.Value)
                .ToList();
            string from = Day(fromDates.Count > 0 ? fromDates.Min() : now);

            string? to = null;
            if (closed)
            {
                var end = current.OperationTo
                          ?? group.Select(r => r.OperationTo ?? r.ValidTo).Where(d => d.HasValue).Max();
                to = end is { } e ? Day(e) : null;
            }

            var parameters = group
                .SelectMany(r => r.Parameters)
                .Distinct(StringComparer.Ordinal)
                .OrderBy(x => Array.IndexOf(ParameterOrder, x) is int k && k >= 0 ? k : ParameterOrder.Length)
                .ThenBy(x => x, StringComparer.Ordinal)
                .ToList();

            selected.Add(new StationOut
            {
                Id = current.StationId,
                Name = current.Name,
                Source = SourceDmi,
                Country = "DK",
                Owner = OwnerName(current.Owner),
                Status = closed ? StatusClosed : StatusActive,
                Lat = Math.Round(positioned.Lat!.Value, 4),
                Lon = Math.Round(positioned.Lon!.Value, 4),
                From = from,
                To = to,
                Parameters = parameters,
            });
        }

        Console.WriteLine($"DMI: {selected.Count} stationer og {selected.Sum(s => s.Parameters.Count)} måleserier.");
        return selected;
    }

    // ---------- SMHI ----------

    // Parameter 6 og 13 er i RH 2000 (arkivfilen skriver "Höjdsystem: RH2000"). 12 og 14 ("RW") er i forhold til
    // middelvandstand. 6 og 12 er timeværdier, 13 og 14 minutværdier.
    private static async Task<List<StationOut>> BuildSmhiStationsAsync(DmiClient dmi, DateTimeOffset now)
    {
        Console.WriteLine("Henter stationsliste fra SMHI ...");
        var byKey = new Dictionary<string, SmhiStation>(StringComparer.Ordinal);
        foreach (var (param, series) in new[] { ("13", "smhi_rh2000"), ("6", "smhi_rh2000"), ("14", "smhi_mw"), ("12", "smhi_mw") })
        {
            using var doc = await dmi.GetJsonAsync($"{SmhiBase}/parameter/{param}.json");
            foreach (var s in doc.RootElement.GetProperty("station").EnumerateArray())
            {
                string key = s.GetProperty("key").GetString() ?? "";
                if (key.Length == 0 || !s.GetProperty("active").GetBoolean()) continue;
                if (!byKey.TryGetValue(key, out var st))
                {
                    st = new SmhiStation
                    {
                        Key = key,
                        Name = s.GetProperty("name").GetString() ?? key,
                        Owner = s.GetProperty("owner").GetString() ?? "",
                        Lat = s.GetProperty("latitude").GetDouble(),
                        Lon = s.GetProperty("longitude").GetDouble(),
                    };
                    byKey[key] = st;
                }
                st.Series.Add(series);
                long from = s.GetProperty("from").GetInt64();
                if (st.FromMs == 0 || from < st.FromMs) st.FromMs = from;
            }
        }

        var list = byKey.Values.Select(s => new StationOut
        {
            Id = "SE-" + s.Key,
            SourceId = s.Key,
            Name = s.Name.Trim(),
            Source = SourceSmhi,
            Country = "SE",
            Owner = s.Owner.Trim(),
            Status = StatusActive,
            Lat = Math.Round(s.Lat, 4),
            Lon = Math.Round(s.Lon, 4),
            From = Day(DateTimeOffset.FromUnixTimeMilliseconds(s.FromMs)),
            Parameters = new[] { "smhi_rh2000", "smhi_mw" }.Where(s.Series.Contains).ToList(),
        }).ToList();
        Console.WriteLine($"SMHI: {list.Count} aktive stationer og {list.Sum(s => s.Parameters.Count)} måleserier.");
        return list;
    }

    private sealed class SmhiStation
    {
        public string Key = "";
        public string Name = "";
        public string Owner = "";
        public double Lat;
        public double Lon;
        public long FromMs;
        public HashSet<string> Series = new(StringComparer.Ordinal);
    }

    // ---------- PEGELONLINE ----------

    // Tyske målere i Østersøen og Nordsøen. Vandstanden er i cm over pegelnul. Har stationen et pegelnul i NHN,
    // gemmes det, så siden kan omregne til cm NHN. PEGELONLINE har kun ca. 30 dage tilbage.
    private static async Task<List<StationOut>> BuildPegelStationsAsync(DmiClient dmi)
    {
        Console.WriteLine("Henter stationsliste fra PEGELONLINE ...");
        using var doc = await dmi.GetJsonAsync($"{PegelBase}/stations.json?waters=OSTSEE,NORDSEE&includeTimeseries=true");
        var list = new List<StationOut>();
        foreach (var s in doc.RootElement.EnumerateArray())
        {
            if (!s.TryGetProperty("latitude", out var la) || !s.TryGetProperty("longitude", out var lo)) continue;
            double lat = la.GetDouble(), lon = lo.GetDouble();
            if (lat == 0 && lon == 0) continue; // fx MINSENER OOG har ingen koordinat

            JsonElement? w = null;
            if (s.TryGetProperty("timeseries", out var ts))
                foreach (var t in ts.EnumerateArray())
                    if (t.GetProperty("shortname").GetString() == "W") w = t;
            if (w is null) continue;

            double? gaugeZero = null;
            string? gaugeZeroFrom = null;
            if (w.Value.TryGetProperty("gaugeZero", out var gz) &&
                (gz.GetProperty("unit").GetString() ?? "").Contains("NHN", StringComparison.OrdinalIgnoreCase))
            {
                gaugeZero = gz.GetProperty("value").GetDouble();
                gaugeZeroFrom = gz.TryGetProperty("validFrom", out var vf) ? vf.GetString() : null;
            }

            string name = s.GetProperty("longname").GetString() ?? "";
            list.Add(new StationOut
            {
                Id = "DE-" + s.GetProperty("number").GetString(),
                SourceId = s.GetProperty("uuid").GetString(),
                Name = TitleCase(name),
                Source = SourcePegel,
                Country = "DE",
                Owner = "WSV",
                Water = s.GetProperty("water").GetProperty("shortname").GetString(),
                Status = StatusActive,
                Lat = Math.Round(lat, 4),
                Lon = Math.Round(lon, 4),
                From = "",
                Parameters = ["W"],
                GaugeZeroNhn = gaugeZero,
                GaugeZeroFrom = gaugeZeroFrom,
            });
        }
        Console.WriteLine($"PEGELONLINE: {list.Count} stationer ({list.Count(s => s.GaugeZeroNhn is not null)} med pegelnul i NHN).");
        return list;
    }

    // "KIEL-HOLTENAU" -> "Kiel-Holtenau", "LIST AUF SYLT" -> "List auf Sylt"
    private static string TitleCase(string upper)
    {
        var small = new HashSet<string>(["auf", "am", "an", "der", "die", "das", "im", "in", "bei"], StringComparer.Ordinal);
        var words = upper.Trim().ToLower(new CultureInfo("de-DE")).Split(' ', StringSplitOptions.RemoveEmptyEntries);
        for (int i = 0; i < words.Length; i++)
        {
            if (i > 0 && small.Contains(words[i])) continue;
            words[i] = string.Join("-", words[i].Split('-').Select(p => p.Length == 0 ? p : char.ToUpper(p[0], CultureInfo.InvariantCulture) + p[1..]));
        }
        return string.Join(" ", words);
    }

    // ---------- Kystatlas (Kystdirektoratet) ----------

    // Kystatlas har målere, som ikke er i DMI's liste (fx Thyborøn Havn radar og Hvide Sande Indsejling).
    // Kun dem kommer med. DMI's id for en Kystdirektoratet-måler er "9" + Kystatlas-id med 6 cifre.
    // Tiden i Kystatlas er dansk normaltid (UTC+1), vandstanden er i hele cm DVR90, koordinaten i UTM32 (ETRS89).
    private static async Task<List<StationOut>> BuildKystatlasAsync(DmiClient client, List<StationOut> dmiStations, string obsDir)
    {
        Console.WriteLine("Henter målerliste fra Kystatlas ...");
        var dmiIds = new HashSet<string>(dmiStations.Select(s => s.Id), StringComparer.Ordinal);
        string list = await client.GetTextAsync($"{KystatlasBase}/vandstandmaalere_ident.txt");
        var today = DateTime.UtcNow.Date;
        var result = new List<StationOut>();
        Directory.CreateDirectory(obsDir);

        foreach (string raw in list.Split('\n'))
        {
            // "Thyborøn (Havn), radar, 4202, 2023-nutid". Navnet kan selv indeholde komma, så der deles fra højre.
            var parts = raw.Trim().Split(',').Select(p => p.Trim()).ToList();
            if (parts.Count < 4 || !parts[^1].EndsWith("nutid", StringComparison.OrdinalIgnoreCase)) continue;
            string id = parts[^2];
            if (!id.All(char.IsDigit)) continue;
            if (dmiIds.Contains("9" + id.PadLeft(6, '0'))) continue;
            string name = string.Join(", ", parts.Take(parts.Count - 3)).Replace(" (Havn)", " Havn");
            string sensor = parts[^3];

            string csv = await client.GetTextAsync(
                $"{KystatlasBase}/response.aspx?ident={id}&startdate={today.AddDays(-KystatlasDays):yyyyMMdd}&enddate={today.AddDays(1):yyyyMMdd}&format=csv");
            var t = new List<long>();
            var v = new List<double>();
            double north = 0, east = 0;
            foreach (string line in csv.Split('\n').Skip(1))
            {
                var c = line.Split(',');
                if (c.Length < 5) continue;
                if (!DateTime.TryParseExact(c[0].Trim(), "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out var local)) continue;
                if (!double.TryParse(c[1].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double value)) continue;
                var utc = DateTime.SpecifyKind(local.AddHours(-1), DateTimeKind.Utc);
                t.Add(new DateTimeOffset(utc).ToUnixTimeSeconds());
                v.Add(value);
                double.TryParse(c[3].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out north);
                double.TryParse(c[4].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out east);
            }
            if (t.Count == 0 || north == 0)
            {
                Warn($"Kystatlas {id} {name}: ingen målinger de seneste {KystatlasDays} døgn. Kommer ikke med.");
                continue;
            }
            // En måler, der står helt stille det seneste døgn, måler ikke vandstand (fx 349-350 cm i Esbjerg Zodiak Spulefelt).
            var lastDay = v.Skip(Math.Max(0, v.Count - 144)).ToList();
            if (lastDay.Max() - lastDay.Min() <= 1)
            {
                Warn($"Kystatlas {id} {name}: værdierne har stået stille det seneste døgn ({lastDay.Min()} til {lastDay.Max()} cm). Kommer ikke med.");
                continue;
            }

            var (lat, lon) = Utm32ToLatLon(east, north);
            string file = Path.Combine(obsDir, id + ".json");
            var obs = new { id, name, sensor, datum = "DVR90", unit = "cm", generatedUtc = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH':'mm':'ss'Z'", CultureInfo.InvariantCulture), t, v };
            await File.WriteAllTextAsync(file, JsonSerializer.Serialize(obs, JsonOptions) + "\n", new UTF8Encoding(false));

            result.Add(new StationOut
            {
                Id = "KA-" + id,
                SourceId = id,
                Name = name,
                Source = SourceKystatlas,
                Country = "DK",
                Owner = "Kystdirektoratet",
                Status = StatusActive,
                Lat = Math.Round(lat, 4),
                Lon = Math.Round(lon, 4),
                From = Day(DateTimeOffset.FromUnixTimeSeconds(t[0])),
                Parameters = ["vandstand"],
            });
            Console.WriteLine($"  Kystatlas {id} {name} ({sensor}): {t.Count} målinger, [{lon:0.0000}, {lat:0.0000}]");
        }
        Console.WriteLine($"Kystatlas: {result.Count} målere, som ikke er i DMI's liste.");
        return result;
    }

    // UTM zone 32N (ETRS89/GRS80) til bredde og længde i grader
    internal static (double Lat, double Lon) Utm32ToLatLon(double east, double north)
    {
        const double a = 6378137.0, f = 1 / 298.257222101, k0 = 0.9996;
        double e2 = f * (2 - f), ep2 = e2 / (1 - e2);
        double x = east - 500000.0, y = north;
        double m = y / k0;
        double mu = m / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
        double e1 = (1 - Math.Sqrt(1 - e2)) / (1 + Math.Sqrt(1 - e2));
        double phi1 = mu + (3 * e1 / 2 - 27 * Math.Pow(e1, 3) / 32) * Math.Sin(2 * mu)
                      + (21 * e1 * e1 / 16 - 55 * Math.Pow(e1, 4) / 32) * Math.Sin(4 * mu)
                      + (151 * Math.Pow(e1, 3) / 96) * Math.Sin(6 * mu)
                      + (1097 * Math.Pow(e1, 4) / 512) * Math.Sin(8 * mu);
        double n1 = a / Math.Sqrt(1 - e2 * Math.Sin(phi1) * Math.Sin(phi1));
        double t1 = Math.Tan(phi1) * Math.Tan(phi1);
        double c1 = ep2 * Math.Cos(phi1) * Math.Cos(phi1);
        double r1 = a * (1 - e2) / Math.Pow(1 - e2 * Math.Sin(phi1) * Math.Sin(phi1), 1.5);
        double d = x / (n1 * k0);
        double lat = phi1 - (n1 * Math.Tan(phi1) / r1) * (d * d / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * Math.Pow(d, 4) / 24
                     + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * Math.Pow(d, 6) / 720);
        double lon = (d - (1 + 2 * t1 + c1) * Math.Pow(d, 3) / 6
                      + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * Math.Pow(d, 5) / 120) / Math.Cos(phi1);
        return (lat * 180 / Math.PI, 9.0 + lon * 180 / Math.PI);
    }

    // ---------- DMI's tidevand ----------

    private static async Task<List<TideOut>> BuildTidesAsync(DmiClient dmi)
    {
        Console.WriteLine("Henter DMI's tidevandssteder ...");
        using var doc = await dmi.GetJsonAsync($"{OceanBase}/tidewaterstation/items?limit=10000");
        var list = new List<TideOut>();
        foreach (var f in doc.RootElement.GetProperty("features").EnumerateArray())
        {
            var p = f.GetProperty("properties");
            if (p.GetProperty("country").GetString() != "DNK") continue;
            var c = f.GetProperty("geometry").GetProperty("coordinates");
            string id = p.GetProperty("stationId").GetString() ?? "";
            list.Add(new TideOut
            {
                Id = "tide-" + id,
                StationId = id,
                Name = (p.GetProperty("name").GetString() ?? id).Trim(),
                Lat = Math.Round(c[1].GetDouble(), 4),
                Lon = Math.Round(c[0].GetDouble(), 4),
                LowAstronomicalTide = p.TryGetProperty("lowAstronomicalTide", out var lat) && lat.ValueKind == JsonValueKind.Number ? lat.GetDouble() : null,
                MeanLowWaterSpring = p.TryGetProperty("meanLowWaterSpring", out var mlws) && mlws.ValueKind == JsonValueKind.Number ? mlws.GetDouble() : null,
            });
        }
        return list.OrderBy(t => t.StationId, StringComparer.Ordinal).ToList();
    }

    // ---------- Havne uden måler ----------

    private static List<HarbourOut> ReadHarbours(string path)
    {
        if (!File.Exists(path)) return [];
        using var doc = JsonDocument.Parse(File.ReadAllText(path, Encoding.UTF8));
        return doc.RootElement.GetProperty("havne").EnumerateArray().Select(h => new HarbourOut
        {
            Id = h.GetProperty("id").GetString() ?? "",
            Name = h.GetProperty("name").GetString() ?? "",
            Lat = Math.Round(h.GetProperty("lat").GetDouble(), 4),
            Lon = Math.Round(h.GetProperty("lon").GetDouble(), 4),
            Osm = h.TryGetProperty("osm", out var o) ? o.GetString() : null,
        }).Where(h => h.Id.Length > 0).ToList();
    }

    // ---------- Prognosepunkter ----------

    private static async Task<List<string>> AssignForecastsAsync(
        DmiClient dmi, List<StationOut> selected, List<HarbourOut> harbours, StationsFile? existing,
        bool refreshForecast, TimeSpan forecastBudget)
    {
        // Havnene regnes med som stationer, så de genbruger samme logik.
        var harbourStations = harbours.Select(h => new StationOut
        {
            Id = h.Id, Name = h.Name, Source = "HAVN", Country = "DK", Status = StatusActive, Lat = h.Lat, Lon = h.Lon,
        }).ToList();
        var candidates = selected.Where(s => s.Status == StatusActive).Concat(harbourStations).ToList();

        var retry = new HashSet<string>(existing?.ForecastPending ?? [], StringComparer.Ordinal);
        var known = new Dictionary<string, StationOut>(StringComparer.Ordinal);
        foreach (var s in existing?.Stations ?? []) known[s.Id] = s;
        foreach (var h in existing?.Harbours ?? [])
            known[h.Id] = new StationOut { Id = h.Id, Lat = h.Lat, Lon = h.Lon, Forecast = h.Forecast, Status = StatusActive };
        // Stationer, der før er tjekket uden at få et punkt (fx svenske uden for de fine modeller), tjekkes ikke igen.
        var checkedBefore = new HashSet<string>(existing?.ForecastChecked ?? [], StringComparer.Ordinal);
        var toCompute = new List<StationOut>();

        foreach (var station in candidates)
        {
            bool samePlace = known.TryGetValue(station.Id, out var old) && old.Lat == station.Lat && old.Lon == station.Lon;
            bool reuse = !refreshForecast && samePlace && !retry.Contains(station.Id) &&
                         (old!.Forecast is not null || station.Source == SourceDmi || checkedBefore.Contains(station.Id));
            if (reuse) station.Forecast = old!.Forecast;
            else toCompute.Add(station);
        }

        // Stationer i nøjagtig samme koordinat deler prognosepunkt. Det sparer kald til DMI.
        var reusable = new Dictionary<(double, double), ForecastOut>();
        foreach (var s in candidates.Where(s => s.Forecast is not null && !toCompute.Contains(s)))
            reusable.TryAdd((s.Lat, s.Lon), s.Forecast!);
        var sharing = new List<(StationOut Station, StationOut Source)>();
        var firstAt = new Dictionary<(double, double), StationOut>();
        foreach (var s in toCompute.ToList())
        {
            if (!refreshForecast && reusable.TryGetValue((s.Lat, s.Lon), out var f))
            {
                s.Forecast = f;
                toCompute.Remove(s);
            }
            else if (firstAt.TryGetValue((s.Lat, s.Lon), out var source))
            {
                sharing.Add((s, source));
                toCompute.Remove(s);
            }
            else
            {
                firstAt[(s.Lat, s.Lon)] = s;
            }
        }

        var pending = new List<string>();
        if (toCompute.Count > 0)
        {
            Console.WriteLine($"Finder prognosepunkt for {toCompute.Count} stationer og havne ...");
            var models = await LoadModelsAsync(dmi);
            var fine = models.Where(m => m.Id != "dkss_nsbs").ToArray();
            string hour = NextFullHourUtc();

            var clock = System.Diagnostics.Stopwatch.StartNew();
            var gate = new SemaphoreSlim(2); // to stationer ad gangen
            int skipped = 0;

            var tasks = toCompute.Select(async station =>
            {
                await gate.WaitAsync();
                try
                {
                    if (forecastBudget > TimeSpan.Zero && clock.Elapsed > forecastBudget)
                    {
                        lock (pending) pending.Add(station.Id);
                        Interlocked.Increment(ref skipped);
                        return;
                    }
                    bool foreign = station.Source is SourceSmhi or SourcePegel;
                    station.Forecast = await FindForecastAsync(dmi, station, foreign ? fine : models, hour);
                    string text = station.Forecast is { } f
                        ? $"{f.Model} [{f.Lon}, {f.Lat}], {DistanceKm(station.Lat, station.Lon, f.Lat, f.Lon) * 1000:0} m fra stationen"
                        : "ingen prognose";
                    Console.WriteLine($"  {station.Id} {station.Name}: {text}");
                }
                catch (Exception ex)
                {
                    station.Forecast = null;
                    lock (pending) pending.Add(station.Id);
                    Warn($"Prognosepunkt for {station.Id} {station.Name} kunne ikke findes: {ex.Message} Prøves igen ved næste kørsel.");
                }
                finally
                {
                    gate.Release();
                }
            });
            await Task.WhenAll(tasks);
            if (skipped > 0)
                Warn($"Tidsgrænsen på {forecastBudget.TotalMinutes:0} minutter for prognosepunkter er nået. {skipped} prøves igen ved næste kørsel.");
        }
        else
        {
            Console.WriteLine("Alle prognosepunkter er genbrugt fra den eksisterende fil eller fra en station i samme punkt.");
        }

        foreach (var (station, source) in sharing)
        {
            station.Forecast = source.Forecast;
            if (pending.Contains(source.Id)) pending.Add(station.Id);
        }

        foreach (var h in harbours)
            h.Forecast = harbourStations.First(s => s.Id == h.Id).Forecast;

        // Husk udenlandske stationer, der er tjekket uden at få et punkt, så de ikke koster kald hver gang.
        ForecastCheckedOut = candidates
            .Where(s => s.Forecast is null && s.Source != SourceDmi && !pending.Contains(s.Id))
            .Select(s => s.Id).OrderBy(x => x, StringComparer.Ordinal).ToList();
        return pending;
    }

    private static List<string> ForecastCheckedOut = [];

    // ---------- Stationsliste ----------

    private static async Task<List<StationRecord>> FetchStationRecordsAsync(DmiClient dmi, string firstUrl)
    {
        var records = new List<StationRecord>();
        string? url = firstUrl;
        int pages = 0;

        while (!string.IsNullOrEmpty(url) && pages < 50)
        {
            pages++;
            using var doc = await dmi.GetJsonAsync(url);
            var root = doc.RootElement;

            if (!root.TryGetProperty("features", out var features) || features.ValueKind != JsonValueKind.Array)
                throw new InvalidOperationException("Stationslisten har ingen features.");

            int count = 0;
            foreach (var feature in features.EnumerateArray())
            {
                count++;
                var record = StationRecord.Parse(feature);
                if (record is not null) records.Add(record);
            }

            // DMI sender altid et next-link, også når der ikke er mere. Stop på tom eller kort side.
            int numberReturned = root.TryGetProperty("numberReturned", out var nr) && nr.ValueKind == JsonValueKind.Number
                ? nr.GetInt32()
                : count;
            if (count == 0 || numberReturned < StationsLimit) break;

            url = NextLink(root);
        }

        return records;
    }

    private static string? NextLink(JsonElement root)
    {
        if (!root.TryGetProperty("links", out var links) || links.ValueKind != JsonValueKind.Array) return null;
        foreach (var link in links.EnumerateArray())
        {
            if (link.TryGetProperty("rel", out var rel) && rel.ValueKind == JsonValueKind.String &&
                rel.GetString() == "next" &&
                link.TryGetProperty("href", out var href) && href.ValueKind == JsonValueKind.String)
                return href.GetString();
        }
        return null;
    }

    // ---------- Prognosepunkt ----------

    private static async Task<ModelInfo[]> LoadModelsAsync(DmiClient dmi)
    {
        try
        {
            using var doc = await dmi.GetJsonAsync(ForecastBase);
            var found = new Dictionary<string, ModelInfo>();
            foreach (var c in doc.RootElement.GetProperty("collections").EnumerateArray())
            {
                string? id = c.GetProperty("id").GetString();
                if (id is null) continue;
                var bbox = c.GetProperty("extent").GetProperty("spatial").GetProperty("bbox")[0];
                found[id] = new ModelInfo(id, bbox[0].GetDouble(), bbox[1].GetDouble(), bbox[2].GetDouble(), bbox[3].GetDouble());
            }
            // Behold rækkefølgen fra finest til grovest, men brug områderne fra DMI's metadata.
            return DefaultModels.Select(m => found.TryGetValue(m.Id, out var live) ? live : m).ToArray();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"  Kunne ikke hente modelområder ({ex.Message}). Bruger de indbyggede.");
            return DefaultModels;
        }
    }

    private static async Task<ForecastOut?> FindForecastAsync(
        DmiClient dmi, StationOut station, ModelInfo[] models, string hour)
    {
        // Et position-kald uden for en models område giver ikke fejl, men nærmeste kantpunkt
        // (målt: 29,8 km væk for dkss_if ved Københavns Havn). Derfor prøves kun modeller, der dækker stationen.
        var covering = models.Where(m => m.Contains(station.Lon, station.Lat)).ToList();

        // Runde 1: position i stationens koordinat, ellers nærmeste punkt med værdier inden for ±0,05°.
        foreach (var model in covering)
        {
            var hit = await PositionAsync(dmi, model.Id, station.Lon, station.Lat);
            if (hit is { HasValues: true })
            {
                var point = await VerifyAsync(dmi, model.Id, hit.Lon, hit.Lat);
                if (point is not null) return point;
            }

            var near = await NearestFromCubeAsync(dmi, model, station, 0.05, hour);
            if (near is not null) return near;
        }

        // Runde 2: udvid til ±0,15°. Sker først, når ingen model har et punkt tæt på.
        foreach (var model in covering)
        {
            var near = await NearestFromCubeAsync(dmi, model, station, 0.15, hour);
            if (near is not null) return near;
        }

        return null;
    }

    private static async Task<PositionResult?> PositionAsync(DmiClient dmi, string model, double lon, double lat)
    {
        string coords = Uri.EscapeDataString(string.Create(CultureInfo.InvariantCulture, $"POINT({lon} {lat})"));
        string url = $"{ForecastBase}/{model}/position?coords={coords}&crs=crs84&parameter-name={ForecastParameter}&f=GeoJSON";

        using var doc = await dmi.GetJsonAsync(url);
        if (!doc.RootElement.TryGetProperty("features", out var features) || features.ValueKind != JsonValueKind.Array)
            return null;

        int steps = 0, withValue = 0;
        double? gridLon = null, gridLat = null;
        foreach (var feature in features.EnumerateArray())
        {
            steps++;
            if (HasValue(feature)) withValue++;
            if (gridLon is null && TryPoint(feature, out double x, out double y))
            {
                gridLon = x;
                gridLat = y;
            }
        }

        if (steps == 0 || gridLon is null || gridLat is null) return null;
        // Punktet skal have værdier i (næsten) alle trin, ellers får prognosen huller.
        return new PositionResult(gridLon.Value, gridLat.Value, withValue >= steps * 0.95);
    }

    // Det gemte punkt afrundes til 4 decimaler. Tjek, at et kald i det afrundede punkt stadig giver værdier.
    private static async Task<ForecastOut?> VerifyAsync(DmiClient dmi, string model, double gridLon, double gridLat)
    {
        double lon = Math.Round(gridLon, 4), lat = Math.Round(gridLat, 4);
        var check = await PositionAsync(dmi, model, lon, lat);
        return check is { HasValues: true } ? new ForecastOut { Model = model, Lat = lat, Lon = lon } : null;
    }

    private static async Task<ForecastOut?> NearestFromCubeAsync(
        DmiClient dmi, ModelInfo model, StationOut station, double delta, string hour)
    {
        string bbox = string.Create(
            CultureInfo.InvariantCulture,
            $"{station.Lon - delta:0.####},{station.Lat - delta:0.####},{station.Lon + delta:0.####},{station.Lat + delta:0.####}");
        string url = $"{ForecastBase}/{model.Id}/cube?bbox={bbox}&crs=crs84&parameter-name={ForecastParameter}" +
                     $"&datetime={Uri.EscapeDataString(hour)}&f=GeoJSON";

        var candidates = new List<(double Lon, double Lat, double Km)>();
        using (var doc = await dmi.GetJsonAsync(url))
        {
            if (!doc.RootElement.TryGetProperty("features", out var features) || features.ValueKind != JsonValueKind.Array)
                return null;

            foreach (var feature in features.EnumerateArray())
            {
                if (!HasValue(feature) || !TryPoint(feature, out double lon, out double lat)) continue;
                candidates.Add((lon, lat, DistanceKm(station.Lat, station.Lon, lat, lon)));
            }
        }

        // Cube-kaldet ser kun ét tidspunkt. Tjek de nærmeste punkter med et position-kald over alle trin.
        foreach (var candidate in candidates.OrderBy(c => c.Km).Take(4))
        {
            var point = await VerifyAsync(dmi, model.Id, candidate.Lon, candidate.Lat);
            if (point is not null) return point;
        }

        return null;
    }

    private static bool HasValue(JsonElement feature) =>
        feature.TryGetProperty("properties", out var properties) &&
        properties.TryGetProperty(ForecastParameter, out var value) &&
        value.ValueKind == JsonValueKind.Number &&
        double.IsFinite(value.GetDouble());

    private static bool TryPoint(JsonElement feature, out double lon, out double lat)
    {
        lon = lat = 0;
        if (!feature.TryGetProperty("geometry", out var geometry) || geometry.ValueKind != JsonValueKind.Object) return false;
        if (!geometry.TryGetProperty("coordinates", out var c) || c.ValueKind != JsonValueKind.Array || c.GetArrayLength() < 2) return false;
        if (c[0].ValueKind != JsonValueKind.Number || c[1].ValueKind != JsonValueKind.Number) return false;
        lon = c[0].GetDouble();
        lat = c[1].GetDouble();
        return true;
    }

    private static string NextFullHourUtc()
    {
        var t = DateTime.UtcNow;
        var hour = new DateTime(t.Year, t.Month, t.Day, t.Hour, 0, 0, DateTimeKind.Utc).AddHours(1);
        return hour.ToString("yyyy-MM-dd'T'HH':'mm':'ss'Z'", CultureInfo.InvariantCulture);
    }

    internal static double DistanceKm(double lat1, double lon1, double lat2, double lon2)
    {
        const double r = 6371;
        static double Rad(double x) => x * Math.PI / 180;
        double dLat = Rad(lat2 - lat1), dLon = Rad(lon2 - lon1);
        double a = Math.Pow(Math.Sin(dLat / 2), 2) +
                   Math.Cos(Rad(lat1)) * Math.Cos(Rad(lat2)) * Math.Pow(Math.Sin(dLon / 2), 2);
        return 2 * r * Math.Asin(Math.Sqrt(a));
    }

    // ---------- Ejer og datoer ----------

    // Ejeren skrives som "DMI", "Kystdirektoratet", "Havn/kommune" eller "Ikke oplyst".
    private static string OwnerName(string raw)
    {
        string owner = raw.Trim();
        if (owner.Length == 0) return "Ikke oplyst";
        if (owner.Equals("DMI", StringComparison.OrdinalIgnoreCase)) return "DMI";
        if (owner.StartsWith("Kystdirektoratet", StringComparison.OrdinalIgnoreCase)) return "Kystdirektoratet";
        if (HarbourOwners.Contains(owner)) return "Havn/kommune";
        return owner; // ukendt ejer: DMI's egen tekst
    }

    private static string Day(DateTimeOffset d) =>
        d.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    // ---------- Fil og beskeder ----------

    private static StationsFile? ReadExisting(string path)
    {
        if (!File.Exists(path)) return null;
        try
        {
            return JsonSerializer.Deserialize<StationsFile>(File.ReadAllText(path, Encoding.UTF8), JsonOptions);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Den eksisterende stations.json kunne ikke læses ({ex.Message}). Alle prognosepunkter beregnes.");
            return null;
        }
    }

    // Find mappen docs/ fra den aktuelle mappe (repoets rod) eller fra programmets egen mappe.
    private static string ResolveDocsDataDirectory()
    {
        foreach (string start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            var dir = new DirectoryInfo(start);
            for (int i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
            {
                string docs = Path.Combine(dir.FullName, "docs");
                if (Directory.Exists(docs)) return Path.Combine(docs, "data");
            }
        }
        return Path.Combine(Directory.GetCurrentDirectory(), "docs", "data");
    }

    internal static void Warn(string message)
    {
        bool inWorkflow = string.Equals(Environment.GetEnvironmentVariable("GITHUB_ACTIONS"), "true", StringComparison.OrdinalIgnoreCase);
        Console.WriteLine(inWorkflow ? $"::warning::{message}" : $"ADVARSEL: {message}");
    }
}

/// <summary>Kald til kilderne: højst 4 ad gangen, og op til 3 nye forsøg med pause ved 429, 5xx og netværksfejl.</summary>
internal sealed class DmiClient(HttpClient http)
{
    private const int MaxConcurrentCalls = 4;
    private const int MaxRetries = 3;
    private static readonly TimeSpan[] Pauses = [TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10)];

    private readonly SemaphoreSlim _gate = new(MaxConcurrentCalls);
    private int _calls;

    public int Calls => _calls;

    public Task<JsonDocument> GetJsonAsync(string url) =>
        GetAsync(url, async content =>
        {
            await using var stream = await content.ReadAsStreamAsync();
            return await JsonDocument.ParseAsync(stream);
        });

    public Task<string> GetTextAsync(string url) => GetAsync(url, content => content.ReadAsStringAsync());

    private async Task<T> GetAsync<T>(string url, Func<HttpContent, Task<T>> read)
    {
        for (int attempt = 0; ; attempt++)
        {
            string problem;
            TimeSpan? retryAfter = null;

            await _gate.WaitAsync();
            try
            {
                Interlocked.Increment(ref _calls);
                using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
                int code = (int)response.StatusCode;

                if (response.IsSuccessStatusCode)
                    return await read(response.Content);

                if (code != 429 && code < 500)
                    throw new InvalidOperationException($"HTTP {code} på {url}");

                problem = $"HTTP {code}";
                retryAfter = response.Headers.RetryAfter?.Delta;
            }
            catch (HttpRequestException ex)
            {
                problem = ex.Message;
            }
            catch (TaskCanceledException)
            {
                problem = "intet svar inden for tidsgrænsen";
            }
            catch (IOException ex)
            {
                problem = ex.Message;
            }
            finally
            {
                _gate.Release();
            }

            if (attempt >= MaxRetries)
                throw new InvalidOperationException($"{problem} efter {attempt + 1} forsøg på {url}");

            var pause = retryAfter is { } r && r > TimeSpan.Zero && r < TimeSpan.FromSeconds(60) ? r : Pauses[attempt];
            await Task.Delay(pause);
        }
    }
}

internal sealed record ModelInfo(string Id, double Left, double Bottom, double Right, double Top)
{
    public bool Contains(double lon, double lat) => lon >= Left && lon <= Right && lat >= Bottom && lat <= Top;
}

internal sealed record PositionResult(double Lon, double Lat, bool HasValues);

internal sealed class StationRecord
{
    public required string StationId { get; init; }
    public required string Name { get; init; }
    public required string Owner { get; init; }
    public string Status { get; init; } = "";
    public required HashSet<string> Parameters { get; init; }
    public double? Lat { get; init; }
    public double? Lon { get; init; }
    public DateTimeOffset? OperationFrom { get; init; }
    public DateTimeOffset? OperationTo { get; init; }
    public DateTimeOffset? ValidFrom { get; init; }
    public DateTimeOffset? ValidTo { get; init; }

    public static StationRecord? Parse(JsonElement feature)
    {
        if (!feature.TryGetProperty("properties", out var p) || p.ValueKind != JsonValueKind.Object) return null;

        string? id = Text(p, "stationId");
        if (string.IsNullOrWhiteSpace(id)) return null;

        var parameters = new HashSet<string>(StringComparer.Ordinal);
        if (p.TryGetProperty("parameterId", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in list.EnumerateArray())
                if (item.ValueKind == JsonValueKind.String) parameters.Add(item.GetString()!);
        }

        double? lon = null, lat = null;
        if (feature.TryGetProperty("geometry", out var g) && g.ValueKind == JsonValueKind.Object &&
            g.TryGetProperty("coordinates", out var c) && c.ValueKind == JsonValueKind.Array && c.GetArrayLength() >= 2 &&
            c[0].ValueKind == JsonValueKind.Number && c[1].ValueKind == JsonValueKind.Number)
        {
            lon = c[0].GetDouble();
            lat = c[1].GetDouble();
        }

        string? name = Text(p, "name");
        return new StationRecord
        {
            StationId = id,
            Name = string.IsNullOrWhiteSpace(name) ? id : name.Trim(),
            Owner = (Text(p, "owner") ?? "").Trim(),
            Status = (Text(p, "status") ?? "").Trim(),
            Parameters = parameters,
            Lat = lat,
            Lon = lon,
            OperationFrom = Date(p, "operationFrom"),
            OperationTo = Date(p, "operationTo"),
            ValidFrom = Date(p, "validFrom"),
            ValidTo = Date(p, "validTo"),
        };
    }

    private static string? Text(JsonElement p, string name) =>
        p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static DateTimeOffset? Date(JsonElement p, string name) =>
        DateTimeOffset.TryParse(
            Text(p, name),
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
            out var d)
            ? d
            : null;
}

internal sealed class StationsFile
{
    public string GeneratedUtc { get; set; } = "";

    // Status for hver kilde ved seneste kørsel. Ok = false betyder, at stationerne er genbrugt fra den forrige fil.
    public List<SourceOut> Sources { get; set; } = [];
    public List<StationOut> Stations { get; set; } = [];
    public List<TideOut> Tides { get; set; } = [];
    public List<HarbourOut> Harbours { get; set; } = [];

    // Stationer, hvor opslaget af prognosepunkt fejlede (fx 429 fra DMI). De prøves igen ved næste kørsel.
    public List<string> ForecastPending { get; set; } = [];

    // Udenlandske stationer, der er tjekket uden at få et prognosepunkt. De tjekkes ikke igen.
    public List<string> ForecastChecked { get; set; } = [];
}

internal sealed class SourceOut
{
    public string Name { get; set; } = "";
    public bool Ok { get; set; }
    public int Stations { get; set; }
    public string? Message { get; set; }
}

internal sealed class StationOut
{
    public string Id { get; set; } = "";
    public string? SourceId { get; set; }
    public string Name { get; set; } = "";
    public string Source { get; set; } = "";
    public string Country { get; set; } = "";
    public string Owner { get; set; } = "";
    public string? Water { get; set; }
    public string Status { get; set; } = "";
    public double Lat { get; set; }
    public double Lon { get; set; }
    public string From { get; set; } = "";
    public string? To { get; set; }
    public List<string> Parameters { get; set; } = [];

    // PEGELONLINE: pegelnul i meter over NHN og datoen, det gælder fra
    public double? GaugeZeroNhn { get; set; }
    public string? GaugeZeroFrom { get; set; }
    public ForecastOut? Forecast { get; set; }
}

internal sealed class TideOut
{
    public string Id { get; set; } = "";
    public string StationId { get; set; } = "";
    public string Name { get; set; } = "";
    public double Lat { get; set; }
    public double Lon { get; set; }
    public double? LowAstronomicalTide { get; set; }
    public double? MeanLowWaterSpring { get; set; }
}

internal sealed class HarbourOut
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public double Lat { get; set; }
    public double Lon { get; set; }
    public string? Osm { get; set; }
    public ForecastOut? Forecast { get; set; }
}

internal sealed class ForecastOut
{
    public string Model { get; set; } = "";
    public double Lat { get; set; }
    public double Lon { get; set; }
}
