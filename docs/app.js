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

  // ====================================================================
  // Siden
  // ====================================================================

  const api = {
    MIN15,
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
    const [stationsFile, postnumre] = await Promise.all([
      fetch(STATIONS_URL, { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error("stations.json");
        return r.json();
      }),
      fetch(POSTNR_URL).then((r) => {
        if (!r.ok) throw new Error("postnumre.json");
        return r.json();
      }),
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

  function leaveStation() {
    state.station = null;
  }

  function fact(term, text) {
    const box = el("div");
    box.append(el("dt", "", term), el("dd", "", text));
    return box;
  }

  function showStation(station, h) {
    if (state.searchJob) state.searchJob.abort();
    state.station = station;

    $("viewSearch").hidden = true;
    $("viewStation").hidden = false;
    document.title = `${station.name} – DMI Vandstand`;
    $("backLink").href = state.lastPostnr ? "#postnr=" + state.lastPostnr : "#";

    $("stName").textContent = station.name;
    const datum = station.parameter === "sealev_dvr" ? "sealev_dvr, DVR90" : `${station.parameter}, DVR90 ifølge DMI`;
    const from = parseIsoDate(station.from);
    const facts = $("stFacts");
    facts.textContent = "";
    facts.append(
      fact("Ejer", station.owner),
      fact("Station-id", station.id),
      fact("Parameter og nulpunkt", datum),
      fact("Data fra", from ? fmtDateParts(from) : station.from)
    );

    window.scrollTo(0, 0);
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
