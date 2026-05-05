export default async function handler(req, res) {

  const city = (req.query.city || "").toLowerCase();
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const CHECKWX_KEY = process.env.CHECKWX_KEY;

  try {

    // -----------------------------
    // GEO
    // -----------------------------
    let baseLat = latQuery ? parseFloat(latQuery) : null;
    let baseLon = lonQuery ? parseFloat(lonQuery) : null;

    if (!baseLat || !baseLon) {
      const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${city}&count=1`
      );
      const geoData = await geoRes.json();

      baseLat = geoData?.results?.[0]?.latitude;
      baseLon = geoData?.results?.[0]?.longitude;
    }

    if (!baseLat || !baseLon) {
      throw new Error("No se pudo obtener ubicación");
    }

    // -----------------------------
    // 🔵 MODELOS
    // -----------------------------
    const models = {};

    // OpenWeather
    try {
      const r = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?lat=${baseLat}&lon=${baseLon}&units=metric&appid=${OPENWEATHER_KEY}`
      );
      const d = await r.json();

      models.openweather = {
        temp: d.main?.temp ?? null,
        status: r.ok ? "ok" : "error"
      };
    } catch {
      models.openweather = { temp: null, status: "error" };
    }

    // Open-Meteo
    try {
      const r = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`
      );
      const d = await r.json();

      models.openmeteo = {
        temp: d.current_weather?.temperature ?? null,
        status: r.ok ? "ok" : "error"
      };
    } catch {
      models.openmeteo = { temp: null, status: "error" };
    }

    // MET Norway
    try {
      const r = await fetch(
        `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`,
        { headers: { "User-Agent": "central-clima-app" } }
      );
      const d = await r.json();

      const temp =
        d?.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature;

      models.metno = {
        temp: temp ?? null,
        status: r.ok ? "ok" : "error"
      };
    } catch {
      models.metno = { temp: null, status: "error" };
    }

    const temps = Object.values(models).map(s => s.temp).filter(t => t != null);
    const avg = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;

    // -----------------------------
    // 🟢 SMN VALIDADO
    // -----------------------------
    let smn = { temp: null, station: "Sin datos", status: "nodata" };

    try {
      const r = await fetch("https://ws.smn.gob.ar/map_items/weather");
      const data = await r.json();

      const now = Date.now() / 1000;

      let best = null;
      let minDist = Infinity;

      for (const st of data) {
        const lat = parseFloat(st.lat);
        const lon = parseFloat(st.lon);
        const temp = st.weather?.temp;
        const updated = st.updated;

        if (!lat || !lon || temp == null || !updated) continue;
        if (now - updated > 7200) continue;

        const dist = Math.sqrt(
          Math.pow(baseLat - lat, 2) +
          Math.pow(baseLon - lon, 2)
        );

        if (dist < minDist) {
          minDist = dist;
          best = st;
        }
      }

      if (best) {
        smn = {
          temp: best.weather.temp,
          station: `${best.name} (${best.province})`,
          status: "ok"
        };
      }

    } catch {}

    // -----------------------------
    // ✈️ METAR NOAA
    // -----------------------------
    let metarNoaa = { temp: null, station: "Sin datos", status: "nodata" };

    try {
      const r = await fetch(
        `https://aviationweather.gov/api/data/metar?lat=${baseLat}&lon=${baseLon}&radius=100&format=json`
      );

      const d = await r.json();

      if (Array.isArray(d) && d.length > 0) {
        metarNoaa = {
          temp: d[0].temp ?? null,
          station: d[0].name ?? d[0].icaoId,
          status: "ok"
        };
      }

    } catch {}

    // -----------------------------
    // ✈️ METAR CHECKWX (el tuyo)
    // -----------------------------
    let metarCheckwx = { temp: null, station: "Sin datos", status: "nodata" };

    try {
      async function fetchMetar(radius) {
        const r = await fetch(
          `https://api.checkwx.com/metar/lat/${baseLat}/lon/${baseLon}/radius/${radius}/decoded`,
          { headers: { "X-API-Key": CHECKWX_KEY } }
        );
        if (!r.ok) return null;
        const d = await r.json();
        return d.data?.[0] ?? null;
      }

      const data =
        await fetchMetar(50) ||
        await fetchMetar(150) ||
        await fetchMetar(300);

      if (data) {
        metarCheckwx = {
          temp: data.temperature?.celsius ?? null,
          station: data.station?.name ?? data.icao ?? "",
          status: "ok"
        };
      }

    } catch {}

    // -----------------------------
    // 🟡 METEOSTAT (fallback)
    // -----------------------------
    let meteostat = { temp: null, status: "nodata" };

    try {
      const r = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`
      );
      const d = await r.json();

      meteostat = {
        temp: d.current_weather?.temperature ?? null,
        status: "ok"
      };

    } catch {}

    // -----------------------------
    // CONSENSO
    // -----------------------------
    let consensus = avg;

    if (metarCheckwx.temp != null) consensus = metarCheckwx.temp;
    else if (metarNoaa.temp != null) consensus = metarNoaa.temp;
    else if (smn.temp != null) consensus = smn.temp;

    res.setHeader("Content-Type", "application/json; charset=utf-8");

    res.status(200).send(JSON.stringify({
      consensus: consensus ? Number(consensus.toFixed(1)) : null,
      confidence: metarCheckwx.temp || metarNoaa.temp ? "alta" : "media",

      models: {
        average: avg ? avg.toFixed(1) : null,
        sources: models
      },

      observation: {
        smn,
        metarNoaa,
        metarCheckwx
      },

      extra: {
        meteostat
      }
    }));

  } catch (error) {

    res.status(500).send(JSON.stringify({
      error: "Error general"
    }));
  }
}