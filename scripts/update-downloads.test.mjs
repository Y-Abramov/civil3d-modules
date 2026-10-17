import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedger, fetchReleases } from './update-downloads.mjs';

const now = '2026-10-18T00:00:00.000Z';
const modules = [{ name: 'demo', bundle_url: 'https://github.com/owner/repo/releases/download/v1/demo.zip' }];
const releases = (count, id = 1) => [{ assets: [{ id, name: 'demo.zip', download_count: count }] }];
const previous = () => ({ schema: 1, updated_at: '2026-10-17T00:00:00.000Z', modules: {
  demo: { repo: 'owner/repo', offset: 0, total: 10, assets: { '1': { name: 'demo.zip', count: 10 } } },
} });

test('counts grow without mutating previous data', () => {
  const prev = previous();
  const result = mergeLedger(prev, modules, { demo: releases(15) }, {}, now);
  assert.equal(result.modules.demo.total, 15);
  assert.equal(result.modules.demo.assets['1'].count, 15);
  assert.equal(result.updated_at, now);
  assert.equal(prev.modules.demo.total, 10);
});

test('a deleted asset retains its count', () => {
  assert.equal(mergeLedger(previous(), modules, { demo: [] }, {}, now).modules.demo.total, 10);
});

test('a clobbered asset with a new id does not reset the total', () => {
  const entry = mergeLedger(previous(), modules, { demo: releases(0, 2) }, {}, now).modules.demo;
  assert.equal(entry.total, 10);
  assert.deepEqual(entry.assets, { '1': { name: 'demo.zip', count: 10 }, '2': { name: 'demo.zip', count: 0 } });
});

test('a lower API count cannot reduce the ledger', () => {
  assert.equal(mergeLedger(previous(), modules, { demo: releases(3) }, {}, now).modules.demo.total, 10);
});

test('an API failure preserves the entire previous entry including offset and repo', () => {
  const prev = previous();
  const changed = [{ ...modules[0], bundle_url: 'https://github.com/owner/new/releases/download/v1/demo.zip' }];
  assert.deepEqual(mergeLedger(prev, changed, { demo: null }, { demo: 116 }, now).modules.demo, prev.modules.demo);
  assert.deepEqual(mergeLedger({}, modules, { demo: null }, {}, now).modules, {});
});

test('offset is added once to all assets across all releases', () => {
  const result = mergeLedger({}, modules, { demo: [...releases(4), ...releases(6, 2)] }, { demo: 116 }, now);
  assert.equal(result.modules.demo.offset, 116);
  assert.equal(result.modules.demo.total, 126);
});

test('a module removed from the catalog remains in the ledger', () => {
  assert.deepEqual(mergeLedger(previous(), [], {}, {}, now).modules, previous().modules);
});

test('identical content preserves updated_at regardless of input key ordering', () => {
  const prev = previous();
  prev.modules.demo = { assets: prev.modules.demo.assets, total: 10, offset: 0, repo: 'owner/repo' };
  assert.equal(mergeLedger(prev, modules, { demo: releases(10) }, {}, now).updated_at, prev.updated_at);
});

test('invalid download counts are treated as zero', () => {
  const assets = [-1, '12', null, undefined, NaN, Infinity].map((download_count, id) => ({ id, name: 'bad.zip', download_count }));
  const entry = mergeLedger({}, modules, { demo: [{ assets }] }, {}, now).modules.demo;
  assert.equal(entry.total, 0);
  assert.ok(Object.values(entry.assets).every(asset => asset.count === 0));
});

test('non GitHub release URLs are skipped', () => {
  const invalid = ['https://example.com/o/r/releases/download/v1/a.zip', 'https://github.com.evil.test/o/r/releases/download/v1/a.zip', 'invalid', 'https://github.com/o/r'];
  for (const bundle_url of invalid) {
    assert.deepEqual(mergeLedger({}, [{ name: 'demo', bundle_url }], { demo: releases(1) }, {}, now).modules, {});
  }
});

test('module and asset keys are stable and sorted', () => {
  const result = mergeLedger({}, [{ ...modules[0], name: 'z' }, { ...modules[0], name: 'a' }], {
    z: releases(1), a: [...releases(2, 20), ...releases(1, 1)],
  }, {}, now);
  assert.deepEqual(Object.keys(result.modules), ['a', 'z']);
  assert.deepEqual(Object.keys(result.modules.a.assets), ['1', '20']);
});

test('fetches every Link next page with GitHub headers', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(releases(calls.length, calls.length)), { headers: calls.length === 1 ? {
      Link: '<https://api.github.com/repos/owner/repo/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repos/owner/repo/releases?per_page=100&page=2>; rel="last"',
    } : {} });
  };
  const result = await fetchReleases('owner/repo', 'test-token', fakeFetch);
  assert.deepEqual(result, [...releases(1, 1), ...releases(2, 2)]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/repo/releases?per_page=100');
  assert.equal(calls[1].url, 'https://api.github.com/repos/owner/repo/releases?per_page=100&page=2');
  assert.equal(calls[0].options.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].options.headers['User-Agent'], 'abr-civil-downloads');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
});

test('failed later page rejects the complete request and omits an unset token', async () => {
  let page = 0;
  await assert.rejects(fetchReleases('owner/repo', '', async (url, options) => {
    assert.equal(Object.hasOwn(options.headers, 'Authorization'), false);
    if (++page === 2) return new Response('', { status: 503 });
    return new Response(JSON.stringify(releases(2)), { headers: {
      Link: '<https://api.github.com/repos/owner/repo/releases?page=2>; rel="next"',
    } });
  }), /503/);
});
