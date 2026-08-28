"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const worker = require(path.join(__dirname, '..', 'extension', 'worker.js'));

/////////////////////////////////////////////////////////////////////////////////////
///////////////////////// isLetterboxdUrl ////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

test('isLetterboxdUrl', async (t) => {
	await t.test('matches bare letterboxd.com URLs', () => {
		assert.strictEqual(worker.isLetterboxdUrl('https://letterboxd.com/film/inception/'), true);
	});

	await t.test('matches www.letterboxd.com URLs', () => {
		assert.strictEqual(worker.isLetterboxdUrl('https://www.letterboxd.com/someone/watchlist/'), true);
	});

	await t.test('rejects unrelated domains, even ones mentioning letterboxd.com in the path', () => {
		assert.strictEqual(worker.isLetterboxdUrl('https://example.com/letterboxd.com/'), false);
	});

	await t.test('handles a missing url without throwing', () => {
		assert.ok(!worker.isLetterboxdUrl(undefined));
		assert.ok(!worker.isLetterboxdUrl(''));
	});
});

/////////////////////////////////////////////////////////////////////////////////////
///////////////////////// isSupportedLetterboxdPage //////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

test('isSupportedLetterboxdPage', async (t) => {
	await t.test('accepts watchlist, films, likes and list pages', () => {
		assert.strictEqual(worker.isSupportedLetterboxdPage('https://letterboxd.com/user/watchlist/'), true);
		assert.strictEqual(worker.isSupportedLetterboxdPage('https://letterboxd.com/films/popular/'), true);
		assert.strictEqual(worker.isSupportedLetterboxdPage('https://letterboxd.com/user/likes/films/'), true);
		assert.strictEqual(worker.isSupportedLetterboxdPage('https://letterboxd.com/user/list/some-list/'), true);
	});

	await t.test('rejects a page type that is not in the supported list (e.g. a single film page)', () => {
		assert.strictEqual(worker.isSupportedLetterboxdPage('https://letterboxd.com/film/inception/'), false);
	});

	await t.test('handles a missing url without throwing', () => {
		assert.ok(!worker.isSupportedLetterboxdPage(undefined));
	});
});

/////////////////////////////////////////////////////////////////////////////////////
///////////////////////// isProcessableLetterboxdTab /////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

test('isProcessableLetterboxdTab', async (t) => {
	const baseTab = { url: 'https://letterboxd.com/user/watchlist/', status: 'complete', discarded: false };

	await t.test('accepts a fully loaded, non-discarded tab on a supported page', () => {
		assert.strictEqual(worker.isProcessableLetterboxdTab(baseTab), true);
	});

	await t.test('rejects a discarded tab', () => {
		assert.strictEqual(worker.isProcessableLetterboxdTab({ ...baseTab, discarded: true }), false);
	});

	await t.test('rejects a tab that has not finished loading', () => {
		assert.strictEqual(worker.isProcessableLetterboxdTab({ ...baseTab, status: 'loading' }), false);
	});

	await t.test('rejects a tab on an unsupported letterboxd page', () => {
		assert.strictEqual(
			worker.isProcessableLetterboxdTab({ ...baseTab, url: 'https://letterboxd.com/film/inception/' }),
			false
		);
	});

	await t.test('rejects a tab on an unrelated domain', () => {
		assert.strictEqual(
			worker.isProcessableLetterboxdTab({ ...baseTab, url: 'https://example.com/watchlist/' }),
			false
		);
	});
});

/////////////////////////////////////////////////////////////////////////////////////
///////////////////////// extractMediaInfo ///////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

