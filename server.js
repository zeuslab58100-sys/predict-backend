const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const HIGHLIGHTLY_BASE_URL = 'https://soccer.highlightly.net';

app.use(cors());
app.use(express.json());

// ====================================================
// CACHE
// ====================================================

const memoryCache = new Map();

const CACHE_ROOT =
  process.env.PREDICT_DATA_DIR ||
  __dirname;

const CACHE_DIR =
  path.join(
    CACHE_ROOT,
    'cache',
  );

const LEAGUE_CACHE_TIME = 24 * 60 * 60 * 1000;
const RECENT_CACHE_TIME = 6 * 60 * 60 * 1000;
const MATCHDAY_PICKS_CACHE_TIME = 60 * 1000;
const SEASON_PICKS_SUMMARY_CACHE_TIME = 60 * 1000;
const MATCHDAY_PICK_SNAPSHOT_CACHE_TIME = 400 * 24 * 60 * 60 * 1000;
const HISTORICAL_STATS_CACHE_TIME = 30 * 24 * 60 * 60 * 1000;
const LEAGUE_ADVANCED_CACHE_TIME = 30 * 24 * 60 * 60 * 1000;
const ADVANCED_SAMPLE_PER_VENUE = 19;
const ADVANCED_FETCH_CONCURRENCY = 4;
const ADVANCED_RECENCY_DECAY = 0.92;
const ADVANCED_OPPOSITE_VENUE_WEIGHT = 0.70;
const CENTRAL_SERIE_A_SCHEDULE_INTERVAL = 6 * 60 * 60 * 1000;
const CENTRAL_SERIE_A_LIVE_INTERVAL = 15 * 60 * 1000;
const CENTRAL_SERIE_A_PRESTART_WINDOW = 15 * 60 * 1000;
const CENTRAL_SERIE_A_POSTSTART_WINDOW = 3 * 60 * 60 * 1000;
const CENTRAL_PREDICTION_HORIZON = 7 * 24 * 60 * 60 * 1000;
const INTERNAL_SYNC_TOKEN =
  process.env.PREDICT_INTERNAL_TOKEN ||
  crypto
    .randomBytes(32)
    .toString('hex');


// Stagione corrente mostrata nell'app.
// Lo storico usato dal modello resta 2025, ma il roster corrente è 2026.
const CURRENT_SERIE_A_SEASON = '2026';

const centralSerieAState = {
  matches: [],
  byDate: new Map(),
  lastScheduleSyncAt: null,
  lastLiveSyncAt: null,
  schedulerStartedAt: null,
  lastError: null,
  syncRunning: false,
  precomputeRunning: false,
};


async function ensureCacheDirectory() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

function sanitizeCachePart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function cacheFilePath(key) {
  return path.join(CACHE_DIR, `${sanitizeCachePart(key)}.json`);
}

function getMemoryCache(key, ttl) {
  const item = memoryCache.get(key);

  if (!item) {
    return null;
  }

  if (Date.now() - item.createdAt > ttl) {
    memoryCache.delete(key);
    return null;
  }

  return item.data;
}

function setMemoryCache(key, data) {
  memoryCache.set(key, {
    createdAt: Date.now(),
    data,
  });
}

