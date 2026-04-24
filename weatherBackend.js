export default async function handler(req, res) {
  const city = req.query.city || "San Luis";

  const OPENWEATHER_KEY = "TU_API_KEY";
  const WEATHERBIT_KEY = "TU_API_KEY";

  try {
    // OpenWeather
    const owRes = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${city},AR&units=metric&appid=${80bb3082e67e9526638c99a6e59685fe}`
    );
    const owData = await owRes.json();

    // Weatherbit
    const wbRes = await fetch(
      `https://api.weatherbit.io/v2.0/current?city=${city}&country=AR&key=${f5d5d9cf83ba4fefb37ddb14ec2beb6a}`
    );
    const wbData = await wbRes.json();

    // SMN (ejemplo simple - estaciones)
    const smnRes = await fetch(
      `https://ws.smn.gob.ar/map_items/weather`
    );
    const smnData = await smnRes.json();

    // Buscar estación cercana (simplificado)
    const smnTemp = smnData[0]?.temperature;

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