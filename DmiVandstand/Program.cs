using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Unicode;

// DMI Vandstand: bygger docs/data/stations.json ud fra DMI's stationsliste (oceanObs) med alle stationer,
// aktive og nedlagte, og finder et prognosepunkt i stormflodsmodellen DKSS til hver aktiv station.
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
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(90) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("DmiVandstand/2.0");
        var dmi = new DmiClient(http);

        string stationsFile = Path.Combine(ResolveDocsDataDirectory(), "stations.json");
        Console.WriteLine($"Fil: {stationsFile}");

        // 1. Stationsliste: aktive og nedlagte (følg next, men stop på tom side eller kort side).
        Console.WriteLine("Henter stationsliste fra DMI ...");
        var records = new List<StationRecord>();
        foreach (string url in StationsUrls)
            records.AddRange(await FetchStationRecordsAsync(dmi, url));
        var byStation = records.GroupBy(r => r.StationId).ToList();
        Console.WriteLine($"Records: {records.Count}. Unikke stationer: {byStation.Count}.");

        // 2. Alle stationer kommer med. Ejer og status tages fra den gældende record.
        var now = DateTimeOffset.UtcNow;
        var selected = new List<StationOut>();
        int noPosition = 0;

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
                noPosition++;
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
                Owner = OwnerName(current.Owner),
                Status = closed ? StatusClosed : StatusActive,
                Lat = Math.Round(positioned.Lat!.Value, 4),
                Lon = Math.Round(positioned.Lon!.Value, 4),
                From = from,
                To = to,
                Parameters = parameters,
            });
        }

        var danish = StringComparer.Create(CultureInfo.GetCultureInfo("da-DK"), ignoreCase: false);
        selected = selected
            .OrderBy(s => s.Name, danish)
            .ThenBy(s => s.Id, StringComparer.Ordinal)
            .ToList();

        Console.WriteLine($"Med: {selected.Count} stationer og {selected.Sum(s => s.Parameters.Count)} måleserier (station × parameter).");
        foreach (var g in selected.GroupBy(s => (s.Owner, s.Status)).OrderBy(g => g.Key.Owner).ThenBy(g => g.Key.Status))
            Console.WriteLine($"  {g.Key.Owner}, {g.Key.Status}: {g.Count()} stationer, {g.Sum(s => s.Parameters.Count)} måleserier");
        foreach (var g in selected.SelectMany(s => s.Parameters).GroupBy(x => x).OrderBy(g => g.Key, StringComparer.Ordinal))
            Console.WriteLine($"  Parameter {g.Key}: {g.Count()} stationer");
        if (noPosition > 0) Console.WriteLine($"  Uden koordinat: {noPosition}");

        if (selected.Count < MinStations)
        {
            Warn($"Kun {selected.Count} stationer fundet (mindst {MinStations} forventet). stations.json er ikke ændret.");
            return 0;
        }

        // 3. Prognosepunkter: genbrug dem, der allerede står i filen.
        var existing = ReadExisting(stationsFile);
        var retry = new HashSet<string>(existing?.ForecastPending ?? [], StringComparer.Ordinal);
        var known = (existing?.Stations ?? []).ToDictionary(s => s.Id, StringComparer.Ordinal);
        var toCompute = new List<StationOut>();

        // Prognosen vises kun sammen med aktive stationer, så nedlagte får ikke et prognosepunkt.
        foreach (var station in selected.Where(s => s.Status == StatusActive))
        {
            bool samePlace = known.TryGetValue(station.Id, out var old) &&
                             old.Lat == station.Lat && old.Lon == station.Lon;

            if (!refreshForecast && samePlace && !retry.Contains(station.Id))
                station.Forecast = old!.Forecast;
            else
                toCompute.Add(station);
        }

        // Stationer i nøjagtig samme koordinat deler prognosepunkt. Det sparer kald til DMI.
        var reusable = new Dictionary<(double, double), ForecastOut>();
        foreach (var s in selected.Where(s => s.Forecast is not null && !toCompute.Contains(s)))
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
            Console.WriteLine($"Finder prognosepunkt for {toCompute.Count} stationer ...");
            var models = await LoadModelsAsync(dmi);
            string hour = NextFullHourUtc();

            var clock = System.Diagnostics.Stopwatch.StartNew();
            var stations = new SemaphoreSlim(2); // to stationer ad gangen
            int skipped = 0;

            var tasks = toCompute.Select(async station =>
            {
                await stations.WaitAsync();
                try
                {
                    if (forecastBudget > TimeSpan.Zero && clock.Elapsed > forecastBudget)
                    {
                        lock (pending) pending.Add(station.Id);
                        Interlocked.Increment(ref skipped);
                        return;
                    }
                    station.Forecast = await FindForecastAsync(dmi, station, models, hour);
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
                    stations.Release();
                }
            });
            await Task.WhenAll(tasks);
            if (skipped > 0)
                Warn($"Tidsgrænsen på {forecastBudget.TotalMinutes:0} minutter for prognosepunkter er nået. {skipped} stationer prøves igen ved næste kørsel.");
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

        foreach (var g in selected.Where(s => s.Status == StatusActive).GroupBy(s => s.Forecast?.Model ?? "ingen").OrderBy(g => g.Key))
            Console.WriteLine($"  Prognosemodel {g.Key}: {g.Count()} stationer");

        // 4. Skriv filen (UTF-8 uden BOM).
        var output = new StationsFile
        {
            GeneratedUtc = now.UtcDateTime.ToString("yyyy-MM-dd'T'HH':'mm':'ss'Z'", CultureInfo.InvariantCulture),
            Stations = selected,
            ForecastPending = pending.Distinct().OrderBy(id => id, StringComparer.Ordinal).ToList(),
        };

        Directory.CreateDirectory(Path.GetDirectoryName(stationsFile)!);
        string temp = stationsFile + ".tmp";
        await File.WriteAllTextAsync(
            temp,
            JsonSerializer.Serialize(output, JsonOptions) + "\n",
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        File.Move(temp, stationsFile, overwrite: true);

        Console.WriteLine($"Skrevet {selected.Count} stationer til {stationsFile} ({dmi.Calls} kald til DMI).");
        return 0;
    }

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