async function getDiskCache(key, ttl) {
  try {
    const raw = await fs.readFile(
      cacheFilePath(key),
      'utf8',
    );

    const parsed = JSON.parse(raw);

    if (
      !parsed ||
      !parsed.createdAt ||
      parsed.data === undefined
    ) {
      return null;
    }

    if (Date.now() - parsed.createdAt > ttl) {
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
}

async function setDiskCache(key, data) {
  try {
    await ensureCacheDirectory();

    await fs.writeFile(
      cacheFilePath(key),
      JSON.stringify(
        {
          createdAt: Date.now(),
          data,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (error) {
    console.error(
      'Errore scrittura cache:',
      error,
    );
  }
}

// ====================================================
// HIGHLIGHTLY
// ====================================================

async function highlightlyGet(
  apiPath,
  query = {},
) {
  if (!process.env.HIGHLIGHTLY_API_KEY) {
    throw new Error(
      'HIGHLIGHTLY_API_KEY non configurata',
    );
  }

  const params = new URLSearchParams();

  Object.entries(query).forEach(
    ([key, value]) => {
      if (
        value !== undefined &&
        value !== null &&
        value.toString().trim() !== ''
      ) {
        params.set(
          key,
          value.toString(),
        );
      }
    },
  );

  const queryString = params.toString();

  const url = queryString
    ? `${HIGHLIGHTLY_BASE_URL}${apiPath}?${queryString}`
    : `${HIGHLIGHTLY_BASE_URL}${apiPath}`;

  console.log(`Highlightly GET: ${url}`);

  const response = await fetch(
    url,
    {
      method: 'GET',
      headers: {
        'x-rapidapi-key':
          process.env.HIGHLIGHTLY_API_KEY,
        Accept: 'application/json',
      },
    },
  );

  let data;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = new Error(
      `Errore Highlightly: ${response.status}`,
    );

    error.statusCode = response.status;
    error.details = data;

    throw error;
  }

  return data;
}

async function cachedHighlightlyGet({
  key,
  apiPath,
  query,
  ttl = RECENT_CACHE_TIME,
}) {
  const memory = getMemoryCache(
    key,
    ttl,
  );

  if (memory) {
    console.log(`CACHE RAM HIT: ${key}`);
    return memory;
  }

  const disk = await getDiskCache(
    key,
    ttl,
  );

  if (disk) {
    console.log(`CACHE DISK HIT: ${key}`);

    setMemoryCache(
      key,
      disk,
    );

    return disk;
  }

  console.log(`CACHE MISS: ${key}`);

  const data = await highlightlyGet(
    apiPath,
    query,
  );

  setMemoryCache(
    key,
    data,
  );

  await setDiskCache(
    key,
    data,
  );

  return data;
}

function sendApiError(
  res,
  error,
) {
  console.error(error);

  res
    .status(error.statusCode || 500)
    .json({
      error: error.statusCode
        ? 'Errore Highlightly'
        : 'Errore interno del server',

      message: error.message,

      details:
        error.details || null,
    });
}

// ====================================================
// UTILITÀ MATCH
// ====================================================

function extractMatches(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (
    !data ||
    typeof data !== 'object'
  ) {
    return [];
  }

  if (Array.isArray(data.data)) {
    return data.data;
  }

  if (Array.isArray(data.matches)) {
    return data.matches;
  }

  if (Array.isArray(data.results)) {
    return data.results;
  }

  return [];
}

function uniqueMatches(matches) {
  const map = new Map();

  for (const match of matches) {
    const key =
      match?.id ??
      [
        match?.date,
        match?.homeTeam?.id,
        match?.awayTeam?.id,
      ].join('-');

    if (!map.has(key)) {
      map.set(key, match);
    }
  }

  return Array.from(map.values());
}

function teamIdOf(team) {
  if (!team) {
    return null;
  }

  const id = team.id;

  if (
    id === undefined ||
    id === null
  ) {
    return null;
  }

  return String(id);
}

function parseScore(match) {
  const current =
    match?.state?.score?.current;

  if (typeof current === 'string') {
    const normalized =
      current.replace(':', '-');

    const parts =
      normalized.split('-');

    if (parts.length >= 2) {
      const home =
        Number.parseInt(
          parts[0].trim(),
          10,
        );

      const away =
        Number.parseInt(
          parts[1].trim(),
          10,
        );

      if (
        Number.isFinite(home) &&
        Number.isFinite(away)
      ) {
        return {
          home,
          away,
        };
      }
    }
  }

  if (
    current &&
    typeof current === 'object'
  ) {
    const home = Number(
      current.home ??
        current.homeTeam ??
        current.local,
    );

    const away = Number(
      current.away ??
        current.awayTeam ??
        current.visitor,
    );

    if (
      Number.isFinite(home) &&
      Number.isFinite(away)
    ) {
      return {
        home,
        away,
      };
    }
  }

  return null;
}

function isFinishedMatch(match) {
  const description =
    (
      match?.state?.description ??
      ''
    )
      .toString()
      .toLowerCase();

  return (
    description.includes('finished') ||
    description.includes('after penalties') ||
    description.includes('after extra time') ||
    description.includes('full time') ||
    description.includes('ended')
  );
}

// ====================================================
// STORICO LEGA
// ====================================================

async function fetchEntireLeagueSeason({
  season,
  leagueName,
  countryName,
}) {
  const limit = 100;
  let offset = 0;

  const allMatches = [];

  for (
    let page = 0;
    page < 10;
    page += 1
  ) {
    console.log(
      `Scarico stagione ${season} - pagina ${page + 1}, offset ${offset}`,
    );

    const data = await highlightlyGet(
      '/matches',
      {
        leagueName,
        countryName,
        season,
        timezone: 'Europe/Rome',
        limit: String(limit),
        offset: String(offset),
      },
    );

    const matches =
      extractMatches(data);

    if (matches.length === 0) {
      break;
    }

    allMatches.push(...matches);

    if (matches.length < limit) {
      break;
    }

    offset += limit;
  }

  return uniqueMatches(
    allMatches,
  );
}

function createEmptyStats() {
  return {
    played: 0,

    wins: 0,
    draws: 0,
    losses: 0,

    goalsFor: 0,
    goalsAgainst: 0,

    cleanSheets: 0,
    failedToScore: 0,

    over15: 0,
    over25: 0,
    over35: 0,

    bothTeamsScore: 0,
  };
}

function updateStats(
  stats,
  goalsFor,
  goalsAgainst,
) {
  stats.played += 1;

  stats.goalsFor += goalsFor;
  stats.goalsAgainst += goalsAgainst;

  if (goalsFor > goalsAgainst) {
    stats.wins += 1;
  } else if (
    goalsFor === goalsAgainst
  ) {
    stats.draws += 1;
  } else {
    stats.losses += 1;
  }

  if (goalsAgainst === 0) {
    stats.cleanSheets += 1;
  }

  if (goalsFor === 0) {
    stats.failedToScore += 1;
  }

  const totalGoals =
    goalsFor + goalsAgainst;

  if (totalGoals > 1.5) {
    stats.over15 += 1;
  }

  if (totalGoals > 2.5) {
    stats.over25 += 1;
  }

  if (totalGoals > 3.5) {
    stats.over35 += 1;
  }

  if (
    goalsFor > 0 &&
    goalsAgainst > 0
  ) {
    stats.bothTeamsScore += 1;
  }
}

function percentage(
  value,
  total,
) {
  if (total === 0) {
    return 0;
  }

  return Number(
    (
      (value / total) *
      100
    ).toFixed(2),
  );
}

function withCalculatedStats(
  stats,
) {
  const played = stats.played;

  if (played === 0) {
    return {
      ...stats,

      points: 0,
      pointsPerGame: 0,

      averageGoalsFor: 0,
      averageGoalsAgainst: 0,
      averageTotalGoals: 0,

      winPercentage: 0,
      drawPercentage: 0,
      lossPercentage: 0,

      cleanSheetPercentage: 0,
      failedToScorePercentage: 0,

      over15Percentage: 0,
      over25Percentage: 0,
      over35Percentage: 0,

      bothTeamsScorePercentage: 0,
    };
  }

  const points =
    stats.wins * 3 +
    stats.draws;

  return {
    ...stats,

    points,

    pointsPerGame:
      Number(
        (
          points / played
        ).toFixed(2),
      ),

    averageGoalsFor:
      Number(
        (
          stats.goalsFor /
          played
        ).toFixed(2),
      ),

    averageGoalsAgainst:
      Number(
        (
          stats.goalsAgainst /
          played
        ).toFixed(2),
      ),

    averageTotalGoals:
      Number(
        (
          (
            stats.goalsFor +
            stats.goalsAgainst
          ) /
          played
        ).toFixed(2),
      ),

    winPercentage:
      percentage(
        stats.wins,
        played,
      ),

    drawPercentage:
      percentage(
        stats.draws,
        played,
      ),

    lossPercentage:
      percentage(
        stats.losses,
        played,
      ),

    cleanSheetPercentage:
      percentage(
        stats.cleanSheets,
        played,
      ),

    failedToScorePercentage:
      percentage(
        stats.failedToScore,
        played,
      ),

    over15Percentage:
      percentage(
        stats.over15,
        played,
      ),

    over25Percentage:
      percentage(
        stats.over25,
        played,
      ),

    over35Percentage:
      percentage(
        stats.over35,
        played,
      ),

    bothTeamsScorePercentage:
      percentage(
        stats.bothTeamsScore,
        played,
      ),
  };
}

function buildTeamHistory(
  matches,
  teamId,
) {
  const wantedTeamId =
    String(teamId);

  const overall =
    createEmptyStats();

  const home =
    createEmptyStats();

  const away =
    createEmptyStats();

  const completedMatches = [];

  for (const match of matches) {
    if (!isFinishedMatch(match)) {
      continue;
    }

    const score =
      parseScore(match);

    if (!score) {
      continue;
    }

    const homeTeamId =
      teamIdOf(
        match.homeTeam,
      );

    const awayTeamId =
      teamIdOf(
        match.awayTeam,
      );

    const isHome =
      homeTeamId ===
      wantedTeamId;

    const isAway =
      awayTeamId ===
      wantedTeamId;

    if (!isHome && !isAway) {
      continue;
    }

    const goalsFor =
      isHome
        ? score.home
        : score.away;

    const goalsAgainst =
      isHome
        ? score.away
        : score.home;

    updateStats(
      overall,
      goalsFor,
      goalsAgainst,
    );

    if (isHome) {
      updateStats(
        home,
        goalsFor,
        goalsAgainst,
      );
    }

    if (isAway) {
      updateStats(
        away,
        goalsFor,
        goalsAgainst,
      );
    }

    let result = 'D';

    if (goalsFor > goalsAgainst) {
      result = 'W';
    } else if (
      goalsFor < goalsAgainst
    ) {
      result = 'L';
    }

    completedMatches.push({
      ...match,

      predictAnalysis: {
        teamId: wantedTeamId,
        venue:
          isHome
            ? 'home'
            : 'away',
        goalsFor,
        goalsAgainst,
        result,
      },
    });
  }

  completedMatches.sort(
    (a, b) => {
      const dateA =
        new Date(
          a.date ?? 0,
        ).getTime();

      const dateB =
        new Date(
          b.date ?? 0,
        ).getTime();

      return dateB - dateA;
    },
  );

  return {
    overall:
      withCalculatedStats(
        overall,
      ),

    home:
      withCalculatedStats(
        home,
      ),

    away:
      withCalculatedStats(
        away,
      ),

    matches:
      completedMatches,
  };
}

function buildLeagueHistory(
  matches,
  {
    season,
    leagueName,
    countryName,
  },
) {
  const teamMap =
    new Map();

  for (const match of matches) {
    const home =
      match?.homeTeam;

    const away =
      match?.awayTeam;

    const homeId =
      teamIdOf(home);

    const awayId =
      teamIdOf(away);

    if (
      homeId &&
      !teamMap.has(homeId)
    ) {
      teamMap.set(
        homeId,
        {
          id: homeId,
          name:
            home?.name ?? '',
          logo:
            home?.logo ?? null,
        },
      );
    }

    if (
      awayId &&
      !teamMap.has(awayId)
    ) {
      teamMap.set(
        awayId,
        {
          id: awayId,
          name:
            away?.name ?? '',
          logo:
            away?.logo ?? null,
        },
      );
    }
  }

  const teams = [];

  for (
    const team of teamMap.values()
  ) {
    const history =
      buildTeamHistory(
        matches,
        team.id,
      );

    teams.push({
      ...team,

      completedMatches:
        history.matches.length,

      summary: {
        overall:
          history.overall,

        home:
          history.home,

        away:
          history.away,
      },

      matches:
        history.matches,
    });
  }

  teams.sort(
    (a, b) =>
      a.name.localeCompare(
        b.name,
      ),
  );

  const completedLeagueMatches =
    matches.filter(
      (match) =>
        isFinishedMatch(match) &&
        parseScore(match),
    );

  return {
    season:
      String(season),

    leagueName,
    countryName,

    fetchedMatches:
      matches.length,

    completedMatches:
      completedLeagueMatches.length,

    teamsCount:
      teams.length,

    teams,
  };
}

function buildLeagueCacheKey({
  season,
  leagueName,
  countryName,
}) {
  return [
    'league-history',
    season,
    leagueName,
    countryName,
  ].join('-');
}

async function getLeagueHistory({
  season,
  leagueName,
  countryName,
}) {
  const cacheKey =
    buildLeagueCacheKey({
      season,
      leagueName,
      countryName,
    });

  const memory =
    getMemoryCache(
      cacheKey,
      LEAGUE_CACHE_TIME,
    );

  if (memory) {
    console.log(
      `CACHE RAM HIT: ${cacheKey}`,
    );

    return {
      data: memory,
      cacheSource: 'memory',
    };
  }

  const disk =
    await getDiskCache(
      cacheKey,
      LEAGUE_CACHE_TIME,
    );

  if (disk) {
    console.log(
      `CACHE DISK HIT: ${cacheKey}`,
    );

    setMemoryCache(
      cacheKey,
      disk,
    );

    return {
      data: disk,
      cacheSource: 'disk',
    };
  }

  console.log(
    `CACHE MISS: ${cacheKey}`,
  );

  const matches =
    await fetchEntireLeagueSeason({
      season,
      leagueName,
      countryName,
    });

  const leagueHistory =
    buildLeagueHistory(
      matches,
      {
        season,
        leagueName,
        countryName,
      },
    );

  setMemoryCache(
    cacheKey,
    leagueHistory,
  );

  await setDiskCache(
    cacheKey,
    leagueHistory,
  );

  return {
    data:
      leagueHistory,

    cacheSource:
      'api',
  };
}


// ====================================================
// FALLBACK SQUADRE NON PRESENTI NELLA SERIE A STORICA
// (es. neopromosse nella stagione corrente)
// ====================================================

function isCupOrFriendlyLeagueName(name) {
  const value = String(name ?? '').toLowerCase();

  return (
    value.includes('friendly') ||
    value.includes('friendlies') ||
    value.includes('coppa') ||
    value.includes('cup') ||
    value.includes('champions') ||
    value.includes('europa') ||
    value.includes('conference') ||
    value.includes('super cup') ||
    value.includes('supercoppa')
  );
}

function pickPrimaryDomesticLeagueMatches(matches) {
  const finished = matches.filter(
    (match) =>
      isFinishedMatch(match) &&
      parseScore(match),
  );

  const domesticCandidates = finished.filter(
    (match) =>
      !isCupOrFriendlyLeagueName(
        match?.league?.name,
      ),
  );

  const source =
    domesticCandidates.length > 0
      ? domesticCandidates
      : finished;

  if (source.length === 0) {
    return {
      leagueName: null,
      matches: [],
    };
  }

  const counts = new Map();

  for (const match of source) {
    const name =
      String(
        match?.league?.name ??
          'Unknown',
      );

    counts.set(
      name,
      (counts.get(name) ?? 0) + 1,
    );
  }

  const primaryLeague =
    Array.from(counts.entries())
      .sort(
        (a, b) =>
          b[1] - a[1],
      )[0]?.[0] ?? null;

  if (!primaryLeague) {
    return {
      leagueName: null,
      matches: source,
    };
  }

  return {
    leagueName:
      primaryLeague,

    matches:
      source.filter(
        (match) =>
          String(
            match?.league?.name ??
              '',
          ) ===
          primaryLeague,
      ),
  };
}

async function fetchTeamSeasonMatches({
  teamId,
  season,
}) {
  const cacheKey =
    `team-season-all-${teamId}-${season}`;

  const memory =
    getMemoryCache(
      cacheKey,
      LEAGUE_CACHE_TIME,
    );

  if (memory) {
    return memory;
  }

  const disk =
    await getDiskCache(
      cacheKey,
      LEAGUE_CACHE_TIME,
    );

  if (disk) {
    setMemoryCache(
      cacheKey,
      disk,
    );

    return disk;
  }

  const [
    homeData,
    awayData,
  ] = await Promise.all([
    highlightlyGet(
      '/matches',
      {
        homeTeamId:
          teamId,

        season,

        timezone:
          'Europe/Rome',

        limit:
          '100',

        offset:
          '0',
      },
    ),

    highlightlyGet(
      '/matches',
      {
        awayTeamId:
          teamId,

        season,

        timezone:
          'Europe/Rome',

        limit:
          '100',

        offset:
          '0',
      },
    ),
  ]);

  const matches =
    uniqueMatches([
      ...extractMatches(
        homeData,
      ),
      ...extractMatches(
        awayData,
      ),
    ]);

  setMemoryCache(
    cacheKey,
    matches,
  );

  await setDiskCache(
    cacheKey,
    matches,
  );

  return matches;
}

function findTeamIdentity(
  matches,
  teamId,
) {
  const wanted =
    String(teamId);

  for (const match of matches) {
    const homeId =
      teamIdOf(
        match?.homeTeam,
      );

    if (homeId === wanted) {
      return {
        id:
          wanted,

        name:
          match?.homeTeam?.name ??
          '',

        logo:
          match?.homeTeam?.logo ??
          null,
      };
    }

    const awayId =
      teamIdOf(
        match?.awayTeam,
      );

    if (awayId === wanted) {
      return {
        id:
          wanted,

        name:
          match?.awayTeam?.name ??
          '',

        logo:
          match?.awayTeam?.logo ??
          null,
      };
    }
  }

  return {
    id:
      wanted,

    name:
      '',

    logo:
      null,
  };
}

async function buildFallbackHistoricalTeam({
  teamId,
  season,
}) {
  const cacheKey =
    `fallback-team-history-${teamId}-${season}-v3`;

  const memory =
    getMemoryCache(
      cacheKey,
      LEAGUE_CACHE_TIME,
    );

  if (memory) {
    return memory;
  }

  const disk =
    await getDiskCache(
      cacheKey,
      LEAGUE_CACHE_TIME,
    );

  if (disk) {
    setMemoryCache(
      cacheKey,
      disk,
    );

    return disk;
  }

  console.log(
    `Fallback storico per team ${teamId}, stagione ${season}`,
  );

  let sourceMatches = [];
  let sourceLeagueName = null;
  let sourceType = 'historical-league';

  // Primo tentativo:
  // recuperiamo tutte le partite della stagione 2025 della squadra
  // e individuiamo il campionato domestico principale.
  try {
    const allMatches =
      await fetchTeamSeasonMatches({
        teamId,
        season,
      });

    const primary =
      pickPrimaryDomesticLeagueMatches(
        allMatches,
      );

    if (
      primary.matches.length > 0
    ) {
      sourceMatches =
        primary.matches;

      sourceLeagueName =
        primary.leagueName;
    }
  } catch (error) {
    console.warn(
      `Fallback stagione non disponibile per team ${teamId}: ${error.message}`,
    );
  }

  // Secondo tentativo:
  // alcune neopromosse non vengono restituite correttamente dal filtro
  // stagionale del provider. In quel caso usiamo le ultime partite reali
  // disponibili, privilegiando gare ufficiali rispetto alle amichevoli.
  if (
    sourceMatches.length === 0
  ) {
    try {
      const recentData =
        await cachedHighlightlyGet({
          key:
            `last-five-${teamId}`,

          apiPath:
            '/last-five-games',

          query: {
            teamId,
          },
        });

      const recentMatches =
        extractMatches(
          recentData,
        ).filter(
          (match) =>
            isFinishedMatch(
              match,
            ) &&
            parseScore(match),
        );

      const officialMatches =
        recentMatches.filter(
          (match) =>
            !String(
              match?.league?.name ??
                '',
            )
              .toLowerCase()
              .includes(
                'friendly',
              ),
        );

      sourceMatches =
        officialMatches.length >= 2
          ? officialMatches
          : recentMatches;

      sourceLeagueName =
        sourceMatches[0]
          ?.league?.name ??
        'Ultime partite';

      sourceType =
        'recent-fallback';
    } catch (error) {
      console.warn(
        `Fallback ultime partite non disponibile per team ${teamId}: ${error.message}`,
      );
    }
  }

  if (
    sourceMatches.length === 0
  ) {
    return null;
  }

  const identity =
    findTeamIdentity(
      sourceMatches,
      teamId,
    );

  const history =
    buildTeamHistory(
      sourceMatches,
      teamId,
    );

  if (
    history.overall.played === 0
  ) {
    return null;
  }

  // Se nel piccolo campione recente manca completamente casa o trasferta,
  // usiamo il rendimento complessivo come fallback prudente.
  const homeSummary =
    history.home.played > 0
      ? history.home
      : history.overall;

  const awaySummary =
    history.away.played > 0
      ? history.away
      : history.overall;

  const team = {
    ...identity,

    completedMatches:
      history.matches.length,

    summary: {
      overall:
        history.overall,

      home:
        homeSummary,

      away:
        awaySummary,
    },

    matches:
      history.matches,

    historicalSource:
      sourceType,

    sourceLeagueName,

    sourceSeason:
      String(season),
  };

  setMemoryCache(
    cacheKey,
    team,
  );

  await setDiskCache(
    cacheKey,
    team,
  );

  return team;
}

async function resolveHistoricalTeam({
  teamId,
  historicalLeagueHistory,
  season,
}) {
  const existing =
    historicalLeagueHistory.teams.find(
      (item) =>
        String(item.id) ===
        String(teamId),
    );

  if (existing) {
    return {
      ...existing,

      historicalSource:
        'serie-a',

      sourceLeagueName:
        historicalLeagueHistory
          .leagueName,

      sourceSeason:
        String(season),
    };
  }

  return await buildFallbackHistoricalTeam({
    teamId,
    season,
  });
}

async function buildCurrentRosterHistoricalHistory({
  historicalLeagueHistory,
  currentLeagueHistory,
  historicalSeason,
  currentSeason,
}) {
  const resolvedTeams =
    await mapWithConcurrency(
      currentLeagueHistory.teams ?? [],
      2,
      async (currentTeam) => {
        const resolved =
          await resolveHistoricalTeam({
            teamId:
              currentTeam.id,

            historicalLeagueHistory,

            season:
              historicalSeason,
          });

        if (!resolved) {
          return {
            ...currentTeam,

            completedMatches:
              0,

            summary: {
              overall:
                withCalculatedStats(
                  createEmptyStats(),
                ),

              home:
                withCalculatedStats(
                  createEmptyStats(),
                ),

              away:
                withCalculatedStats(
                  createEmptyStats(),
                ),
            },

            matches:
              [],

            historicalSource:
              'none',

            sourceLeagueName:
              null,

            sourceSeason:
              String(
                historicalSeason,
              ),
          };
        }

        return {
          ...resolved,

          // Manteniamo nome/logo del roster corrente quando disponibili.
          name:
            currentTeam.name ||
            resolved.name,

          logo:
            currentTeam.logo ||
            resolved.logo,
        };
      },
    );

  return {
    season:
      String(
        historicalSeason,
      ),

    rosterSeason:
      String(
        currentSeason,
      ),

    leagueName:
      historicalLeagueHistory
        .leagueName,

    countryName:
      historicalLeagueHistory
        .countryName,

    fetchedMatches:
      historicalLeagueHistory
        .fetchedMatches,

    completedMatches:
      historicalLeagueHistory
        .completedMatches,

    teamsCount:
      resolvedTeams.length,

    teams:
      resolvedTeams,
  };
}

// ====================================================
// MODELLO PREDICT V1
// ====================================================

function clamp(
  value,
  min,
  max,
) {
  return Math.min(
    Math.max(value, min),
    max,
  );
}

function round2(value) {
  return Number(
    value.toFixed(2),
  );
}

function competitionWeight(match) {
  const name =
    (
      match?.league?.name ??
      ''
    )
      .toString()
      .toLowerCase();

  if (
    name.includes('friendly') ||
    name.includes('friendlies')
  ) {
    return 0.35;
  }

  if (
    name.includes('serie a')
  ) {
    return 1.0;
  }

  if (
    name.includes('coppa') ||
    name.includes('cup') ||
    name.includes('uefa') ||
    name.includes('champions') ||
    name.includes('europa')
  ) {
    return 0.75;
  }

  return 0.65;
}

function buildRecentSnapshot(
  matches,
  teamId,
) {
  const wantedTeamId =
    String(teamId);

  let totalWeight = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let points = 0;
  let usedMatches = 0;

  for (const match of matches) {
    const score =
      parseScore(match);

    if (!score) {
      continue;
    }

    const homeId =
      teamIdOf(
        match.homeTeam,
      );

    const awayId =
      teamIdOf(
        match.awayTeam,
      );

    const isHome =
      homeId ===
      wantedTeamId;

    const isAway =
      awayId ===
      wantedTeamId;

    if (!isHome && !isAway) {
      continue;
    }

    const gf =
      isHome
        ? score.home
        : score.away;

    const ga =
      isHome
        ? score.away
        : score.home;

    const weight =
      competitionWeight(match);

    totalWeight += weight;
    goalsFor += gf * weight;
    goalsAgainst += ga * weight;

    if (gf > ga) {
      points += 3 * weight;
    } else if (gf === ga) {
      points += 1 * weight;
    }

    usedMatches += 1;
  }

  if (totalWeight === 0) {
    return {
      matches: 0,
      averageGoalsFor: null,
      averageGoalsAgainst: null,
      pointsPerGame: null,
    };
  }

  return {
    matches: usedMatches,

    averageGoalsFor:
      round2(
        goalsFor / totalWeight,
      ),

    averageGoalsAgainst:
      round2(
        goalsAgainst / totalWeight,
      ),

    pointsPerGame:
      round2(
        points / totalWeight,
      ),
  };
}

function calculateLeagueAverages(
  teams,
) {
  let homePlayed = 0;
  let homeGoals = 0;

  let awayPlayed = 0;
  let awayGoals = 0;

  for (const team of teams) {
    const home =
      team?.summary?.home;

    const away =
      team?.summary?.away;

    if (home) {
      homePlayed +=
        Number(home.played || 0);

      homeGoals +=
        Number(home.goalsFor || 0);
    }

    if (away) {
      awayPlayed +=
        Number(away.played || 0);

      awayGoals +=
        Number(away.goalsFor || 0);
    }
  }

  return {
    homeGoals:
      homePlayed > 0
        ? homeGoals /
          homePlayed
        : 1.4,

    awayGoals:
      awayPlayed > 0
        ? awayGoals /
          awayPlayed
        : 1.1,
  };
}

function safeStrength(
  value,
  baseline,
) {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(baseline) ||
    baseline <= 0
  ) {
    return 1;
  }

  return clamp(
    value / baseline,
    0.35,
    2.5,
  );
}

function factorial(n) {
  let result = 1;

  for (
    let i = 2;
    i <= n;
    i += 1
  ) {
    result *= i;
  }

  return result;
}

function poissonProbability(
  lambda,
  goals,
) {
  return (
    Math.exp(-lambda) *
    Math.pow(lambda, goals) /
    factorial(goals)
  );
}

function normalizeThree(
  home,
  draw,
  away,
) {
  const total =
    home + draw + away;

  if (total <= 0) {
    return {
      home: 1 / 3,
      draw: 1 / 3,
      away: 1 / 3,
    };
  }

  return {
    home:
      home / total,

    draw:
      draw / total,

    away:
      away / total,
  };
}

function poissonOneXTwo(
  homeLambda,
  awayLambda,
) {
  let home = 0;
  let draw = 0;
  let away = 0;

  for (
    let homeGoals = 0;
    homeGoals <= 10;
    homeGoals += 1
  ) {
    const homeProbability =
      poissonProbability(
        homeLambda,
        homeGoals,
      );

    for (
      let awayGoals = 0;
      awayGoals <= 10;
      awayGoals += 1
    ) {
      const awayProbability =
        poissonProbability(
          awayLambda,
          awayGoals,
        );

      const probability =
        homeProbability *
        awayProbability;

      if (
        homeGoals >
        awayGoals
      ) {
        home += probability;
      } else if (
        homeGoals ===
        awayGoals
      ) {
        draw += probability;
      } else {
        away += probability;
      }
    }
  }

  return normalizeThree(
    home,
    draw,
    away,
  );
}

function totalGoalsOverProbability(
  totalLambda,
  line,
) {
  const maxUnderGoals =
    Math.floor(line);

  let underOrEqual = 0;

  for (
    let goals = 0;
    goals <= maxUnderGoals;
    goals += 1
  ) {
    underOrEqual +=
      poissonProbability(
        totalLambda,
        goals,
      );
  }

  return clamp(
    1 - underOrEqual,
    0,
    1,
  );
}

function blendProbability(
  poissonValue,
  empiricalValue,
  poissonWeight = 0.75,
) {
  return clamp(
    poissonValue *
      poissonWeight +
      empiricalValue *
        (1 - poissonWeight),
    0.01,
    0.99,
  );
}

function buildExactScores(
  homeLambda,
  awayLambda,
) {
  const scores = [];

  for (
    let homeGoals = 0;
    homeGoals <= 6;
    homeGoals += 1
  ) {
    for (
      let awayGoals = 0;
      awayGoals <= 6;
      awayGoals += 1
    ) {
      const probability =
        poissonProbability(
          homeLambda,
          homeGoals,
        ) *
        poissonProbability(
          awayLambda,
          awayGoals,
        );

      scores.push({
        score:
          `${homeGoals}-${awayGoals}`,

        probability:
          round2(
            probability * 100,
          ),
      });
    }
  }

  scores.sort(
    (a, b) =>
      b.probability -
      a.probability,
  );

  return scores.slice(0, 3);
}

function strongestOutcome(
  values,
) {
  return Object.entries(values)
    .sort(
      (a, b) =>
        b[1] - a[1],
    )[0];
}

function calculatePrediction({
  homeTeam,
  awayTeam,
  homeRecentMatches,
  awayRecentMatches,
  headToHeadMatches,
  leagueHistory,
}) {
  const homeVenue =
    homeTeam.summary.home;

  const awayVenue =
    awayTeam.summary.away;

  const leagueAverage =
    calculateLeagueAverages(
      leagueHistory.teams,
    );

  const homeAttackStrength =
    safeStrength(
      Number(
        homeVenue.averageGoalsFor,
      ),
      leagueAverage.homeGoals,
    );

  const awayDefenseWeakness =
    safeStrength(
      Number(
        awayVenue.averageGoalsAgainst,
      ),
      leagueAverage.homeGoals,
    );

  const awayAttackStrength =
    safeStrength(
      Number(
        awayVenue.averageGoalsFor,
      ),
      leagueAverage.awayGoals,
    );

  const homeDefenseWeakness =
    safeStrength(
      Number(
        homeVenue.averageGoalsAgainst,
      ),
      leagueAverage.awayGoals,
    );

  const seasonHomeLambda =
    leagueAverage.homeGoals *
    homeAttackStrength *
    awayDefenseWeakness;

  const seasonAwayLambda =
    leagueAverage.awayGoals *
    awayAttackStrength *
    homeDefenseWeakness;

  const homeRecent =
    buildRecentSnapshot(
      homeRecentMatches,
      homeTeam.id,
    );

  const awayRecent =
    buildRecentSnapshot(
      awayRecentMatches,
      awayTeam.id,
    );

  let homeLambda =
    seasonHomeLambda;

  let awayLambda =
    seasonAwayLambda;

  if (
    homeRecent.averageGoalsFor !== null &&
    awayRecent.averageGoalsAgainst !== null
  ) {
    const recentHomeComponent =
      (
        homeRecent.averageGoalsFor +
        awayRecent.averageGoalsAgainst
      ) /
      2;

    homeLambda =
      seasonHomeLambda * 0.82 +
      recentHomeComponent * 0.18;
  }

  if (
    awayRecent.averageGoalsFor !== null &&
    homeRecent.averageGoalsAgainst !== null
  ) {
    const recentAwayComponent =
      (
        awayRecent.averageGoalsFor +
        homeRecent.averageGoalsAgainst
      ) /
      2;

    awayLambda =
      seasonAwayLambda * 0.82 +
      recentAwayComponent * 0.18;
  }

  homeLambda =
    clamp(
      homeLambda,
      0.25,
      3.5,
    );

  awayLambda =
    clamp(
      awayLambda,
      0.25,
      3.5,
    );

  const poisson1x2 =
    poissonOneXTwo(
      homeLambda,
      awayLambda,
    );

  const empirical1x2 =
    normalizeThree(
      (
        Number(
          homeVenue.winPercentage,
        ) +
        Number(
          awayVenue.lossPercentage,
        )
      ) /
        200,

      (
        Number(
          homeVenue.drawPercentage,
        ) +
        Number(
          awayVenue.drawPercentage,
        )
      ) /
        200,

      (
        Number(
          homeVenue.lossPercentage,
        ) +
        Number(
          awayVenue.winPercentage,
        )
      ) /
        200,
    );

  const blended1x2 =
    normalizeThree(
      poisson1x2.home *
        0.82 +
        empirical1x2.home *
          0.18,

      poisson1x2.draw *
        0.82 +
        empirical1x2.draw *
          0.18,

      poisson1x2.away *
        0.82 +
        empirical1x2.away *
          0.18,
    );

  const totalLambda =
    homeLambda +
    awayLambda;

  const poissonGG =
    (
      1 -
      Math.exp(-homeLambda)
    ) *
    (
      1 -
      Math.exp(-awayLambda)
    );

  const empiricalGG =
    (
      Number(
        homeVenue.bothTeamsScorePercentage,
      ) +
      Number(
        awayVenue.bothTeamsScorePercentage,
      )
    ) /
    200;

  const gg =
    blendProbability(
      poissonGG,
      empiricalGG,
      0.75,
    );

  const poissonOver15 =
    totalGoalsOverProbability(
      totalLambda,
      1.5,
    );

  const poissonOver25 =
    totalGoalsOverProbability(
      totalLambda,
      2.5,
    );

  const poissonOver35 =
    totalGoalsOverProbability(
      totalLambda,
      3.5,
    );

  const empiricalOver15 =
    (
      Number(
        homeVenue.over15Percentage,
      ) +
      Number(
        awayVenue.over15Percentage,
      )
    ) /
    200;

  const empiricalOver25 =
    (
      Number(
        homeVenue.over25Percentage,
      ) +
      Number(
        awayVenue.over25Percentage,
      )
    ) /
    200;

  const empiricalOver35 =
    (
      Number(
        homeVenue.over35Percentage,
      ) +
      Number(
        awayVenue.over35Percentage,
      )
    ) /
    200;

  const over15 =
    blendProbability(
      poissonOver15,
      empiricalOver15,
    );

  const over25 =
    blendProbability(
      poissonOver25,
      empiricalOver25,
    );

  const over35 =
    blendProbability(
      poissonOver35,
      empiricalOver35,
    );

  const oneXTwoPercent = {
    home:
      round2(
        blended1x2.home *
        100,
      ),

    draw:
      round2(
        blended1x2.draw *
        100,
      ),

    away:
      round2(
        blended1x2.away *
        100,
      ),
  };

  const goalPercent = {
    gg:
      round2(gg * 100),

    noGoal:
      round2(
        (1 - gg) * 100,
      ),

    over15:
      round2(
        over15 * 100,
      ),

    under15:
      round2(
        (1 - over15) *
        100,
      ),

    over25:
      round2(
        over25 * 100,
      ),

    under25:
      round2(
        (1 - over25) *
        100,
      ),

    over35:
      round2(
        over35 * 100,
      ),

    under35:
      round2(
        (1 - over35) *
        100,
      ),
  };

  const strongest1x2 =
    strongestOutcome({
      '1': oneXTwoPercent.home,
      'X': oneXTwoPercent.draw,
      '2': oneXTwoPercent.away,
    });

  const strongestGG =
    strongestOutcome({
      'GG': goalPercent.gg,
      'NG': goalPercent.noGoal,
    });

  const strongestOU25 =
    strongestOutcome({
      'Over 2.5':
        goalPercent.over25,

      'Under 2.5':
        goalPercent.under25,
    });

  const topSignals = [
    {
      label:
        strongest1x2[0],

      probability:
        strongest1x2[1],

      reason:
        'Esito più probabile nel modello 1X2',

      market:
        'oneXTwo',
    },

    {
      label:
        strongestGG[0],

      probability:
        strongestGG[1],

      reason:
        'Segnale Goal / No Goal',

      market:
        'goals',
    },

    {
      label:
        strongestOU25[0],

      probability:
        strongestOU25[1],

      reason:
        'Segnale principale sulla linea 2.5',

      market:
        'goals',
    },
  ].sort(
    (a, b) =>
      b.probability -
      a.probability,
  );

  const h2hSnapshot =
    buildRecentSnapshot(
      headToHeadMatches,
      homeTeam.id,
    );

  const minimumVenueSample =
    Math.min(
      Number(
        homeVenue.played || 0,
      ),
      Number(
        awayVenue.played || 0,
      ),
    );

  const dataCoverage =
    minimumVenueSample >= 15
      ? 'alta'
      : minimumVenueSample >= 8
        ? 'media'
        : 'bassa';

  return {
    modelVersion:
      'PREDICT v5',

    modelDescription:
      'Poisson + casa/trasferta + forma recente + statistiche avanzate ponderate su campione esteso',

    dataCoverage,

    expectedGoals: {
      home:
        round2(homeLambda),

      away:
        round2(awayLambda),

      total:
        round2(
          totalLambda,
        ),
    },

    oneXTwo:
      oneXTwoPercent,

    goals:
      goalPercent,

    exactScores:
      buildExactScores(
        homeLambda,
        awayLambda,
      ),

    topSignals,

    inputs: {
      leagueAverageHomeGoals:
        round2(
          leagueAverage.homeGoals,
        ),

      leagueAverageAwayGoals:
        round2(
          leagueAverage.awayGoals,
        ),

      homeRecent,

      awayRecent,

      headToHeadSample:
        h2hSnapshot.matches,

      note:
        'Gli H2H sono mostrati come contesto ma non pesano direttamente sul modello v4.',
    },
  };
}


// ====================================================
// STATISTICHE AVANZATE: CORNER, TIRI IN PORTA, CARTELLINI
// ====================================================

function parseNumericStatistic(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? value
      : null;
  }

  const normalized = String(value)
    .replace(',', '.')
    .replace('%', '')
    .trim();

  const parsed = Number.parseFloat(normalized);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function normalizeStatisticName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findStatisticValue(statistics, aliases) {
  if (!Array.isArray(statistics)) {
    return null;
  }

  const normalizedAliases = aliases.map(
    normalizeStatisticName,
  );

  for (const statistic of statistics) {
    const name = normalizeStatisticName(
      statistic?.displayName ??
        statistic?.name ??
        statistic?.type,
    );

    if (!name) {
      continue;
    }

    const matched = normalizedAliases.some(
      (alias) =>
        name === alias ||
        name.includes(alias) ||
        alias.includes(name),
    );

    if (!matched) {
      continue;
    }

    const parsed = parseNumericStatistic(
      statistic?.value,
    );

    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function extractTeamAdvancedStats(
  statisticsPayload,
  teamId,
) {
  if (!Array.isArray(statisticsPayload)) {
    return null;
  }

  const wantedTeamId = String(teamId);

  const teamBlock = statisticsPayload.find(
    (item) =>
      String(item?.team?.id ?? '') ===
      wantedTeamId,
  );

  if (!teamBlock) {
    return null;
  }

  const statistics = teamBlock.statistics;

  const corners = findStatisticValue(
    statistics,
    [
      'corners',
      'corner kicks',
      'corner kick',
      'total corners',
    ],
  );

  const shotsOnTarget = findStatisticValue(
    statistics,
    [
      'shots on target',
      'shots on goal',
      'shots target',
      'on target',
    ],
  );

  const yellowCards = findStatisticValue(
    statistics,
    [
      'yellow cards',
      'yellow card',
    ],
  );

  const redCards = findStatisticValue(
    statistics,
    [
      'red cards',
      'red card',
    ],
  );

  const cards =
    yellowCards === null &&
    redCards === null
      ? null
      : (yellowCards ?? 0) +
        (redCards ?? 0);

  return {
    corners,
    shotsOnTarget,
    yellowCards,
    redCards,
    cards,
  };
}

async function getHistoricalMatchStatistics(
  matchId,
) {
  const key = `statistics-${matchId}`;

  const memory = getMemoryCache(
    key,
    HISTORICAL_STATS_CACHE_TIME,
  );

  if (memory) {
    if (memory.__unavailable === true) {
      return null;
    }

    return memory;
  }

  const disk = await getDiskCache(
    key,
    HISTORICAL_STATS_CACHE_TIME,
  );

  if (disk) {
    setMemoryCache(key, disk);

    if (disk.__unavailable === true) {
      return null;
    }

    return disk;
  }

  try {
    const data = await highlightlyGet(
      `/statistics/${matchId}`,
      {},
    );

    setMemoryCache(key, data);
    await setDiskCache(key, data);

    return data;
  } catch (error) {
    if (error.statusCode === 404) {
      const unavailable = {
        __unavailable: true,
      };

      setMemoryCache(
        key,
        unavailable,
      );

      await setDiskCache(
        key,
        unavailable,
      );

      console.log(
        `Statistiche non disponibili per match ${matchId}`,
      );

      return null;
    }

    // Highlightly può restituire occasionalmente 5xx per alcune
    // statistiche storiche. Non facciamo fallire tutta l'analisi:
    // ignoriamo quel singolo match e usiamo gli altri del campione.
    if (
      error.statusCode >= 500 &&
      error.statusCode <= 599
    ) {
      console.warn(
        `Statistiche temporaneamente non disponibili per match ${matchId} (${error.statusCode})`,
      );

      return null;
    }

    // Errori di autenticazione, rate limit o altri errori client
    // restano visibili perché richiedono un intervento reale.
    throw error;
  }
}


async function getCachedHistoricalMatchStatistics(
  matchId,
) {
  const key = `statistics-${matchId}`;

  const memory =
    getMemoryCache(
      key,
      HISTORICAL_STATS_CACHE_TIME,
    );

  if (memory) {
    return memory.__unavailable === true
      ? null
      : memory;
  }

  const disk =
    await getDiskCache(
      key,
      HISTORICAL_STATS_CACHE_TIME,
    );

  if (disk) {
    setMemoryCache(
      key,
      disk,
    );

    return disk.__unavailable === true
      ? null
      : disk;
  }

  return null;
}

function createAdvancedAccumulator() {
  return {
    matchesWithAnyData: 0,

    cornersForTotal: 0,
    cornersForCount: 0,
    cornersForWeight: 0,

    cornersAgainstTotal: 0,
    cornersAgainstCount: 0,
    cornersAgainstWeight: 0,

    shotsOnTargetForTotal: 0,
    shotsOnTargetForCount: 0,
    shotsOnTargetForWeight: 0,

    shotsOnTargetAgainstTotal: 0,
    shotsOnTargetAgainstCount: 0,
    shotsOnTargetAgainstWeight: 0,

    cardsForTotal: 0,
    cardsForCount: 0,
    cardsForWeight: 0,

    cardsAgainstTotal: 0,
    cardsAgainstCount: 0,
    cardsAgainstWeight: 0,
  };
}

function addAdvancedValue(
  accumulator,
  key,
  value,
  weight = 1,
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value) ||
    !Number.isFinite(weight) ||
    weight <= 0
  ) {
    return;
  }

  accumulator[`${key}Total`] +=
    value * weight;

  accumulator[`${key}Count`] += 1;

  accumulator[`${key}Weight`] +=
    weight;
}

function averageAccumulatorValue(
  accumulator,
  key,
) {
  const weight =
    accumulator[`${key}Weight`];

  if (!weight) {
    return null;
  }

  return (
    accumulator[`${key}Total`] /
    weight
  );
}

function advancedMatchWeight({
  match,
  team,
  targetVenue,
  recencyIndex,
}) {
  const actualVenue =
    String(
      match?.predictAnalysis?.venue ??
        '',
    );

  const venueWeight =
    actualVenue === targetVenue
      ? 1
      : ADVANCED_OPPOSITE_VENUE_WEIGHT;

  // PREDICT v5:
  // 1-5   = forma molto recente
  // 6-10  = trend recente
  // 11-15 = trend medio
  // 16-19 = base stagionale
  let recencyWeight = 0.35;

  if (recencyIndex < 5) {
    recencyWeight = 1.00;
  } else if (recencyIndex < 10) {
    recencyWeight = 0.78;
  } else if (recencyIndex < 15) {
    recencyWeight = 0.55;
  } else {
    recencyWeight = 0.35;
  }

  return (
    venueWeight *
    recencyWeight
  );
}

async function buildVenueAdvancedSample({
  team,
  venue,
  sampleSize = 3,
}) {
  const validMatches = (team.matches ?? [])
    .filter(
      (match) =>
        match?.id !== undefined &&
        match?.id !== null,
    );

  const preferredMatches = validMatches
    .filter(
      (match) =>
        match?.predictAnalysis?.venue === venue,
    );

  const fallbackMatches = validMatches
    .filter(
      (match) =>
        match?.predictAnalysis?.venue !== venue,
    );

  const selectedMatches = [
    ...preferredMatches,
    ...fallbackMatches,
  ]
    .filter(
      (match, index, list) =>
        list.findIndex(
          (item) =>
            String(item.id) ===
            String(match.id),
        ) === index,
    )
    .slice(0, sampleSize);

  const payloads = await Promise.all(
    selectedMatches.map(
      (match) =>
        getHistoricalMatchStatistics(
          match.id,
        ),
    ),
  );

  const accumulator =
    createAdvancedAccumulator();

  for (
    let index = 0;
    index < selectedMatches.length;
    index += 1
  ) {
    const match = selectedMatches[index];
    const payload = payloads[index];

    if (!payload) {
      continue;
    }

    const isHome =
      String(match?.homeTeam?.id ?? '') ===
      String(team.id);

    const opponentId = isHome
      ? match?.awayTeam?.id
      : match?.homeTeam?.id;

    const own = extractTeamAdvancedStats(
      payload,
      team.id,
    );

    const opponent = extractTeamAdvancedStats(
      payload,
      opponentId,
    );

    if (!own && !opponent) {
      continue;
    }

    accumulator.matchesWithAnyData += 1;

    const weight =
      advancedMatchWeight({
        match,
        team,
        targetVenue:
          venue,
        recencyIndex:
          index,
      });

    addAdvancedValue(
      accumulator,
      'cornersFor',
      own?.corners,
      weight,
    );

    addAdvancedValue(
      accumulator,
      'cornersAgainst',
      opponent?.corners,
      weight,
    );

    addAdvancedValue(
      accumulator,
      'shotsOnTargetFor',
      own?.shotsOnTarget,
      weight,
    );

    addAdvancedValue(
      accumulator,
      'shotsOnTargetAgainst',
      opponent?.shotsOnTarget,
      weight,
    );

    addAdvancedValue(
      accumulator,
      'cardsFor',
      own?.cards,
      weight,
    );

    addAdvancedValue(
      accumulator,
      'cardsAgainst',
      opponent?.cards,
      weight,
    );
  }

  return {
    requestedMatches:
      selectedMatches.length,

    matchesWithAnyData:
      accumulator.matchesWithAnyData,

    cornersFor:
      averageAccumulatorValue(
        accumulator,
        'cornersFor',
      ),

    cornersAgainst:
      averageAccumulatorValue(
        accumulator,
        'cornersAgainst',
      ),

    shotsOnTargetFor:
      averageAccumulatorValue(
        accumulator,
        'shotsOnTargetFor',
      ),

    shotsOnTargetAgainst:
      averageAccumulatorValue(
        accumulator,
        'shotsOnTargetAgainst',
      ),

    cardsFor:
      averageAccumulatorValue(
        accumulator,
        'cardsFor',
      ),

    cardsAgainst:
      averageAccumulatorValue(
        accumulator,
        'cardsAgainst',
      ),
  };
}

function combineAdvancedExpectation(
  attackingValue,
  opponentConcededValue,
) {
  const available = [
    attackingValue,
    opponentConcededValue,
  ].filter(
    (value) =>
      value !== null &&
      value !== undefined &&
      Number.isFinite(value),
  );

  if (available.length === 0) {
    return null;
  }

  return available.reduce(
    (sum, value) => sum + value,
    0,
  ) / available.length;
}

function createAdvancedMetric({
  homeExpected,
  awayExpected,
  homeSample,
  awaySample,
}) {
  if (
    homeExpected === null ||
    awayExpected === null ||
    !Number.isFinite(homeExpected) ||
    !Number.isFinite(awayExpected)
  ) {
    return {
      available: false,
      reason:
        'Statistiche insufficienti nel campione disponibile',
    };
  }

  const totalExpected =
    homeExpected + awayExpected;

  const line =
    Math.max(
      0.5,
      Math.floor(totalExpected) + 0.5,
    );

  const overProbability =
    totalGoalsOverProbability(
      totalExpected,
      line,
    );

  return {
    available: true,

    homeExpected:
      round2(homeExpected),

    awayExpected:
      round2(awayExpected),

    totalExpected:
      round2(totalExpected),

    line:
      round2(line),

    overProbability:
      round2(
        overProbability * 100,
      ),

    underProbability:
      round2(
        (1 - overProbability) * 100,
      ),

    sample: {
      homeVenueMatches:
        homeSample.matchesWithAnyData,

      awayVenueMatches:
        awaySample.matchesWithAnyData,
    },
  };
}

function buildLeagueAdvancedCacheKey({
  season,
  leagueName,
  countryName,
  sampleSize,
  rosterSeason,
}) {
  return [
    'league-advanced-v5',
    season,
    leagueName,
    countryName,
    `roster${rosterSeason ?? season}`,
    `s${sampleSize}`,
  ].join('-');
}

function collectLeagueAdvancedSelection(
  leagueHistory,
  sampleSize = ADVANCED_SAMPLE_PER_VENUE,
) {
  const uniqueMatches = new Map();
  const selectedByTeam = new Map();

  for (const team of leagueHistory.teams ?? []) {
    const matches = team.matches ?? [];

    const validMatches = matches
      .filter(
        (match) =>
          match?.id !== undefined &&
          match?.id !== null,
      );

    const homeVenueMatches = validMatches
      .filter(
        (match) =>
          match?.predictAnalysis?.venue === 'home',
      );

    const awayVenueMatches = validMatches
      .filter(
        (match) =>
          match?.predictAnalysis?.venue === 'away',
      );

    const homeMatches = [
      ...homeVenueMatches,
      ...awayVenueMatches,
    ]
      .filter(
        (match, index, list) =>
          list.findIndex(
            (item) =>
              String(item.id) ===
              String(match.id),
          ) === index,
      )
      .slice(0, sampleSize);

    const awayMatches = [
      ...awayVenueMatches,
      ...homeVenueMatches,
    ]
      .filter(
        (match, index, list) =>
          list.findIndex(
            (item) =>
              String(item.id) ===
              String(match.id),
          ) === index,
      )
      .slice(0, sampleSize);

    selectedByTeam.set(
      String(team.id),
      {
        home: homeMatches,
        away: awayMatches,
      },
    );

    for (
      const match of [
        ...homeMatches,
        ...awayMatches,
      ]
    ) {
      uniqueMatches.set(
        String(match.id),
        match,
      );
    }
  }

  return {
    uniqueMatches:
      Array.from(
        uniqueMatches.values(),
      ),

    selectedByTeam,
  };
}

async function mapWithConcurrency(
  items,
  concurrency,
  worker,
) {
  const results =
    new Array(items.length);

  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index =
        nextIndex;

      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      results[index] =
        await worker(
          items[index],
          index,
        );
    }
  }

  const workerCount =
    Math.max(
      1,
      Math.min(
        concurrency,
        items.length || 1,
      ),
    );

  await Promise.all(
    Array.from(
      {
        length:
          workerCount,
      },
      () =>
        runWorker(),
    ),
  );

  return results;
}

function buildAdvancedSampleFromPayloads({
  team,
  selectedMatches,
  statisticsByMatchId,
  targetVenue,
}) {
  const accumulator =
    createAdvancedAccumulator();

  for (
    let index = 0;
    index < selectedMatches.length;
    index += 1
  ) {
    const match =
      selectedMatches[index];

    const payload =
      statisticsByMatchId.get(
        String(match.id),
      );

    if (!payload) {
      continue;
    }

    const isHome =
      String(
        match?.homeTeam?.id ??
          '',
      ) ===
      String(team.id);

    const opponentId =
      isHome
        ? match?.awayTeam?.id
        : match?.homeTeam?.id;

    const own =
      extractTeamAdvancedStats(
        payload,
        team.id,
      );

    const opponent =
      extractTeamAdvancedStats(
        payload,
        opponentId,
      );

    if (!own && !opponent) {
      continue;
    }

    accumulator.matchesWithAnyData +=
      1;

    const weight =
      advancedMatchWeight({
        match,
        team,
        targetVenue,
        recencyIndex:
          index,
      });

    addAdvancedValue(
      accumulator,
      'cornersFor',
      own?.corners,
      weight,
    );

    addAdvancedValue(
      accumulator,
      'cornersAgainst',
      opponent?.corners,
      weight,
    );

    addAdvancedValue(
      accumulator,
      'shotsOnTargetFor',
      own?.shotsOnTarget,
      weight,
    );

    addAdvancedValue(
      accumulator,
      'shotsOnTargetAgainst',
      opponent?.shotsOnTarget,
      weight,
    );

    addAdvancedValue(
      accumulator,
      'cardsFor',
      own?.cards,
      weight,
    );

    addAdvancedValue(
      accumulator,
      'cardsAgainst',
      opponent?.cards,
      weight,
    );
  }

  return {
    requestedMatches:
      selectedMatches.length,

    matchesWithAnyData:
      accumulator.matchesWithAnyData,

    cornersFor:
      averageAccumulatorValue(
        accumulator,
        'cornersFor',
      ),

    cornersAgainst:
      averageAccumulatorValue(
        accumulator,
        'cornersAgainst',
      ),

    shotsOnTargetFor:
      averageAccumulatorValue(
        accumulator,
        'shotsOnTargetFor',
      ),

    shotsOnTargetAgainst:
      averageAccumulatorValue(
        accumulator,
        'shotsOnTargetAgainst',
      ),

    cardsFor:
      averageAccumulatorValue(
        accumulator,
        'cardsFor',
      ),

    cardsAgainst:
      averageAccumulatorValue(
        accumulator,
        'cardsAgainst',
      ),
  };
}

async function buildLeagueAdvancedProfiles({
  leagueHistory,
  sampleSize = ADVANCED_SAMPLE_PER_VENUE,
}) {
  const selection =
    collectLeagueAdvancedSelection(
      leagueHistory,
      sampleSize,
    );

  console.log(
    `Advanced league build: ${selection.uniqueMatches.length} match unici per ${leagueHistory.teamsCount ?? leagueHistory.teams?.length ?? 0} squadre`,
  );

  const statisticsResults =
    await mapWithConcurrency(
      selection.uniqueMatches,
      ADVANCED_FETCH_CONCURRENCY,
      async (match) => {
        const payload =
          await getHistoricalMatchStatistics(
            match.id,
          );

        return {
          matchId:
            String(match.id),

          payload,
        };
      },
    );

  const statisticsByMatchId =
    new Map();

  let matchesWithStatistics = 0;

  for (const item of statisticsResults) {
    statisticsByMatchId.set(
      item.matchId,
      item.payload,
    );

    if (item.payload) {
      matchesWithStatistics +=
        1;
    }
  }

  const teams = [];

  for (const team of leagueHistory.teams ?? []) {
    const selected =
      selection.selectedByTeam.get(
        String(team.id),
      ) ?? {
        home: [],
        away: [],
      };

    const home =
      buildAdvancedSampleFromPayloads({
        team,
        selectedMatches:
          selected.home,
        statisticsByMatchId,
        targetVenue:
          'home',
      });

    const away =
      buildAdvancedSampleFromPayloads({
        team,
        selectedMatches:
          selected.away,
        statisticsByMatchId,
        targetVenue:
          'away',
      });

    teams.push({
      id:
        String(team.id),

      name:
        team.name ?? '',

      logo:
        team.logo ?? null,

      home,
      away,
    });
  }

  return {
    sampleSizePerVenue:
      sampleSize,

    teamsCount:
      teams.length,

    uniqueMatchesRequested:
      selection.uniqueMatches.length,

    uniqueMatchesWithStatistics:
      matchesWithStatistics,

    coveragePercentage:
      selection.uniqueMatches.length > 0
        ? round2(
            (
              matchesWithStatistics /
              selection.uniqueMatches.length
            ) *
              100,
          )
        : 0,

    teams,

    note:
      'PREDICT v5: stagione avanzata completa, match deduplicati, finestre 5/10/15/19 ponderate, preferenza casa/trasferta e cache persistente.',
  };
}

async function getLeagueAdvancedProfiles({
  leagueHistory,
  season,
  leagueName,
  countryName,
  sampleSize = ADVANCED_SAMPLE_PER_VENUE,
}) {
  const cacheKey =
    buildLeagueAdvancedCacheKey({
      season,
      leagueName,
      countryName,
      sampleSize,

      rosterSeason:
        leagueHistory?.rosterSeason ??
        season,
    });

  const memory =
    getMemoryCache(
      cacheKey,
      LEAGUE_ADVANCED_CACHE_TIME,
    );

  if (memory) {
    console.log(
      `CACHE RAM HIT: ${cacheKey}`,
    );

    return {
      data:
        memory,

      cacheSource:
        'memory',
    };
  }

  const disk =
    await getDiskCache(
      cacheKey,
      LEAGUE_ADVANCED_CACHE_TIME,
    );

  if (disk) {
    console.log(
      `CACHE DISK HIT: ${cacheKey}`,
    );

    setMemoryCache(
      cacheKey,
      disk,
    );

    return {
      data:
        disk,

      cacheSource:
        'disk',
    };
  }

  console.log(
    `CACHE MISS: ${cacheKey}`,
  );

  const data =
    await buildLeagueAdvancedProfiles({
      leagueHistory,
      sampleSize,
    });

  setMemoryCache(
    cacheKey,
    data,
  );

  await setDiskCache(
    cacheKey,
    data,
  );

  return {
    data,
    cacheSource:
      'api',
  };
}

function findAdvancedTeamProfile(
  leagueAdvanced,
  teamId,
) {
  return (
    leagueAdvanced?.teams?.find(
      (team) =>
        String(team.id) ===
        String(teamId),
    ) ??
    null
  );
}

function calculateAdvancedPrediction({
  homeTeam,
  awayTeam,
  leagueAdvanced,
}) {
  const homeProfile =
    findAdvancedTeamProfile(
      leagueAdvanced,
      homeTeam.id,
    );

  const awayProfile =
    findAdvancedTeamProfile(
      leagueAdvanced,
      awayTeam.id,
    );

  const homeSample =
    homeProfile?.home ?? {
      requestedMatches: 0,
      matchesWithAnyData: 0,
      cornersFor: null,
      cornersAgainst: null,
      shotsOnTargetFor: null,
      shotsOnTargetAgainst: null,
      cardsFor: null,
      cardsAgainst: null,
    };

  const awaySample =
    awayProfile?.away ?? {
      requestedMatches: 0,
      matchesWithAnyData: 0,
      cornersFor: null,
      cornersAgainst: null,
      shotsOnTargetFor: null,
      shotsOnTargetAgainst: null,
      cardsFor: null,
      cardsAgainst: null,
    };

  const homeCorners =
    combineAdvancedExpectation(
      homeSample.cornersFor,
      awaySample.cornersAgainst,
    );

  const awayCorners =
    combineAdvancedExpectation(
      awaySample.cornersFor,
      homeSample.cornersAgainst,
    );

  const homeShotsOnTarget =
    combineAdvancedExpectation(
      homeSample.shotsOnTargetFor,
      awaySample.shotsOnTargetAgainst,
    );

  const awayShotsOnTarget =
    combineAdvancedExpectation(
      awaySample.shotsOnTargetFor,
      homeSample.shotsOnTargetAgainst,
    );

  const homeCards =
    combineAdvancedExpectation(
      homeSample.cardsFor,
      awaySample.cardsAgainst,
    );

  const awayCards =
    combineAdvancedExpectation(
      awaySample.cardsFor,
      homeSample.cardsAgainst,
    );

  return {
    sample: {
      requestedPerTeam:
        leagueAdvanced
          ?.sampleSizePerVenue ??
        ADVANCED_SAMPLE_PER_VENUE,

      homeVenueMatches:
        homeSample.matchesWithAnyData,

      awayVenueMatches:
        awaySample.matchesWithAnyData,

      leagueTeams:
        leagueAdvanced
          ?.teamsCount ??
        0,

      leagueCoverage:
        leagueAdvanced
          ?.coveragePercentage ??
        0,
    },

    corners:
      createAdvancedMetric({
        homeExpected:
          homeCorners,
        awayExpected:
          awayCorners,
        homeSample,
        awaySample,
      }),

    shotsOnTarget:
      createAdvancedMetric({
        homeExpected:
          homeShotsOnTarget,
        awayExpected:
          awayShotsOnTarget,
        homeSample,
        awaySample,
      }),

    cards:
      createAdvancedMetric({
        homeExpected:
          homeCards,
        awayExpected:
          awayCards,
        homeSample,
        awaySample,
      }),

    note:
      `PREDICT v5: statistiche avanzate condivise per tutte le ${leagueAdvanced?.teamsCount ?? 0} squadre, fino a ${leagueAdvanced?.sampleSizePerVenue ?? ADVANCED_SAMPLE_PER_VENUE} gare casa + ${leagueAdvanced?.sampleSizePerVenue ?? ADVANCED_SAMPLE_PER_VENUE} trasferte, con finestre ponderate 5/10/15/stagione completa.`,
  };
}

function appendAdvancedSignals(
  prediction,
  advanced,
) {
  const candidates = [];

  const entries = [
    ['Corner', advanced?.corners],
    ['Tiri in porta', advanced?.shotsOnTarget],
    ['Cartellini', advanced?.cards],
  ];

  for (const [label, metric] of entries) {
    if (!metric?.available) {
      continue;
    }

    const overIsStronger =
      metric.overProbability >=
      metric.underProbability;

    const probability = overIsStronger
      ? metric.overProbability
      : metric.underProbability;

    if (probability < 55) {
      continue;
    }

    const market =
      label === 'Corner'
        ? 'corners'
        : label === 'Tiri in porta'
          ? 'shotsOnTarget'
          : 'cards';

    candidates.push({
      label:
        `${label} ${overIsStronger ? 'Over' : 'Under'} ${metric.line}`,

      probability,

      reason:
        `Segnale ${label.toLowerCase()} dal campione casa/trasferta ponderato`,

      market,
    });
  }

  prediction.topSignals = [
    ...(prediction.topSignals ?? []),
    ...candidates,
  ]
    .sort(
      (a, b) =>
        b.probability -
        a.probability,
    )
    .slice(0, 6);
}


// ====================================================
// AFFIDABILITÀ PREDICT V4
// ====================================================

function reliabilityLabel(score) {
  if (score >= 85) {
    return 'Molto alta';
  }

  if (score >= 72) {
    return 'Alta';
  }

  if (score >= 58) {
    return 'Media';
  }

  return 'Bassa';
}

function historicalSourceScore(team) {
  const source =
    String(
      team?.historicalSource ??
        'serie-a',
    );

  if (source === 'serie-a') {
    return 100;
  }

  if (source === 'historical-league') {
    return 82;
  }

  if (source === 'recent-fallback') {
    return 62;
  }

  return 50;
}

function sampleReliability(
  value,
  target,
) {
  if (
    !Number.isFinite(value) ||
    target <= 0
  ) {
    return 0;
  }

  return clamp(
    (value / target) * 100,
    0,
    100,
  );
}

function attachPredictionReliability({
  prediction,
  advanced,
  homeTeam,
  awayTeam,
}) {
  const homeVenuePlayed =
    Number(
      homeTeam?.summary?.home?.played ??
        0,
    );

  const awayVenuePlayed =
    Number(
      awayTeam?.summary?.away?.played ??
        0,
    );

  const seasonSample =
    sampleReliability(
      Math.min(
        homeVenuePlayed,
        awayVenuePlayed,
      ),
      15,
    );

  const homeRecentMatches =
    Number(
      prediction?.inputs?.homeRecent?.matches ??
        0,
    );

  const awayRecentMatches =
    Number(
      prediction?.inputs?.awayRecent?.matches ??
        0,
    );

  const recentSample =
    sampleReliability(
      Math.min(
        homeRecentMatches,
        awayRecentMatches,
      ),
      5,
    );

  const sourceScore =
    (
      historicalSourceScore(
        homeTeam,
      ) +
      historicalSourceScore(
        awayTeam,
      )
    ) /
    2;

  const baseScore =
    clamp(
      seasonSample * 0.55 +
      recentSample * 0.20 +
      sourceScore * 0.25,
      0,
      100,
    );

  const oneXTwo =
    round2(
      baseScore,
    );

  const goals =
    round2(
      clamp(
        seasonSample * 0.50 +
        recentSample * 0.25 +
        sourceScore * 0.25,
        0,
        100,
      ),
    );

  const exactScore =
    round2(
      goals * 0.82,
    );

  const requestedAdvanced =
    Number(
      advanced?.sample?.requestedPerTeam ??
        ADVANCED_SAMPLE_PER_VENUE,
    );

  const homeAdvanced =
    Number(
      advanced?.sample?.homeVenueMatches ??
        0,
    );

  const awayAdvanced =
    Number(
      advanced?.sample?.awayVenueMatches ??
        0,
    );

  const pairAdvanced =
    sampleReliability(
      Math.min(
        homeAdvanced,
        awayAdvanced,
      ),
      requestedAdvanced ||
        ADVANCED_SAMPLE_PER_VENUE,
    );

  const leagueCoverage =
    clamp(
      Number(
        advanced?.sample?.leagueCoverage ??
          0,
      ),
      0,
      100,
    );

  const advancedScore =
    round2(
      clamp(
        pairAdvanced * 0.60 +
        leagueCoverage * 0.20 +
        sourceScore * 0.20,
        0,
        100,
      ),
    );

  const corners =
    advanced?.corners?.available
      ? advancedScore
      : 0;

  const shotsOnTarget =
    advanced?.shotsOnTarget?.available
      ? advancedScore
      : 0;

  const cards =
    advanced?.cards?.available
      ? advancedScore
      : 0;

  const availableAdvanced =
    [
      corners,
      shotsOnTarget,
      cards,
    ].filter(
      (value) =>
        value > 0,
    );

  const advancedAverage =
    availableAdvanced.length > 0
      ? availableAdvanced.reduce(
          (sum, value) =>
            sum + value,
          0,
        ) /
        availableAdvanced.length
      : goals;

  const overall =
    round2(
      clamp(
        oneXTwo * 0.30 +
        goals * 0.30 +
        exactScore * 0.10 +
        advancedAverage * 0.30,
        0,
        100,
      ),
    );

  const reliability = {
    overall,
    overallLabel:
      reliabilityLabel(
        overall,
      ),

    oneXTwo,
    oneXTwoLabel:
      reliabilityLabel(
        oneXTwo,
      ),

    goals,
    goalsLabel:
      reliabilityLabel(
        goals,
      ),

    exactScore,
    exactScoreLabel:
      reliabilityLabel(
        exactScore,
      ),

    corners,
    cornersLabel:
      corners > 0
        ? reliabilityLabel(
            corners,
          )
        : 'N/D',

    shotsOnTarget,
    shotsOnTargetLabel:
      shotsOnTarget > 0
        ? reliabilityLabel(
            shotsOnTarget,
          )
        : 'N/D',

    cards,
    cardsLabel:
      cards > 0
        ? reliabilityLabel(
            cards,
          )
        : 'N/D',

    components: {
      seasonSample:
        round2(
          seasonSample,
        ),

      recentSample:
        round2(
          recentSample,
        ),

      sourceScore:
        round2(
          sourceScore,
        ),

      advancedSample:
        round2(
          pairAdvanced,
        ),

      leagueAdvancedCoverage:
        round2(
          leagueCoverage,
        ),
    },
  };

  prediction.reliability =
    reliability;

  prediction.dataCoverage =
    reliability.overallLabel
      .toLowerCase();

  for (
    const signal of
      prediction.topSignals ?? []
  ) {
    const market =
      signal.market ??
      'goals';

    const score =
      market === 'oneXTwo'
        ? oneXTwo
        : market === 'corners'
          ? corners
          : market === 'shotsOnTarget'
            ? shotsOnTarget
            : market === 'cards'
              ? cards
              : goals;

    signal.reliability =
      round2(
        score,
      );

    signal.reliabilityLabel =
      score > 0
        ? reliabilityLabel(
            score,
          )
        : 'N/D';
  }

  return reliability;
}

// ====================================================
// HEALTH
// ====================================================

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,
      app: 'Predict Backend',
      message: 'Backend attivo',
      environment:
        process.env.NODE_ENV ||
        'development',
      persistentStorage:
        Boolean(
          process.env
            .PREDICT_DATA_DIR,
        ),
    });
  },
);


