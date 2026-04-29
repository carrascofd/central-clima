export default async function handler(req, res) {
  const city = req.query.city || "San Luis";
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const WEATHERBIT_KEY = process.env.WEATHERBIT_KEY;

  try {
    let baseLat = null;
    let baseLon = null;

    // -----------------------------
    // 1. OPENWEATHER
    // -----------------------------
    let ow = { temp: null, status: "error" };

    try {
      const owUrl =
        latQuery && lonQuery
          ? `https://api.openweathermap.org/data/2.5/weather?lat=${latQuery}&lon=${lonQuery}&units=metric&appid=${OPENWEATHER_KEY}`
          : `https://api.openweathermap.org/data/2.5/weather?q=${city},AR&units=metric&appid=${OPENWEATHER_KEY}`;

      const owRes = await fetch(owUrl);
      const owData = await owRes.json();

      if (owRes.ok) {
        ow = {
          temp: owData.main?.temp ?? null,
          status: "ok"
        };

        baseLat = latQuery ? parseFloat(latQuery) : owData.coord?.lat;
        baseLon = lonQuery ? parseFloat(lonQuery) : owData.coord?.lon;
      }
    } catch {}

    // -----------------------------
    // 2. WEATHERBIT
    // -----------------------------
    let wb = { temp: null, status: "error" };

    try {
      let wbUrl = `https://api.weatherbit.io/v2.0/current?city=${city}&country=AR&key=${WEATHERBIT_KEY}`;
      let wbRes = await fetch(wbUrl);

      if (wbRes.status === 429) {
        wb.status = "limit";
      } else {
        let wbData = wbRes.ok ? await wbRes.json() : null;

        if (!wbData?.data?.[0] && baseLat && baseLon) {
          wbUrl = `https://api.weatherbit.io/v2.0/current?lat=${baseLat}&lon=${baseLon}&key=${WEATHERBIT_KEY}`;
          wbRes = await fetch(wbUrl);
          wbData = wbRes.ok ? await wbRes.json() : null;
        }

        if (wbData?.data?.[0]) {
          wb = {
            temp: wbData.data[0].temp,
            status: "ok"
          };
        }
      }
    } catch {}

    // -----------------------------
    // 3. OPEN-METEO
    // -----------------------------
    let om = { temp: null, status: "error" };

    try {
      if (baseLat && baseLon) {
        const resOm = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`
        );
        const data = await resOm.json();

        om = {
          temp: data.current_weather?.temperature ?? null,
          status: "ok"
        };
      }
    } catch {}

    // -----------------------------
    // 4. SMN (simple estable)
    // -----------------------------
    let smn = { temp: null, status: "error" };

    try {
      const smnRes = await fetch(`https://ws.smn.gob.ar/map_items/weather`);
      const smnData = await smnRes.json();

      function distKm(a, b, c, d) {
        return Math.sqrt((a - c) ** 2 + (b - d) ** 2) * 111;
      }

      let best = null;
      let min = Infinity;

      for (const st of smnData) {
        const lat = parseFloat(st.lat);
        const lon = parseFloat(st.lon);
        const temp = st.weather?.temp;

        if (!lat || !lon || temp == null) continue;

        const d = baseLat && baseLon ? distKm(baseLat, baseLon, lat, lon) : 9999;

        if (d < min) {
          min = d;
          best = { temp, distance: d };
        }
      }

      if (best) {
        smn = {
          temp: best.temp,
          status: "ok",
          distance: best.distance
        };
      }
    } catch {}

    // -----------------------------
    // 🔥 CONSENSO PROFESIONAL
    // -----------------------------

    const sources = {
      openweather: ow,
      weatherbit: wb,
      openmeteo: om,
      smn: smn
    };

    // 1. recolectar válidos
    let values = Object.entries(sources)
      .filter(([_, s]) => s.status === "ok" && s.temp != null)
      .map(([name, s]) => ({ name, value: s.temp }));

    // 2. promedio inicial
    const avg =
      values.reduce((a, b) => a + b.value, 0) / (values.length || 1);

    // 3. desviación
    const variance =
      values.reduce((a, b) => a + Math.pow(b.value - avg, 2), 0) /
      (values.length || 1);

    const std = Math.sqrt(variance);

    // 4. eliminar outliers
    const filtered = values.filter(v => Math.abs(v.value - avg) <= std * 2);

    // marcar descartados
    values.forEach(v => {
      if (!filtered.find(f => f.name === v.name)) {
        sources[v.name].status = "outlier";
      }
    });

    // 5. pesos
    const weights = {
      smn: 1.5,
      openweather: 1.2,
      openmeteo: 1.1,
      weatherbit: 1.0
    };

    // 6. promedio ponderado
    let sum = 0;
    let weightSum = 0;

    filtered.forEach(v => {
      const w = weights[v.name] || 1;
      sum += v.value * w;
      weightSum += w;
    });

    const consensus =
      weightSum > 0 ? Number((sum / weightSum).toFixed(1)) : null;

    // -----------------------------
    // 🔥 CONFIANZA
    // -----------------------------
    let confidence = "baja";
    let confidenceScore = 0;

    if (filtered.length >= 3 && std < 2) {
      confidence = "alta";
      confidenceScore = 90;
    } else if (filtered.length >= 2 && std < 4) {
      confidence = "media";
      confidenceScore = 70;
    } else {
      confidence = "baja";
      confidenceScore = 40;
    }

    // -----------------------------
    // RESPUESTA FINAL
    // -----------------------------
    res.status(200).json({
      city,
      sources,
      consensus,
      confidence,
      confidenceScore
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}