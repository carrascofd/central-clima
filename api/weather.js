import { sql } from '@vercel/postgres';

const CACHE_TTL_MS = 10 * 60 * 1000;
const METAR_MAX_DISTANCE_KM = 100;
const REM_MAX_DISTANCE_KM = 60; 

const cache = new Map();

// --- FUNCIONES AUXILIARES DE PARSEO PROVINCIAL ---
function parseProvincialJson(text) {
  if (!text) return null;
  let cleanText = text.trim();
  if (cleanText.startsWith('"Datos"')) {
    cleanText = `{${cleanText}}`;
  }
  try {
    const obj = JSON.parse(cleanText);
    if (Array.isArray(obj)) return obj;
    if (obj && Array.isArray(obj.Datos)) return obj.Datos;
    return obj;
  } catch (e) {
    console.error("Error parseando texto crudo de la REM:", e);
    return null;
  }
}

function parseProvincialFloat(val) {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  const clean = String(val).replace(',', '.').trim();
  const p = parseFloat(clean);
  return isNaN(p) ? null : p;
}

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

function degToCard(deg) {
  if (deg == null) return "N/A";
  const angles = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  const index = Math.round(deg / 45) % 8;
  return angles[index];
}

// Fase lunar matemática simple
function calcularFaseLunar() {
  const LUNAR_MONTH = 29.53058867;
  const knownNewMoon = new Date('2024-01-11T11:57:00Z').getTime();
  const diffDays = (Date.now() - knownNewMoon) / (1000 * 60 * 60 * 24);
  const phase = (diffDays % LUNAR_MONTH) / LUNAR_MONTH;
  if (phase < 0.05 || phase > 0.95) return { name: "Nueva", emoji: "🌑" };
  if (phase < 0.25) return { name: "Creciente", emoji: "🌒" };
  if (phase < 0.45) return { name: "Cuarto Creciente", emoji: "🌓" };
  if (phase < 0.55) return { name: "Llena", emoji: "🌕" };
  if (phase < 0.75) return { name: "Menguante", emoji: "🌖" };
  return { name: "Cuarto Menguante", emoji: "🌗" };
}

// Traductor estático MetNorway
function traducirMetNorway(code) {
  if(!code) return null;
  const map = {
    'clearsky': 'Despejado', 'fair': 'Poco nublado',
    'partlycloudy': 'Parcialmente nublado', 'cloudy': 'Nublado',
    'heavyrain': 'Lluvia fuerte', 'lightrain': 'Lluvia ligera',
    'rain': 'Lluvia', 'showers': 'Chubascos', 'snow': 'Nieve',
    'fog': 'Niebla', 'thunder': 'Tormenta eléctrica'
  };
  const baseCode = code.split('_')[0];
  return map[baseCode] || code;
}

// Traductor WMO (Open-Meteo)
function translateWmoCode(code) {
  if (code === 0) return "Despejado";
  if ([1, 2, 3].includes(code)) return "Parcialmente nublado";
  if ([45, 48].includes(code)) return "Niebla";
  if ([51, 53, 55].includes(code)) return "Llovizna ligera";
  if ([61, 63, 65].includes(code)) return "Lluvias intermitentes";
  if ([71, 73, 75].includes(code)) return "Nieve";
  if ([80, 81, 82].includes(code)) return "Chubascos de lluvia";
  if ([95, 96, 99].includes(code)) return "Tormenta eléctrica";
  return "Tiempo estable";
}