// ====================================================
// PREDICT CENTRAL SYNC — NESSUN CLIENT CHIAMA HIGHLIGHTLY
// ====================================================

function centralApiDate(
  value,
) {
  const date =
    value instanceof Date
      ? value
      : new Date(value);

  if (
    Number.isNaN(
      date.getTime(),
    )
  ) {
    return null;
  }

  const year =
    date.getFullYear();

  const month =
    String(
      date.getMonth() + 1,
    ).padStart(
      2,
      '0',
    );

  const day =
    String(
      date.getDate(),
    ).padStart(
      2,
      '0',
    );

  return `${year}-${month}-${day}`;
}

function rebuildCentralSerieAIndex() {
  const byDate =
    new Map();

  for (
    const match
      of centralSerieAState.matches
  ) {
    const dateKey =
      centralApiDate(
        match?.date,
      );

    if (!dateKey) {
      continue;
    }

    if (!byDate.has(dateKey)) {
      byDate.set(
        dateKey,
        [],
      );
    }

    byDate
      .get(dateKey)
      .push(match);
  }

  for (
    const matches
      of byDate.values()
  ) {
    matches.sort(
      (a, b) =>
        Date.parse(
          a?.date ?? '',
        ) -
        Date.parse(
          b?.date ?? '',
        ),
    );
  }

  centralSerieAState.byDate =
    byDate;
}

