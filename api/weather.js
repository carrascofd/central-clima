export default async function handler(req, res) {
  const city = req.query.city;
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const WEATHERBIT_KEY = process.env.WEATHERBIT_KEY;

  try {
    // -----------------------------
    // 1. OpenWeather
    // -----------------------------
    let owUrl;

	if (latQuery && lonQuery) {
	  owUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${latQuery}&lon=${lonQuery}&units=metric&appid=${OPENWEATHER_KEY}`;
	} else {
	  owUrl = `https://api.openweathermap.org/data/2.5/weather?q=${city},AR&units=metric&appid=${OPENWEATHER_KEY}`;
	}

	const owRes = await fetch(owUrl);

    if (!owRes.ok) {
      throw new Error("Error en OpenWeather");
    }

    const owData = await owRes.json();
/*
    const lat = owData.coord?.lat;
    const lon = owData.coord?.lon;
*/

    // -----------------------------
    // 2. Weatherbit
    // -----------------------------
    let wbUrl;

	if (latQuery && lonQuery) {
	  wbUrl = `https://api.weatherbit.io/v2.0/current?lat=${latQuery}&lon=${lonQuery}&key=${WEATHERBIT_KEY}`;
	} else {
	  wbUrl = `https://api.weatherbit.io/v2.0/current?city=${city}&country=AR&key=${WEATHERBIT_KEY}`;
	}

	const wbRes = await fetch(wbUrl);

    const wbData = wbRes.ok ? await wbRes.json() : null;

    // -----------------------------
    // 3. SMN
    // -----------------------------
    const smnRes = await fetch(
      `https://ws.smn.gob.ar/map_items/weather`
    );

	const baseLat = latQuery ? parseFloat(latQuery) : owData.coord?.lat;
	const baseLon = lonQuery ? parseFloat(lonQuery) : owData.coord?.lon;
    const smnData = smnRes.ok ? await smnRes.json() : [];

    // -----------------------------
    // Función distancia
    // -----------------------------
    function getDistance(lat1, lon1, lat2, lon2) {
      const dLat = lat1 - lat2;
      const dLon = lon1 - lon2;
      return Math.sqrt(dLat * dLat + dLon * dLon);
    }

    // -----------------------------
    // Buscar estación más cercana
    // -----------------------------
    let closestStation = null;
	let minDistance = Infinity;

	for (const station of smnData) {
	  const stLat = parseFloat(station.lat ?? station.latitud);
	  const stLon = parseFloat(station.lon ?? station.longitud);

	  const temp =
		station.weather?.temp ??
		station.temperature ??
		station.temp;

	  if (
		isNaN(stLat) ||
		isNaN(stLon) ||
		temp == null
	  ) continue;

	  const updated = station.updated; // timestamp
	  const now = Date.now() / 1000;

	  // descartar datos viejos (> 3 horas)
	  if (now - updated > 10800) continue;

	  const distance = getDistance(baseLat, baseLon, stLat, stLon);
	  const distanceKm = distance * 111;

	  if (distanceKm > 100) continue; // descarta estaciones lejanas

	  if (distance < minDistance) {
		minDistance = distance;
		closestStation = {
		  ...station,
		  temp
		};
	  }
	}

	const smnTemp = closestStation?.temp ?? null;

    const stationDesc = closestStation
	  ? `${closestStation.name} - ${closestStation.province}
		 | Viento: ${closestStation.weather?.wind_speed ?? "-"} km/h
		 | Humedad: ${closestStation.weather?.humidity ?? "-"}%`
	  : "Sin datos SMN";

    // -----------------------------
    // Resultado final
    // -----------------------------
    const result = {
      city,
      sources: {
        openweather: {
          temp: owData.main?.temp ?? null,
          desc: owData.weather?.[0]?.description ?? ""
        },
        weatherbit: {
          temp: wbData?.data?.[0]?.temp ?? null,
          desc: wbData?.data?.[0]?.weather?.description ?? ""
        },
        smn: {
		  temp: smnTemp,
		  desc: stationDesc,
		  distance: minDistance !== Infinity ? minDistance * 111 : null
		}
      }
    };
	
    // -----------------------------
    // Promedio
    // -----------------------------
    const temps = Object.values(result.sources)
      .map(s => s.temp)
      .filter(t => t != null);

    result.average = temps.length
      ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1)
      : null;
	
	// -----------------------------
	// CONSENSO INTELIGENTE
	// -----------------------------

	const ow = result.sources.openweather.temp;
	const wb = result.sources.weatherbit.temp;
	const smn = result.sources.smn.temp;
	const smnDistance = result.sources.smn.distance;

	// helper
	function diff(a, b) {
	  return Math.abs(a - b);
	}

	// lista de fuentes válidas
	let values = [];

	if (ow != null) values.push({ name: "ow", value: ow });
	if (wb != null) values.push({ name: "wb", value: wb });
	if (smn != null) values.push({ name: "smn", value: smn });

	// -----------------------------
	// 1. Detectar consenso base (OW + WB)
	// -----------------------------
	let consensus = null;
	let confidence = "baja";
	let note = "";

	if (ow != null && wb != null) {
	  const diffOWWB = diff(ow, wb);

	  if (diffOWWB <= 2) {
		consensus = (ow + wb) / 2;
		confidence = "alta";
	  } else if (diffOWWB <= 4) {
		consensus = (ow + wb) / 2;
		confidence = "media";
		note = "Diferencia moderada entre modelos";
	  } else {
		consensus = ow; // fallback
		confidence = "baja";
		note = "Alta discrepancia entre modelos";
	  }
	}

	// -----------------------------
	// 2. Evaluar SMN (dato real)
	// -----------------------------
	if (smn != null) {
	  const closeEnough = smnDistance != null && smnDistance < 50; // km aprox

	  if (consensus != null) {
		const diffSMN = diff(consensus, smn);

		if (closeEnough && diffSMN <= 2) {
		  // SMN confiable → lo incluimos
		  consensus = (consensus + smn) / 2;
		  confidence = "alta";
		  note = "SMN alineado con modelos";
		} else if (closeEnough && diffSMN <= 5) {
		  confidence = "media";
		  note = "SMN cercano con diferencia moderada";
		} else {
		  note = "SMN descartado por diferencia alta o lejanía";
		}
	  } else {
		// solo SMN disponible
		consensus = smn;
		confidence = "media";
		note = "Solo SMN disponible";
	  }
	}

	// -----------------------------
	// 3. Redondeo final
	// -----------------------------
	if (consensus != null) {
	  consensus = Number(consensus.toFixed(1));
	}
	
	if (smn != null && consensus != null) {
	  if (Math.abs(smn - consensus) > 5 && !note.includes("SMN")) {
		note += " | SMN inconsistente";
	  }
	}

	// -----------------------------
	// 4. Agregar al resultado
	// -----------------------------
	result.consensus = consensus;
	result.confidence = confidence;
	result.note = note;
	
    res.status(200).json(result);

  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "Error obteniendo datos",
      detail: error.message
    });
  }
}