// --- SERVICIOS COMPLEMENTARIOS ---
async function fetchNearestMetar(lat, lon, apiKey) {
  const defaultObj = { temp: null, humidity: null, windSpeed: null, windDir: null, pressure: null, visibility: null, station: "Sin datos", distanceKm: null, note: "CHECKWX_KEY no configurada", timestamp: null };
  if (!apiKey) return defaultObj;
  
  const metarRes = await fetch(`https://api.checkwx.com/v2/metar/lat/${lat}/lon/${lon}/decoded?limit=1`, { headers: { "X-API-Key": apiKey } });
  if (!metarRes.ok) return { ...defaultObj, station: "METAR sin datos", note: null };
  const metarData = await metarRes.json();
  const obs = metarData?.data?.[0];
  if (!obs) return { ...defaultObj, station: "METAR sin datos", note: null };
  
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

  let wSpeed = obs.wind?.speed_kph ?? null;
  if (wSpeed == null && obs.wind?.speed_kts != null) {
    wSpeed = obs.wind.speed_kts * 1.852;
  }
  let vis = obs.visibility?.meters ? obs.visibility.meters / 1000 : null;
  if (vis == null && obs.visibility?.miles != null) {
    vis = obs.visibility.miles * 1.60934;
  }

  return {
    temp: obs.temperature?.celsius ?? null,
    humidity: obs.humidity?.percent ?? null,
    windSpeed: wSpeed != null ? Number(wSpeed.toFixed(1)) : null,
    windDir: obs.wind?.degrees ? degToCard(obs.wind.degrees) : null,
    pressure: obs.barometer?.hpa ?? null,
    visibility: vis != null ? Number(vis.toFixed(1)) : null,
    station: stationLabel,
    distanceKm: distance != null ? Number(distance.toFixed(1)) : null,
    note: distance != null ? `A ${Math.round(distance)} km${timeDesc}` : null,
    timestamp: obsTime
  };
}

