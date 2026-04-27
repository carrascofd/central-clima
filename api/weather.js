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

    const lat = owData.coord?.lat;
    const lon = owData.coord?.lon;

    // -----------------------------
    // 2. Weatherbit
    // -----------------------------
    const wbRes = await fetch(
      `https://api.weatherbit.io/v2.0/current?city=${city}&country=AR&key=${WEATHERBIT_KEY}`
    );

    const wbData = wbRes.ok ? await wbRes.json() : null;

    // -----------------------------
    // 3. SMN
    // -----------------------------
    const smnRes = await fetch(
      `https://ws.smn.gob.ar/map_items/weather`
    );

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

	  const distance = getDistance(lat, lon, stLat, stLon);

	  if (distance < minDistance) {
		minDistance = distance;
		closestStation = {
		  ...station,
		  temp
		};
	  }
	}

	const smnTemp = closestStation?.temp ?? null;

    console.log("SMN estación elegida:", closestStation?.name);
	console.log("SMN SAMPLE:", smnData.slice(0, 3));

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
          desc: closestStation
            ? `SMN estación: ${closestStation.name}`
            : "Sin datos SMN",
          distance: minDistance !== Infinity ? minDistance : null
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

    res.status(200).json(result);

  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "Error obteniendo datos",
      detail: error.message
    });
  }
}