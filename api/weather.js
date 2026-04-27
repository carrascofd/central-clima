export default async function handler(req, res) {
  const city = req.query.city || "San Luis";
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
    if (!owRes.ok) throw new Error("Error en OpenWeather");

    const owData = await owRes.json();

    const baseLat = latQuery ? parseFloat(latQuery) : owData.coord?.lat;
    const baseLon = lonQuery ? parseFloat(lonQuery) : owData.coord?.lon;

    const owTemp = owData.main?.temp ?? null;

    // -----------------------------
    // 2. Weatherbit (VERSIÓN ESTABLE)
    // -----------------------------
    let wbTemp = null;
    let wbDesc = "";

    try {
      // 👉 PRIMERO: por ciudad (como antes)
      let wbUrl = `https://api.weatherbit.io/v2.0/current?city=${city}&country=AR&key=${WEATHERBIT_KEY}`;

      let wbRes = await fetch(wbUrl);
      let wbData = wbRes.ok ? await wbRes.json() : null;

      // 👉 SI FALLA: fallback a coords
      if (!wbData?.data?.[0] && baseLat && baseLon) {
        wbUrl = `https://api.weatherbit.io/v2.0/current?lat=${baseLat}&lon=${baseLon}&key=${WEATHERBIT_KEY}`;
        wbRes = await fetch(wbUrl);
        wbData = wbRes.ok ? await wbRes.json() : null;
      }

      if (wbData?.data?.[0]) {
        wbTemp = wbData.data[0].temp ?? null;
        wbDesc = wbData.data[0].weather?.description ?? "";
      } else {
        console.error("Weatherbit sin datos:", wbData);
      }

    } catch (err) {
      console.error("Weatherbit error:", err);
    }

    // -----------------------------
    // 3. SMN (SIMPLIFICADO Y ESTABLE)
    // -----------------------------
    const smnRes = await fetch(`https://ws.smn.gob.ar/map_items/weather`);
    const smnData = smnRes.ok ? await smnRes.json() : [];

    function getDistanceKm(lat1, lon1, lat2, lon2) {
      const dLat = lat1 - lat2;
      const dLon = lon1 - lon2;
      return Math.sqrt(dLat * dLat + dLon * dLon) * 111;
    }

    let closestStation = null;
    let minDistance = Infinity;

    for (const st of smnData) {
      const lat = parseFloat(st.lat);
      const lon = parseFloat(st.lon);
      const temp = st.weather?.temp ?? st.temperature ?? st.temp;

      if (isNaN(lat) || isNaN(lon) || temp == null) continue;

      const dist =
        baseLat && baseLon
          ? getDistanceKm(baseLat, baseLon, lat, lon)
          : Infinity;

      if (dist < minDistance) {
        minDistance = dist;
        closestStation = { ...st, temp, distance: dist };
      }
    }

    const smnTemp = closestStation?.temp ?? null;

    const stationDesc = closestStation
      ? `${closestStation.name} - ${closestStation.province}
         | 💧 ${closestStation.weather?.humidity ?? "-"}%
         | 📍 ${closestStation.distance?.toFixed(1)} km`
      : "Sin datos SMN";

    // -----------------------------
    // RESULTADO
    // -----------------------------
    const result = {
      city,
      sources: {
        openweather: {
          temp: owTemp,
          desc: owData.weather?.[0]?.description ?? ""
        },
        weatherbit: {
          temp: wbTemp,
          desc: wbDesc
        },
        smn: {
          temp: smnTemp,
          desc: stationDesc
        }
      }
    };

    // promedio
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