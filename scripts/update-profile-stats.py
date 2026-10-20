#!/usr/bin/env python3
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

USERNAME = "abdulkareemakn"
API = "https://api.github.com/search"
GRAPHQL = "https://api.github.com/graphql"


def search_count(endpoint, query):
    url = f"{API}/{endpoint}?{urlencode({'q': query, 'per_page': 1})}"
    request = Request(url, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urlopen(request) as response:
        return json.load(response)["total_count"]


def contribution_count(start, end):
    body = json.dumps({
        "query": """
            query($login: String!, $from: DateTime!, $to: DateTime!) {
              user(login: $login) {
                contributionsCollection(from: $from, to: $to) {
                  contributionCalendar { totalContributions }
                }
              }
            }
        """,
        "variables": {
            "login": USERNAME,
            "from": start.isoformat().replace("+00:00", "Z"),
            "to": end.isoformat().replace("+00:00", "Z"),
        },
    }).encode()
    request = Request(GRAPHQL, data=body, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urlopen(request) as response:
        result = json.load(response)
    if "errors" in result:
        raise RuntimeError(result["errors"])
    return result["data"]["user"]["contributionsCollection"]["contributionCalendar"]["totalContributions"]


now = datetime.now(timezone.utc)
since = (now - timedelta(days=365)).date().isoformat()
commits = search_count("commits", f"author:{USERNAME} committer-date:>={since}")
pull_requests = search_count("issues", f"author:{USERNAME} is:pr")
contributions = contribution_count(now - timedelta(days=365), now)

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="520" height="100" viewBox="0 0 520 100" role="img" aria-labelledby="title desc">
  <title id="title">GitHub activity</title>
  <desc id="desc">{commits} commits, {pull_requests} pull requests, and {contributions} contributions in the past year</desc>
  <rect width="520" height="100" rx="8" fill="#f6f8fa" stroke="#d0d7de"/>
  <g fill="#1f2328" font-family="Arial, sans-serif">
    <text x="28" y="48" font-size="28" font-weight="700">{commits}</text>
    <text x="28" y="72" font-size="13">commits (past year)</text>
    <text x="195" y="48" font-size="28" font-weight="700">{pull_requests}</text>
    <text x="195" y="72" font-size="13">pull requests</text>
    <text x="355" y="48" font-size="28" font-weight="700">{contributions}</text>
    <text x="355" y="72" font-size="13">contributions (past year)</text>
  </g>
</svg>
'''
Path("profile/stats.svg").write_text(svg, encoding="utf-8")
