import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

function repoFromModule(module) {
  if (typeof module.bundle_url !== 'string') return null;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/download\/[^/]+\/.+$/i.exec(module.bundle_url);
  return match ? `${match[1]}/${match[2]}` : null;
}

function sortedEntries(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export function mergeLedger(prev, modules, releasesByName, offsets, nowIso) {
  const entries = new Map(Object.entries(prev?.modules ?? {}));
  for (const module of modules) {
    const repo = repoFromModule(module);
    if (!repo) continue;
    const releases = releasesByName[module.name];
    if (releases == null) continue;
    const old = entries.get(module.name);
    const assets = new Map(Object.entries(old?.assets ?? {}));
    for (const release of releases) {
      for (const asset of release.assets ?? []) {
        const id = String(asset.id);
        const count = Number.isFinite(asset.download_count) && asset.download_count >= 0 ? asset.download_count : 0;
        assets.set(id, { name: asset.name, count: Math.max(assets.get(id)?.count ?? 0, count) });
      }
    }
    const offset = Object.hasOwn(offsets, module.name) ? offsets[module.name] : 0;
    entries.set(module.name, {
      repo,
      offset,
      total: offset + [...assets.values()].reduce((sum, asset) => sum + asset.count, 0),
      assets: sortedEntries(Object.fromEntries(assets)),
    });
  }
  const sortedModules = sortedEntries(Object.fromEntries([...entries].map(([name, entry]) => [
    name, { ...entry, assets: sortedEntries(entry.assets) },
  ])));
  const unchanged = prev?.schema === 1 && isDeepStrictEqual(sortedModules, prev.modules);
  return { schema: 1, updated_at: unchanged ? prev.updated_at : nowIso, modules: sortedModules };
}

export async function fetchReleases(repo, token = process.env.GITHUB_TOKEN, fetchImpl = fetch) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'abr-civil-downloads' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const releases = [];
  let url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const visited = new Set();
  while (url) {
    if (new URL(url).origin !== 'https://api.github.com' || visited.has(url)) {
      throw new Error('Invalid GitHub pagination link');
    }
    visited.add(url);
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('GitHub releases response is not an array');
    releases.push(...page);
    const next = (response.headers.get('link') ?? '').split(',').find(link => /;\s*rel="next"/.test(link));
    url = next?.match(/<([^>]+)>/)?.[1] ?? null;
  }
  return releases;
}

async function main() {
  const root = new URL('../', import.meta.url);
  const { modules } = JSON.parse(await readFile(new URL('catalog.json', root), 'utf8'));
  const offsets = JSON.parse(await readFile(new URL('scripts/downloads-offsets.json', root), 'utf8'));
  const ledgerPath = new URL('downloads.json', root);
  // No ledger yet = start empty. A ledger that exists but is broken must stop the run:
  // starting from {} and committing would wipe the whole history this file exists to keep.
  let prev = {};
  let raw = null;
  try {
    raw = await readFile(ledgerPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (raw !== null) {
    const parsed = JSON.parse(raw);
    if (!(parsed?.schema === 1 && parsed.modules && typeof parsed.modules === 'object' && !Array.isArray(parsed.modules)
      && Object.values(parsed.modules).every(entry => entry && typeof entry === 'object'
        && entry.assets && typeof entry.assets === 'object' && !Array.isArray(entry.assets)
        && Number.isFinite(entry.total) && Number.isFinite(entry.offset)
        && Object.values(entry.assets).every(asset => asset && typeof asset.name === 'string'
          && Number.isFinite(asset.count) && asset.count >= 0)))) {
      throw new Error('downloads.json is malformed; fix it by hand, refusing to reset the ledger');
    }
    prev = parsed;
  }
  const releasesByName = Object.create(null);
  const byRepo = new Map();
  for (const module of modules) {
    const repo = repoFromModule(module);
    if (!repo) continue;
    if (!byRepo.has(repo)) {
      try {
        byRepo.set(repo, await fetchReleases(repo));
      } catch {
        // Keep credentials and response bodies out of logs.
        console.error(`${module.name}: GitHub request failed; preserving previous entry`);
        byRepo.set(repo, null);
      }
    }
    releasesByName[module.name] = byRepo.get(repo);
  }
  const ledger = mergeLedger(prev, modules, releasesByName, offsets, new Date().toISOString());
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  for (const [name, entry] of Object.entries(ledger.modules)) console.log(`${name} ${entry.total}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Failed to update downloads ledger');
    process.exitCode = 1;
  });
}
