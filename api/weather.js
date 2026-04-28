export default async function handler(req, res) {
  const city = req.query.city;
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const WEATHERBIT_KEY = process.env.WEATHERBIT_KEY;

  try {
    // -----------------------------
    // 1. OPENWEATHER
    // -----------------------------
    let ow = { temp: null, desc: "", status: "error", error: null };
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

      if (!owRes.ok) throw new Error("HTTP error");

      const owData = await owRes.json();

      ow = {
        temp: owData.main?.temp ?? null,
        desc: owData.weather?.[0]?.description ?? "",
        status: "ok",
        error: null
      };

      baseLat = latQuery ? parseFloat(latQuery) : owData.coord?.lat;
      baseLon = lonQuery ? parseFloat(lonQuery) : owData.coord?.lon;

    } catch (err) {
      ow.error = err.message;
    }

    // -----------------------------
    // 2. WEATHERBIT
    // -----------------------------
    let wb = { temp: null, desc: "", status: "error", error: null };

    try {
      let wbUrl = `https://api.weatherbit.io/v2.0/current?city=${city}&country=AR&key=${WEATHERBIT_KEY}`;
      let wbRes = await fetch(wbUrl);

      if (wbRes.status === 429) {
        wb.status = "limit";
        wb.error = "Rate limit exceeded";
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
            desc: wbData.data[0].weather?.description ?? "",
            status: "ok",
            error: null
          };
        } else {
          wb.error = "No data";
        }
      }

    } catch (err) {
      wb.error = err.message;
    }

    // -----------------------------
    // 3. OPEN-METEO (SIN API KEY)
    // -----------------------------
    let om = { temp: null, desc: "", status: "error", error: null };

    try {
      if (baseLat && baseLon) {
        const omRes = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`
        );

        if (omRes.ok) {
          const omData = await omRes.json();

          om = {
            temp: omData.current_weather?.temperature ?? null,
            desc: "Open-Meteo",
            status: "ok",
            error: null
          };
        }
      } else {
        om.error = "Sin coordenadas";
      }

    } catch (err) {
      om.error = err.message;
    }

    // -----------------------------
    // 4. METEOSTAT (simulado vía Open-Meteo fallback)
    // -----------------------------
    let ms = { temp: null, desc: "", status: "error", error: null };

    try {
      if (baseLat && baseLon) {
        const msRes = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&hourly=temperature_2m`
        );

        if (msRes.ok) {
          const msData = await msRes.json();

          ms = {
            temp: msData.hourly?.temperature_2m?.[0] ?? null,
            desc: "Meteostat-like",
            status: "ok",
            error: null
          };
        }
      }

    } catch (err) {
      ms.error = err.message;
    }

    // -----------------------------
    // 5. SMN (tu lógica actual)
    // -----------------------------
    let smn = { temp: null, desc: "", status: "error", error: null };

    try {
      const smnRes = await fetch(`https://ws.smn.gob.ar/map_items/weather`);
      const smnData = smnRes.ok ? await smnRes.json() : [];

      function getDistanceKm(lat1, lon1, lat2, lon2) {
        const dLat = lat1 - lat2;
        const dLon = lon1 - lon2;
        return Math.sqrt(dLat * dLat + dLon * dLon) * 111;
      }

      let bestStation = null;
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
          bestStation = { ...st, temp, distance: dist };
        }
      }

      if (bestStation) {
        smn = {
          temp: bestStation.temp,
          desc: `${bestStation.name} (${bestStation.distance.toFixed(1)} km)`,
          status: "ok",
          error: null
        };
      }

    } catch (err) {
      smn.error = err.message;
    }

    // -----------------------------
    // CONSOLIDADO
    // -----------------------------
    const sources = {
      openweather: ow,
      weatherbit: wb,
      openmeteo: om,
      meteostat: ms,
      smn: smn
    };

    const temps = Object.values(sources)
      .filter(s => s.status === "ok" && s.temp != null)
      .map(s => s.temp);

    const average = temps.length
      ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1)
      : null;

    res.status(200).json({
      city,
      sources,
      average
    });

  } catch (error) {
    res.status(500).json({
      error: "Error general",
      detail: error.message
    });
  }
}