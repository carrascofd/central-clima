const CACHE_TTL_MS = 10 * 60 * 1000;
const METAR_MAX_DISTANCE_KM = 100;

const cache = new Map();

function getCacheKey(lat, lon) {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

function getCachedResponse(key) {
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedResponse(key, data) {
  cache.set(key, {
    timestamp: Date.now(),
    data
  });
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function metarDistanceKm(obs, lat, lon) {
  const meters = obs?.position?.distance?.meters;
  if (typeof meters === "number") {
    return meters / 1000;
  }

  const coords = obs?.station?.geometry?.coordinates;
  if (coords?.length >= 2) {
    return distanceKm(lat, lon, coords[1], coords[0]);
  }
  return null;
}

async function fetchNearestMetar(lat, lon, apiKey) {
  if (!apiKey) {
    return {
      temp: null,
      station: "Sin datos",
      distanceKm: null,
      usedInConsensus: false,
      note: "CHECKWX_KEY no configurada"
    };
  }

  const metarRes = await fetch(
    `https://api.checkwx.com/v2/metar/lat/${lat}/lon/${lon}/decoded?limit=1`,
    { headers: { "X-API-Key": apiKey } }
  );

  if (!metarRes.ok) {
    return {
      temp: null,
      station: "METAR sin datos",
      distanceKm: null,
      usedInConsensus: false,
      note: null
    };
  }

  const metarData = await metarRes.json();
  const obs = metarData?.data?.[0];

  if (!obs) {
    return {
      temp: null,
      station: "METAR sin datos",
      distanceKm: null,
      usedInConsensus: false,
      note: null
    };
  }

  const distance = metarDistanceKm(obs, lat, lon);
  const stationName = obs.station?.name ?? obs.station?.icao ?? obs.icao ?? "Estación desconocida";
  const icao = obs.station?.icao ?? obs.icao ?? "";
  const stationLabel = icao ? `${stationName} (${icao})` : stationName;

  const withinRange = distance == null || distance <= METAR_MAX_DISTANCE_KM;

  return {
    temp: withinRange ? obs.temperature?.celsius ?? null : null,
    station: stationLabel,
    distanceKm: distance != null ? Number(distance.toFixed(1)) : null,
    usedInConsensus: withinRange,
    note: withinRange ? null : `Estación a ${Math.round(distance)} km (Excluida por distancia)`
  };
}

async function fetchMeteostatObservation(lat, lon, apiKey) {
  const empty = {
    temp: null,
    station: null,
    distanceKm: null,
    observedAt: null,
    desc: "Sin datos",
    usedInConsensus: false
  };

  if (!apiKey) {
    return { ...empty, desc: "Meteostat no configurado (METEOSTAT_KEY)" };
  }

  const headers = {
    "x-rapidapi-host": "meteostat.p.rapidapi.com",
    "x-rapidapi-key": apiKey
  };

  const nearbyRes = await fetch(
    `https://meteostat.p.rapidapi.com/stations/nearby?lat=${lat}&lon=${lon}&limit=1`,
    { headers }
  );

  if (!nearbyRes.ok) return { ...empty, desc: "Meteostat sin estación cercana" };

  const nearbyData = await nearbyRes.json();
  const station = nearbyData?.data?.[0];

  if (!station) return { ...empty, desc: "Meteostat sin estación cercana" };

  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 1);

  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  const hourlyRes = await fetch(
    `https://meteostat.p.rapidapi.com/stations/hourly?station=${station.id}&start=${startStr}&end=${endStr}&model=false&units=metric`,
    { headers }
  );

  if (!hourlyRes.ok) {
    return {
      ...empty,
      station: station.name?.en ?? station.id,
      distanceKm: station.distance != null ? Number((station.distance / 1000).toFixed(1)) : null,
      desc: "Meteostat sin observaciones recientes"
    };
  }

  const hourlyData = await hourlyRes.json();
  const rows = hourlyData?.data ?? [];
  const latest = [...rows].reverse().find(row => row?.temp != null);

  if (!latest) {
    return {
      ...empty,
      station: station.name?.en ?? station.id,
      distanceKm: station.distance != null ? Number((station.distance / 1000).toFixed(1)) : null,
      desc: "Meteostat sin observaciones recientes"
    };
  }

  const stationDistanceKm = station.distance != null ? station.distance / 1000 : null;
  const withinRange = stationDistanceKm == null || stationDistanceKm <= METAR_MAX_DISTANCE_KM;

  return {
    temp: withinRange ? latest.temp : null,
    station: station.name?.en ?? station.id,
    distanceKm: stationDistanceKm != null ? Number(stationDistanceKm.toFixed(1)) : null,
    observedAt: latest.time ?? null,
    desc: withinRange ? "Observación activa de estación" : `Estación a ${Math.round(stationDistanceKm)} km (Excluida)`,
    usedInConsensus: withinRange
  };
}

export default async function handler(req, res) {
  const city = req.query.city;
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const CHECKWX_KEY = process.env.CHECKWX_KEY;
  const METEOSTAT_KEY = process.env.METEOSTAT_KEY;

  try {
    // =====================================================
    // GEO BASE
    // =====================================================
    let baseLat = latQuery ? parseFloat(latQuery) : null;
    let baseLon = lonQuery ? parseFloat(lonQuery) : null;

    if (!baseLat || !baseLon) {
      const geoRes = await fetch(
        `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${OPENWEATHER_KEY}`
      );
      const geoData = await geoRes.json();

      if (!geoData?.length) {
        return res.status(404).json({ error: "Ciudad no encontrada" });
      }
      baseLat = geoData[0].lat;
      baseLon = geoData[0].lon;
    }

    const cacheKey = getCacheKey(baseLat, baseLon);
    const cached = getCachedResponse(cacheKey);

    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(cached);
    }

    // =====================================================
    // FUENTES (Paralelo)
    // =====================================================
    const [owRes, omRes, metRes, metar, meteostat] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${baseLat}&lon=${baseLon}&units=metric&appid=${OPENWEATHER_KEY}`),
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`),
      fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`, {
        headers: { "User-Agent": "central-clima" }
      }),
      fetchNearestMetar(baseLat, baseLon, CHECKWX_KEY).catch(() => ({
        temp: null, station: "Error METAR", distanceKm: null, usedInConsensus: false, note: null
      })),
      fetchMeteostatObservation(baseLat, baseLon, METEOSTAT_KEY).catch(() => ({
        temp: null, station: null, distanceKm: null, observedAt: null, desc: "Error Meteostat", usedInConsensus: false
      }))
    ]);

    const owData = owRes.ok ? await owRes.json() : null;
    const omData = omRes.ok ? await omRes.json() : null;
    const metData = metRes.ok ? await metRes.json() : null;

    // Resuelve el nombre real de la ciudad si la petición vino de coordenadas nativas
    const resolvedCityName = city || owData?.name || "Ubicación actual";

    // =====================================================
    // MODELOS DATA MAPPING
    // =====================================================
    const models = {
      sources: {
        openweather: {
          temp: owData?.main?.temp ?? null,
          humidity: owData?.main?.humidity ?? null,
          wind: owData?.wind?.speed ?? null,
          desc: owData?.weather?.[0]?.description ?? ""
        },
        openmeteo: {
          temp: omData?.current_weather?.temperature ?? null,
          wind: omData?.current_weather?.windspeed ?? null,
          desc: "Open-Meteo"
        },
        metno: {
          temp: metData?.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature ?? null,
          humidity: metData?.properties?.timeseries?.[0]?.data?.instant?.details?.relative_humidity ?? null,
          wind: metData?.properties?.timeseries?.[0]?.data?.instant?.details?.wind_speed ?? null,
          desc: "MET Norway"
        }
      }
    };

    const modelTemps = Object.values(models.sources).map(s => s.temp).filter(t => t != null);
    models.average = modelTemps.length
      ? (modelTemps.reduce((a, b) => a + b, 0) / modelTemps.length).toFixed(1)
      : null;

    // =====================================================
    // CONSENSO
    // =====================================================
    const observationTemps = [];
    if (metar.usedInConsensus && metar.temp != null) observationTemps.push(metar.temp);
    if (meteostat.usedInConsensus && meteostat.temp != null) observationTemps.push(meteostat.temp);

    const allTemps = [...modelTemps, ...observationTemps];
    const consensus = allTemps.length
      ? (allTemps.reduce((a, b) => a + b, 0) / allTemps.length).toFixed(1)
      : null;

    // =====================================================
    // 🤖 IA - CONSEJO DEL DÍA (Google Gemini)
    // =====================================================
    let ai_recommendation = "Consejo no disponible en este momento.";
    
    if (process.env.GEMINI_API_KEY) {
      try {
        const promptText = `Eres un asistente meteorológico local. El clima en ${resolvedCityName} es de ${consensus}°C. Escribe un consejo muy breve (máximo 2 oraciones) y amigable sobre qué ropa usar y una actividad recomendada para hacer hoy.`;
        
        const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
        });
        
        const aiData = await aiRes.json();
        if (aiData.candidates && aiData.candidates.length > 0) {
          ai_recommendation = aiData.candidates[0].content.parts[0].text;
        }
      } catch (error) {
        console.error("Error consultando Gemini IA:", error);
      }
    }

    // =====================================================
    // RESPONSE OBJECT
    // =====================================================
    const result = {
      consensus,
      confidence: allTemps.length >= 4 ? "alta" : "media",
      location: {
        name: resolvedCityName,
        lat: baseLat,
        lon: baseLon
      },
      models,
      observation: { metar },
      extra: { meteostat },
      ai_recommendation
    };

    setCachedResponse(cacheKey, result);
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(result);
    
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Error backend",
      detail: error.message
    });
  }
}