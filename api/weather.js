const CACHE_TTL_MS = 10 * 60 * 1000;
const METAR_MAX_DISTANCE_KM = 100;
const REM_MAX_DISTANCE_KM = 60; 

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
  if (!apiKey) return { temp: null, station: "Sin datos", distanceKm: null, note: "CHECKWX_KEY no configurada", timestamp: null };
  const metarRes = await fetch(`https://api.checkwx.com/v2/metar/lat/${lat}/lon/${lon}/decoded?limit=1`, { headers: { "X-API-Key": apiKey } });
  if (!metarRes.ok) return { temp: null, station: "METAR sin datos", distanceKm: null, note: null, timestamp: null };
  const metarData = await metarRes.json();
  const obs = metarData?.data?.[0];
  if (!obs) return { temp: null, station: "METAR sin datos", distanceKm: null, note: null, timestamp: null };
  
  const distance = metarDistanceKm(obs, lat, lon);
  const stationName = obs.station?.name ?? obs.station?.icao ?? obs.icao ?? "Estación desconocida";
  const icao = obs.station?.icao ?? obs.icao ?? "";
  const stationLabel = icao ? `${stationName} (${icao})` : stationName;

  const obsTimeStr = obs.observed;
  const obsTime = obsTimeStr ? new Date(obsTimeStr).getTime() : null;
  let timeDesc = "";
  if (obsTime) {
    const diffH = Math.round((Date.now() - obsTime) / 3600000);
    timeDesc = diffH > 0 ? ` (hace ${diffH}h)` : " (reciente)";
  }

  return {
    temp: obs.temperature?.celsius ?? null,
    station: stationLabel,
    distanceKm: distance != null ? Number(distance.toFixed(1)) : null,
    note: distance != null ? `A ${Math.round(distance)} km${timeDesc}` : null,
    timestamp: obsTime
  };
}

async function fetchMeteostatObservation(lat, lon, apiKey) {
  const empty = { temp: null, station: null, distanceKm: null, desc: "Sin datos", timestamp: null };
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

  let obsTime = null;
  let timeDesc = "";
  if (latest.time) {
    obsTime = new Date(latest.time.replace(' ', 'T') + 'Z').getTime();
    const diffH = Math.round((Date.now() - obsTime) / 3600000);
    timeDesc = diffH > 0 ? ` (hace ${diffH}h)` : " (reciente)";
  }

  return {
    temp: latest.temp,
    station: station.name?.en ?? station.id,
    distanceKm: station.distance != null ? Number((station.distance / 1000).toFixed(1)) : null,
    desc: `Observación activa${timeDesc}`,
    timestamp: obsTime
  };
}

