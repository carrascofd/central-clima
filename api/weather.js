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
  cache.set(key, { timestamp: Date.now(), data });
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function metarDistanceKm(obs, lat, lon) {
  const meters = obs?.position?.distance?.meters;
  if (typeof meters === "number") return meters / 1000;
  const coords = obs?.station?.geometry?.coordinates;
  if (coords?.length >= 2) return distanceKm(lat, lon, coords[1], coords[0]);
  return null;
}

async function fetchNearestMetar(lat, lon, apiKey) {
  if (!apiKey) return { temp: null, station: "Sin datos", distanceKm: null, note: "CHECKWX_KEY no configurada" };
  const metarRes = await fetch(`https://api.checkwx.com/v2/metar/lat/${lat}/lon/${lon}/decoded?limit=1`, { headers: { "X-API-Key": apiKey } });
  if (!metarRes.ok) return { temp: null, station: "METAR sin datos", distanceKm: null, note: null };
  const metarData = await metarRes.json();
  const obs = metarData?.data?.[0];
  if (!obs) return { temp: null, station: "METAR sin datos", distanceKm: null, note: null };
  
  const distance = metarDistanceKm(obs, lat, lon);
  const stationName = obs.station?.name ?? obs.station?.icao ?? obs.icao ?? "Estación desconocida";
  const icao = obs.station?.icao ?? obs.icao ?? "";
  const stationLabel = icao ? `${stationName} (${icao})` : stationName;

  return {
    temp: obs.temperature?.celsius ?? null,
    station: stationLabel,
    distanceKm: distance != null ? Number(distance.toFixed(1)) : null,
    note: distance != null ? `A ${Math.round(distance)} km` : null
  };
}

async function fetchMeteostatObservation(lat, lon, apiKey) {
  const empty = { temp: null, station: null, distanceKm: null, desc: "Sin datos" };
  if (!apiKey) return { ...empty, desc: "Meteostat no configurado" };
  const headers = { "x-rapidapi-host": "meteostat.p.rapidapi.com", "x-rapidapi-key": apiKey };
  const nearbyRes = await fetch(`https://meteostat.p.rapidapi.com/stations/nearby?lat=${lat}&lon=${lon}&limit=1`, { headers });
  if (!nearbyRes.ok) return { ...empty, desc: "Sin estación cercana" };
  
  const nearbyData = await nearbyRes.json();
  const station = nearbyData?.data?.[0];
  if (!station) return { ...empty, desc: "Sin estación cercana" };

  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  const hourlyRes = await fetch(`https://meteostat.p.rapidapi.com/stations/hourly?station=${station.id}&start=${startStr}&end=${endStr}&model=false&units=metric`, { headers });
  if (!hourlyRes.ok) return { ...empty, station: station.name?.en ?? station.id, desc: "Sin observaciones recientes" };

  const hourlyData = await hourlyRes.json();
  const rows = hourlyData?.data ?? [];
  const latest = [...rows].reverse().find(row => row?.temp != null);
  
  if (!latest) return { ...empty, station: station.name?.en ?? station.id, desc: "Sin observaciones recientes" };

  return {
    temp: latest.temp,
    station: station.name?.en ?? station.id,
    distanceKm: station.distance != null ? Number((station.distance / 1000).toFixed(1)) : null,
    desc: "Observación activa de estación"
  };
}