function mergeCentralSerieAMatches(
  incoming,
) {
  const byId =
    new Map();

  for (
    const match
      of centralSerieAState.matches
  ) {
    if (
      match?.id !== undefined &&
      match?.id !== null
    ) {
      byId.set(
        String(match.id),
        match,
      );
    }
  }

  for (
    const match
      of incoming ?? []
  ) {
    if (
      match?.id !== undefined &&
      match?.id !== null
    ) {
      byId.set(
        String(match.id),
        match,
      );
    }
  }

  centralSerieAState.matches =
    Array.from(
      byId.values(),
    ).sort(
      (a, b) =>
        Date.parse(
          a?.date ?? '',
        ) -
        Date.parse(
          b?.date ?? '',
        ),
    );

  rebuildCentralSerieAIndex();
}

async function persistCentralSerieAState() {
  await setDiskCache(
    'central-serie-a-state-v2',
    {
      matches:
        centralSerieAState.matches,

      lastScheduleSyncAt:
        centralSerieAState
          .lastScheduleSyncAt,

      lastLiveSyncAt:
        centralSerieAState
          .lastLiveSyncAt,
    },
  );
}

async function restoreCentralSerieAState() {
  const disk =
    await getDiskCache(
      'central-serie-a-state-v2',
      30 * 24 * 60 * 60 * 1000,
    );

  if (
    !disk ||
    !Array.isArray(
      disk.matches,
    )
  ) {
    return false;
  }

  centralSerieAState.matches =
    disk.matches;

  centralSerieAState.lastScheduleSyncAt =
    disk.lastScheduleSyncAt ??
    null;

  centralSerieAState.lastLiveSyncAt =
    disk.lastLiveSyncAt ??
    null;

  rebuildCentralSerieAIndex();

  return true;
}

