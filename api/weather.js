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
    // 3. SMN (SELECCIÓN INTELIGENTE)
    // -----------------------------
    const smnRes = await fetch(`https://ws.smn.gob.ar/map_items/weather`);
    const smnData = smnRes.ok ? await smnRes.json() : [];

    const owTemp = owData.main?.temp ?? null;
    const wbTemp = wbData?.data?.[0]?.temp ?? null;

    // promedio base de modelos
    let modelAvg = null;
    if (owTemp != null && wbTemp != null) {
      modelAvg = (owTemp + wbTemp) / 2;
    } else {
      modelAvg = owTemp ?? wbTemp ?? null;
    }

    const normalizedCity = city?.toLowerCase().trim();

    // -----------------------------
    // candidatos por ciudad
    // -----------------------------
    let candidates = smnData
      .map(st => ({
        ...st,
        temp: st.weather?.temp ?? st.temperature ?? st.temp
      }))
      .filter(st =>
        st.temp != null &&
        st.name &&
        normalizedCity &&
        st.name.toLowerCase().includes(normalizedCity)
      );

    // fallback: usar todas
    if (candidates.length === 0) {
      candidates = smnData
        .map(st => ({
          ...st,
          temp: st.weather?.temp ?? st.temperature ?? st.temp
        }))
        .filter(st => st.temp != null);
    }

    // -----------------------------
    // scoring inteligente
    // -----------------------------
    let bestStation = null;
    let bestScore = Infinity;

    for (const st of candidates) {
      let score = 0;

      // 1. diferencia contra modelos (peso fuerte)
      if (modelAvg != null) {
        score += Math.abs(st.temp - modelAvg) * 2;
      }

      // 2. penalizar estaciones automáticas
      if (st.name?.toLowerCase().includes("auto")) {
        score += 2;
      }

      // 3. penalizar datos viejos
      const now = Date.now() / 1000;
      if (st.updated && (now - st.updated > 10800)) {
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
         | 💧 ${bestStation.weather?.humidity ?? "-"}%`
      : "Sin datos SMN";

    console.log("SMN elegida:", bestStation?.name, smnTemp);

    // -----------------------------
    // Resultado base
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
          desc: wbData?.data?.[0]?.weather?.description ?? ""
        },
        smn: {
          temp: smnTemp,
          desc: stationDesc
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
    function diff(a, b) {
      return Math.abs(a - b);
    }

    let consensus = null;
    let confidence = "baja";
    let note = "";

    if (owTemp != null && wbTemp != null) {
      const d = diff(owTemp, wbTemp);

      if (d <= 2) {
        consensus = (owTemp + wbTemp) / 2;
        confidence = "alta";
      } else if (d <= 4) {
        consensus = (owTemp + wbTemp) / 2;
        confidence = "media";
        note = "Diferencia moderada entre modelos";
      } else {
        consensus = owTemp;
        confidence = "baja";
        note = "Alta discrepancia entre modelos";
      }
    }

    if (smnTemp != null && consensus != null) {
      const d = diff(consensus, smnTemp);

      if (d <= 2) {
        consensus = (consensus + smnTemp) / 2;
        confidence = "alta";
        note = "SMN alineado con modelos";
      } else if (d <= 5) {
        confidence = "media";
        note = "SMN cercano con diferencia";
      } else {
        note = "SMN descartado por inconsistencia";
      }
    }

    if (consensus != null) {
      consensus = Number(consensus.toFixed(1));
    }

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