export default async function handler(req, res) {

  const city = req.query.city;
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;

  try {

    // -----------------------------
    // 1. OPENWEATHER (fallback + coords)
    // -----------------------------
    let owUrl = latQuery && lonQuery
      ? `https://api.openweathermap.org/data/2.5/weather?lat=${latQuery}&lon=${lonQuery}&units=metric&appid=${OPENWEATHER_KEY}`
      : `https://api.openweathermap.org/data/2.5/weather?q=${city},AR&units=metric&appid=${OPENWEATHER_KEY}`;

    const owRes = await fetch(owUrl);
    if (!owRes.ok) throw new Error("OpenWeather error");

    const owData = await owRes.json();

    const baseLat = latQuery ? parseFloat(latQuery) : owData.coord?.lat;
    const baseLon = lonQuery ? parseFloat(lonQuery) : owData.coord?.lon;

    const owTemp = owData.main?.temp ?? null;

    // -----------------------------
    // 2. OPEN-METEO
    // -----------------------------
    let omTemp = null;

    if (baseLat && baseLon) {
      const omRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current=temperature_2m`
      );

      if (omRes.ok) {
        const omData = await omRes.json();
        omTemp = omData.current?.temperature_2m ?? null;
      }
    }

    // -----------------------------
    // 3. MET.NO
    // -----------------------------
    let metnoTemp = null;

    if (baseLat && baseLon) {
      const metnoRes = await fetch(
        `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`,
        { headers: { "User-Agent": "clima-app" } }
      );

      if (metnoRes.ok) {
        const data = await metnoRes.json();
        metnoTemp =
          data.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature ?? null;
      }
    }

    // -----------------------------
    // 4. SMN (OBSERVACIÓN REAL)
    // -----------------------------
    const smnRes = await fetch(`https://ws.smn.gob.ar/map_items/weather`);
    const smnData = smnRes.ok ? await smnRes.json() : [];

    function distKm(a, b, c, d) {
      return Math.sqrt((a - c) ** 2 + (b - d) ** 2) * 111;
    }

    let bestStation = null;
    let minDist = Infinity;

    for (const st of smnData) {
      const lat = parseFloat(st.lat);
      const lon = parseFloat(st.lon);
      const temp = st.weather?.temp;

      if (!lat || !lon || temp == null) continue;

      const d = distKm(baseLat, baseLon, lat, lon);

      if (d < minDist && d < 150) {
        minDist = d;
        bestStation = st;
      }
    }

    const smnTemp = bestStation?.weather?.temp ?? null;

    // -----------------------------
    // 5. METEOSTAT (placeholder)
    // -----------------------------
    const meteostat = {
      temp: null,
      desc: "Histórico disponible (próximamente)"
    };

    // -----------------------------
    // MODELOS (🔵)
    // -----------------------------
    const models = [
      omTemp,
      metnoTemp,
      owTemp
    ].filter(v => v != null);

    const modelAvg = models.length
      ? models.reduce((a, b) => a + b, 0) / models.length
      : null;

    // -----------------------------
    // CONSENSO FINAL
    // -----------------------------
    let consensus = modelAvg;
    let confidence = "media";

    if (smnTemp != null && modelAvg != null) {
      const diff = Math.abs(smnTemp - modelAvg);

      if (diff <= 2) {
        consensus = (smnTemp + modelAvg) / 2;
        confidence = "alta";
      } else if (diff > 5) {
        confidence = "baja";
      }
    }

    if (consensus != null) {
      consensus = Number(consensus.toFixed(1));
    }

    // -----------------------------
    // RESPONSE
    // -----------------------------
    res.status(200).json({
      city,
      consensus,
      confidence,

      models: {
        average: modelAvg?.toFixed(1),
        sources: {
          openmeteo: { temp: omTemp },
          metno: { temp: metnoTemp },
          openweather: { temp: owTemp }
        }
      },

      observation: {
        smn: {
          temp: smnTemp,
          station: bestStation?.name || null
        }
      },

      extra: {
        meteostat
      }
    });

  } catch (err) {
    res.status(500).json({
      error: "error",
      detail: err.message
    });
  }
}