function centralLiveWindowActive(
  now = new Date(),
) {
  const nowMs =
    now.getTime();

  return centralSerieAState.matches
    .some(
      (match) => {
        const startMs =
          Date.parse(
            match?.date ?? '',
          );

        if (
          !Number.isFinite(
            startMs,
          )
        ) {
          return false;
        }

        if (
          isFinishedMatch(
            match,
          )
        ) {
          return false;
        }

        return (
          nowMs >=
            startMs -
              CENTRAL_SERIE_A_PRESTART_WINDOW &&
          nowMs <=
            startMs +
              CENTRAL_SERIE_A_POSTSTART_WINDOW
        );
      },
    );
}

async function syncCentralSerieASchedule({
  force = false,
} = {}) {
  const previous =
    Date.parse(
      centralSerieAState
        .lastScheduleSyncAt ??
      '',
    );

  if (
    !force &&
    Number.isFinite(
      previous,
    ) &&
    Date.now() - previous <
      CENTRAL_SERIE_A_SCHEDULE_INTERVAL
  ) {
    return false;
  }

  console.log(
    'PREDICT CENTRAL: sincronizzo calendario Serie A',
  );

  const matches =
    await fetchEntireLeagueSeason({
      season:
        CURRENT_SERIE_A_SEASON,

      leagueName:
        'Serie A',

      countryName:
        'Italy',
    });

  centralSerieAState.matches =
    matches;

  centralSerieAState.lastScheduleSyncAt =
    new Date()
      .toISOString();

  rebuildCentralSerieAIndex();

  await persistCentralSerieAState();

  console.log(
    `PREDICT CENTRAL: calendario aggiornato (${matches.length} partite)`,
  );

  return true;
}

