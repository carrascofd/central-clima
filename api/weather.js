export default async function handler(req, res) {

  const city = req.query.city;
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;

  try {

    // -----------------------------
    // 1. OPENWEATHER (para coords)
    // -----------------------------
    let owUrl;

    if (latQuery && lonQuery) {
      owUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${latQuery}&lon=${lonQuery}&units=metric&appid=${OPENWEATHER_KEY}`;
    } else {
      owUrl = `https://api.openweathermap.org/data/2.5/weather?q=${city},AR&units=metric&appid=${OPENWEATHER_KEY}`;
    }

    const owRes = await fetch(owUrl);
    const owData = await owRes.json();

    const baseLat = latQuery ? parseFloat(latQuery) : owData.coord?.lat;
    const baseLon = lonQuery ? parseFloat(lonQuery) : owData.coord?.lon;

    // -----------------------------
    // 2. MODELOS
    // -----------------------------
    const openmeteoRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`
    );

    const openmeteoData = await openmeteoRes.json();

    const metnoRes = await fetch(
      `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`
    );

    const metnoData = await metnoRes.json();

    const models = {
      openmeteo: {
        temp: openmeteoData?.current_weather?.temperature ?? null
      },
      metno: {
        temp: metnoData?.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature ?? null
      },
      openweather: {
        temp: owData.main?.temp ?? null
      }
    };

    // -----------------------------
    // PROMEDIO MODELOS
    // -----------------------------
    const modelTemps = Object.values(models)
      .map(s => s.temp)
      .filter(t => t != null);

    const modelAvg = modelTemps.length
      ? modelTemps.reduce((a, b) => a + b, 0) / modelTemps.length
      : null;

    // -----------------------------
    // 3. SMN (con validación)
    // -----------------------------
    const smnRes = await fetch(`https://ws.smn.gob.ar/map_items/weather`);
    const smnData = await smnRes.json();

    function distKm(a, b, c, d) {
      return Math.sqrt((a - c) ** 2 + (b - d) ** 2) * 111;
    }

    let best = null;
    let min = Infinity;

    for (const st of smnData) {
      const lat = parseFloat(st.lat);
      const lon = parseFloat(st.lon);
      const temp = st.weather?.temp;

      if (!lat || !lon || temp == null) continue;

      const d = distKm(baseLat, baseLon, lat, lon);

      if (d < min) {
        min = d;
        best = st;
      }
    }

    let smnTemp = null;
    let smnStation = null;

    if (best) {
      const now = Date.now() / 1000;
      const age = now - best.updated;

      // ⚠️ validación: max 2 horas
      if (age <= 7200) {
        smnTemp = best.weather?.temp;
        smnStation = `${best.name} (${Math.round(min)} km)`;
      } else {
        smnStation = "Sin datos actualizados";
      }
    }

    // -----------------------------
    // 4. METAR (aviación real)
    // -----------------------------

    // mapping simple Argentina
    const airports = [
      { code: "SAME", lat: -32.831, lon: -68.792 }, // Mendoza
      { code: "SACO", lat: -31.323, lon: -64.208 }, // Córdoba
      { code: "SAAR", lat: -32.903, lon: -60.785 }, // Rosario
      { code: "SAEZ", lat: -34.822, lon: -58.535 }, // Ezeiza
      { code: "SAZS", lat: -41.151, lon: -71.157 }, // Bariloche
      { code: "SAZB", lat: -38.725, lon: -62.169 }  // Bahía Blanca
    ];

    let closestAirport = airports
      .map(a => ({
        ...a,
        dist: distKm(baseLat, baseLon, a.lat, a.lon)
      }))
      .sort((a, b) => a.dist - b.dist)[0];

    let metarTemp = null;
    let metarDesc = "Sin datos";

    if (closestAirport && closestAirport.dist < 150) {
      try {
        const metarRes = await fetch(
          `https://tgftp.nws.noaa.gov/data/observations/metar/stations/${closestAirport.code}.TXT`
        );

        const text = await metarRes.text();

        // parse temp (ej: 14/08)
        const match = text.match(/ (\d{2})\/\d{2} /);

        if (match) {
          metarTemp = parseInt(match[1]);
          metarDesc = `Aeropuerto ${closestAirport.code}`;
        }

      } catch {
        metarDesc = "Error METAR";
      }
    } else {
      metarDesc = "Sin aeropuerto cercano";
    }

    // -----------------------------
    // CONSENSO FINAL
    // -----------------------------
    let consensus = modelAvg;

    if (smnTemp != null) {
      consensus = (consensus + smnTemp) / 2;
    }

    if (metarTemp != null) {
      consensus = (consensus + metarTemp) / 2;
    }

    if (consensus != null) {
      consensus = Number(consensus.toFixed(1));
    }

    res.json({
      consensus,
      confidence: "media",

      models: {
        average: modelAvg?.toFixed(1),
        sources: models
      },

      observation: {
        smn: {
          temp: smnTemp,
          station: smnStation
        },
        metar: {
          temp: metarTemp,
          station: metarDesc
        }
      },

      extra: {
        meteostat: {
          desc: "Histórico disponible"
        }
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}