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
    if (!owRes.ok) throw new Error("Error en OpenWeather");

    const owData = await owRes.json();

    const baseLat = latQuery
      ? parseFloat(latQuery)
      : owData.coord?.lat;

    const baseLon = lonQuery
      ? parseFloat(lonQuery)
      : owData.coord?.lon;

    const owTemp = owData.main?.temp ?? null;

    // -----------------------------
    // 2. Weatherbit (ROBUSTO)
    // -----------------------------
    let wbTemp = null;
    let wbDesc = "";

    try {
      let wbUrl;

      if (latQuery && lonQuery) {
        wbUrl = `https://api.weatherbit.io/v2.0/current?lat=${latQuery}&lon=${lonQuery}&key=${WEATHERBIT_KEY}`;
      } else {
        wbUrl = `https://api.weatherbit.io/v2.0/current?city=${city}&country=AR&key=${WEATHERBIT_KEY}`;
      }

      let wbRes = await fetch(wbUrl);

      // fallback a coordenadas si falla por ciudad
      if (!wbRes.ok && owData.coord) {
        const fallbackUrl = `https://api.weatherbit.io/v2.0/current?lat=${owData.coord.lat}&lon=${owData.coord.lon}&key=${WEATHERBIT_KEY}`;
        wbRes = await fetch(fallbackUrl);
      }

      if (wbRes.ok) {
        const wbData = await wbRes.json();
        wbTemp = wbData?.data?.[0]?.temp ?? null;
        wbDesc = wbData?.data?.[0]?.weather?.description ?? "";
      } else {
        const errText = await wbRes.text();
        console.error("Weatherbit error:", errText);
      }

    } catch (err) {
      console.error("Weatherbit exception:", err);
    }

    // -----------------------------
    // 3. SMN (SELECCIÓN EQUILIBRADA)
    // -----------------------------
    const smnRes = await fetch(`https://ws.smn.gob.ar/map_items/weather`);
    const smnData = smnRes.ok ? await smnRes.json() : [];

    function getDistanceKm(lat1, lon1, lat2, lon2) {
      const dLat = lat1 - lat2;
      const dLon = lon1 - lon2;
      return Math.sqrt(dLat * dLat + dLon * dLon) * 111;
    }

    const modelAvg =
      owTemp != null && wbTemp != null
        ? (owTemp + wbTemp) / 2
        : owTemp ?? wbTemp ?? null;

    const normalizedCity = city?.toLowerCase()?.trim();

    const stations = smnData
      .map(st => ({
        ...st,
        lat: parseFloat(st.lat),
        lon: parseFloat(st.lon),
        temp: st.weather?.temp ?? st.temperature ?? st.temp
      }))
      .filter(st =>
        !isNaN(st.lat) &&
        !isNaN(st.lon) &&
        st.temp != null
      );

    const stationsWithDistance = stations.map(st => ({
      ...st,
      distance:
        baseLat != null && baseLon != null
          ? getDistanceKm(baseLat, baseLon, st.lat, st.lon)
          : Infinity
    }));

    // radio principal
    let nearby = stationsWithDistance.filter(st => st.distance <= 150);

    // fallback
    if (nearby.length === 0) {
      nearby = stationsWithDistance
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 5);
    }

    let bestStation = null;
    let bestScore = Infinity;

    for (const st of nearby) {
      let score = 0;

      // distancia
      score += st.distance * 0.1;

      // match por ciudad
      if (normalizedCity && st.name?.toLowerCase().includes(normalizedCity)) {
        score -= 10;
      }

      // coherencia
      if (modelAvg != null) {
        score += Math.abs(st.temp - modelAvg) * 2;
      }

      // datos viejos
      const now = Date.now() / 1000;
      if (st.updated && now - st.updated > 10800) {
        score += 5;
      }

      if (score < bestScore) {
        bestScore = score;
        bestStation = st;
      }
    }

    const smnTemp = bestStation?.temp ?? null;

    const stationDesc = bestStation
      ? `${bestStation.name} - ${bestStation.province}
         | 🌬 ${bestStation.weather?.wind_speed ?? "-"} km/h
         | 💧 ${bestStation.weather?.humidity ?? "-"}%
         | 📍 ${bestStation.distance?.toFixed(1)} km`
      : "Sin datos SMN";

    console.log("SMN FINAL:", bestStation?.name, smnTemp);

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