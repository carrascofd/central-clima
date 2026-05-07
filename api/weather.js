export default async function handler(req, res) {

  const city = req.query.city;
  const latQuery = req.query.lat;
  const lonQuery = req.query.lon;

  const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;
  const CHECKWX_KEY = process.env.CHECKWX_KEY;

  try {

    // =====================================================
    // GEO BASE
    // =====================================================

    let baseLat = latQuery ? parseFloat(latQuery) : null;
    let baseLon = lonQuery ? parseFloat(lonQuery) : null;

    // 🌍 Geocoding GLOBAL
    if (!baseLat || !baseLon) {

      const geoRes = await fetch(
        `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${OPENWEATHER_KEY}`
      );

      const geoData = await geoRes.json();

      if (!geoData?.length) {
        return res.status(404).json({
          error: "Ciudad no encontrada"
        });
      }

      baseLat = geoData[0].lat;
      baseLon = geoData[0].lon;
    }

    // =====================================================
    // 🔵 OPENWEATHER
    // =====================================================

    const owRes = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=${baseLat}&lon=${baseLon}&units=metric&appid=${OPENWEATHER_KEY}`
    );

    const owData = owRes.ok
      ? await owRes.json()
      : null;

    // =====================================================
    // 🔵 OPEN-METEO
    // =====================================================

    const omRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${baseLat}&longitude=${baseLon}&current_weather=true`
    );

    const omData = omRes.ok
      ? await omRes.json()
      : null;

    // =====================================================
    // 🔵 MET NORWAY
    // =====================================================

    const metRes = await fetch(
      `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${baseLat}&lon=${baseLon}`,
      {
        headers: {
          "User-Agent": "central-clima"
        }
      }
    );

    const metData = metRes.ok
      ? await metRes.json()
      : null;

    // =====================================================
    // MODELOS
    // =====================================================

    const models = {

      sources: {

        openweather: {

          temp: owData?.main?.temp ?? null,
          humidity: owData?.main?.humidity ?? null,
          wind: owData?.wind?.speed ?? null,
          desc: owData?.weather?.[0]?.description ?? ""

        },

        openmeteo: {

          temp: omData?.current_weather?.temperature ?? null,
          wind: omData?.current_weather?.windspeed ?? null,
          desc: "Open-Meteo"

        },

        metno: {

          temp:
            metData?.properties?.timeseries?.[0]
              ?.data?.instant?.details?.air_temperature ?? null,

          humidity:
            metData?.properties?.timeseries?.[0]
              ?.data?.instant?.details?.relative_humidity ?? null,

          wind:
            metData?.properties?.timeseries?.[0]
              ?.data?.instant?.details?.wind_speed ?? null,

          desc: "MET Norway"

        }

      }

    };

    const modelTemps = Object.values(models.sources)
      .map(s => s.temp)
      .filter(t => t != null);

    models.average = modelTemps.length
      ? (
          modelTemps.reduce((a, b) => a + b, 0)
          / modelTemps.length
        ).toFixed(1)
      : null;

    // =====================================================
    // 🌍 AEROPUERTOS
    // =====================================================

    const AIRPORTS = [

      { icao: "SAOU", name: "San Luis", lat: -33.273, lon: -66.356, alt: 700 },
      { icao: "SACO", name: "Cordoba", lat: -31.323, lon: -64.208, alt: 474 },
      { icao: "SAAR", name: "Rosario", lat: -32.903, lon: -60.785, alt: 25 },
      { icao: "SAME", name: "Mendoza", lat: -32.831, lon: -68.792, alt: 704 },
      { icao: "SABE", name: "Aeroparque", lat: -34.559, lon: -58.416, alt: 6 },
      { icao: "SAEZ", name: "Ezeiza", lat: -34.822, lon: -58.535, alt: 20 },

      // 🌍 Internacionales
      { icao: "CYOW", name: "Ottawa", lat: 45.3225, lon: -75.6692, alt: 114 },
      { icao: "CYYZ", name: "Toronto", lat: 43.6777, lon: -79.6248, alt: 173 },
      { icao: "KJFK", name: "New York", lat: 40.6413, lon: -73.7781, alt: 4 },
      { icao: "KLAX", name: "Los Angeles", lat: 33.9416, lon: -118.4085, alt: 38 },
      { icao: "EGLL", name: "London Heathrow", lat: 51.4700, lon: -0.4543, alt: 25 },
      { icao: "LFPG", name: "Paris CDG", lat: 49.0097, lon: 2.5479, alt: 119 }

    ];

    // =====================================================
    // DISTANCIA REAL
    // =====================================================

    function distanceKm(lat1, lon1, lat2, lon2) {

      const R = 6371;

      const dLat =
        (lat2 - lat1) * Math.PI / 180;

      const dLon =
        (lon2 - lon1) * Math.PI / 180;

      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;

      return R * (
        2 * Math.atan2(
          Math.sqrt(a),
          Math.sqrt(1 - a)
        )
      );
    }

    // =====================================================
    // SELECCIÓN AEROPUERTO
    // =====================================================

    function selectAirport(lat, lon) {

      let best = null;
      let bestScore = Infinity;

      for (const ap of AIRPORTS) {

        const dist = distanceKm(
          lat,
          lon,
          ap.lat,
          ap.lon
        );

        let score = dist;

        score += Math.abs(ap.alt - 500) * 0.01;

        if (score < bestScore) {
          bestScore = score;
          best = ap;
        }
      }

      return best;
    }

    // =====================================================
    // 🟢 METAR REAL
    // =====================================================

    let metar = {

      temp: null,
      station: "Sin datos"

    };

    try {

      const airport =
        selectAirport(baseLat, baseLon);

      if (airport) {

        const metarRes = await fetch(
          `https://api.checkwx.com/metar/${airport.icao}/decoded`,
          {
            headers: {
              "X-API-Key": CHECKWX_KEY
            }
          }
        );

        const metarData =
          await metarRes.json();

        const obs =
          metarData?.data?.[0];

        if (obs) {

          metar = {

            temp:
              obs.temperature?.celsius ?? null,

            station:
              `${airport.name} (${airport.icao})`

          };

        } else {

          metar.station =
            "METAR sin datos";
        }
      }

    } catch (e) {

      metar.station =
        "Error METAR";
    }

    // =====================================================
    // 🟢 METEOSTAT (actual)
    // =====================================================

    let meteostat = {

      temp: null,
      desc: "Sin datos"

    };

    try {

      meteostat = {

        temp:
          omData?.current_weather?.temperature ?? null,

        desc:
          "Dato actual disponible"

      };

    } catch {

      meteostat.desc =
        "Error Meteostat";
    }

    // =====================================================
    // CONSENSO
    // =====================================================

    const allTemps = [

      ...modelTemps,

      metar.temp,

      meteostat.temp

    ].filter(t => t != null);

    const consensus =
      allTemps.length
        ? (
            allTemps.reduce((a, b) => a + b, 0)
            / allTemps.length
          ).toFixed(1)
        : null;

    // =====================================================
    // RESPONSE
    // =====================================================

    const result = {

      consensus,

      confidence:
        allTemps.length >= 4
          ? "alta"
          : "media",

      location: {

        lat: baseLat,
        lon: baseLon

      },

      models,

      observation: {

        metar

      },

      extra: {

        meteostat

      }

    };

    res.status(200).json(result);

  } catch (error) {

    console.error(error);

    res.status(500).json({

      error: "Error backend",
      detail: error.message

    });
  }
}