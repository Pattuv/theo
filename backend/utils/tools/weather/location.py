import requests


def getLocation():
    r = requests.get("https://ipinfo.io/json", timeout=5)
    r.raise_for_status()
    data = r.json()
    city = data.get("city")
    country = data.get("country")
    return f"{city}, {country}"