async function syncCentralSerieALive() {
  if (
    !centralLiveWindowActive()
  ) {
    return false;
  }

  const today =
    centralApiDate(
      new Date(),
    );

  if (!today) {
    return false;
  }

  console.log(
    `PREDICT CENTRAL LIVE: aggiorno ${today}`,
  );

  // UNA richiesta centralizzata aggiorna tutte le partite
  // di Serie A della giornata, indipendentemente dagli utenti.
  const data =
    await highlightlyGet(
      '/matches',
      {
        date:
          today,

        leagueName:
          'Serie A',

        countryName:
          'Italy',

        season:
          CURRENT_SERIE_A_SEASON,

        timezone:
          'Europe/Rome',

        limit:
          '100',

        offset:
          '0',
      },
    );

  const matches =
    extractMatches(
      data,
    );

  mergeCentralSerieAMatches(
    matches,
  );

  centralSerieAState.lastLiveSyncAt =
    new Date()
      .toISOString();

  await persistCentralSerieAState();

  console.log(
    `PREDICT CENTRAL LIVE: ${matches.length} partite aggiornate`,
  );

  return true;
}

async function precomputeUpcomingPredictData() {
  if (
    centralSerieAState.precomputeRunning
  ) {
    return;
  }

  centralSerieAState.precomputeRunning =
    true;

  try {
    const now =
      Date.now();

    const upcoming =
      centralSerieAState.matches
        .filter(
          (match) => {
            const startMs =
              Date.parse(
                match?.date ?? '',
              );

            return (
              Number.isFinite(
                startMs,
              ) &&
              startMs > now &&
              startMs - now <=
                CENTRAL_PREDICTION_HORIZON
            );
          },
        );

    if (
      upcoming.length ===
      0
    ) {
      return;
    }

    console.log(
      `PREDICT CENTRAL: preparo ${upcoming.length} analisi/pronostici futuri`,
    );

    await mapWithConcurrency(
      upcoming,
      2,
      async (match) => {
        const homeTeamId =
          teamIdOf(
            match?.homeTeam,
          );

        const awayTeamId =
          teamIdOf(
            match?.awayTeam,
          );

        if (
          !homeTeamId ||
          !awayTeamId
        ) {
          return;
        }

        try {
          await getOrCreateMatchdayPickSnapshot({
            match,
            homeTeamId,
            awayTeamId,
            historicalSeason:
              '2025',
            leagueName:
              'Serie A',
            countryName:
              'Italy',
          });
        } catch (error) {
          console.warn(
            `Precompute ${homeTeamId}-${awayTeamId} non riuscito:`,
            error?.message ??
              error,
          );
        }
      },
    );
  } finally {
    centralSerieAState.precomputeRunning =
      false;
  }
}

async function settleCentralFinishedMatches() {
  const now =
    Date.now();

  const recentlyFinished =
    centralSerieAState.matches
      .filter(
        (match) => {
          const startMs =
            Date.parse(
              match?.date ?? '',
            );

          return (
            Number.isFinite(
              startMs,
            ) &&
            isFinishedMatch(
              match,
            ) &&
            now - startMs <=
              4 *
                60 *
                60 *
                1000
          );
        },
      );

  await mapWithConcurrency(
    recentlyFinished,
    2,
    async (match) => {
      // Solo il server centrale può andare al provider
      // per le statistiche finali.
      await getHistoricalMatchStatistics(
        match?.id,
      );
    },
  );
}

async function centralSerieATick() {
  if (
    centralSerieAState.syncRunning
  ) {
    return;
  }

  centralSerieAState.syncRunning =
    true;

  try {
    const scheduleChanged =
      await syncCentralSerieASchedule();

    if (
      scheduleChanged ||
      centralSerieAState.matches.length >
        0
    ) {
      await precomputeUpcomingPredictData();
    }

    const liveUpdated =
      await syncCentralSerieALive();

    if (liveUpdated) {
      await settleCentralFinishedMatches();
    }

    centralSerieAState.lastError =
      null;
  } catch (error) {
    centralSerieAState.lastError =
      error?.message ??
      String(error);

    console.error(
      'PREDICT CENTRAL ERROR:',
      centralSerieAState.lastError,
    );
  } finally {
    centralSerieAState.syncRunning =
      false;
  }
}

async function startCentralSerieAScheduler() {
  centralSerieAState.schedulerStartedAt =
    new Date()
      .toISOString();

  await restoreCentralSerieAState();

  // Primo controllo gestito dal server, non da un cliente.
  await centralSerieATick();

  setInterval(
    centralSerieATick,
    CENTRAL_SERIE_A_LIVE_INTERVAL,
  );

  console.log(
    'PREDICT CENTRAL: scheduler attivo ogni 15 minuti',
  );
}

app.get(
  '/api/football/sync-status',
  (req, res) => {
    res.json({
      ok: true,

      schedulerStartedAt:
        centralSerieAState
          .schedulerStartedAt,

      lastScheduleSyncAt:
        centralSerieAState
          .lastScheduleSyncAt,

      lastLiveSyncAt:
        centralSerieAState
          .lastLiveSyncAt,

      matchesCached:
        centralSerieAState
          .matches.length,

      liveWindowActive:
        centralLiveWindowActive(),

      lastError:
        centralSerieAState
          .lastError,
    });
  },
);

// ====================================================
// PARTITE
// ====================================================

app.get(
  '/api/football/matches',
  async (req, res) => {
    try {
      const {
        date,
        leagueName,
        leagueId,
        season,
        countryName,

        homeTeamId,
        awayTeamId,

        homeTeamName,
        awayTeamName,

        limit = '100',
        offset = '0',
      } = req.query;

      const query = {
        date,
        leagueName,
        leagueId,
        season,
        countryName,

        homeTeamId,
        awayTeamId,

        homeTeamName,
        awayTeamName,

        timezone:
          'Europe/Rome',

        limit,
        offset,
      };

      if (
        !date &&
        !leagueName &&
        !leagueId &&
        !season &&
        !countryName &&
        !homeTeamId &&
        !awayTeamId &&
        !homeTeamName &&
        !awayTeamName
      ) {
        query.date =
          new Date()
            .toISOString()
            .split('T')[0];
      }

      const centralPublicRequest =
        String(
          query.leagueName ??
          '',
        ).toLowerCase() ===
          'serie a' &&
        String(
          query.countryName ??
          '',
        ).toLowerCase() ===
          'italy' &&
        String(
          query.season ??
          '',
        ) ===
          CURRENT_SERIE_A_SEASON &&
        Boolean(
          query.date,
        ) &&
        !query.homeTeamId &&
        !query.awayTeamId &&
        !query.homeTeamName &&
        !query.awayTeamName;

      if (
        centralPublicRequest
      ) {
        return res.json({
          data:
            centralSerieAState.byDate
              .get(
                query.date,
              ) ??
            [],

          meta: {
            source:
              'predict-central-cache',

            lastScheduleSyncAt:
              centralSerieAState
                .lastScheduleSyncAt,

            lastLiveSyncAt:
              centralSerieAState
                .lastLiveSyncAt,
          },
        });
      }

      const internalRequest =
        req.get(
          'x-predict-internal',
        ) ===
        INTERNAL_SYNC_TOKEN;

      if (!internalRequest) {
        return res
          .status(403)
          .json({
            error:
              'Endpoint provider riservato al server PREDICT',
          });
      }

      const data =
        await highlightlyGet(
          '/matches',
          query,
        );

      res.json(data);
    } catch (error) {
      sendApiError(
        res,
        error,
      );
    }
  },
);

// ====================================================
// STORICO LEGA
// ====================================================

app.get(
  '/api/football/league-history',
  async (req, res) => {
    try {
      const {
        season,

        leagueName =
          'Serie A',

        countryName =
          'Italy',

        refresh =
          '0',
      } = req.query;

      if (!season) {
        return res
          .status(400)
          .json({
            error:
              'Parametro season obbligatorio',
          });
      }

      const result =
        await getLeagueHistory({
          season,
          leagueName,
          countryName,
        });

      res.json({
        ...result.data,

        cached:
          result.cacheSource !==
          'api',

        cacheSource:
          result.cacheSource,
      });
    } catch (error) {
      sendApiError(
        res,
        error,
      );
    }
  },
);

// ====================================================
// STORICO SQUADRA
// ====================================================

app.get(
  '/api/football/team-history',
  async (req, res) => {
    try {
      const {
        teamId,
        season,

        leagueName =
          'Serie A',

        countryName =
          'Italy',
      } = req.query;

      if (!teamId) {
        return res
          .status(400)
          .json({
            error:
              'Parametro teamId obbligatorio',
          });
      }

      if (!season) {
        return res
          .status(400)
          .json({
            error:
              'Parametro season obbligatorio',
          });
      }

      const result =
        await getLeagueHistory({
          season,
          leagueName,
          countryName,
        });

      const team =
        result.data.teams.find(
          (item) =>
            String(item.id) ===
            String(teamId),
        );

      if (!team) {
        return res
          .status(404)
          .json({
            error:
              'Squadra non trovata nello storico della lega',

            teamId:
              String(teamId),

            season:
              String(season),
          });
      }

      res.json({
        season:
          result.data.season,

        leagueName:
          result.data.leagueName,

        countryName:
          result.data.countryName,

        team,

        cached:
          result.cacheSource !==
          'api',

        cacheSource:
          result.cacheSource,
      });
    } catch (error) {
      sendApiError(
        res,
        error,
      );
    }
  },
);

// ====================================================
// ULTIME 5
// ====================================================

app.get(
  '/api/football/last-five',
  async (req, res) => {
    try {
      const {
        teamId,
      } = req.query;

      if (!teamId) {
        return res
          .status(400)
          .json({
            error:
              'Parametro teamId obbligatorio',
          });
      }

      const data =
        await cachedHighlightlyGet({
          key:
            `last-five-${teamId}`,

          apiPath:
            '/last-five-games',

          query: {
            teamId,
          },
        });

      res.json(data);
    } catch (error) {
      sendApiError(
        res,
        error,
      );
    }
  },
);

// ====================================================
// HEAD TO HEAD
// ====================================================

app.get(
  '/api/football/head-to-head',
  async (req, res) => {
    try {
      const {
        teamIdOne,
        teamIdTwo,
      } = req.query;

      if (
        !teamIdOne ||
        !teamIdTwo
      ) {
        return res
          .status(400)
          .json({
            error:
              'teamIdOne e teamIdTwo sono obbligatori',
          });
      }

      const ordered =
        [
          String(teamIdOne),
          String(teamIdTwo),
        ].sort();

      const data =
        await cachedHighlightlyGet({
          key:
            `h2h-${ordered[0]}-${ordered[1]}`,

          apiPath:
            '/head-2-head',

          query: {
            teamIdOne,
            teamIdTwo,
          },
        });

      res.json(data);
    } catch (error) {
      sendApiError(
        res,
        error,
      );
    }
  },
);

// ====================================================
// STATISTICHE AVANZATE DI TUTTA LA LEGA
// ====================================================

app.get(
  '/api/football/league-advanced-stats',
  async (req, res) => {
    try {
      const {
        season = '2025',

        currentSeason =
          CURRENT_SERIE_A_SEASON,

        leagueName =
          'Serie A',

        countryName =
          'Italy',

        sampleSize =
          String(
            ADVANCED_SAMPLE_PER_VENUE,
          ),
      } = req.query;

      const parsedSampleSize =
        Math.max(
          1,
          Math.min(
            19,
            Number.parseInt(
              sampleSize,
              10,
            ) ||
              ADVANCED_SAMPLE_PER_VENUE,
          ),
        );

      const [
        historicalResult,
        currentResult,
      ] = await Promise.all([
        getLeagueHistory({
          season,
          leagueName,
          countryName,
        }),

        getLeagueHistory({
          season:
            currentSeason,

          leagueName,
          countryName,
        }),
      ]);

      const currentRosterHistory =
        await buildCurrentRosterHistoricalHistory({
          historicalLeagueHistory:
            historicalResult.data,

          currentLeagueHistory:
            currentResult.data,

          historicalSeason:
            season,

          currentSeason,
        });

      const advancedResult =
        await getLeagueAdvancedProfiles({
          leagueHistory:
            currentRosterHistory,

          season,
          leagueName,
          countryName,

          sampleSize:
            parsedSampleSize,
        });

      res.json({
        season:
          String(season),

        currentSeason:
          String(currentSeason),

        leagueName,
        countryName,

        ...advancedResult.data,

        rosterTeams:
          currentRosterHistory.teams.map(
            (team) => ({
              id:
                team.id,

              name:
                team.name,

              historicalSource:
                team.historicalSource,

              sourceLeagueName:
                team.sourceLeagueName,

              completedMatches:
                team.completedMatches,
            }),
          ),

        cached:
          advancedResult.cacheSource !==
          'api',

        cacheSource:
          advancedResult.cacheSource,
      });
    } catch (error) {
      sendApiError(
        res,
        error,
      );
    }
  },
);

