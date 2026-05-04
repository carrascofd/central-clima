export default async function handler(req, res) {

  const city = req.query.city;
  const lat = req.query.lat;
  const lon = req.query.lon;

  try {

    // -------------------------
    // 📍 GEO (Open-Meteo)
    // -------------------------
    let baseLat = lat;
    let baseLon = lon;

    if (!lat || !lon) {
      const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${city}&count=1`);
      const geoData = await geoRes.json();

      baseLat = geoData?.results?.[0]?.latitude;
      baseLon = geoData?.results?.[0]?.longitude;
    }

    // -------------------------
    // 🔵 MODELOS
    // -------------------------
    const models = {};

    // Open-Meteo
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current=temperature_2m`);
      const d = await r.json();

      models.openmeteo = {
        temp: d?.current?.temperature_2m ?? null,
        status: "ok"
      };
    } catch {
      models.openmeteo = { temp: null, status: "error" };
    }

    // MET Norway
    try {
      const r = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`, {
        headers: { "User-Agent": "central-clima-app" }
      });

      const d = await r.json();

      const temp = d?.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature;

      models.metno = {
        temp: temp ?? null,
        status: "ok"
      };
    } catch {
      models.metno = { temp: null, status: "error" };
    }

    // OpenWeather
    try {
      const r = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${baseLat}&lon=${baseLon}&units=metric&appid=${process.env.OPENWEATHER_KEY}`);
      const d = await r.json();

      models.openweather = {
        temp: d?.main?.temp ?? null,
        status: "ok"
      };
    } catch {
      models.openweather = { temp: null, status: "error" };
    }

    // -------------------------
    // 🟢 SMN (VALIDADO)
    // -------------------------
    let smn = { temp: null, station: "", status: "error" };

    try {
      const r = await fetch("https://ws.smn.gob.ar/map_items/weather");
      const data = await r.json();

      const now = Date.now() / 1000;

      let best = null;
      let minDist = Infinity;

      for (const st of data) {
        const t = st.weather?.temp;
        const updated = st.updated;

        if (t == null || !updated) continue;

        // ⛔ descartamos datos viejos
        if (now - updated > 7200) continue;

        const dist = Math.sqrt(
          Math.pow(baseLat - st.lat, 2) +
          Math.pow(baseLon - st.lon, 2)
        );

        if (dist < minDist) {
          minDist = dist;
          best = st;
        }
      }

      if (best) {
        smn = {
          temp: best.weather.temp,
          station: best.name,
          status: "ok"
        };
      } else {
        smn = {
          temp: null,
          station: "Sin datos actualizados",
          status: "error"
        };
      }

    } catch {}

    // -------------------------
    // ✈️ METAR
    // -------------------------
    let metar = { temp: null, station: "", status: "error" };

    try {
      const r = await fetch(`https://aviationweather.gov/api/data/metar?format=json&lat=${baseLat}&lon=${baseLon}&radius=50`);
      const d = await r.json();

      if (d?.length) {
        metar = {
          temp: d[0].temp,
          station: d[0].station,
          status: "ok"
        };
      } else {
        metar.station = "Sin aeropuerto cercano";
      }
    } catch {}

    // -------------------------
    // 📊 Meteostat (placeholder)
    // -------------------------
    const meteostat = {
      desc: "Histórico disponible"
    };

    // -------------------------
    // PROMEDIO + CONSENSO
    // -------------------------
    const temps = Object.values(models)
      .map(s => s.temp)
      .filter(t => t != null);

    const average = temps.length
      ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1)
      : null;

    const consensus = average ? Number(average) : null;

    // -------------------------
    // RESPUESTA UTF-8 SEGURA
    // -------------------------
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    res.status(200).send(JSON.stringify({
      consensus,
      confidence: temps.length >= 2 ? "alta" : "media",
      models: {
        average,
        sources: models
      },
      observation: {
        smn,
        metar
      },
      extra: {
        meteostat
      }
    }));

  } catch (error) {
    res.status(500).send(JSON.stringify({ error: "Error" }));
  }
}