test('extractMediaInfo', async (t) => {
	await t.test('extracts title/release_date for a movie', () => {
		const item = { title: 'Inception', release_date: '2010-07-16' };
		assert.deepStrictEqual(worker.extractMediaInfo(item, 'movie'), {
			itemTitle: 'Inception',
			itemReleaseDate: '2010-07-16',
		});
	});

	await t.test('extracts name/first_air_date for a tv show', () => {
		const item = { name: 'Chernobyl', first_air_date: '2019-05-06' };
		assert.deepStrictEqual(worker.extractMediaInfo(item, 'tv'), {
			itemTitle: 'Chernobyl',
			itemReleaseDate: '2019-05-06',
		});
	});

	await t.test('returns nulls when a movie is missing release_date', () => {
		const item = { title: 'Inception' };
		assert.deepStrictEqual(worker.extractMediaInfo(item, 'movie'), { itemTitle: null, itemReleaseDate: null });
	});

	await t.test('returns nulls when a movie is missing title', () => {
		const item = { release_date: '2010-07-16' };
		assert.deepStrictEqual(worker.extractMediaInfo(item, 'movie'), { itemTitle: null, itemReleaseDate: null });
	});

	await t.test('returns nulls when a tv show is missing name', () => {
		const item = { first_air_date: '2019-05-06' };
		assert.deepStrictEqual(worker.extractMediaInfo(item, 'tv'), { itemTitle: null, itemReleaseDate: null });
	});

	await t.test('does not cross-match movie fields against a tv media type', () => {
		const item = { title: 'Inception', release_date: '2010-07-16' };
		assert.deepStrictEqual(worker.extractMediaInfo(item, 'tv'), { itemTitle: null, itemReleaseDate: null });
	});

	await t.test('returns nulls for an unrecognized media type', () => {
		const item = { title: 'Inception', release_date: '2010-07-16', name: 'Inception' };
		assert.deepStrictEqual(worker.extractMediaInfo(item, 'person'), { itemTitle: null, itemReleaseDate: null });
	});
});

/////////////////////////////////////////////////////////////////////////////////////
///////////////////////// getIdWithReleaseYear ///////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

