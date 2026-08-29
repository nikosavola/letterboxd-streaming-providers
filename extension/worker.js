"use strict";

// for compatibility reasons
const browser = chrome;

/////////////////////////////////////////////////////////////////////////////////////
///////////////////////// CONSTANTS /////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

const LETTERBOXD_PATTERNS = ['://letterboxd.com/', '://www.letterboxd.com/'];
const SUPPORTED_PAGES = ['/watchlist/', '/films/', '/likes/', '/list/'];
const CSS_CLASSES = {
	GRID_ITEM: 'griditem',
	POSTER_ITEM: 'posteritem',
	NOT_STREAMED: 'film-not-streamed'
};
const MAX_CRAWL_RETRIES = 3;

/////////////////////////////////////////////////////////////////////////////////////
///////////////////////// STATE MANAGEMENT //////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

// settings
let countryCode = ''; // e.g. German: "DE", USA: "US"
let providerId = 0; // e.g. Netflix: 8, Amazon Prime Video: 9
let filterStatus = false;

// fetch options
let fetchOptions = {};

// cache
let providers = {};
let countries = {};
let availableMovies = {};
let crawledMovies = {};
let unsolvedRequests = {};
let crawlRetryCount = {};

// Per-tab processing generation, incremented on every new page load of a tab.
// Used to discard results of in-flight work that belongs to a superseded page.
// Intentionally kept in memory only: in-flight work never survives a service
// worker restart, so a restarted worker has no stale sessions to guard against.
let tabGeneration = {};

let settingsLoaded = false;
let cacheLoaded = false;

// Single-flight loading of settings and cache, see ensureSettingsAndCacheLoaded()
let loadingPromise = null;
// Bumped whenever the stored settings change, so a load that started before the
// change does not satisfy a caller that needs the new settings.
let settingsEpoch = 0;
let loadedEpoch = -1;

/////////////////////////////////////////////////////////////////////////////////////
///////////////////////// STARTUP AND SETTINGS //////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

/**
 * Loads all information from JSON files for intern computations.
 * Requests the available countries and providers from TMDB.
 * Also loads the current settings.
 *
 * @returns {Promise<void>} - An empty Promise if the loadings worked correctly, else the Promise contains the respective errors.
 */
const onStartUp = async () => {
	// load TMDb token and set fetch options
	await loadTmdbToken();

	// load stored settings from localStorage
	const localItems = await browser.storage.local.get();
	await parseSettings(localItems);

	await Promise.all([requestRegions(), requestProviderList()]);
};

/**
 * Fetches available regions from TMDB API.
 */
async function requestRegions() {
	const url = "https://api.themoviedb.org/3/watch/providers/regions";

	const response = await safeFetchJson(url, fetchOptions, "TMDB regions request");
	if (response?.json == null) {
		return;
	}

	for (const entry of response.json.results) {
		countries[entry.iso_3166_1] = {
			code: entry.iso_3166_1,
			name: entry.english_name
		};
	}

	// persist for later service worker cycles
	browser.storage.session.set({ countries });
}

/**
 * Fetches available streaming providers from TMDB API.
 */
async function requestProviderList() {
	const url = "https://api.themoviedb.org/3/watch/providers/movie?language=en-US";

	const response = await safeFetchJson(url, fetchOptions, "TMDB providers request");
	if (response?.json == null) {
		return;
	}

	for (const entry of response.json.results) {
		providers[entry.provider_id] = {
			provider_id: entry.provider_id,
			name: entry.provider_name.trim(),
			display_priority: entry.display_priority,
			countries: Object.keys(entry.display_priorities)
		};
	}

	// persist for later service worker cycles
	browser.storage.session.set({ providers });
}

/**
 * Parses settings from storage items.
 *
 * @param {object} items - Storage items containing settings.
 */
