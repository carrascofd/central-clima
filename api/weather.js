export default async function handler(req, res) {
  const city = req.query.city;
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const CHECKWX_KEY = process.env.CHECKWX_KEY;

  try {

    // =============================
    // GEO BASE
    // =============================
    let baseLat = latQuery ? parseFloat(latQuery) : null;
    let baseLon = lonQuery ? parseFloat(lonQuery) : null;

    // =============================
    // OPENWEATHER (para coords fallback)
    // =============================
    if (!baseLat || !baseLon) {
      const geoRes = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${city},AR&appid=${OPENWEATHER_KEY}`
      );
      const geoData = await geoRes.json();
      baseLat = geoData.coord?.lat;
      baseLon = geoData.coord?.lon;
    }

    // =============================
    // MODELOS
    // =============================

    // OpenWeather
    const owRes = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=${baseLat}&lon=${baseLon}&units=metric&appid=${OPENWEATHER_KEY}`
    );
    const owData = owRes.ok ? await owRes.json() : null;

    // Open-Meteo
    const omRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`
    );
    const omData = omRes.ok ? await omRes.json() : null;

    // MET Norway
    const metRes = await fetch(
      `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`,
      { headers: { "User-Agent": "clima-app" } }
    );
    const metData = metRes.ok ? await metRes.json() : null;

    const models = {
      sources: {
        openweather: {
          temp: owData?.main?.temp ?? null
        },
        openmeteo: {
          temp: omData?.current_weather?.temperature ?? null
        },
        metno: {
          temp: metData?.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature ?? null
        }
      }
    };

    const modelTemps = Object.values(models.sources)
      .map(s => s.temp)
      .filter(t => t != null);

    models.average = modelTemps.length
      ? (modelTemps.reduce((a, b) => a + b, 0) / modelTemps.length).toFixed(1)
      : null;

    // =============================
    // 🟢 SMN (VALIDADO)
    // =============================
    let smnTemp = null;
    let smnStation = "Sin datos";

    try {
      const smnRes = await fetch(`https://ws.smn.gob.ar/map_items/weather`);
      const smnData = await smnRes.json();

      let best = null;
      let minDist = Infinity;

      for (const st of smnData) {
        const lat = parseFloat(st.lat);
        const lon = parseFloat(st.lon);

        if (!lat || !lon) continue;

        const d = Math.sqrt((lat - baseLat)**2 + (lon - baseLon)**2);

        if (d < minDist) {
          minDist = d;
          best = st;
        }
      }

      if (best) {
        const now = Date.now() / 1000;
        const updated = best.updated;

        if (updated && (now - updated) < 10800) {
          smnTemp = best.weather?.temp ?? best.temp ?? null;
          smnStation = best.name;
        } else {
          smnStation = "Sin datos actualizados";
        }
      }

    } catch {}

    // =============================
    // ✈️ BASE DE AEROPUERTOS (expandible)
    // =============================
    const AIRPORTS = [
      { icao: "SAOU", name: "San Luis", lat: -33.273, lon: -66.356, alt: 700 },
      { icao: "SACO", name: "Córdoba", lat: -31.323, lon: -64.208, alt: 474 },
      { icao: "SABE", name: "Aeroparque", lat: -34.559, lon: -58.416, alt: 6 },
      { icao: "SAEZ", name: "Ezeiza", lat: -34.822, lon: -58.535, alt: 20 },
      { icao: "SAAR", name: "Rosario", lat: -32.903, lon: -60.785, alt: 25 },
      { icao: "SAME", name: "Mendoza", lat: -32.831, lon: -68.792, alt: 704 },
      { icao: "SANT", name: "Tucumán", lat: -26.841, lon: -65.104, alt: 450 },
      { icao: "SAZS", name: "Bariloche", lat: -41.151, lon: -71.157, alt: 840 },
      { icao: "SAWE", name: "Río Gallegos", lat: -51.608, lon: -69.312, alt: 20 },
	  { icao: "CYOW", name: "Ottawa Macdonald-Cartier International Airport", lat: -75.6692, lon: 45.3225, alt: 115 }
    ];

    function distanceKm(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;

      const a =
        Math.sin(dLat/2)**2 +
        Math.cos(lat1*Math.PI/180) *
        Math.cos(lat2*Math.PI/180) *
        Math.sin(dLon/2)**2;

      return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
    }

    function selectAirport(lat, lon) {
      let best = null;
      let bestScore = Infinity;

      for (const ap of AIRPORTS) {
        const dist = distanceKm(lat, lon, ap.lat, ap.lon);

        // 🔥 SCORE INTELIGENTE
        let score = dist;

        // penalizar altitudes muy distintas
        score += Math.abs((ap.alt || 0) - 500) * 0.01;

        if (score < bestScore) {
          bestScore = score;
          best = ap;
        }
      }

      return best;
    }

    // =============================
    // ✈️ METAR CHECKWX
    // =============================
    let metar = { temp: null, station: "Sin datos" };

    try {
      const airport = selectAirport(baseLat, baseLon);

      if (airport) {
        const metarRes = await fetch(
          `https://api.checkwx.com/metar/${airport.icao}/decoded`,
          {
            headers: { "X-API-Key": CHECKWX_KEY }
          }
        );

        const metarData = await metarRes.json();
        const obs = metarData.data?.[0];

        if (obs) {
          metar = {
            temp: obs.temperature?.celsius ?? null,
            station: `${airport.name} (${airport.icao})`
          };
        } else {
          metar.station = "Sin datos METAR";
        }
      }

    } catch {}

    // =============================
    // METEOSTAT (fallback)
    // =============================
    let meteostat = { temp: null, desc: "Sin datos" };

    try {
      const msRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`
      );
      const msData = await msRes.json();

      meteostat.temp = msData?.current_weather?.temperature ?? null;
      meteostat.desc = "Dato actual (fallback)";
    } catch {}

    // =============================
    // CONSOLIDADO
    // =============================
    const allTemps = [
      ...modelTemps,
      smnTemp,
      metar.temp,
      meteostat.temp
    ].filter(t => t != null);

    const consensus = allTemps.length
      ? (allTemps.reduce((a, b) => a + b, 0) / allTemps.length).toFixed(1)
      : null;

    const result = {
      consensus,
      confidence: allTemps.length >= 3 ? "alta" : "media",

      models,

      observation: {
        smn: {
          temp: smnTemp,
          station: smnStation
        },
        metar
      },

      extra: {
        meteostat
      }
    };

    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ error: "Error backend", detail: error.message });
  }
}