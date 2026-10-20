#!/usr/bin/env python3
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

USERNAME = "abdulkareemakn"
API = "https://api.github.com/search"


def search_count(endpoint, query):
    url = f"{API}/{endpoint}?{urlencode({'q': query, 'per_page': 1})}"
    request = Request(url, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urlopen(request) as response:
        return json.load(response)["total_count"]


since = (datetime.now(timezone.utc) - timedelta(days=365)).date().isoformat()
commits = search_count("commits", f"author:{USERNAME} committer-date:>={since}")
pull_requests = search_count("issues", f"author:{USERNAME} is:pr")

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100" viewBox="0 0 400 100" role="img" aria-labelledby="title desc">
  <title id="title">GitHub activity</title>
  <desc id="desc">{commits} commits in the past year and {pull_requests} pull requests</desc>
  <rect width="400" height="100" rx="8" fill="#f6f8fa" stroke="#d0d7de"/>
  <g fill="#1f2328" font-family="Arial, sans-serif">
    <text x="32" y="48" font-size="28" font-weight="700">{commits}</text>
    <text x="32" y="72" font-size="13">commits in the past year</text>
    <text x="230" y="48" font-size="28" font-weight="700">{pull_requests}</text>
    <text x="230" y="72" font-size="13">pull requests</text>
  </g>
</svg>
'''
Path("profile/stats.svg").write_text(svg, encoding="utf-8")