async function parseSettings(items) {
	const hasCountryCode = 'country_code' in items;
	const hasProvider = 'provider_id' in items;
	const hasStatus = 'filter_status' in items;

	if (hasCountryCode) {
		countryCode = items.country_code;
	}
	if (hasProvider) {
		providerId = items.provider_id;
	}
	if (hasStatus) {
		filterStatus = items.filter_status;
	}

	if (!hasCountryCode || !hasProvider || !hasStatus) {
		await loadDefaultSettings(!hasCountryCode, !hasProvider, !hasStatus);
	}

	settingsLoaded = true;
}

/**
 * Loads default settings from JSON file.
 *
 * @param {boolean} needCountryCode - Whether to load default country code.
 * @param {boolean} needProvider - Whether to load default provider.
 * @param {boolean} needStatus - Whether to load default filter status.
 */
async function loadDefaultSettings(needCountryCode, needProvider, needStatus) {
	const result = await safeFetchJson("settings/default.json", {}, "default settings");
	if (!result?.json) {
		return;
	}

	const toStore = {};

	if (needCountryCode && 'country_code' in result.json) {
		countryCode = result.json.country_code;
		toStore.country_code = countryCode;
	}
	if (needProvider && 'provider_id' in result.json) {
		providerId = result.json.provider_id;
		toStore.provider_id = providerId;
	}
	if (needStatus && 'filter_status' in result.json) {
		filterStatus = result.json.filter_status;
		toStore.filter_status = filterStatus;
	}

	if (Object.keys(toStore).length > 0) {
		browser.storage.local.set(toStore);
	}
}

/**
 * Parses cached data from session storage.
 *
 * @param {object} items - Session storage items.
 */
async function parseCache(items) {
	providers = items.providers ?? {};
	countries = items.countries ?? {};

	// If session storage was cleared, refetch from API
	const apiCalls = [];
	if (Object.keys(providers).length === 0) {
		apiCalls.push(requestProviderList());
	}
	if (Object.keys(countries).length === 0) {
		apiCalls.push(requestRegions());
	}
	if (apiCalls.length > 0) {
		await Promise.all(apiCalls);
	}

	availableMovies = items.available_movies ?? {};
	crawledMovies = items.crawled_movies ?? {};
	unsolvedRequests = items.unsolved_requests ?? {};

	await loadTmdbToken();

	cacheLoaded = true;
}

/**
 * Reads settings and cache from storage into the module level state.
 *
 * @returns {Promise<void>} - Resolves once settings and cache are parsed.
 */
async function loadSettingsAndCache() {
	const [localItems, sessionItems] = await Promise.all([
		browser.storage.local.get(),
		browser.storage.session.get()
	]);
	await parseSettings(localItems);
	await parseCache(sessionItems);
}

/**
 * Ensures settings and cache are loaded, loading them at most once at a time.
 *
 * Concurrent callers (e.g. two Letterboxd tabs waking the same cold service
 * worker) await the same in-flight load instead of each reading storage and
 * each overwriting the shared per-tab maps in parseCache().
 *
 * @returns {Promise<void>} - Resolves once settings and cache are available.
 */
async function ensureSettingsAndCacheLoaded() {
	while (!settingsLoaded || !cacheLoaded || loadedEpoch < settingsEpoch) {
		if (!loadingPromise) {
			const epoch = settingsEpoch;
			loadingPromise = loadSettingsAndCache()
				// Record which settings version this load actually observed.
				.then(() => { loadedEpoch = epoch; })
				.finally(() => { loadingPromise = null; });
		}
		// A load that started before the last settings change does not count as
		// up to date, so the loop starts a fresh one in that case.
		await loadingPromise;
	}
}

/**
 * Loads settings and cache if not already loaded, then executes the callback function.
 *
 * @param {function} callback - The function to execute after settings and cache are loaded.
 */
async function loadSettingsAndExecute(callback) {
	await ensureSettingsAndCacheLoaded();
	callback();
}

/////////////////////////////////////////////////////////////////////////////////////
/////////////////////////// EVENT LISTENER //////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

