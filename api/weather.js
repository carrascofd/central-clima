export default async function handler(req, res) {

  const city = (req.query.city || "").toLowerCase();
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const CHECKWX_KEY = process.env.CHECKWX_KEY;

  try {

    // -----------------------------
    // 📍 GEO (resolver coordenadas)
    // -----------------------------
    let baseLat = latQuery ? parseFloat(latQuery) : null;
    let baseLon = lonQuery ? parseFloat(lonQuery) : null;

    if (!baseLat || !baseLon) {
      if (!city) throw new Error("Sin ubicación");

      const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${city}&count=1`
      );
      const geoData = await geoRes.json();

      baseLat = geoData?.results?.[0]?.latitude;
      baseLon = geoData?.results?.[0]?.longitude;
    }

    if (!baseLat || !baseLon) {
      throw new Error("No se pudo obtener coordenadas");
    }

    // -----------------------------
    // 🔵 MODELOS
    // -----------------------------
    const models = {};

    // OpenWeather
    try {
      const owRes = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?lat=${baseLat}&lon=${baseLon}&units=metric&appid=${OPENWEATHER_KEY}`
      );
      const owData = await owRes.json();

      models.openweather = {
        temp: owData.main?.temp ?? null,
        status: owRes.ok ? "ok" : "error"
      };

    } catch {
      models.openweather = { temp: null, status: "error" };
    }

    // Open-Meteo
    try {
      const omRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`
      );
      const omData = await omRes.json();

      models.openmeteo = {
        temp: omData.current_weather?.temperature ?? null,
        status: omRes.ok ? "ok" : "error"
      };

    } catch {
      models.openmeteo = { temp: null, status: "error" };
    }

    // MET Norway
    try {
      const metRes = await fetch(
        `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`,
        { headers: { "User-Agent": "central-clima-app" } }
      );
      const metData = await metRes.json();

      const temp =
        metData?.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature;

      models.metno = {
        temp: temp ?? null,
        status: metRes.ok ? "ok" : "error"
      };

    } catch {
      models.metno = { temp: null, status: "error" };
    }

    // -----------------------------
    // 🟢 SMN (validación real)
    // -----------------------------
    let smn = {
      temp: null,
      station: "Sin datos",
      status: "error"
    };

    try {
      const smnRes = await fetch("https://ws.smn.gob.ar/map_items/weather");
      const smnData = await smnRes.json();

      const now = Date.now() / 1000;

      let bestStation = null;
      let minDist = Infinity;

      for (const st of smnData) {

        const stLat = parseFloat(st.lat);
        const stLon = parseFloat(st.lon);
        const temp = st.weather?.temp;
        const updated = st.updated;

        if (
          isNaN(stLat) ||
          isNaN(stLon) ||
          temp == null ||
          !updated
        ) continue;

        // ⛔ descartar si está viejo (>2h)
        if (now - updated > 7200) continue;

        const dist = Math.sqrt(
          Math.pow(baseLat - stLat, 2) +
          Math.pow(baseLon - stLon, 2)
        );

        if (dist < minDist) {
          minDist = dist;
          bestStation = st;
        }
      }

      if (bestStation) {
        smn = {
          temp: bestStation.weather.temp,
          station: `${bestStation.name} (${bestStation.province})`,
          status: "ok"
        };
      } else {
        smn = {
          temp: null,
          station: "Sin datos actualizados",
          status: "error"
        };
      }

    } catch (err) {
      console.error("SMN error:", err);
    }

    // -----------------------------
	// ✈️ METAR (CheckWX ROBUSTO)
	// -----------------------------
	let metar = {
	  temp: null,
	  station: "Sin datos",
	  status: "error"
	};

	try {

	  async function fetchMetar(radius) {
		const url = `https://api.checkwx.com/metar/lat/${baseLat}/lon/${baseLon}/radius/${radius}/decoded`;

		const res = await fetch(url, {
		  headers: { "X-API-Key": process.env.CHECKWX_KEY }
		});

		const text = await res.text();

		console.log("METAR RAW:", text); // 🔥 DEBUG

		if (!res.ok) return null;

		const json = JSON.parse(text);
		return json.data?.[0] ?? null;
	  }

	  // 🔁 intentos progresivos
	  let data =
		await fetchMetar(50) ||
		await fetchMetar(150) ||
		await fetchMetar(300);

	  if (data) {
		metar = {
		  temp: data.temperature?.celsius ?? null,
		  station: data.station?.name ?? data.icao ?? "Aeropuerto",
		  status: "ok"
		};
	  } else {
		metar = {
		  temp: null,
		  station: "Sin METAR cercano",
		  status: "nodata"
		};
	  }

	} catch (err) {
	  console.error("METAR ERROR:", err);

	  metar = {
		temp: null,
		station: "Error conexión METAR",
		status: "error"
	  };
	}

    // -----------------------------
    // 📊 CONSOLIDADO
    // -----------------------------
    const temps = Object.values(models)
      .map(s => s.temp)
      .filter(t => t != null);

    const average = temps.length
      ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1)
      : null;

    const consensus = average ? Number(average) : null;

    // -----------------------------
    // RESPUESTA UTF-8 SEGURA
    // -----------------------------
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    res.status(200).send(JSON.stringify({
      consensus,
      confidence: temps.length >= 2 ? "alta" : "media",

      models: {
        average,
        sources: models
      },

      observation: {
        smn,
        metar
      },

      extra: {
        meteostat: {
          desc: "Histórico disponible"
        }
      }
    }));

  } catch (error) {
    console.error("ERROR GENERAL:", error);

    res.status(500).send(JSON.stringify({
      error: "Error obteniendo datos"
    }));
  }
}