test('getIdWithReleaseYear', async (t) => {
	await t.test('returns an exact title+year match', () => {
		const results = [{ media_type: 'movie', id: 20, title: 'Dune', release_date: '2021-06-15' }];
		assert.deepStrictEqual(worker.getIdWithReleaseYear(results, 'Dune', 2021), {
			tmdbId: 20,
			mediaType: 'movie',
			matchFound: true,
		});
	});

	await t.test('prefers an exact match over an earlier fuzzy (+-1 year) candidate', () => {
		const results = [
			{ media_type: 'movie', id: 10, title: 'Dune', release_date: '2020-06-15' }, // off by 1 year, seen first
			{ media_type: 'movie', id: 20, title: 'Dune', release_date: '2021-06-15' }, // exact
		];
		assert.deepStrictEqual(worker.getIdWithReleaseYear(results, 'Dune', 2021), {
			tmdbId: 20,
			mediaType: 'movie',
			matchFound: true,
		});
	});

	await t.test('falls back to a +-1 year fuzzy match when no exact match exists', () => {
		const results = [{ media_type: 'movie', id: 5, title: 'Nope', release_date: '2022-06-15' }];
		assert.deepStrictEqual(worker.getIdWithReleaseYear(results, 'Nope', 2021), {
			tmdbId: 5,
			mediaType: 'movie',
			matchFound: true,
		});
	});

	await t.test('does not match when the year differs by more than 1', () => {
		const results = [{ media_type: 'movie', id: 5, title: 'Old Movie', release_date: '2015-06-15' }];
		assert.deepStrictEqual(worker.getIdWithReleaseYear(results, 'Old Movie', 2021), {
			tmdbId: -1,
			mediaType: '',
			matchFound: false,
		});
	});

	await t.test('matches titles case-insensitively', () => {
		const results = [{ media_type: 'movie', id: 7, title: 'DUNE', release_date: '2021-06-15' }];
		assert.deepStrictEqual(worker.getIdWithReleaseYear(results, 'dune', 2021), {
			tmdbId: 7,
			mediaType: 'movie',
			matchFound: true,
		});
	});

	await t.test('matches a tv show via name/first_air_date', () => {
		const results = [{ media_type: 'tv', id: 42, name: 'Chernobyl', first_air_date: '2019-06-15' }];
		assert.deepStrictEqual(worker.getIdWithReleaseYear(results, 'Chernobyl', 2019), {
			tmdbId: 42,
			mediaType: 'tv',
			matchFound: true,
		});
	});

	await t.test('does not match a tv result against a movie release_date field', () => {
		// item is tv media_type but only carries movie-shaped fields; extractMediaInfo
		// should reject it, so no match should be produced even though titles align.
		const results = [{ media_type: 'tv', id: 42, title: 'Chernobyl', release_date: '2019-06-15' }];
		assert.deepStrictEqual(worker.getIdWithReleaseYear(results, 'Chernobyl', 2019), {
			tmdbId: -1,
			mediaType: '',
			matchFound: false,
		});
	});

	await t.test('returns no match for an empty result set', () => {
		assert.deepStrictEqual(worker.getIdWithReleaseYear([], 'Anything', 2021), {
			tmdbId: -1,
			mediaType: '',
			matchFound: false,
		});
	});

	await t.test('treats releaseYear -1 ("no known year") as an automatic fuzzy candidate', () => {
		const results = [{ media_type: 'movie', id: 99, title: 'Timeless', release_date: '1999-06-15' }];
		assert.deepStrictEqual(worker.getIdWithReleaseYear(results, 'Timeless', -1), {
			tmdbId: 99,
			mediaType: 'movie',
			matchFound: true,
		});
	});

	await t.test('skips items with no media_type at all', () => {
		const results = [
			{ id: 1, title: 'No Type', release_date: '2021-06-15' }, // no media_type -> skipped
			{ media_type: 'movie', id: 2, title: 'No Type', release_date: '2021-06-15' },
		];
		assert.deepStrictEqual(worker.getIdWithReleaseYear(results, 'No Type', 2021), {
			tmdbId: 2,
			mediaType: 'movie',
			matchFound: true,
		});
	});

	await t.test('ignores items whose title does not match', () => {
		const results = [{ media_type: 'movie', id: 1, title: 'Completely Different', release_date: '2021-06-15' }];
		assert.deepStrictEqual(worker.getIdWithReleaseYear(results, 'Dune', 2021), {
			tmdbId: -1,
			mediaType: '',
			matchFound: false,
		});
	});

	await t.test('keeps the last qualifying fuzzy candidate when several are found', () => {
		const results = [
			{ media_type: 'movie', id: 1, title: 'Dune', release_date: '2020-06-15' }, // off by 1
			{ media_type: 'movie', id: 2, title: 'Dune', release_date: '2022-06-15' }, // off by 1, seen later
		];
		assert.deepStrictEqual(worker.getIdWithReleaseYear(results, 'Dune', 2021), {
			tmdbId: 2,
			mediaType: 'movie',
			matchFound: true,
		});
	});
});

/////////////////////////////////////////////////////////////////////////////////////
///////////////////////// addMovieIfFlatrate //////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