browser.runtime.onInstalled.addListener(() => onStartUp());
browser.runtime.onStartup.addListener(() => onStartUp());

browser.runtime.onMessage.addListener((request, sender, _) => {
	loadSettingsAndExecute(() => handleMessage(request, sender));
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tabInfo) => {
	// Use status from changeInfo as tabInfo.status may not be updated yet when the event fires
	if (!isProcessableLetterboxdTab({ ...tabInfo, status: changeInfo?.status })) {
		return;
	}

	loadSettingsAndExecute(() => processLetterboxdTab(tabId));
});

browser.tabs.onRemoved.addListener(tabId => {
	// Load first: on a cold service worker the in-memory maps are empty, so
	// persisting them without loading would wipe every other tab's state.
	loadSettingsAndExecute(() => clearTabState(tabId));
});

browser.storage.local.onChanged.addListener(_ => {
	settingsLoaded = false;
	settingsEpoch++;
	loadSettingsAndExecute(() => reloadMovieFilter());
});

browser.alarms.onAlarm.addListener(alarm => {
	if (alarm.name !== "handleUnsolvedRequests") {
		return;
	}
	loadSettingsAndExecute(() => handleUnsolvedRequests());
});

/////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////// RELOAD ///////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

/**
 * Called to force the filters to reload with the new provider ID.
 */
async function reloadMovieFilter() {
	const tabs = await browser.tabs.query({}) ?? [];

	for (const tab of tabs) {
		if (!isProcessableLetterboxdTab(tab)) {
			continue;
		}

		const tabId = tab.id;
		await unfadeAllMovies(tabId);
		processLetterboxdTab(tabId);
	}
}

/////////////////////////////////////////////////////////////////////////////////////
/////////////////////////// MOVIE AVAILABILITY //////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

/**
 * Called from within the listener for new messages from the content script.
 * Triggers check for movie availability or re-initiates the whole process if no movies received.
 *
 * @param {{messageType: string, messageContent: object}} request - The message from the content script.
 * @param {object} sender - The sender from the runtime.onMessage event.
 */
function handleMessage(request, sender) {
	if (typeof sender?.frameId === 'number' && sender.frameId !== 0) {
		return;
	}

	const tabId = sender?.tab?.id;
	if (!tabId) {
		console.error("Error: missing tab ID");
		return;
	}

	if (request?.messageType !== 'movie-titles' || !request?.messageContent) {
		return;
	}

	crawledMovies[tabId] = request.messageContent;
	browser.storage.session.set({ crawled_movies: crawledMovies });

	if (Object.keys(crawledMovies[tabId]).length === 0) {
		// we don't got any movies yet, let's try again if we haven't exceeded max retries
		crawlRetryCount[tabId] = (crawlRetryCount[tabId] ?? 0) + 1;
		if (crawlRetryCount[tabId] < MAX_CRAWL_RETRIES) {
			getFilmsFromLetterboxd(tabId);
		}
	} else {
		// Reset retry count on success
		crawlRetryCount[tabId] = 0;
		checkMovieAvailability(tabId, crawledMovies[tabId]);
	}
}

/**
 * Calls the method for checking the movie availability for each movie in movies.
 *
 * @param {number} tabId - The tabId to operate in.
 * @param {object} movies - The crawled movies from Letterboxed.
 */
async function checkMovieAvailability(tabId, movies) {
	if (!filterStatus) {
		return;
	}

	// Everything below belongs to the page load that is current right now. If the
	// tab navigates to another supported page in the meantime, this session is
	// superseded and its results must not touch the new page's state.
	const generation = currentTabGeneration(tabId);

	prepareLetterboxdForFading(tabId);

	const CONCURRENCY_LIMIT = 5;
	const entries = Object.entries(movies);
	for (let i = 0; i < entries.length; i += CONCURRENCY_LIMIT) {
		if (!isCurrentTabGeneration(tabId, generation)) {
			// Superseded by a newer page load, stop issuing requests for this one.
			return;
		}

		const batch = entries.slice(i, i + CONCURRENCY_LIMIT);
		await Promise.all(batch.map(([title, data]) =>
			checkMovie(tabId, title, data.year, data.id, generation)
		));

		// Persist after every batch: the service worker can be terminated at any
		// point, and everything found so far has to survive the restart.
		await persistAvailableMovies();
	}

	fadeUnstreamableMovies(tabId, movies, generation);
}

