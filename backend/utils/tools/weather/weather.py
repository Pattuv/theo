import requests
import openmeteo_requests
import requests_cache
from retry_requests import retry
from .location import getLocation


def getWeather(location_name: str) -> tuple[str, float, str]:
    """
    Resolves a location string and returns (place label, temperature °F, qualitative condition).
    Use ``"local"`` (case-insensitive) to resolve the caller's approximate city/country via IP.
    """
    query = location_name.strip()
    if query.lower() == "local":
        query = getLocation()

    clean_name = query
    if "," in query:
        parts = query.split(",")
        if parts[0].strip():
            clean_name = parts[0].strip()

    geocode_url = "https://geocoding-api.open-meteo.com/v1/search"
    geo_params = {
        "name": clean_name,
        "count": 1,
        "language": "en",
        "format": "json",
    }
    try:
        geo_response = requests.get(geocode_url, params=geo_params).json()
        if "results" not in geo_response or not geo_response["results"]:
            raise ValueError(f"Location '{query}' could not be found.")

        location_data = geo_response["results"][0]
        lat = location_data["latitude"]
        lon = location_data["longitude"]
        nm = (location_data.get("name") or "").strip()
        ct = (location_data.get("country") or "").strip()
        place = f"{nm}, {ct}" if nm and ct else nm or ct or "unknown"
    except ValueError:
        raise
    except Exception as e:
        raise RuntimeError(f"Geocoding failed: {e}") from e

    cache_session = requests_cache.CachedSession(".cache", expire_after=3600)
    retry_session = retry(cache_session, retries=5, backoff_factor=0.2)
    openmeteo = openmeteo_requests.Client(session=retry_session)

    forecast_url = "https://api.open-meteo.com/v1/forecast"
    forecast_params = {
        "latitude": lat,
        "longitude": lon,
        "current": ["temperature_2m", "weather_code"],
        "temperature_unit": "fahrenheit",
    }
    try:
        responses = openmeteo.weather_api(forecast_url, params=forecast_params)
        response = responses[0]
        current = response.Current()
        temp_f = float(current.Variables(0).Value())
        code = int(current.Variables(1).Value())
    except Exception as e:
        raise RuntimeError(f"Weather retrieval failed: {e}") from e

    wmo_codes = {
        0: "clear sky",
        1: "mainly clear",
        2: "partly cloudy",
        3: "overcast",
        45: "foggy",
        48: "depositing rime fog",
        51: "light drizzle",
        53: "moderate drizzle",
        55: "dense drizzle",
        61: "slight rain",
        63: "moderate rain",
        65: "heavy rain",
        66: "light freezing rain",
        67: "heavy freezing rain",
        71: "slight snow fall",
        73: "moderate snow fall",
        75: "heavy snow fall",
        77: "snow grains",
        80: "slight rain showers",
        81: "moderate rain showers",
        82: "violent rain showers",
        85: "slight snow showers",
        86: "heavy snow showers",
        95: "thunderstorm",
        96: "thunderstorm with slight hail",
        99: "thunderstorm with heavy hail",
    }
    qualitative = wmo_codes.get(code, f"conditions unknown (code {code})")

    return place, temp_f, qualitative


if __name__ == "__main__":
    print(getWeather("local"))
    print(getWeather("London, United Kingdom"))