test('addMovieIfFlatrate', async (t) => {
	// addMovieIfFlatrate reads module-level countryCode/providerId, which parseSettings
	// sets synchronously (no fetch is triggered when all three settings keys are given).
	t.beforeEach(async () => {
		await worker.parseSettings({ country_code: 'DE', provider_id: 8, filter_status: true });
	});

	await t.test('adds letterboxd ids when the provider is present in flatrate', () => {
		worker.availableMovies[1] = [];
		const results = { DE: { flatrate: [{ provider_id: 8 }], free: [] } };
		worker.addMovieIfFlatrate(results, 1, [100, 101]);
		assert.deepStrictEqual(worker.availableMovies[1], [100, 101]);
	});

	await t.test('adds letterboxd ids when the provider is only present in free (flatrate empty)', () => {
		worker.availableMovies[2] = [];
		const results = { DE: { flatrate: [], free: [{ provider_id: 8 }] } };
		worker.addMovieIfFlatrate(results, 2, [200]);
		assert.deepStrictEqual(worker.availableMovies[2], [200]);
	});

	await t.test('does nothing when the provider is absent from both flatrate and free', () => {
		worker.availableMovies[3] = [];
		const results = { DE: { flatrate: [{ provider_id: 9 }], free: [{ provider_id: 10 }] } };
		worker.addMovieIfFlatrate(results, 3, [300]);
		assert.deepStrictEqual(worker.availableMovies[3], []);
	});

	await t.test('does nothing when the configured country is absent from the results', () => {
		worker.availableMovies[4] = [];
		// configured country is DE (see beforeEach), but only US data is present
		const results = { US: { flatrate: [{ provider_id: 8 }] } };
		worker.addMovieIfFlatrate(results, 4, [400]);
		assert.deepStrictEqual(worker.availableMovies[4], []);
	});

	await t.test('handles a country entry with no flatrate/free arrays at all', () => {
		worker.availableMovies[5] = [];
		const results = { DE: {} };
		assert.doesNotThrow(() => worker.addMovieIfFlatrate(results, 5, [500]));
		assert.deepStrictEqual(worker.availableMovies[5], []);
	});

	await t.test('appends across multiple calls rather than overwriting prior entries', () => {
		worker.availableMovies[6] = [1];
		const results = { DE: { flatrate: [{ provider_id: 8 }] } };
		worker.addMovieIfFlatrate(results, 6, [2, 3]);
		assert.deepStrictEqual(worker.availableMovies[6], [1, 2, 3]);
	});
});

/////////////////////////////////////////////////////////////////////////////////////
///////////////////////// parseSettings ///////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

test('parseSettings', async (t) => {
	await t.test('applies fully-specified settings synchronously, without calling fetch', async () => {
		const originalFetch = global.fetch;
		let fetchCalled = false;
		global.fetch = async (...args) => {
			fetchCalled = true;
			return originalFetch ? originalFetch(...args) : undefined;
		};

		try {
			await worker.parseSettings({ country_code: 'US', provider_id: 9, filter_status: false });
		} finally {
			global.fetch = originalFetch;
		}

		assert.strictEqual(fetchCalled, false, 'fetch should not be called when all settings are already present');

		// Confirm the values actually took effect, via the observable behavior of addMovieIfFlatrate.
		worker.availableMovies[900] = [];
		worker.addMovieIfFlatrate({ US: { flatrate: [{ provider_id: 9 }] } }, 900, [1]);
		assert.deepStrictEqual(worker.availableMovies[900], [1]);
	});

	await t.test('falls back to fetching default settings (without throwing) when settings are incomplete', async () => {
		const originalFetch = global.fetch;
		const originalConsoleError = console.error;
		console.error = () => {};
		let requestedUrl = null;
		global.fetch = async (url) => {
			requestedUrl = url;
			return { status: 200, json: async () => ({}) };
		};

		try {
			await assert.doesNotReject(worker.parseSettings({}));
		} finally {
			global.fetch = originalFetch;
			console.error = originalConsoleError;
		}

		assert.match(String(requestedUrl), /default\.json/);
	});

	await t.test('does not throw when the fallback fetch itself fails (e.g. network error)', async () => {
		const originalFetch = global.fetch;
		const originalConsoleError = console.error;
		console.error = () => {};
		global.fetch = async () => {
			throw new Error('network down');
		};

		try {
			// country_code is present but provider_id/filter_status are missing, so the
			// (failing) default-settings fetch path is exercised.
			await assert.doesNotReject(worker.parseSettings({ country_code: 'DE' }));
		} finally {
			global.fetch = originalFetch;
			console.error = originalConsoleError;
		}
	});
});