/**
 * Persists the available movies of all tabs for later service worker cycles.
 *
 * @returns {Promise<void>} - Resolves once the state is written.
 */
function persistAvailableMovies() {
	return browser.storage.session.set({ available_movies: availableMovies });
}

/**
 * Returns the current processing generation of a tab.
 * A tab without a known generation is treated as generation 0.
 *
 * @param {number|string} tabId - The tab ID.
 * @returns {number} - The tab's current generation.
 */
function currentTabGeneration(tabId) {
	return tabGeneration[tabId] ?? 0;
}

/**
 * Checks whether a captured generation still refers to the tab's current page load.
 *
 * @param {number|string} tabId - The tab ID.
 * @param {number} generation - The generation captured when the work started.
 * @returns {boolean} - True if no newer page load superseded the captured one.
 */
function isCurrentTabGeneration(tabId, generation) {
	return currentTabGeneration(tabId) === generation;
}

/**
 * Checks if a movie is available and adds it to availableMovies[tabId].
 *
 * @param {number} tabId - The tabId of the tab, in which Letterboxd should be filtered.
 * @param {string} title - The movie title.
 * @param {number} year - The release year.
 * @param {Array} letterboxdId - The Letterboxd-intern array id.
 * @param {number} generation - The tab generation this check belongs to.
 */
async function checkMovie(tabId, title, year, letterboxdId, generation) {
	const titleSanitized = encodeURIComponent(title);

	// Search for the movie
	const searchUrl = `https://api.themoviedb.org/3/search/multi?query=${titleSanitized}`;
	const searchResult = await safeFetchJson(searchUrl, fetchOptions, `TMDB search for '${title}' (${year})`);
	if (searchResult?.json == null) {
		handleRateLimitError(searchResult?.status, tabId, title, year, letterboxdId, generation);
		return;
	}
	const tmdbInfo = getIdWithReleaseYear(searchResult.json.results, title, year);

	if (!tmdbInfo.matchFound) {
		return;
	}

	// Check provider availability
	const providerUrl = `https://api.themoviedb.org/3/${tmdbInfo.mediaType}/${tmdbInfo.tmdbId}/watch/providers`;
	const providerResult = await safeFetchJson(providerUrl, fetchOptions, `TMDB providers for '${title}' (${year})`);
	if (providerResult?.json == null) {
		handleRateLimitError(providerResult?.status, tabId, title, year, letterboxdId, generation);
		return;
	}
	addMovieIfFlatrate(providerResult.json.results, tabId, letterboxdId, generation);
}

/**
 * Handles rate limit errors by storing the request for later retry.
 *
 * @param {number} status - HTTP status code.
 * @param {number} tabId - The tab ID.
 * @param {string} title - Movie title.
 * @param {number} year - Release year.
 * @param {Array} id - Letterboxd IDs.
 * @param {number} generation - The tab generation this request belongs to.
 */
function handleRateLimitError(status, tabId, title, year, id, generation) {
	if (status !== 429) {
		return;
	}

	// The request was issued for a page load that has since been superseded. Its
	// Letterboxd IDs refer to the old DOM, so retrying it would corrupt the new
	// page's state; the new page load checks its own movies anyway.
	if (!isCurrentTabGeneration(tabId, generation)) {
		return;
	}

	// unsolvedRequests[tabId] can be gone by the time this in-flight request
	// resolves (e.g. handleUnsolvedRequests deleted it because the tab is no
	// longer valid/processable). Nothing tracks this tab anymore, so drop the
	// retry instead of resurrecting state for it.
	if (!unsolvedRequests[tabId]) {
		return;
	}

	unsolvedRequests[tabId][title] = { year, id };
	browser.storage.session.set({ unsolved_requests: unsolvedRequests });
}

