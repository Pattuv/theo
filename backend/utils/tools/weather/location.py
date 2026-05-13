import requests


def getLocation():
    r = requests.get("https://ipinfo.io/json", timeout=5)
    r.raise_for_status()
    data = r.json()
    return (f"{data.get("city"), data.get("country")}")  

#development scaffolding
print(getLocation())