// =====================================================================
// MOTOR DE CONSOLIDACIÓN OPTIMIZADO (ANCLAJE POR VERDAD TERRESTRE)
// =====================================================================
function calculateAdvancedConsensus(sourcesArray) {
  const valid = sourcesArray.filter(s => s.temp != null);
  if (valid.length === 0) return { value: null, acceptedIds: [] };

  // Intentar identificar estaciones reales válidas para fijar el Anclaje Real
  const metar = valid.find(s => s.type === 'metar');
  const meteostat = valid.find(s => s.type === 'meteostat');
  
  let groundTruthAnchor = null;
  let realObsConsistent = false;

  const tMetar = metar?.temp;
  const tMeteostat = meteostat?.temp;

  // Filtrar que las observaciones estén dentro de la cobertura espacial permitida
  const isMetarNear = metar && (metar.distanceKm == null || metar.distanceKm <= METAR_MAX_DISTANCE_KM);
  const isMeteostatNear = meteostat && (meteostat.distanceKm == null || meteostat.distanceKm <= METAR_MAX_DISTANCE_KM);

  if (tMetar != null && tMeteostat != null && isMetarNear && isMeteostatNear) {
    if (Math.abs(tMetar - tMeteostat) <= 3.0) {
      // Consenso de Verdad Terrestre perfecto entre estaciones
      groundTruthAnchor = (tMetar + tMeteostat) / 2;
      realObsConsistent = true;
    } else {
      // Conflicto de lecturas reales: Se prioriza la estación físicamente más cercana
      groundTruthAnchor = (metar.distanceKm || 0) <= (meteostat.distanceKm || 0) ? tMetar : tMeteostat;
    }
  } else if (tMetar != null && isMetarNear) {
    groundTruthAnchor = tMetar;
  } else if (tMeteostat != null && isMeteostatNear) {
    groundTruthAnchor = tMeteostat;
  }

  const acceptedIds = [];
  let totalWeight = 0;
  let weightedSum = 0;

  // Tolerancias límites de desviación métrica
  const MAX_MODEL_DEVIATION_FROM_REAL = 4.5; // Margen tolerable a un modelo antes de considerarlo desfasado por la realidad
  const MAX_MODEL_DEVIATION_FROM_MEDIAN = 2.0; // Respaldo tradicional si no hay estaciones reales cerca

  // ESCENARIO A: Existe Verdad Terrestre disponible
  if (groundTruthAnchor !== null) {
    valid.forEach(s => {
      let isAcceptable = false;

      if (s.type === 'metar' || s.type === 'meteostat') {
        if (s.distanceKm == null || s.distanceKm <= METAR_MAX_DISTANCE_KM) {
          isAcceptable = true; // Las observaciones válidas quedan inmunizadas frente al sesgo de modelos
        }
      } else if (s.type === 'model') {
        // Los modelos numéricos se auditan y validan usando la superficie real
        isAcceptable = Math.abs(s.temp - groundTruthAnchor) <= MAX_MODEL_DEVIATION_FROM_REAL;
      }

      if (isAcceptable) {
        acceptedIds.push(s.id);
        let weight = 1; // Peso base estándar para simulaciones

        if (s.type === 'metar') {
          // Atenuación lineal por distancia física de la pista (Máx: 4.0, Mín: 1.5)
          const dist = s.distanceKm || 0;
          weight = Math.max(1.5, 4.0 - (dist / 30));
        } else if (s.type === 'meteostat') {
          weight = 2.5;
        }

        weightedSum += s.temp * weight;
        totalWeight += weight;
      }
    });
  } else {
    // ESCENARIO B: Caída por Respaldo (Sin estaciones reales disponibles, se aplica el filtro por mediana)
    const temps = valid.map(s => s.temp).sort((a, b) => a - b);
    const mid = Math.floor(temps.length / 2);
    const median = temps.length % 2 !== 0 ? temps[mid] : (temps[mid - 1] + temps[mid]) / 2;

    valid.forEach(s => {
      if (Math.abs(s.temp - median) <= MAX_MODEL_DEVIATION_FROM_MEDIAN) {
        acceptedIds.push(s.id);
        weightedSum += s.temp * 1;
        totalWeight += 1;
      }
    });
  }

  // Prevención de error por división por cero
  if (totalWeight === 0) {
    const temps = valid.map(s => s.temp).sort((a, b) => a - b);
    const mid = Math.floor(temps.length / 2);
    const median = temps.length % 2 !== 0 ? temps[mid] : (temps[mid - 1] + temps[mid]) / 2;
    return { value: median.toFixed(1), acceptedIds: [] };
  }

  return {
    value: (weightedSum / totalWeight).toFixed(1),
    acceptedIds: acceptedIds
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
    let baseLat = latQuery ? parseFloat(latQuery) : null;
    let baseLon = lonQuery ? parseFloat(lonQuery) : null;

    if (!baseLat || !baseLon) {
      const geoRes = await fetch(`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${OPENWEATHER_KEY}`);
      const geoData = await geoRes.json();
      if (!geoData?.length) return res.status(404).json({ error: "Ciudad no encontrada" });
      baseLat = geoData[0].lat;
      baseLon = geoData[0].lon;
    }

    const cacheKey = getCacheKey(baseLat, baseLon);
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(cached);
    }

    const [owRes, omRes, metRes, aqiRes, metarData, meteostatData] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${baseLat}&lon=${baseLon}&units=metric&appid=${OPENWEATHER_KEY}`),
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current=temperature_2m,wind_speed_10m,weather_code,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,weather_code,uv_index_max,precipitation_probability_max&forecast_days=3&timezone=auto`),
      fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`, { headers: { "User-Agent": "central-clima" } }),
      fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${baseLat}&longitude=${baseLon}&current=european_aqi,uv_index,pm10,pm2_5&timezone=auto`).catch(() => null),
      fetchNearestMetar(baseLat, baseLon, CHECKWX_KEY).catch(() => ({ temp: null, station: "Error METAR", distanceKm: null, note: null })),
      fetchMeteostatObservation(baseLat, baseLon, METEOSTAT_KEY).catch(() => ({ temp: null, station: null, distanceKm: null, desc: "Error Meteostat" }))
    ]);

    const owData = owRes.ok ? await owRes.json() : null;
    const omData = omRes.ok ? await omRes.json() : null;
    const metData = metRes.ok ? await metRes.json() : null;
    const aqiData = aqiRes && aqiRes.ok ? await aqiRes.json() : null;

    const resolvedCityName = city || owData?.name || "Ubicación actual";

    // 1. DATA PREMIUM Y PRONÓSTICO EXTENDIDO
    const dailyForecast = [];
    if (omData?.daily) {
      for (let i = 0; i < omData.daily.time.length; i++) {
        dailyForecast.push({
          date: omData.daily.time[i],
          max: omData.daily.temperature_2m_max?.[i] ?? null,
          min: omData.daily.temperature_2m_min?.[i] ?? null,
          code: omData.daily.weather_code?.[i] ?? null
        });
      }
    }

    const premium = {
       aqi: aqiData?.current?.european_aqi ?? null,
       pm10: aqiData?.current?.pm10 ?? null,
       uv: omData?.daily?.uv_index_max?.[0] ?? aqiData?.current?.uv_index ?? null,
       rainProb: omData?.daily?.precipitation_probability_max?.[0] ?? null,
       agro: {
         humidity: omData?.current?.relative_humidity_2m ?? null,
         frost: (omData?.daily?.temperature_2m_min?.[0] <= 3) ? "Alta" : "Baja"
       }
    };

    // 2. EXTRACCIÓN DE TEMPERATURAS PARA CONSENSO
    const rawSources = [
      { id: 'openweather', type: 'model', temp: owData?.main?.temp },
      { id: 'openmeteo', type: 'model', temp: omData?.current?.temperature_2m },
      { id: 'metno', type: 'model', temp: metData?.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature },
      { id: 'metar', type: 'metar', temp: metarData.temp, distanceKm: metarData.distanceKm },
      { id: 'meteostat', type: 'meteostat', temp: meteostatData.temp, distanceKm: meteostatData.distanceKm }
    ];

    // Calculamos el Consenso Global (Ponderado + Exclusión Outliers basado en Verdad Terrestre)
    const generalAnalysis = calculateAdvancedConsensus(rawSources);
    
    // Calculamos el Consenso SOLO de modelos (cae correctamente en lógica de mediana al no pasar observaciones)
    const modelAnalysis = calculateAdvancedConsensus(rawSources.filter(s => s.type === 'model'));

    const isUsed = (id) => generalAnalysis.acceptedIds.includes(id);

    // 3. ARMADO DEL OBJETO DE RESPUESTA
    const models = {
      average: modelAnalysis.value,
      sources: {
        openweather: { 
          temp: owData?.main?.temp ?? null, 
          humidity: owData?.main?.humidity ?? null, 
          wind: owData?.wind?.speed ?? null, 
          desc: owData?.weather?.[0]?.description ?? "",
          usedInConsensus: isUsed('openweather')
        },
        openmeteo: { 
          temp: omData?.current?.temperature_2m ?? null, 
          wind: omData?.current?.wind_speed_10m ?? null, 
          desc: "Open-Meteo",
          usedInConsensus: isUsed('openmeteo')
        },
        metno: { 
          temp: metData?.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature ?? null, 
          humidity: metData?.properties?.timeseries?.[0]?.data?.instant?.details?.relative_humidity ?? null, 
          wind: metData?.properties?.timeseries?.[0]?.data?.instant?.details?.wind_speed ?? null, 
          desc: "MET Norway",
          usedInConsensus: isUsed('metno')
        }
      }
    };

    const result = {
      consensus: generalAnalysis.value,
      confidence: generalAnalysis.acceptedIds.length >= 3 ? "alta" : "media",
      location: { name: resolvedCityName, lat: baseLat, lon: baseLon },
      models,
      observation: { 
        metar: {
          ...metarData,
          usedInConsensus: isUsed('metar')
        }
      },
      premium,
      extra: { 
        meteostat: {
          ...meteostatData,
          usedInConsensus: isUsed('meteostat')
        }, 
        owmKey: OPENWEATHER_KEY 
      },
      daily: dailyForecast
    };

    setCachedResponse(cacheKey, result);
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(result);
    
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error backend", detail: error.message });
  }
}