/**
 * Returns the TMDb ID for a given English media title and a corresponding release year.
 * If no exact match is found (i.e., title and release year do not match exactly),
 * this function tries to find a match with best effort:
 * maybe the release year differs by 1 or is missing completely.
 *
 * @param {object[]} results - The results from the TMDB "Multi" request.
 * @param {string} titleEnglish - The English movie title.
 * @param {number} releaseYear - The media's release year.
 * @returns {{tmdbId: number, mediaType: string, matchFound: boolean}} - TMDb info object.
 */
function getIdWithReleaseYear(results, titleEnglish, releaseYear) {
	let candidate = { tmdbId: -1, mediaType: '', matchFound: false };
	const titleLower = titleEnglish.toLowerCase();

	for (const item of results) {
		const mediaType = item.media_type;
		if (!mediaType) {
			continue;
		}

		const { itemTitle, itemReleaseDate } = extractMediaInfo(item, mediaType);
		if (!itemTitle || !itemReleaseDate) {
			continue;
		}

		const itemReleaseYear = new Date(itemReleaseDate).getFullYear();

		if (itemTitle.toLowerCase() !== titleLower) {
			continue;
		}

		// Exact match - return immediately
		if (itemReleaseYear === releaseYear) {
			return { tmdbId: item.id, mediaType, matchFound: true };
		}

		// Fuzzy match - store as candidate
		if (releaseYear === -1 || Math.abs(itemReleaseYear - releaseYear) === 1) {
			candidate = { tmdbId: item.id, mediaType, matchFound: true };
		}
	}

	return candidate;
}

/**
 * Extracts title and release date from a TMDB result item.
 *
 * @param {object} item - TMDB result item.
 * @param {string} mediaType - Type of media ('movie' or 'tv').
 * @returns {{itemTitle: string|null, itemReleaseDate: string|null}} - Extracted info.
 */
function extractMediaInfo(item, mediaType) {
	if (mediaType === 'movie' && item.release_date && item.title) {
		return { itemTitle: item.title, itemReleaseDate: item.release_date };
	}
	if (mediaType === 'tv' && item.first_air_date && item.name) {
		return { itemTitle: item.name, itemReleaseDate: item.first_air_date };
	}
	return { itemTitle: null, itemReleaseDate: null };
}

/**
 * Adds the given letterboxd ID to the availableMovies
 * if the selected provider includes the movie in its flatrate.
 *
 * @param {object} results - The results from the TMDB "Watch Providers" request.
 * @param {number} tabId - The tabId to operate in.
 * @param {Array} letterboxdId - The intern ID from the array in letterboxd.com.
 * @param {number} generation - The tab generation this result belongs to.
 */
function addMovieIfFlatrate(results, tabId, letterboxdId, generation) {
	// This result was computed for a page load that has since been superseded.
	// Its Letterboxd IDs index the old page's DOM, so discard it instead of
	// mixing it into the new page's availability data.
	if (!isCurrentTabGeneration(tabId, generation)) {
		return;
	}

	const countryData = results[countryCode];
	if (!countryData) {
		return;
	}

	const offersToCheck = [
		...(countryData.flatrate ?? []),
		...(countryData.free ?? [])
	];

	const hasProvider = offersToCheck.some(offer =>
		offer.provider_id && offer.provider_id === providerId
	);

	// availableMovies[tabId] may be gone if the tab's state was torn down while
	// this request was in flight; skip rather than resurrecting a lone entry.
	if (hasProvider && availableMovies[tabId]) {
		availableMovies[tabId].push(...letterboxdId);
	}
}

