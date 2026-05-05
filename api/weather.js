export default async function handler(req, res) {

  const city = req.query.city;
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const CHECKWX_KEY = process.env.CHECKWX_KEY;

  try {

    let baseLat = latQuery ? parseFloat(latQuery) : null;
    let baseLon = lonQuery ? parseFloat(lonQuery) : null;

    let owTemp = null;
    let owDesc = "";

    // =============================
    // OPENWEATHER (igual)
    // =============================
    try {
      let owUrl;

      if (baseLat && baseLon) {
        owUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${baseLat}&lon=${baseLon}&units=metric&appid=${OPENWEATHER_KEY}`;
      } else {
        owUrl = `https://api.openweathermap.org/data/2.5/weather?q=${city},AR&units=metric&appid=${OPENWEATHER_KEY}`;
      }

      const r = await fetch(owUrl);

      if (r.ok) {
        const d = await r.json();

        owTemp = d.main?.temp ?? null;
        owDesc = d.weather?.[0]?.description ?? "";

        if (!baseLat || !baseLon) {
          baseLat = d.coord?.lat;
          baseLon = d.coord?.lon;
        }
      }

    } catch {}

    // =============================
    // OPEN-METEO (igual)
    // =============================
    let omTemp = null;

    try {
      if (baseLat && baseLon) {
        const r = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`
        );

        if (r.ok) {
          const d = await r.json();
          omTemp = d.current_weather?.temperature ?? null;
        }
      }
    } catch {}

    // =============================
    // MET NORWAY (igual)
    // =============================
    let metnoTemp = null;

    try {
      if (baseLat && baseLon) {
        const r = await fetch(
          `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`,
          { headers: { "User-Agent": "clima-app" } }
        );

        if (r.ok) {
          const d = await r.json();

          metnoTemp =
            d.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature ?? null;
        }
      }
    } catch {}

    const modelTemps = [owTemp, omTemp, metnoTemp].filter(v => v != null);
    const modelAvg = modelTemps.length
      ? modelTemps.reduce((a, b) => a + b, 0) / modelTemps.length
      : null;

    // =============================
    // SMN (igual)
    // =============================
    let smnTemp = null;
    let smnDesc = "Sin datos";
    let smnValid = false;

    try {
      const r = await fetch(`https://ws.smn.gob.ar/map_items/weather`);

      if (r.ok) {
        const data = await r.json();

        function dist(a, b, c, d) {
          return Math.sqrt((a - c) ** 2 + (b - d) ** 2) * 111;
        }

        let best = null;
        let min = Infinity;

        for (const st of data) {
          const lat = parseFloat(st.lat);
          const lon = parseFloat(st.lon);
          const temp = st.weather?.temp;

          if (!lat || !lon || temp == null) continue;

          const d = dist(baseLat, baseLon, lat, lon);

          if (d < min) {
            min = d;
            best = st;
          }
        }

        if (best) {
          const now = Date.now() / 1000;

          if (best.updated && (now - best.updated < 7200)) {
            smnTemp = best.weather?.temp;
            smnDesc = `${best.name} (${min.toFixed(1)} km)`;
            smnValid = true;
          } else {
            smnDesc = "Sin datos actualizados";
          }
        }
      }

    } catch {}

    // =============================
    // 🔥 METAR CORRECTO DEFINITIVO
    // =============================
    let metarTemp = null;
    let metarStation = "Sin aeropuerto cercano";

    function getDistanceKm(lat1, lon1, lat2, lon2) {
      return Math.sqrt((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2) * 111;
    }

    // fallback ICAO
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
      let best = null;
      let min = Infinity;

      // ===== 1. BUSCAR POR COORDENADAS =====
      if (baseLat && baseLon) {
        const r = await fetch(
          `https://api.checkwx.com/metar/lat/${baseLat}/lon/${baseLon}/radius/400/decoded`,
          { headers: { "X-API-Key": CHECKWX_KEY } }
        );

        if (r.ok) {
          const d = await r.json();

          for (const st of d.data || []) {

            const lat =
              st.geometry?.coordinates?.[1] ??
              st.station?.location?.latitude;

            const lon =
              st.geometry?.coordinates?.[0] ??
              st.station?.location?.longitude;

            if (!lat || !lon) continue;

            const dist = getDistanceKm(baseLat, baseLon, lat, lon);

            if (dist < min) {
              min = dist;
              best = st;
            }
          }
        }
      }

      // ===== 2. FALLBACK ICAO =====
      if (!best && city) {
        const icao = ICAO_MAP[city.toLowerCase()];

        if (icao) {
          const r2 = await fetch(
            `https://api.checkwx.com/metar/${icao}/decoded`,
            { headers: { "X-API-Key": CHECKWX_KEY } }
          );

          if (r2.ok) {
            const d2 = await r2.json();
            best = d2.data?.[0] ?? null;
          }
        }
      }

      // ===== 3. RESULTADO FINAL =====
      if (best) {
        metarTemp = best.temperature?.celsius ?? null;
        metarStation = `${best.station?.name || ""} (${best.icao})`;
      }

    } catch (err) {
      console.error("METAR error:", err);
    }

    // =============================
    // METEOSTAT (igual)
    // =============================
    let meteostatTemp = null;
    let meteostatDesc = "Sin datos";

    try {
      if (baseLat && baseLon) {
        const r = await fetch(
          `https://meteostat.p.rapidapi.com/point/nearest?lat=${baseLat}&lon=${baseLon}`,
          {
            headers: {
              "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
              "X-RapidAPI-Host": "meteostat.p.rapidapi.com"
            }
          }
        );

        if (r.ok) {
          const d = await r.json();

          if (d.data && d.data.length > 0) {
            const st = d.data[0];
            meteostatTemp = st.temp ?? null;
            meteostatDesc = st.name;
          }
        }
      }
    } catch {}

    // =============================
    // CONSENSO (igual)
    // =============================
    let consensus = modelAvg;

    if (smnValid && smnTemp != null) {
      consensus = (consensus + smnTemp) / 2;
    } else if (metarTemp != null) {
      consensus = (consensus + metarTemp) / 2;
    } else if (meteostatTemp != null) {
      consensus = (consensus + meteostatTemp) / 2;
    }

    if (consensus != null) {
      consensus = Number(consensus.toFixed(1));
    }

    // =============================
    // RESULTADO
    // =============================
    res.status(200).json({
      city,
      models: {
        sources: {
          openweather: { temp: owTemp, desc: owDesc },
          openmeteo: { temp: omTemp },
          metno: { temp: metnoTemp }
        },
        average: modelAvg != null ? modelAvg.toFixed(1) : null
      },
      observation: {
        smn: { temp: smnTemp, desc: smnDesc, valid: smnValid },
        metar: { temp: metarTemp, station: metarStation },
        meteostat: { temp: meteostatTemp, desc: meteostatDesc }
      },
      consensus
    });

  } catch (error) {
    res.status(500).json({ error: "Error general" });
  }
}