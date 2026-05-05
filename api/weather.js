export default async function handler(req, res) {

  const city = req.query.city;
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const WEATHERBIT_KEY = process.env.WEATHERBIT_KEY;
  const CHECKWX_KEY = process.env.CHECKWX_KEY;

  try {

    // -----------------------------
    // 1. OpenWeather (SIN CAMBIOS)
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
    // 2. Weatherbit (SIN CAMBIOS)
    // -----------------------------
    let wbUrl;

    if (latQuery && lonQuery) {
      wbUrl = `https://api.weatherbit.io/v2.0/current?lat=${latQuery}&lon=${lonQuery}&key=${WEATHERBIT_KEY}`;
    } else {
      wbUrl = `https://api.weatherbit.io/v2.0/current?city=${city}&country=AR&key=${WEATHERBIT_KEY}`;
    }

    const wbRes = await fetch(wbUrl);
    const wbData = wbRes.ok ? await wbRes.json() : null;

    const wbTemp = wbData?.data?.[0]?.temp ?? null;

    const modelAvg =
      owTemp != null && wbTemp != null
        ? (owTemp + wbTemp) / 2
        : owTemp ?? wbTemp ?? null;

    // -----------------------------
    // 3. SMN (SIN CAMBIOS)
    // -----------------------------
    const smnRes = await fetch(`https://ws.smn.gob.ar/map_items/weather`);
    const smnData = smnRes.ok ? await smnRes.json() : [];

    function getDistanceKm(lat1, lon1, lat2, lon2) {
      const dLat = lat1 - lat2;
      const dLon = lon1 - lon2;
      return Math.sqrt(dLat * dLat + dLon * dLon) * 111;
    }

    const stations = smnData
      .map(st => ({
        ...st,
        lat: parseFloat(st.lat),
        lon: parseFloat(st.lon),
        temp: st.weather?.temp
      }))
      .filter(st => !isNaN(st.lat) && !isNaN(st.lon) && st.temp != null);

    let bestStation = null;
    let minDistance = Infinity;

    for (const st of stations) {
      const dist = getDistanceKm(baseLat, baseLon, st.lat, st.lon);

      if (dist < minDistance) {
        minDistance = dist;
        bestStation = st;
      }
    }

    const smnTemp = bestStation?.temp ?? null;

    // =============================
    // 🔥 METAR CORREGIDO (NUEVO)
    // =============================
    let metarTemp = null;
    let metarStation = "Sin aeropuerto cercano";

    // fallback ICAO básico Argentina
    const ICAO_MAP = {
      "san luis": "SAOU",
      "cordoba": "SACO",
      "rosario": "SAAR",
      "buenos aires": "SAEZ",
      "mendoza": "SAME",
      "salta": "SASA",
      "neuquen": "SAZN",
      "resistencia": "SARE",
      "formosa": "SARF"
    };

    try {
      // 1. intento por lat/lon
      const r = await fetch(
        `https://api.checkwx.com/metar/lat/${baseLat}/lon/${baseLon}/radius/300/decoded`,
        { headers: { "X-API-Key": CHECKWX_KEY } }
      );

      if (r.ok) {
        const d = await r.json();

        if (d.data && d.data.length > 0) {
          const st = d.data[0];

          metarTemp = st.temperature?.celsius ?? null;
          metarStation = `${st.station?.name || ""} (${st.icao})`;
        }
      }

      // 2. fallback por ICAO si no hay data
      if (metarTemp == null && city) {
        const icao = ICAO_MAP[city.toLowerCase()];

        if (icao) {
          const r2 = await fetch(
            `https://api.checkwx.com/metar/${icao}/decoded`,
            { headers: { "X-API-Key": CHECKWX_KEY } }
          );

          if (r2.ok) {
            const d2 = await r2.json();

            const st = d2.data?.[0];

            if (st) {
              metarTemp = st.temperature?.celsius ?? null;
              metarStation = `${st.station?.name || ""} (${st.icao})`;
            }
          }
        }
      }

    } catch (err) {
      console.error("METAR error:", err);
    }

    // -----------------------------
    // RESULTADO (SIN CAMBIOS)
    // -----------------------------
    const result = {
      city,
      sources: {
        openweather: { temp: owTemp },
        weatherbit: { temp: wbTemp },
        smn: { temp: smnTemp },
        metar: {
          temp: metarTemp,
          station: metarStation
        }
      }
    };

    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ error: "Error" });
  }
}