/**
 * Handles unsolved requests by re-attempting to check their availability.
 */
async function handleUnsolvedRequests() {
	for (const tabId in unsolvedRequests) {
		const tabRequests = unsolvedRequests[tabId];
		if (!tabRequests || Object.keys(tabRequests).length === 0) {
			continue;
		}

		// Check if the tab still exists and is processable right now
		let tabExists = false;
		let isProcessable = false;
		try {
			const tab = await browser.tabs.get(Number(tabId));
			tabExists = true;
			isProcessable = isProcessableLetterboxdTab(tab);
		} catch (e) {
			// Tab no longer exists
		}

		if (!tabExists) {
			// The tab is really gone. tabs.onRemoved usually cleans this up, but
			// the service worker may have been asleep when the tab was closed.
			clearTabState(tabId);
			continue;
		}

		if (!isProcessable) {
			// The tab exists but is momentarily not processable, e.g. discarded by
			// the browser's memory saver or in the middle of a reload. Keep its
			// pending retries so they can still be handled later on.
			continue;
		}

		// Everything below belongs to the tab's current page load
		const generation = currentTabGeneration(tabId);

		// Clear unsolved requests for this tab before retrying
		const moviesToRetry = { ...tabRequests };
		unsolvedRequests[tabId] = {};
		browser.storage.session.set({ unsolved_requests: unsolvedRequests });

		// Retry all failed movies and wait for completion
		const retryPromises = Object.entries(moviesToRetry).map(([title, data]) =>
			checkMovie(Number(tabId), title, data.year, data.id, generation)
		);
		await Promise.all(retryPromises);

		// Persist the retried movies before they are read back for fading
		await persistAvailableMovies();

		// Re-apply fading with updated availableMovies
		fadeUnstreamableMovies(Number(tabId), crawledMovies[tabId], generation);
	}
}

/////////////////////////////////////////////////////////////////////////////////////
//////////////////////// GET MOVIES FROM LETTERBOXD /////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

/**
 * Checks if a URL matches Letterboxd patterns.
 *
 * @param {string} url - URL to check.
 * @returns {boolean} - True if URL is a Letterboxd URL.
 */
function isLetterboxdUrl(url) {
	return url && LETTERBOXD_PATTERNS.some(pattern => url.includes(pattern));
}

/**
 * Checks if a URL is a supported Letterboxd page type.
 *
 * @param {string} url - URL to check.
 * @returns {boolean} - True if URL is a supported page.
 */
function isSupportedLetterboxdPage(url) {
	return url && SUPPORTED_PAGES.some(page => url.includes(page));
}

/**
 * Checks if a tab is ready to be processed (loaded, not discarded, and is a supported Letterboxd page).
 *
 * @param {object} tab - The tab object with url, status, and discarded properties.
 * @returns {boolean} - True if the tab can be processed.
 */
function isProcessableLetterboxdTab(tab) {
	if (tab.discarded || tab.status !== 'complete') {
		return false;
	}
	return isLetterboxdUrl(tab.url) && isSupportedLetterboxdPage(tab.url);
}

/**
 * Starts processing a Letterboxd tab by initializing state and crawling films.
 *
 * @param {number} tabId - The tabId to operate in.
 */
async function processLetterboxdTab(tabId) {
	if (!filterStatus) {
		return;
	}

	await initializeTabState(tabId);
	getFilmsFromLetterboxd(tabId);
}

/**
 * Initializes state for a tab.
 *
 * @param {number} tabId - The tab ID.
 */
async function initializeTabState(tabId) {
	// A new page load supersedes everything that is still in flight for this tab
	tabGeneration[tabId] = currentTabGeneration(tabId) + 1;

	availableMovies[tabId] = [];
	crawledMovies[tabId] = {};
	unsolvedRequests[tabId] = {};
	crawlRetryCount[tabId] = 0;

	// Persist for later service worker cycles
	await browser.storage.session.set({
		available_movies: availableMovies,
		crawled_movies: crawledMovies,
		unsolved_requests: unsolvedRequests,
	});
}