async function fetchREMObservation(lat, lon) {
  const emptyOutside = { temp: null, station: "Red REM San Luis", stationId: null, distanceKm: null, note: "Fuera de rango provincial", timestamp: null, visible: false };
  
  const isSanLuisRegion = lat >= -36.5 && lat <= -31.0 && lon >= -68.5 && lon <= -63.5;
  if (!isSanLuisRegion) return emptyOutside;

  // Cabeceras de simulación para evitar bloqueos de Web Application Firewalls (WAF)
  const spoofHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'es-419,es;q=0.9'
  };

  let targetStationId = null;
  let stationName = "Estación REM";
  let minDistance = Infinity;

  // 1. Intentar obtener el listado dinámico con su propio timeout holgado (6 segundos)
  try {
    const listController = new AbortController();
    const listTimeout = setTimeout(() => listController.abort(), 6000);

    const stationsRes = await fetch('https://wsestaciones.sanluis.gob.ar/Modulos/Datos/Datos.aspx?function=estaciones', { 
      signal: listController.signal,
      headers: spoofHeaders
    }).catch(() => null);
    
    clearTimeout(listTimeout);

    if (stationsRes && stationsRes.ok) {
      const stations = await stationsRes.json();
      if (Array.isArray(stations)) {
        stations.forEach(st => {
          const id = st.id ?? st.id_estacion ?? st.station_id;
          const name = st.nombre ?? st.name ?? st.estacion;
          const stLat = parseFloat(st.latitud ?? st.lat ?? st.latitude);
          const stLon = parseFloat(st.longitud ?? st.lon ?? st.longitude ?? st.lng);
          
          if (stLat && stLon && id) {
            const d = distanceKm(lat, lon, stLat, stLon);
            if (d < minDistance) {
              minDistance = d;
              targetStationId = String(id);
              stationName = name;
            }
          }
        });
      }
    }
  } catch (e) {
    console.warn("No se pudo mapear dinámicamente el listado REM, usando fallback estático.");
  }

  // Fallback estático inmediato si el servidor de mapas de la REM falló o dio timeout
  if (!targetStationId) {
    const backupStations = [
      { id: "1", name: "Alto Pelado", lat: -34.039, lon: -66.308 },
      { id: "2", name: "Anchorena", lat: -35.666, lon: -65.424 },
      { id: "46", name: "San Luis Rural", lat: -33.272, lon: -66.228 },
      { id: "58", name: "Aeropuerto San Luis", lat: -33.273, lon: -66.353 },
      { id: "3", name: "Merlo", lat: -32.343, lon: -65.013 }
    ];
    backupStations.forEach(st => {
      const d = distanceKm(lat, lon, st.lat, st.lon);
      if (d < minDistance) {
        minDistance = d;
        targetStationId = st.id;
        stationName = st.name;
      }
    });
  }

  if (minDistance > REM_MAX_DISTANCE_KM) {
    return emptyOutside;
  }

  // 2. Consultar las métricas de minutos con un nuevo timeout dedicado
  try {
    const dataController = new AbortController();
    const dataTimeout = setTimeout(() => dataController.abort(), 6000);

    const currentRes = await fetch(`https://wsestaciones.sanluis.gob.ar/Modulos/Datos/Datos.aspx?function=minutos&EstacionId=${targetStationId}`, { 
      signal: dataController.signal,
      headers: spoofHeaders
    }).catch(() => null);
    
    clearTimeout(dataTimeout);

    if (currentRes && currentRes.ok) {
      let currentData = await currentRes.json();
      
      if (Array.isArray(currentData)) {
        currentData = currentData[0] || {};
      }

      const realRemTemp = currentData.temperatura ?? currentData.Temperatura ?? currentData.temp ?? currentData.temperature;
      const humidity = currentData.humedad ?? currentData.Humedad ?? currentData.humidity ?? currentData.hum;
      const windSpeed = currentData.viento_velocidad ?? currentData.Viento_Velocidad ?? currentData.velocidad_viento ?? currentData.wind_speed ?? currentData.wind_speed_kmh;
      const windDir = currentData.viento_direccion ?? currentData.Viento_Direccion ?? currentData.direccion_viento ?? currentData.wind_direction ?? currentData.wind_dir;
      const pressure = currentData.presion ?? currentData.Presion ?? currentData.pressure ?? currentData.atmospheric_pressure;
      const rain = currentData.precipitacion ?? currentData.Precipitacion ?? currentData.lluvia ?? currentData.rain ?? currentData.rain_today;

      if (realRemTemp !== undefined && realRemTemp !== null) {
        return {
          temp: parseFloat(realRemTemp),
          station: stationName,
          stationId: targetStationId,
          distanceKm: Number(minDistance.toFixed(1)),
          note: `A ${minDistance.toFixed(1)} km de tu ubicación`,
          humidity: humidity != null ? Math.round(parseFloat(humidity)) : null,
          windSpeed: windSpeed != null ? Math.round(parseFloat(windSpeed)) : null,
          windDir: windDir ? String(windDir).trim() : null,
          pressure: pressure != null ? Math.round(parseFloat(pressure)) : null,
          rain: rain != null ? parseFloat(rain) : null,
          timestamp: Date.now(),
          visible: true
        };
      }
    }

    return { 
      temp: null, 
      station: stationName, 
      stationId: targetStationId,
      distanceKm: Number(minDistance.toFixed(1)), 
      note: "Estación REM en mantenimiento o sin datos recientes", 
      timestamp: null, 
      visible: true 
    };

  } catch (e) {
    return { 
      temp: null, 
      station: stationName, 
      stationId: targetStationId,
      distanceKm: Number(minDistance.toFixed(1)), 
      note: "Error al leer respuesta del nodo provincial", 
      timestamp: null, 
      visible: true 
    };
  }
}