async function fetchMeteostatObservation(lat, lon, apiKey) {
  const empty = { temp: null, humidity: null, windSpeed: null, windDir: null, pressure: null, precipitation: null, station: null, distanceKm: null, desc: "Sin datos", timestamp: null };
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
    humidity: latest.rh ?? null,
    windSpeed: latest.wspd ?? null, 
    windDir: latest.wdir ? degToCard(latest.wdir) : null,
    pressure: latest.pres ?? null,
    precipitation: latest.prcp ?? null,
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

  const spoofHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'es-419,es;q=0.9'
  };

  let targetStationId = null;
  let stationName = "Estación REM";
  let minDistance = Infinity;

  try {
    const listController = new AbortController();
    const listTimeout = setTimeout(() => listController.abort(), 6000);

    const stationsRes = await fetch('https://wsestaciones.sanluis.gob.ar/Modulos/Datos/Datos.aspx?function=estaciones', { 
      signal: listController.signal,
      headers: spoofHeaders
    }).catch(() => null);
    
    clearTimeout(listTimeout);

    if (stationsRes && stationsRes.ok) {
      const rawText = await stationsRes.text();
      const stations = parseProvincialJson(rawText);

      if (Array.isArray(stations)) {
        stations.forEach(st => {
          const id = st.id ?? st.id_estacion ?? st.station_id;
          const name = st.nombre ?? st.name ?? st.estacion;
          const stLat = parseProvincialFloat(st.latitud ?? st.lat ?? st.latitude);
          const stLon = parseProvincialFloat(st.longitud ?? st.lon ?? st.longitude ?? st.lng);
          
          if (stLat !== null && stLon !== null && id) {
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
    console.warn("Fallo en mapeo dinámico REM, recurriendo a fallback.");
  }

  if (!targetStationId) {
    const backupStations = [
      { id: "1", name: "Alto Pelado", lat: -33.83756, lon: -66.13864 }, { id: "2", name: "Anchorena", lat: -35.6731, lon: -65.42411 },
      { id: "8", name: "Concarán", lat: -32.55445, lon: -65.24881 }, { id: "21", name: "La Toma", lat: -33.05243, lon: -65.61933 },
      { id: "27", name: "Merlo", lat: -32.33348, lon: -65.01432 }, { id: "42", name: "Villa Mercedes", lat: -33.678586, lon: -65.504645 },
      { id: "46", name: "San Luis Rural", lat: -33.33604, lon: -66.43529 }, { id: "51", name: "Potrero de los Funes", lat: -33.23122, lon: -66.22822 },
      { id: "58", name: "Aeropuerto San Luis", lat: -33.275921, lon: -66.353356 }
    ];
    backupStations.forEach(st => {
      const d = distanceKm(lat, lon, st.lat, st.lon);
      if (d < minDistance) { minDistance = d; targetStationId = st.id; stationName = st.name; }
    });
  }

  if (minDistance > REM_MAX_DISTANCE_KM) return emptyOutside;

  try {
    const dataController = new AbortController();
    const dataTimeout = setTimeout(() => dataController.abort(), 6000);

    const currentRes = await fetch(`https://wsestaciones.sanluis.gob.ar/Modulos/Datos/Datos.aspx?function=minutos&EstacionId=${targetStationId}`, { 
      signal: dataController.signal,
      headers: spoofHeaders
    }).catch(() => null);
    
    clearTimeout(dataTimeout);

    if (currentRes && currentRes.ok) {
      const rawText = await currentRes.text();
      const records = parseProvincialJson(rawText);
      const currentData = (Array.isArray(records) ? records[0] : records) || {};

      const realRemTemp = parseProvincialFloat(currentData.temp ?? currentData.temperatura ?? currentData.Temperatura);
      const humidity = parseProvincialFloat(currentData.hh ?? currentData.humedad ?? currentData.Humedad);
      const windSpeed = parseProvincialFloat(currentData.vv ?? currentData.viento_velocidad ?? currentData.velocidad_viento);
      const windDir = currentData.dv ?? currentData.viento_direccion ?? currentData.direccion_viento;
      const pressure = parseProvincialFloat(currentData.pres ?? currentData.presion ?? currentData.Presion);
      const rain = parseProvincialFloat(currentData.pp ?? currentData.precipitacion ?? currentData.lluvia);

      if (realRemTemp !== null) {
        return {
          temp: Number(realRemTemp.toFixed(1)),
          station: stationName,
          stationId: targetStationId,
          distanceKm: Number(minDistance.toFixed(1)),
          note: `A ${minDistance.toFixed(1)} km de tu ubicación`,
          humidity: humidity != null ? Math.round(humidity) : null,
          windSpeed: windSpeed != null ? Math.round(windSpeed) : null,
          windDir: windDir ? String(windDir).trim() : null,
          pressure: pressure != null ? Math.round(pressure) : null,
          rain: rain != null ? Number(rain.toFixed(2)) : null,
          timestamp: Date.now(),
          visible: true
        };
      }
    }
    return { temp: null, station: stationName, stationId: targetStationId, distanceKm: Number(minDistance.toFixed(1)), note: "Estación sin datos recientes", timestamp: null, visible: true };
  } catch (e) {
    return { temp: null, station: stationName, stationId: targetStationId, distanceKm: Number(minDistance.toFixed(1)), note: "Error interpretando nodo provincial", timestamp: null, visible: true };
  }
}

// --- ALGORITMO DE CONSENSO AVANZADO ---
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
      groundTruthAnchor = Math.abs(ageMetar - ageMeteostat) > 1.5 * 60 * 60 * 1000 ? (ageMetar < ageMeteostat ? tMetar : tMeteostat) : ((metar.distanceKm || 0) <= (meteostat.distanceKm || 0) ? tMetar : tMeteostat);
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
          if (Math.abs(s.temp - groundTruthAnchor) <= 3.0) isAcceptable = true; 
        }
      } else if (s.type === 'model') {
        isAcceptable = Math.abs(s.temp - groundTruthAnchor) <= MAX_MODEL_DEVIATION_FROM_REAL;
      }

      if (isAcceptable) {
        acceptedIds.push(s.id);
        let weight = 1; 
        if (s.type === 'metar') weight = Math.max(1.5, 4.0 - ((s.distanceKm || 0) / 30));
        else if (s.type === 'meteostat') weight = 2.5;
        else if (s.type === 'rem') weight = 5.0; 

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
    return { value: Number(median.toFixed(1)), acceptedIds: [] };
  }

  return { value: Number((weightedSum / totalWeight).toFixed(1)), acceptedIds };
}

function calculateSecondaryConsensus(sources, field, acceptedIds, isInteger = false) {
  const filtered = sources.filter(s => acceptedIds.includes(s.id) && s[field] != null);
  const targetList = filtered.length > 0 ? filtered : sources.filter(s => s[field] != null);
  
  if (targetList.length === 0) return null;
  const sum = targetList.reduce((acc, curr) => acc + curr[field], 0);
  const avg = sum / targetList.length;
  return isInteger ? Math.round(avg) : Number(avg.toFixed(1));
}

// --- HANDLER PRINCIPAL ---
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
      fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${baseLat}&lon=${baseLon}&units=metric&lang=es&appid=${OPENWEATHER_KEY}`),
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,surface_pressure,visibility,precipitation,weather_code,dew_point_2m,et0_fao_evapotranspiration&daily=temperature_2m_max,temperature_2m_min,weather_code,uv_index_max,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant&forecast_days=4&wind_speed_unit=kmh&timezone=auto`),
      fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`, { headers: { "User-Agent": "central-clima" } }),
      fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${baseLat}&longitude=${baseLon}&current=european_aqi,uv_index,pm10,pm2_5,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen&timezone=auto`).catch(() => null),
      fetchNearestMetar(baseLat, baseLon, CHECKWX_KEY).catch(() => ({ temp: null, humidity: null, windSpeed: null, windDir: null, pressure: null, visibility: null, station: "Error METAR", distanceKm: null, note: null, timestamp: null })),
      fetchMeteostatObservation(baseLat, baseLon, METEOSTAT_KEY).catch(() => ({ temp: null, humidity: null, windSpeed: null, windDir: null, pressure: null, precipitation: null, station: null, distanceKm: null, desc: "Error Meteostat", timestamp: null }))
    ]);

    const owData = owRes.ok ? await owRes.json() : null;
    const omData = omRes.ok ? await omRes.json() : null;
    const metData = metRes.ok ? await metRes.json() : null;
    const aqiData = aqiRes && aqiRes.ok ? await aqiRes.json() : null;

    const resolvedCityName = city || owData?.name || "Ubicación actual";
    const remData = await fetchREMObservation(baseLat, baseLon);

    const owNormalized = {
      id: 'openweather', type: 'model',
      temp: owData?.main?.temp ?? null,
      humidity: owData?.main?.humidity ?? null,
      windSpeed: owData?.wind?.speed != null ? Number((owData.wind.speed * 3.6).toFixed(1)) : null, 
      windDir: owData?.wind?.deg ? degToCard(owData.wind.deg) : null,
      pressure: owData?.main?.pressure ?? null,
      visibility: owData?.visibility != null ? Number((owData.visibility / 1000).toFixed(1)) : null, 
      precipitation: owData?.rain?.['1h'] ?? owData?.snow?.['1h'] ?? 0
    };

    const omNormalized = {
      id: 'openmeteo', type: 'model',
      temp: omData?.current?.temperature_2m ?? null,
      humidity: omData?.current?.relative_humidity_2m ?? null,
      windSpeed: omData?.current?.wind_speed_10m ?? null, 
      windDir: omData?.current?.wind_direction_10m ? degToCard(omData.current.wind_direction_10m) : null,
      pressure: omData?.current?.surface_pressure ?? null,
      visibility: omData?.current?.visibility != null ? Number((omData.current.visibility / 1000).toFixed(1)) : null, 
      precipitation: omData?.current?.precipitation ?? 0
    };

    const metDetails = metData?.properties?.timeseries?.[0]?.data?.instant?.details;
    const metSummaryCode = metData?.properties?.timeseries?.[0]?.data?.next_1_hours?.summary?.symbol_code;
    const metNormalized = {
      id: 'metno', type: 'model',
      temp: metDetails?.air_temperature ?? null,
      humidity: metDetails?.relative_humidity ?? null,
      windSpeed: metDetails?.wind_speed != null ? Number((metDetails.wind_speed * 3.6).toFixed(1)) : null, 
      windDir: metDetails?.wind_from_direction ? degToCard(metDetails.wind_from_direction) : null,
      pressure: metDetails?.air_pressure_at_sea_level ?? null,
      visibility: null,
      precipitation: metData?.properties?.timeseries?.[0]?.data?.next_1_hours?.details?.precipitation_amount ?? 0
    };

    const rawSources = [
      owNormalized, omNormalized, metNormalized,
      { id: 'metar', type: 'metar', ...metarData },
      { id: 'meteostat', type: 'meteostat', ...meteostatData },
      { id: 'rem', type: 'rem', ...remData }
    ];

    const generalAnalysis = calculateAdvancedConsensus(rawSources);
    const modelAnalysis = calculateAdvancedConsensus(rawSources.filter(s => s.type === 'model'));
    const isUsed = (id) => generalAnalysis.acceptedIds.includes(id);

    const consensus_fields = {
      humidity: calculateSecondaryConsensus(rawSources, 'humidity', generalAnalysis.acceptedIds, true),
      windSpeed: calculateSecondaryConsensus(rawSources, 'windSpeed', generalAnalysis.acceptedIds),
      pressure: calculateSecondaryConsensus(rawSources, 'pressure', generalAnalysis.acceptedIds, true),
      visibility: calculateSecondaryConsensus(rawSources, 'visibility', generalAnalysis.acceptedIds),
      precipitation: calculateSecondaryConsensus(rawSources, 'precipitation', generalAnalysis.acceptedIds),
      windDir: remData.windDir ?? metarData.windDir ?? omNormalized.windDir ?? owNormalized.windDir ?? "N/A"
    };

    const dailyForecast = [];
    if (omData?.daily) {
      for (let i = 0; i < omData.daily.time.length; i++) {
        dailyForecast.push({
          date: omData.daily.time[i],
          max: omData.daily.temperature_2m_max?.[i] ?? null,
          min: omData.daily.temperature_2m_min?.[i] ?? null,
          code: omData.daily.weather_code?.[i] ?? null,
          rainProb: omData.daily.precipitation_probability_max?.[i] ?? 0,
          precipitationSum: omData.daily.precipitation_sum?.[i] ?? 0,
          windMax: omData.daily.wind_speed_10m_max?.[i] ?? null,
          windDir: omData.daily.wind_direction_10m_dominant?.[i] ? degToCard(omData.daily.wind_direction_10m_dominant[i]) : "N/A"
        });
      }
    }

    let totalPollen = null;
    if (aqiData?.current) {
        const p1 = aqiData.current.alder_pollen || 0;
        const p2 = aqiData.current.birch_pollen || 0;
        const p3 = aqiData.current.grass_pollen || 0;
        const p4 = aqiData.current.mugwort_pollen || 0;
        const p5 = aqiData.current.olive_pollen || 0;
        const p6 = aqiData.current.ragweed_pollen || 0;
        totalPollen = (p1 + p2 + p3 + p4 + p5 + p6).toFixed(1);
        if(totalPollen === "0.0") totalPollen = null;
    }

    const premium = {
       aqi: aqiData?.current?.european_aqi ?? null,
       pm10: aqiData?.current?.pm10 ?? null,
       uv: omData?.daily?.uv_index_max?.[0] ?? aqiData?.current?.uv_index ?? null,
       rainProb: omData?.daily?.precipitation_probability_max?.[0] ?? 0,
       pollen: totalPollen,
       agro: {
          humidity: consensus_fields.humidity,
          frost: (omData?.daily?.temperature_2m_min?.[0] <= 3) ? "Alta" : "Baja",
          dewPoint: omData?.current?.dew_point_2m ?? null,
          et0: omData?.current?.et0_fao_evapotranspiration ?? null,
          lunarPhase: calcularFaseLunar()
       }
    };

    const result = {
      consensus: generalAnalysis.value,
      confidence: generalAnalysis.acceptedIds.length >= 3 ? "alta" : "media",
      location: { name: resolvedCityName, lat: baseLat, lon: baseLon },
      consensus_fields,
      models: {
        average: modelAnalysis.value,
        sources: {
          openweather: { ...owNormalized, desc: owData?.weather?.[0]?.description ?? "", usedInConsensus: isUsed('openweather') },
          openmeteo: { ...omNormalized, desc: translateWmoCode(omData?.current?.weather_code), usedInConsensus: isUsed('openmeteo') },
          metno: { ...metNormalized, desc: traducirMetNorway(metSummaryCode), usedInConsensus: isUsed('metno') }
        }
      },
      observation: { 
        metar: { ...metarData, usedInConsensus: isUsed('metar') },
        rem: { ...remData, usedInConsensus: isUsed('rem') }
      },
      premium,
      extra: { meteostat: { ...meteostatData, usedInConsensus: isUsed('meteostat') }, owmKey: OPENWEATHER_KEY },
      daily: dailyForecast
    };

    try {
      const fuentesTexto = generalAnalysis.acceptedIds.join(', ');
      const condicionTexto = owData?.weather?.[0]?.description ?? "N/A";
      await sql`
        INSERT INTO historial_clima 
        (ciudad, temperatura_consenso, humedad_consenso, viento_consenso, condicion_consenso, fuentes_respondieron)
        VALUES (
          ${resolvedCityName}, 
          ${generalAnalysis.value}, 
          ${consensus_fields.humidity}, 
          ${consensus_fields.windSpeed}, 
          ${condicionTexto}, 
          ${fuentesTexto}
        );
      `;
    } catch (dbError) {
      console.error("Error al guardar en el log de Neon:", dbError);
    }

    setCachedResponse(cacheKey, result);
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error backend", detail: error.message });
  }
}