/**
 * Discards all state of a tab, in memory and in the session storage.
 * Called once a tab is really gone, so its state does not pile up for the
 * lifetime of the service worker.
 *
 * @param {number|string} tabId - The tab ID.
 */
function clearTabState(tabId) {
	delete availableMovies[tabId];
	delete crawledMovies[tabId];
	delete unsolvedRequests[tabId];
	delete crawlRetryCount[tabId];
	delete tabGeneration[tabId];

	browser.storage.session.set({
		available_movies: availableMovies,
		crawled_movies: crawledMovies,
		unsolved_requests: unsolvedRequests,
	});
}

/**
 * Injects a content script into the Letterboxd web page to crawl the movie titles and release years.
 *
 * @param {number} tabId - The tabId to operate in.
 */
async function getFilmsFromLetterboxd(tabId) {
	await browser.scripting.executeScript({
		target: { tabId, allFrames: false },
		files: ["./scripts/getFilmsFromLetterboxd.js"]
	});
}

/////////////////////////////////////////////////////////////////////////////////////
///////////////////////////// FADING ////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

/**
 * Inserts CSS and a corresponding content script in Letterboxd to add a new class and its style sheets.
 *
 * @param {number} tabId - The tabId to operate in.
 */
async function prepareLetterboxdForFading(tabId) {
	await browser.scripting.insertCSS({
		files: ["./style/hideunstreamed.css"],
		target: { tabId, allFrames: false },
	});

	browser.scripting.executeScript({
		target: { tabId, allFrames: false },
		files: ["./scripts/prepareLetterboxdForFading.js"]
	});
}

/**
 * Fades out movies that are not available on the selected streaming provider.
 *
 * @param {number} tabId - The tabId to operate in.
 * @param {object} movies - The crawled movies.
 * @param {number} generation - The tab generation this fading belongs to.
 */
function fadeUnstreamableMovies(tabId, movies, generation) {
	// The movie IDs of a superseded page load are array indices into the old
	// page's DOM. Applying them to the new page would fade the wrong posters.
	if (!isCurrentTabGeneration(tabId, generation)) {
		return;
	}

	// availableMovies[tabId] can be missing if this runs for a tab whose state
	// was torn down mid-flight (see handleRateLimitError/addMovieIfFlatrate).
	// Falling back to an empty array here would fade every movie as
	// unavailable, which is worse than doing nothing, so bail out instead.
	if (!availableMovies[tabId]) {
		return;
	}

	// Collect all movie IDs that need to be faded
	const idsToFade = [];
	for (const movie in movies) {
		for (const movieId of movies[movie].id) {
			if (!availableMovies[tabId].includes(movieId)) {
				idsToFade.push(movieId);
			}
		}
	}

	// Batch fade all movies in a single script injection
	if (idsToFade.length > 0) {
		browser.scripting.executeScript({
			target: { tabId, allFrames: false },
			func: fadeOutMovies,
			args: [CSS_CLASSES.GRID_ITEM, CSS_CLASSES.POSTER_ITEM, CSS_CLASSES.NOT_STREAMED, idsToFade],
		});
	}

	// Handle unsolved requests
	if (Object.keys(unsolvedRequests[tabId] ?? {}).length > 0) {
		browser.alarms.create("handleUnsolvedRequests", { delayInMinutes: 0.5 });
	}
}

/**
 * Content script function to fade out multiple movies.
 * Injected into the page context.
 *
 * @param {string} className - Primary class name to search.
 * @param {string} fallbackClassName - Fallback class name.
 * @param {string} fadeClass - Class to add for fading.
 * @param {number[]} movieIds - Array of movie indices to fade.
 */