/// <summary>Kald til DMI: højst 4 ad gangen, og op til 3 nye forsøg med pause ved 429, 5xx og netværksfejl.</summary>
internal sealed class DmiClient(HttpClient http)
{
    private const int MaxConcurrentCalls = 4;
    private const int MaxRetries = 3;
    private static readonly TimeSpan[] Pauses = [TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10)];

    private readonly SemaphoreSlim _gate = new(MaxConcurrentCalls);
    private int _calls;

    public int Calls => _calls;

    public async Task<JsonDocument> GetJsonAsync(string url)
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
                {
                    await using var stream = await response.Content.ReadAsStreamAsync();
                    return await JsonDocument.ParseAsync(stream);
                }

                if (code != 429 && code < 500)
                    throw new InvalidOperationException($"DMI svarede HTTP {code} på {url}");

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
    public List<StationOut> Stations { get; set; } = [];

    // Stationer, hvor opslaget af prognosepunkt fejlede (fx 429 fra DMI). De prøves igen ved næste kørsel.
    public List<string> ForecastPending { get; set; } = [];
}

internal sealed class StationOut
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Owner { get; set; } = "";
    public string Status { get; set; } = "";
    public double Lat { get; set; }
    public double Lon { get; set; }
    public string From { get; set; } = "";
    public string? To { get; set; }
    public List<string> Parameters { get; set; } = [];
    public ForecastOut? Forecast { get; set; }
}

internal sealed class ForecastOut
{
    public string Model { get; set; } = "";
    public double Lat { get; set; }
    public double Lon { get; set; }
}
