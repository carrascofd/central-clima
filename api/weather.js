export default async function handler(req, res) {
  const city = (req.query.city || "").toLowerCase();
  const lat = req.query.lat;
  const lon = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const CHECKWX_KEY = process.env.CHECKWX_KEY;

  try {

    // -----------------------------
    // OPENWEATHER
    // -----------------------------
    const owUrl = lat && lon
      ? `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${OPENWEATHER_KEY}`
      : `https://api.openweathermap.org/data/2.5/weather?q=${city},AR&units=metric&appid=${OPENWEATHER_KEY}`;

    const owRes = await fetch(owUrl);
    const owData = await owRes.json();

    const owTemp = owData.main?.temp ?? null;

    const baseLat = lat || owData.coord?.lat;
    const baseLon = lon || owData.coord?.lon;

    // -----------------------------
    // OPEN-METEO
    // -----------------------------
    let omTemp = null;

    if (baseLat && baseLon) {
      const omRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`
      );
      const omData = await omRes.json();
      omTemp = omData.current_weather?.temperature ?? null;
    }

    // -----------------------------
    // MET Norway
    // -----------------------------
    let metnoTemp = null;

    if (baseLat && baseLon) {
      const metnoRes = await fetch(
        `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`,
        { headers: { "User-Agent": "central-clima-app" } }
      );

      const metnoData = await metnoRes.json();
      metnoTemp =
        metnoData.properties?.timeseries?.[0]?.data?.instant?.details?.air_temperature ?? null;
    }

    // -----------------------------
    // SMN (con validación)
    // -----------------------------
    let smnTemp = null;
    let smnStatus = "Sin datos";

    try {
      const smnRes = await fetch("https://ws.smn.gob.ar/map_items/weather");
      const smnData = await smnRes.json();

      const station = smnData.find(s =>
        s.name?.toLowerCase().includes(city)
      );

      if (station) {
        const updated = station.updated;
        const now = Date.now() / 1000;

        if (updated && now - updated < 7200) {
          smnTemp = station.weather?.temp ?? null;
          smnStatus = "ok";
        } else {
          smnStatus = "Datos desactualizados";
        }
      }

    } catch {
      smnStatus = "Error";
    }

    // -----------------------------
	// ✈️ METAR (CheckWX por coordenadas)
	// -----------------------------
	let metarTemp = null;
	let metarStatus = "Sin datos METAR";
	let metarStation = "";

	try {

	  let metarUrl;

	  if (baseLat && baseLon) {
		// 🔥 USAR COORDENADAS (MEJOR OPCIÓN)
		metarUrl = `https://api.checkwx.com/metar/lat/${baseLat}/lon/${baseLon}/radius/50/decoded`;
	  } else if (city) {
		// fallback ciudad → ICAO map
		const ICAO_MAP = {
		  "buenos aires": "SAEZ",
		  "cordoba": "SACO",
		  "rosario": "SAAR",
		  "mendoza": "SAME",
		  "san luis": "SAOU",
		  "resistencia": "SARE",
		  "formosa": "SARF"
		};

		const icao = ICAO_MAP[city];

		if (icao) {
		  metarUrl = `https://api.checkwx.com/metar/${icao}/decoded`;
		}
	  }

	  if (metarUrl) {
		const metarRes = await fetch(metarUrl, {
		  headers: {
			"X-API-Key": process.env.CHECKWX_KEY
		  }
		});

		const metarData = await metarRes.json();

		const data = metarData.data?.[0];

		if (data) {
		  metarTemp = data.temperature?.celsius ?? null;
		  metarStation = data.station?.name ?? data.icao ?? "";
		  metarStatus = "ok";
		} else {
		  metarStatus = "Sin estación cercana";
		}
	  }

	} catch (err) {
	  console.error("METAR error:", err);
	  metarStatus = "Error METAR";
	}

    // -----------------------------
    // CONSOLIDADO
    // -----------------------------
    const modelTemps = [owTemp, omTemp, metnoTemp].filter(t => t != null);
    const avg =
      modelTemps.length > 0
        ? modelTemps.reduce((a, b) => a + b, 0) / modelTemps.length
        : null;

    const result = {
      consensus: avg ? avg.toFixed(1) : null,
      confidence: modelTemps.length >= 3 ? "alta" : "media",

      models: {
        average: avg?.toFixed(1),
        sources: {
          openweather: { temp: owTemp },
          openmeteo: { temp: omTemp },
          metno: { temp: metnoTemp }
        }
      },

      observation: {
        smn: {
          temp: smnTemp,
          status: smnStatus
        },
        metar: {
		  temp: metarTemp,
		  station: metarStation,
		  status: metarStatus
		}
      },

      extra: {
        meteostat: {
          desc: "Histórico disponible"
        }
      }
    };

    res.status(200).json(result);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}