function fadeOutMovies(className, fallbackClassName, fadeClass, movieIds) {
	let filmposters = document.body.getElementsByClassName(className);
	if (filmposters.length === 0) {
		filmposters = document.body.getElementsByClassName(fallbackClassName);
	}

	for (const movieId of movieIds) {
		if (filmposters[movieId]) {
			filmposters[movieId].classList.add(fadeClass);
		}
	}
}

/**
 * Unfades all movies on Letterboxd.
 *
 * @param {number} tabId - The tabId to operate in.
 */
async function unfadeAllMovies(tabId) {
	await browser.scripting.executeScript({
		target: { tabId, allFrames: false },
		func: unfadeMovies,
		args: [CSS_CLASSES.GRID_ITEM, CSS_CLASSES.POSTER_ITEM, CSS_CLASSES.NOT_STREAMED],
	});
}

/**
 * Content script function to unfade all movies.
 * Injected into the page context.
 *
 * @param {string} className - Primary class name to search.
 * @param {string} fallbackClassName - Fallback class name.
 * @param {string} fadeClass - Class to remove.
 */
function unfadeMovies(className, fallbackClassName, fadeClass) {
	let filmposters = document.body.getElementsByClassName(className);
	if (filmposters.length === 0) {
		filmposters = document.body.getElementsByClassName(fallbackClassName);
	}

	for (const poster of filmposters) {
		poster.classList.remove(fadeClass);
	}
}

/////////////////////////////////////////////////////////////////////////////////////
//////////////////////////// HELPERS ////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////

/**
 * Decodes an XOR+base64 obfuscated token using a hex nonce as key.
 *
 * @param {string} obfuscated - The base64-encoded XOR'd token.
 * @param {string} nonceHex - The per-build nonce used during obfuscation.
 * @returns {Promise<string>} - The decoded token.
 */
async function decodeToken(obfuscated, nonceHex) {
	const pepper = 'LSP::tmdb::v1';
	const keyMaterial = `${pepper}${nonceHex}`;
	const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyMaterial));
	const keyBytes = new Uint8Array(hashBuffer);
	const bytes = Uint8Array.from(atob(obfuscated), c => c.charCodeAt(0));
	return Array.from(bytes).map((b, i) => String.fromCharCode(b ^ keyBytes[i % keyBytes.length])).join('');
}

/**
 * Loads the TMDB token from the bundled config and updates fetch options.
 *
 * @returns {Promise<void>} - Resolves once fetch options are configured.
 */
async function loadTmdbToken() {
	const apiConfig = await safeFetchJson("settings/api.json", {}, "API config");
	if (!apiConfig?.json?.tmdb) {
		return;
	}

	const raw = apiConfig.json;
	const token = (raw.debug || !raw.nonce) ? raw.tmdb : await decodeToken(raw.tmdb, raw.nonce);
	setFetchOptions(token);
}

/**
 * Sets fetch options with the given API token.
 *
 * @param {string} token - The TMDB API token.
 */
function setFetchOptions(token) {
	fetchOptions = {
		method: 'GET',
		headers: {
			"Authorization": `Bearer ${token}`,
			"Accept": "application/json"
		}
	};
}

/**
 * Safely fetches a URL and parses JSON, with error handling.
 * @param {string} url - The URL to fetch.
 * @param {object} options - Fetch options.
 * @param {string} context - Context string for error messages.
 * @returns {Promise<{json: any, status: number}|null>} - Object with json and status, or null on error.
 */
async function safeFetchJson(url, options, context) {
	let response;

	try {
		response = await fetch(url, options);
	} catch (error) {
		console.error(`Failed to fetch ${context}:`, error);
		return null;
	}

	if (!response || response.status !== 200) {
		// Still return status for further error handling
		return { json: null, status: response?.status };
	}

	try {
		const json = await response.json();
		return { json, status: response.status };
	} catch (error) {
		console.error(`Failed to parse JSON for ${context}:`, error);
		return null;
	}
}
