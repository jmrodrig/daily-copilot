import urllib.request
import json
url = "https://www.ebay.co.uk/itm/327380232031"
req = urllib.request.Request(f'https://api.microlink.io?url={urllib.parse.quote(url)}')
try:
    with urllib.request.urlopen(req, timeout=5) as res:
        data = json.loads(res.read().decode('utf-8'))
        print("Microlink Title:", data['data']['title'])
except Exception as e:
    print("Error:", e)
