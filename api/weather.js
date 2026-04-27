export default async function handler(req, res) {
  const city = req.query.city || "San Luis";

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const WEATHERBIT_KEY = process.env.WEATHERBIT_KEY;

  try {
    // OpenWeather
    const owRes = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${city},AR&units=metric&appid=${OPENWEATHER_KEY}`
    );
    const owData = await owRes.json();

    // Weatherbit
    const wbRes = await fetch(
      `https://api.weatherbit.io/v2.0/current?city=${city}&country=AR&key=${WEATHERBIT_KEY}`
    );
    const wbData = await wbRes.json();

    // SMN (ejemplo simple - estaciones)
    const smnRes = await fetch(
      `https://ws.smn.gob.ar/map_items/weather`
    );
    const smnData = await smnRes.json();
	
	const lat = owData.coord?.lat;
	const lon = owData.coord?.lon;
	
	function getDistance(lat1, lon1, lat2, lon2) {
	  const dLat = lat1 - lat2;
	  const dLon = lon1 - lon2;
	  return Math.sqrt(dLat * dLat + dLon * dLon);
	}

    // Buscar estación cercana
    let closestStation = null;
	let minDistance = Infinity;

	for (const station of smnData) {
	  if (!station.lat || !station.lon || !station.temperature) continue;

	  const distance = getDistance(lat, lon, station.lat, station.lon);

	  if (distance < minDistance) {
		minDistance = distance;
		closestStation = station;
	  }
	}

	const smnTemp = closestStation?.temperature;

    const result = {
      city,
      sources: {
        openweather: {
          temp: owData.main?.temp,
          desc: owData.weather?.[0]?.description
        },
        weatherbit: {
          temp: wbData.data?.[0]?.temp,
          desc: wbData.data?.[0]?.weather?.description
        },
        smn: {
          temp: smnTemp
		  desc: "SMN estación elegida: ", closestStation?.name;
        }
      }
    };

    // Promedio
    const temps = Object.values(result.sources)
      .map(s => s.temp)
      .filter(t => t !== undefined);

    result.average = temps.length
      ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1)
      : null;

    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ error: "Error obteniendo datos" });
  }
}