export default async function handler(req, res) {
  const city = req.query.city || null;
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const WEATHERBIT_KEY = process.env.WEATHERBIT_KEY;

  try {
    // -----------------------------
    // 1. OpenWeather
    // -----------------------------
    let owTemp = null;
    let owDesc = "";
    let baseLat = null;
    let baseLon = null;

    try {
      let owUrl;

      if (latQuery && lonQuery) {
        owUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${latQuery}&lon=${lonQuery}&units=metric&appid=${OPENWEATHER_KEY}`;
      } else {
        owUrl = `https://api.openweathermap.org/data/2.5/weather?q=${city},AR&units=metric&appid=${OPENWEATHER_KEY}`;
      }

      const owRes = await fetch(owUrl);

      if (owRes.ok) {
        const owData = await owRes.json();

        owTemp = owData.main?.temp ?? null;
        owDesc = owData.weather?.[0]?.description ?? "";

        baseLat = latQuery ? parseFloat(latQuery) : owData.coord?.lat;
        baseLon = lonQuery ? parseFloat(lonQuery) : owData.coord?.lon;
      }

    } catch (e) {
      console.error("OpenWeather error:", e);
    }

    // -----------------------------
    // 2. Weatherbit
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

      // fallback si falla
      if (!wbRes.ok && baseLat && baseLon) {
        wbRes = await fetch(
          `https://api.weatherbit.io/v2.0/current?lat=${baseLat}&lon=${baseLon}&key=${WEATHERBIT_KEY}`
        );
      }

      if (wbRes.ok) {
        const wbData = await wbRes.json();
        wbTemp = wbData?.data?.[0]?.temp ?? null;
        wbDesc = wbData?.data?.[0]?.weather?.description ?? "";
      } else {
        const txt = await wbRes.text();
        console.warn("Weatherbit fallo:", txt);
      }

    } catch (e) {
      console.error("Weatherbit error:", e);
    }

    // -----------------------------
    // 3. OpenMeteo
    // -----------------------------
    let omTemp = null;
    let omDesc = "";

    try {
      if (baseLat && baseLon) {
        const omRes = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`
        );

        if (omRes.ok) {
          const omData = await omRes.json();
          omTemp = omData?.current_weather?.temperature ?? null;
          omDesc = "Modelo OpenMeteo";
        }
      }
    } catch (e) {
      console.error("OpenMeteo error:", e);
    }

    // -----------------------------
    // 4. SMN
    // -----------------------------
    let smnTemp = null;
    let smnDesc = "";

    try {
      const smnRes = await fetch(`https://ws.smn.gob.ar/map_items/weather`);
      const smnData = smnRes.ok ? await smnRes.json() : [];

      function distKm(a, b, c, d) {
        return Math.sqrt((a - c) ** 2 + (b - d) ** 2) * 111;
      }

      let best = null;
      let min = Infinity;

      for (const st of smnData) {
        const lat = parseFloat(st.lat);
        const lon = parseFloat(st.lon);
        const temp = st.weather?.temp;

        if (!lat || !lon || temp == null || !baseLat || !baseLon) continue;

        const d = distKm(baseLat, baseLon, lat, lon);

        if (d < min && d < 200) {
          min = d;
          best = st;
        }
      }

      if (best) {
        smnTemp = best.weather?.temp;
        smnDesc = `${best.name} - ${best.province}`;
      }

    } catch (e) {
      console.error("SMN error:", e);
    }

    // -----------------------------
    // STATUS
    // -----------------------------
    const status = {
      openweather: owTemp != null ? "ok" : "fail",
      weatherbit: wbTemp != null ? "ok" : "fail",
      openmeteo: omTemp != null ? "ok" : "fail",
      smn: smnTemp != null ? "ok" : "fail"
    };

    // -----------------------------
    // CONSENSO SIMPLE
    // -----------------------------
    const temps = [owTemp, wbTemp, omTemp, smnTemp].filter(t => t != null);

    const average = temps.length
      ? (temps.reduce((a, b) => a + b, 0) / temps.length)
      : null;

    const consensus = average ? Number(average.toFixed(1)) : null;

    // -----------------------------
    // RESULT
    // -----------------------------
    res.status(200).json({
      city,
      coord: {
        lat: baseLat,
        lon: baseLon
      },
      sources: {
        openweather: { temp: owTemp, desc: owDesc },
        weatherbit: { temp: wbTemp, desc: wbDesc },
        openmeteo: { temp: omTemp, desc: omDesc },
        smn: { temp: smnTemp, desc: smnDesc }
      },
      status,
      average: average ? average.toFixed(1) : null,
      consensus,
      confidence: temps.length >= 3 ? "alta" : "media",
      note: temps.length < 2 ? "Pocas fuentes disponibles" : ""
    });

  } catch (error) {
    res.status(500).json({
      error: "Error general",
      detail: error.message
    });
  }
}