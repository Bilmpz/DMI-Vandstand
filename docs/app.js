/* DMI Vandstand v1.0. Ingen byggeværktøjer og ingen frameworks. */
(function (root) {
  "use strict";

  const STATIONS_URL = "data/stations.json";
  const POSTNR_URL = "data/postnumre.json";
  const OBS_URL = "https://opendataapi.dmi.dk/v2/oceanObs/collections/observation/items";

  const MIN = 60000;
  const MIN15 = 15 * MIN;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const STALE_AFTER = 3 * HOUR; // ældre end det: "Ingen ny måling siden ..."
  const MINUS = "−";

  // ====================================================================
  // Tid. Alt vises i dansk tid (Europe/Copenhagen), også sommertid.
  // ====================================================================

  const dkFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Copenhagen",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // Forskellen mellem dansk tid og UTC i minutter, slået op i browserens tidszonedata.
  function intlOffsetMin(ms) {
    const p = {};
    for (const part of dkFormat.formatToParts(ms)) p[part.type] = part.value;
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((wall - Math.floor(ms / 1000) * 1000) / MIN);
  }

  // Skiftene til og fra sommertid findes én gang pr. år, så en million rækker kan omregnes hurtigt.
  const yearRules = new Map();

  function yearRule(year) {
    let rule = yearRules.get(year);
    if (rule) return rule;

    const start = Date.UTC(year, 0, 1);
    const mid = Date.UTC(year, 6, 1);
    const end = Date.UTC(year + 1, 0, 1);
    const winter = intlOffsetMin(start);
    const summer = intlOffsetMin(mid);
    const late = intlOffsetMin(end - MIN);

    const firstChange = (lo, hi, before) => {
      while (hi - lo > MIN) {
        const m = lo + Math.floor((hi - lo) / (2 * MIN)) * MIN;
        if (intlOffsetMin(m) === before) lo = m;
        else hi = m;
      }
      return hi;
    };

    rule = {
      winter,
      summer,
      late,
      t1: summer !== winter ? firstChange(start, mid, winter) : mid,
      t2: late !== summer ? firstChange(mid, end, summer) : end,
    };
    yearRules.set(year, rule);
    return rule;
  }

  function offsetMin(ms) {
    const rule = yearRule(new Date(ms).getUTCFullYear());
    return ms < rule.t1 ? rule.winter : ms < rule.t2 ? rule.summer : rule.late;
  }

  // Dansk klokkeslæt til UTC i millisekunder. Dagen må gerne løbe over (dag 32 er den 1. i næste måned).
  function dkToUtc(y, m, d, hh, mm) {
    const wall = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
    const guess = wall - offsetMin(wall) * MIN;
    return wall - offsetMin(guess) * MIN;
  }

  function dkParts(ms) {
    const d = new Date(ms + offsetMin(ms) * MIN);
    return {
      y: d.getUTCFullYear(),
      m: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      hh: d.getUTCHours(),
      mm: d.getUTCMinutes(),
    };
  }

  const p2 = (n) => (n < 10 ? "0" + n : String(n));

  function fmtDateParts(p) {
    return `${p2(p.d)}.${p2(p.m)}.${p.y}`;
  }

  function fmtDate(ms) {
    return fmtDateParts(dkParts(ms));
  }

  function fmtTime(ms) {
    const p = dkParts(ms);
    return `${p2(p.hh)}:${p2(p.mm)}`;
  }

  // 26.11.2026 kl. 10:50
  function fmtDateTime(ms) {
    return `${fmtDate(ms)} kl. ${fmtTime(ms)}`;
  }

  function isoDate(p) {
    return `${p.y}-${p2(p.m)}-${p2(p.d)}`;
  }

  function todayDk(now) {
    const p = dkParts(now === undefined ? Date.now() : now);
    return { y: p.y, m: p.m, d: p.d };
  }

  function validDate(y, m, d) {
    const t = new Date(Date.UTC(y, m - 1, d));
    const ok = y >= 1800 && y <= 2200 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
    return ok ? { y, m, d } : null;
  }

  // "26.11.2026" (også 26-11-2026 og 26/11/2026)
  function parseDkDate(text) {
    const m = /^\s*(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\s*$/.exec(text || "");
    return m ? validDate(+m[3], +m[2], +m[1]) : null;
  }

  // "2026-11-26"
  function parseIsoDate(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || "");
    return m ? validDate(+m[1], +m[2], +m[3]) : null;
  }

  function addDays(p, days) {
    const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }

  function compareDates(a, b) {
    return a.y - b.y || a.m - b.m || a.d - b.d;
  }

  // ====================================================================
  // Tal
  // ====================================================================

  function round1(v) {
    const r = Math.round(v * 10) / 10;
    return r === 0 ? 0 : r;
  }

  // Dansk decimalkomma og højst én decimal
  function fmtNum(v) {
    return String(Math.abs(round1(v))).replace(".", ",");
  }

  // Vandstand har altid fortegn: +22, −5
  function fmtLevel(v) {
    const r = round1(v);
    return r > 0 ? "+" + fmtNum(r) : r < 0 ? MINUS + fmtNum(r) : "0";
  }

  function fmtKm(km) {
    return km.toFixed(1).replace(".", ",") + " km";
  }

  function fmtCount(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  // ====================================================================
  // Afstand og steder
  // ====================================================================

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  const NUMERALS = { I: 1, II: 2, III: 3 };

  function baseName(name) {
    return name.replace(/\s+(III|II|I)$/, "");
  }

  function numeral(name) {
    const m = /\s+(III|II|I)$/.exec(name);
    return m ? NUMERALS[m[1]] : 0;
  }

  // Et sted er stationer med samme ejer, samme navn uden I/II/III til sidst og under 1 km fra hinanden.
  function buildPlaces(stations) {
    const places = [];
    for (const s of stations) {
      const base = baseName(s.name);
      let place = places.find(
        (p) =>
          p.owner === s.owner &&
          p.base === base &&
          p.stations.some((o) => haversineKm(o.lat, o.lon, s.lat, s.lon) < 1)
      );
      if (!place) {
        place = { owner: s.owner, base, stations: [] };
        places.push(place);
      }
      place.stations.push(s);
    }
    for (const p of places) {
      p.stations.sort((a, b) => numeral(a.name) - numeral(b.name) || (a.id < b.id ? -1 : 1));
      p.main = p.stations[0]; // laveste nummerering er standard
    }
    return places;
  }

  function nearestPlaces(places, lat, lon, count) {
    return places
      .map((place) => ({ place, km: haversineKm(lat, lon, place.main.lat, place.main.lon) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, count);
  }

  // ====================================================================
  // Kald til DMI
  // ====================================================================

  class HttpError extends Error {
    constructor(status) {
      super("HTTP " + status);
      this.status = status;
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new DOMException("Afbrudt", "AbortError"));
      const onAbort = () => {
        clearTimeout(id);
        reject(new DOMException("Afbrudt", "AbortError"));
      };
      const id = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function getJson(url, signal) {
    const response = await fetch(url, { signal, cache: "no-store" });
    if (!response.ok) throw new HttpError(response.status);
    return response.json();
  }

  // Prøv igen ved 429, 5xx og netværksfejl. pauses er ventetiden før hvert nyt forsøg.
  async function getJsonRetry(url, signal, pauses) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await getJson(url, signal);
      } catch (err) {
        if (signal && signal.aborted) throw err;
        const retryable = !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
        if (!retryable || attempt >= pauses.length) throw err;
        await sleep(pauses[attempt], signal);
      }
    }
  }

  // Kør fn på alle elementer, højst limit ad gangen.
  async function pool(items, limit, fn) {
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  function obsUrl(station, query) {
    return (
      `${OBS_URL}?stationId=${encodeURIComponent(station.id)}` +
      `&parameterId=${encodeURIComponent(station.parameter)}&${query}`
    );
  }

  // Den rå, nyeste måling fra DMI
  async function fetchLatest(station, signal) {
    const data = await getJsonRetry(obsUrl(station, "period=latest"), signal, [1000]);
    const p = data.features && data.features[0] && data.features[0].properties;
    if (!p || typeof p.value !== "number") return null;
    const t = Date.parse(p.observed);
    return Number.isNaN(t) ? null : { t, v: p.value, q: p.qcStatus || "" };
  }

  // Målingen ca. 60 minutter før, til tendensen. Vælger den, der ligger tættest på.
  async function fetchReference(station, targetMs, signal) {
    const range = encodeURIComponent(isoZ(targetMs - 15 * MIN) + "/" + isoZ(targetMs + 15 * MIN));
    const data = await getJsonRetry(obsUrl(station, `datetime=${range}&limit=100`), signal, [1000]);
    let best = null;
    for (const f of data.features || []) {
      const p = f.properties;
      if (!p || typeof p.value !== "number") continue;
      const t = Date.parse(p.observed);
      if (Number.isNaN(t)) continue;
      if (!best || Math.abs(t - targetMs) < Math.abs(best.t - targetMs)) best = { t, v: p.value };
    }
    return best;
  }

  // ====================================================================
  // Målinger i en periode
  // ====================================================================

  const PAGE_LIMIT = 300000;
  const CACHE_FOR = 10 * MIN;
  const QC_NAMES = [""]; // qcStatus gemmes som et lille tal pr. række

  function qcCode(text) {
    if (!text) return 0;
    let i = QC_NAMES.indexOf(text);
    if (i < 0) {
      QC_NAMES.push(text);
      i = QC_NAMES.length - 1;
    }
    return i;
  }

  function isoZ(ms) {
    return new Date(ms).toISOString().slice(0, 19) + "Z";
  }

  function nextLink(data) {
    for (const link of data.links || []) {
      if (link.rel === "next" && link.href) return link.href;
    }
    return null;
  }

  // Perioden deles i kalenderkvartaler. Målt 26.11.2026 for station 30336 med 3 kald ad gangen:
  // tre år tog 4,9 s i kvartaler, 6,3 s i halvår og 6,6 s i hele år. Et kvartal er ca. 3,7 MB JSON.
  function planChunks(startMs, endMs) {
    const chunks = [];
    let start = startMs;
    while (start <= endMs) {
      const d = new Date(start);
      const next = Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3 + 3, 1);
      chunks.push({ start, end: Math.min(endMs, next - 1000), year: d.getUTCFullYear() });
      start = next;
    }
    return chunks;
  }

  // Kompakte arrays: tid, værdi og qcStatus. Sorteret efter tid, uden dubletter.
  function packSeries(t, v, q) {
    const n = t.length;
    const order = new Uint32Array(n);
    let ascending = true;
    let descending = true;
    for (let i = 0; i < n; i++) {
      order[i] = i;
      if (i > 0 && t[i] <= t[i - 1]) ascending = false;
      if (i > 0 && t[i] >= t[i - 1]) descending = false;
    }
    if (!ascending) {
      if (descending) order.reverse(); // DMI sender nyeste først
      else order.sort((a, b) => t[a] - t[b]);
    }

    const T = new Float64Array(n);
    const V = new Float64Array(n);
    const Q = new Uint8Array(n);
    let m = 0;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      if (m > 0 && t[i] === T[m - 1]) continue;
      T[m] = t[i];
      V[m] = v[i];
      Q[m] = q[i];
      m++;
    }
    return { t: T.subarray(0, m), v: V.subarray(0, m), q: Q.subarray(0, m), n: m };
  }

  const EMPTY_SERIES = packSeries([], [], []);

  // Bidderne ligger i tidsrækkefølge. datetime er inklusiv i begge ender, så dubletter i kanterne fjernes.
  function mergeSeries(parts) {
    let total = 0;
    for (const p of parts) total += p.n;
    const T = new Float64Array(total);
    const V = new Float64Array(total);
    const Q = new Uint8Array(total);
    let m = 0;
    for (const p of parts) {
      for (let i = 0; i < p.n; i++) {
        if (m > 0 && p.t[i] <= T[m - 1]) continue;
        T[m] = p.t[i];
        V[m] = p.v[i];
        Q[m] = p.q[i];
        m++;
      }
    }
    return { t: T.subarray(0, m), v: V.subarray(0, m), q: Q.subarray(0, m), n: m };
  }

  // Henter én bid. DMI sender altid et next-link, også når der ikke er mere,
  // så løkken stopper på en tom side eller en side, der er kortere end limit.
  async function fetchWindow(station, startMs, endMs, signal) {
    const range = encodeURIComponent(isoZ(startMs) + "/" + isoZ(endMs));
    let url = obsUrl(station, `datetime=${range}&limit=${PAGE_LIMIT}`);
    const t = [];
    const v = [];
    const q = [];

    for (let page = 0; url && page < 100; page++) {
      const data = await getJson(url, signal);
      const features = data.features || [];
      for (const f of features) {
        const p = f.properties;
        if (!p || typeof p.value !== "number") continue;
        const ms = Date.parse(p.observed);
        if (Number.isNaN(ms)) continue;
        t.push(ms);
        v.push(p.value);
        q.push(qcCode(p.qcStatus));
      }
      const returned = typeof data.numberReturned === "number" ? data.numberReturned : features.length;
      if (features.length === 0 || returned < PAGE_LIMIT) break;
      url = nextLink(data);
    }
    return packSeries(t, v, q); // JSON'en smides væk her
  }

  // Afsluttede kvartaler genbruges i 10 minutter, så "Vis" efterfulgt af "Hent Excel" ikke henter alt to gange.
  // Bidden med de nyeste målinger hentes altid igen.
  const chunkCache = new Map();
  let chunkCacheStation = null;

  class DmiDownError extends Error {}

  // En fejlet bid prøves igen 2 gange. Mens der ventes, holder de andre kald også pause,
  // så en overbelastet server ikke får flere kald. DMI svarer 429 ("Server is busy"), når den har travlt.
  const RETRY_PAUSES = [3000, 8000];
  const FINAL_PAUSE = 10000; // pause før bidder, der stadig mangler, prøves en sidste gang

  async function fetchRange(station, startMs, endMs, opts) {
    const options = opts || {};
    const signal = options.signal;
    const pauses = options.pauses || RETRY_PAUSES;
    const finalPause = options.finalPause === undefined ? FINAL_PAUSE : options.finalPause;

    const key0 = station.id + "|" + station.parameter;
    if (chunkCacheStation !== key0) {
      chunkCache.clear();
      chunkCacheStation = key0;
    }
    const startedAt = Date.now();
    for (const [key, entry] of chunkCache) {
      if (startedAt - entry.at >= CACHE_FOR) chunkCache.delete(key);
    }

    const chunks = planChunks(startMs, endMs);
    const parts = new Array(chunks.length).fill(EMPTY_SERIES);
    let done = 0;
    let holdUntil = 0;
    const report = (chunk, waiting) => {
      if (options.onProgress) options.onProgress({ year: chunk.year, done, total: chunks.length, waiting: !!waiting });
    };

    // Henter én bid. Giver false, hvis den stadig fejler efter 2 nye forsøg.
    const load = async (chunk, i) => {
      const key = chunk.start + "|" + chunk.end;
      const hit = chunkCache.get(key);
      if (hit && chunk.end < hit.at - HOUR) {
        parts[i] = hit.series;
        return true;
      }
      for (let attempt = 0; ; attempt++) {
        if (signal && signal.aborted) throw new DOMException("Afbrudt", "AbortError");
        while (holdUntil > Date.now()) {
          report(chunk, true);
          await sleep(holdUntil - Date.now(), signal);
        }
        report(chunk, false);
        try {
          const at = Date.now();
          parts[i] = await fetchWindow(station, chunk.start, chunk.end, signal);
          chunkCache.set(key, { at, series: parts[i] });
          return true;
        } catch (err) {
          if (signal && signal.aborted) throw err;
          const retryable = !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
          if (!retryable || attempt >= pauses.length) return false;
          holdUntil = Math.max(holdUntil, Date.now() + pauses[attempt]);
        }
      }
    };

    let failed = [];
    await pool(chunks, 3, async (chunk, i) => {
      if (await load(chunk, i)) done++;
      else failed.push(i);
      report(chunk, false);
    });

    if (failed.length === chunks.length) throw new DmiDownError("DMI svarer ikke");

    // Sidste runde: bidder, der fejlede, prøves igen én ad gangen efter en pause.
    // Fejler den første stadig, er DMI ikke klar, og resten meldes som manglende.
    if (failed.length) {
      const again = failed.sort((a, b) => a - b);
      failed = [];
      holdUntil = Math.max(holdUntil, Date.now() + finalPause);
      let giveUp = false;
      for (const i of again) {
        if (!giveUp && (await load(chunks[i], i))) {
          done++;
        } else {
          giveUp = true;
          failed.push(i);
        }
        report(chunks[i], false);
      }
    }

    return { series: mergeSeries(parts), failed: failed.map((i) => chunks[i]) };
  }

  // Fra og Til er danske datoer. Perioden går fra Fra kl. 00:00 til Til kl. 24:00 i dansk tid, dog højst til nu.
  function periodOf(fra, til, now) {
    const start = dkToUtc(fra.y, fra.m, fra.d, 0, 0);
    const endExclusive = dkToUtc(til.y, til.m, til.d + 1, 0, 0);
    const toToday = compareDates(til, todayDk(now)) === 0;
    return {
      fra,
      til,
      start,
      end: toToday ? Math.min(now, endExclusive - 1) : endExclusive - 1,
      apiEnd: endExclusive - 1000,
      toToday,
    };
  }

  // ====================================================================
  // 15-minutters datasæt (bruges i graf, tabel og Excel-fil)
  // ====================================================================

  const TYPE_MEASURED = 1;
  const TYPE_COMPUTED = 2;
  const TYPE_NAMES = ["", "målt", "beregnet"];
  const MAX_SPAN = 20 * MIN; // nabomålinger må højst ligge så langt fra hinanden

  // obs: målinger sorteret efter tid. Giver én række pr. kvarter (:00, :15, :30, :45):
  // - findes der en måling præcis på tidspunktet, bruges den ("målt")
  // - ellers beregnes værdien lineært mellem nærmeste måling før og efter,
  //   hvis de højst ligger 20 minutter fra hinanden ("beregnet", 1 decimal)
  // - ellers er der ingen række. Hullerne tælles frem til gapEndMs.
  function build15(obs, startMs, endMs, gapEndMs) {
    const first = Math.ceil(startMs / MIN15) * MIN15;
    const last = Math.floor(endMs / MIN15) * MIN15;
    const slots = last >= first ? Math.round((last - first) / MIN15) + 1 : 0;
    const gapEnd = gapEndMs === undefined ? endMs : gapEndMs;

    const t = new Float64Array(slots);
    const v = new Float64Array(slots);
    const type = new Uint8Array(slots);
    const q = new Uint8Array(slots);
    const N = obs.n;
    let n = 0;
    let gaps = 0;
    let i = 0;

    for (let k = 0; k < slots; k++) {
      const g = first + k * MIN15;
      while (i < N && obs.t[i] < g) i++;

      if (i < N && obs.t[i] === g) {
        t[n] = g;
        v[n] = obs.v[i];
        type[n] = TYPE_MEASURED;
        q[n] = obs.q[i];
        n++;
      } else if (i > 0 && i < N && obs.t[i] - obs.t[i - 1] <= MAX_SPAN) {
        const a = i - 1;
        const share = (g - obs.t[a]) / (obs.t[i] - obs.t[a]);
        t[n] = g;
        v[n] = round1(obs.v[a] + (obs.v[i] - obs.v[a]) * share);
        type[n] = TYPE_COMPUTED;
        q[n] = 0;
        n++;
      } else if (g <= gapEnd) {
        gaps++;
      }
    }

    return { t: t.subarray(0, n), v: v.subarray(0, n), type: type.subarray(0, n), q: q.subarray(0, n), n, gaps };
  }

  // Seneste, højeste og laveste værdi i datasættet
  function seriesStats(ds) {
    if (!ds.n) return null;
    let hi = 0;
    let lo = 0;
    for (let i = 1; i < ds.n; i++) {
      if (ds.v[i] > ds.v[hi]) hi = i;
      if (ds.v[i] < ds.v[lo]) lo = i;
    }
    const at = (i) => ({ t: ds.t[i], v: ds.v[i], type: ds.type[i] });
    return { last: at(ds.n - 1), max: at(hi), min: at(lo) };
  }

  // ====================================================================
  // Prognose (DMI's stormflodsmodel DKSS) og beregninger til grafen
  // ====================================================================

  const EDR_URL = "https://opendataapi.dmi.dk/v1/forecastedr/collections";
  const TYPE_FORECAST = 3;

  // Ét position-kald i stationens prognosepunkt. Værdien er afvigelse fra middelvandstand i meter
  // og omregnes til cm. Den justeres ikke til DVR90.
  async function fetchForecast(station, signal) {
    const f = station.forecast;
    const coords = encodeURIComponent(`POINT(${f.lon} ${f.lat})`);
    const url =
      `${EDR_URL}/${encodeURIComponent(f.model)}/position?coords=${coords}` +
      "&crs=crs84&parameter-name=sea-mean-deviation&f=GeoJSON";
    const data = await getJsonRetry(url, signal, [2000, 5000]);
    return parseForecast(data);
  }

  function parseForecast(data) {
    const points = [];
    for (const feature of (data && data.features) || []) {
      const p = feature.properties || {};
      const value = p["sea-mean-deviation"];
      const t = Date.parse(p.step);
      if (typeof value === "number" && Number.isFinite(value) && !Number.isNaN(t)) {
        points.push({ t, v: round1(value * 100) });
      }
    }
    points.sort((a, b) => a.t - b.t);
    return points;
  }

  function indexOfTime(times, n, t) {
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] === t) return mid;
      if (times[mid] < t) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  // Gennemsnittet af (måling − prognose) i de timer, hvor der er begge dele
  function overlapOf(ds, forecast) {
    let sum = 0;
    let n = 0;
    let first = 0;
    let last = 0;
    for (const p of forecast) {
      const i = indexOfTime(ds.t, ds.n, p.t);
      if (i < 0) continue;
      sum += ds.v[i] - p.v;
      if (n === 0) first = p.t;
      last = p.t;
      n++;
    }
    return n ? { n, mean: sum / n, first, last } : { n: 0 };
  }

  // Punkter over grænsen i 15-minutters datasættet
  function exceedOfSeries(ds, limit) {
    const out = { count: 0, measured: 0, computed: 0, first: 0, last: 0, max: -Infinity, maxT: 0 };
    for (let i = 0; i < ds.n; i++) {
      if (!(ds.v[i] > limit)) continue;
      if (out.count === 0) out.first = ds.t[i];
      out.last = ds.t[i];
      out.count++;
      if (ds.type[i] === TYPE_MEASURED) out.measured++;
      else out.computed++;
      if (ds.v[i] > out.max) {
        out.max = ds.v[i];
        out.maxT = ds.t[i];
      }
    }
    return out;
  }

  // Punkter over grænsen i prognosen
  function exceedOfForecast(forecast, limit) {
    const out = { count: 0, first: 0, last: 0, max: -Infinity, maxT: 0 };
    for (const p of forecast) {
      if (!(p.v > limit)) continue;
      if (out.count === 0) out.first = p.t;
      out.last = p.t;
      out.count++;
      if (p.v > out.max) {
        out.max = p.v;
        out.maxT = p.t;
      }
    }
    return out;
  }

  function medianSpacing(ds) {
    const pairs = Math.min(ds.n - 1, 1000);
    if (pairs < 1) return MIN15;
    const gaps = [];
    for (let k = 0; k < pairs; k++) {
      const i = Math.floor((k * (ds.n - 1)) / pairs);
      gaps.push(ds.t[i + 1] - ds.t[i]);
    }
    gaps.sort((a, b) => a - b);
    return gaps[gaps.length >> 1];
  }

  const CHART_RAW_MAX = 5000; // over det nedsamles serien
  const CHART_BUCKETS = 2000;

  // Punkter til den målte kurve. Lange serier nedsamles til laveste og højeste værdi pr. tidsinterval,
  // så spidser bevares. Huller i målingerne giver et brud i linjen (y = null).
  function chartPoints(ds) {
    const n = ds.n;
    const points = [];
    if (!n) return points;

    const breakGap = Math.max(MIN15, medianSpacing(ds)) * 2.5;
    const push = (i) => points.push({ x: ds.t[i], y: ds.v[i], k: ds.type[i] });
    const pushBreak = (i) => points.push({ x: (ds.t[i - 1] + ds.t[i]) / 2, y: null });

    if (n <= CHART_RAW_MAX) {
      for (let i = 0; i < n; i++) {
        if (i > 0 && ds.t[i] - ds.t[i - 1] > breakGap) pushBreak(i);
        push(i);
      }
    } else {
      const t0 = ds.t[0];
      const width = Math.max(MIN15, (ds.t[n - 1] - t0) / CHART_BUCKETS);
      const gapLimit = Math.max(breakGap, width);
      let i = 0;
      while (i < n) {
        const bucketEnd = t0 + (Math.floor((ds.t[i] - t0) / width) + 1) * width;
        let lo = i;
        let hi = i;
        let j = i + 1;
        for (; j < n && ds.t[j] < bucketEnd; j++) {
          if (ds.v[j] < ds.v[lo]) lo = j;
          if (ds.v[j] > ds.v[hi]) hi = j;
        }
        if (i > 0 && ds.t[i] - ds.t[i - 1] > gapLimit) pushBreak(i);
        push(Math.min(lo, hi));
        if (lo !== hi) push(Math.max(lo, hi));
        i = j;
      }
    }

    // Et punkt uden naboer ville ikke kunne ses som linje. Det tegnes som en lille prik.
    for (let k = 0; k < points.length; k++) {
      if (points[k].y === null) continue;
      const before = k === 0 || points[k - 1].y === null;
      const after = k === points.length - 1 || points[k + 1].y === null;
      if (before && after) points[k].alone = true;
    }
    return points;
  }

  const MONTHS = ["jan.", "feb.", "mar.", "apr.", "maj", "jun.", "jul.", "aug.", "sep.", "okt.", "nov.", "dec."];

  // Aksemærker i dansk tid: hele timer, døgn, måneder eller år, alt efter periodens længde.
  // label er én tekst eller to linjer.
  function timeTicks(min, max, maxTicks) {
    const span = max - min;
    const steps = [];
    for (const n of [1, 2, 3, 6, 12]) steps.push({ unit: "h", n, ms: n * HOUR });
    for (const n of [1, 2, 3, 4, 7, 14]) steps.push({ unit: "d", n, ms: n * DAY });
    for (const n of [1, 3, 6]) steps.push({ unit: "m", n, ms: n * 30.44 * DAY });
    for (const n of [1, 2, 5, 10, 20, 50]) steps.push({ unit: "y", n, ms: n * 365.25 * DAY });
    const step = steps.find((s) => span / s.ms <= maxTicks) || steps[steps.length - 1];

    const ticks = [];
    const add = (value, label) => {
      if (value < min || value > max) return;
      if (ticks.length && ticks[ticks.length - 1].value >= value) return;
      ticks.push({ value, label });
    };
    const p = dkParts(min);
    const dayMonth = (q) => `${p2(q.d)}.${p2(q.m)}.`;

    if (step.unit === "h") {
      for (let day = 0; ; day++) {
        const midnight = dkToUtc(p.y, p.m, p.d + day, 0, 0);
        if (midnight > max) break;
        for (let hour = 0; hour < 24; hour += step.n) {
          const t = dkToUtc(p.y, p.m, p.d + day, hour, 0);
          const q = dkParts(t);
          const time = `${p2(q.hh)}:${p2(q.mm)}`;
          add(t, hour === 0 || !ticks.length ? [time, dayMonth(q)] : time);
        }
      }
    } else if (step.unit === "d") {
      for (let day = 0; ; day++) {
        const t = dkToUtc(p.y, p.m, p.d + day, 0, 0);
        if (t > max) break;
        const q = dkParts(t);
        const index = Math.round(Date.UTC(q.y, q.m - 1, q.d) / DAY);
        if (index % step.n !== 0) continue;
        add(t, !ticks.length || (q.d <= step.n && q.m === 1) ? [dayMonth(q), String(q.y)] : dayMonth(q));
      }
    } else if (step.unit === "m") {
      for (let k = 0; ; k++) {
        const index = p.y * 12 + (p.m - 1) + k;
        const y = Math.floor(index / 12);
        const m = (index % 12) + 1;
        const t = dkToUtc(y, m, 1, 0, 0);
        if (t > max) break;
        if (index % step.n !== 0) continue;
        add(t, [MONTHS[m - 1], String(y)]);
      }
    } else {
      for (let y = p.y; ; y++) {
        const t = dkToUtc(y, 1, 1, 0, 0);
        if (t > max) break;
        if (y % step.n !== 0) continue;
        add(t, String(y));
      }
    }
    return ticks;
  }

  // ====================================================================
  // Excel-fil: CSV med semikolon, decimalkomma, CRLF og UTF-8 med BOM
  // ====================================================================

  // Stationer ejet af havne og kommuner måler sea_reg, men DMI dokumenterer ikke nulpunktet.
  const OWNER_HARBOUR = "Havn/kommune";

  function datumKnown(station) {
    return !station || station.owner !== OWNER_HARBOUR;
  }

  // Enheden for målt vandstand: "cm DVR90", eller "cm", når nulpunktet ikke er dokumenteret
  function levelUnit(station) {
    return datumKnown(station) ? "cm DVR90" : "cm";
  }

  const CSV_HEADER = "Tid UTC;Tid dansk;Vandstand cm DVR90;Type;qcStatus;Prognose cm (middelvandstand)";
  const CSV_HEADER_NO_DATUM =
    "Tid UTC;Tid dansk;Vandstand cm (nulpunkt ikke dokumenteret);Type;qcStatus;Prognose cm (middelvandstand)";

  function csvHeader(station) {
    return datumKnown(station) ? CSV_HEADER : CSV_HEADER_NO_DATUM;
  }
  const CSV_MAX_ROWS = 1000000; // Excel kan højst vise 1.048.576 rækker
  const CRLF = "\r\n";
  const BOM = String.fromCharCode(0xfeff);

  // Decimalkomma og almindelig bindestreg som minus
  function csvNum(v) {
    return String(round1(v)).replace(".", ",");
  }

  // yyyy-MM-dd HH:mm for et tidspunkt, der allerede er forskudt til den ønskede tidszone
  function stamp(ms) {
    const d = new Date(ms);
    return (
      d.getUTCFullYear() + "-" + p2(d.getUTCMonth() + 1) + "-" + p2(d.getUTCDate()) +
      " " + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes())
    );
  }

  // Rækkerne som tekst, samlet i blokke pr. dansk kalenderår: [{ year, rows, text }].
  // Prognosen står i sin egen kolonne på hele timer. Efter seneste måling kommer kun rækker med type "prognose".
  function csvBlocks(ds, forecast, qcNames) {
    const blocks = [];
    let year = null;
    let lines = [];

    const close = () => {
      if (lines.length) blocks.push({ year, rows: lines.length, text: lines.join(CRLF) + CRLF });
      lines = [];
    };
    const add = (ms, rest) => {
      const local = ms + offsetMin(ms) * MIN;
      const y = new Date(local).getUTCFullYear();
      if (y !== year) {
        close();
        year = y;
      }
      lines.push(stamp(ms) + ";" + stamp(local) + ";" + rest);
    };
    const forecastOnly = (p) => add(p.t, ";prognose;;" + csvNum(p.v));

    const points = forecast || [];
    let j = 0;
    for (let i = 0; i < ds.n; i++) {
      const t = ds.t[i];
      while (j < points.length && points[j].t < t) forecastOnly(points[j++]);
      let forecastText = "";
      if (j < points.length && points[j].t === t) forecastText = csvNum(points[j++].v);
      add(t, csvNum(ds.v[i]) + ";" + TYPE_NAMES[ds.type[i]] + ";" + (qcNames[ds.q[i]] || "") + ";" + forecastText);
    }
    while (j < points.length) forecastOnly(points[j++]);
    close();
    return blocks;
  }

  // Over 1.000.000 rækker deles filen i flere på hele år.
  function csvParts(blocks, maxRows) {
    const limit = maxRows || CSV_MAX_ROWS;
    let total = 0;
    for (const b of blocks) total += b.rows;
    if (total <= limit) return [{ blocks, rows: total }];

    const parts = [];
    let current = { blocks: [], rows: 0 };
    for (const b of blocks) {
      if (current.rows > 0 && current.rows + b.rows > limit) {
        parts.push(current);
        current = { blocks: [], rows: 0 };
      }
      current.blocks.push(b);
      current.rows += b.rows;
    }
    if (current.rows > 0) parts.push(current);
    return parts;
  }

  // Indholdet af én fil som en liste af tekststykker (til en Blob)
  function csvPieces(part, station) {
    return [BOM + csvHeader(station) + CRLF].concat(part.blocks.map((b) => b.text));
  }

  function slug(name) {
    return (
      name
        .toLowerCase()
        .replace(/æ/g, "ae")
        .replace(/ø/g, "oe")
        .replace(/å/g, "aa")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "station"
    );
  }

  // vandstand_{stationId}_{navn}_{parameter}_{fra}_{til}.csv, med _del1, _del2 ... når filen er delt
  function csvFileName(station, fra, til, partNo, partCount) {
    const base = `vandstand_${station.id}_${slug(station.name)}_${station.parameter}_${isoDate(fra)}_${isoDate(til)}`;
    return base + (partCount > 1 ? `_del${partNo}` : "") + ".csv";
  }

  // ====================================================================
  // Siden
  // ====================================================================

  const api = {
    MIN15,
    QC_NAMES,
    planChunks,
    packSeries,
    mergeSeries,
    periodOf,
    fetchRange,
    build15,
    seriesStats,
    parseForecast,
    overlapOf,
    exceedOfSeries,
    exceedOfForecast,
    chartPoints,
    timeTicks,
    CSV_HEADER,
    CSV_HEADER_NO_DATUM,
    OWNER_HARBOUR,
    datumKnown,
    levelUnit,
    csvHeader,
    csvBlocks,
    csvParts,
    csvPieces,
    csvFileName,
    offsetMin,
    dkToUtc,
    dkParts,
    fmtDate,
    fmtDateTime,
    parseDkDate,
    parseIsoDate,
    addDays,
    todayDk,
    fmtLevel,
    fmtNum,
    fmtCount,
    haversineKm,
    baseName,
    numeral,
    buildPlaces,
    nearestPlaces,
  };

  if (typeof document === "undefined") {
    // Kørt i Node til test af beregningerne
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    return;
  }
  root.Vandstand = api;

  const $ = (id) => document.getElementById(id);

  const state = {
    stations: [],
    byId: new Map(),
    places: [],
    placeOf: new Map(),
    postnumre: null,
    lastPostnr: null,
    station: null,
    searchJob: null,
    job: null, // hentning af en periode
    liveJob: null, // seneste måling
    liveTimer: 0,
    progressTimer: 0,
    latest: null,
    latestRef: null,
    latestAt: 0,
    latestError: false,
    limit: null,
    view: null,
    chart: null,
    blobUrls: [],
    overlay: null,
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showError(node, text) {
    node.textContent = text || "";
    node.hidden = !text;
  }

  function markFetched() {
    $("fetchedLine").textContent = `Data er hentet fra DMI ${fmtDateTime(Date.now())}.`;
  }

  // ---------- Indlæsning ----------

  async function loadLists() {
    // Sidens egne lister. GitHub Pages kan svare 503 et øjeblik lige efter en deploy, så der prøves igen.
    const [stationsFile, postnumre] = await Promise.all([
      getJsonRetry(STATIONS_URL, undefined, [800, 2500]),
      getJsonRetry(POSTNR_URL, undefined, [800, 2500]),
    ]);

    state.stations = stationsFile.stations || [];
    state.postnumre = postnumre;
    state.places = buildPlaces(state.stations);
    for (const place of state.places) {
      for (const s of place.stations) {
        state.byId.set(s.id, s);
        state.placeOf.set(s.id, place);
      }
    }

    const generated = Date.parse(stationsFile.generatedUtc);
    if (!Number.isNaN(generated)) {
      const sameDay = fmtDate(generated) === fmtDate(Date.now());
      $("listStatus").textContent =
        "Stationsliste opdateret " + (sameDay ? `kl. ${fmtTime(generated)}` : fmtDateTime(generated));
    }
  }

  // ---------- Adresse (hash) ----------

  function readHash() {
    const q = new URLSearchParams(location.hash.replace(/^#/, ""));
    return {
      postnr: q.get("postnr"),
      station: q.get("station"),
      fra: q.get("fra"),
      til: q.get("til"),
      graense: q.get("graense"),
    };
  }

  function route() {
    const h = readHash();
    if (h.station) {
      const station = state.byId.get(h.station);
      if (station) return showStation(station, h);
      showSearch(null);
      showError($("searchError"), `Station ${h.station} findes ikke i stationslisten. Søg på et postnummer i stedet.`);
      return;
    }
    showSearch(h.postnr);
  }

  // ---------- Søgning ----------

  function showSearch(postnr) {
    leaveStation();
    $("viewStation").hidden = true;
    $("viewSearch").hidden = false;
    document.title = "DMI Vandstand";
    showError($("searchError"), "");

    if (postnr === null || postnr === "") {
      $("results").hidden = true;
      return;
    }
    $("postnr").value = postnr;
    runSearch(postnr);
  }

  function runSearch(postnr) {
    if (state.searchJob) state.searchJob.abort();
    $("results").hidden = true;

    const hit = /^\d{4}$/.test(postnr) ? state.postnumre[postnr] : null;
    if (!hit) {
      showError($("searchError"), `Postnummer ${postnr} findes ikke. Skriv fire cifre, for eksempel 2100.`);
      return;
    }

    state.lastPostnr = postnr;
    const nearest = nearestPlaces(state.places, hit.lat, hit.lon, 5);
    $("resultsTitle").textContent = `Nærmeste målestationer ved ${postnr} ${hit.navn || ""}`.trim();

    const list = $("resultRows");
    list.textContent = "";
    const rows = nearest.map(({ place, km }) => {
      const s = place.main;
      const link = el("a", "row");
      link.href = "#station=" + encodeURIComponent(s.id);

      const meta = el("span", "row-meta");
      const time = el("span", "row-time");
      meta.append(el("span", "row-owner", s.owner), el("span", "row-dist", fmtKm(km)), time);
      const value = el("span", "row-value", "Henter …");
      link.append(el("span", "row-name", s.name), meta, value);

      const item = el("li");
      item.append(link);
      list.append(item);
      return { station: s, value, time };
    });
    $("results").hidden = false;

    // Seneste måling hentes live for de fem.
    const job = new AbortController();
    state.searchJob = job;
    pool(rows, 3, async (row) => {
      try {
        const latest = await fetchLatest(row.station, job.signal);
        if (job.signal.aborted) return;
        markFetched();
        if (!latest) {
          row.value.textContent = "Ingen måling hos DMI";
          row.value.classList.add("is-wide");
        } else if (Date.now() - latest.t > STALE_AFTER) {
          row.value.textContent = `Ingen ny måling siden ${fmtDateTime(latest.t)}`;
          row.value.classList.add("is-wide");
        } else {
          row.value.textContent = `${fmtLevel(latest.v)} cm`;
          row.time.textContent = fmtDateTime(latest.t);
        }
      } catch (err) {
        if (job.signal.aborted) return;
        row.value.textContent = "DMI svarer ikke lige nu";
        row.value.classList.add("is-wide");
      }
    }).catch(() => {});
  }

  // ---------- Station ----------

  const LIVE_EVERY = 5 * MIN;
  const GAP_GRACE = 30 * MIN; // DMI's målinger kommer med forsinkelse, så de nyeste kvarterer tælles ikke som huller
  const smallScreen = window.matchMedia("(max-width: 760px)");

  function leaveStation() {
    if (state.job) state.job.abort();
    if (state.liveJob) state.liveJob.abort();
    clearInterval(state.liveTimer);
    clearTimeout(state.progressTimer);
    state.station = null;
    state.latest = null;
    state.latestRef = null;
    state.view = null;
    destroyChart();
    releaseExcelLinks();
    $("progress").hidden = true;
  }

  function fact(term, text) {
    const box = el("div");
    box.append(el("dt", "", term), el("dd", "", text));
    return box;
  }

  function stationFrom(station) {
    return parseIsoDate(station.from);
  }

  function defaultPeriod(station) {
    const til = todayDk();
    let fra = addDays(til, -7);
    const from = stationFrom(station);
    if (from && compareDates(fra, from) < 0) fra = from;
    return { fra, til };
  }

  // "120", "120,5", "-20" eller tomt. Giver null for tomt og NaN for noget, der ikke er et tal.
  function parseLimit(text) {
    const s = (text || "").trim().replace(",", ".").replace(MINUS, "-");
    if (s === "") return null;
    return /^[+-]?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  }

  function limitText(limit) {
    return limit === null ? "" : String(limit).replace(".", ",");
  }

  function stationHash(id, input) {
    const q = new URLSearchParams();
    q.set("station", id);
    if (input) {
      const def = defaultPeriod(state.byId.get(id));
      const isDefault = compareDates(input.fra, def.fra) === 0 && compareDates(input.til, def.til) === 0;
      if (!isDefault) {
        q.set("fra", isoDate(input.fra));
        q.set("til", isoDate(input.til));
      }
      if (input.limit !== null && !Number.isNaN(input.limit)) q.set("graense", String(input.limit));
    }
    return "#" + q.toString();
  }

  // Skift måler, hvis stedet har flere
  function renderSensors(input) {
    const station = state.station;
    const place = state.placeOf.get(station.id);
    const box = $("stSensors");
    box.textContent = "";
    box.hidden = !place || place.stations.length < 2;
    if (box.hidden) return;

    box.append(el("span", "", `Stedet har ${place.stations.length} målere`));
    for (const s of place.stations) {
      if (s.id === station.id) {
        box.append(el("strong", "", `${s.name} (vist)`));
      } else {
        const link = el("a", "", s.name);
        link.href = stationHash(s.id, input);
        box.append(link);
      }
    }
  }

  function showStation(station, h) {
    if (state.searchJob) state.searchJob.abort();
    leaveStation();
    state.station = station;

    $("viewSearch").hidden = true;
    $("viewStation").hidden = false;
    document.title = `${station.name} – DMI Vandstand`;
    $("backLink").href = state.lastPostnr ? "#postnr=" + state.lastPostnr : "#";

    $("stName").textContent = station.name;
    $("tableUnit").textContent = "Vandstand " + levelUnit(station);
    const datum = !datumKnown(station)
      ? `${station.parameter}, nulpunkt ikke dokumenteret af DMI`
      : station.parameter === "sealev_dvr"
        ? "sealev_dvr, DVR90"
        : `${station.parameter}, DVR90 ifølge DMI`;
    const from = stationFrom(station);
    const facts = $("stFacts");
    facts.textContent = "";
    facts.append(
      fact("Ejer", station.owner),
      fact("Station-id", station.id),
      fact("Parameter og nulpunkt", datum),
      fact("Data fra", from ? fmtDateParts(from) : station.from)
    );

    // Periode og grænseværdi fra adressen, ellers de seneste 7 døgn
    let fra = parseIsoDate(h.fra);
    let til = parseIsoDate(h.til);
    if (!fra || !til) ({ fra, til } = defaultPeriod(station));
    const limit = parseLimit(h.graense);
    state.limit = Number.isNaN(limit) ? null : limit;
    $("fra").value = fmtDateParts(fra);
    $("til").value = fmtDateParts(til);
    $("graense").value = limitText(state.limit);
    renderSensors({ fra, til, limit: state.limit });

    for (const id of ["chartBlock", "notes", "tableBlock", "dataStatus", "excelParts"]) $(id).hidden = true;
    for (const id of ["periodForm", "shortcuts", "nowBlock", "stSource"]) $(id).hidden = false;
    showError($("periodError"), "");
    $("stSource").textContent =
      (station.owner === "DMI"
        ? "Kilde til målingerne: DMI."
        : station.owner === OWNER_HARBOUR
          ? "Kilde til målingerne: DMI og havnen eller kommunen, som ejer stationen."
          : `Kilde til målingerne: DMI og ${station.owner}, som ejer stationen.`) +
      " Kilde til prognosen: DMI's stormflodsmodel DKSS.";

    renderLatest();
    window.scrollTo(0, 0);

    refreshLatest();
    state.liveTimer = setInterval(() => {
      if (!document.hidden) refreshLatest();
    }, LIVE_EVERY);
    runPeriod({ excel: false });
  }

  // ---------- Seneste måling og vandstandsbræt ----------

  async function refreshLatest() {
    const station = state.station;
    if (!station) return;
    if (state.liveJob) state.liveJob.abort();
    const job = (state.liveJob = new AbortController());

    try {
      const latest = await fetchLatest(station, job.signal);
      let ref = null;
      if (latest) {
        try {
          ref = await fetchReference(station, latest.t - HOUR, job.signal);
        } catch (err) {
          ref = null;
        }
      }
      if (job.signal.aborted || state.station !== station) return;
      state.latest = latest;
      state.latestRef = ref;
      state.latestAt = Date.now();
      state.latestError = !latest;
      markFetched();
    } catch (err) {
      if (job.signal.aborted || state.station !== station) return;
      state.latestError = true;
    }
    renderLatest();
  }

  function renderLatest() {
    const latest = state.latest;
    const trend = $("nowTrend");
    const time = $("nowTime");
    time.classList.remove("is-stale");
    trend.textContent = "";

    if (!latest) {
      $("nowValue").textContent = state.latestError ? "–" : "…";
      $("nowUnit").textContent = "";
      time.textContent = state.latestError
        ? "DMI svarer ikke lige nu. Prøv igen om lidt."
        : "Henter seneste måling fra DMI …";
      renderGauge();
      return;
    }

    $("nowValue").textContent = fmtLevel(latest.v);
    $("nowUnit").textContent = levelUnit(state.station);

    if (Date.now() - latest.t > STALE_AFTER) {
      time.textContent = `Ingen ny måling siden ${fmtDateTime(latest.t)}`;
      time.classList.add("is-stale");
    } else {
      time.textContent = `Målt ${fmtDateTime(latest.t)}`;
      const ref = state.latestRef;
      if (ref && ref.t < latest.t) {
        const diff = round1(latest.v - ref.v);
        const minutes = Math.round((latest.t - ref.t) / MIN);
        const word = Math.abs(diff) < 2 ? "Stabil" : diff > 0 ? "Stigende" : "Faldende";
        trend.textContent = `${word}, ${fmtLevel(diff)} cm på ${minutes} minutter`;
      } else {
        trend.textContent = "Tendensen kan ikke beregnes, fordi målingen 60 minutter før mangler.";
      }
    }
    renderGauge();
  }

  // Vandstandsbrættet: en lodret skala som på en havnekaj. Streger for hver 10 cm, tal for hver 50 cm,
  // vandsøjle op til seneste måling, nullinje og rød markering ved grænseværdien.
  function renderGauge() {
    const box = $("gauge");
    const value = state.latest ? state.latest.v : null;
    const limit = state.limit;
    const small = smallScreen.matches;

    const H = small ? 96 : 240; // skalaens højde i px
    const boardW = small ? 24 : 40;
    const font = small ? 11 : 13;
    const pad = 8;
    const left = 8; // plads til grænsemarkeringen
    const labelX = left + boardW + 10;
    const W = labelX + (small ? 52 : 86);

    // Skalaen dækker mindst −100 til +150 cm og udvides i trin på 50 cm.
    let lo = -100;
    let hi = 150;
    for (const x of [value, limit]) {
      if (x === null || !Number.isFinite(x)) continue;
      while (x > hi - 10) hi += 50;
      while (x < lo + 10) lo -= 50;
    }
    const pxPerCm = H / (hi - lo);
    const y = (cm) => pad + (hi - cm) * pxPerCm;
    const snap = (px) => Math.round(px) + 0.5;
    const labelStep = 50 * pxPerCm >= font + 3 ? 50 : 100 * pxPerCm >= font + 3 ? 100 : 200;
    const tickStep = 10 * pxPerCm >= 3 ? 10 : 50;

    const INK = "#0F2D40";
    const SEA = "#0B6FA4";
    const MUTED = "#55687A";
    const RED = "#C8341F";
    const parts = [];

    parts.push(`<rect x="${left}" y="${pad}" width="${boardW}" height="${H}" fill="#FFFFFF"/>`);
    if (value !== null) {
      const top = Math.max(pad, Math.min(pad + H, y(value)));
      parts.push(`<rect x="${left}" y="${top}" width="${boardW}" height="${pad + H - top}" fill="${SEA}"/>`);
    }

    for (let cm = lo + tickStep; cm < hi; cm += tickStep) {
      if (cm === 0) continue;
      const long = cm % 50 === 0;
      const wet = value !== null && cm <= value;
      const len = Math.round(boardW * (long ? 0.6 : 0.3));
      parts.push(
        `<line x1="${left}" x2="${left + len}" y1="${snap(y(cm))}" y2="${snap(y(cm))}" stroke="${wet ? "#FFFFFF" : INK}" stroke-width="1"/>`
      );
    }
    for (let cm = Math.ceil(lo / labelStep) * labelStep; cm <= hi; cm += labelStep) {
      if (cm === 0) continue;
      parts.push(
        `<text x="${labelX}" y="${y(cm) + font * 0.35}" font-size="${font}" fill="${MUTED}">${fmtLevel(cm)}</text>`
      );
    }

    // Nullinjen
    const y0 = Math.round(y(0));
    const wetZero = value !== null && value >= 0;
    parts.push(`<rect x="${left}" y="${y0 - 1}" width="${boardW}" height="2" fill="${wetZero ? "#FFFFFF" : INK}"/>`);
    parts.push(`<rect x="${left + boardW}" y="${y0 - 1}" width="6" height="2" fill="${INK}"/>`);
    parts.push(
      `<text x="${labelX}" y="${y0 + font * 0.35}" font-size="${font}" font-weight="600" fill="${INK}">${datumKnown(state.station) ? "0 DVR90" : "0"}</text>`
    );

    parts.push(
      `<rect x="${left + 0.5}" y="${pad + 0.5}" width="${boardW - 1}" height="${H - 1}" fill="none" stroke="${INK}" stroke-width="1"/>`
    );

    // Grænseværdien
    let limitLabel = "";
    if (limit !== null && Number.isFinite(limit)) {
      const yl = Math.round(y(limit));
      parts.push(`<rect x="0" y="${yl - 1}" width="${left + boardW + 6}" height="2" fill="${RED}"/>`);
      const nearest = Math.round(limit / labelStep) * labelStep;
      if (!small && Math.abs(limit - nearest) * pxPerCm >= font + 2) {
        parts.push(
          `<text x="${labelX}" y="${yl + font * 0.35}" font-size="${font}" font-weight="600" fill="${RED}">Grænse ${fmtLevel(limit)}</text>`
        );
      }
      limitLabel = ` Grænseværdi ${fmtLevel(limit)} cm.`;
    }

    const label =
      (value === null ? "Vandstandsbræt uden måling." : `Vandstandsbræt. Seneste måling ${fmtLevel(value)} ${levelUnit(state.station)}.`) +
      limitLabel;
    box.innerHTML =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 2 * pad}" viewBox="0 0 ${W} ${H + 2 * pad}" ` +
      `role="img" aria-label="${label}" shape-rendering="crispEdges">${parts.join("")}</svg>`;
  }

  // ---------- Periode ----------

  function readPeriodFields() {
    const station = state.station;
    const today = todayDk();
    const from = stationFrom(station);
    const fra = parseDkDate($("fra").value);
    const til = parseDkDate($("til").value);

    if (!fra || !til) return { error: `Skriv datoerne som dd.mm.åååå, for eksempel ${fmtDateParts(today)}.` };
    if (compareDates(til, today) > 0) return { error: `Til kan højst være i dag, ${fmtDateParts(today)}.` };
    if (compareDates(fra, til) > 0) return { error: "Fra skal være samme dag som Til eller tidligere." };
    if (from && compareDates(fra, from) < 0) {
      return { error: `Stationen har data fra ${fmtDateParts(from)}. Vælg en Fra-dato, der ikke ligger før.` };
    }
    const limit = parseLimit($("graense").value);
    if (Number.isNaN(limit)) return { error: "Grænseværdien skal være et tal i cm, for eksempel 120." };
    return { fra, til, limit };
  }

  function setShortcut(range) {
    const station = state.station;
    const til = todayDk();
    const from = stationFrom(station);
    let fra;
    if (range === "7d") fra = addDays(til, -7);
    else if (range === "30d") fra = addDays(til, -30);
    else if (range === "1y") fra = validDate(til.y - 1, til.m, til.d) || addDays({ y: til.y - 1, m: til.m, d: 1 }, til.d - 2);
    else fra = from || addDays(til, -7);
    if (from && compareDates(fra, from) < 0) fra = from;

    $("fra").value = fmtDateParts(fra);
    $("til").value = fmtDateParts(til);
    runPeriod({ excel: false });
  }

  function showProgress(p) {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    $("progressText").textContent =
      `Henter ${p.year}, ${pct} %` + (p.waiting ? ". DMI svarer ikke lige nu, prøver igen om lidt." : "");
    $("progressFill").style.width = pct + "%";
  }

  function setStatus(text) {
    const node = $("dataStatus");
    node.textContent = text || "";
    node.hidden = !text;
  }

  // Henter perioden i Fra og Til fra DMI og viser den. Et nyt kald afbryder det gamle.
  async function runPeriod(opts) {
    const station = state.station;
    if (!station) return;

    const input = readPeriodFields();
    if (input.error) {
      showError($("periodError"), input.error);
      return;
    }
    showError($("periodError"), "");
    setStatus("");
    releaseExcelLinks();

    state.limit = input.limit;
    history.replaceState(null, "", stationHash(station.id, input));
    renderSensors(input);
    renderGauge();

    if (state.job) state.job.abort();
    const job = (state.job = new AbortController());
    const now = Date.now();
    const period = periodOf(input.fra, input.til, now);

    $("progressFill").style.width = "0%";
    $("progressText").textContent = `Henter ${dkParts(period.start).y}, 0 %`;
    clearTimeout(state.progressTimer);
    state.progressTimer = setTimeout(() => {
      if (state.job === job && !job.signal.aborted) $("progress").hidden = false;
    }, 300);

    // Prognosen hentes samtidig med målingerne. Den vises kun, når Til er i dag.
    const wantForecast = period.toToday && !!station.forecast;
    const forecastJob = wantForecast
      ? fetchForecast(station, job.signal).then(
          (points) => ({ points: points.filter((p) => p.t >= period.start) }),
          () => ({ points: null })
        )
      : null;

    try {
      const result = await fetchRange(station, period.start, period.apiEnd, {
        signal: job.signal,
        onProgress: (p) => {
          if (state.job === job) showProgress(p);
        },
      });
      if (job.signal.aborted || state.station !== station) return;
      markFetched();

      const ds = build15(result.series, period.start, period.end, Math.min(period.end, now - GAP_GRACE));
      const view = {
        station,
        period,
        ds,
        failed: result.failed,
        fetchedAt: now,
        forecast: null,
        forecastState: wantForecast ? "loading" : "off",
      };
      state.view = view;
      renderView();
      clearTimeout(state.progressTimer);
      $("progress").hidden = true;

      if (forecastJob) {
        const forecast = await forecastJob;
        if (job.signal.aborted || state.station !== station || state.view !== view) return;
        view.forecast = forecast.points;
        view.forecastState = forecast.points && forecast.points.length ? "ok" : "error";
        renderView();
      }

      if (opts && opts.excel) {
        try {
          await downloadExcel(view);
        } catch (err) {
          setStatus("Excel-filen kunne ikke laves. Prøv en kortere periode.");
        }
      }
    } catch (err) {
      if (state.station !== station) return;
      if (job.signal.aborted) {
        if (job.stoppedByUser) {
          setStatus(
            state.view ? "Hentningen blev stoppet. Siden viser stadig den forrige periode." : "Hentningen blev stoppet."
          );
        }
        return;
      }
      showError($("periodError"), "DMI svarer ikke lige nu. Prøv igen om lidt.");
    } finally {
      if (state.job === job) {
        clearTimeout(state.progressTimer);
        $("progress").hidden = true;
        state.job = null;
      }
    }
  }

  function stopJob() {
    if (!state.job) return;
    state.job.stoppedByUser = true;
    state.job.abort();
  }

  // ---------- Visning af perioden ----------

  // Sammenhængende perioder, der ikke kunne hentes
  function failedRanges(failed) {
    const ranges = [];
    for (const c of failed) {
      const last = ranges[ranges.length - 1];
      if (last && c.start - last.end <= 1000) last.end = c.end;
      else ranges.push({ start: c.start, end: c.end });
    }
    return ranges.map((r) => `${fmtDate(r.start)} til ${fmtDate(r.end)}`);
  }

  function renderView() {
    const view = state.view;
    if (!view) return;
    const { station, ds, failed } = view;
    const stats = seriesStats(ds);
    const hasForecast = !!(view.forecast && view.forecast.length);

    $("noteMissing").textContent = failed.length
      ? `DMI svarede ikke for ${failedRanges(failed).join(", ")}. Den periode mangler i graf, tabel og Excel-fil. Tryk "Vis" for at prøve igen.`
      : "";

    if (stats) {
      view.summary =
        `Seneste værdi er ${fmtLevel(stats.last.v)} cm den ${fmtDateTime(stats.last.t)}, ` +
        `højeste i perioden er ${fmtLevel(stats.max.v)} cm den ${fmtDateTime(stats.max.t)}, ` +
        `og laveste er ${fmtLevel(stats.min.v)} cm den ${fmtDateTime(stats.min.t)}.`;
      $("noteSummary").textContent = view.summary;
      $("noteGaps").textContent =
        ds.gaps === 0
          ? ""
          : ds.gaps === 1
            ? "1 kvarter uden måling i perioden."
            : `${fmtCount(ds.gaps)} kvarterer uden måling i perioden.`;
      renderTable(ds);
    } else {
      const from = stationFrom(station);
      view.summary = "";
      showError(
        $("periodError"),
        "Ingen målinger i perioden." + (from ? ` Stationen har data fra ${fmtDateParts(from)}.` : "")
      );
      $("noteSummary").textContent = "";
      $("noteGaps").textContent = "";
      $("tableBlock").hidden = true;
    }

    renderLimitNotes();
    renderForecastNotes();
    $("notes").hidden = false;

    if (stats || hasForecast) {
      renderChart();
    } else {
      destroyChart();
      $("chartBlock").hidden = true;
    }
  }

  function renderTable(ds) {
    const body = $("tableBody");
    body.textContent = "";
    const firstRow = Math.max(0, ds.n - 50);
    for (let i = ds.n - 1; i >= firstRow; i--) {
      const row = el("tr");
      row.append(
        el("td", "", fmtDateTime(ds.t[i])),
        el("td", "num", fmtLevel(ds.v[i])),
        el("td", "", TYPE_NAMES[ds.type[i]]),
        el("td", "", QC_NAMES[ds.q[i]])
      );
      body.append(row);
    }
    $("tableBlock").hidden = false;
  }

  // ---------- Graf ----------

  const COLOR = {
    ink: "#0F2D40",
    muted: "#55687A",
    line: "#C9D4DB",
    sea: "#0B6FA4",
    forecast: "#B5306F",
    limit: "#C8341F",
    over: "rgba(200, 52, 31, 0.15)",
    none: "rgba(0, 0, 0, 0)",
  };
  const CHART_FONT = '"Source Sans 3", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  function limitLabel(limit) {
    return (limit < 0 ? MINUS : "") + fmtNum(limit);
  }

  function fmtDistance(km) {
    return km < 1 ? `${Math.round(km * 1000)} m` : fmtKm(km);
  }

  // Nullinje, grænselinje og "Nu" tegnes oven på grafen
  const overlayPlugin = {
    id: "vandstandOverlay",
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: area, scales } = chart;
      const y0 = Math.round(scales.y.getPixelForValue(0)) + 0.5;
      if (y0 < area.top || y0 > area.bottom) return;
      ctx.save();
      ctx.strokeStyle = COLOR.ink;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(area.left, y0);
      ctx.lineTo(area.right, y0);
      ctx.stroke();
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: area, scales } = chart;
      const info = state.overlay || {};
      ctx.save();
      ctx.lineWidth = 1;
      ctx.textBaseline = "alphabetic";

      if (info.limit !== null && info.limit !== undefined) {
        const yl = Math.round(scales.y.getPixelForValue(info.limit)) + 0.5;
        if (yl >= area.top && yl <= area.bottom) {
          ctx.strokeStyle = COLOR.limit;
          ctx.beginPath();
          ctx.moveTo(area.left, yl);
          ctx.lineTo(area.right, yl);
          ctx.stroke();

          const text = `Grænse ${limitLabel(info.limit)} cm`;
          ctx.font = `600 14px ${CHART_FONT}`;
          const ty = yl - area.top > 26 ? yl - 7 : yl + 18;
          ctx.textAlign = "left";
          ctx.lineJoin = "round";
          ctx.strokeStyle = "#FFFFFF"; // hvid kant om bogstaverne, så teksten kan læses oven på kurven
          ctx.lineWidth = 4;
          ctx.strokeText(text, area.left + 8, ty);
          ctx.lineWidth = 1;
          ctx.fillStyle = COLOR.limit;
          ctx.fillText(text, area.left + 8, ty);
        }
      }

      if (info.now) {
        const xn = Math.round(scales.x.getPixelForValue(info.now)) + 0.5;
        if (xn >= area.left && xn <= area.right) {
          ctx.strokeStyle = COLOR.ink;
          ctx.beginPath();
          ctx.moveTo(xn, area.top);
          ctx.lineTo(xn, area.bottom);
          ctx.stroke();
          ctx.font = `600 14px ${CHART_FONT}`;
          ctx.fillStyle = COLOR.ink;
          ctx.textAlign = xn > area.right - 24 ? "right" : "center";
          ctx.fillText("Nu", xn, area.top - 6);
        }
      }
      ctx.restore();
    },
  };

  function destroyChart() {
    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }
  }

  function legendItem(className, text) {
    const item = el("li");
    item.append(el("span", "key " + className), el("span", "", text));
    return item;
  }

  function renderChart() {
    const view = state.view;
    const Chart = window.Chart;
    if (!view || !Chart) return;

    const limit = state.limit;
    const hasLimit = limit !== null && Number.isFinite(limit);
    const measured = chartPoints(view.ds);
    const forecast = (view.forecast || []).map((p) => ({ x: p.t, y: p.v, k: TYPE_FORECAST }));

    // Forklaringen står som tekst med små linjestykker over grafen
    const legend = $("legend");
    legend.textContent = "";
    const unit = levelUnit(view.station);
    legend.append(legendItem("", `Målt (${unit})`));
    if (forecast.length) legend.append(legendItem("key-forecast", "Prognose (cm, middelvandstand)"));
    if (hasLimit) legend.append(legendItem("key-limit", "Grænse"));

    // Akser: fra Fra til Til, eller til 5 døgn frem, når prognosen vises
    const xMin = view.period.start;
    const xMax = forecast.length ? Math.max(view.period.end, forecast[forecast.length - 1].x) : view.period.end;

    let lo = 0;
    let hi = 0;
    for (const p of measured) {
      if (p.y === null) continue;
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    }
    for (const p of forecast) {
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    }
    if (hasLimit) {
      lo = Math.min(lo, limit);
      hi = Math.max(hi, limit);
    }
    const margin = Math.max(5, (hi - lo) * 0.06);

    const fill = hasLimit ? { target: { value: limit }, above: COLOR.over, below: COLOR.none } : false;
    const tickLabels = new Map();
    const small = smallScreen.matches;

    Chart.defaults.font.family = CHART_FONT;
    Chart.defaults.font.size = small ? 13 : 14;
    Chart.defaults.color = COLOR.muted;

    destroyChart();
    state.overlay = { limit: hasLimit ? limit : null, now: view.period.toToday ? view.fetchedAt : 0 };
    $("chartBlock").hidden = false;
    const canvas = $("chart");
    canvas.setAttribute(
      "aria-label",
      `Graf over vandstand ved ${view.station.name}. ${view.summary || "Ingen målinger i perioden."}` +
        (forecast.length ? " Prognosen vises som stiplet linje de næste fem døgn." : "")
    );

    state.chart = new Chart(canvas, {
      type: "line",
      data: {
        datasets: [
          {
            label: "Målt",
            data: measured,
            borderColor: COLOR.sea,
            backgroundColor: COLOR.sea,
            borderWidth: 1.5,
            pointRadius: (c) => (c.raw && c.raw.alone ? 1.5 : 0),
            pointHoverRadius: 3,
            pointBorderWidth: 0,
            pointHitRadius: 6,
            spanGaps: false,
            fill,
          },
          {
            label: "Prognose",
            data: forecast,
            borderColor: COLOR.forecast,
            backgroundColor: COLOR.forecast,
            borderWidth: 1.5,
            borderDash: [6, 4],
            pointRadius: 0,
            pointHoverRadius: 3,
            pointBorderWidth: 0,
            pointHitRadius: 6,
            fill,
          },
        ],
      },
      options: {
        parsing: false,
        normalized: true,
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        layout: { padding: { top: 24, right: 8 } },
        scales: {
          x: {
            type: "linear",
            min: xMin,
            max: xMax,
            grid: { color: COLOR.line },
            border: { color: COLOR.line },
            ticks: {
              autoSkip: false,
              maxRotation: 0,
              callback: (value) => tickLabels.get(value) || "",
            },
            afterBuildTicks: (scale) => {
              const ticks = timeTicks(scale.min, scale.max, Math.max(2, Math.floor(scale.width / (small ? 60 : 104))));
              tickLabels.clear();
              for (const t of ticks) tickLabels.set(t.value, t.label);
              scale.ticks = ticks.map((t) => ({ value: t.value }));
            },
          },
          y: {
            suggestedMin: lo - margin,
            suggestedMax: hi + margin,
            grid: { color: COLOR.line },
            border: { display: false },
            ticks: { maxTicksLimit: small ? 7 : 9, callback: (value) => fmtLevel(value) },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            backgroundColor: COLOR.ink,
            titleColor: "#FFFFFF",
            bodyColor: "#FFFFFF",
            cornerRadius: 4,
            padding: 10,
            titleFont: { weight: "600" },
            callbacks: {
              title: (items) => (items.length ? fmtDateTime(items[0].parsed.x) : ""),
              label: (item) => {
                const p = item.raw;
                const over = hasLimit && p.y > limit;
                if (p.k === TYPE_FORECAST) {
                  const lines = [`${fmtLevel(p.y)} cm i forhold til middelvandstand, prognose`];
                  if (over) lines.push("Over grænsen (prognose, andet nulpunkt)");
                  return lines;
                }
                const lines = [`${fmtLevel(p.y)} ${unit}, ${TYPE_NAMES[p.k]}`];
                if (over) lines.push("Over grænsen");
                return lines;
              },
            },
          },
        },
      },
      plugins: [overlayPlugin],
    });
  }

  // ---------- Tekster under grafen ----------

  function renderLimitNotes() {
    const view = state.view;
    const limit = state.limit;
    const note = $("noteLimit");
    const forecastNote = $("noteForecastLimit");
    note.textContent = "";
    forecastNote.textContent = "";
    if (!view || limit === null || !Number.isFinite(limit)) return;

    const text = limitLabel(limit);
    if (view.ds.n) {
      const e = exceedOfSeries(view.ds, limit);
      if (e.count === 0) {
        note.textContent = `Ingen punkter på den målte kurve ligger over grænsen på ${text} cm.`;
      } else {
        note.textContent =
          `${fmtCount(e.count)} ${e.count === 1 ? "punkt" : "punkter"} på den målte kurve ligger over grænsen på ${text} cm ` +
          `(${fmtCount(e.measured)} målt, ${fmtCount(e.computed)} beregnet). ` +
          `Første ${fmtDateTime(e.first)}, seneste ${fmtDateTime(e.last)}. ` +
          `Højeste værdi ${fmtLevel(e.max)} cm den ${fmtDateTime(e.maxT)}.`;
      }
    }

    if (view.forecast && view.forecast.length) {
      const f = exceedOfForecast(view.forecast, limit);
      forecastNote.textContent =
        f.count === 0
          ? "Ingen prognosepunkter ligger over grænsen (prognose, andet nulpunkt)."
          : `${fmtCount(f.count)} ${f.count === 1 ? "prognosepunkt" : "prognosepunkter"} ligger over grænsen (prognose, andet nulpunkt). ` +
            `Første ${fmtDateTime(f.first)}, seneste ${fmtDateTime(f.last)}. ` +
            `Højeste værdi ${fmtLevel(f.max)} cm den ${fmtDateTime(f.maxT)}.`;
    }
  }

  function renderForecastNotes() {
    const view = state.view;
    const note = $("noteForecast");
    const overlapNote = $("noteOverlap");
    note.classList.remove("msg-error");
    note.textContent = "";
    overlapNote.textContent = "";
    if (!view) return;

    const station = view.station;
    if (!station.forecast) {
      note.textContent = "Ingen prognose for denne station.";
      return;
    }
    if (view.forecastState === "off") {
      note.textContent = "Prognosen vises, når Til er i dag.";
      return;
    }
    if (view.forecastState === "loading") {
      note.textContent = "Henter prognose fra DMI …";
      return;
    }
    if (view.forecastState === "error" || !view.forecast || !view.forecast.length) {
      note.textContent = 'Prognosen kunne ikke hentes fra DMI lige nu. Tryk "Vis" for at prøve igen.';
      note.classList.add("msg-error");
      return;
    }

    const f = station.forecast;
    const km = haversineKm(station.lat, station.lon, f.lat, f.lon);
    const last = view.forecast[view.forecast.length - 1].t;
    note.textContent =
      `Prognosen er fra DMI's stormflodsmodel DKSS (${f.model}) i et modelpunkt ${fmtDistance(km)} fra stationen ` +
      `og går til ${fmtDateTime(last)}.` +
      (km > 5 ? " Modelpunktet ligger langt fra stationen, så prognosen kan afvige meget fra vandstanden her." : "");

    const o = overlapOf(view.ds, view.forecast);
    const basis = datumKnown(station)
      ? " Måling er i DVR90, prognose er afvigelse fra middelvandstand. Prognosen er ikke justeret."
      : " DMI dokumenterer ikke målingens nulpunkt, og prognosen er afvigelse fra middelvandstand. " +
        "Forskellen kan derfor skyldes forskellige nulpunkter. Prognosen er ikke justeret.";
    if (o.n === 0) {
      overlapNote.textContent = "Der er endnu ingen timer med både måling og prognose, så forskellen kan ikke beregnes." + basis;
      return;
    }
    const mean = Math.round(o.mean);
    const hours = o.n === 1 ? "den seneste time" : `de seneste ${o.n} timer`;
    const how =
      mean === 0
        ? "Målingen lå i gennemsnit under 1 cm fra prognosen"
        : `Målingen lå i gennemsnit ${Math.abs(mean)} cm ${mean > 0 ? "over" : "under"} prognosen`;
    overlapNote.textContent = `${how} ${hours} med både måling og prognose.` + basis;
  }

  // ---------- Excel-fil ----------

  function releaseExcelLinks() {
    for (const url of state.blobUrls) URL.revokeObjectURL(url);
    state.blobUrls = [];
    $("excelParts").textContent = "";
    $("excelParts").hidden = true;
  }

  function saveFile(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // Laver filen af det, der lige er hentet: 15-minutters datasættet og prognosen.
  async function downloadExcel(view) {
    const { station, period, ds } = view;
    const forecast = view.forecastState === "ok" ? view.forecast : [];
    if (!ds.n && !forecast.length) return;

    setStatus("Laver Excel-fil …");
    await new Promise((resolve) => setTimeout(resolve, 30)); // lad teksten nå at blive vist
    if (state.view !== view) return;

    const parts = csvParts(csvBlocks(ds, forecast, QC_NAMES), CSV_MAX_ROWS);
    const total = parts.reduce((sum, p) => sum + p.rows, 0);
    const type = "text/csv;charset=utf-8";
    const extra =
      (view.period.toToday && station.forecast && view.forecastState !== "ok"
        ? " Prognosen er ikke med, fordi den ikke kunne hentes."
        : "") + (view.failed.length ? " Nogle perioder mangler, se under grafen." : "");

    if (parts.length === 1) {
      const name = csvFileName(station, period.fra, period.til, 1, 1);
      saveFile(new Blob(csvPieces(parts[0], station), { type }), name);
      setStatus(`Excel-filen er hentet: ${name} med ${fmtCount(total)} rækker.` + extra);
      return;
    }

    // Over 1.000.000 rækker: sig det først, og lad brugeren hente filerne én ad gangen.
    setStatus(
      `Perioden har ${fmtCount(total)} rækker. Excel kan højst vise 1.048.576 rækker, ` +
        `så filen er delt i ${parts.length} filer på hele år. Hent dem her:` + extra
    );
    const list = el("ul");
    parts.forEach((part, index) => {
      const name = csvFileName(station, period.fra, period.til, index + 1, parts.length);
      const url = URL.createObjectURL(new Blob(csvPieces(part, station), { type }));
      state.blobUrls.push(url);
      const firstYear = part.blocks[0].year;
      const lastYear = part.blocks[part.blocks.length - 1].year;
      const years = firstYear === lastYear ? `${firstYear}` : `${firstYear} til ${lastYear}`;
      const link = el("a", "", `Hent del ${index + 1}: ${years}, ${fmtCount(part.rows)} rækker`);
      link.href = url;
      link.download = name;
      const item = el("li");
      item.append(link);
      list.append(item);
    });
    const box = $("excelParts");
    box.textContent = "";
    box.append(list);
    box.hidden = false;
  }

  // ---------- Start ----------

  function start() {
    $("searchForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const postnr = $("postnr").value.trim();
      const target = "#postnr=" + encodeURIComponent(postnr);
      if (location.hash === target) route();
      else location.hash = target;
    });

    $("periodForm").addEventListener("submit", (event) => {
      event.preventDefault();
      runPeriod({ excel: false });
    });
    $("excelBtn").addEventListener("click", () => runPeriod({ excel: true }));
    $("stopBtn").addEventListener("click", stopJob);
    $("shortcuts").addEventListener("click", (event) => {
      const range = event.target && event.target.getAttribute && event.target.getAttribute("data-range");
      if (range) setShortcut(range);
    });

    // Grænseværdien kan ændres uden at hente data igen
    $("graense").addEventListener("change", () => {
      if (!state.station) return;
      const limit = parseLimit($("graense").value);
      if (Number.isNaN(limit)) {
        showError($("periodError"), "Grænseværdien skal være et tal i cm, for eksempel 120.");
        return;
      }
      showError($("periodError"), "");
      state.limit = limit;
      const input = readPeriodFields();
      if (!input.error) {
        history.replaceState(null, "", stationHash(state.station.id, input));
        renderSensors(input);
      }
      renderGauge();
      renderView();
    });

    // Seneste måling opdateres hvert 5. minut, mens fanen er synlig
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.station && Date.now() - (state.latestAt || 0) >= LIVE_EVERY) refreshLatest();
    });
    smallScreen.addEventListener("change", () => {
      if (!state.station) return;
      renderGauge();
      renderView();
    });

    // Grafens tekster tegnes på et canvas. Tegn igen, når skriften er hentet.
    if (document.fonts && document.fonts.load) {
      Promise.all([document.fonts.load('400 14px "Source Sans 3"'), document.fonts.load('600 14px "Source Sans 3"')])
        .then(() => {
          if (state.chart) state.chart.update();
        })
        .catch(() => {});
    }

    loadLists()
      .then(() => {
        window.addEventListener("hashchange", route);
        route();
      })
      .catch(() => {
        showError($("searchError"), "Stationslisten kunne ikke hentes. Prøv at genindlæse siden.");
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof window !== "undefined" ? window : globalThis);