// ====================================================
// ANALISI PARTITA COMPLETA
// ====================================================

app.get(
  '/api/football/match-analysis',
  async (req, res) => {
    try {
      const {
        homeTeamId,
        awayTeamId,

        season = '2025',

        leagueName =
          'Serie A',

        countryName =
          'Italy',
      } = req.query;

      if (
        !homeTeamId ||
        !awayTeamId
      ) {
        return res
          .status(400)
          .json({
            error:
              'homeTeamId e awayTeamId sono obbligatori',
          });
      }


      const analysisCacheKey = [
        'match-analysis-snapshot-v1',
        homeTeamId,
        awayTeamId,
        season,
        leagueName,
        countryName,
      ].join('-');

      const cachedAnalysisMemory =
        getMemoryCache(
          analysisCacheKey,
          14 * 24 * 60 * 60 * 1000,
        );

      if (cachedAnalysisMemory) {
        return res.json({
          ...cachedAnalysisMemory,
          cacheSource:
            'predict-analysis-memory',
        });
      }

      const cachedAnalysisDisk =
        await getDiskCache(
          analysisCacheKey,
          14 * 24 * 60 * 60 * 1000,
        );

      if (cachedAnalysisDisk) {
        setMemoryCache(
          analysisCacheKey,
          cachedAnalysisDisk,
        );

        return res.json({
          ...cachedAnalysisDisk,
          cacheSource:
            'predict-analysis-disk',
        });
      }

      const internalRequest =
        req.get(
          'x-predict-internal',
        ) ===
        INTERNAL_SYNC_TOKEN;

      if (!internalRequest) {
        return res
          .status(503)
          .json({
            error:
              'Analisi in preparazione sul server PREDICT',

            retryLater:
              true,
          });
      }

      const leagueResult =
        await getLeagueHistory({
          season,
          leagueName,
          countryName,
        });

      const [
        homeTeam,
        awayTeam,
      ] = await Promise.all([
        resolveHistoricalTeam({
          teamId:
            homeTeamId,

          historicalLeagueHistory:
            leagueResult.data,

          season,
        }),

        resolveHistoricalTeam({
          teamId:
            awayTeamId,

          historicalLeagueHistory:
            leagueResult.data,

          season,
        }),
      ]);

      if (
        !homeTeam ||
        !awayTeam
      ) {
        return res
          .status(404)
          .json({
            error:
              'Dati storici insufficienti per una o entrambe le squadre',

            homeTeamId:
              String(homeTeamId),

            awayTeamId:
              String(awayTeamId),
          });
      }

      const orderedH2H =
        [
          String(homeTeamId),
          String(awayTeamId),
        ].sort();

      const [
        homeRecentData,
        awayRecentData,
        headToHeadData,
      ] = await Promise.all([
        cachedHighlightlyGet({
          key:
            `last-five-${homeTeamId}`,

          apiPath:
            '/last-five-games',

          query: {
            teamId:
              homeTeamId,
          },
        }),

        cachedHighlightlyGet({
          key:
            `last-five-${awayTeamId}`,

          apiPath:
            '/last-five-games',

          query: {
            teamId:
              awayTeamId,
          },
        }),

        cachedHighlightlyGet({
          key:
            `h2h-${orderedH2H[0]}-${orderedH2H[1]}`,

          apiPath:
            '/head-2-head',

          query: {
            teamIdOne:
              homeTeamId,

            teamIdTwo:
              awayTeamId,
          },
        }),
      ]);

      const homeRecentMatches =
        extractMatches(
          homeRecentData,
        );

      const awayRecentMatches =
        extractMatches(
          awayRecentData,
        );

      const headToHeadMatches =
        extractMatches(
          headToHeadData,
        );

      const prediction =
        calculatePrediction({
          homeTeam,
          awayTeam,

          homeRecentMatches,
          awayRecentMatches,
          headToHeadMatches,

          // Le medie di riferimento restano quelle della Serie A 2025.
          leagueHistory:
            leagueResult.data,
        });

      // Prima proviamo l'archivio avanzato storico già presente.
      const historicalAdvancedResult =
        await getLeagueAdvancedProfiles({
          leagueHistory:
            leagueResult.data,

          season,
          leagueName,
          countryName,

          sampleSize:
            ADVANCED_SAMPLE_PER_VENUE,
        });

      let advancedData =
        historicalAdvancedResult.data;

      const missingAdvancedTeams =
        [
          homeTeam,
          awayTeam,
        ].filter(
          (team) =>
            !findAdvancedTeamProfile(
              advancedData,
              team.id,
            ),
        );

      // Per neopromosse / squadre non presenti nella Serie A storica,
      // costruiamo il profilo avanzato solo per le squadre mancanti.
      if (
        missingAdvancedTeams.length >
        0
      ) {
        const fallbackAdvanced =
          await buildLeagueAdvancedProfiles({
            leagueHistory: {
              season:
                String(season),

              rosterSeason:
                CURRENT_SERIE_A_SEASON,

              leagueName,
              countryName,

              teamsCount:
                missingAdvancedTeams.length,

              teams:
                missingAdvancedTeams,
            },

            sampleSize:
              ADVANCED_SAMPLE_PER_VENUE,
          });

        const mergedTeams =
          [
            ...(advancedData.teams ?? []),
          ];

        for (
          const team of
            fallbackAdvanced.teams ?? []
        ) {
          const exists =
            mergedTeams.some(
              (item) =>
                String(item.id) ===
                String(team.id),
            );

          if (!exists) {
            mergedTeams.push(
              team,
            );
          }
        }

        advancedData = {
          ...advancedData,

          teams:
            mergedTeams,
        };
      }

      const advanced =
        calculateAdvancedPrediction({
          homeTeam,
          awayTeam,

          leagueAdvanced:
            advancedData,
        });

      appendAdvancedSignals(
        prediction,
        advanced,
      );

      attachPredictionReliability({
        prediction,
        advanced,
        homeTeam,
        awayTeam,
      });

      const analysisPayload = {
        season:
          String(season),

        leagueName,
        countryName,

        homeTeam,
        awayTeam,

        historicalSources: {
          home: {
            source:
              homeTeam.historicalSource ??
              'serie-a',

            league:
              homeTeam.sourceLeagueName ??
              leagueName,
          },

          away: {
            source:
              awayTeam.historicalSource ??
              'serie-a',

            league:
              awayTeam.sourceLeagueName ??
              leagueName,
          },
        },

        recent: {
          home:
            homeRecentMatches,

          away:
            awayRecentMatches,
        },

        headToHead:
          headToHeadMatches,

        prediction,

        advanced,
      };

      setMemoryCache(
        analysisCacheKey,
        analysisPayload,
      );

      await setDiskCache(
        analysisCacheKey,
        analysisPayload,
      );

      res.json({
        ...analysisPayload,
        cacheSource:
          'predict-analysis-generated',
      });
    } catch (error) {
      sendApiError(
        res,
        error,
      );
    }
  },
);


// ====================================================
// PRONOSTICO UNICO PER GIORNATA
// ====================================================

function roundNumberOf(match) {
  const rawRound =
    match?.round;

  const candidates = [
    rawRound,
    rawRound?.name,
    rawRound?.round,
    rawRound?.number,
    rawRound?.current,
  ];

  for (const candidate of candidates) {
    if (
      candidate === undefined ||
      candidate === null
    ) {
      continue;
    }

    if (
      typeof candidate === 'number' &&
      Number.isFinite(candidate)
    ) {
      return candidate;
    }

    const text =
      String(candidate);

    const matches =
      text.match(
        /(\d+)(?!.*\d)/,
      );

    if (matches) {
      const value =
        Number.parseInt(
          matches[1],
          10,
        );

      if (
        Number.isFinite(value)
      ) {
        return value;
      }
    }
  }

  return null;
}

function buildMostProbablePick(
  analysis,
) {
  const prediction =
    analysis?.prediction ?? {};

  const advanced =
    analysis?.advanced ?? {};

  const homeName =
    analysis?.homeTeam?.name ??
    'Casa';

  const awayName =
    analysis?.awayTeam?.name ??
    'Ospite';

  const candidates = [];

  function addCandidate({
    label,
    probability,
    market,
    selection,
    line = null,
  }) {
    const numeric =
      Number(probability);

    if (
      !Number.isFinite(numeric)
    ) {
      return;
    }

    candidates.push({
      label,
      probability:
        round2(numeric),
      market,
      selection,
      line,
    });
  }

  addCandidate({
    label:
      `1 · ${homeName}`,
    probability:
      prediction?.oneXTwo?.home,
    market:
      '1X2',
    selection:
      'home',
  });

  addCandidate({
    label:
      'X · Pareggio',
    probability:
      prediction?.oneXTwo?.draw,
    market:
      '1X2',
    selection:
      'draw',
  });

  addCandidate({
    label:
      `2 · ${awayName}`,
    probability:
      prediction?.oneXTwo?.away,
    market:
      '1X2',
    selection:
      'away',
  });

  addCandidate({
    label:
      'GG · Entrambe segnano',
    probability:
      prediction?.goals?.gg,
    market:
      'GG/NG',
    selection:
      'gg',
  });

  addCandidate({
    label:
      'NG · No Goal',
    probability:
      prediction?.goals?.noGoal,
    market:
      'GG/NG',
    selection:
      'ng',
  });

  // Nella pagina riepilogativa usiamo solo la linea 2.5.
  // Le linee 1.5 e 3.5 restano disponibili nell'analisi completa.
  addCandidate({
    label:
      'Over 2.5',
    probability:
      prediction?.goals?.over25,
    market:
      'Under/Over',
    selection:
      'over',
    line:
      2.5,
  });

  addCandidate({
    label:
      'Under 2.5',
    probability:
      prediction?.goals?.under25,
    market:
      'Under/Over',
    selection:
      'under',
    line:
      2.5,
  });

  const advancedEntries = [
    [
      'Corner',
      advanced?.corners,
    ],
    [
      'Tiri in porta',
      advanced?.shotsOnTarget,
    ],
    [
      'Cartellini',
      advanced?.cards,
    ],
  ];

  for (
    const [label, metric]
      of advancedEntries
  ) {
    if (
      !metric?.available
    ) {
      continue;
    }

    const line =
      Number(metric.line);

    if (
      !Number.isFinite(line)
    ) {
      continue;
    }

    addCandidate({
      label:
        `${label} Over ${line}`,
      probability:
        metric.overProbability,
      market:
        label,
      selection:
        'over',
      line,
    });

    addCandidate({
      label:
        `${label} Under ${line}`,
      probability:
        metric.underProbability,
      market:
        label,
      selection:
        'under',
      line,
    });
  }

  candidates.sort(
    (a, b) =>
      b.probability -
      a.probability,
  );

  return (
    candidates[0] ??
    null
  );
}

async function evaluateMatchdayPick(
  match,
  pick,
  {
    allowProvider = false,
  } = {},
) {
  if (
    !pick ||
    !isFinishedMatch(match)
  ) {
    return {
      status:
        'pending',
      settled:
        false,
    };
  }

  const score =
    parseScore(match);

  if (!score) {
    return {
      status:
        'unavailable',
      settled:
        false,
      message:
        'Risultato finale non disponibile',
    };
  }

  const scoreLabel =
    `${score.home}-${score.away}`;

  function settled(
    won,
    actualLabel,
  ) {
    return {
      status:
        won
          ? 'won'
          : 'lost',
      settled:
        true,
      won,
      actualLabel,
      homeGoals:
        score.home,
      awayGoals:
        score.away,
    };
  }

  if (
    pick.market === '1X2'
  ) {
    let actual =
      'draw';

    if (
      score.home >
      score.away
    ) {
      actual =
        'home';
    } else if (
      score.home <
      score.away
    ) {
      actual =
        'away';
    }

    return settled(
      actual ===
        pick.selection,
      `Finale ${scoreLabel}`,
    );
  }

  if (
    pick.market === 'GG/NG'
  ) {
    const both =
      score.home > 0 &&
      score.away > 0;

    const won =
      pick.selection === 'gg'
        ? both
        : !both;

    return settled(
      won,
      `Finale ${scoreLabel}`,
    );
  }

  if (
    pick.market ===
    'Under/Over'
  ) {
    const total =
      score.home +
      score.away;

    const line =
      Number(pick.line);

    if (
      !Number.isFinite(line)
    ) {
      return {
        status:
          'unavailable',
        settled:
          false,
        message:
          'Linea non disponibile',
      };
    }

    const won =
      pick.selection === 'over'
        ? total > line
        : total < line;

    return settled(
      won,
      `Finale ${scoreLabel} · ${total} gol`,
    );
  }

  const advancedMarketMap = {
    Corner:
      'corners',
    'Tiri in porta':
      'shotsOnTarget',
    Cartellini:
      'cards',
  };

  const metricKey =
    advancedMarketMap[
      pick.market
    ];

  if (!metricKey) {
    return {
      status:
        'unavailable',
      settled:
        false,
      message:
        'Mercato non valutabile',
    };
  }

  const statistics =
    allowProvider
      ? await getHistoricalMatchStatistics(
          match?.id,
        )
      : await getCachedHistoricalMatchStatistics(
          match?.id,
        );

  if (!statistics) {
    return {
      status:
        'unavailable',
      settled:
        false,
      message:
        'Statistiche finali non disponibili',
      homeGoals:
        score.home,
      awayGoals:
        score.away,
    };
  }

  const homeTeamId =
    teamIdOf(
      match?.homeTeam,
    );

  const awayTeamId =
    teamIdOf(
      match?.awayTeam,
    );

  const homeStats =
    extractTeamAdvancedStats(
      statistics,
      homeTeamId,
    );

  const awayStats =
    extractTeamAdvancedStats(
      statistics,
      awayTeamId,
    );

  const homeValue =
    Number(
      homeStats?.[
        metricKey
      ],
    );

  const awayValue =
    Number(
      awayStats?.[
        metricKey
      ],
    );

  if (
    !Number.isFinite(
      homeValue,
    ) ||
    !Number.isFinite(
      awayValue,
    )
  ) {
    return {
      status:
        'unavailable',
      settled:
        false,
      message:
        'Dato finale del mercato non disponibile',
      homeGoals:
        score.home,
      awayGoals:
        score.away,
    };
  }

  const total =
    homeValue +
    awayValue;

  const line =
    Number(pick.line);

  if (
    !Number.isFinite(line)
  ) {
    return {
      status:
        'unavailable',
      settled:
        false,
      message:
        'Linea non disponibile',
    };
  }

  const won =
    pick.selection === 'over'
      ? total > line
      : total < line;

  return settled(
    won,
    `${pick.market}: ${round2(total)}`,
  );
}

