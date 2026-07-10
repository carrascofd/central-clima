const CACHE_TTL_MS = 10 * 60 * 1000;
const METAR_MAX_DISTANCE_KM = 100;
const REM_MAX_DISTANCE_KM = 60; 

const cache = new Map();

// --- FUNCIONES AUXILIARES DE PARSEO PROVINCIAL ---
function parseProvincialJson(text) {
  if (!text) return null;
  let cleanText = text.trim();
  // Maneja el caso si el servidor devuelve la propiedad Datos suelta sin llaves exteriores
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
  // Reemplaza comas decimales por puntos antes de evaluar
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

// --- SERVICIOS COMPLEMENTARIOS ---
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

// --- SERVICIO REM CORREGIDO Y BLINDADO ---
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

  // 1. Obtener y parsear listado dinámico de estaciones
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
    console.warn("Fallo en mapeo dinámico REM, recurriendo a fallback estático.");
  }

  // Fallback estático inmediato si falló el listado por red o timeout
  if (!targetStationId) {
    const backupStations = [
      { id: "1", name: "Alto Pelado", lat: -33.83756, lon: -66.13864 },
      { id: "2", name: "Anchorena", lat: -35.6731, lon: -65.42411 },
      { id: "3", name: "Bajada Nueva", lat: -35.16846, lon: -66.49468 },
      { id: "4", name: "Baldecito", lat: -32.34821, lon: -66.20278 },
      { id: "5", name: "Batavia", lat: -34.77845, lon: -65.68851 },
      { id: "6", name: "Beazley", lat: -33.75676, lon: -66.64833 },
      { id: "7", name: "Buena Esperanza", lat: -34.75682, lon: -65.25261 },
      { id: "8", name: "Concarán", lat: -32.55445, lon: -65.24881 },
      { id: "9", name: "Desaguadero", lat: -33.40499, lon: -67.1494 },
      { id: "10", name: "El Amago", lat: -32.72055, lon: -66.1628 },
      { id: "11", name: "El Durazno", lat: -33.19005, lon: -66.15286 },
      { id: "12", name: "Fraga", lat: -33.50133, lon: -65.79225 },
      { id: "13", name: "Justo Daract", lat: -33.85085, lon: -65.17382 },
      { id: "14", name: "La Angelina", lat: -34.36133, lon: -65.32747 },
      { id: "15", name: "La Calera", lat: -32.87713, lon: -66.84113 },
      { id: "16", name: "La Cumbre", lat: -33.34238, lon: -66.12125 },
      { id: "17", name: "La Esquina", lat: -33.14587, lon: -65.37258 },
      { id: "18", name: "La Florida", lat: -33.11747, lon: -66.0025 },
      { id: "19", name: "La Punilla", lat: -33.14373, lon: -65.0837 },
      { id: "20", name: "La Punta", lat: -33.15642, lon: -66.31473 },
      { id: "21", name: "La Toma", lat: -33.05243, lon: -65.61933 },
      { id: "22", name: "La Tranca", lat: -32.33969, lon: -67.2662 },
      { id: "23", name: "Lafinur", lat: -32.05826, lon: -65.34197 },
      { id: "26", name: "Martín de Loyola", lat: -35.71217, lon: -66.35322 },
      { id: "27", name: "Merlo", lat: -32.33348, lon: -65.01432 },
      { id: "28", name: "Naschel", lat: -32.91946, lon: -65.37194 },
      { id: "29", name: "Nogolí", lat: -32.9188, lon: -66.32607 },
      { id: "30", name: "Nueva Galia", lat: -35.11305, lon: -65.25683 },
      { id: "31", name: "Paso Grande", lat: -32.87672, lon: -65.63421 },
      { id: "32", name: "San Francisco", lat: -32.60059, lon: -66.12823 },
      { id: "34", name: "San Martín", lat: -32.41002, lon: -65.67489 },
      { id: "35", name: "Santa Rosa", lat: -32.34359, lon: -65.20872 },
      { id: "36", name: "San Miguel", lat: -32.14099, lon: -65.81574 },
      { id: "37", name: "Tilisarao", lat: -32.73375, lon: -65.29536 },
      { id: "38", name: "Unión", lat: -35.1546, lon: -65.94489 },
      { id: "39", name: "Villa de Praga", lat: -32.53259, lon: -65.64681 },
      { id: "40", name: "Villa Gral. Roca", lat: -32.66487, lon: -66.45049 },
      { id: "41", name: "Villa Larca", lat: -32.61817, lon: -64.98036 },
      { id: "42", name: "Villa Mercedes", lat: -33.678586, lon: -65.504645 },
      { id: "43", name: "Zanjitas", lat: -33.80497, lon: -66.41587 },
      { id: "44", name: "Navia", lat: -34.77453, lon: -66.5858 },
      { id: "45", name: "Valle de Pancanta", lat: -32.87029, lon: -66.10596 },
      { id: "46", name: "San Luis Rural", lat: -33.33604, lon: -66.43529 },
      { id: "47", name: "El Trapiche", lat: -33.102925, lon: -66.05738056 },
      { id: "48", name: "Merlo Alto", lat: -32.35308, lon: -64.96828 },
      { id: "49", name: "Coronel Alzogaray", lat: -33.46051, lon: -65.42903 },
      { id: "50", name: "La Botija", lat: -32.23766, lon: -66.57863 },
      { id: "51", name: "Potrero de los Funes", lat: -33.23122, lon: -66.22822 },
      { id: "52", name: "Soven", lat: -34.17522, lon: -65.33552 },
      { id: "53", name: "Quebrada de las Higueritas", lat: -32.39472, lon: -65.91894 },
      { id: "54", name: "Los Coros", lat: -33.63525, lon: -66.51341 },
      { id: "55", name: "Estancia Grande", lat: -33.19227, lon: -66.13736 },
      { id: "56", name: "Las Chacras", lat: -33.26172, lon: -66.24302 },
      { id: "58", name: "Aeropuerto San Luis", lat: -33.275921, lon: -66.353356 },
      { id: "59", name: "Aeropuerto Valle del Conlara", lat: -32.378914, lon: -65.180141 },
      { id: "60", name: "Villa Reynolds", lat: -33.725452, lon: -65.385817 },
      { id: "85", name: "Donovan", lat: -33.337614, lon: -66.232069 },
      { id: "86", name: "Varela", lat: -34.1225, lon: -66.463889 },
      { id: "87", name: "La Florida - Dique", lat: -33.1142, lon: -66.0041 },
      { id: "88", name: "AgroZAL", lat: -33.6450639, lon: -65.3794056 },
      { id: "89", name: "Filo-Merlo", lat: -32.3775, lon: -64.925833 },
      { id: "92", name: "Parapente Merlo", lat: -32.368194, lon: -64.937222 }
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

  // 2. Consultar y parsear las métricas de la estación seleccionada
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

      // Mapeo exhaustivo y conversión de comas usando los campos reales observados
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
      note: "Error al interpretar la respuesta del nodo provincial", 
      timestamp: null, 
      visible: true 
    };
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

// --- FORMATEADOR INSTAGRAM ---
// --- TRADUCTOR DE CÓDIGOS WMO (OPEN-METEO) A TEXTO ---
function translateWmoCode(code) {
  if (code === 0) return "Despejado ☀️";
  if ([1, 2, 3].includes(code)) return "Parcialmente nublado ⛅";
  if ([45, 48].includes(code)) return "Niebla o neblina 🌫️";
  if ([51, 53, 55].includes(code)) return "Llovizna ligera 🌦️";
  if ([61, 63, 65].includes(code)) return "Lluvias intermitentes 🌧️";
  if ([71, 73, 75].includes(code)) return "Probabilidad de nieve ❄️";
  if ([80, 81, 82].includes(code)) return "Chubascos de lluvia 🌧️";
  if ([95, 96, 99].includes(code)) return "Tormenta eléctrica ⛈️";
  return "Tiempo estable 🌤️";
}

// --- FORMATEADOR INSTAGRAM (CORREGIDO ACUMULADO VS ACTUAL) ---
function generateInstagramPayload(data) {
  const cleanCityName = data.location.name.replace(/\s+/g, '');
  
  // 1. Forzar la hora de ejecución del backend al huso de Argentina
  const currentHour = new Date().toLocaleTimeString('es-AR', { 
    hour: '2-digit', 
    minute: '2-digit', 
    timeZone: 'America/Argentina/Buenos_Aires' 
  });

  // 2. Extraer el bloque del pronóstico diario para hoy (Índice 0)
  const todayForecast = data.daily?.[0] || {};
  const maxTemp = todayForecast.max != null ? `${todayForecast.max}°C` : '--°C';
  const minTemp = todayForecast.min != null ? `${todayForecast.min}°C` : '--°C';
  const dayCondition = translateWmoCode(todayForecast.code);

  // Intros modificados aclarando que es la lectura de la hora actual
  const intros = [
    `📍 CONDICIONES ACTUALES | ${data.location.name}\n\nReporte consolidado de las ${currentHour} hs. Nuestro algoritmo procesó las mediciones actuales fijando una temperatura real de ${data.consensus}°C en este instante. Así se proyecta el resto de la jornada:`,
    `🌍 ESTADO DEL TIEMPO | ${data.location.name}\n\nLectura en tiempo real (Actualizado a las ${currentHour} hs). El consenso matemático procesó los modelos y estaciones fijando la temperatura actual en ${data.consensus}°C. Te dejamos el panorama para hoy:`,
    `📊 METEO REPORTE | ${data.location.name}\n\nDatos frescos de las ${currentHour} hs. Pasamos por el colador analítico los sensores meteorológicos: temperatura actual de ${data.consensus}°C. Mirá la proyección del día:`
  ];

  const outros = [
    `\n\n💻 Datos procesados en tiempo real por Central de Clima.\n\n#Clima #${cleanCityName} #Meteorologia #Agro #ConsensoClimatico`,
    `\n\n🚀 Monitoreo continuo automatizado por Central de Clima.\n\n#Tiempo #${cleanCityName} #Agrotecnologia #DataScience #ClimaHoy`,
    `\n\n🌾 Optimización de datos meteorológicos de precisión.\n\n#Meteorologia #${cleanCityName} #CampoArgentino #SmartFarming #Consenso`
  ];

  const dayIndex = new Date().getDate();
  const intro = intros[dayIndex % intros.length];
  const outro = outros[dayIndex % outros.length];

  // Configuración dinámica de estaciones reales (REM / METAR)
  let groundTruthText = `• ${data.observation.metar.station || 'Estación Cercana'}: ${data.observation.metar.temp ?? '--'}°C (${data.observation.metar.note || 'Activa'})`;
  if (data.observation.rem && data.observation.rem.temp !== null && data.observation.rem.visible !== false) {
    groundTruthText = `• ${data.observation.rem.station} (REM ID: ${data.observation.rem.stationId}): ${data.observation.rem.temp}°C\n• METAR Cercano: ${data.observation.metar.temp ?? '--'}°C`;
  }

  // Estructura del cuerpo: Primero el pronóstico general, luego el análisis técnico del momento
  const body = `
🔮 Pronóstico para hoy:
• Tendencia general: ${dayCondition}
• Mínima esperada: ${minTemp}
• Máxima proyectada: ${maxTemp}

🤖 Modelos de simulación (a las ${currentHour} hs):
• Promedio de modelos: ${data.models.average}°C
• Desviación analizada: Confianza ${data.confidence.toUpperCase()}

📡 Verdad Terrestre (Sensores Físicos):
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

// --- HANDLER PRINCIPAL ---
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

    // Llamada blindada a la REM San Luis
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