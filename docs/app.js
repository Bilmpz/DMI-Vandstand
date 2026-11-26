/* DMI Vandstand v3.0. Ingen byggeværktøjer og ingen frameworks. */
(function (root) {
  "use strict";

  const STATIONS_URL = "data/stations.json";
  const POSTNR_URL = "data/postnumre.json";
  const OBS_URL = "https://opendataapi.dmi.dk/v2/oceanObs/collections/observation/items";
  const TIDE_URL = "https://opendataapi.dmi.dk/v2/oceanObs/collections/tidewater/items";
  const SMHI_URL = "https://opendata-download-ocobs.smhi.se/api/version/latest/parameter";
  const SMHI_ARCHIVE_URL = "https://opendata-download-ocobs.smhi.se/api/version/1.0/parameter";
  const PEGEL_URL = "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations";
  const OPENMETEO_URL = "https://marine-api.open-meteo.com/v1/marine";
  const TIDE_FROM = "2025-12-31"; // DMI's tidevand findes fra 31.12.2025 (målt 26.11.2026)
  const OPENMETEO_FROM = "2022-11-23"; // Open-Meteo marine har vandstand fra 23.11.2022 (målt 26.11.2026)
  const PEGEL_DAYS = 30; // PEGELONLINE har kun ca. 30 dage tilbage

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

  // ---------- Måleserier: kilde, parameter, nulpunkt og enhed ----------

  const STATUS_ACTIVE = "aktiv";
  const OWNER_KYST = "Kystdirektoratet";
  const OWNER_ORDER = ["DMI", "Kystdirektoratet", "Havn/kommune", "Ikke oplyst", "SMHI", "Sjöfartsverket", "WSV"];
  const PLACE_KM = 3; // stationer med samme navn under 3 km fra hinanden er ét sted
  const COUNTRY_NAMES = { DK: "Danmark", SE: "Sverige", DE: "Tyskland" };

  // Kilderne. Målinger: DMI, SMHI og PEGELONLINE. Beregnet: DMI's tidevand, DMI's prognose (DKSS) og Open-Meteo.
  const SRC_DMI = "DMI";
  const SRC_SMHI = "SMHI";
  const SRC_PEGEL = "PEGELONLINE";
  const SRC_KYST = "Kystatlas";
  const SRC_TIDE = "DMI tidevand";
  const SRC_DKSS = "DMI prognose";
  const SRC_OPENMETEO = "Open-Meteo";

  const KIND_MEASURED = "målt";
  const KIND_TIDE = "tidevand";
  const KIND_MODEL = "model";
  const KIND_FORECAST = "prognose";

  const DATUM_TIDE = "nulpunkt ikke oplyst af DMI";

  // Nulpunktet for én måleserie (station × parameter)
  function datumOf(station, parameter) {
    const source = station.source || SRC_DMI;
    if (source === SRC_SMHI) return parameter === "smhi_mw" ? "middelvandstand (SMHI)" : "RH2000";
    if (source === SRC_PEGEL) return typeof station.gaugeZeroNhn === "number" ? "NHN (omregnet fra pegelnul)" : "pegelnul";
    if (source === SRC_KYST) return "DVR90";
    if (parameter === "sealev_dvr") return "DVR90";
    if (parameter === "sealev_ln") return "lokalt nulpunkt";
    if (parameter === "sea_reg") return station.owner === OWNER_KYST ? "DVR90 ifølge DMI" : "nulpunkt ikke dokumenteret";
    if (parameter === "tw") return "°C, vandtemperatur";
    return "ikke dokumenteret";
  }

  function isTemperature(series) {
    return series.parameter === "tw";
  }

  function isDvr90(series) {
    return series.datum === "DVR90" || series.datum === "DVR90 ifølge DMI";
  }

  // "cm" eller "°C"
  function unitShort(series) {
    return isTemperature(series) ? "°C" : "cm";
  }

  // Enhed med nulpunkt. Kun serier, der er i DVR90, får "DVR90". Svenske tal er i RH 2000, tyske i NHN eller over pegelnul.
  function unitLabel(series) {
    if (isTemperature(series)) return "°C";
    if (isDvr90(series)) return "cm DVR90";
    if (series.datum === "RH2000") return "cm RH2000";
    if (series.datum === "pegelnul") return "cm over pegelnul";
    if (series.datum === "NHN (omregnet fra pegelnul)") return "cm NHN (omregnet fra pegelnul)";
    return "cm, " + series.datum;
  }

  // Kort nulpunkt til vandstandsbrættets nullinje
  function zeroLabel(series) {
    if (isDvr90(series)) return "0 DVR90";
    if (series.datum === "RH2000") return "0 RH2000";
    if (series.datum === "NHN (omregnet fra pegelnul)") return "0 NHN";
    return "0";
  }

  function seriesName(series) {
    return series.label || `${series.id} ${series.parameter}`;
  }

  // Parameteren, som den står i tabellen "Måleserier"
  function paramLabel(series) {
    if (series.source === SRC_SMHI) return series.parameter === "smhi_mw" ? "Havsvattenstånd, RW" : "Havsvattenstånd";
    if (series.source === SRC_PEGEL) return "W (Wasserstand)";
    if (series.source === SRC_KYST) return "Vandstand (Kystatlas)";
    if (series.kind === KIND_TIDE) return "Tidevand (beregnet af DMI)";
    if (series.kind === KIND_MODEL) return "Open-Meteo (global model, grov)";
    if (series.kind === KIND_FORECAST) return "Prognose (DMI's model DKSS)";
    return series.parameter;
  }

  // Vandstand med fortegn (+22, −5). Temperatur uden plus.
  function fmtValue(series, v) {
    if (!isTemperature(series)) return fmtLevel(v);
    const r = round1(v);
    return (r < 0 ? MINUS : "") + fmtNum(r);
  }

  function isMeasured(series) {
    return !series.kind || series.kind === KIND_MEASURED;
  }

  // ---------- Steder ----------

  const NUMERALS = { I: 1, II: 2, III: 3 };
  const NAME_SUFFIX = /\s+(III|II|I|\(old\))$/i;

  // Navnet uden " I", " II", " III" og " (Old)" til sidst
  function baseName(name) {
    let n = String(name).trim();
    for (;;) {
      const m = n.replace(NAME_SUFFIX, "");
      if (m === n) return n;
      n = m;
    }
  }

  function placeKey(name) {
    return baseName(name).toLocaleLowerCase("da");
  }

  function numeral(name) {
    const m = /\s+(III|II|I)$/.exec(String(name).trim());
    return m ? NUMERALS[m[1]] : 0;
  }

  // Aktive stationer først, derefter laveste nummerering og station-id
  function stationOrder(a, b) {
    return (
      (b.status === STATUS_ACTIVE) - (a.status === STATUS_ACTIVE) ||
      numeral(a.name) - numeral(b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  }

  function seriesLabel(station, parameter) {
    if (station.source === SRC_SMHI) return `${station.id} ${parameter === "smhi_mw" ? "RW" : "RH2000"}`;
    return `${station.id} ${parameter}`;
  }

  // Én måleserie pr. parameter. Serien har stationens felter med, så den kan bruges som en station.
  function seriesOf(station) {
    return (station.parameters || []).map((parameter) => ({
      key: station.id + ":" + parameter,
      id: station.id,
      parameter,
      label: seriesLabel(station, parameter),
      station,
      source: station.source || SRC_DMI,
      country: station.country || "DK",
      kind: KIND_MEASURED,
      datum: datumOf(station, parameter),
      active: station.status === STATUS_ACTIVE,
      name: station.name,
      owner: station.owner,
      lat: station.lat,
      lon: station.lon,
      from: station.from,
      to: station.to || null,
      forecast: station.forecast || null,
    }));
  }

  // Tidevand beregnet af DMI for et tidevandssted
  function tideSeries(tide) {
    return {
      key: "tide:" + tide.stationId,
      id: tide.stationId,
      parameter: "tidevand",
      label: `${tide.stationId} tidevand`,
      station: tide,
      source: SRC_TIDE,
      country: "DK",
      kind: KIND_TIDE,
      datum: DATUM_TIDE,
      active: true,
      name: tide.name,
      owner: "DMI",
      lat: tide.lat,
      lon: tide.lon,
      from: TIDE_FROM,
      to: null,
      forecast: null,
    };
  }

  // Open-Meteo i et punkt. Valgfri og ikke valgt fra start.
  function modelSeries(key, name, lat, lon) {
    return {
      key: "openmeteo:" + key,
      id: "Open-Meteo",
      parameter: "sea_level_height_msl",
      label: "Open-Meteo",
      station: { id: "Open-Meteo", name, lat, lon },
      source: SRC_OPENMETEO,
      country: "",
      kind: KIND_MODEL,
      datum: "middelvandstand",
      active: true,
      name,
      owner: "Open-Meteo",
      lat,
      lon,
      from: OPENMETEO_FROM,
      to: null,
      forecast: null,
    };
  }

  // Hovedserien: DMI sealev_dvr, sea_reg fra Kystdirektoratet, sea_reg fra andre, sealev_ln.
  // Svenske steder: RH 2000-serien. Tyske steder: W.
  function mainRank(series) {
    if (series.source === SRC_SMHI) return series.parameter === "smhi_rh2000" ? 0 : 1;
    if (series.source === SRC_PEGEL) return 0;
    if (series.parameter === "sealev_dvr") return 0;
    if (series.source === SRC_KYST) return 1;
    if (series.parameter === "sea_reg") return series.owner === OWNER_KYST ? 1 : 2;
    if (series.parameter === "sealev_ln") return 3;
    return 4;
  }

  function makePlace(members) {
    const stations = members.slice().sort(stationOrder);
    const all = [].concat(...stations.map(seriesOf));
    const active = all.filter((s) => s.active);
    // Blandt aktive stationer. Har stedet ingen, vælges blandt de nedlagte, nyeste først.
    const pool = active.length ? active : all;
    const main =
      pool.slice().sort(
        (a, b) =>
          mainRank(a) - mainRank(b) ||
          String(b.to || "").localeCompare(String(a.to || "")) ||
          stationOrder(a.station, b.station)
      )[0] || null;
    const series = main ? [main].concat(all.filter((s) => s !== main)) : all;

    const owners = [];
    for (const o of OWNER_ORDER) if (stations.some((s) => s.owner === o)) owners.push(o);
    for (const s of stations) if (!owners.includes(s.owner)) owners.push(s.owner);

    let from = null;
    let to = null;
    for (const s of stations) {
      if (s.from && (!from || s.from < from)) from = s.from;
      if (s.to && (!to || s.to > to)) to = s.to;
    }
    const anchor = main ? main.station : stations[0];
    return {
      kind: "sted",
      name: baseName(anchor.name),
      country: anchor.country || "DK",
      sources: Array.from(new Set(stations.map((s) => s.source || SRC_DMI))),
      stations,
      series,
      main,
      owners,
      active: active.length > 0,
      from,
      to: active.length ? null : to,
      lat: anchor.lat,
      lon: anchor.lon,
    };
  }

  // Et sted er alle stationer med samme navn og under 3 km fra hinanden, på tværs af ejer og status,
  // men aldrig på tværs af lande. Navnene sammenlignes uden store/små bogstaver og uden " I", " II", " III"
  // og " (Old)" til sidst.
  function buildPlaces(stations, tides) {
    const n = stations.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const keys = stations.map((s) => placeKey(s.name));
    const country = (s) => s.country || "DK";
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (keys[i] !== keys[j]) continue;
        const a = stations[i];
        const b = stations[j];
        if (country(a) !== country(b)) continue;
        if (haversineKm(a.lat, a.lon, b.lat, b.lon) < PLACE_KM) parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    stations.forEach((s, i) => {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(s);
    });
    const places = Array.from(groups.values(), makePlace);
    attachTides(places, tides || []);
    for (const place of places) {
      if (place.active) place.series.push(modelSeries(place.name + "|" + place.lat + "|" + place.lon, place.name, place.lat, place.lon));
    }
    return places;
  }

  // Et tidevandssted knyttes til det nærmeste danske sted, når det ligger under 3 km fra en af stedets stationer.
  function attachTides(places, tides) {
    for (const tide of tides) {
      let best = null;
      let bestKm = PLACE_KM;
      for (const place of places) {
        if (place.country !== "DK") continue;
        for (const s of place.stations) {
          const km = haversineKm(tide.lat, tide.lon, s.lat, s.lon);
          if (km < bestKm) {
            bestKm = km;
            best = place;
          }
        }
      }
      if (best) {
        const series = tideSeries(tide);
        series.distanceKm = bestKm;
        best.series.push(series);
        best.tide = best.tide || series;
      }
    }
  }

  // En havn uden måler: DMI's prognose i havnen og de nærmeste målinger ved siden af
  function makeHarbour(h) {
    const forecast = {
      key: "dkss:" + h.id,
      id: h.id,
      parameter: "dkss",
      label: `Prognose ${h.name}`,
      station: h,
      source: SRC_DKSS,
      country: "DK",
      kind: KIND_FORECAST,
      datum: "middelvandstand",
      active: true,
      name: h.name,
      owner: "DMI",
      lat: h.lat,
      lon: h.lon,
      from: null,
      to: null,
      forecast: h.forecast || null,
    };
    return {
      kind: "havn",
      id: h.id,
      name: h.name,
      country: "DK",
      sources: [SRC_DKSS],
      harbour: h,
      stations: [],
      series: [forecast, modelSeries(h.id, h.name, h.lat, h.lon)],
      main: forecast,
      owners: ["Havn uden måler"],
      active: true,
      from: null,
      to: null,
      lat: h.lat,
      lon: h.lon,
    };
  }

  // De nærmeste steder. Uden withClosed kun steder med mindst én aktiv station.
  function nearestPlaces(places, lat, lon, count, withClosed, filter) {
    return places
      .filter((place) => (withClosed || place.active) && (!filter || filter(place)))
      .map((place) => ({ place, km: haversineKm(lat, lon, place.lat, place.lon) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, count);
  }

  // ====================================================================
  // Kald til kilderne. Højst 2 kald ad gangen til hver vært, og nyt forsøg ved 429 og 5xx.
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

  const HOST_LIMIT = 2;
  const hostGates = new Map();

  // En kø pr. vært. En ledig plads gives direkte videre til den næste i køen.
  function gateFor(url) {
    const m = /^https?:\/\/([^/]+)/.exec(url);
    const host = m ? m[1] : "";
    let gate = hostGates.get(host);
    if (!gate) {
      gate = { active: 0, queue: [] };
      hostGates.set(host, gate);
    }
    return gate;
  }

  async function acquire(gate, signal) {
    if (gate.active < HOST_LIMIT) {
      gate.active++;
      return;
    }
    await new Promise((resolve, reject) => {
      const item = { resolve };
      gate.queue.push(item);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            const i = gate.queue.indexOf(item);
            if (i >= 0) {
              gate.queue.splice(i, 1);
              reject(new DOMException("Afbrudt", "AbortError"));
            }
          },
          { once: true }
        );
      }
    });
  }

  function release(gate) {
    const next = gate.queue.shift();
    if (next) next.resolve();
    else gate.active--;
  }

  // Svaret som JSON. Lokale filer (data/...) går ikke gennem køen.
  async function getJson(url, signal) {
    if (!/^https?:/.test(url)) {
      const response = await fetch(url, { signal, cache: "no-store" });
      if (!response.ok) throw new HttpError(response.status);
      return response.json();
    }
    const gate = gateFor(url);
    await acquire(gate, signal);
    try {
      const response = await fetch(url, { signal, cache: "no-store" });
      if (!response.ok) throw new HttpError(response.status);
      return await response.json();
    } finally {
      release(gate);
    }
  }

  // Læser en tekstfil linje for linje uden at holde hele filen i hukommelsen. onLine giver false for at stoppe.
  async function streamLines(url, signal, onLine, onBytes) {
    const gate = gateFor(url);
    await acquire(gate, signal);
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new HttpError(response.status);
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let rest = "";
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (onBytes) onBytes(bytes);
        const text = rest + decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        rest = lines.pop();
        for (const line of lines) {
          if (onLine(line) === false) {
            await reader.cancel();
            return;
          }
        }
      }
      if (rest) onLine(rest);
    } finally {
      release(gate);
    }
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
  async function fetchLatestDmi(station, signal) {
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
    const tide = station.kind === KIND_TIDE;
    let url = tide
      ? `${TIDE_URL}?stationId=${encodeURIComponent(station.id)}&datetime=${range}&limit=${PAGE_LIMIT}`
      : obsUrl(station, `datetime=${range}&limit=${PAGE_LIMIT}`);
    const t = [];
    const v = [];
    const q = [];

    for (let page = 0; url && page < 100; page++) {
      const data = await getJson(url, signal);
      const features = data.features || [];
      for (const f of features) {
        const p = f.properties;
        if (!p || typeof p.value !== "number") continue;
        // Tidevandet har også højvande og lavvande. Kurven bruger værdierne hvert 10. minut.
        if (tide && p.predictionType !== "10minutes") continue;
        const ms = Date.parse(tide ? p.predictionTime : p.observed);
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
  // Bidden med de nyeste målinger hentes altid igen. Nøglen er serie og bid. Tømmes, når man skifter sted.
  const chunkCache = new Map();

  function clearChunkCache() {
    chunkCache.clear();
  }

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

    const prefix = station.id + "|" + station.parameter + "|";
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
      const key = prefix + chunk.start + "|" + chunk.end;
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
    await pool(chunks, HOST_LIMIT, async (chunk, i) => {
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

  // ====================================================================
  // Kilder. Hver kilde har en lille adapter med samme form:
  //   latest(series, signal)              -> { latest: { t, v, q }, ref: { t, v } } eller null
  //   range(series, startMs, endMs, opts) -> { series: pakkede målinger, failed: [{ start, end, year }], note }
  // Resten af siden kender ikke forskel på kilderne.
  // ====================================================================

  // Den måling i points, der ligger tættest på target, inden for 15 minutter
  function nearestPoint(t, v, target) {
    let best = -1;
    for (let i = 0; i < t.length; i++) {
      if (Math.abs(t[i] - target) > 15 * MIN) continue;
      if (best < 0 || Math.abs(t[i] - target) < Math.abs(t[best] - target)) best = i;
    }
    return best < 0 ? null : { t: t[best], v: v[best] };
  }

  // Seneste måling og målingen ca. 60 minutter før ud fra en pakket serie
  function latestOf(packed) {
    if (!packed.n) return null;
    const i = packed.n - 1;
    const latest = { t: packed.t[i], v: packed.v[i], q: QC_NAMES[packed.q[i]] || "" };
    return { latest, ref: nearestPoint(packed.t, packed.v, latest.t - HOUR) };
  }

  function wholeRangeFailed(startMs, endMs) {
    return [{ start: startMs, end: endMs, year: new Date(startMs).getUTCFullYear() }];
  }

  const ADAPTERS = {};

  // ---------- DMI: målinger i kvartaler fra oceanObs ----------

  ADAPTERS[SRC_DMI] = {
    async latest(series, signal) {
      const latest = await fetchLatestDmi(series, signal);
      if (!latest) return null;
      let ref = null;
      try {
        ref = await fetchReference(series, latest.t - HOUR, signal);
      } catch (err) {
        if (signal && signal.aborted) throw err;
      }
      return { latest, ref };
    },
    range: (series, startMs, endMs, opts) => fetchRange(series, startMs, endMs, opts),
  };

  // ---------- DMI's tidevand: beregnet hvert 10. minut ----------

  ADAPTERS[SRC_TIDE] = {
    latest: async () => null,
    range: (series, startMs, endMs, opts) => fetchRange(series, startMs, endMs, opts),
  };

  // ---------- SMHI ----------
  // Parameter 13 (minutværdier) og 6 (timeværdier) er i RH 2000. 14 og 12 ("RW") er i forhold til middelvandstand.
  // Det seneste døgn hentes som JSON. Ældre minutværdier findes kun i arkivfilen (en CSV for hele perioden,
  // fx 19 MB komprimeret for Helsingborg), som læses linje for linje og stoppes, når perioden er nået.
  // Perioder, der slutter mere end 92 dage tilbage, hentes som timeværdier fra det mindre timearkiv.

  const SMHI_PARAMS = { smhi_rh2000: { minute: 13, hour: 6 }, smhi_mw: { minute: 14, hour: 12 } };
  const SMHI_MINUTE_DAYS = 92;
  const smhiCache = [];

  function smhiJsonUrl(series, period) {
    const p = SMHI_PARAMS[series.parameter].minute;
    return `${SMHI_URL}/${p}/station/${encodeURIComponent(series.station.sourceId)}/period/${period}/data.json`;
  }

  function smhiPack(data, startMs, endMs) {
    const t = [];
    const v = [];
    const q = [];
    for (const x of (data && data.value) || []) {
      if (typeof x.value !== "number" || typeof x.date !== "number") continue;
      if (x.date < startMs || x.date > endMs) continue;
      t.push(x.date);
      v.push(x.value);
      q.push(qcCode(x.quality || ""));
    }
    return packSeries(t, v, q);
  }

  // Arkivfilen: "2026-11-25 23:57:00;16.8;G;0" i UTC, sorteret efter tid
  async function smhiArchive(series, param, startMs, endMs, opts) {
    const cached = smhiCache.find(
      (c) => c.key === series.key + "|" + param && c.start <= startMs && c.end >= endMs && Date.now() - c.at < CACHE_FOR
    );
    if (cached) return buildRaw(cached.packed, startMs, endMs);

    const url = `${SMHI_ARCHIVE_URL}/${param}/station/${encodeURIComponent(series.station.sourceId)}/period/corrected-archive/data.csv`;
    const t = [];
    const v = [];
    const q = [];
    const from = parseIsoDate(series.from);
    const fileStart = from ? Date.UTC(from.y, from.m - 1, from.d) : startMs;
    const span = Math.max(1, Math.min(endMs, Date.now()) - fileStart);
    let lastReport = 0;
    let year = new Date(fileStart).getUTCFullYear();
    await streamLines(
      url,
      opts.signal,
      (line) => {
        const c = line.charCodeAt(0);
        if (c < 48 || c > 57 || line.length < 21 || line[4] !== "-" || line[10] !== " ") return true;
        const ms = Date.UTC(+line.slice(0, 4), +line.slice(5, 7) - 1, +line.slice(8, 10), +line.slice(11, 13), +line.slice(14, 16), +line.slice(17, 19));
        if (ms > endMs) return false; // filen er sorteret: resten ligger efter perioden
        year = +line.slice(0, 4);
        if (ms < startMs) return true;
        const a = line.indexOf(";", 19);
        const b = line.indexOf(";", a + 1);
        const value = parseFloat(line.slice(a + 1, b < 0 ? undefined : b));
        if (Number.isNaN(value)) return true;
        const e = b < 0 ? -1 : line.indexOf(";", b + 1);
        t.push(ms);
        v.push(value);
        q.push(qcCode(b < 0 ? "" : line.slice(b + 1, e < 0 ? undefined : e).trim()));
        return true;
      },
      () => {
        const now = Date.now();
        if (!opts.onProgress || now - lastReport < 250) return;
        lastReport = now;
        const done = Math.max(0, Math.min(1, (Date.UTC(year, 0, 1) - fileStart) / span));
        opts.onProgress({ year, done: Math.round(done * 1000), total: 1000, waiting: false });
      }
    );
    const packed = packSeries(t, v, q);
    smhiCache.length = 0; // kun den seneste arkivlæsning gemmes
    smhiCache.push({ key: series.key + "|" + param, start: startMs, end: endMs, at: Date.now(), packed });
    return packed;
  }

  ADAPTERS[SRC_SMHI] = {
    async latest(series, signal) {
      const data = await getJsonRetry(smhiJsonUrl(series, "latest-day"), signal, [2000, 6000]);
      return latestOf(smhiPack(data, 0, Infinity));
    },
    async range(series, startMs, endMs, opts) {
      const now = Date.now();
      const P = SMHI_PARAMS[series.parameter];
      const parts = [];
      let note = "";
      try {
        if (startMs >= now - 23 * HOUR) {
          parts.push(smhiPack(await getJsonRetry(smhiJsonUrl(series, "latest-day"), opts.signal, [2000, 6000]), startMs, endMs));
        } else if (!opts.raw && endMs < now - SMHI_MINUTE_DAYS * DAY) {
          parts.push(await smhiArchive(series, P.hour, startMs, endMs, opts));
          note = "SMHI: perioden er hentet som timeværdier fra SMHI's arkiv, så 15-minutters datasættet har kun hele timer.";
        } else {
          parts.push(await smhiArchive(series, P.minute, startMs, endMs, opts));
          // Arkivet går til kl. 00 UTC i dag. Resten kommer fra det seneste døgn.
          const midnight = Math.floor(now / DAY) * DAY;
          if (endMs >= midnight - HOUR) {
            parts.push(smhiPack(await getJsonRetry(smhiJsonUrl(series, "latest-day"), opts.signal, [2000, 6000]), startMs, endMs));
          }
          note = "SMHI: minutværdierne er læst fra SMHI's arkivfil for hele stationen. Den kan tage lidt tid at hente.";
        }
      } catch (err) {
        if (opts.signal && opts.signal.aborted) throw err;
        return { series: EMPTY_SERIES, failed: wholeRangeFailed(startMs, endMs), note: "" };
      }
      return { series: mergeSorted(parts), failed: [], note };
    },
  };

  // Flere pakkede serier til én, sorteret og uden dubletter
  function mergeSorted(parts) {
    const t = [];
    const v = [];
    const q = [];
    for (const p of parts) {
      for (let i = 0; i < p.n; i++) {
        t.push(p.t[i]);
        v.push(p.v[i]);
        q.push(p.q[i]);
      }
    }
    return packSeries(t, v, q);
  }

  // ---------- PEGELONLINE: minutværdier for de seneste ca. 30 dage ----------

  function pegelValue(series, v) {
    const zero = series.station.gaugeZeroNhn;
    return typeof zero === "number" ? round1(v + zero * 100) : v;
  }

  function pegelPack(series, data) {
    const t = [];
    const v = [];
    const q = [];
    for (const x of Array.isArray(data) ? data : []) {
      if (typeof x.value !== "number") continue;
      const ms = Date.parse(x.timestamp);
      if (Number.isNaN(ms)) continue;
      t.push(ms);
      v.push(pegelValue(series, x.value));
      q.push(0);
    }
    return packSeries(t, v, q);
  }

  function pegelUrl(series, query) {
    return `${PEGEL_URL}/${encodeURIComponent(series.station.sourceId)}/W/measurements.json?${query}`;
  }

  ADAPTERS[SRC_PEGEL] = {
    async latest(series, signal) {
      return latestOf(pegelPack(series, await getJsonRetry(pegelUrl(series, "start=PT2H"), signal, [2000, 6000])));
    },
    async range(series, startMs, endMs, opts) {
      const limit = Date.now() - PEGEL_DAYS * DAY;
      const a = Math.max(startMs, limit);
      const note =
        startMs < limit ? "PEGELONLINE har kun målinger for de seneste 30 dage, så perioden før er tom." : "";
      if (a > endMs) return { series: EMPTY_SERIES, failed: [], note };
      try {
        const data = await getJsonRetry(
          pegelUrl(series, `start=${encodeURIComponent(isoZ(a))}&end=${encodeURIComponent(isoZ(endMs))}`),
          opts.signal,
          [3000, 8000]
        );
        return { series: pegelPack(series, data), failed: [], note };
      } catch (err) {
        if (opts.signal && opts.signal.aborted) throw err;
        return { series: EMPTY_SERIES, failed: wholeRangeFailed(a, endMs), note };
      }
    },
  };

  // ---------- Kystatlas: de seneste 30 døgn, som workflowet har hentet (Kystatlas sender ingen CORS-header) ----------

  const kystCache = new Map();

  async function kystPacked(series, signal) {
    const id = series.station.sourceId;
    const hit = kystCache.get(id);
    if (hit && Date.now() - hit.at < CACHE_FOR) return hit.packed;
    const data = await getJsonRetry(`data/obs/kystatlas/${encodeURIComponent(id)}.json`, signal, [1000, 3000]);
    const t = (data.t || []).map((sec) => sec * 1000);
    const packed = packSeries(t, data.v || [], new Array(t.length).fill(0));
    kystCache.set(id, { at: Date.now(), packed });
    return packed;
  }

  const KYST_NOTE = "Kystatlas sender ikke den header, der lader browseren hente data direkte. Siden viser derfor kun de seneste 30 døgn, som hentes hver halve time.";

  ADAPTERS[SRC_KYST] = {
    async latest(series, signal) {
      return latestOf(await kystPacked(series, signal));
    },
    async range(series, startMs, endMs, opts) {
      try {
        return { series: buildRaw(await kystPacked(series, opts.signal), startMs, endMs), failed: [], note: KYST_NOTE };
      } catch (err) {
        if (opts.signal && opts.signal.aborted) throw err;
        return { series: EMPTY_SERIES, failed: wholeRangeFailed(startMs, endMs), note: KYST_NOTE };
      }
    },
  };

  // ---------- Open-Meteo: global model, timeværdier i meter over middelvandstand ----------

  ADAPTERS[SRC_OPENMETEO] = {
    latest: async () => null,
    async range(series, startMs, endMs, opts) {
      const d = (ms) => new Date(ms).toISOString().slice(0, 10);
      const url =
        `${OPENMETEO_URL}?latitude=${series.lat}&longitude=${series.lon}&hourly=sea_level_height_msl` +
        `&timezone=GMT&start_date=${d(startMs)}&end_date=${d(endMs)}`;
      try {
        const data = await getJsonRetry(url, opts.signal, [3000, 8000]);
        const time = (data.hourly && data.hourly.time) || [];
        const values = (data.hourly && data.hourly.sea_level_height_msl) || [];
        const t = [];
        const v = [];
        const q = [];
        for (let i = 0; i < time.length; i++) {
          if (typeof values[i] !== "number") continue;
          const ms = Date.parse(time[i] + ":00Z");
          if (Number.isNaN(ms) || ms < startMs || ms > endMs) continue;
          t.push(ms);
          v.push(round1(values[i] * 100));
          q.push(0);
        }
        if (typeof data.latitude === "number") series.grid = { lat: data.latitude, lon: data.longitude };
        const km = series.grid ? haversineKm(series.lat, series.lon, series.grid.lat, series.grid.lon) : null;
        const note =
          (t.length ? "" : "Open-Meteo har ingen værdier i punktet for perioden. ") +
          (km !== null ? `Open-Meteo bruger gitterpunktet ${fmtKm(km)} herfra.` : "");
        return { series: packSeries(t, v, q), failed: [], note };
      } catch (err) {
        if (opts.signal && opts.signal.aborted) throw err;
        return { series: EMPTY_SERIES, failed: wholeRangeFailed(startMs, endMs), note: "" };
      }
    },
  };

  // ---------- DMI's prognose i en havn ----------

  ADAPTERS[SRC_DKSS] = {
    async latest(series, signal) {
      if (!series.forecast) return null;
      const best = forecastNow(await fetchForecast(series, signal), Date.now());
      return best ? { latest: { t: best.t, v: best.v, q: "" }, ref: null } : null;
    },
    async range() {
      return { series: EMPTY_SERIES, failed: [], note: "" };
    },
  };

  function adapterOf(series) {
    return ADAPTERS[series.source] || ADAPTERS[SRC_DMI];
  }

  // Seneste måling (eller beregning) i en serie. Gemmes i 2 minutter, så "Vis 5 mere" ikke henter de første igen.
  const latestCache = new Map();

  async function fetchLatest(series, signal) {
    const hit = latestCache.get(series.key);
    if (hit && Date.now() - hit.at < 2 * MIN) return hit.latest;
    const r = await adapterOf(series).latest(series, signal);
    const latest = r ? r.latest : null;
    latestCache.set(series.key, { at: Date.now(), latest });
    return latest;
  }

  // Kildens navn i fejlbeskeder, fx "SMHI svarer ikke lige nu"
  function sourceName(series) {
    if (series.source === SRC_TIDE || series.source === SRC_DKSS) return "DMI";
    return series.source;
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

  // Rå målinger i perioden: alle målte tidspunkter og ingen beregnede værdier. Type er altid "målt".
  function buildRaw(obs, startMs, endMs) {
    let a = 0;
    while (a < obs.n && obs.t[a] < startMs) a++;
    let b = a;
    while (b < obs.n && obs.t[b] <= endMs) b++;
    const n = b - a;
    return {
      t: obs.t.subarray(a, b),
      v: obs.v.subarray(a, b),
      type: new Uint8Array(n).fill(TYPE_MEASURED),
      q: obs.q.subarray(a, b),
      n,
      gaps: 0,
    };
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
  // Prognosen i et punkt gemmes i 10 minutter, så søgning, "Beregnet nu" og graf deler ét kald.
  const forecastCache = new Map();

  async function fetchForecast(station, signal) {
    const f = station.forecast;
    const coords = encodeURIComponent(`POINT(${f.lon} ${f.lat})`);
    const url =
      `${EDR_URL}/${encodeURIComponent(f.model)}/position?coords=${coords}` +
      "&crs=crs84&parameter-name=sea-mean-deviation&f=GeoJSON";
    const hit = forecastCache.get(url);
    if (hit && Date.now() - hit.at < CACHE_FOR) return hit.points;
    const data = await getJsonRetry(url, signal, [3000, 8000, 15000]);
    const points = parseForecast(data);
    if (points.length) forecastCache.set(url, { at: Date.now(), points });
    return points;
  }

  // Prognosens værdi nu: trinnet tættest på nu, dog ikke mere end 30 minutter frem
  function forecastNow(points, now) {
    let best = null;
    for (const p of points) {
      if (p.t > now + 30 * MIN) continue;
      if (!best || Math.abs(p.t - now) < Math.abs(best.t - now)) best = p;
    }
    return best;
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

  // Overskrift: Tid UTC; Tid dansk; for hver serie værdi, type og qcStatus; prognose
  // names: valgfrie navne pr. serie (fx stedets navn for en nabomåling). forecastTitle: prognosekolonnens navn.
  function csvHeader(list, forecastTitle, names) {
    const cols = ["Tid UTC", "Tid dansk"];
    (Array.isArray(list) ? list : [list]).forEach((s, k) => {
      const name = (names && names[k]) || seriesName(s);
      cols.push(`${name} (${s.datum})`, `${name} type`, `${name} qcStatus`);
    });
    cols.push(forecastTitle || "Prognose cm (middelvandstand)");
    return cols.join(";");
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
  // Én række pr. tidspunkt. For hver serie tre kolonner: værdi, type og qcStatus.
  // Prognosen står i sin egen kolonne på hele timer. Efter seneste måling kommer kun rækker med type "prognose".
  function csvBlocks(list, forecast, qcNames) {
    const sets = Array.isArray(list) ? list : [list];
    const K = sets.length;
    const idx = new Array(K).fill(0);
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
    // Rækker kun med prognose: "prognose" står i den første series type-kolonne
    const emptyRest = ";;;".repeat(Math.max(0, K - 1));
    // Uden serier (en havn uden valgt nabomåling) har filen kun prognosekolonnen.
    const forecastOnly = (p) => add(p.t, (K ? ";prognose;" + emptyRest + ";" : "") + csvNum(p.v));

    const points = forecast || [];
    let j = 0;
    for (;;) {
      let t = Infinity;
      for (let k = 0; k < K; k++) {
        const d = sets[k];
        if (idx[k] < d.n && d.t[idx[k]] < t) t = d.t[idx[k]];
      }
      if (j < points.length && points[j].t < t) {
        forecastOnly(points[j++]);
        continue;
      }
      if (t === Infinity) break;

      let rest = "";
      for (let k = 0; k < K; k++) {
        const d = sets[k];
        const i = idx[k];
        if (k) rest += ";";
        if (i < d.n && d.t[i] === t) {
          rest += csvNum(d.v[i]) + ";" + TYPE_NAMES[d.type[i]] + ";" + (qcNames[d.q[i]] || "");
          idx[k]++;
        } else {
          rest += ";;";
        }
      }
      let forecastText = "";
      if (j < points.length && points[j].t === t) forecastText = csvNum(points[j++].v);
      add(t, K ? rest + ";" + forecastText : forecastText);
    }
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
  function csvPieces(part, header) {
    return [BOM + header + CRLF].concat(part.blocks.map((b) => b.text));
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

  // vandstand_{sted}_{antal}-serier_{15min|raa}_{fra}_{til}.csv, med _del1, _del2 ... når filen er delt
  function csvFileName(place, fra, til, count, raw, partNo, partCount) {
    const series = `${count}-${count === 1 ? "serie" : "serier"}`;
    const base = `vandstand_${slug(place.name)}_${series}_${raw ? "raa" : "15min"}_${isoDate(fra)}_${isoDate(til)}`;
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
    buildRaw,
    seriesStats,
    parseForecast,
    overlapOf,
    exceedOfSeries,
    exceedOfForecast,
    chartPoints,
    timeTicks,
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
    placeKey,
    numeral,
    datumOf,
    unitLabel,
    unitShort,
    fmtValue,
    seriesOf,
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
    lastSearch: null, // { nedlagte, kunMaalt, antal }
    sources: [], // status for kilderne fra stations.json
    neighbours: [], // havn uden måler: de nærmeste målinger
    place: null, // stedet, der vises
    shown: null, // serien i grafen
    selected: new Set(), // serier med i Excel
    cachePlace: null,
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

    state.stations = (stationsFile.stations || []).filter((st) => Number.isFinite(st.lat) && Number.isFinite(st.lon));
    state.postnumre = postnumre;
    state.sources = stationsFile.sources || [];
    state.places = buildPlaces(state.stations, stationsFile.tides || []);
    for (const place of state.places) {
      for (const st of place.stations) {
        state.byId.set(st.id, st);
        state.placeOf.set(st.id, place);
      }
    }
    // Havne uden måler er egne steder
    for (const h of stationsFile.harbours || []) {
      if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) continue;
      const place = makeHarbour(h);
      state.places.push(place);
      state.placeOf.set(h.id, place);
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
      serie: q.get("serie"),
      fra: q.get("fra"),
      til: q.get("til"),
      graense: q.get("graense"),
      nedlagte: q.get("nedlagte") === "1",
      kunMaalt: q.get("kunmaalt") === "1",
      antal: Math.max(5, Math.min(50, parseInt(q.get("antal"), 10) || 5)),
    };
  }

  function route() {
    const h = readHash();
    if (h.station) {
      const place = state.placeOf.get(h.station);
      if (place && place.main) return showPlace(place, h);
      showSearch(null);
      showError($("searchError"), `Station ${h.station} findes ikke i stationslisten. Søg på et postnummer i stedet.`);
      return;
    }
    showSearch(h.postnr, { nedlagte: h.nedlagte, kunMaalt: h.kunMaalt, antal: h.antal });
  }

  // Adressen for en søgning: #postnr=3070&kunmaalt=1&antal=10
  function searchHash(postnr, opts) {
    const q = new URLSearchParams();
    q.set("postnr", postnr);
    if (opts.nedlagte) q.set("nedlagte", "1");
    if (opts.kunMaalt) q.set("kunmaalt", "1");
    if (opts.antal > 5) q.set("antal", String(opts.antal));
    return "#" + q.toString();
  }

  // ---------- Søgning ----------

  function showSearch(postnr, opts) {
    leavePlace();
    $("viewStation").hidden = true;
    $("viewSearch").hidden = false;
    document.title = "DMI Vandstand";
    showError($("searchError"), "");

    if (postnr === null || postnr === "") {
      $("results").hidden = true;
      return;
    }
    $("postnr").value = postnr;
    runSearch(postnr, opts || { nedlagte: false, kunMaalt: false, antal: 5 });
  }

  function placeHref(place) {
    if (place.kind === "havn") return "#station=" + encodeURIComponent(place.id);
    return "#station=" + encodeURIComponent((place.main ? place.main.station : place.stations[0]).id);
  }

  // "Danmark · DMI" eller "Havn uden måler"
  function placeOwnerText(place) {
    if (place.kind === "havn") return "Havn uden måler";
    return `${COUNTRY_NAMES[place.country] || place.country} · ${place.owners.join(", ")}`;
  }

  // "2 måleserier, data fra 1891" eller for en havn "Prognose fra DMI"
  function placeSubText(place) {
    if (place.kind === "havn") return "Prognose fra DMI, ingen måling";
    const count = place.series.filter(isMeasured).length;
    const from = parseIsoDate(place.from);
    const short = place.sources.length === 1 && (place.sources[0] === SRC_PEGEL || place.sources[0] === SRC_KYST);
    const days = short ? ", kun 30 dage tilbage" : from ? `, data fra ${from.y}` : "";
    return `${count} ${count === 1 ? "måleserie" : "måleserier"}${days}`;
  }

  // De nærmeste steder. opts.nedlagte tager nedlagte steder med, opts.kunMaalt skjuler havne uden måler,
  // og opts.antal er antallet af steder (5, 10, 15 ...).
  function runSearch(postnr, opts) {
    if (state.searchJob) state.searchJob.abort();
    $("results").hidden = true;

    const hit = /^\d{4}$/.test(postnr) ? state.postnumre[postnr] : null;
    if (!hit) {
      showError($("searchError"), `Postnummer ${postnr} findes ikke. Skriv fire cifre, for eksempel 2100.`);
      return;
    }

    state.lastPostnr = postnr;
    state.lastSearch = opts;
    const filter = opts.kunMaalt ? (place) => place.kind !== "havn" : null;
    const nearest = nearestPlaces(state.places, hit.lat, hit.lon, opts.antal + 1, opts.nedlagte, filter);
    const hasMore = nearest.length > opts.antal;
    nearest.length = Math.min(nearest.length, opts.antal);
    $("resultsTitle").textContent = `Nærmeste steder ved ${postnr} ${hit.navn || ""}`.trim();

    const list = $("resultRows");
    list.textContent = "";
    const rows = nearest.map(({ place, km }) => {
      const link = el("a", "row");
      link.href = placeHref(place);

      const title = el("span", "row-title");
      title.append(el("span", "row-name", place.name), el("span", "row-sub", placeSubText(place)));

      const meta = el("span", "row-meta");
      const time = el("span", "row-time");
      meta.append(el("span", "row-owner", placeOwnerText(place)), el("span", "row-dist", fmtKm(km)), time);
      const value = el("span", "row-value", place.active ? "Henter …" : "");
      const valueText = el("span", "", value.textContent);
      value.textContent = "";
      value.append(valueText);
      if (!place.active) {
        const to = parseIsoDate(place.to);
        value.textContent = "Nedlagt" + (to ? `, data til ${fmtDateParts(to)}` : "");
        value.classList.add("is-wide");
      }
      link.append(title, meta, value);

      const item = el("li");
      item.append(link);
      list.append(item);
      return { place, series: place.main, value, valueText, time };
    });

    $("closedToggle").textContent = opts.nedlagte ? "Vis kun steder med aktive stationer" : "Vis også nedlagte steder";
    $("measuredToggle").checked = !!opts.kunMaalt;
    $("moreBtn").hidden = !hasMore;
    $("results").hidden = false;

    // Seneste måling i hovedserien hentes live for de aktive steder.
    const job = new AbortController();
    state.searchJob = job;
    pool(
      rows.filter((row) => row.place.active && row.series),
      5,
      async (row) => {
        try {
          const latest = await fetchLatest(row.series, job.signal);
          if (job.signal.aborted) return;
          markFetched();
          const computed = row.series.kind === KIND_FORECAST;
          if (!latest) {
            row.value.textContent = computed ? "Ingen prognose lige nu" : `Ingen måling hos ${sourceName(row.series)}`;
            row.value.classList.add("is-wide");
          } else if (!computed && Date.now() - latest.t > STALE_AFTER) {
            row.value.textContent = `Ingen ny måling siden ${fmtDateTime(latest.t)}`;
            row.value.classList.add("is-wide");
          } else {
            row.valueText.textContent = `${fmtValue(row.series, latest.v)} ${unitShort(row.series)}`;
            // "beregnet" står på sin egen linje under tallet, så den ikke støder ind i tidspunktet
            if (computed) row.value.append(el("span", "row-calc", "beregnet"));
            row.time.textContent = fmtDateTime(latest.t);
          }
        } catch (err) {
          if (job.signal.aborted) return;
          row.value.textContent = `${sourceName(row.series)} svarer ikke lige nu`;
          row.value.classList.add("is-wide");
        }
      }
    ).catch(() => {});
  }

  // ---------- Sted ----------

  const LIVE_EVERY = 5 * MIN;
  const GAP_GRACE = 30 * MIN; // DMI's målinger kommer med forsinkelse, så de nyeste kvarterer tælles ikke som huller
  const smallScreen = window.matchMedia("(max-width: 760px)");

  function leavePlace() {
    if (state.job) state.job.abort();
    if (state.liveJob) state.liveJob.abort();
    clearInterval(state.liveTimer);
    clearTimeout(state.progressTimer);
    state.place = null;
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

  function fmtIso(text) {
    const d = parseIsoDate(text);
    return d ? fmtDateParts(d) : text || "";
  }

  // Seriens sidste dag med data: i dag for aktive serier, ellers stationens slutdato
  function seriesEnd(series) {
    const today = todayDk();
    const to = series.to ? parseIsoDate(series.to) : null;
    return to && compareDates(to, today) < 0 ? to : today;
  }

  function seriesStart(series) {
    return parseIsoDate(series.from);
  }

  // "fra 08.11.1991" eller "01.01.1891 til 11.10.1991"
  function seriesPeriodText(series) {
    return series.to ? `${fmtIso(series.from)} til ${fmtIso(series.to)}` : `fra ${fmtIso(series.from)}`;
  }

  // De seneste 7 døgn. For en nedlagt serie de sidste 7 døgn med data.
  function defaultPeriod(series) {
    const til = seriesEnd(series);
    let fra = addDays(til, -7);
    const from = seriesStart(series);
    if (from && compareDates(fra, from) < 0) fra = from;
    return { fra, til };
  }

  // Tidligste dato blandt stedets serier
  function placeStart(place) {
    return parseIsoDate(place.from);
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

  // #station=30017&serie=30018:sealev_ln&fra=...&til=...&graense=...
  function placeHash(series, input) {
    const place = state.place;
    const q = new URLSearchParams();
    q.set("station", place.kind === "havn" ? place.id : place.main ? place.main.id : series.id);
    if (series && series !== place.main) q.set("serie", series.key);
    if (input) {
      const def = defaultPeriod(series || place.main);
      const isDefault = compareDates(input.fra, def.fra) === 0 && compareDates(input.til, def.til) === 0;
      if (!isDefault) {
        q.set("fra", isoDate(input.fra));
        q.set("til", isoDate(input.til));
      }
      if (input.limit !== null && !Number.isNaN(input.limit)) q.set("graense", String(input.limit));
    }
    return "#" + q.toString();
  }

  function selectedSeries() {
    return state.place ? state.place.series.filter((s) => state.selected.has(s.key)) : [];
  }

  function showPlace(place, h) {
    if (state.searchJob) state.searchJob.abort();
    leavePlace();
    const harbour = place.kind === "havn";
    if (state.cachePlace !== place) {
      // Et nyt sted: hovedserien er valgt til Excel, og gemte bidder fra det forrige sted smides væk.
      clearChunkCache();
      state.cachePlace = place;
      state.selected = new Set(place.main && !harbour ? [place.main.key] : []);
      state.neighbours = harbour ? nearestMeasurements(place) : [];
    }
    state.place = place;
    if (harbour) {
      // Grafen viser havnens prognose. Én nabomåling eller Open-Meteo kan lægges på.
      const options = harbourOptions(place);
      state.shown = options.find((s) => s.key === h.serie) || null;
    } else {
      state.shown = place.series.find((s) => s.key === h.serie) || place.main;
    }
    const main = place.main;
    const shown = state.shown;

    $("viewSearch").hidden = true;
    $("viewStation").hidden = false;
    document.title = `${place.name} – DMI Vandstand`;
    $("backLink").href = state.lastPostnr && state.lastSearch ? searchHash(state.lastPostnr, state.lastSearch) : "#";

    $("stName").textContent = place.name;
    const facts = $("stFacts");
    facts.textContent = "";
    if (harbour) {
      const f = main.forecast;
      facts.append(
        fact("Type", "Havn uden måler"),
        fact("Land", "Danmark"),
        fact("Koordinat", "OpenStreetMap" + (place.harbour.osm ? ` (${place.harbour.osm})` : "")),
        fact("Prognose", f ? `DMI's model DKSS (${f.model}), modelpunkt ${fmtDistance(haversineKm(place.lat, place.lon, f.lat, f.lon))} fra havnen` : "ingen prognosepunkt")
      );
    } else {
      const pegel = place.sources.length === 1 && (place.sources[0] === SRC_PEGEL || place.sources[0] === SRC_KYST);
      facts.append(
        fact("Land", COUNTRY_NAMES[place.country] || place.country),
        fact(place.owners.length === 1 ? "Ejer" : "Ejere", place.owners.join(", ")),
        fact(place.stations.length === 1 ? "Station" : "Stationer", place.stations.map((s) => s.id).join(", ")),
        fact("Hovedserie", `${seriesName(main)}, ${main.datum}`),
        fact(pegel ? "Historik" : "Data fra", pegel ? `kun de seneste 30 dage (${place.sources[0]})` : fmtIso(place.from)),
        fact("Status", place.active ? "aktiv" : `nedlagt, data til ${fmtIso(place.to)}`)
      );
      if (place.tide) facts.append(fact("Tidevand", `${place.tide.name}, ${fmtDistance(place.tide.distanceKm)} fra stationen`));
    }
    const kept = state.sources.filter((src) => !src.ok && place.sources.includes(src.name));
    if (kept.length) {
      facts.append(
        fact("Bemærk", `Stationslisten fra ${kept.map((x) => x.name).join(" og ")} kunne ikke opdateres ved seneste kørsel. Stationerne er fra den forrige liste.`)
      );
    }

    // Periode og grænseværdi fra adressen, ellers de seneste 7 døgn i den viste serie
    let fra = parseIsoDate(h.fra);
    let til = parseIsoDate(h.til);
    if (!fra || !til) ({ fra, til } = defaultPeriod(shown || main));
    const limit = parseLimit(h.graense);
    state.limit = Number.isNaN(limit) ? null : limit;
    $("fra").value = fmtDateParts(fra);
    $("til").value = fmtDateParts(til);
    $("graense").value = limitText(state.limit);

    for (const id of ["chartBlock", "notes", "tableBlock", "dataStatus", "excelParts"]) $(id).hidden = true;
    for (const id of ["periodForm", "shortcuts", "stSource"]) $(id).hidden = false;
    $("seriesBlock").hidden = harbour;
    $("nearBlock").hidden = !harbour;
    $("resField").hidden = harbour;
    $("nowBlock").hidden = !place.active;
    $("nowTitle").textContent = harbour ? "Beregnet nu" : "Seneste måling";
    if (harbour) renderNearTable();
    else renderSeriesTable();
    showError($("periodError"), "");
    $("stSource").textContent = sourceText(place);

    renderLatest();
    window.scrollTo(0, 0);

    if (place.active) {
      refreshLatest();
      state.liveTimer = setInterval(() => {
        if (!document.hidden) refreshLatest();
      }, LIVE_EVERY);
    }
    if (harbour) refreshNeighbours();
    runPeriod({ excel: false });
  }

  // Kildeteksten under stedet
  function sourceText(place) {
    const parts = [];
    if (place.kind === "havn") {
      parts.push("Kilde til prognosen: DMI's stormflodsmodel DKSS (DMI's Frie Data). Værdien er beregnet og ikke målt.");
      parts.push("Nærmeste målinger kommer fra deres egne kilder.");
    } else if (place.sources.includes(SRC_SMHI)) {
      parts.push(`Kilde til målingerne: SMHI's öppna data. Stationen ejes af ${place.owners.join(" og ")}.`);
    } else if (place.sources.includes(SRC_PEGEL)) {
      parts.push("Kilde til målingerne: Wasserstraßen- und Schifffahrtsverwaltung des Bundes (WSV), PEGELONLINE.");
    } else if (place.sources.length === 1 && place.sources[0] === SRC_KYST) {
      parts.push("Kilde til målingerne: Kystdirektoratet, Kystatlas (CC BY 4.0).");
    } else {
      const others = place.owners.filter((o) => o !== "DMI");
      parts.push(
        "Kilde til målingerne: DMI's Frie Data" +
          (others.length
            ? `. Stationerne ejes af ${place.owners.join(", ").replace(/, ([^,]*)$/, " og $1")}`
                .replace("Havn/kommune", "havne eller kommuner")
                .replace("Ikke oplyst", "en ejer, som DMI ikke oplyser")
            : "") +
          "."
      );
    }
    if (place.sources.includes(SRC_KYST) && place.sources.length > 1) parts.push("Kystatlas-måleren: Kystdirektoratet (CC BY 4.0).");
    if (place.tide) parts.push("Tidevand: beregnet af DMI.");
    if (place.kind !== "havn") parts.push("Kilde til prognosen: DMI's stormflodsmodel DKSS.");
    parts.push("Open-Meteo: Open-Meteo.com, CC BY 4.0.");
    return parts.join(" ");
  }

  // ---------- Tabellen "Måleserier" ----------

  function seriesOwnerText(s) {
    if (s.kind === KIND_TIDE) return "DMI (beregnet)";
    if (s.kind === KIND_MODEL) return "Open-Meteo";
    return s.owner;
  }

  function seriesStatusText(s) {
    if (s.kind === KIND_TIDE) return "beregnet";
    if (s.kind === KIND_MODEL) return "model";
    return s.active ? "aktiv" : "nedlagt";
  }

  function renderSeriesTable() {
    const place = state.place;
    const body = $("seriesBody");
    body.textContent = "";
    for (const s of place.series) {
      const row = el("tr");
      if (s === state.shown) row.className = "is-shown";

      const radio = el("input");
      radio.type = "radio";
      radio.name = "graf";
      radio.value = s.key;
      radio.checked = s === state.shown;
      radio.setAttribute("aria-label", `Vis ${seriesName(s)} i grafen`);

      const box = el("input");
      box.type = "checkbox";
      box.value = s.key;
      box.checked = state.selected.has(s.key);
      box.setAttribute("aria-label", `${seriesName(s)} med i Excel`);

      const graphCell = el("td", "pick");
      graphCell.append(radio);
      const excelCell = el("td", "pick");
      excelCell.append(box);

      const param = el("td");
      param.append(document.createTextNode(paramLabel(s)));
      if (s === place.main) param.append(el("span", "tag", "hovedserie"));

      row.append(
        graphCell,
        excelCell,
        el("td", "", s.kind === KIND_MODEL ? "–" : s.id),
        el("td", "", seriesOwnerText(s)),
        param,
        el("td", "", s.datum),
        el("td", "", seriesPeriodText(s)),
        el("td", "", seriesStatusText(s))
      );
      body.append(row);
    }
    renderSelectedCount();
  }

  function renderSelectedCount() {
    const n = state.selected.size;
    const total = state.place ? state.place.series.length : 0;
    $("seriesCount").textContent = `${n} af ${total} ${total === 1 ? "serie" : "serier"} med i Excel`;
  }

  // ---------- Havn uden måler: de nærmeste målinger ----------

  // De 3 nærmeste steder med en aktiv måling, uanset land og kilde. Havne tæller ikke.
  function nearestMeasurements(place) {
    return nearestPlaces(state.places, place.lat, place.lon, 3, false, (p) => p.kind !== "havn" && p.main && p.main.active).map(
      ({ place: p, km }) => ({ place: p, series: p.main, km, latest: null, error: false })
    );
  }

  // Det, der kan lægges på havnens graf: de nærmeste målinger og Open-Meteo
  function harbourOptions(place) {
    return state.neighbours.map((n) => n.series).concat(place.series.filter((s) => s.kind === KIND_MODEL));
  }

  function neighbourOf(series) {
    return state.neighbours.find((n) => n.series === series) || null;
  }

  async function refreshNeighbours() {
    const place = state.place;
    const job = state.liveJob || new AbortController();
    await pool(state.neighbours, 3, async (n) => {
      try {
        n.latest = await fetchLatest(n.series, job.signal);
        n.error = false;
      } catch (err) {
        n.error = true;
      }
      if (state.place === place) renderNearTable();
    }).catch(() => {});
  }

  function renderNearTable() {
    const place = state.place;
    const body = $("nearBody");
    body.textContent = "";
    const addRow = (key, label, cells, checked) => {
      const row = el("tr");
      if (checked) row.className = "is-shown";
      const radio = el("input");
      radio.type = "radio";
      radio.name = "naboer";
      radio.value = key;
      radio.checked = checked;
      radio.setAttribute("aria-label", label);
      const pick = el("td", "pick");
      pick.append(radio);
      row.append(pick, ...cells.map((c) => el("td", c.cls || "", c.text)));
      body.append(row);
    };
    addRow("", "Kun prognosen i grafen", [{ text: "Ingen, kun prognosen" }, { text: "" }, { text: "" }, { text: "" }], !state.shown);
    for (const n of state.neighbours) {
      const s = n.series;
      const latest = n.latest;
      const value = n.error
        ? `${sourceName(s)} svarer ikke lige nu`
        : latest
          ? `${fmtValue(s, latest.v)} ${unitShort(s)}, ${fmtDateTime(latest.t)}`
          : "Henter …";
      addRow(
        s.key,
        `Vis målingen ved ${n.place.name} i grafen`,
        [
          { text: `${n.place.name} (${COUNTRY_NAMES[n.place.country] || n.place.country})` },
          { text: fmtKm(n.km), cls: "num" },
          { text: value },
          { text: s.datum },
        ],
        state.shown === s
      );
    }
    for (const s of place.series.filter((x) => x.kind === KIND_MODEL)) {
      addRow(
        s.key,
        "Vis Open-Meteo i grafen",
        [{ text: "Open-Meteo (global model, grov)" }, { text: "" }, { text: "beregnet, ikke målt" }, { text: s.datum }],
        state.shown === s
      );
    }
  }

  // Vælg den serie, grafen viser. Ligger perioden uden for seriens data, vises seriens sidste 7 døgn.
  function showSeries(series) {
    if (series === state.shown) return;
    state.shown = series;
    if (series) {
      const input = readPeriodFields();
      const start = seriesStart(series);
      const end = seriesEnd(series);
      const outside =
        input.error ||
        (start && compareDates(input.til, start) < 0) ||
        compareDates(input.fra, end) > 0;
      if (outside) {
        const def = defaultPeriod(series);
        $("fra").value = fmtDateParts(def.fra);
        $("til").value = fmtDateParts(def.til);
      }
    }
    const harbour = state.place.kind === "havn";
    if (harbour) renderNearTable();
    else renderSeriesTable();
    // Tabellen er tegnet forfra. Fokus bliver på den valgte radioknap.
    const body = $(harbour ? "nearBody" : "seriesBody");
    const radio = Array.from(body.querySelectorAll('input[type="radio"]')).find((r) => r.value === (series ? series.key : ""));
    if (radio) radio.focus();
    runPeriod({ excel: false });
  }

  // ---------- Seneste måling og vandstandsbræt ----------

  async function refreshLatest() {
    const place = state.place;
    const main = place && place.main;
    if (!main || !main.active) return;
    if (state.liveJob) state.liveJob.abort();
    const job = (state.liveJob = new AbortController());

    try {
      const r = await adapterOf(main).latest(main, job.signal);
      if (job.signal.aborted || state.place !== place) return;
      state.latest = r ? r.latest : null;
      state.latestRef = r ? r.ref : null;
      state.latestAt = Date.now();
      state.latestError = !state.latest;
      markFetched();
    } catch (err) {
      if (job.signal.aborted || state.place !== place) return;
      state.latestError = true;
    }
    renderLatest();
  }

  function renderLatest() {
    const main = state.place && state.place.main;
    if (!main) return;
    const computed = main.kind === KIND_FORECAST;
    const latest = state.latest;
    const trend = $("nowTrend");
    const time = $("nowTime");
    time.classList.remove("is-stale");
    trend.textContent = "";
    $("nowSeries").textContent = computed
      ? "Beregnet af DMI's model DKSS i havnen. Ikke målt."
      : `${seriesName(main)}, ${main.datum}`;

    if (!latest) {
      $("nowValue").textContent = state.latestError ? "–" : "…";
      $("nowUnit").textContent = "";
      time.textContent = state.latestError
        ? computed && !main.forecast
          ? "Havnen har intet prognosepunkt."
          : `${sourceName(main)} svarer ikke lige nu. Prøv igen om lidt.`
        : computed
          ? "Henter beregningen fra DMI …"
          : `Henter seneste måling fra ${sourceName(main)} …`;
      renderGauge();
      return;
    }

    $("nowValue").textContent = fmtValue(main, latest.v);
    $("nowUnit").textContent = computed
      ? "cm, middelvandstand"
      : isDvr90(main) || isTemperature(main) || main.datum === "RH2000"
        ? unitLabel(main)
        : "cm";

    if (computed) {
      time.textContent = `Beregnet for ${fmtDateTime(latest.t)}`;
    } else if (Date.now() - latest.t > STALE_AFTER) {
      time.textContent = `Ingen ny måling siden ${fmtDateTime(latest.t)}`;
      time.classList.add("is-stale");
    } else {
      time.textContent = `Målt ${fmtDateTime(latest.t)}`;
      const ref = state.latestRef;
      if (ref && ref.t < latest.t) {
        const diff = round1(latest.v - ref.v);
        const minutes = Math.round((latest.t - ref.t) / MIN);
        const still = isTemperature(main) ? 0.2 : 2;
        const word = Math.abs(diff) < still ? "Stabil" : diff > 0 ? "Stigende" : "Faldende";
        trend.textContent = `${word}, ${fmtLevel(diff)} ${unitShort(main)} på ${minutes} minutter`;
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
    const main = state.place && state.place.main;
    // Brættet er til vandstand. For en temperaturserie vises kun tallet.
    box.hidden = !main || isTemperature(main);
    if (box.hidden) return;
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
      `<text x="${labelX}" y="${y0 + font * 0.35}" font-size="${font}" font-weight="600" fill="${INK}">${zeroLabel(main)}</text>`
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
      (value === null ? "Vandstandsbræt uden måling." : `Vandstandsbræt. Seneste måling ${fmtLevel(value)} ${unitLabel(main)}.`) +
      limitLabel;
    box.innerHTML =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 2 * pad}" viewBox="0 0 ${W} ${H + 2 * pad}" ` +
      `role="img" aria-label="${label}" shape-rendering="crispEdges">${parts.join("")}</svg>`;
  }

  // ---------- Periode ----------

  function readPeriodFields() {
    const place = state.place;
    const today = todayDk();
    const from = placeStart(place);
    const fra = parseDkDate($("fra").value);
    const til = parseDkDate($("til").value);

    if (!fra || !til) return { error: `Skriv datoerne som dd.mm.åååå, for eksempel ${fmtDateParts(today)}.` };
    if (compareDates(til, today) > 0) return { error: `Til kan højst være i dag, ${fmtDateParts(today)}.` };
    if (compareDates(fra, til) > 0) return { error: "Fra skal være samme dag som Til eller tidligere." };
    if (from && compareDates(fra, from) < 0) {
      return { error: `Stedet har data fra ${fmtDateParts(from)}. Vælg en Fra-dato, der ikke ligger før.` };
    }
    const limit = parseLimit($("graense").value);
    if (Number.isNaN(limit)) return { error: "Grænseværdien skal være et tal, for eksempel 120." };
    return { fra, til, limit };
  }

  // 7 døgn, 30 døgn og 1 år går tilbage fra den viste series sidste dag.
  // "Alt" går fra den tidligste dato blandt de serier, der er valgt til Excel.
  function setShortcut(range) {
    const shown = state.shown || state.place.main;
    let til = seriesEnd(shown);
    let fra;
    if (range === "7d") fra = addDays(til, -7);
    else if (range === "30d") fra = addDays(til, -30);
    else if (range === "1y") fra = validDate(til.y - 1, til.m, til.d) || addDays({ y: til.y - 1, m: til.m, d: 1 }, til.d - 2);
    else {
      const chosen = selectedSeries().length ? selectedSeries() : [shown];
      fra = null;
      for (const s of chosen) {
        const start = seriesStart(s);
        if (start && (!fra || compareDates(start, fra) < 0)) fra = start;
        const end = seriesEnd(s);
        if (compareDates(end, til) > 0) til = end;
      }
      fra = fra || addDays(til, -7);
    }
    const from = placeStart(state.place);
    if (from && compareDates(fra, from) < 0) fra = from;

    $("fra").value = fmtDateParts(fra);
    $("til").value = fmtDateParts(til);
    runPeriod({ excel: false });
  }

  function showProgress(p) {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    $("progressText").textContent =
      `Henter ${p.label ? p.label + ", " : ""}${p.year}, ${pct} %` +
      (p.waiting ? `. ${p.source || "DMI"} svarer ikke lige nu, prøver igen om lidt.` : "");
    $("progressFill").style.width = pct + "%";
  }

  function setStatus(text) {
    const node = $("dataStatus");
    node.textContent = text || "";
    node.hidden = !text;
  }

  // Den del af perioden, hvor serien har data. null, hvis de ikke overlapper.
  function seriesWindow(series, period) {
    let start = period.start;
    let end = period.apiEnd;
    const from = seriesStart(series);
    if (from) start = Math.max(start, dkToUtc(from.y, from.m, from.d, 0, 0));
    if (series.to) {
      const to = parseIsoDate(series.to);
      if (to) end = Math.min(end, dkToUtc(to.y, to.m, to.d + 1, 0, 0) - 1000);
    }
    return start <= end ? { start, end } : null;
  }

  // 15-minutters datasættet for én serie. Det bygges kun i den del af perioden, hvor serien findes,
  // så kvarterer før seriens start ikke tælles som huller og ikke fylder i hukommelsen.
  function seriesDataset(series, obs, period, gapEndMs, raw) {
    const win = seriesWindow(series, period);
    if (!win) return build15(EMPTY_SERIES, 0, -1);
    const end = Math.min(period.end, win.end);
    const ds = raw ? buildRaw(obs, win.start, end) : build15(obs, win.start, end, Math.min(end, gapEndMs));
    // Tidevand og modeller er beregnet, ikke målt
    if (!isMeasured(series)) ds.type.fill(TYPE_COMPUTED);
    return ds;
  }

  // Henter én serie i perioden. Giver målingerne og de bidder, der ikke kunne hentes.
  // Kilden bestemmer, hvordan der hentes (se ADAPTERS). raw = alle målte tidspunkter til Excel.
  async function loadSeries(series, period, signal, label, raw) {
    const win = seriesWindow(series, period);
    if (!win) return { series: EMPTY_SERIES, failed: [], note: "" };
    const result = await adapterOf(series).range(series, win.start, win.end, {
      signal,
      raw: !!raw,
      onProgress: (p) => {
        if (state.job && state.job.signal === signal) showProgress(Object.assign({ label, source: sourceName(series) }, p));
      },
    });
    return Object.assign({ note: "" }, result);
  }

  // Henter perioden i Fra og Til for den viste serie og viser den. Et nyt kald afbryder det gamle.
  // For en havn uden måler er prognosen hovedkurven, og den viste serie er en valgfri nabomåling.
  async function runPeriod(opts) {
    const place = state.place;
    const series = state.shown;
    const harbour = place && place.kind === "havn";
    if (!place || (!series && !harbour)) return;

    const input = readPeriodFields();
    if (input.error) {
      showError($("periodError"), input.error);
      return;
    }
    showError($("periodError"), "");
    setStatus("");
    releaseExcelLinks();

    state.limit = input.limit;
    history.replaceState(null, "", placeHash(series, input));
    renderGauge();

    if (state.job) state.job.abort();
    const job = (state.job = new AbortController());
    const now = Date.now();
    const period = periodOf(input.fra, input.til, now);

    $("progressFill").style.width = "0%";
    $("progressText").textContent = `Henter ${series ? seriesName(series) : "prognose"}, ${dkParts(period.start).y}, 0 %`;
    clearTimeout(state.progressTimer);
    state.progressTimer = setTimeout(() => {
      if (state.job === job && !job.signal.aborted) $("progress").hidden = false;
    }, 300);

    // Prognosen hentes samtidig med målingerne. Den vises, når Til er i dag: i en havn altid,
    // ellers kun sammen med en aktiv, målt vandstandsserie.
    const forecastSeries = harbour ? place.main : series;
    const wantForecast =
      period.toToday &&
      !!forecastSeries.forecast &&
      (harbour || (isMeasured(series) && series.active && !isTemperature(series)));
    const forecastJob = wantForecast
      ? fetchForecast(forecastSeries, job.signal).then(
          (points) => ({ points: points.filter((p) => p.t >= period.start) }),
          () => ({ points: null })
        )
      : null;

    try {
      const result = series
        ? await loadSeries(series, period, job.signal, seriesName(series))
        : { series: EMPTY_SERIES, failed: [], note: "" };
      if (job.signal.aborted || state.place !== place || state.shown !== series) return;
      markFetched();

      const ds = series ? seriesDataset(series, result.series, period, now - GAP_GRACE, false) : build15(EMPTY_SERIES, 0, -1);
      const view = {
        place,
        series,
        harbour,
        forecastSeries,
        station: series,
        period,
        ds,
        raw: result.series,
        failed: result.failed,
        note: result.note || "",
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
        if (job.signal.aborted || state.place !== place || state.view !== view) return;
        view.forecast = forecast.points;
        view.forecastState = forecast.points && forecast.points.length ? "ok" : "error";
        // En havn: "Beregnet nu" kan tages fra den prognose, grafen lige har hentet.
        if (harbour && !state.latest && view.forecastState === "ok") {
          const best = forecastNow(view.forecast, Date.now());
          if (best) {
            state.latest = { t: best.t, v: best.v, q: "" };
            state.latestError = false;
            renderLatest();
          }
        }
        renderView();
      }

      if (opts && opts.excel) await downloadExcel(view, job);
    } catch (err) {
      if (state.place !== place) return;
      if (job.signal.aborted) {
        if (job.stoppedByUser) {
          setStatus(
            state.view ? "Hentningen blev stoppet. Siden viser stadig den forrige periode." : "Hentningen blev stoppet."
          );
        }
        return;
      }
      if (opts && opts.excel && state.view) setStatus("Excel-filen kunne ikke laves. Prøv en kortere periode eller færre serier.");
      else showError($("periodError"), `${series ? sourceName(series) : "DMI"} svarer ikke lige nu. Prøv igen om lidt.`);
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

  // Overskrift på værdikolonnen, fx "Vandstand cm DVR90" eller "Vandtemperatur °C"
  function valueTitle(series) {
    if (isTemperature(series)) return "Vandtemperatur °C";
    if (series.kind === KIND_TIDE) return "Tidevand " + unitLabel(series);
    if (series.kind === KIND_MODEL) return "Open-Meteo " + unitLabel(series);
    return "Vandstand " + unitLabel(series);
  }

  // Tekst om en nabomåling på en havns graf, fx "Målt ved Sletten Havn, 4,3 km væk"
  function overlayText(view) {
    const s = view.series;
    if (!s) return "";
    if (s.kind === KIND_MODEL) return "Open-Meteo (global model, grov)";
    const n = neighbourOf(s);
    return n ? `Målt ved ${n.place.name}, ${fmtKm(n.km)} væk` : seriesName(s);
  }

  function renderView() {
    const view = state.view;
    if (!view) return;
    const { series, ds, failed } = view;
    const stats = seriesStats(ds);
    const hasForecast = !!(view.forecast && view.forecast.length);

    $("chartTitle").textContent = view.harbour
      ? `Prognose for ${view.place.name}, cm, middelvandstand` + (series ? ` · ${overlayText(view)}, ${unitLabel(series)}` : "")
      : `${seriesName(series)}, ${unitLabel(series)}`;
    $("noteSource").textContent = view.note || "";
    $("noteMissing").textContent =
      series && failed.length
        ? `${sourceName(series)} svarede ikke for ${failedRanges(failed).join(", ")}. Den periode mangler i graf og tabel. Tryk "Vis" for at prøve igen.`
        : "";

    if (series && stats) {
      const unit = unitShort(series);
      $("tableUnit").textContent = valueTitle(series);
      const what = view.harbour ? overlayText(view) + ": s" : "S";
      view.summary =
        `${what}eneste værdi er ${fmtValue(series, stats.last.v)} ${unit} den ${fmtDateTime(stats.last.t)}, ` +
        `højeste i perioden er ${fmtValue(series, stats.max.v)} ${unit} den ${fmtDateTime(stats.max.t)}, ` +
        `og laveste er ${fmtValue(series, stats.min.v)} ${unit} den ${fmtDateTime(stats.min.t)}.`;
      $("noteSummary").textContent = view.summary;
      $("noteGaps").textContent =
        !isMeasured(series) || ds.gaps === 0
          ? ""
          : ds.gaps === 1
            ? "1 kvarter uden måling i perioden."
            : `${fmtCount(ds.gaps)} kvarterer uden måling i perioden.`;
      renderTable(view);
    } else {
      view.summary = "";
      // Svarede kilden ikke, står det i noteMissing. Så skrives der ikke også "Ingen målinger".
      if (series && !failed.length) {
        const what = isMeasured(series) ? "målinger" : "værdier";
        showError(
          $("periodError"),
          `Ingen ${what} i perioden for ${seriesName(series)}. Serien har data ${seriesPeriodText(series)}.` +
            (series.source === SRC_PEGEL ? " PEGELONLINE har kun de seneste 30 dage." : "")
        );
      }
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

  function renderTable(view) {
    const { ds, series } = view;
    const body = $("tableBody");
    body.textContent = "";
    const firstRow = Math.max(0, ds.n - 50);
    for (let i = ds.n - 1; i >= firstRow; i--) {
      const row = el("tr");
      row.append(
        el("td", "", fmtDateTime(ds.t[i])),
        el("td", "num", fmtValue(series, ds.v[i])),
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

          const text = `Grænse ${limitLabel(info.limit)} ${info.unit || "cm"}`;
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
    const series = view.series;
    const unit = series ? unitLabel(series) : "cm, middelvandstand";
    // Blå betyder målt. Tidevand er prikket i dæmpet farve, Open-Meteo prikket i magenta.
    const style =
      !series || isMeasured(series)
        ? { color: COLOR.sea, dash: [], key: "" }
        : series.kind === KIND_TIDE
          ? { color: COLOR.muted, dash: [2, 3], key: "key-tide" }
          : { color: COLOR.forecast, dash: [2, 3], key: "key-model" };
    if (series) {
      const label = view.harbour
        ? `${overlayText(view)} (${unit})`
        : `${isMeasured(series) ? "Målt" : paramLabel(series)}, ${seriesName(series)} (${unit})`;
      legend.append(legendItem(style.key, label));
    }
    if (forecast.length) {
      legend.append(
        legendItem("key-forecast", view.harbour ? `Prognose for ${view.place.name} (DMI, cm, middelvandstand)` : "Prognose (cm, middelvandstand)")
      );
    }
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
    state.overlay = {
      limit: hasLimit ? limit : null,
      unit: series ? unitShort(series) : "cm",
      now: view.period.toToday ? view.fetchedAt : 0,
    };
    $("chartBlock").hidden = false;
    const canvas = $("chart");
    canvas.setAttribute(
      "aria-label",
      (series
        ? `Graf over ${isTemperature(series) ? "vandtemperatur" : "vandstand"} ved ${view.place.name}, ` +
          `serie ${seriesName(series)} i ${unit}. ${view.summary || "Ingen værdier i perioden."}`
        : `Graf over DMI's prognose for ${view.place.name}.`) +
        (forecast.length ? " Prognosen vises som stiplet linje de næste fem døgn." : "")
    );

    state.chart = new Chart(canvas, {
      type: "line",
      data: {
        datasets: [
          {
            label: "Målt",
            data: measured,
            borderColor: style.color,
            backgroundColor: style.color,
            borderWidth: style.dash.length ? 2 : 1.5,
            borderDash: style.dash,
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
            title: { display: true, text: unit, color: COLOR.muted, font: { size: small ? 13 : 14 } },
            ticks: { maxTicksLimit: small ? 7 : 9, callback: (value) => (series ? fmtValue(series, value) : fmtLevel(value)) },
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
                const kind = !series || isMeasured(series) ? TYPE_NAMES[p.k] : series.kind === KIND_TIDE ? "tidevand, beregnet" : "Open-Meteo, beregnet";
                const lines = [`${fmtValue(series, p.y)} ${unit}, ${kind}`];
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
    const series = view.series;
    const unit = series ? unitShort(series) : "cm";
    if (series && view.ds.n) {
      const e = exceedOfSeries(view.ds, limit);
      if (e.count === 0) {
        note.textContent = `Ingen punkter på den målte kurve ligger over grænsen på ${text} ${unit}.`;
      } else {
        note.textContent =
          `${fmtCount(e.count)} ${e.count === 1 ? "punkt" : "punkter"} på den målte kurve ligger over grænsen på ${text} ${unit} ` +
          `(${fmtCount(e.measured)} målt, ${fmtCount(e.computed)} beregnet). ` +
          `Første ${fmtDateTime(e.first)}, seneste ${fmtDateTime(e.last)}. ` +
          `Højeste værdi ${fmtValue(series, e.max)} ${unit} den ${fmtDateTime(e.maxT)}.`;
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

  // Hvad forskellen mellem måling og prognose bygger på. Skriver aldrig "DVR90" ved en serie, der ikke er det.
  function datumBasis(series) {
    const tail = " Forskellen kan derfor skyldes forskellige nulpunkter. Prognosen er ikke justeret.";
    if (isDvr90(series)) return " Måling er i DVR90, prognose er afvigelse fra middelvandstand. Prognosen er ikke justeret.";
    if (series.datum === "RH2000") return " Målingen er i det svenske højdesystem RH 2000, og prognosen er afvigelse fra middelvandstand." + tail;
    if (series.datum === "NHN (omregnet fra pegelnul)")
      return " Målingen er omregnet til det tyske højdesystem NHN, og prognosen er afvigelse fra middelvandstand." + tail;
    if (series.datum === "pegelnul") return " Målingen er i forhold til målerens pegelnul, og prognosen er afvigelse fra middelvandstand." + tail;
    if (series.datum === "middelvandstand (SMHI)")
      return " Målingen er i forhold til SMHI's middelvandstand, og prognosen er afvigelse fra DMI's middelvandstand. De to er ikke nødvendigvis ens. Prognosen er ikke justeret.";
    if (series.datum === "lokalt nulpunkt")
      return " Målingen er i forhold til et lokalt nulpunkt, og prognosen er afvigelse fra middelvandstand." + tail;
    return " DMI dokumenterer ikke målingens nulpunkt, og prognosen er afvigelse fra middelvandstand." + tail;
  }

  function renderForecastNotes() {
    const view = state.view;
    const note = $("noteForecast");
    const overlapNote = $("noteOverlap");
    note.classList.remove("msg-error");
    note.textContent = "";
    overlapNote.textContent = "";
    if (!view) return;

    const series = view.series;
    const fs = view.forecastSeries;
    const modelText =
      series && series.kind === KIND_TIDE
        ? " Tidevandet er beregnet af DMI ud fra månens og solens påvirkning. Det tager ikke højde for vind og lufttryk, og DMI oplyser ikke nulpunktet."
        : series && series.kind === KIND_MODEL
          ? " Open-Meteo er en global model med et groft gitter. Open-Meteo skriver, at den ikke må bruges til sejlads tæt på kysten."
          : "";
    if (!view.harbour) {
      if (!isMeasured(series)) {
        note.textContent = modelText.trim();
        return;
      }
      if (isTemperature(series)) {
        note.textContent = "Prognosen er for vandstand og vises ikke sammen med vandtemperatur.";
        return;
      }
      if (!series.active) {
        note.textContent = "Prognosen vises kun sammen med en aktiv serie.";
        return;
      }
    }
    if (!fs || !fs.forecast) {
      note.textContent = view.harbour ? "Havnen har intet prognosepunkt i DMI's model." : "Ingen prognose for denne station.";
      return;
    }
    if (view.forecastState === "off") {
      note.textContent = "Prognosen vises, når Til er i dag." + modelText;
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

    const f = fs.forecast;
    const km = haversineKm(fs.lat, fs.lon, f.lat, f.lon);
    const last = view.forecast[view.forecast.length - 1].t;
    note.textContent =
      `Prognosen er fra DMI's stormflodsmodel DKSS (${f.model}) i et modelpunkt ${fmtDistance(km)} fra ${view.harbour ? "havnen" : "stationen"} ` +
      `og går til ${fmtDateTime(last)}. Den er beregnet og ikke målt.` +
      (km > 5 ? " Modelpunktet ligger langt væk, så prognosen kan afvige meget fra vandstanden her." : "") +
      modelText;

    // Forskellen mellem måling og prognose giver kun mening for en målt serie på selve stedet
    if (view.harbour || !isMeasured(series)) return;
    const o = overlapOf(view.ds, view.forecast);
    const basis = datumBasis(series);
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

  // Henter de valgte serier i perioden og laver filen. Den viste serie er allerede hentet og genbruges.
  // Serierne hentes én ad gangen, hver i kvartaler med højst 3 kald ad gangen.
  async function downloadExcel(view, job) {
    const { place, period } = view;
    // En havn: prognosen og den nabomåling, der er lagt på grafen. Ellers serierne med flueben.
    const list = view.harbour ? (view.series ? [view.series] : []) : selectedSeries();
    if (!list.length && !view.harbour) {
      setStatus('Vælg mindst én serie med "Med i Excel" i tabellen Måleserier.');
      return;
    }
    const raw = $("oplosning").value === "raa";
    const now = view.fetchedAt;
    const gapEnd = Math.min(period.end, now - GAP_GRACE);

    $("progressFill").style.width = "0%";
    $("progress").hidden = false;
    const sets = [];
    const missing = [];
    for (let k = 0; k < list.length; k++) {
      const s = list[k];
      const label = `${seriesName(s)} (${k + 1} af ${list.length})`;
      let obs;
      // Den viste serie er hentet. Rå minutværdier fra SMHI skal dog hentes særskilt.
      if (s === view.series && !(raw && s.source === SRC_SMHI)) {
        obs = view.raw;
        if (view.failed.length) missing.push(`${sourceName(s)}, ${seriesName(s)}: ${failedRanges(view.failed).join(", ")}`);
      } else {
        let result;
        try {
          result = await loadSeries(s, period, job.signal, label, raw);
        } catch (err) {
          if (job.signal.aborted) throw err;
          result = { series: EMPTY_SERIES, failed: [{ start: period.start, end: period.end }] };
        }
        if (job.signal.aborted || state.view !== view) return;
        obs = result.series;
        if (result.failed.length) missing.push(`${sourceName(s)}, ${seriesName(s)}: ${failedRanges(result.failed).join(", ")}`);
      }
      sets.push(seriesDataset(s, obs, period, gapEnd, raw));
    }
    $("progress").hidden = true;

    const forecast = view.forecastState === "ok" ? view.forecast : [];
    if (!sets.some((d) => d.n) && !forecast.length) {
      setStatus("De valgte serier har ingen målinger i perioden, så der er ingen Excel-fil.");
      return;
    }

    setStatus("Laver Excel-fil …");
    await new Promise((resolve) => setTimeout(resolve, 30)); // lad teksten nå at blive vist
    if (state.view !== view) return;

    const names = view.harbour
      ? list.map((s) => (s.kind === KIND_MODEL ? `Open-Meteo ved ${place.name}` : `${neighbourOf(s) ? neighbourOf(s).place.name : ""} ${seriesName(s)}`.trim()))
      : null;
    const header = csvHeader(list, view.harbour ? `Prognose ${place.name} cm (middelvandstand)` : null, names);
    const parts = csvParts(csvBlocks(sets, forecast, QC_NAMES), CSV_MAX_ROWS);
    const total = parts.reduce((sum, p) => sum + p.rows, 0);
    const type = "text/csv;charset=utf-8";
    const what = view.harbour
      ? `prognose${list.length ? " og " + overlayText(view) : ""}`
      : `${list.length} ${list.length === 1 ? "serie" : "serier"}, ${raw ? "rå målinger" : "15 minutter"}`;
    const extra =
      (view.forecastState !== "off" && view.forecastState !== "ok" ? " Prognosen er ikke med, fordi den ikke kunne hentes." : "") +
      (missing.length ? ` Kilden svarede ikke for ${missing.join("; ")}. Det mangler i filen.` : "");

    if (parts.length === 1) {
      const name = csvFileName(place, period.fra, period.til, list.length + (view.harbour && forecast.length ? 1 : 0), raw, 1, 1);
      saveFile(new Blob(csvPieces(parts[0], header), { type }), name);
      setStatus(`Excel-filen er hentet: ${name} med ${fmtCount(total)} rækker (${what}).` + extra);
      return;
    }

    // Over 1.000.000 rækker: sig det først, og lad brugeren hente filerne én ad gangen.
    setStatus(
      `Perioden har ${fmtCount(total)} rækker (${what}). Excel kan højst vise 1.048.576 rækker, ` +
        `så filen er delt i ${parts.length} filer på hele år. Hent dem her:` + extra
    );
    const ul = el("ul");
    parts.forEach((part, index) => {
      const name = csvFileName(place, period.fra, period.til, list.length + (view.harbour && forecast.length ? 1 : 0), raw, index + 1, parts.length);
      const url = URL.createObjectURL(new Blob(csvPieces(part, header), { type }));
      state.blobUrls.push(url);
      const firstYear = part.blocks[0].year;
      const lastYear = part.blocks[part.blocks.length - 1].year;
      const years = firstYear === lastYear ? `${firstYear}` : `${firstYear} til ${lastYear}`;
      const link = el("a", "", `Hent del ${index + 1}: ${years}, ${fmtCount(part.rows)} rækker`);
      link.href = url;
      link.download = name;
      const item = el("li");
      item.append(link);
      ul.append(item);
    });
    const box = $("excelParts");
    box.textContent = "";
    box.append(ul);
    box.hidden = false;
  }

  // ---------- Start ----------

  function start() {
    $("searchForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const postnr = $("postnr").value.trim();
      const target = searchHash(postnr, { nedlagte: false, kunMaalt: $("measuredToggle").checked, antal: 5 });
      if (location.hash === target) route();
      else location.hash = target;
    });

    $("periodForm").addEventListener("submit", (event) => {
      event.preventDefault();
      runPeriod({ excel: false });
    });
    $("excelBtn").addEventListener("click", () => runPeriod({ excel: true }));
    // Søgevalg: nedlagte steder, kun steder med målinger og 5 steder mere ad gangen
    const changeSearch = (change) => {
      if (!state.lastPostnr || !state.lastSearch) return;
      location.hash = searchHash(state.lastPostnr, Object.assign({}, state.lastSearch, change));
    };
    $("closedToggle").addEventListener("click", () => changeSearch({ nedlagte: !state.lastSearch.nedlagte }));
    // Boksen virker med det samme efter en søgning, og ellers ved næste søgning
    $("measuredToggle").addEventListener("change", () => changeSearch({ kunMaalt: $("measuredToggle").checked }));
    $("moreBtn").addEventListener("click", () => changeSearch({ antal: state.lastSearch.antal + 5 }));
    $("stopBtn").addEventListener("click", stopJob);
    $("shortcuts").addEventListener("click", (event) => {
      const range = event.target && event.target.getAttribute && event.target.getAttribute("data-range");
      if (range) setShortcut(range);
    });

    // Grænseværdien kan ændres uden at hente data igen
    $("graense").addEventListener("change", () => {
      if (!state.place) return;
      const limit = parseLimit($("graense").value);
      if (Number.isNaN(limit)) {
        showError($("periodError"), "Grænseværdien skal være et tal, for eksempel 120.");
        return;
      }
      showError($("periodError"), "");
      state.limit = limit;
      const input = readPeriodFields();
      if (!input.error) history.replaceState(null, "", placeHash(state.shown, input));
      renderGauge();
      renderView();
    });

    // Tabellen "Måleserier": radioknappen vælger grafen, fluebenet vælger Excel
    $("seriesBody").addEventListener("change", (event) => {
      const input = event.target;
      if (!state.place || !input || !input.value) return;
      const series = state.place.series.find((s) => s.key === input.value);
      if (!series) return;
      if (input.type === "radio" && input.checked) showSeries(series);
      if (input.type === "checkbox") {
        if (input.checked) state.selected.add(series.key);
        else state.selected.delete(series.key);
        renderSelectedCount();
      }
    });
    $("nearBody").addEventListener("change", (event) => {
      const input = event.target;
      if (!state.place || !input || input.type !== "radio" || !input.checked) return;
      showSeries(harbourOptions(state.place).find((s) => s.key === input.value) || null);
    });
    $("selectAll").addEventListener("click", () => {
      if (!state.place) return;
      for (const s of state.place.series) state.selected.add(s.key);
      renderSeriesTable();
    });

    // Seneste måling opdateres hvert 5. minut, mens fanen er synlig
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.place && state.place.active && Date.now() - (state.latestAt || 0) >= LIVE_EVERY) {
        refreshLatest();
      }
    });
    smallScreen.addEventListener("change", () => {
      if (!state.place) return;
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

    loadLists().then(
      () => {
        window.addEventListener("hashchange", route);
        route();
      },
      () => {
        showError($("searchError"), "Stationslisten kunne ikke hentes. Prøv at genindlæse siden.");
      }
    );
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof window !== "undefined" ? window : globalThis);
