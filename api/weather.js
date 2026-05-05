export default async function handler(req, res) {

  const city = (req.query.city || "").toLowerCase();
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const CHECKWX_KEY = process.env.CHECKWX_KEY;

  try {

    // -------------------------
    // GEO
    // -------------------------
    let baseLat = latQuery ? parseFloat(latQuery) : null;
    let baseLon = lonQuery ? parseFloat(lonQuery) : null;

    if (!baseLat || !baseLon) {
      const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${city}&count=1`
      );
      const geoData = await geoRes.json();

      baseLat = geoData?.results?.[0]?.latitude;
      baseLon = geoData?.results?.[0]?.longitude;
    }

    if (!baseLat || !baseLon) throw new Error("Sin ubicación");

    // -------------------------
    // MODELOS
    // -------------------------
    const models = {};

    const owRes = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=${baseLat}&lon=${baseLon}&units=metric&appid=${OPENWEATHER_KEY}`
    );
    const owData = await owRes.json();

    models.openweather = {
      temp: owData.main?.temp ?? null,
      status: owRes.ok ? "ok" : "error"
    };

    const omRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`
    );
    const omData = await omRes.json();

    models.openmeteo = {
      temp: omData.current_weather?.temperature ?? null,
      status: "ok"
    };

    const temps = Object.values(models).map(s => s.temp).filter(t => t != null);
    const avg = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;

    // -------------------------
    // METAR (FIX REAL)
    // -------------------------
    let metar = { temp: null, station: "Sin datos", status: "nodata" };

    function getDistanceKm(lat1, lon1, lat2, lon2) {
      const dLat = lat1 - lat2;
      const dLon = lon1 - lon2;
      return Math.sqrt(dLat*dLat + dLon*dLon) * 111;
    }

    try {
      const r = await fetch(
        `https://api.checkwx.com/metar/lat/${baseLat}/lon/${baseLon}/radius/300/decoded`,
        { headers: { "X-API-Key": CHECKWX_KEY } }
      );

      if (r.ok) {
        const d = await r.json();

        let closest = null;
        let minDist = Infinity;

        for (const st of d.data || []) {

          const lat = st.geometry?.coordinates?.[1];
          const lon = st.geometry?.coordinates?.[0];

          if (!lat || !lon) continue;

          const dist = getDistanceKm(baseLat, baseLon, lat, lon);

          if (dist < minDist) {
            minDist = dist;
            closest = st;
          }
        }

        if (closest) {
          metar = {
            temp: closest.temperature?.celsius ?? null,
            station: `${closest.station?.name || ""} (${closest.icao})`,
            status: "ok"
          };
        }
      }

    } catch {}

    // -------------------------
    // SMN (igual que antes)
    // -------------------------
    let smn = { temp: null, station: "Sin datos", status: "nodata" };

    try {
      const r = await fetch("https://ws.smn.gob.ar/map_items/weather");
      const data = await r.json();

      const now = Date.now() / 1000;

      let closest = null;
      let minDist = Infinity;

      for (const st of data) {
        const lat = parseFloat(st.lat);
        const lon = parseFloat(st.lon);
        const temp = st.weather?.temp;

        if (!lat || !lon || temp == null) continue;

        if (st.updated && (now - st.updated > 7200)) continue;

        const dist = getDistanceKm(baseLat, baseLon, lat, lon);

        if (dist < minDist) {
          minDist = dist;
          closest = st;
        }
      }

      if (closest) {
        smn = {
          temp: closest.weather.temp,
          station: `${closest.name} (${closest.province})`,
          status: "ok"
        };
      }

    } catch {}

    // -------------------------
    // CONSENSO
    // -------------------------
    let consensus = avg;

    if (metar.temp != null) consensus = metar.temp;
    else if (smn.temp != null) consensus = smn.temp;

    res.setHeader("Content-Type", "application/json; charset=utf-8");

    res.status(200).json({
      consensus: consensus ? Number(consensus.toFixed(1)) : null,
      confidence: metar.temp ? "alta" : "media",
      models: { average: avg ? avg.toFixed(1) : null, sources: models },
      observation: { smn, metar }
    });

  } catch (e) {
    res.status(500).json({ error: "Error" });
  }
}