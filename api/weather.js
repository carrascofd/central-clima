const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
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
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// =====================================================================
// NUEVO MOTOR DE CONSOLIDACIÓN PONDERADA Y RECHAZO DE OUTLIERS
// =====================================================================
function calculateWeightedConsensus(sources) {
  // 1. Extraer temperaturas válidas
  const validSources = sources.filter(s => s && typeof s.temp === 'number');
  if (validSources.length === 0) return null;

  // 2. Encontrar la Mediana (para ignorar valores atípicos extremos)
  const temps = validSources.map(s => s.temp).sort((a, b) => a - b);
  const mid = Math.floor(temps.length / 2);
  const median = temps.length % 2 !== 0 ? temps[mid] : (temps[mid - 1] + temps[mid]) / 2;

  // 3. Filtrar anomalías (rechazar fuentes que se desvíen más de 3°C de la mediana)
  const MAX_DEVIATION = 3.0;
  const reliableSources = validSources.filter(s => Math.abs(s.temp - median) <= MAX_DEVIATION);

  if (reliableSources.length === 0) return median.toFixed(1); // Failsafe

  // 4. Calcular Promedio Ponderado
  let totalWeight = 0;
  let weightedSum = 0;

  reliableSources.forEach(source => {
    let weight = 1; // Peso base para modelos (OpenWeather, Open-Meteo, MET Norway)

    if (source.type === 'metar') {
      // El METAR pesa más mientras más cerca esté. Máximo peso 4, mínimo 1.5
      const dist = source.distance || 0;
      weight = Math.max(1.5, 4 - (dist / 30)); 
    } else if (source.type === 'meteostat') {
      weight = 2.5; // Observación de estaciones promediadas
    }

    weightedSum += source.temp * weight;
    totalWeight += weight;
  });

  return (weightedSum / totalWeight).toFixed(1);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { lat, lon, city } = req.query;
    if (!lat || !lon) {
      return res.status(400).json({ error: "Faltan parámetros lat y lon" });
    }

    const baseLat = parseFloat(lat);
    const baseLon = parseFloat(lon);
    const cacheKey = getCacheKey(baseLat, baseLon);
    const cached = getCachedResponse(cacheKey);

    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(cached);
    }

    let resolvedCityName = city || "Ubicación actual";

    // 1. OpenWeather
    let openweatherData = {};
    try {
      const owRes = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${baseLat}&lon=${baseLon}&units=metric&lang=es&appid=d9987817b3eb27e4dbb35ce984cc5266`);
      if (owRes.ok) openweatherData = await owRes.json();
    } catch (e) { console.error("Error OpenWeather:", e); }

    // 2. Open-Meteo
    let openmeteoData = {};
    try {
      const omRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`);
      if (omRes.ok) openmeteoData = await omRes.json();
    } catch (e) { console.error("Error Open-Meteo:", e); }

    // 3. MET Norway
    let metnoData = {};
    try {
      const mnRes = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`, {
        headers: { "User-Agent": "CentralDeClima/1.0" }
      });
      if (mnRes.ok) metnoData = await mnRes.json();
    } catch (e) { console.error("Error MET Norway:", e); }

    // 4. METAR via CheckWX
    let metarData = null;
    let metarDistance = 999;
    try {
      const metarRes = await fetch(`https://api.checkwx.com/metar/lat/${baseLat}/lon/${baseLon}/radius/${METAR_MAX_DISTANCE_KM}/decoded`, {
        headers: { "X-API-Key": "4bfcc583fbcf49e4ae0f055a40" }
      });
      if (metarRes.ok) {
        const json = await metarRes.json();
        if (json.data && json.data.length > 0) {
          metarData = json.data[0];
          if (metarData.station && metarData.station.geometry && metarData.station.geometry.coordinates) {
            const [mLon, mLat] = metarData.station.geometry.coordinates;
            metarDistance = distanceKm(baseLat, baseLon, mLat, mLon);
          }
        }
      }
    } catch (e) { console.error("Error METAR:", e); }

    // 5. Meteostat (Alternativa Observacional)
    let meteostatData = null;
    try {
      const stationsRes = await fetch(`https://meteostat.p.rapidapi.com/stations/nearby?lat=${baseLat}&lon=${baseLon}&limit=1`, {
        headers: {
          'X-RapidAPI-Key': 'TU_API_KEY_AQUI', // OPCIONAL SI LO USAS
          'X-RapidAPI-Host': 'meteostat.p.rapidapi.com'
        }
      });
      // Si usas meteostat, aquí extraes la temp. Por ahora lo dejamos nulo si no hay API válida.
    } catch (e) { console.error("Error Meteostat:", e); }


    // Construcción de fuentes normalizadas
    const owTemp = openweatherData?.main?.temp;
    const omTemp = openmeteoData?.current_weather?.temperature;
    const mnTemp = metnoData?.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature;
    const metarTemp = metarData?.temperature?.celsius;

    const sourcesForConsensus = [
      { type: 'model', temp: owTemp },
      { type: 'model', temp: omTemp },
      { type: 'model', temp: mnTemp },
      { type: 'metar', temp: metarTemp, distance: metarDistance },
      // { type: 'meteostat', temp: meteostatTemp } // Descomentar si activas meteostat
    ];

    // Calcula el nuevo consenso ponderado
    const generalConsensus = calculateWeightedConsensus(sourcesForConsensus);
    const modelConsensus = calculateWeightedConsensus(sourcesForConsensus.filter(s => s.type === 'model'));

    const models = {
      consensus: modelConsensus,
      sources: {
        openweather: {
          temp: owTemp,
          humidity: openweatherData?.main?.humidity,
          wind: openweatherData?.wind?.speed,
          desc: openweatherData?.weather?.[0]?.description
        },
        openmeteo: {
          temp: omTemp,
          wind: openmeteoData?.current_weather?.windspeed
        },
        metno: {
          temp: mnTemp,
          humidity: metnoData?.properties?.timeseries?.[0]?.data?.instant?.details?.relative_humidity,
          wind: metnoData?.properties?.timeseries?.[0]?.data?.instant?.details?.wind_speed
        }
      }
    };

    const metarPayload = metarTemp !== undefined ? {
      temp: metarTemp,
      station: metarData.icao,
      note: `A ${metarDistance.toFixed(1)} km`
    } : {};

    const result = {
      consensus: generalConsensus,
      confidence: sourcesForConsensus.filter(s => s.temp !== undefined).length >= 3 ? "alta" : "media",
      location: {
        name: resolvedCityName,
        lat: baseLat,
        lon: baseLon
      },
      models,
      observation: { metar: metarPayload },
      extra: { meteostat: {} } // Vacío por ahora
    };

    setCachedResponse(cacheKey, result);
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(result);

  } catch (error) {
    console.error("Error global:", error);
    return res.status(500).json({ error: "Error procesando el clima" });
  }
}