async function getOrCreateMatchdayPickSnapshot({
  match,
  homeTeamId,
  awayTeamId,
  historicalSeason,
  leagueName,
  countryName,
}) {
  const key = [
    'matchday-pick-snapshot-v2',
    match?.id,
    historicalSeason,
    leagueName,
    countryName,
  ].join('-');

  const memory =
    getMemoryCache(
      key,
      MATCHDAY_PICK_SNAPSHOT_CACHE_TIME,
    );

  if (memory) {
    return memory;
  }

  const disk =
    await getDiskCache(
      key,
      MATCHDAY_PICK_SNAPSHOT_CACHE_TIME,
    );

  if (disk) {
    setMemoryCache(
      key,
      disk,
    );

    return disk;
  }

  const analysis =
    await internalMatchAnalysis({
      homeTeamId,
      awayTeamId,
      historicalSeason,
      leagueName,
      countryName,
    });

  const snapshot = {
    pick:
      buildMostProbablePick(
        analysis,
      ),

    modelVersion:
      analysis
        ?.prediction
        ?.modelVersion ??
      'PREDICT v5',

    generatedAt:
      new Date()
        .toISOString(),
  };

  setMemoryCache(
    key,
    snapshot,
  );

  await setDiskCache(
    key,
    snapshot,
  );

  return snapshot;
}

async function mapWithConcurrency(
  items,
  concurrency,
  mapper,
) {
  const results =
    new Array(
      items.length,
    );

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index =
        nextIndex;

      nextIndex += 1;

      if (
        index >=
        items.length
      ) {
        return;
      }

      results[index] =
        await mapper(
          items[index],
          index,
        );
    }
  }

  const workers =
    Array.from(
      {
        length:
          Math.min(
            concurrency,
            items.length,
          ),
      },
      () => worker(),
    );

  await Promise.all(
    workers,
  );

  return results;
}

async function internalMatchAnalysis({
  homeTeamId,
  awayTeamId,
  historicalSeason,
  leagueName,
  countryName,
}) {
  const params =
    new URLSearchParams({
      homeTeamId:
        String(homeTeamId),

      awayTeamId:
        String(awayTeamId),

      season:
        String(
          historicalSeason,
        ),

      leagueName:
        String(leagueName),

      countryName:
        String(countryName),
    });

  const response =
    await fetch(
      `http://127.0.0.1:${PORT}/api/football/match-analysis?${params.toString()}`,
      {
        headers: {
          'x-predict-internal':
            INTERNAL_SYNC_TOKEN,
        },
      },
    );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Analisi ${homeTeamId}-${awayTeamId} fallita: ${response.status} ${body}`,
    );
  }

  return response.json();
}

app.get(
  '/api/football/matchday-picks',
  async (req, res) => {
    try {
      const {
        round = '1',

        season =
          CURRENT_SERIE_A_SEASON,

        historicalSeason =
          '2025',

        leagueName =
          'Serie A',

        countryName =
          'Italy',

        refresh =
          '0',
      } = req.query;

      const parsedRound =
        Math.max(
          1,
          Number.parseInt(
            String(round),
            10,
          ) || 1,
        );

      const cacheKey = [
        'matchday-picks-v1',
        season,
        historicalSeason,
        parsedRound,
        leagueName,
        countryName,
      ].join('-');

      const forceRefresh =
        String(refresh) === '1';

      if (!forceRefresh) {
        const memory =
          getMemoryCache(
            cacheKey,
            MATCHDAY_PICKS_CACHE_TIME,
          );

        if (memory) {
          return res.json({
            ...memory,
            cached: true,
            cacheSource:
              'memory',
          });
        }

        const disk =
          await getDiskCache(
            cacheKey,
            MATCHDAY_PICKS_CACHE_TIME,
          );

        if (disk) {
          setMemoryCache(
            cacheKey,
            disk,
          );

          return res.json({
            ...disk,
            cached: true,
            cacheSource:
              'disk',
          });
        }
      }

      const seasonMatches =
        String(season) ===
            CURRENT_SERIE_A_SEASON &&
        String(leagueName).toLowerCase() ===
            'serie a' &&
        String(countryName).toLowerCase() ===
            'italy'
          ? centralSerieAState.matches
          : [];

      const roundMatches =
        seasonMatches
          .filter(
            (match) =>
              roundNumberOf(match) ===
              parsedRound,
          )
          .sort(
            (a, b) => {
              const aDate =
                Date.parse(
                  a?.date ?? '',
                );

              const bDate =
                Date.parse(
                  b?.date ?? '',
                );

              if (
                !Number.isFinite(
                  aDate,
                ) &&
                !Number.isFinite(
                  bDate,
                )
              ) {
                return 0;
              }

              if (
                !Number.isFinite(
                  aDate,
                )
              ) {
                return 1;
              }

              if (
                !Number.isFinite(
                  bDate,
                )
              ) {
                return -1;
              }

              return (
                aDate -
                bDate
              );
            },
          );

      if (
        roundMatches.length ===
        0
      ) {
        return res
          .status(404)
          .json({
            error:
              `Nessuna partita trovata per la giornata ${parsedRound}`,

            season:
              String(season),

            round:
              parsedRound,
          });
      }

      const picks =
        await mapWithConcurrency(
          roundMatches,
          3,
          async (match) => {
            const home =
              match?.homeTeam ?? {};

            const away =
              match?.awayTeam ?? {};

            const homeTeamId =
              teamIdOf(home);

            const awayTeamId =
              teamIdOf(away);

            const base = {
              matchId:
                match?.id ?? null,

              date:
                match?.date ?? null,

              round:
                match?.round ?? '',

              homeTeam: {
                id:
                  homeTeamId,

                name:
                  home?.name ?? '',

                logo:
                  home?.logo ?? null,
              },

              awayTeam: {
                id:
                  awayTeamId,

                name:
                  away?.name ?? '',

                logo:
                  away?.logo ?? null,
              },
            };

            if (
              !homeTeamId ||
              !awayTeamId
            ) {
              return {
                ...base,

                pick:
                  null,

                result: {
                  status:
                    'unavailable',
                  settled:
                    false,
                },

                error:
                  'ID squadre non disponibili',
              };
            }

            try {
              const snapshot =
                await getExistingMatchdayPickSnapshot({
                  matchId:
                    match?.id,
                  historicalSeason,
                  leagueName,
                  countryName,
                });

              const result =
                await evaluateMatchdayPick(
                  match,
                  snapshot?.pick,
                );

              return {
                ...base,

                pick:
                  snapshot?.pick ??
                  null,

                pickGeneratedAt:
                  snapshot
                    ?.generatedAt ??
                  null,

                modelVersion:
                  snapshot
                    ?.modelVersion ??
                  'PREDICT v5',

                result,
              };
            } catch (error) {
              console.error(
                'Errore pronostico giornata:',
                error?.message ??
                  error,
              );

              return {
                ...base,

                pick:
                  null,

                result: {
                  status:
                    'unavailable',
                  settled:
                    false,
                },

                error:
                  error?.message ??
                  'Analisi non disponibile',
              };
            }
          },
        );

      const payload = {
        season:
          String(season),

        historicalSeason:
          String(
            historicalSeason,
          ),

        leagueName,
        countryName,

        round:
          parsedRound,

        matchesCount:
          picks.length,

        generatedAt:
          new Date()
            .toISOString(),

        description:
          'Per ogni partita viene mostrato un solo pronostico principale tra 1X2, GG/NG, Under/Over 2.5, Corner, Tiri in porta e Cartellini. A partita conclusa il pronostico viene marcato come preso o sbagliato.',

        picks,
      };

      setMemoryCache(
        cacheKey,
        payload,
      );

      await setDiskCache(
        cacheKey,
        payload,
      );

      res.json({
        ...payload,

        cached: false,

        cacheSource:
          'predict-central-cache',
      });
    } catch (error) {
      sendApiError(
        res,
        error,
      );
    }
  },
);


// ====================================================
// RIEPILOGO COMPLESSIVO PRONOSTICI STAGIONE
// ====================================================

async function getExistingMatchdayPickSnapshot({
  matchId,
  historicalSeason,
  leagueName,
  countryName,
}) {
  const key = [
    'matchday-pick-snapshot-v2',
    matchId,
    historicalSeason,
    leagueName,
    countryName,
  ].join('-');

  const memory =
    getMemoryCache(
      key,
      MATCHDAY_PICK_SNAPSHOT_CACHE_TIME,
    );

  if (memory) {
    return memory;
  }

  const disk =
    await getDiskCache(
      key,
      MATCHDAY_PICK_SNAPSHOT_CACHE_TIME,
    );

  if (disk) {
    setMemoryCache(
      key,
      disk,
    );

    return disk;
  }

  return null;
}

function emptyRoundPredictSummary(
  round,
) {
  return {
    round,
    matches: 0,
    generatedPicks: 0,
    verified: 0,
    won: 0,
    lost: 0,
    pending: 0,
    unavailable: 0,
    successRate: null,
  };
}

app.get(
  '/api/football/season-picks-summary',
  async (req, res) => {
    try {
      const {
        season =
          CURRENT_SERIE_A_SEASON,

        historicalSeason =
          '2025',

        leagueName =
          'Serie A',

        countryName =
          'Italy',

        refresh =
          '0',
      } = req.query;

      const cacheKey = [
        'season-picks-summary-v1',
        season,
        historicalSeason,
        leagueName,
        countryName,
      ].join('-');

      const forceRefresh =
        String(refresh) === '1';

      if (!forceRefresh) {
        const memory =
          getMemoryCache(
            cacheKey,
            SEASON_PICKS_SUMMARY_CACHE_TIME,
          );

        if (memory) {
          return res.json({
            ...memory,
            cached: true,
            cacheSource:
              'memory',
          });
        }

        const disk =
          await getDiskCache(
            cacheKey,
            SEASON_PICKS_SUMMARY_CACHE_TIME,
          );

        if (disk) {
          setMemoryCache(
            cacheKey,
            disk,
          );

          return res.json({
            ...disk,
            cached: true,
            cacheSource:
              'disk',
          });
        }
      }

      const seasonMatches =
        String(season) ===
            CURRENT_SERIE_A_SEASON &&
        String(leagueName).toLowerCase() ===
            'serie a' &&
        String(countryName).toLowerCase() ===
            'italy'
          ? centralSerieAState.matches
          : [];

      const rounds =
        Array.from(
          {
            length: 38,
          },
          (_, index) =>
            emptyRoundPredictSummary(
              index + 1,
            ),
        );

      const totals = {
        generatedPicks: 0,
        verified: 0,
        won: 0,
        lost: 0,
        pending: 0,
        unavailable: 0,
        successRate: null,
      };

      const evaluated =
        await mapWithConcurrency(
          seasonMatches,
          4,
          async (match) => {
            const round =
              roundNumberOf(
                match,
              );

            if (
              !round ||
              round < 1 ||
              round > 38
            ) {
              return null;
            }

            const roundSummary =
              rounds[
                round - 1
              ];

            roundSummary.matches +=
              1;

            const snapshot =
              await getExistingMatchdayPickSnapshot({
                matchId:
                  match?.id,
                historicalSeason,
                leagueName,
                countryName,
              });

            if (
              !snapshot?.pick
            ) {
              return {
                round,
                hasPick: false,
              };
            }

            const result =
              await evaluateMatchdayPick(
                match,
                snapshot.pick,
              );

            return {
              round,
              hasPick: true,
              result,
            };
          },
        );

      for (
        const item of evaluated
      ) {
        if (
          !item ||
          !item.hasPick
        ) {
          continue;
        }

        const roundSummary =
          rounds[
            item.round - 1
          ];

        roundSummary
          .generatedPicks += 1;

        totals
          .generatedPicks += 1;

        const status =
          item.result?.status ??
          'pending';

        if (status === 'won') {
          roundSummary.won += 1;
          roundSummary.verified +=
            1;

          totals.won += 1;
          totals.verified += 1;
        } else if (
          status === 'lost'
        ) {
          roundSummary.lost += 1;
          roundSummary.verified +=
            1;

          totals.lost += 1;
          totals.verified += 1;
        } else if (
          status ===
          'unavailable'
        ) {
          roundSummary
            .unavailable += 1;

          totals
            .unavailable += 1;
        } else {
          roundSummary.pending +=
            1;

          totals.pending += 1;
        }
      }

      for (
        const roundSummary
          of rounds
      ) {
        roundSummary.successRate =
          roundSummary.verified >
          0
            ? round2(
                (
                  roundSummary.won /
                  roundSummary.verified
                ) *
                  100,
              )
            : null;
      }

      totals.successRate =
        totals.verified > 0
          ? round2(
              (
                totals.won /
                totals.verified
              ) *
                100,
            )
          : null;

      const payload = {
        season:
          String(season),

        historicalSeason:
          String(
            historicalSeason,
          ),

        leagueName,
        countryName,

        generatedAt:
          new Date()
            .toISOString(),

        roundsWithPredictions:
          rounds.filter(
            (round) =>
              round
                .generatedPicks >
              0,
          ).length,

        roundsWithVerifiedPicks:
          rounds.filter(
            (round) =>
              round.verified > 0,
          ).length,

        totals,

        rounds,
      };

      setMemoryCache(
        cacheKey,
        payload,
      );

      await setDiskCache(
        cacheKey,
        payload,
      );

      res.json({
        ...payload,
        cached: false,
        cacheSource:
          'snapshots/results',
      });
    } catch (error) {
      sendApiError(
        res,
        error,
      );
    }
  },
);

// ====================================================
// STATISTICHE PARTITA
// ====================================================

app.get(
  '/api/football/statistics/:matchId',
  async (req, res) => {
    try {
      const {
        matchId,
      } = req.params;

      if (!matchId) {
        return res
          .status(400)
          .json({
            error:
              'matchId obbligatorio',
          });
      }

      const data =
        await cachedHighlightlyGet({
          key:
            `statistics-${matchId}`,

          apiPath:
            `/statistics/${matchId}`,

          query: {},

          ttl:
            RECENT_CACHE_TIME,
        });

      res.json(data);
    } catch (error) {
      sendApiError(
        res,
        error,
      );
    }
  },
);

// ====================================================
// AVVIO
// ====================================================

ensureCacheDirectory()
  .catch(console.error);

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `PREDICT backend attivo sulla porta ${PORT}`,
    );

    console.log(
      `PREDICT cache directory: ${CACHE_DIR}`,
    );

    console.log(
      `PREDICT persistent storage: ${
        process.env.PREDICT_DATA_DIR
          ? 'ON'
          : 'OFF'
      }`,
    );

    startCentralSerieAScheduler()
      .catch(
        (error) => {
          console.error(
            'Avvio PREDICT CENTRAL fallito:',
            error?.message ??
              error,
          );
        },
      );

    console.log(
      `Health: http://localhost:${PORT}/health`,
    );

    console.log(
      'Football endpoints pronti:',
    );

    console.log(
      '- /api/football/matches',
    );

    console.log(
      '- /api/football/league-history?season=2025',
    );

    console.log(
      '- /api/football/team-history?teamId=...&season=2025',
    );

    console.log(
      '- /api/football/last-five?teamId=...',
    );

    console.log(
      '- /api/football/head-to-head?teamIdOne=...&teamIdTwo=...',
    );

    console.log(
      '- /api/football/league-advanced-stats?season=2025&currentSeason=2026&sampleSize=19',
    );

    console.log(
      '- /api/football/match-analysis?homeTeamId=...&awayTeamId=...&season=2025',
    );

    console.log(
      '- /api/football/matchday-picks?round=1&season=2026&historicalSeason=2025',
    );

    console.log(
      '- /api/football/season-picks-summary?season=2026&historicalSeason=2025',
    );

    console.log(
      '- /api/football/sync-status',
    );

    console.log(
      '- /api/football/statistics/:matchId',
    );
  },
);
