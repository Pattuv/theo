import requests


def location_from_ip():
    r = requests.get("https://ipinfo.io/json", timeout=5)
    r.raise_for_status()
    data = r.json()
    return (f"{data.get("city"), data.get("country")}")  

print(location_from_ip())