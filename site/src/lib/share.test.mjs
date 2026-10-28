import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SHARE_PLATFORMS, shareHref, taggedUrl } from './share.ts';

const page = 'https://moncefbousselat.com/writing/a-post/';
const title = 'Locks & state: S3 "native" locking';

describe('taggedUrl', () => {
  it('tags the page with the platform and the share medium', () => {
    assert.equal(taggedUrl(page, 'linkedin'), `${page}?utm_source=linkedin&utm_medium=share`);
  });

  it('replaces tags already on the URL instead of repeating them', () => {
    const url = new URL(taggedUrl(`${page}?utm_source=old&utm_medium=old`, 'x'));
    assert.deepEqual(url.searchParams.getAll('utm_source'), ['x']);
    assert.deepEqual(url.searchParams.getAll('utm_medium'), ['share']);
  });
});

describe('shareHref', () => {
  it('passes each platform the tagged page URL, encoded', () => {
    for (const platform of SHARE_PLATFORMS) {
      const href = new URL(shareHref(platform, page, title));
      const values = [...href.searchParams.values()].join(' ');
      assert.ok(values.includes(taggedUrl(page, platform)), platform);
    }
  });

  it('carries the title where the platform accepts one', () => {
    assert.equal(new URL(shareHref('x', page, title)).searchParams.get('text'), title);
    assert.equal(new URL(shareHref('reddit', page, title)).searchParams.get('title'), title);
    assert.ok(
      new URL(shareHref('bluesky', page, title)).searchParams.get('text').startsWith(title),
    );
  });

  it('gives LinkedIn the URL alone, as share-offsite ignores anything else', () => {
    const href = new URL(shareHref('linkedin', page, title));
    assert.deepEqual([...href.searchParams.keys()], ['url']);
  });
});