function calculateAdvancedConsensus(sourcesArray) {
  const now = Date.now();
  const MAX_AGE_MS = 5 * 60 * 60 * 1000;

  const valid = sourcesArray.filter(s => {
    if (s.temp == null) return false;
    if ((s.type === 'metar' || s.type === 'meteostat' || s.type === 'rem') && s.timestamp) {
      if (now - s.timestamp > MAX_AGE_MS) return false;
    }
    return true;
  });

  if (valid.length === 0) return { value: null, acceptedIds: [] };

  const metar = valid.find(s => s.type === 'metar');
  const meteostat = valid.find(s => s.type === 'meteostat');
  const rem = valid.find(s => s.type === 'rem'); 
  
  let groundTruthAnchor = null;

  const tMetar = metar?.temp;
  const tMeteostat = meteostat?.temp;
  const tRem = rem?.temp;

  const isMetarNear = metar && (metar.distanceKm == null || metar.distanceKm <= METAR_MAX_DISTANCE_KM);
  const isMeteostatNear = meteostat && (meteostat.distanceKm == null || meteostat.distanceKm <= METAR_MAX_DISTANCE_KM);
  const isRemNear = rem && (rem.distanceKm == null || rem.distanceKm <= REM_MAX_DISTANCE_KM);

  if (tRem != null && isRemNear) {
    groundTruthAnchor = tRem;
  } else if (tMetar != null && tMeteostat != null && isMetarNear && isMeteostatNear) {
    if (Math.abs(tMetar - tMeteostat) <= 3.0) {
      groundTruthAnchor = (tMetar + tMeteostat) / 2;
    } else {
      const ageMetar = metar.timestamp ? (now - metar.timestamp) : 0;
      const ageMeteostat = meteostat.timestamp ? (now - meteostat.timestamp) : 0;
      
      if (Math.abs(ageMetar - ageMeteostat) > 1.5 * 60 * 60 * 1000) {
        groundTruthAnchor = ageMetar < ageMeteostat ? tMetar : tMeteostat;
      } else {
        groundTruthAnchor = (metar.distanceKm || 0) <= (meteostat.distanceKm || 0) ? tMetar : tMeteostat;
      }
    }
  } else if (tMetar != null && isMetarNear) {
    groundTruthAnchor = tMetar;
  } else if (tMeteostat != null && isMeteostatNear) {
    groundTruthAnchor = tMeteostat;
  }

  const acceptedIds = [];
  let totalWeight = 0;
  let weightedSum = 0;

  const MAX_MODEL_DEVIATION_FROM_REAL = 4.5;
  const MAX_MODEL_DEVIATION_FROM_MEDIAN = 2.0; 

  if (groundTruthAnchor !== null) {
    valid.forEach(s => {
      let isAcceptable = false;

      if (s.type === 'metar' || s.type === 'meteostat' || s.type === 'rem') {
        const limitDist = s.type === 'rem' ? REM_MAX_DISTANCE_KM : METAR_MAX_DISTANCE_KM;
        if (s.distanceKm == null || s.distanceKm <= limitDist) {
          if (Math.abs(s.temp - groundTruthAnchor) <= 3.0) {
            isAcceptable = true; 
          }
        }
      } else if (s.type === 'model') {
        isAcceptable = Math.abs(s.temp - groundTruthAnchor) <= MAX_MODEL_DEVIATION_FROM_REAL;
      }

      if (isAcceptable) {
        acceptedIds.push(s.id);
        let weight = 1; 

        if (s.type === 'metar') {
          const dist = s.distanceKm || 0;
          weight = Math.max(1.5, 4.0 - (dist / 30));
        } else if (s.type === 'meteostat') {
          weight = 2.5;
        } else if (s.type === 'rem') {
          weight = 5.0; 
        }

        weightedSum += s.temp * weight;
        totalWeight += weight;
      }
    });
  } else {
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

function generateInstagramPayload(data) {
  const cleanCityName = data.location.name.replace(/\s+/g, '');
  
  const intros = [
    `📍 REPORTE DEL CLIMA | ${data.location.name}\n\nEl análisis consolidado de hoy muestra una temperatura de ${data.consensus}°C. Nuestro algoritmo procesó las tendencias principales para darte el dato más preciso del momento.`,
    `🌍 ACTUALIZACIÓN CLIMÁTICA | ${data.location.name}\n\nPasamos por el colador los principales modelos numéricos y el consenso matemático nos da ${data.consensus}°C para hoy. Te dejamos el desglose técnico de la jornada:`,
    `📊 CONSENSO DEL TIEMPO | ${data.location.name}\n\n¿Qué dice nuestra optimización hoy? Monitoreamos estaciones físicas y simulaciones para consolidar una temperatura real de ${data.consensus}°C. Así se ven los datos duros:`
  ];

  const outros = [
    `\n\n💻 Datos procesados en tiempo real por Central de Clima.\n\n#Clima #${cleanCityName} #Meteorologia #Agro #ConsensoClimatico`,
    `\n\n🚀 Monitoreo continuo automatizado por Central de Clima.\n\n#Tiempo #${cleanCityName} #Agrotecnologia #DataScience #ClimaHoy`,
    `\n\n🌾 Optimización de datos meteorológicos de precisión.\n\n#Meteorologia #${cleanCityName} #CampoArgentino #SmartFarming #Consenso`
  ];

  const dayIndex = new Date().getDate();
  const intro = intros[dayIndex % intros.length];
  const outro = outros[dayIndex % outros.length];

  let groundTruthText = `• ${data.observation.metar.station || 'Estación Cercana'}: ${data.observation.metar.temp ?? '--'}°C (${data.observation.metar.note || 'Activa'})`;
  if (data.observation.rem && data.observation.rem.temp !== null && data.observation.rem.visible !== false) {
    groundTruthText = `• ${data.observation.rem.station} (REM ID: ${data.observation.rem.stationId}): ${data.observation.rem.temp}°C\n• METAR Cercano: ${data.observation.metar.temp ?? '--'}°C`;
  }

  const body = `
🤖 Modelos Numéricos:
• Promedio de simulaciones: ${data.models.average}°C
• Desviación analizada: Confianza ${data.confidence.toUpperCase()}

📡 Verdad Terrestre (Estaciones Reales):
${groundTruthText}

🌾 Indicadores de Campo y Salud:
• Probabilidad de Precipitaciones: ${data.premium.rainProb ?? 0}%
• Humedad en Superficie: ${data.premium.agro.humidity ?? '--'}%
• Riesgo de Heladas: ${data.premium.agro.frost}
• Índice UV Máximo: ${data.premium.uv ?? '--'}`;

  return {
    caption: `${intro}\n${body}${outro}`,
    raw_data: data
  };
}

export default async function handler(req, res) {
  const city = req.query.city;
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;
  const format = req.query.format;

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
      if (format === 'instagram') {
        return res.status(200).json(generateInstagramPayload(cached));
      }
      return res.status(200).json(cached);
    }

    const [owRes, omRes, metRes, aqiRes, metarData, meteostatData] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${baseLat}&lon=${baseLon}&units=metric&appid=${OPENWEATHER_KEY}`),
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current=temperature_2m,wind_speed_10m,weather_code,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,weather_code,uv_index_max,precipitation_probability_max&forecast_days=3&timezone=auto`),
      fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`, { headers: { "User-Agent": "central-clima" } }),
      fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${baseLat}&longitude=${baseLon}&current=european_aqi,uv_index,pm10,pm2_5&timezone=auto`).catch(() => null),
      fetchNearestMetar(baseLat, baseLon, CHECKWX_KEY).catch(() => ({ temp: null, station: "Error METAR", distanceKm: null, note: null, timestamp: null })),
      fetchMeteostatObservation(baseLat, baseLon, METEOSTAT_KEY).catch(() => ({ temp: null, station: null, distanceKm: null, desc: "Error Meteostat", timestamp: null }))
    ]);

    const owData = owRes.ok ? await owRes.json() : null;
    const omData = omRes.ok ? await omRes.json() : null;
    const metData = metRes.ok ? await metRes.json() : null;
    const aqiData = aqiRes && aqiRes.ok ? await aqiRes.json() : null;

    const resolvedCityName = city || owData?.name || "Ubicación actual";

    const remData = await fetchREMObservation(baseLat, baseLon);

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

    const rawSources = [
      { id: 'openweather', type: 'model', temp: owData?.main?.temp },
      { id: 'openmeteo', type: 'model', temp: omData?.current?.temperature_2m },
      { id: 'metno', type: 'model', temp: metData?.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature },
      { id: 'metar', type: 'metar', temp: metarData.temp, distanceKm: metarData.distanceKm, timestamp: metarData.timestamp },
      { id: 'meteostat', type: 'meteostat', temp: meteostatData.temp, distanceKm: meteostatData.distanceKm, timestamp: meteostatData.timestamp },
      { id: 'rem', type: 'rem', temp: remData.temp, distanceKm: remData.distanceKm, timestamp: remData.timestamp }
    ];

    const generalAnalysis = calculateAdvancedConsensus(rawSources);
    const modelAnalysis = calculateAdvancedConsensus(rawSources.filter(s => s.type === 'model'));

    const isUsed = (id) => generalAnalysis.acceptedIds.includes(id);

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
        },
        rem: {
          ...remData,
          usedInConsensus: isUsed('rem')
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

    if (format === 'instagram') {
      return res.status(200).json(generateInstagramPayload(result));
    }
    return res.status(200).json(result);
    
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error backend", detail: error.message });
  }
}