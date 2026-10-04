#!/usr/bin/env node
// Collects the live GitHub numbers that appear on the terminal card.
//
// The card itself is printed by the `abdulkareem` package, which ships
// hardcoded figures. Those go stale, so this recomputes them and hands them to
// render-card.mjs, which patches the matching lines.
//
//   node scripts/fetch-stats.mjs > stats.json
//   FORCE_COLOR=3 pnpm dlx abdulkareem | node scripts/render-card.mjs profile/card.svg --stats stats.json
//
// Reads GITHUB_TOKEN from the environment. The public endpoints work without
// one, but at 60 requests an hour, and the line-count rollup needs far more
// than that, so a token is required for --lines.
//
// --lines walks every commit on every default branch, which costs one GraphQL
// request per 100 commits. It is off by default because the daily workflow
// should not pay for it on every run.

const USERNAME = process.env.GITHUB_USER ?? "abdulkareemakn";
const token = process.env.GITHUB_TOKEN;

if (!token) {
  process.stderr.write("warning: GITHUB_TOKEN unset, falling back to unauthenticated limits\n");
}

async function api(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status} ${response.statusText}`);
  return response.json();
}

async function graphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`graphql -> ${response.status} ${response.statusText}`);
  const payload = await response.json();
  if (payload.errors) throw new Error(JSON.stringify(payload.errors));
  return payload.data;
}

/**
 * Owned repositories with their star counts and the number of commits authored
 * on each default branch, which is what the card's Repos and Stars rows report.
 */
async function ownedRepositories(userId) {
  const query = `
    query($login: String!, $author: ID!, $endCursor: String) {
      user(login: $login) {
        repositories(first: 100, after: $endCursor, ownerAffiliations: OWNER, isFork: false) {
          nodes {
            nameWithOwner
            stargazerCount
            defaultBranchRef { target { ... on Commit {
              history(author: {id: $author}) { totalCount }
            } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;

  let cursor = null;
  const nodes = [];

  do {
    const data = await graphql(query, { login: USERNAME, author: userId, endCursor: cursor });
    nodes.push(...data.user.repositories.nodes);
    cursor = data.user.repositories.pageInfo.hasNextPage
      ? data.user.repositories.pageInfo.endCursor
      : null;
  } while (cursor);

  return nodes;
}

async function userId() {
  const data = await graphql(
    `query($login: String!) { user(login: $login) { id } }`,
    { login: USERNAME },
  );
  return data.user.id;
}

/**
 * Repositories the user can see through collaboration or org membership.
 * The card shows this as the "Contributed" figure next to the repo count.
 */
async function contributedCount() {
  let total = 0;
  for (let page = 1; ; page++) {
    const batch = await api(
      `/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=${page}`,
    );
    total += batch.length;
    if (batch.length < 100) return total;
  }
}

async function profile() {
  return api(`/users/${USERNAME}`);
}

/** Additions and deletions across every commit the user authored. */
async function authoredLines(userId, repositories) {
  const query = `
    query($owner: String!, $name: String!, $author: ID!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        defaultBranchRef { target { ... on Commit {
          history(first: 100, after: $endCursor, author: {id: $author}) {
            nodes { author { user { id } } additions deletions }
            pageInfo { hasNextPage endCursor }
          }
        } } }
      }
    }
  `;

  let commits = 0;
  let additions = 0;
  let deletions = 0;

  for (const { nameWithOwner } of repositories) {
    const [owner, name] = nameWithOwner.split("/");
    let cursor = null;
    do {
      const data = await graphql(query, { owner, name, author: userId, endCursor: cursor });
      const history = data.repository?.defaultBranchRef?.target?.history;
      if (!history) break;
      for (const commit of history.nodes) {
        // history(author:) already filters, but the node is nullable when the
        // commit has no linked account, so the guard is load-bearing.
        if (commit.author?.user?.id !== userId) continue;
        commits += 1;
        additions += commit.additions;
        deletions += commit.deletions;
      }
      cursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    } while (cursor);
  }

  return { commits, additions, deletions };
}

const id = await userId();
const [account, owned] = await Promise.all([profile(), ownedRepositories(id)]);
const contributed = await contributedCount();

const authored = owned.reduce((total, node) => {
  const history = node.defaultBranchRef?.target?.history;
  return total + (history ? history.totalCount : 0);
}, 0);

// Values are formatted here rather than in the renderer so the card's rows stay
// dumb display strings keyed by their field label.
const grouped = new Intl.NumberFormat("en-US");
const stats = {
  Repos: `${owned.length} {Contributed: ${contributed}}`,
  Stars: String(owned.reduce((total, node) => total + node.stargazerCount, 0)),
  Followers: String(account.followers),
  Commits: grouped.format(authored),
};

if (process.argv.includes("--lines")) {
  const lines = await authoredLines(id, owned);
  stats.Commits = grouped.format(lines.commits);
  stats["Lines of Code on GitHub"] =
    `${grouped.format(lines.additions + lines.deletions)} ` +
    `(${grouped.format(lines.additions)}++, ${grouped.format(lines.deletions)}--)`;
}

process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);