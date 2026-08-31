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

const SEED_CACHE_DIR =
  path.join(
    __dirname,
    'seed-cache',
  );

const LEAGUE_CACHE_TIME = 24 * 60 * 60 * 1000;
const RECENT_CACHE_TIME = 6 * 60 * 60 * 1000;
const SUPPORTED_LEAGUE_PUBLIC_MATCHES_CACHE_TIME = 2 * 60 * 1000;
const MATCHDAY_PICKS_CACHE_TIME = 60 * 1000;
const SEASON_PICKS_SUMMARY_CACHE_TIME = 60 * 1000;
const OFFICIAL_STANDINGS_CACHE_TIME = 30 * 60 * 1000;
const MATCHDAY_PICK_SNAPSHOT_CACHE_TIME = 400 * 24 * 60 * 60 * 1000;
const HISTORICAL_STATS_CACHE_TIME = 30 * 24 * 60 * 60 * 1000;
const LEAGUE_ADVANCED_CACHE_TIME = 30 * 24 * 60 * 60 * 1000;
const ADVANCED_SAMPLE_PER_VENUE = 19;
const ADVANCED_FETCH_CONCURRENCY = 4;
const ADVANCED_RECENCY_DECAY = 0.92;
const ADVANCED_OPPOSITE_VENUE_WEIGHT = 0.70;

// Progressione stagione corrente:
// con poche partite il 2025/26 resta il "prior" principale;
// giornata dopo giornata il 2026/27 pesa sempre di più.
const CURRENT_SEASON_PRIOR_MATCHES = 5;
const CURRENT_SEASON_MAX_WEIGHT = 0.90;

// Un 404 sulle statistiche appena concluse può essere temporaneo.
// I payload validi restano in cache 30 giorni, i "non disponibili"
// vengono invece riprovati dopo un'ora.
const UNAVAILABLE_STATS_CACHE_TIME = 60 * 60 * 1000;

const CENTRAL_SERIE_A_SCHEDULE_INTERVAL = 6 * 60 * 60 * 1000;
const CENTRAL_SERIE_A_LIVE_INTERVAL = 15 * 60 * 1000;
const CENTRAL_SERIE_A_PRESTART_WINDOW = 15 * 60 * 1000;
const CENTRAL_SERIE_A_POSTSTART_WINDOW = 3 * 60 * 60 * 1000;
const CENTRAL_PREDICTION_HORIZON = 10 * 24 * 60 * 60 * 1000;
const PREMATCH_PREDICTION_FREEZE_WINDOW = 60 * 60 * 1000;
const MATCHDAY_MULTIPLE_FREEZE_WINDOW = 4 * 60 * 60 * 1000;
const MATCHDAY_MULTIPLE_SNAPSHOT_CACHE_TIME = 400 * 24 * 60 * 60 * 1000;

// Archivio storico PREDICT: durata pratica di 100 anni.
// Questi record vivono sul disco persistente e non dipendono dalla RAM.
const PREDICT_HISTORY_ARCHIVE_CACHE_TIME = 100 * 365 * 24 * 60 * 60 * 1000;
const MATCHDAY_PICK_SNAPSHOT_CURRENT_VERSION = 'v3';
const MATCHDAY_PICK_SNAPSHOT_LEGACY_VERSIONS = ['v2'];
const MATCH_ANALYSIS_SNAPSHOT_CURRENT_VERSION = 'v2';
const MATCH_ANALYSIS_SNAPSHOT_LEGACY_VERSIONS = ['v1'];

const BOOKMAKER_ONLY_FROM_ROUND = 3;
const BOOKMAKER_ONLY_PREDICT_WEIGHT = 0.00;
const BOOKMAKER_ONLY_BOOKMAKER_WEIGHT = 1.00;
const MATCHDAY_PICK_BOOKMAKER_ONLY_VERSION = 'v6-bookmaker100-pure-nullfix';

function bookmakerOnlyModeForRound(round) {
  const numericRound =
    Number(round);

  return (
    Number.isFinite(numericRound) &&
    numericRound >=
      BOOKMAKER_ONLY_FROM_ROUND
  );
}

function matchdayPickSnapshotVersionForMatch(
  match,
) {
  return bookmakerOnlyModeForRound(
    roundNumberOf(match),
  )
    ? MATCHDAY_PICK_BOOKMAKER_ONLY_VERSION
    : MATCHDAY_PICK_SNAPSHOT_CURRENT_VERSION;
}

function matchdayPicksAggregatePrefixForRound(
  round,
) {
  return bookmakerOnlyModeForRound(round)
    ? 'matchday-picks-v5-bookmaker100-pure-nullfix'
    : 'matchday-picks-v2';
}

const INTERNAL_SYNC_TOKEN =
  process.env.PREDICT_INTERNAL_TOKEN ||
  crypto
    .randomBytes(32)
    .toString('hex');


// Stagione corrente mostrata nell'app.
// Il 2025/26 resta il prior storico iniziale; i risultati 2026/27
// entrano progressivamente nel modello dopo ogni partita conclusa.
const CURRENT_SERIE_A_SEASON = '2026';


// ====================================================
// CAMPIONATI SUPPORTATI
// ====================================================
// Configurazione unica delle cinque leghe PREDICT.
// In questo primo passaggio la Serie A continua a usare lo scheduler
// centrale esistente senza alcun cambiamento di comportamento.
// Le altre leghe vengono dichiarate qui come base per i passaggi successivi.
const SUPPORTED_LEAGUES = Object.freeze({
  serieA: Object.freeze({
    key: 'serie-a',
    leagueName: 'Serie A',
    countryName: 'Italy',
    currentSeason: '2026',
    historicalSeason: '2025',
    regularSeasonRounds: 38,
    languageCode: 'it',
  }),

  premierLeague: Object.freeze({
    key: 'premier-league',
    leagueName: 'Premier League',
    countryName: 'England',
    currentSeason: '2026',
    historicalSeason: '2025',
    regularSeasonRounds: 38,
    languageCode: 'en',
  }),

  bundesliga: Object.freeze({
    key: 'bundesliga',
    leagueName: 'Bundesliga',
    countryName: 'Germany',
    currentSeason: '2026',
    historicalSeason: '2025',
    regularSeasonRounds: 34,
    languageCode: 'de',
  }),

  ligue1: Object.freeze({
    key: 'ligue-1',
    leagueName: 'Ligue 1',
    countryName: 'France',
    currentSeason: '2026',
    historicalSeason: '2025',
    regularSeasonRounds: 34,
    languageCode: 'fr',
  }),

  laLiga: Object.freeze({
    key: 'la-liga',
    leagueName: 'La Liga',
    countryName: 'Spain',
    currentSeason: '2026',
    historicalSeason: '2025',
    regularSeasonRounds: 38,
    languageCode: 'es',
  }),
});

const SUPPORTED_LEAGUE_LIST =
  Object.freeze(
    Object.values(
      SUPPORTED_LEAGUES,
    ),
  );

function normalizeLeagueText(value) {
  return String(
    value ?? '',
  )
    .trim()
    .toLowerCase();
}

function resolveSupportedLeague({
  leagueName,
  countryName,
}) {
  const wantedLeague =
    normalizeLeagueText(
      leagueName,
    );

  const wantedCountry =
    normalizeLeagueText(
      countryName,
    );

  return (
    SUPPORTED_LEAGUE_LIST.find(
      (league) =>
        normalizeLeagueText(
          league.leagueName,
        ) === wantedLeague &&
        normalizeLeagueText(
          league.countryName,
        ) === wantedCountry,
    ) ??
    null
  );
}


// Endpoint pubblico usato dal frontend per conoscere i campionati
// supportati da PREDICT. In questo passaggio non cambia ancora lo scheduler:
// la Serie A continua a essere gestita dal flusso centrale esistente.
app.get(
  '/api/football/supported-leagues',
  (req, res) => {
    res.json({
      ok: true,
      leagues:
        SUPPORTED_LEAGUE_LIST.map(
          (league) => ({
            key:
              league.key,
            leagueName:
              league.leagueName,
            countryName:
              league.countryName,
            currentSeason:
              league.currentSeason,
            historicalSeason:
              league.historicalSeason,
            regularSeasonRounds:
              league.regularSeasonRounds,
            languageCode:
              league.languageCode,
          }),
        ),
    });
  },
);

const centralSerieAState = {
  matches: [],
  byDate: new Map(),

  // Revisione dinamica per squadra.
  // Parte da 0 così gli snapshot storici/seed già creati restano validi.
  // Quando termina una nuova partita, la revisione delle due squadre
  // aumenta e le future analisi usano automaticamente una nuova chiave.
  teamDataRevision: new Map(),

  // Evita di elaborare più volte lo stesso risultato dopo i successivi
  // cicli dello scheduler o dopo un riavvio del backend.
  processedFinishedMatchIds: new Set(),

  // Se il risultato è già noto ma Highlightly non ha ancora pubblicato
  // corner/tiri/cartellini finali, il match resta qui fino al recupero.
  pendingStatisticsMatchIds: new Set(),

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

async function bootstrapSeedCache() {
  await ensureCacheDirectory();

  try {
    const seedFiles =
      await fs.readdir(
        SEED_CACHE_DIR,
      );

    if (
      seedFiles.length === 0
    ) {
      console.log(
        'PREDICT seed-cache: vuota',
      );

      return;
    }

    let copied = 0;
    let existing = 0;

    for (
      const fileName
        of seedFiles
    ) {
      if (
        !fileName.endsWith(
          '.json',
        )
      ) {
        continue;
      }

      const source =
        path.join(
          SEED_CACHE_DIR,
          fileName,
        );

      const target =
        path.join(
          CACHE_DIR,
          fileName,
        );

      try {
        await fs.access(
          target,
        );

        existing += 1;
      } catch {
        await fs.copyFile(
          source,
          target,
        );

        copied += 1;
      }
    }

    console.log(
      `PREDICT seed-cache: ${copied} copiati, ${existing} già presenti`,
    );
  } catch (error) {
    if (
      error?.code ===
      'ENOENT'
    ) {
      console.log(
        'PREDICT seed-cache: cartella non presente',
      );

      return;
    }

    console.error(
      'PREDICT seed-cache error:',
      error?.message ??
        error,
    );
  }
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


async function deleteCacheKey(key) {
  memoryCache.delete(key);

  try {
    await fs.unlink(
      cacheFilePath(key),
    );
  } catch (error) {
    if (
      error?.code !==
      'ENOENT'
    ) {
      console.warn(
        `Impossibile eliminare cache ${key}:`,
        error?.message ??
          error,
      );
    }
  }
}

// ====================================================
// ARCHIVIO STORICO PERSISTENTE PREDICT
// ====================================================

async function getPermanentCache(key) {
  const memory =
    getMemoryCache(
      key,
      PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
    );

  if (memory) {
    return memory;
  }

  const disk =
    await getDiskCache(
      key,
      PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
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

async function setPermanentCache(
  key,
  data,
) {
  setMemoryCache(
    key,
    data,
  );

  await setDiskCache(
    key,
    data,
  );
}

function buildMatchdayPickSnapshotKey({
  version =
    MATCHDAY_PICK_SNAPSHOT_CURRENT_VERSION,
  matchId,
  historicalSeason,
  leagueName,
  countryName,
}) {
  return [
    `matchday-pick-snapshot-${version}`,
    matchId,
    historicalSeason,
    leagueName,
    countryName,
  ].join('-');
}

function buildMatchdayPickRecordKey({
  matchId,
  historicalSeason,
  leagueName,
  countryName,
}) {
  return [
    'matchday-pick-record-v1',
    matchId,
    historicalSeason,
    leagueName,
    countryName,
  ].join('-');
}

function buildMatchdayRoundArchiveKey({
  season,
  historicalSeason,
  round,
  leagueName,
  countryName,
}) {
  return [
    'matchday-picks-history-v1',
    season,
    historicalSeason,
    round,
    leagueName,
    countryName,
  ].join('-');
}

function buildSeasonSummaryArchiveKey({
  season,
  historicalSeason,
  leagueName,
  countryName,
}) {
  return [
    'season-picks-history-v1',
    season,
    historicalSeason,
    leagueName,
    countryName,
  ].join('-');
}

function buildMatchdayMultipleArchiveKey({
  season,
  historicalSeason,
  round,
  leagueName,
  countryName,
}) {
  return [
    'matchday-multiples-history-v1',
    season,
    historicalSeason,
    round,
    leagueName,
    countryName,
  ].join('-');
}

function buildSeasonMultiplesSummaryArchiveKey({
  season,
  historicalSeason,
  leagueName,
  countryName,
}) {
  return [
    'season-multiples-history-v1',
    season,
    historicalSeason,
    leagueName,
    countryName,
  ].join('-');
}

function buildMatchAnalysisLegacySnapshotKey({
  version = 'v1',
  homeTeamId,
  awayTeamId,
  historicalSeason,
  leagueName,
  countryName,
}) {
  return [
    `match-analysis-snapshot-${version}`,
    homeTeamId,
    awayTeamId,
    historicalSeason,
    leagueName,
    countryName,
  ].join('-');
}

function buildMatchAnalysisArchiveKey({
  homeTeamId,
  awayTeamId,
  historicalSeason,
  leagueName,
  countryName,
}) {
  const teamIds =
    new Set([
      String(homeTeamId),
      String(awayTeamId),
    ]);

  // Data-fix 1: Fiorentina-Frosinone deve usare un nuovo archivio
  // permanente, senza cancellare quello precedente creato con il
  // dato provider casa/trasferta errato di Fiorentina-Benevento.
  const archiveDataFixRevision =
    teamIds.has('427986') &&
    teamIds.has('436496')
      ? 3
      : 0;

  return [
    'match-analysis-history-v1',
    homeTeamId,
    awayTeamId,
    historicalSeason,
    leagueName,
    countryName,

    ...(archiveDataFixRevision > 0
      ? [
          'datafix',
          archiveDataFixRevision,
        ]
      : []),
  ].join('-');
}

async function getPermanentMatchAnalysisRecord({
  homeTeamId,
  awayTeamId,
  historicalSeason,
  leagueName,
  countryName,
}) {
  return getPermanentCache(
    buildMatchAnalysisArchiveKey({
      homeTeamId,
      awayTeamId,
      historicalSeason,
      leagueName,
      countryName,
    }),
  );
}

async function persistPermanentMatchAnalysis({
  homeTeamId,
  awayTeamId,
  historicalSeason,
  leagueName,
  countryName,
  analysis,
  sourceKey = null,
}) {
  if (
    !analysis ||
    typeof analysis !== 'object'
  ) {
    return null;
  }

  const key =
    buildMatchAnalysisArchiveKey({
      homeTeamId,
      awayTeamId,
      historicalSeason,
      leagueName,
      countryName,
    });

  const existing =
    await getPermanentCache(
      key,
    );

  // La prima analisi pre-match archiviata resta immutabile:
  // non deve essere riscritta da revisioni future del modello.
  if (
    existing?.analysis &&
    typeof existing.analysis === 'object'
  ) {
    return existing;
  }

  const record = {
    schemaVersion: 1,

    homeTeamId:
      String(homeTeamId),

    awayTeamId:
      String(awayTeamId),

    historicalSeason:
      String(historicalSeason),

    leagueName,
    countryName,

    analysis,

    sourceKey,

    createdAt:
      new Date()
        .toISOString(),
  };

  await setPermanentCache(
    key,
    record,
  );

  return record;
}

async function getPermanentMatchdayPickRecord({
  matchId,
  historicalSeason,
  leagueName,
  countryName,
}) {
  if (
    matchId === undefined ||
    matchId === null
  ) {
    return null;
  }

  return getPermanentCache(
    buildMatchdayPickRecordKey({
      matchId,
      historicalSeason,
      leagueName,
      countryName,
    }),
  );
}

async function persistPermanentMatchdayPickRecord({
  match = null,
  matchId = null,
  snapshot = null,
  result = null,
  historicalSeason,
  leagueName,
  countryName,
}) {
  const resolvedMatchId =
    match?.id ??
    matchId;

  if (
    resolvedMatchId === undefined ||
    resolvedMatchId === null
  ) {
    return null;
  }

  const key =
    buildMatchdayPickRecordKey({
      matchId:
        resolvedMatchId,
      historicalSeason,
      leagueName,
      countryName,
    });

  const existing =
    await getPermanentCache(
      key,
    );

  // Il primo pronostico archiviato diventa definitivo.
  // Una nuova versione del modello non può riscrivere lo storico.
  const pick =
    existing?.pick ??
    snapshot?.pick ??
    null;

  const existingResult =
    existing?.result ??
    null;

  const finalResult =
    existingResult?.settled
      ? existingResult
      : result ??
        existingResult ??
        {
          status:
            'pending',
          settled:
            false,
        };

  const nowIso =
    new Date()
      .toISOString();

  const record = {
    schemaVersion: 1,

    matchId:
      resolvedMatchId,

    historicalSeason:
      String(
        historicalSeason,
      ),

    leagueName,
    countryName,

    round:
      match
        ? roundNumberOf(
            match,
          )
        : existing?.round ??
          null,

    date:
      match?.date ??
      existing?.date ??
      null,

    homeTeam:
      match?.homeTeam ??
      existing?.homeTeam ??
      null,

    awayTeam:
      match?.awayTeam ??
      existing?.awayTeam ??
      null,

    pick,

    pickGeneratedAt:
      existing
        ?.pickGeneratedAt ??
      snapshot
        ?.generatedAt ??
      null,

    modelVersion:
      existing
        ?.modelVersion ??
      snapshot
        ?.modelVersion ??
      'PREDICT v5',

    result:
      finalResult,

    createdAt:
      existing?.createdAt ??
      nowIso,

    updatedAt:
      nowIso,
  };

  await setPermanentCache(
    key,
    record,
  );

  return record;
}

function snapshotFromPermanentRecord(
  record,
) {
  if (!record?.pick) {
    return null;
  }

  return {
    pick:
      record.pick,

    modelVersion:
      record.modelVersion ??
      'PREDICT v5',

    generatedAt:
      record.pickGeneratedAt ??
      record.createdAt ??
      null,

    historicalRecord:
      true,
  };
}

async function readMatchdayPickSnapshotVersion({
  version,
  matchId,
  historicalSeason,
  leagueName,
  countryName,
}) {
  const key =
    buildMatchdayPickSnapshotKey({
      version,
      matchId,
      historicalSeason,
      leagueName,
      countryName,
    });

  const memory =
    getMemoryCache(
      key,
      MATCHDAY_PICK_SNAPSHOT_CACHE_TIME,
    );

  if (memory) {
    return {
      key,
      snapshot:
        memory,
      source:
        'memory',
    };
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

    return {
      key,
      snapshot:
        disk,
      source:
        'disk',
    };
  }

  return {
    key,
    snapshot:
      null,
    source:
      null,
  };
}

async function migrateLegacyMatchdayPickSnapshot({
  legacyVersion,
  matchId,
  historicalSeason,
  leagueName,
  countryName,
  snapshot,
}) {
  if (!snapshot?.pick) {
    return snapshot;
  }

  const currentKey =
    buildMatchdayPickSnapshotKey({
      version:
        MATCHDAY_PICK_SNAPSHOT_CURRENT_VERSION,
      matchId,
      historicalSeason,
      leagueName,
      countryName,
    });

  const migrated = {
    ...snapshot,

    migratedFrom:
      legacyVersion,

    migratedAt:
      new Date()
        .toISOString(),
  };

  setMemoryCache(
    currentKey,
    migrated,
  );

  await setDiskCache(
    currentKey,
    migrated,
  );

  console.log(
    `PREDICT HISTORY: snapshot ${legacyVersion} -> ${MATCHDAY_PICK_SNAPSHOT_CURRENT_VERSION} migrato per match ${matchId}`,
  );

  return migrated;
}

function teamDataRevisionOf(
  teamId,
) {
  if (
    teamId === undefined ||
    teamId === null
  ) {
    return 0;
  }

  return (
    centralSerieAState
      .teamDataRevision
      .get(
        String(teamId),
      ) ??
    0
  );
}

function incrementTeamDataRevision(
  teamId,
) {
  if (
    teamId === undefined ||
    teamId === null
  ) {
    return 0;
  }

  const key =
    String(teamId);

  const next =
    teamDataRevisionOf(key) +
    1;

  centralSerieAState
    .teamDataRevision
    .set(
      key,
      next,
    );

  return next;
}

function buildMatchAnalysisCacheKey({
  homeTeamId,
  awayTeamId,
  historicalSeason,
  leagueName,
  countryName,
  cacheVariant = null,
}) {
  const homeRevision =
    teamDataRevisionOf(
      homeTeamId,
    );

  const awayRevision =
    teamDataRevisionOf(
      awayTeamId,
    );

  const matchDataFixRevision =
    String(homeTeamId) ===
      '427986' ||
    String(awayTeamId) ===
      '427986'
      ? 3
      : 0;

  const parts = [
    'match-analysis-snapshot-v2',
    homeTeamId,
    awayTeamId,
    historicalSeason,
    leagueName,
    countryName,

    ...(cacheVariant
      ? [
          'variant',
          cacheVariant,
        ]
      : []),

    ...(matchDataFixRevision > 0
      ? [
          'datafix',
          matchDataFixRevision,
        ]
      : []),
  ];

  // Revisione 0/0 = stessa chiave usata finora.
  // In questo modo tutti gli snapshot seed già pronti continuano a funzionare.
  if (
    homeRevision === 0 &&
    awayRevision === 0
  ) {
    return parts.join('-');
  }

  return [
    ...parts,
    'rev',
    homeRevision,
    awayRevision,
  ].join('-');
}


async function readLegacyMatchAnalysisSnapshot({
  homeTeamId,
  awayTeamId,
  historicalSeason,
  leagueName,
  countryName,
}) {
  for (
    const version
      of MATCH_ANALYSIS_SNAPSHOT_LEGACY_VERSIONS
  ) {
    const key =
      buildMatchAnalysisLegacySnapshotKey({
        version,
        homeTeamId,
        awayTeamId,
        historicalSeason,
        leagueName,
        countryName,
      });

    const memory =
      getMemoryCache(
        key,
        PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
      );

    if (memory) {
      return {
        key,
        version,
        snapshot:
          memory,
        source:
          'memory',
      };
    }

    const disk =
      await getDiskCache(
        key,
        PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
      );

    if (disk) {
      setMemoryCache(
        key,
        disk,
      );

      return {
        key,
        version,
        snapshot:
          disk,
        source:
          'disk',
      };
    }
  }

  return null;
}

async function migrateLegacyMatchAnalysisSnapshot({
  homeTeamId,
  awayTeamId,
  historicalSeason,
  leagueName,
  countryName,
  legacy,
}) {
  if (!legacy?.snapshot) {
    return null;
  }

  const currentKey =
    buildMatchAnalysisCacheKey({
      homeTeamId,
      awayTeamId,
      historicalSeason,
      leagueName,
      countryName,
    });

  const existingCurrentMemory =
    getMemoryCache(
      currentKey,
      PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
    );

  const existingCurrentDisk =
    existingCurrentMemory ??
    await getDiskCache(
      currentKey,
      PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
    );

  if (!existingCurrentDisk) {
    setMemoryCache(
      currentKey,
      legacy.snapshot,
    );

    await setDiskCache(
      currentKey,
      legacy.snapshot,
    );
  }

  await persistPermanentMatchAnalysis({
    homeTeamId,
    awayTeamId,
    historicalSeason,
    leagueName,
    countryName,
    analysis:
      legacy.snapshot,
    sourceKey:
      legacy.key,
  });

  console.log(
    `PREDICT HISTORY: analisi ${legacy.version} -> ${MATCH_ANALYSIS_SNAPSHOT_CURRENT_VERSION} migrata per ${homeTeamId}-${awayTeamId}`,
  );

  return (
    existingCurrentDisk ??
    legacy.snapshot
  );
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

async function getMatchOdds(matchId) {
  if (!matchId) {
    return null;
  }

  return await cachedHighlightlyGet({
    key: `odds-prematch-${matchId}`,
    apiPath: '/odds',
    query: {
      matchId,
      oddsType: 'prematch',
      limit: '5',
      offset: '0',
    },
    ttl: 30 * 60 * 1000,
  });
}


function oddsToNormalizedProbabilities(homeOdd, drawOdd, awayOdd) {
  const home = Number(homeOdd);
  const draw = Number(drawOdd);
  const away = Number(awayOdd);

  if (
    !Number.isFinite(home) ||
    !Number.isFinite(draw) ||
    !Number.isFinite(away) ||
    home <= 1 ||
    draw <= 1 ||
    away <= 1
  ) {
    return null;
  }

  const homeRaw = 1 / home;
  const drawRaw = 1 / draw;
  const awayRaw = 1 / away;

  const total = homeRaw + drawRaw + awayRaw;

  if (total <= 0) {
    return null;
  }

  return {
    home: homeRaw / total,
    draw: drawRaw / total,
    away: awayRaw / total,
  };
}

function extractOddsMarketItems(oddsPayload) {
  const marketItems = [];

  if (Array.isArray(oddsPayload?.odds)) {
    marketItems.push(...oddsPayload.odds);
  }

  if (Array.isArray(oddsPayload?.data)) {
    for (const matchOdds of oddsPayload.data) {
      if (Array.isArray(matchOdds?.odds)) {
        marketItems.push(...matchOdds.odds);
      } else if (matchOdds?.market) {
        marketItems.push(matchOdds);
      }
    }
  }

  return marketItems;
}

function normalizeProbabilityObject(values) {
  const entries =
    Object.entries(values)
      .filter(
        ([, value]) =>
          Number.isFinite(value) &&
          value > 0,
      );

  const total =
    entries.reduce(
      (sum, [, value]) =>
        sum + value,
      0,
    );

  if (total <= 0) {
    return null;
  }

  return Object.fromEntries(
    entries.map(
      ([key, value]) => [
        key,
        value / total,
      ],
    ),
  );
}

function normalizedMarketValues(item) {
  const values =
    Array.isArray(item?.values)
      ? item.values
      : [];

  const raw = {};

  for (const entry of values) {
    const label =
      String(
        entry?.value ??
        entry?.name ??
        entry?.label ??
        '',
      )
        .trim()
        .toLowerCase();

    const odd =
      Number(entry?.odd);

    if (
      !label ||
      !Number.isFinite(odd) ||
      odd <= 1
    ) {
      continue;
    }

    raw[label] =
      1 / odd;
  }

  return normalizeProbabilityObject(
    raw,
  );
}

function averageProbabilityObjects(items, keys) {
  const valid =
    items.filter(
      (item) =>
        item &&
        keys.every(
          (key) =>
            Number.isFinite(
              item[key],
            ),
        ),
    );

  if (valid.length === 0) {
    return null;
  }

  const average = {};

  for (const key of keys) {
    average[key] =
      valid.reduce(
        (sum, item) =>
          sum + item[key],
        0,
      ) /
      valid.length;
  }

  return normalizeProbabilityObject(
    average,
  );
}

function oddsMarketLine(marketName) {
  const match =
    String(marketName ?? '')
      .match(
        /(-?\d+(?:\.\d+)?)\s*$/,
      );

  if (!match) {
    return null;
  }

  const line =
    Number(match[1]);

  return Number.isFinite(line)
    ? line
    : null;
}

function buildBookmakerMarketProbabilities(oddsPayload) {
  const marketItems =
    extractOddsMarketItems(
      oddsPayload,
    );

  const oneXTwoSamples = [];
  const bttsSamples = [];
  const totalGoalsSamples = new Map();
  const totalCardsSamples = new Map();
  const totalCornersSamples = new Map();

  function addLineSample(
    target,
    line,
    probabilities,
  ) {
    if (
      line === null ||
      !probabilities ||
      !Number.isFinite(probabilities.over) ||
      !Number.isFinite(probabilities.under)
    ) {
      return;
    }

    const key =
      String(line);

    if (!target.has(key)) {
      target.set(
        key,
        [],
      );
    }

    target
      .get(key)
      .push({
        over:
          probabilities.over,
        under:
          probabilities.under,
      });
  }

  for (const item of marketItems) {
    const marketName =
      String(
        item?.market ?? '',
      ).trim();

    const market =
      marketName.toLowerCase();

    const values =
      normalizedMarketValues(
        item,
      );

    if (!values) {
      continue;
    }

    if (
      market === 'full time result' ||
      market === 'match result' ||
      market === '1x2'
    ) {
      const home =
        values.home ??
        values['1'];

      const draw =
        values.draw ??
        values.x;

      const away =
        values.away ??
        values['2'];

      if (
        Number.isFinite(home) &&
        Number.isFinite(draw) &&
        Number.isFinite(away)
      ) {
        oneXTwoSamples.push({
          home,
          draw,
          away,
        });
      }

      continue;
    }

    if (
      market === 'both teams to score'
    ) {
      const yes =
        values.yes ??
        values.gg;

      const no =
        values.no ??
        values.ng;

      if (
        Number.isFinite(yes) &&
        Number.isFinite(no)
      ) {
        bttsSamples.push({
          yes,
          no,
        });
      }

      continue;
    }

    const line =
      oddsMarketLine(
        marketName,
      );

    const overUnder = {
      over:
        values.over,
      under:
        values.under,
    };

    if (
      market.startsWith('total goals')
    ) {
      addLineSample(
        totalGoalsSamples,
        line,
        overUnder,
      );
    } else if (
      market.startsWith('total cards')
    ) {
      addLineSample(
        totalCardsSamples,
        line,
        overUnder,
      );
    } else if (
      market.startsWith('total corners')
    ) {
      addLineSample(
        totalCornersSamples,
        line,
        overUnder,
      );
    }
  }

  function averageLineMap(source) {
    const result = {};

    for (
      const [line, samples]
        of source.entries()
    ) {
      const average =
        averageProbabilityObjects(
          samples,
          ['over', 'under'],
        );

      if (average) {
        result[line] =
          average;
      }
    }

    return result;
  }

  return {
    oneXTwo:
      averageProbabilityObjects(
        oneXTwoSamples,
        ['home', 'draw', 'away'],
      ),

    bothTeamsToScore:
      averageProbabilityObjects(
        bttsSamples,
        ['yes', 'no'],
      ),

    totalGoals:
      averageLineMap(
        totalGoalsSamples,
      ),

    totalCards:
      averageLineMap(
        totalCardsSamples,
      ),

    totalCorners:
      averageLineMap(
        totalCornersSamples,
      ),
  };
}

async function getBookmakerProbabilitiesForMatch(matchId) {
  if (!matchId) {
    return null;
  }

  try {
    const oddsPayload =
      await getMatchOdds(matchId);

    return buildBookmakerMarketProbabilities(
      oddsPayload,
    );
  } catch (error) {
    console.warn(
      `Odds prematch non disponibili per match ${matchId}:`,
      error?.message ?? error,
    );

    return null;
  }
}

function mostBalancedBookmakerLine(lineMap) {
  if (
    !lineMap ||
    typeof lineMap !== 'object'
  ) {
    return null;
  }

  const candidates =
    Object.entries(lineMap)
      .map(
        ([line, probabilities]) => ({
          line:
            Number(line),
          over:
            Number(
              probabilities?.over,
            ),
          under:
            Number(
              probabilities?.under,
            ),
        }),
      )
      .filter(
        (item) =>
          Number.isFinite(item.line) &&
          Number.isFinite(item.over) &&
          Number.isFinite(item.under) &&
          item.over > 0 &&
          item.under > 0,
      )
      .sort(
        (a, b) =>
          Math.abs(a.over - a.under) -
          Math.abs(b.over - b.under),
      );

  return (
    candidates[0] ??
    null
  );
}

async function buildBookmakerOnlyMatchdayPick(
  match,
) {
  const matchId =
    match?.id ??
    null;

  if (!matchId) {
    return null;
  }

  const bookmaker =
    await getBookmakerProbabilitiesForMatch(
      matchId,
    );

  if (!bookmaker) {
    return null;
  }

  const homeName =
    match?.homeTeam?.name ??
    'Casa';

  const awayName =
    match?.awayTeam?.name ??
    'Ospite';

  const candidates = [];

  function addCandidate({
    label,
    probability,
    market,
    selection,
    line = null,
  }) {
    if (
      probability === null ||
      probability === undefined ||
      probability === ''
    ) {
      return;
    }

    const numeric =
      Number(probability);

    if (
      !Number.isFinite(numeric) ||
      numeric <= 0
    ) {
      return;
    }

    candidates.push({
      label,
      probability:
        round2(
          numeric * 100,
        ),
      market,
      selection,
      line,
    });
  }

  addCandidate({
    label:
      `1 · ${homeName}`,
    probability:
      bookmaker
        ?.oneXTwo
        ?.home,
    market:
      '1X2',
    selection:
      'home',
  });

  addCandidate({
    label:
      'X · Pareggio',
    probability:
      bookmaker
        ?.oneXTwo
        ?.draw,
    market:
      '1X2',
    selection:
      'draw',
  });

  addCandidate({
    label:
      `2 · ${awayName}`,
    probability:
      bookmaker
        ?.oneXTwo
        ?.away,
    market:
      '1X2',
    selection:
      'away',
  });

  addCandidate({
    label:
      'GG · Entrambe segnano',
    probability:
      bookmaker
        ?.bothTeamsToScore
        ?.yes,
    market:
      'GG/NG',
    selection:
      'gg',
  });

  addCandidate({
    label:
      'NG · No Goal',
    probability:
      bookmaker
        ?.bothTeamsToScore
        ?.no,
    market:
      'GG/NG',
    selection:
      'ng',
  });

  const goals25 =
    bookmaker
      ?.totalGoals
      ?.['2.5'] ??
    null;

  addCandidate({
    label:
      'Over 2.5',
    probability:
      goals25?.over,
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
      goals25?.under,
    market:
      'Under/Over',
    selection:
      'under',
    line:
      2.5,
  });

  const cornerLine =
    mostBalancedBookmakerLine(
      bookmaker
        ?.totalCorners,
    );

  if (cornerLine) {
    addCandidate({
      label:
        `Corner Over ${cornerLine.line}`,
      probability:
        cornerLine.over,
      market:
        'Corner',
      selection:
        'over',
      line:
        cornerLine.line,
    });

    addCandidate({
      label:
        `Corner Under ${cornerLine.line}`,
      probability:
        cornerLine.under,
      market:
        'Corner',
      selection:
        'under',
      line:
        cornerLine.line,
    });
  }

  const cardsLine =
    mostBalancedBookmakerLine(
      bookmaker
        ?.totalCards,
    );

  if (cardsLine) {
    addCandidate({
      label:
        `Cartellini Over ${cardsLine.line}`,
      probability:
        cardsLine.over,
      market:
        'Cartellini',
      selection:
        'over',
      line:
        cardsLine.line,
    });

    addCandidate({
      label:
        `Cartellini Under ${cardsLine.line}`,
      probability:
        cardsLine.under,
      market:
        'Cartellini',
      selection:
        'under',
      line:
        cardsLine.line,
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

function blendPredictWithBookmaker(
  predictProbabilities,
  bookmakerProbabilities,
  predictWeight = 0.20,
  bookmakerWeight = 0.80,
) {
  const bookmakerOnly =
    predictWeight === 0 &&
    bookmakerWeight === 1;

  if (
    bookmakerOnly &&
    !bookmakerProbabilities
  ) {
    return null;
  }

  if (
    !predictProbabilities ||
    !bookmakerProbabilities
  ) {
    return predictProbabilities ?? bookmakerProbabilities ?? null;
  }

  const home =
    Number(predictProbabilities.home) * predictWeight +
    Number(bookmakerProbabilities.home) * bookmakerWeight;

  const draw =
    Number(predictProbabilities.draw) * predictWeight +
    Number(bookmakerProbabilities.draw) * bookmakerWeight;

  const away =
    Number(predictProbabilities.away) * predictWeight +
    Number(bookmakerProbabilities.away) * bookmakerWeight;

  const total = home + draw + away;

  if (
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return bookmakerOnly
      ? null
      : predictProbabilities;
  }

  return {
    home: home / total,
    draw: draw / total,
    away: away / total,
  };
}
function blendBinaryPredictWithBookmaker(
  predictProbabilities,
  bookmakerProbabilities,
  firstKey,
  secondKey,
  predictWeight = 0.20,
  bookmakerWeight = 0.80,
) {
  const bookmakerOnly =
    predictWeight === 0 &&
    bookmakerWeight === 1;

  if (
    bookmakerOnly &&
    !bookmakerProbabilities
  ) {
    return null;
  }

  if (
    !predictProbabilities ||
    !bookmakerProbabilities
  ) {
    return predictProbabilities ?? bookmakerProbabilities ?? null;
  }

  const first =
    Number(
      predictProbabilities[firstKey],
    ) * predictWeight +
    Number(
      bookmakerProbabilities[firstKey],
    ) * bookmakerWeight;

  const second =
    Number(
      predictProbabilities[secondKey],
    ) * predictWeight +
    Number(
      bookmakerProbabilities[secondKey],
    ) * bookmakerWeight;

  const normalized =
    normalizeProbabilityObject({
      [firstKey]:
        first,
      [secondKey]:
        second,
    });

  return normalized ??
    (bookmakerOnly
      ? null
      : predictProbabilities);
}

function bookmakerLineProbability(
  lineMap,
  wantedLine,
) {
  if (
    !lineMap ||
    typeof lineMap !== 'object'
  ) {
    return null;
  }

  const exact =
    lineMap[
      String(wantedLine)
    ];

  if (exact) {
    return {
      line:
        Number(wantedLine),
      probabilities:
        exact,
    };
  }

  const candidates =
    Object.entries(lineMap)
      .map(
        ([line, probabilities]) => ({
          line:
            Number(line),
          probabilities,
        }),
      )
      .filter(
        (item) =>
          Number.isFinite(item.line) &&
          item.probabilities,
      )
      .sort(
        (a, b) =>
          Math.abs(
            a.line - wantedLine,
          ) -
          Math.abs(
            b.line - wantedLine,
          ),
      );

  if (candidates.length === 0) {
    return null;
  }

  return candidates[0];
}

function applyBookmakerAdvancedBlend(
  advanced,
  bookmakerProbabilities,
  predictWeight = 0.20,
  bookmakerWeight = 0.80,
) {
  if (!advanced) {
    return advanced;
  }

  const bookmakerOnly =
    predictWeight === 0 &&
    bookmakerWeight === 1;

  function markTopSignalUnavailable(metric, reason) {
    if (!metric) {
      return;
    }

    // La metrica statistica resta disponibile nella pagina Analisi.
    // Blocchiamo soltanto il suo utilizzo come Top Signal bookmaker-only.
    metric.topSignalAvailable = false;
    metric.bookmakerOnlyUnavailable = true;
    metric.bookmakerOnlyReason = reason;
  }

  // Il parser bookmaker attuale non espone un mercato tiri in porta.
  // La statistica PREDICT resta visibile nell'Analisi, ma in modalità
  // 100% bookmaker non può competere nei Top Signal.
  if (bookmakerOnly) {
    markTopSignalUnavailable(
      advanced.shotsOnTarget,
      'Quote bookmaker tiri in porta non disponibili nel feed attuale',
    );
  }

  const entries = [
    [
      'corners',
      bookmakerProbabilities?.totalCorners,
    ],
    [
      'cards',
      bookmakerProbabilities?.totalCards,
    ],
  ];

  for (
    const [metricKey, lineMap]
      of entries
  ) {
    const metric =
      advanced?.[metricKey];

    if (!metric?.available) {
      continue;
    }

    if (!lineMap) {
      if (bookmakerOnly) {
        markTopSignalUnavailable(
          metric,
          'Quote bookmaker non disponibili per questo mercato',
        );
      }

      continue;
    }

    const wantedLine =
      Number(metric.line);

    if (
      !Number.isFinite(wantedLine)
    ) {
      if (bookmakerOnly) {
        markTopSignalUnavailable(
          metric,
          'Linea bookmaker non determinabile',
        );
      }

      continue;
    }

    const bookmakerLine =
      bookmakerLineProbability(
        lineMap,
        wantedLine,
      );

    if (!bookmakerLine) {
      if (bookmakerOnly) {
        markTopSignalUnavailable(
          metric,
          'Linea bookmaker non disponibile',
        );
      }

      continue;
    }

    const line =
      bookmakerLine.line;

    const predictOver =
      Number.isFinite(
        Number(metric.totalExpected),
      )
        ? totalGoalsOverProbability(
            Number(metric.totalExpected),
            line,
          )
        : 0.5;

    const blended =
      blendBinaryPredictWithBookmaker(
        {
          over:
            predictOver,
          under:
            1 - predictOver,
        },
        bookmakerLine.probabilities,
        'over',
        'under',
        predictWeight,
        bookmakerWeight,
      );

    if (!blended) {
      if (bookmakerOnly) {
        markTopSignalUnavailable(
          metric,
          'Probabilità bookmaker non utilizzabile',
        );
      }

      continue;
    }

    if (bookmakerOnly) {
      // Manteniamo linee e probabilità statistiche PREDICT nella pagina Analisi.
      // Le probabilità bookmaker vengono salvate separatamente e sono le sole
      // utilizzabili dai Top Signal in regime 0% PREDICT / 100% bookmaker.
      metric.topSignalAvailable = true;
      metric.topSignalLine =
        round2(line);
      metric.topSignalOverProbability =
        round2(
          blended.over * 100,
        );
      metric.topSignalUnderProbability =
        round2(
          blended.under * 100,
        );
      metric.bookmakerOnly = true;
      metric.bookmakerOnlyUnavailable = false;
      delete metric.bookmakerOnlyReason;
    } else {
      // Comportamento storico invariato fuori dalla modalità bookmaker-only.
      metric.line =
        round2(line);

      metric.overProbability =
        round2(
          blended.over * 100,
        );

      metric.underProbability =
        round2(
          blended.under * 100,
        );
    }
  }

  return advanced;
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

// Correzioni puntuali di anomalie note del provider.
// Match 1378323785: il provider restituisce Benevento-Fiorentina 4-1,
// ma la gara corretta è Fiorentina-Benevento 4-1.
// Non modifichiamo il punteggio: scambiamo solo casa/trasferta.
const PREDICT_MATCH_HOME_AWAY_SWAP_IDS =
  new Set([
    '1378323785',
  ]);

function normalizeProviderMatch(match) {
  if (
    !match ||
    typeof match !== 'object'
  ) {
    return match;
  }

  const matchId =
    match?.id === undefined ||
    match?.id === null
      ? null
      : String(match.id);

  if (
    !matchId ||
    !PREDICT_MATCH_HOME_AWAY_SWAP_IDS
      .has(matchId)
  ) {
    return match;
  }

  return {
    ...match,

    homeTeam:
      match?.awayTeam ??
      null,

    awayTeam:
      match?.homeTeam ??
      null,

    predictDataCorrection: {
      type:
        'home-away-swap',

      revision:
        1,

      reason:
        'Correzione anomalia provider',

      originalHomeTeam:
        match?.homeTeam ??
        null,

      originalAwayTeam:
        match?.awayTeam ??
        null,
    },
  };
}

function normalizeProviderMatches(
  matches,
) {
  if (!Array.isArray(matches)) {
    return [];
  }

  return matches.map(
    normalizeProviderMatch,
  );
}

function normalizeAnalysisProviderMatches(
  analysis,
) {
  if (
    !analysis ||
    typeof analysis !== 'object'
  ) {
    return analysis;
  }

  const recent =
    analysis?.recent &&
    typeof analysis.recent === 'object'
      ? {
          ...analysis.recent,

          home:
            normalizeProviderMatches(
              analysis.recent.home,
            ),

          away:
            normalizeProviderMatches(
              analysis.recent.away,
            ),
        }
      : analysis?.recent;

  return {
    ...analysis,

    recent,

    headToHead:
      normalizeProviderMatches(
        analysis?.headToHead,
      ),
  };
}

function extractMatches(data) {
  if (Array.isArray(data)) {
    return normalizeProviderMatches(
      data,
    );
  }

  if (
    !data ||
    typeof data !== 'object'
  ) {
    return [];
  }

  if (Array.isArray(data.data)) {
    return normalizeProviderMatches(
      data.data,
    );
  }

  if (Array.isArray(data.matches)) {
    return normalizeProviderMatches(
      data.matches,
    );
  }

  if (Array.isArray(data.results)) {
    return normalizeProviderMatches(
      data.results,
    );
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


function progressiveCurrentSeasonWeight(
  effectiveMatches,
) {
  const matches =
    Math.max(
      0,
      Number(
        effectiveMatches,
      ) || 0,
    );

  if (matches <= 0) {
    return 0;
  }

  return clamp(
    matches /
      (
        matches +
        CURRENT_SEASON_PRIOR_MATCHES
      ),
    0,
    CURRENT_SEASON_MAX_WEIGHT,
  );
}

function currentVenueProjection(
  currentHistory,
  targetVenue,
) {
  const target =
    currentHistory?.[targetVenue];

  const oppositeVenue =
    targetVenue === 'home'
      ? 'away'
      : 'home';

  const opposite =
    currentHistory?.[oppositeVenue];

  const targetPlayed =
    Number(
      target?.played || 0,
    );

  const oppositePlayed =
    Number(
      opposite?.played || 0,
    );

  const targetWeight =
    targetPlayed;

  const oppositeWeight =
    oppositePlayed *
    ADVANCED_OPPOSITE_VENUE_WEIGHT;

  const totalWeight =
    targetWeight +
    oppositeWeight;

  if (totalWeight <= 0) {
    return null;
  }

  const fields = [
    'pointsPerGame',
    'averageGoalsFor',
    'averageGoalsAgainst',
    'averageTotalGoals',
    'winPercentage',
    'drawPercentage',
    'lossPercentage',
    'cleanSheetPercentage',
    'failedToScorePercentage',
    'over15Percentage',
    'over25Percentage',
    'over35Percentage',
    'bothTeamsScorePercentage',
  ];

  const projection = {
    played:
      totalWeight,

    actualTargetVenueMatches:
      targetPlayed,

    oppositeVenueMatches:
      oppositePlayed,
  };

  for (const field of fields) {
    const targetValue =
      Number(
        target?.[field],
      );

    const oppositeValue =
      Number(
        opposite?.[field],
      );

    let weightedTotal = 0;
    let availableWeight = 0;

    if (
      targetPlayed > 0 &&
      Number.isFinite(
        targetValue,
      )
    ) {
      weightedTotal +=
        targetValue *
        targetWeight;

      availableWeight +=
        targetWeight;
    }

    if (
      oppositePlayed > 0 &&
      Number.isFinite(
        oppositeValue,
      )
    ) {
      weightedTotal +=
        oppositeValue *
        oppositeWeight;

      availableWeight +=
        oppositeWeight;
    }

    projection[field] =
      availableWeight > 0
        ? weightedTotal /
          availableWeight
        : null;
  }

  return projection;
}

function overallCurrentProjection(
  currentHistory,
) {
  const overall =
    currentHistory?.overall;

  const played =
    Number(
      overall?.played || 0,
    );

  if (played <= 0) {
    return null;
  }

  return {
    ...overall,
    played,
  };
}

function blendHistoricalWithCurrentStats({
  historical,
  current,
}) {
  if (!current) {
    return {
      ...historical,

      predictCurrentSeasonWeight:
        0,

      predictCurrentSeasonMatches:
        0,
    };
  }

  const weight =
    progressiveCurrentSeasonWeight(
      current.played,
    );

  const fields = [
    'pointsPerGame',
    'averageGoalsFor',
    'averageGoalsAgainst',
    'averageTotalGoals',
    'winPercentage',
    'drawPercentage',
    'lossPercentage',
    'cleanSheetPercentage',
    'failedToScorePercentage',
    'over15Percentage',
    'over25Percentage',
    'over35Percentage',
    'bothTeamsScorePercentage',
  ];

  const blended = {
    ...historical,

    predictCurrentSeasonWeight:
      round2(
        weight * 100,
      ),

    predictCurrentSeasonMatches:
      round2(
        current.played,
      ),
  };

  for (const field of fields) {
    const historicalValue =
      Number(
        historical?.[field],
      );

    const currentValue =
      Number(
        current?.[field],
      );

    if (
      Number.isFinite(
        historicalValue,
      ) &&
      Number.isFinite(
        currentValue,
      )
    ) {
      blended[field] =
        historicalValue *
          (1 - weight) +
        currentValue *
          weight;
    } else if (
      Number.isFinite(
        currentValue,
      )
    ) {
      blended[field] =
        currentValue;
    }
  }

  return blended;
}

function buildProgressiveCurrentSeasonModelTeam({
  historicalTeam,
  currentHistory,
}) {
  if (!historicalTeam) {
    return historicalTeam;
  }

  const currentOverall =
    overallCurrentProjection(
      currentHistory,
    );

  const currentHome =
    currentVenueProjection(
      currentHistory,
      'home',
    );

  const currentAway =
    currentVenueProjection(
      currentHistory,
      'away',
    );

  const blendedOverall =
    blendHistoricalWithCurrentStats({
      historical:
        historicalTeam
          ?.summary
          ?.overall ??
        {},

      current:
        currentOverall,
    });

  const blendedHome =
    blendHistoricalWithCurrentStats({
      historical:
        historicalTeam
          ?.summary
          ?.home ??
        historicalTeam
          ?.summary
          ?.overall ??
        {},

      current:
        currentHome,
    });

  const blendedAway =
    blendHistoricalWithCurrentStats({
      historical:
        historicalTeam
          ?.summary
          ?.away ??
        historicalTeam
          ?.summary
          ?.overall ??
        {},

      current:
        currentAway,
    });

  return {
    ...historicalTeam,

    summary: {
      ...historicalTeam.summary,

      overall:
        blendedOverall,

      home:
        blendedHome,

      away:
        blendedAway,
    },

    currentSeasonAdjustment: {
      season:
        CURRENT_SERIE_A_SEASON,

      completedMatches:
        Number(
          currentHistory
            ?.overall
            ?.played ||
            0,
        ),

      overallWeight:
        blendedOverall
          .predictCurrentSeasonWeight ??
        0,

      homeWeight:
        blendedHome
          .predictCurrentSeasonWeight ??
        0,

      awayWeight:
        blendedAway
          .predictCurrentSeasonWeight ??
        0,
    },
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
  bookmakerProbabilities = null,
  predictWeight = 0.20,
  bookmakerWeight = 0.80,
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

  const final1x2 =
    blendPredictWithBookmaker(
      blended1x2,
      bookmakerProbabilities?.oneXTwo,
      predictWeight,
      bookmakerWeight,
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

  const finalGG =
    blendBinaryPredictWithBookmaker(
      {
        yes:
          gg,
        no:
          1 - gg,
      },
      bookmakerProbabilities
        ?.bothTeamsToScore,
      'yes',
      'no',
      predictWeight,
      bookmakerWeight,
    );

  const finalOver15 =
    blendBinaryPredictWithBookmaker(
      {
        over:
          over15,
        under:
          1 - over15,
      },
      bookmakerProbabilities
        ?.totalGoals
        ?.['1.5'],
      'over',
      'under',
      predictWeight,
      bookmakerWeight,
    );

  const finalOver25 =
    blendBinaryPredictWithBookmaker(
      {
        over:
          over25,
        under:
          1 - over25,
      },
      bookmakerProbabilities
        ?.totalGoals
        ?.['2.5'],
      'over',
      'under',
      predictWeight,
      bookmakerWeight,
    );

  const finalOver35 =
    blendBinaryPredictWithBookmaker(
      {
        over:
          over35,
        under:
          1 - over35,
      },
      bookmakerProbabilities
        ?.totalGoals
        ?.['3.5'],
      'over',
      'under',
      predictWeight,
      bookmakerWeight,
    );

  const oneXTwoPercent = {
    home:
      final1x2
        ? round2(
            final1x2.home *
            100,
          )
        : null,

    draw:
      final1x2
        ? round2(
            final1x2.draw *
            100,
          )
        : null,

    away:
      final1x2
        ? round2(
            final1x2.away *
            100,
          )
        : null,
  };

  const goalPercent = {
    gg:
      finalGG
        ? round2(
            finalGG.yes * 100,
          )
        : null,

    noGoal:
      finalGG
        ? round2(
            finalGG.no * 100,
          )
        : null,

    over15:
      finalOver15
        ? round2(
            finalOver15.over * 100,
          )
        : null,

    under15:
      finalOver15
        ? round2(
            finalOver15.under *
            100,
          )
        : null,

    over25:
      finalOver25
        ? round2(
            finalOver25.over * 100,
          )
        : null,

    under25:
      finalOver25
        ? round2(
            finalOver25.under *
            100,
          )
        : null,

    over35:
      finalOver35
        ? round2(
            finalOver35.over * 100,
          )
        : null,

    under35:
      finalOver35
        ? round2(
            finalOver35.under *
            100,
          )
        : null,
  };

  const strongest1x2 =
    final1x2
      ? strongestOutcome({
          '1':
            oneXTwoPercent.home,
          'X':
            oneXTwoPercent.draw,
          '2':
            oneXTwoPercent.away,
        })
      : null;

  const strongestGG =
    finalGG
      ? strongestOutcome({
          'GG':
            goalPercent.gg,
          'NG':
            goalPercent.noGoal,
        })
      : null;

  const strongestOU25 =
    finalOver25
      ? strongestOutcome({
          'Over 2.5':
            goalPercent.over25,

          'Under 2.5':
            goalPercent.under25,
        })
      : null;

  const topSignals = [
    ...(strongest1x2
      ? [
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
        ]
      : []),

    ...(strongestGG
      ? [
          {
            label:
              strongestGG[0],

            probability:
              strongestGG[1],

            reason:
              'Segnale Goal / No Goal',

            market:
              'ggNg',
          },
        ]
      : []),

    ...(strongestOU25
      ? [
          {
            label:
              strongestOU25[0],

            probability:
              strongestOU25[1],

            reason:
              'Segnale principale sulla linea 2.5',

            market:
              'overUnder',
          },
        ]
      : []),
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
      'Poisson + casa/trasferta + forma recente + storico 2025/26 con peso progressivo Serie A 2026/27 + statistiche avanzate ponderate',

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

function statisticsCacheTtlForData(
  data,
) {
  return data?.__unavailable === true
    ? UNAVAILABLE_STATS_CACHE_TIME
    : HISTORICAL_STATS_CACHE_TIME;
}

function getStatisticsMemoryCache(
  key,
) {
  const item =
    memoryCache.get(key);

  if (!item) {
    return null;
  }

  const ttl =
    statisticsCacheTtlForData(
      item.data,
    );

  if (
    Date.now() -
      item.createdAt >
    ttl
  ) {
    memoryCache.delete(key);
    return null;
  }

  return item.data;
}

async function getStatisticsDiskCache(
  key,
) {
  try {
    const raw =
      await fs.readFile(
        cacheFilePath(key),
        'utf8',
      );

    const parsed =
      JSON.parse(raw);

    if (
      !parsed ||
      !parsed.createdAt ||
      parsed.data === undefined
    ) {
      return null;
    }

    const ttl =
      statisticsCacheTtlForData(
        parsed.data,
      );

    if (
      Date.now() -
        parsed.createdAt >
      ttl
    ) {
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
}

async function getHistoricalMatchStatistics(
  matchId,
) {
  const key =
    `statistics-${matchId}`;

  const memory =
    getStatisticsMemoryCache(
      key,
    );

  if (memory) {
    return memory.__unavailable === true
      ? null
      : memory;
  }

  const disk =
    await getStatisticsDiskCache(
      key,
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

  try {
    const data =
      await highlightlyGet(
        `/statistics/${matchId}`,
        {},
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
  } catch (error) {
    if (
      error.statusCode ===
      404
    ) {
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
        `Statistiche non disponibili per match ${matchId}; nuovo tentativo dopo ${Math.round(UNAVAILABLE_STATS_CACHE_TIME / 60000)} minuti`,
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
  const key =
    `statistics-${matchId}`;

  const memory =
    getStatisticsMemoryCache(
      key,
    );

  if (memory) {
    return memory.__unavailable === true
      ? null
      : memory;
  }

  const disk =
    await getStatisticsDiskCache(
      key,
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

  let targetVenueMatchesWithAnyData = 0;
  let oppositeVenueMatchesWithAnyData = 0;

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

    const actualVenue =
      String(
        match
          ?.predictAnalysis
          ?.venue ??
          '',
      );

    if (
      actualVenue ===
      targetVenue
    ) {
      targetVenueMatchesWithAnyData +=
        1;
    } else {
      oppositeVenueMatchesWithAnyData +=
        1;
    }

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

    targetVenueMatchesWithAnyData,

    oppositeVenueMatchesWithAnyData,

    effectiveVenueMatches:
      targetVenueMatchesWithAnyData +
      oppositeVenueMatchesWithAnyData *
        ADVANCED_OPPOSITE_VENUE_WEIGHT,

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


function buildCurrentSeasonTeamProfile(
  historicalIdentity,
  {
    seasonMatches =
      centralSerieAState.matches,
    currentSeason =
      CURRENT_SERIE_A_SEASON,
    leagueName =
      'Serie A',
  } = {},
) {
  const history =
    buildTeamHistory(
      seasonMatches,
      historicalIdentity.id,
    );

  if (
    Number(
      history
        ?.overall
        ?.played ||
        0,
    ) <= 0
  ) {
    return null;
  }

  return {
    ...historicalIdentity,

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

    historicalSource:
      'current-league',

    sourceLeagueName:
      leagueName,

    sourceSeason:
      String(currentSeason),
  };
}

async function buildCurrentSeasonAdvancedProfilesForMatch({
  homeTeam,
  awayTeam,
  seasonMatches =
    centralSerieAState.matches,
  currentSeason =
    CURRENT_SERIE_A_SEASON,
  leagueName =
    'Serie A',
  countryName =
    'Italy',
}) {
  const currentTeams =
    [
      homeTeam,
      awayTeam,
    ]
      .map(
        (team) =>
          buildCurrentSeasonTeamProfile(
            team,
            {
              seasonMatches,
              currentSeason,
              leagueName,
            },
          ),
      )
      .filter(Boolean);

  if (
    currentTeams.length ===
    0
  ) {
    return {
      sampleSizePerVenue:
        ADVANCED_SAMPLE_PER_VENUE,

      teamsCount: 0,
      teams: [],

      season:
        String(currentSeason),

      note:
        'Nessuna statistica avanzata della stagione corrente ancora disponibile.',
    };
  }

  const result =
    await buildLeagueAdvancedProfiles({
      leagueHistory: {
        season:
          String(currentSeason),

        rosterSeason:
          String(currentSeason),

        leagueName,
        countryName,

        teamsCount:
          currentTeams.length,

        teams:
          currentTeams,
      },

      sampleSize:
        ADVANCED_SAMPLE_PER_VENUE,
    });

  return {
    ...result,

    season:
      String(currentSeason),

    note:
      `Statistiche avanzate ${leagueName} ${currentSeason} usate con peso progressivo.`,
  };
}

function advancedCurrentEffectiveMatches(
  sample,
) {
  const explicit =
    Number(
      sample
        ?.effectiveVenueMatches,
    );

  if (
    Number.isFinite(
      explicit,
    )
  ) {
    return Math.max(
      0,
      explicit,
    );
  }

  return Math.max(
    0,
    Number(
      sample
        ?.matchesWithAnyData ||
        0,
    ),
  );
}

function blendAdvancedSampleWithCurrent({
  historicalSample,
  currentSample,
}) {
  if (!historicalSample) {
    if (!currentSample) {
      return null;
    }

    return {
      ...currentSample,

      predictHistoricalMatches:
        0,

      predictCurrentSeasonMatches:
        currentSample
          .matchesWithAnyData ??
        0,

      predictCurrentSeasonWeight:
        100,
    };
  }

  if (
    !currentSample ||
    Number(
      currentSample
        .matchesWithAnyData ||
        0,
    ) <= 0
  ) {
    return {
      ...historicalSample,

      predictHistoricalMatches:
        historicalSample
          .matchesWithAnyData ??
        0,

      predictCurrentSeasonMatches:
        0,

      predictCurrentSeasonWeight:
        0,
    };
  }

  const effectiveCurrentMatches =
    advancedCurrentEffectiveMatches(
      currentSample,
    );

  const currentWeight =
    progressiveCurrentSeasonWeight(
      effectiveCurrentMatches,
    );

  const fields = [
    'cornersFor',
    'cornersAgainst',
    'shotsOnTargetFor',
    'shotsOnTargetAgainst',
    'cardsFor',
    'cardsAgainst',
  ];

  const blended = {
    ...historicalSample,

    predictHistoricalMatches:
      historicalSample
        .matchesWithAnyData ??
      0,

    predictCurrentSeasonMatches:
      currentSample
        .matchesWithAnyData ??
      0,

    predictCurrentSeasonEffectiveMatches:
      round2(
        effectiveCurrentMatches,
      ),

    predictCurrentSeasonWeight:
      round2(
        currentWeight *
        100,
      ),
  };

  for (const field of fields) {
    const historicalValue =
      Number(
        historicalSample?.[field],
      );

    const currentValue =
      Number(
        currentSample?.[field],
      );

    if (
      Number.isFinite(
        historicalValue,
      ) &&
      Number.isFinite(
        currentValue,
      )
    ) {
      blended[field] =
        historicalValue *
          (1 - currentWeight) +
        currentValue *
          currentWeight;
    } else if (
      Number.isFinite(
        currentValue,
      )
    ) {
      blended[field] =
        currentValue;
    }
  }

  return blended;
}

function blendAdvancedLeagueWithCurrentSeason({
  historicalAdvanced,
  currentAdvanced,
}) {
  const historicalTeams =
    historicalAdvanced
      ?.teams ??
    [];

  const currentTeams =
    currentAdvanced
      ?.teams ??
    [];

  const teamIds =
    new Set([
      ...historicalTeams.map(
        (team) =>
          String(team.id),
      ),

      ...currentTeams.map(
        (team) =>
          String(team.id),
      ),
    ]);

  const teams = [];

  for (const teamId of teamIds) {
    const historicalTeam =
      historicalTeams.find(
        (team) =>
          String(team.id) ===
          teamId,
      );

    const currentTeam =
      currentTeams.find(
        (team) =>
          String(team.id) ===
          teamId,
      );

    const identity =
      historicalTeam ??
      currentTeam;

    if (!identity) {
      continue;
    }

    teams.push({
      ...identity,

      home:
        blendAdvancedSampleWithCurrent({
          historicalSample:
            historicalTeam
              ?.home ??
            null,

          currentSample:
            currentTeam
              ?.home ??
            null,
        }),

      away:
        blendAdvancedSampleWithCurrent({
          historicalSample:
            historicalTeam
              ?.away ??
            null,

          currentSample:
            currentTeam
              ?.away ??
            null,
        }),
    });
  }

  return {
    ...historicalAdvanced,

    teams,

    currentSeason:
      CURRENT_SERIE_A_SEASON,

    currentSeasonTeamsWithData:
      currentTeams.length,

    note:
      'PREDICT v5: profilo avanzato storico 2025/26 + Serie A 2026/27 con peso progressivo dopo ogni risultato.',
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
      `PREDICT v5: storico avanzato fino a ${leagueAdvanced?.sampleSizePerVenue ?? ADVANCED_SAMPLE_PER_VENUE} gare casa + ${leagueAdvanced?.sampleSizePerVenue ?? ADVANCED_SAMPLE_PER_VENUE} trasferte, con progressivo ingresso delle statistiche Serie A ${CURRENT_SERIE_A_SEASON}.`,
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
    if (
      !metric?.available ||
      metric.topSignalAvailable === false
    ) {
      continue;
    }

    const signalOverProbability =
      metric.topSignalOverProbability ??
      metric.overProbability;

    const signalUnderProbability =
      metric.topSignalUnderProbability ??
      metric.underProbability;

    const signalLine =
      metric.topSignalLine ??
      metric.line;

    const overIsStronger =
      signalOverProbability >=
      signalUnderProbability;

    const probability = overIsStronger
      ? signalOverProbability
      : signalUnderProbability;

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
        `${label} ${overIsStronger ? 'Over' : 'Under'} ${signalLine}`,

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



function predictSignalReliability(
  prediction,
  market,
) {
  const reliability =
    prediction?.reliability ?? {};

  if (market === 'oneXTwo') {
    return Number(
      reliability.oneXTwo ?? 0,
    );
  }

  if (market === 'corners') {
    return Number(
      reliability.corners ?? 0,
    );
  }

  if (
    market ===
    'shotsOnTarget'
  ) {
    return Number(
      reliability.shotsOnTarget ??
      0,
    );
  }

  if (market === 'cards') {
    return Number(
      reliability.cards ?? 0,
    );
  }

  if (
    market === 'ggNg' ||
    market === 'overUnder' ||
    market === 'goals'
  ) {
    return Number(
      reliability.goals ?? 0,
    );
  }

  return Number(
    reliability.goals ?? 0,
  );
}

function buildPredictPresentationSignals(
  analysis,
) {
  analysis =
    normalizeAnalysisProviderMatches(
      analysis,
    );

  if (
    !analysis ||
    !analysis.prediction
  ) {
    return analysis;
  }

  const prediction = {
    ...analysis.prediction,
  };

  const advanced =
    analysis.advanced ?? {};

  const candidates = [];

  function addSignal({
    label,
    probability,
    reason,
    market,
    selection = null,
    line = null,
  }) {
    if (
      probability === null ||
      probability === undefined ||
      probability === ''
    ) {
      return;
    }

    const numeric =
      Number(probability);

    if (
      !Number.isFinite(numeric)
    ) {
      return;
    }

    const reliability =
      predictSignalReliability(
        prediction,
        market,
      );

    candidates.push({
      label,
      probability:
        round2(numeric),
      reason,
      market,
      selection,
      line,
      reliability:
        round2(reliability),
      reliabilityLabel:
        reliability > 0
          ? reliabilityLabel(
              reliability,
            )
          : 'N/D',
    });
  }

  const oneXTwo =
    prediction.oneXTwo ?? {};

  const oneXTwoCandidates = [
    ['1', oneXTwo.home, 'home'],
    ['X', oneXTwo.draw, 'draw'],
    ['2', oneXTwo.away, 'away'],
  ]
    .filter(
      (item) =>
        Number.isFinite(
          Number(item[1]),
        ),
    )
    .sort(
      (a, b) =>
        Number(b[1]) -
        Number(a[1]),
    );

  if (oneXTwoCandidates[0]) {
    addSignal({
      label:
        oneXTwoCandidates[0][0],
      probability:
        oneXTwoCandidates[0][1],
      reason:
        'Esito più probabile nel modello 1X2',
      market:
        'oneXTwo',
      selection:
        oneXTwoCandidates[0][2],
    });
  }

  const goals =
    prediction.goals ?? {};

  const ggCandidates = [
    ['GG', goals.gg, 'gg'],
    ['NG', goals.noGoal, 'ng'],
  ]
    .filter(
      (item) =>
        Number.isFinite(
          Number(item[1]),
        ),
    )
    .sort(
      (a, b) =>
        Number(b[1]) -
        Number(a[1]),
    );

  if (ggCandidates[0]) {
    addSignal({
      label:
        ggCandidates[0][0],
      probability:
        ggCandidates[0][1],
      reason:
        'Segnale Goal / No Goal',
      market:
        'ggNg',
      selection:
        ggCandidates[0][2],
    });
  }

  const goalLineCandidates = [
    {
      label:
        'Over 1.5',
      probability:
        goals.over15,
      selection:
        'over',
      line:
        1.5,
    },
    {
      label:
        'Under 1.5',
      probability:
        goals.under15,
      selection:
        'under',
      line:
        1.5,
    },
    {
      label:
        'Over 2.5',
      probability:
        goals.over25,
      selection:
        'over',
      line:
        2.5,
    },
    {
      label:
        'Under 2.5',
      probability:
        goals.under25,
      selection:
        'under',
      line:
        2.5,
    },
    {
      label:
        'Over 3.5',
      probability:
        goals.over35,
      selection:
        'over',
      line:
        3.5,
    },
    {
      label:
        'Under 3.5',
      probability:
        goals.under35,
      selection:
        'under',
      line:
        3.5,
    },
  ]
    .filter(
      (item) =>
        Number.isFinite(
          Number(
            item.probability,
          ),
        ),
    )
    .sort(
      (a, b) =>
        Number(
          b.probability,
        ) -
        Number(
          a.probability,
        ),
    );

  const strongestGoalLine =
    goalLineCandidates[0];

  if (strongestGoalLine) {
    addSignal({
      ...strongestGoalLine,
      reason:
        'Segnale Under / Over più forte tra le linee 1.5, 2.5 e 3.5',
      market:
        'overUnder',
    });
  }

  const advancedEntries = [
    [
      'Corner',
      'corners',
      advanced?.corners,
    ],
    [
      'Tiri in porta',
      'shotsOnTarget',
      advanced
        ?.shotsOnTarget,
    ],
    [
      'Cartellini',
      'cards',
      advanced?.cards,
    ],
  ];

  for (
    const [
      label,
      market,
      metric,
    ] of advancedEntries
  ) {
    if (
      !metric?.available ||
      metric.topSignalAvailable === false
    ) {
      continue;
    }

    const overProbability =
      Number(
        metric.topSignalOverProbability ??
        metric.overProbability,
      );

    const underProbability =
      Number(
        metric.topSignalUnderProbability ??
        metric.underProbability,
      );

    const signalLine =
      Number(
        metric.topSignalLine ??
        metric.line,
      );

    const overIsStronger =
      overProbability >=
      underProbability;

    const probability =
      overIsStronger
        ? overProbability
        : underProbability;

    if (
      !Number.isFinite(
        probability,
      )
    ) {
      continue;
    }

    addSignal({
      label:
        `${label} ${overIsStronger ? 'Over' : 'Under'} ${signalLine}`,
      probability,
      reason:
        `Segnale ${label.toLowerCase()} dal campione casa/trasferta ponderato`,
      market,
      selection:
        overIsStronger
          ? 'over'
          : 'under',
      line:
        signalLine,
    });
  }

  candidates.sort(
    (a, b) =>
      b.probability -
      a.probability,
  );

  const primaryPick =
    buildMostProbablePick({
      ...analysis,
      prediction,
    });

  let primarySignal =
    null;

  if (primaryPick) {
    const primaryMarket =
      primaryPick.market ===
      '1X2'
        ? 'oneXTwo'
        : primaryPick.market ===
            'GG/NG'
          ? 'ggNg'
          : primaryPick.market ===
              'Under/Over'
            ? 'overUnder'
            : primaryPick.market ===
                'Corner'
              ? 'corners'
              : primaryPick.market ===
                  'Tiri in porta'
                ? 'shotsOnTarget'
                : primaryPick.market ===
                    'Cartellini'
                  ? 'cards'
                  : 'goals';

    const primaryReliability =
      predictSignalReliability(
        prediction,
        primaryMarket,
      );

    primarySignal = {
      ...primaryPick,
      reason:
        'Scelta principale PREDICT',
      signalMarket:
        primaryMarket,
      reliability:
        round2(
          primaryReliability,
        ),
      reliabilityLabel:
        primaryReliability > 0
          ? reliabilityLabel(
              primaryReliability,
            )
          : 'N/D',
    };
  }

  const alternatives =
    candidates.filter(
      (signal) => {
        if (!primarySignal) {
          return true;
        }

        return (
          signal.market !==
          primarySignal
            .signalMarket
        );
      },
    );

  prediction.primarySignal =
    primarySignal;

  prediction.topSignals = [
    ...(primarySignal
      ? [
          {
            label:
              primarySignal.label,
            probability:
              primarySignal
                .probability,
            reason:
              primarySignal.reason,
            market:
              primarySignal
                .signalMarket,
            selection:
              primarySignal
                .selection,
            line:
              primarySignal.line,
            reliability:
              primarySignal
                .reliability,
            reliabilityLabel:
              primarySignal
                .reliabilityLabel,
            primary:
              true,
          },
        ]
      : []),
    ...alternatives.map(
      (signal) => ({
        ...signal,
        primary:
          false,
      }),
    ),
  ].slice(
    0,
    6,
  );

  return {
    ...analysis,
    prediction,
  };
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
      modelVersion:
        'PREDICT v5',
      currentSeason:
        CURRENT_SERIE_A_SEASON,
      progressiveCurrentSeason:
        true,
      pendingCurrentStatistics:
        centralSerieAState
          .pendingStatisticsMatchIds
          .size,
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

      teamDataRevision:
        Object.fromEntries(
          centralSerieAState
            .teamDataRevision,
        ),

      processedFinishedMatchIds:
        Array.from(
          centralSerieAState
            .processedFinishedMatchIds,
        ),

      pendingStatisticsMatchIds:
        Array.from(
          centralSerieAState
            .pendingStatisticsMatchIds,
        ),

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

  centralSerieAState.teamDataRevision =
    new Map(
      Object.entries(
        disk.teamDataRevision ??
          {},
      ).map(
        ([teamId, revision]) => [
          String(teamId),
          Number(revision) ||
            0,
        ],
      ),
    );

  centralSerieAState.processedFinishedMatchIds =
    new Set(
      Array.isArray(
        disk.processedFinishedMatchIds,
      )
        ? disk
            .processedFinishedMatchIds
            .map(String)
        : [],
    );

  centralSerieAState.pendingStatisticsMatchIds =
    new Set(
      Array.isArray(
        disk.pendingStatisticsMatchIds,
      )
        ? disk
            .pendingStatisticsMatchIds
            .map(String)
        : [],
    );

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
        )
        .sort(
          (a, b) =>
            Date.parse(
              a?.date ?? '',
            ) -
            Date.parse(
              b?.date ?? '',
            ),
        );

    if (
      upcoming.length ===
      0
    ) {
      return;
    }

    // Prepariamo fino a 10 partite mancanti per ciclo.
    // La concorrenza resta limitata a 2 per evitare picchi simultanei
    // verso Highlightly e completare rapidamente il precompute.
    const pendingMatches = [];

    for (
      const match
        of upcoming
    ) {
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
        continue;
      }

      const analysisMatchStartMs =
        Date.parse(
          match?.date ?? '',
        );

      const analysisFreezeActive =
        Number.isFinite(
          analysisMatchStartMs,
        ) &&
        now >=
          analysisMatchStartMs -
            PREMATCH_PREDICTION_FREEZE_WINDOW;

      const analysisPrecomputeTtl =
        analysisFreezeActive
          ? 14 * 24 * 60 * 60 * 1000
          : 30 * 60 * 1000;

      const existingAnalysis =
        await getExistingMatchAnalysisSnapshot({
          homeTeamId,
          awayTeamId,
          historicalSeason:
            '2025',
          leagueName:
            'Serie A',
          countryName:
            'Italy',
          cacheVariant:
            bookmakerOnlyModeForRound(
              roundNumberOf(match),
            )
              ? `bookmaker100pure-analysisstats-v2-r${BOOKMAKER_ONLY_FROM_ROUND}plus`
              : null,
          cacheTtl:
            analysisPrecomputeTtl,

          // Prima del freeze vogliamo una vera analisi aggiornata:
          // un vecchio archivio permanente o legacy non deve bloccare
          // la rigenerazione dello snapshot corrente.
          allowPermanent:
            analysisFreezeActive,
          allowLegacy:
            analysisFreezeActive,
        });

      const existingSnapshot =
        await getExistingMatchdayPickSnapshot({
          matchId:
            match?.id,
          historicalSeason:
            '2025',
          leagueName:
            'Serie A',
          countryName:
            'Italy',
        });

      if (
        existingAnalysis &&
        existingSnapshot
      ) {
        continue;
      }

      pendingMatches.push({
        match,
        homeTeamId,
        awayTeamId,
        needsAnalysis:
          !existingAnalysis,
        needsSnapshot:
          !existingSnapshot,
      });

      if (
        pendingMatches.length >= 10
      ) {
        break;
      }
    }

    if (
      pendingMatches.length === 0
    ) {
      return;
    }

    const affectedRounds =
      new Set();

    await mapWithConcurrency(
      pendingMatches,
      2,
      async (item) => {
        const {
          match,
          homeTeamId,
          awayTeamId,
          needsAnalysis,
          needsSnapshot,
        } = item;

        if (needsAnalysis) {
          console.log(
            `PREDICT CENTRAL: preparo analisi completa (${homeTeamId}-${awayTeamId})`,
          );

          try {
            await internalMatchAnalysis({
              homeTeamId,
              awayTeamId,
              matchId:
                match?.id,
              historicalSeason:
                '2025',
              leagueName:
                'Serie A',
              countryName:
                'Italy',
            });
          } catch (error) {
            console.warn(
              `Precompute analisi ${homeTeamId}-${awayTeamId} non riuscito:`,
              error?.message ??
                error,
            );

            return false;
          }
        }

        if (needsSnapshot) {
          console.log(
            `PREDICT CENTRAL: preparo pronostico mancante (${homeTeamId}-${awayTeamId})`,
          );

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
              `Precompute pronostico ${homeTeamId}-${awayTeamId} non riuscito:`,
              error?.message ??
                error,
            );

            return false;
          }
        }

        const roundNumber =
          roundNumberOf(match);

        if (
          Number.isFinite(
            Number(roundNumber),
          )
        ) {
          affectedRounds.add(
            Number(roundNumber),
          );
        }

        return true;
      },
    );

    // Evita che la schermata giornata continui a mostrare pick:null
    // fino alla scadenza della cache aggregata di 60 secondi.
    for (
      const roundNumber
        of affectedRounds
    ) {
      await deleteCacheKey(
        [
          matchdayPicksAggregatePrefixForRound(
            roundNumber,
          ),
          CURRENT_SERIE_A_SEASON,
          '2025',
          roundNumber,
          'Serie A',
          'Italy',
        ].join('-'),
      );
    }
  } finally {
    centralSerieAState.precomputeRunning =
      false;
  }
}

async function refreshDynamicDataAfterFinishedMatch(
  match,
) {
  const matchId =
    match?.id;

  if (
    matchId === undefined ||
    matchId === null
  ) {
    return false;
  }

  const matchKey =
    String(matchId);

  if (
    centralSerieAState
      .processedFinishedMatchIds
      .has(matchKey)
  ) {
    return false;
  }

  if (
    !isFinishedMatch(match) ||
    !parseScore(match)
  ) {
    return false;
  }

  const homeTeamId =
    teamIdOf(
      match?.homeTeam,
    );

  const awayTeamId =
    teamIdOf(
      match?.awayTeam,
    );

  // Proviamo prima a salvare anche le statistiche finali.
  // Se Highlightly non le espone ancora, il risultato viene comunque
  // registrato: il modello base aggiorna subito forma e gol, mentre
  // corner/tiri/cartellini verranno recuperati dallo scheduler.
  let finalStatistics = null;

  try {
    finalStatistics =
      await getHistoricalMatchStatistics(
        matchId,
      );
  } catch (error) {
    console.warn(
      `Statistiche finali non ancora disponibili per match ${matchKey}:`,
      error?.message ??
        error,
    );
  }

  if (finalStatistics) {
    centralSerieAState
      .pendingStatisticsMatchIds
      .delete(matchKey);
  } else {
    centralSerieAState
      .pendingStatisticsMatchIds
      .add(matchKey);
  }

  const affectedTeamIds =
    [
      homeTeamId,
      awayTeamId,
    ]
      .filter(
        (value) =>
          value !== null &&
          value !== undefined,
      )
      .map(String);

  for (
    const teamId
      of new Set(
        affectedTeamIds,
      )
  ) {
    incrementTeamDataRevision(
      teamId,
    );

    // La forma recente deve essere richiesta di nuovo subito,
    // senza aspettare le normali 6 ore di cache.
    await deleteCacheKey(
      `last-five-${teamId}`,
    );
  }

  // Se le stesse squadre si riaffronteranno, anche l'H2H deve
  // includere il risultato appena concluso.
  if (
    homeTeamId &&
    awayTeamId
  ) {
    const orderedH2H =
      [
        String(homeTeamId),
        String(awayTeamId),
      ].sort();

    await deleteCacheKey(
      `h2h-${orderedH2H[0]}-${orderedH2H[1]}`,
    );
  }

  centralSerieAState
    .processedFinishedMatchIds
    .add(matchKey);

  console.log(
    `PREDICT DYNAMIC REFRESH: risultato ${matchKey} acquisito; revisioni ${homeTeamId ?? '-'}=${teamDataRevisionOf(homeTeamId)}, ${awayTeamId ?? '-'}=${teamDataRevisionOf(awayTeamId)}`,
  );

  return true;
}

async function settleCentralFinishedMatches() {
  const pendingFinished =
    centralSerieAState.matches
      .filter(
        (match) => {
          const matchId =
            match?.id;

          return (
            matchId !== undefined &&
            matchId !== null &&
            isFinishedMatch(
              match,
            ) &&
            Boolean(
              parseScore(match),
            ) &&
            !centralSerieAState
              .processedFinishedMatchIds
              .has(
                String(matchId),
              )
          );
        },
      )
      .sort(
        (a, b) =>
          Date.parse(
            a?.date ?? '',
          ) -
          Date.parse(
            b?.date ?? '',
          ),
      )
      // Protezione in caso di riavvio dopo una lunga assenza:
      // massimo 10 nuovi risultati per ciclo.
      .slice(0, 10);

  if (
    pendingFinished.length ===
    0
  ) {
    return false;
  }

  const refreshed =
    await mapWithConcurrency(
      pendingFinished,
      2,
      async (match) =>
        refreshDynamicDataAfterFinishedMatch(
          match,
        ),
    );

  const changed =
    refreshed.some(Boolean);

  if (changed) {
    await persistCentralSerieAState();
  }

  return changed;
}


async function retryPendingCurrentStatistics() {
  const pendingIds =
    Array.from(
      centralSerieAState
        .pendingStatisticsMatchIds,
    )
      .slice(0, 2);

  if (
    pendingIds.length ===
    0
  ) {
    return false;
  }

  let changed = false;

  for (const matchId of pendingIds) {
    const match =
      centralSerieAState.matches
        .find(
          (item) =>
            String(
              item?.id,
            ) ===
            String(matchId),
        );

    if (!match) {
      centralSerieAState
        .pendingStatisticsMatchIds
        .delete(
          String(matchId),
        );

      changed = true;
      continue;
    }

    let statistics = null;

    try {
      statistics =
        await getHistoricalMatchStatistics(
          matchId,
        );
    } catch (error) {
      console.warn(
        `Retry statistiche ${matchId} non riuscito:`,
        error?.message ??
          error,
      );

      continue;
    }

    if (!statistics) {
      continue;
    }

    centralSerieAState
      .pendingStatisticsMatchIds
      .delete(
        String(matchId),
      );

    const affectedTeamIds =
      [
        teamIdOf(
          match?.homeTeam,
        ),
        teamIdOf(
          match?.awayTeam,
        ),
      ]
        .filter(
          (value) =>
            value !== null &&
            value !== undefined,
        )
        .map(String);

    for (
      const teamId
        of new Set(
          affectedTeamIds,
        )
    ) {
      incrementTeamDataRevision(
        teamId,
      );
    }

    console.log(
      `PREDICT ADVANCED REFRESH: statistiche finali ${matchId} disponibili; rigenero analisi future`,
    );

    changed = true;
  }

  if (changed) {
    await persistCentralSerieAState();
  }

  return changed;
}


async function archivePermanentAnalysisHistoryForFrozenMatches() {
  const frozenMatches =
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
            Date.now() >=
              startMs -
                PREMATCH_PREDICTION_FREEZE_WINDOW
          );
        },
      );

  if (
    frozenMatches.length ===
    0
  ) {
    return false;
  }

  const archived =
    await mapWithConcurrency(
      frozenMatches,
      2,
      async (match) => {
        try {
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
            return false;
          }

          const existing =
            await getPermanentMatchAnalysisRecord({
              homeTeamId,
              awayTeamId,
              historicalSeason:
                '2025',
              leagueName:
                'Serie A',
              countryName:
                'Italy',
            });

          if (
            existing?.analysis
          ) {
            return false;
          }

          const analysis =
            await getExistingMatchAnalysisSnapshot({
              homeTeamId,
              awayTeamId,
              historicalSeason:
                '2025',
              leagueName:
                'Serie A',
              countryName:
                'Italy',
              cacheVariant:
                bookmakerOnlyModeForRound(
                  roundNumberOf(match),
                )
                  ? `bookmaker100pure-nullfix-r${BOOKMAKER_ONLY_FROM_ROUND}plus`
                  : null,
            });

          if (!analysis) {
            return false;
          }

          await persistPermanentMatchAnalysis({
            homeTeamId,
            awayTeamId,
            historicalSeason:
              '2025',
            leagueName:
              'Serie A',
            countryName:
              'Italy',
            analysis,
            sourceKey:
              buildMatchAnalysisCacheKey({
                homeTeamId,
                awayTeamId,
                historicalSeason:
                  '2025',
                leagueName:
                  'Serie A',
                countryName:
                  'Italy',
                  cacheVariant:
                    bookmakerOnlyModeForRound(
                      roundNumberOf(match),
                    )
                      ? `bookmaker100pure-nullfix-r${BOOKMAKER_ONLY_FROM_ROUND}plus`
                      : null,
              }),
          });

          return true;
        } catch (error) {
          console.warn(
            `PREDICT HISTORY: archivio analisi non riuscito per ${match?.id}:`,
            error?.message ??
              error,
          );

          return false;
        }
      },
    );

  return archived.some(Boolean);
}

async function settlePermanentPickHistoryForFinishedMatches() {
  const finishedMatches =
    centralSerieAState.matches
      .filter(
        (match) =>
          isFinishedMatch(
            match,
          ) &&
          Boolean(
            parseScore(
              match,
            ),
          ),
      );

  if (finishedMatches.length === 0) {
    return false;
  }

  const settled =
    await mapWithConcurrency(
      finishedMatches,
      2,
      async (match) => {
        try {
          const snapshot =
            await getExistingMatchdayPickSnapshot({
              matchId:
                match?.id,
              historicalSeason:
                '2025',
              leagueName:
                'Serie A',
              countryName:
                'Italy',
            });

          if (!snapshot?.pick) {
            return false;
          }

          const before =
            await getPermanentMatchdayPickRecord({
              matchId:
                match?.id,
              historicalSeason:
                '2025',
              leagueName:
                'Serie A',
              countryName:
                'Italy',
            });

          if (
            before
              ?.result
              ?.settled
          ) {
            return false;
          }

          const result =
            await getOrPersistMatchdayPickResult({
              match,
              snapshot,
              historicalSeason:
                '2025',
              leagueName:
                'Serie A',
              countryName:
                'Italy',
              allowProvider:
                false,
            });

          return Boolean(
            result?.settled,
          );
        } catch (error) {
          console.warn(
            `PREDICT HISTORY: settlement non riuscito per ${match?.id}:`,
            error?.message ??
              error,
          );

          return false;
        }
      },
    );

  return settled.some(Boolean);
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

    const liveUpdated =
      await syncCentralSerieALive();

    // Prima registriamo i risultati appena conclusi e aumentiamo
    // la revisione delle squadre. Solo DOPO prepariamo le analisi future,
    // così le percentuali vengono calcolate con i dati più recenti.
    const finishedDataChanged =
      await settleCentralFinishedMatches();

    const advancedStatisticsChanged =
      await retryPendingCurrentStatistics();

    // Storico indipendente dagli accessi degli utenti:
    // ogni risultato concluso viene archiviato dal server stesso.
    const persistentHistoryChanged =
      await settlePermanentPickHistoryForFinishedMatches();

    if (
      scheduleChanged ||
      liveUpdated ||
      finishedDataChanged ||
      advancedStatisticsChanged ||
      persistentHistoryChanged ||
      centralSerieAState.matches.length >
        0
    ) {
      await precomputeUpcomingPredictData();
      await precomputeUpcomingMatchdayMultiples();

      // Le multiple ufficialmente congelate vengono valutate dal server
      // e il loro storico aggregato viene aggiornato senza dipendere dall'app.
      await settlePermanentMultipleHistory();

      // Dopo il precompute, se una partita è entrata nella finestra
      // di congelamento, preserviamo definitivamente anche l'analisi
      // pre-match completa sul disco persistente.
      await archivePermanentAnalysisHistoryForFrozenMatches();
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

      processedFinishedMatches:
        centralSerieAState
          .processedFinishedMatchIds
          .size,

      dynamicTeamRevisions:
        Object.fromEntries(
          centralSerieAState
            .teamDataRevision,
        ),

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

      // Accesso pubblico controllato anche per gli altri campionati
      // supportati da PREDICT. Non esponiamo il proxy Highlightly:
      // il client puo leggere solo la stagione corrente di una lega
      // dichiarata in SUPPORTED_LEAGUES e solo per una data specifica.
      const supportedLeague =
        resolveSupportedLeague({
          leagueName:
            query.leagueName,
          countryName:
            query.countryName,
        });

      const supportedLeaguePublicRequest =
        Boolean(
          supportedLeague,
        ) &&
        String(
          query.season ??
          '',
        ) ===
          String(
            supportedLeague
              ?.currentSeason ??
            '',
          ) &&
        Boolean(
          query.date,
        ) &&
        !query.homeTeamId &&
        !query.awayTeamId &&
        !query.homeTeamName &&
        !query.awayTeamName;

      if (
        supportedLeaguePublicRequest
      ) {
        const requestedDate =
          String(
            query.date,
          );

        // Per i campionati non gestiti dallo scheduler centrale Serie A
        // leggiamo la singola data con una cache breve. La cache stagione
        // (6 ore) e' ottima per calendario/round, ma e' troppo lunga per
        // punteggi live e risultati appena conclusi.
        const datePayload =
          await cachedHighlightlyGet({
            key: [
              'supported-public-matches-v2',
              supportedLeague.key,
              String(
                query.season,
              ),
              requestedDate,
            ].join('-'),
            apiPath:
              '/matches',
            query: {
              date:
                requestedDate,
              leagueName:
                supportedLeague
                  .leagueName,
              countryName:
                supportedLeague
                  .countryName,
              season:
                String(
                  query.season,
                ),
              timezone:
                'Europe/Rome',
              limit:
                String(
                  limit,
                ),
              offset:
                String(
                  offset,
                ),
            },
            ttl:
              SUPPORTED_LEAGUE_PUBLIC_MATCHES_CACHE_TIME,
          });

        const matchesForDate =
          extractMatches(
            datePayload,
          )
            .filter(
              regularSeasonMatch,
            )
            .sort(
              (a, b) =>
                Date.parse(
                  a?.date ?? '',
                ) -
                Date.parse(
                  b?.date ?? '',
                ),
            );

        return res.json({
          data:
            matchesForDate,

          meta: {
            source:
              supportedLeague.key ===
                'serie-a'
                ? 'predict-central-cache'
                : 'predict-supported-league-live-cache',
            leagueKey:
              supportedLeague.key,
            leagueName:
              supportedLeague
                .leagueName,
            countryName:
              supportedLeague
                .countryName,
            season:
              String(
                query.season,
              ),
            date:
              requestedDate,
            cacheTtlSeconds:
              Math.round(
                SUPPORTED_LEAGUE_PUBLIC_MATCHES_CACHE_TIME /
                1000,
              ),
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
        matchId,

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


      const supportedLeague =
        resolveSupportedLeague({
          leagueName,
          countryName,
        });

      const currentSeason =
        supportedLeague
          ?.currentSeason ??
        CURRENT_SERIE_A_SEASON;

      const currentSeasonMatches =
        supportedLeague
          ? await loadSupportedLeagueSeasonMatches({
              season:
                currentSeason,
              leagueName,
              countryName,
            })
          : centralSerieAState.matches;

      const centralMatch =
        currentSeasonMatches.find(
          (match) =>
            (
              matchId !== undefined &&
              matchId !== null &&
              String(match?.id) ===
                String(matchId)
            ) ||
            (
              String(
                teamIdOf(match?.homeTeam),
              ) === String(homeTeamId) &&
              String(
                teamIdOf(match?.awayTeam),
              ) === String(awayTeamId)
            ),
        );

      const centralRound =
        roundNumberOf(
          centralMatch,
        );

      const bookmakerOnlyMode =
        bookmakerOnlyModeForRound(
          centralRound,
        );

      const predictBlendWeight =
        bookmakerOnlyMode
          ? BOOKMAKER_ONLY_PREDICT_WEIGHT
          : 0.20;

      const bookmakerBlendWeight =
        bookmakerOnlyMode
          ? BOOKMAKER_ONLY_BOOKMAKER_WEIGHT
          : 0.80;

      const analysisCacheVariant =
        bookmakerOnlyMode
          ? `bookmaker100pure-nullfix-analysisstats-v2-r${BOOKMAKER_ONLY_FROM_ROUND}plus`
          : null;

      const effectiveMatchId =
        matchId ??
        centralMatch?.id ??
        null;

      const matchStartMs =
        Date.parse(
          centralMatch?.date ?? '',
        );

      const matchIsUpcoming =
        Number.isFinite(matchStartMs) &&
        Date.now() < matchStartMs;

      const predictionFreezeActive =
        Number.isFinite(matchStartMs) &&
        Date.now() >=
          matchStartMs -
            PREMATCH_PREDICTION_FREEZE_WINDOW;

      const analysisCacheTtl =
        predictionFreezeActive
          ? 14 * 24 * 60 * 60 * 1000
          : matchIsUpcoming ||
              (!centralMatch && effectiveMatchId)
            ? 30 * 60 * 1000
            : 14 * 24 * 60 * 60 * 1000;

      const analysisCacheKey =
        buildMatchAnalysisCacheKey({
          homeTeamId,
          awayTeamId,
          historicalSeason:
            season,
          leagueName,
          countryName,
          cacheVariant:
            analysisCacheVariant,
        });

      // L'archivio permanente ha priorità solo quando il match è ormai
      // congelato/giocato (o non è una gara futura della schedule corrente).
      // Prima del freeze una vecchia analisi archiviata non deve impedire
      // l'aggiornamento con i dati correnti.
      const canUsePermanentAnalysis =
        predictionFreezeActive ||
        !matchIsUpcoming;

      if (canUsePermanentAnalysis) {
        const permanentAnalysis =
          await getPermanentMatchAnalysisRecord({
            homeTeamId,
            awayTeamId,
            historicalSeason:
              season,
            leagueName,
            countryName,
          });

        if (
          permanentAnalysis?.analysis
        ) {
          const presentedAnalysis =
            buildPredictPresentationSignals(
              permanentAnalysis.analysis,
            );

          return res.json({
            ...presentedAnalysis,
            cacheSource:
              'predict-analysis-history',
          });
        }
      }

      const cachedAnalysisMemory =
        getMemoryCache(
          analysisCacheKey,
          analysisCacheTtl,
        );

      if (cachedAnalysisMemory) {
        if (
          predictionFreezeActive
        ) {
          await persistPermanentMatchAnalysis({
            homeTeamId,
            awayTeamId,
            historicalSeason:
              season,
            leagueName,
            countryName,
            analysis:
              cachedAnalysisMemory,
            sourceKey:
              analysisCacheKey,
          });
        }

        const presentedAnalysis =
          buildPredictPresentationSignals(
            cachedAnalysisMemory,
          );

        return res.json({
          ...presentedAnalysis,
          cacheSource:
            'predict-analysis-memory',
        });
      }

      const cachedAnalysisDisk =
        await getDiskCache(
          analysisCacheKey,
          analysisCacheTtl,
        );

      if (cachedAnalysisDisk) {
        setMemoryCache(
          analysisCacheKey,
          cachedAnalysisDisk,
        );

        if (
          predictionFreezeActive
        ) {
          await persistPermanentMatchAnalysis({
            homeTeamId,
            awayTeamId,
            historicalSeason:
              season,
            leagueName,
            countryName,
            analysis:
              cachedAnalysisDisk,
            sourceKey:
              analysisCacheKey,
          });
        }

        const presentedAnalysis =
          buildPredictPresentationSignals(
            cachedAnalysisDisk,
          );

        return res.json({
          ...presentedAnalysis,
          cacheSource:
            'predict-analysis-disk',
        });
      }

      const internalRequest =
        req.get(
          'x-predict-internal',
        ) ===
        INTERNAL_SYNC_TOKEN;

      // Le quattro nuove leghe possono generare l'analisi completa
      // on-demand quando l'utente apre una partita dall'app.
      // Serie A mantiene il comportamento storico del flusso centrale.
      const publicOnDemandAnalysisAllowed =
        supportedLeague !== null &&
        supportedLeague !== undefined &&
        supportedLeague.key !==
          'serie-a';

      // Per una partita futura, se l'analisi esiste sul disco ma ha
      // superato il TTL operativo di 30 minuti, la mostriamo comunque
      // all'app come fallback invece di rispondere 503.
      // Le richieste interne dello scheduler bypassano il fallback:
      // devono rigenerare davvero lo snapshot.
      if (
        matchIsUpcoming &&
        !predictionFreezeActive &&
        !internalRequest
      ) {
        const staleAnalysisDisk =
          await getDiskCache(
            analysisCacheKey,
            PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
          );

        if (staleAnalysisDisk) {
          const presentedAnalysis =
            buildPredictPresentationSignals(
              staleAnalysisDisk,
            );

          return res.json({
            ...presentedAnalysis,
            cacheSource:
              'predict-analysis-disk-stale',
            refreshPending:
              true,
          });
        }
      }

      // Compatibilità storica: le analisi della prima giornata
      // erano state salvate come snapshot v1. Se esistono, vengono
      // recuperate senza rigenerarle, copiate in v2 e archiviate.
      const legacyAnalysis =
        await readLegacyMatchAnalysisSnapshot({
          homeTeamId,
          awayTeamId,
          historicalSeason:
            season,
          leagueName,
          countryName,
        });

      if (legacyAnalysis?.snapshot) {
        if (
          matchIsUpcoming &&
          !predictionFreezeActive
        ) {
          // Prima del freeze un vecchio snapshot legacy può essere
          // mostrato solo come fallback temporaneo. Non viene copiato
          // nella nuova chiave e non viene archiviato come definitivo.
          if (!internalRequest) {
            const presentedAnalysis =
              buildPredictPresentationSignals(
                legacyAnalysis.snapshot,
              );

            return res.json({
              ...presentedAnalysis,

              cacheSource:
                `predict-analysis-${legacyAnalysis.version}-stale`,

              refreshPending:
                true,
            });
          }
        } else {
          const migratedAnalysis =
            await migrateLegacyMatchAnalysisSnapshot({
              homeTeamId,
              awayTeamId,
              historicalSeason:
                season,
              leagueName,
              countryName,
              legacy:
                legacyAnalysis,
            });

          const presentedAnalysis =
            buildPredictPresentationSignals(
              migratedAnalysis,
            );

          return res.json({
            ...presentedAnalysis,
            cacheSource:
              `predict-analysis-${legacyAnalysis.version}-history`,
          });
        }
      }

      if (
        !internalRequest &&
        !publicOnDemandAnalysisAllowed
      ) {
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

      const currentHomeHistory =
        buildTeamHistory(
          currentSeasonMatches,
          homeTeam.id,
        );

      const currentAwayHistory =
        buildTeamHistory(
          currentSeasonMatches,
          awayTeam.id,
        );

      const modelHomeTeam =
        buildProgressiveCurrentSeasonModelTeam({
          historicalTeam:
            homeTeam,

          currentHistory:
            currentHomeHistory,
        });

      const modelAwayTeam =
        buildProgressiveCurrentSeasonModelTeam({
          historicalTeam:
            awayTeam,

          currentHistory:
            currentAwayHistory,
        });

      const bookmakerProbabilities =
        await getBookmakerProbabilitiesForMatch(
          effectiveMatchId,
        );

      const prediction =
        calculatePrediction({
          homeTeam:
            modelHomeTeam,

          awayTeam:
            modelAwayTeam,

          homeRecentMatches,
          awayRecentMatches,
          headToHeadMatches,

          // Le medie lega restano ancorate al 2025/26; i profili squadra
          // incorporano progressivamente i risultati 2026/27.
          leagueHistory:
            leagueResult.data,

          bookmakerProbabilities,
          predictWeight:
            predictBlendWeight,
          bookmakerWeight:
            bookmakerBlendWeight,
        });

      prediction.inputs = {
        ...prediction.inputs,

        currentSeasonBlend: {
          season:
            String(currentSeason),

          home:
            modelHomeTeam
              ?.currentSeasonAdjustment ??
            null,

          away:
            modelAwayTeam
              ?.currentSeasonAdjustment ??
            null,

          rule:
            'peso = partite_effettive / (partite_effettive + 5), massimo 90%',
        },
      };

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
                String(currentSeason),

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

      const currentSeasonAdvanced =
        await buildCurrentSeasonAdvancedProfilesForMatch({
          homeTeam,
          awayTeam,
          seasonMatches:
            currentSeasonMatches,
          currentSeason,
          leagueName,
          countryName,
        });

      const progressiveAdvancedData =
        blendAdvancedLeagueWithCurrentSeason({
          historicalAdvanced:
            advancedData,

          currentAdvanced:
            currentSeasonAdvanced,
        });

      const advanced =
        calculateAdvancedPrediction({
          homeTeam,
          awayTeam,

          leagueAdvanced:
            progressiveAdvancedData,
        });

      applyBookmakerAdvancedBlend(
        advanced,
        bookmakerProbabilities,
        predictBlendWeight,
        bookmakerBlendWeight,
      );

      advanced.currentSeasonBlend = {
        season:
          String(currentSeason),

        home:
          findAdvancedTeamProfile(
            progressiveAdvancedData,
            homeTeam.id,
          )
            ?.home
            ?.predictCurrentSeasonWeight ??
          0,

        away:
          findAdvancedTeamProfile(
            progressiveAdvancedData,
            awayTeam.id,
          )
            ?.away
            ?.predictCurrentSeasonWeight ??
          0,

        rule:
          'peso progressivo con prior storico di 5 partite, massimo 90%',
      };

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

      const presentedAnalysisPayload =
        buildPredictPresentationSignals(
          analysisPayload,
        );

      setMemoryCache(
        analysisCacheKey,
        presentedAnalysisPayload,
      );

      await setDiskCache(
        analysisCacheKey,
        presentedAnalysisPayload,
      );

      if (
        predictionFreezeActive
      ) {
        await persistPermanentMatchAnalysis({
          homeTeamId,
          awayTeamId,
          historicalSeason:
            season,
          leagueName,
          countryName,
          analysis:
            presentedAnalysisPayload,
          sourceKey:
            analysisCacheKey,
        });
      }

      res.json({
        ...presentedAnalysisPayload,
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

function regularSeasonMatch(match) {
  const rawRound =
    match?.round;

  const candidates = [
    rawRound,
    rawRound?.name,
    rawRound?.round,
    rawRound?.label,
  ];

  const text =
    candidates
      .filter(
        (value) =>
          value !== undefined &&
          value !== null &&
          typeof value !== 'number',
      )
      .map(
        (value) =>
          String(value).trim(),
      )
      .find(
        (value) =>
          value.length > 0,
      );

  // Se il provider restituisce solo il numero della giornata,
  // lo consideriamo una gara di regular season.
  if (!text) {
    return true;
  }

  const normalized =
    text.toLowerCase();

  return (
    normalized.includes(
      'regular season',
    ) ||
    /^\d+$/.test(
      normalized,
    )
  );
}

async function loadSupportedLeagueSeasonMatches({
  season,
  leagueName,
  countryName,
}) {
  const league =
    resolveSupportedLeague({
      leagueName,
      countryName,
    });

  if (!league) {
    const error = new Error(
      `Campionato non supportato: ${leagueName} / ${countryName}`,
    );

    error.statusCode = 400;
    throw error;
  }

  const isCentralSerieA =
    league.key === 'serie-a' &&
    String(season) ===
      CURRENT_SERIE_A_SEASON;

  if (isCentralSerieA) {
    return centralSerieAState.matches;
  }

  const cacheKey = [
    'supported-league-season-v1',
    String(season),
    league.key,
  ].join('-');

  const memory =
    getMemoryCache(
      cacheKey,
      RECENT_CACHE_TIME,
    );

  if (memory) {
    return memory;
  }

  const disk =
    await getDiskCache(
      cacheKey,
      RECENT_CACHE_TIME,
    );

  if (disk) {
    setMemoryCache(
      cacheKey,
      disk,
    );

    return disk;
  }

  const allMatches = [];
  const pageLimit = 100;
  let offset = 0;
  let totalCount = null;

  while (offset < 1000) {
    const payload =
      await highlightlyGet(
        '/matches',
        {
          leagueName:
            league.leagueName,
          countryName:
            league.countryName,
          season:
            String(season),
          timezone:
            'Europe/Rome',
          limit:
            String(pageLimit),
          offset:
            String(offset),
        },
      );

    const pageMatches =
      extractMatches(
        payload,
      );

    allMatches.push(
      ...pageMatches,
    );

    const declaredTotal =
      Number(
        payload?.pagination
          ?.totalCount,
      );

    if (
      Number.isFinite(
        declaredTotal,
      )
    ) {
      totalCount =
        declaredTotal;
    }

    if (
      pageMatches.length === 0 ||
      pageMatches.length <
        pageLimit ||
      (
        Number.isFinite(
          totalCount,
        ) &&
        allMatches.length >=
          totalCount
      )
    ) {
      break;
    }

    offset +=
      pageLimit;
  }

  const regularSeasonMatches =
    uniqueMatches(
      allMatches,
    )
      .filter(
        regularSeasonMatch,
      )
      .sort(
        (a, b) =>
          Date.parse(
            a?.date ?? '',
          ) -
          Date.parse(
            b?.date ?? '',
          ),
      );

  setMemoryCache(
    cacheKey,
    regularSeasonMatches,
  );

  await setDiskCache(
    cacheKey,
    regularSeasonMatches,
  );

  return regularSeasonMatches;
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
    if (
      probability === null ||
      probability === undefined ||
      probability === ''
    ) {
      return;
    }

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
      !metric?.available ||
      metric.topSignalAvailable === false
    ) {
      continue;
    }

    const line =
      Number(
        metric.topSignalLine ??
        metric.line,
      );

    if (
      !Number.isFinite(line)
    ) {
      continue;
    }

    addCandidate({
      label:
        `${label} Over ${line}`,
      probability:
        metric.topSignalOverProbability ??
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
        metric.topSignalUnderProbability ??
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

async function getOrPersistMatchdayPickResult({
  match,
  snapshot,
  historicalSeason,
  leagueName,
  countryName,
  allowProvider = false,
}) {
  if (!snapshot?.pick) {
    if (!isFinishedMatch(match)) {
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

    return {
      status:
        'unavailable',
      settled:
        false,
      actualLabel:
        `Finale ${score.home}-${score.away}`,
      homeGoals:
        score.home,
      awayGoals:
        score.away,
      resultOnly:
        true,
    };
  }

  const archived =
    await getPermanentMatchdayPickRecord({
      matchId:
        match?.id,
      historicalSeason,
      leagueName,
      countryName,
    });

  if (
    archived
      ?.result
      ?.settled
  ) {
    return archived.result;
  }

  const result =
    await evaluateMatchdayPick(
      match,
      snapshot.pick,
      {
        allowProvider,
      },
    );

  // Dopo il calcio d'inizio il pick viene comunque archiviato.
  // Il risultato resta aggiornabile finché non diventa definitivamente settled.
  const startMs =
    Date.parse(
      match?.date ?? '',
    );

  if (
    Number.isFinite(startMs) &&
    Date.now() >= startMs
  ) {
    await persistPermanentMatchdayPickRecord({
      match,
      snapshot,
      result,
      historicalSeason,
      leagueName,
      countryName,
    });
  }

  return result;
}

async function getExistingMatchAnalysisSnapshot({
  homeTeamId,
  awayTeamId,
  historicalSeason,
  leagueName,
  countryName,
  cacheVariant = null,
  cacheTtl =
    PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
  allowPermanent = true,
  allowLegacy = true,
}) {
  if (allowPermanent) {
    const permanent =
      await getPermanentMatchAnalysisRecord({
        homeTeamId,
        awayTeamId,
        historicalSeason,
        leagueName,
        countryName,
      });

    if (permanent?.analysis) {
      return permanent.analysis;
    }
  }

  const key =
    buildMatchAnalysisCacheKey({
      homeTeamId,
      awayTeamId,
      historicalSeason,
      leagueName,
      countryName,
      cacheVariant,
    });

  const memory =
    getMemoryCache(
      key,
      cacheTtl,
    );

  if (memory) {
    return memory;
  }

  const disk =
    await getDiskCache(
      key,
      cacheTtl,
    );

  if (disk) {
    setMemoryCache(
      key,
      disk,
    );

    return disk;
  }

  if (allowLegacy && !cacheVariant) {
    const legacy =
      await readLegacyMatchAnalysisSnapshot({
        homeTeamId,
        awayTeamId,
        historicalSeason,
        leagueName,
        countryName,
      });

    if (legacy?.snapshot) {
      return migrateLegacyMatchAnalysisSnapshot({
        homeTeamId,
        awayTeamId,
        historicalSeason,
        leagueName,
        countryName,
        legacy,
      });
    }
  }

  return null;
}

async function getOrCreateMatchdayPickSnapshot({
  match,
  homeTeamId,
  awayTeamId,
  historicalSeason,
  leagueName,
  countryName,
}) {
  const matchId =
    match?.id;

  const snapshotVersion =
    matchdayPickSnapshotVersionForMatch(
      match,
    );

  const key =
    buildMatchdayPickSnapshotKey({
      version:
        snapshotVersion,
      matchId,
      historicalSeason,
      leagueName,
      countryName,
    });

  const matchStartMs =
    Date.parse(
      match?.date ?? '',
    );

  const beforeKickoff =
    Number.isFinite(matchStartMs) &&
    Date.now() < matchStartMs;

  const predictionFreezeActive =
    Number.isFinite(matchStartMs) &&
    Date.now() >=
      matchStartMs -
        PREMATCH_PREDICTION_FREEZE_WINDOW;

  function snapshotIsFresh(snapshot) {
    if (!snapshot?.pick) {
      return false;
    }

    // Da 60 minuti prima del calcio d'inizio il pronostico prematch
    // resta congelato, e rimane invariato anche dopo il fischio iniziale.
    if (predictionFreezeActive || !beforeKickoff) {
      return true;
    }

    const generatedAtMs =
      Date.parse(
        snapshot?.generatedAt ?? '',
      );

    return (
      Number.isFinite(generatedAtMs) &&
      Date.now() - generatedAtMs <
        30 * 60 * 1000
    );
  }

  // Un record storico già archiviato ha priorità assoluta:
  // il pronostico pubblicato non può più essere riscritto.
  const permanentRecord =
    await getPermanentMatchdayPickRecord({
      matchId,
      historicalSeason,
      leagueName,
      countryName,
    });

  const permanentSnapshot =
    snapshotFromPermanentRecord(
      permanentRecord,
    );

  if (permanentSnapshot) {
    return permanentSnapshot;
  }

  const current =
    await readMatchdayPickSnapshotVersion({
      version:
        snapshotVersion,
      matchId,
      historicalSeason,
      leagueName,
      countryName,
    });

  if (
    current.snapshot &&
    snapshotIsFresh(
      current.snapshot,
    )
  ) {
    if (
      predictionFreezeActive ||
      !beforeKickoff
    ) {
      await persistPermanentMatchdayPickRecord({
        match,
        snapshot:
          current.snapshot,
        historicalSeason,
        leagueName,
        countryName,
      });
    }

    return current.snapshot;
  }

  if (
    snapshotVersion ===
      MATCHDAY_PICK_SNAPSHOT_CURRENT_VERSION
  ) {
    // Compatibilità con gli snapshot storici v2.
    // Se esistono, vengono copiati in v3 senza cambiare pick o data originale.
    for (
      const legacyVersion
        of MATCHDAY_PICK_SNAPSHOT_LEGACY_VERSIONS
    ) {
      const legacy =
        await readMatchdayPickSnapshotVersion({
          version:
            legacyVersion,
          matchId,
          historicalSeason,
          leagueName,
          countryName,
        });

      if (
        !legacy.snapshot?.pick ||
        !snapshotIsFresh(
          legacy.snapshot,
        )
      ) {
        continue;
      }

      const migrated =
        await migrateLegacyMatchdayPickSnapshot({
          legacyVersion,
          matchId,
          historicalSeason,
          leagueName,
          countryName,
          snapshot:
            legacy.snapshot,
        });

      if (
        predictionFreezeActive ||
        !beforeKickoff
      ) {
        await persistPermanentMatchdayPickRecord({
          match,
          snapshot:
            migrated,
          historicalSeason,
          leagueName,
          countryName,
        });
      }

      return migrated;
    }
  }

  // Protezione anti-retroattività: se la partita è già iniziata
  // e non esiste alcun pronostico prematch storico, NON ne creiamo uno dopo.
  if (
    Number.isFinite(matchStartMs) &&
    !beforeKickoff
  ) {
    return null;
  }

  const requestedLeague =
    resolveSupportedLeague({
      leagueName,
      countryName,
    });

  const directBookmakerOnly =
    bookmakerOnlyModeForRound(
      roundNumberOf(match),
    ) &&
    requestedLeague &&
    requestedLeague.key !==
      'serie-a';

  // Dalla giornata 3 le nuove leghe lavorano in modalità 100% bookmaker.
  // Per creare il Top Signal non serve quindi costruire prima tutta
  // l'analisi PREDICT storica: basta il feed quote della partita.
  // Questo riduce drasticamente le chiamate Highlightly e permette anche
  // alle neopromosse di avere una pick quando le quote sono disponibili.
  if (directBookmakerOnly) {
    const directPick =
      await buildBookmakerOnlyMatchdayPick(
        match,
      );

    const directSnapshot = {
      pick:
        directPick,

      modelVersion:
        'PREDICT v5',

      generatedAt:
        new Date()
          .toISOString(),
    };

    setMemoryCache(
      key,
      directSnapshot,
    );

    await setDiskCache(
      key,
      directSnapshot,
    );

    if (
      directSnapshot?.pick &&
      predictionFreezeActive
    ) {
      await persistPermanentMatchdayPickRecord({
        match,
        snapshot:
          directSnapshot,
        historicalSeason,
        leagueName,
        countryName,
      });
    }

    return directSnapshot;
  }

  const analysis =
    await internalMatchAnalysis({
      homeTeamId,
      awayTeamId,
      matchId,
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

  if (
    snapshot?.pick &&
    predictionFreezeActive
  ) {
    await persistPermanentMatchdayPickRecord({
      match,
      snapshot,
      historicalSeason,
      leagueName,
      countryName,
    });
  }

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
  matchId = null,
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

  if (matchId !== null && matchId !== undefined) {
    params.set(
      'matchId',
      String(matchId),
    );
  }

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

// ====================================================
// MULTIPLE PREDICT DI GIORNATA
// ====================================================

function buildMatchdayMultipleCacheKey({
  season,
  historicalSeason,
  round,
  leagueName,
  countryName,
}) {
  return [
    'matchday-multiples-snapshot-v1',
    season,
    historicalSeason,
    round,
    leagueName,
    countryName,
  ].join('-');
}

async function getExistingMatchdayMultipleSnapshot({
  season,
  historicalSeason,
  round,
  leagueName,
  countryName,
}) {
  const key =
    buildMatchdayMultipleCacheKey({
      season,
      historicalSeason,
      round,
      leagueName,
      countryName,
    });

  const archiveKey =
    buildMatchdayMultipleArchiveKey({
      season,
      historicalSeason,
      round,
      leagueName,
      countryName,
    });

  const archived =
    await getPermanentCache(
      archiveKey,
    );

  if (
    archived?.frozen &&
    archived?.available
  ) {
    setMemoryCache(
      key,
      archived,
    );

    return archived;
  }

  const memory =
    getMemoryCache(
      key,
      MATCHDAY_MULTIPLE_SNAPSHOT_CACHE_TIME,
    );

  if (memory) {
    return memory;
  }

  const disk =
    await getDiskCache(
      key,
      MATCHDAY_MULTIPLE_SNAPSHOT_CACHE_TIME,
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

function buildMultipleFromRankedPicks(
  rankedPicks,
  requestedEvents,
) {
  const selections =
    rankedPicks
      .slice(
        0,
        requestedEvents,
      )
      .map(
        (item) => ({
          matchId:
            item?.matchId ?? null,

          date:
            item?.date ?? null,

          homeTeam:
            item?.homeTeam ?? null,

          awayTeam:
            item?.awayTeam ?? null,

          pick:
            item?.pick ?? null,

          pickGeneratedAt:
            item?.pickGeneratedAt ?? null,

          modelVersion:
            item?.modelVersion ??
            'PREDICT v5',
        }),
      );

  return {
    requestedEvents,

    eventsCount:
      selections.length,

    ready:
      selections.length ===
      requestedEvents,

    selections,
  };
}

function buildRankedMultipleCandidates(
  picks,
) {
  return (picks ?? [])
    .filter(
      (item) =>
        item?.pick &&
        Number.isFinite(
          Number(
            item?.pick?.probability,
          ),
        ),
    )
    .sort(
      (a, b) =>
        Number(
          b?.pick?.probability ?? 0,
        ) -
        Number(
          a?.pick?.probability ?? 0,
        ),
    );
}


function buildMultipleResultSummary(
  accumulator,
) {
  const selections =
    Array.isArray(
      accumulator?.selections,
    )
      ? accumulator.selections
      : [];

  const statuses =
    selections.map(
      (selection) =>
        selection?.result
          ?.status ??
        'pending',
    );

  const wonSelections =
    statuses.filter(
      (status) =>
        status === 'won',
    ).length;

  const lostSelections =
    statuses.filter(
      (status) =>
        status === 'lost',
    ).length;

  const unavailableSelections =
    statuses.filter(
      (status) =>
        status ===
        'unavailable',
    ).length;

  const pendingSelections =
    Math.max(
      0,
      selections.length -
        wonSelections -
        lostSelections -
        unavailableSelections,
    );

  let status =
    'pending';

  let settled =
    false;

  let won =
    null;

  if (lostSelections > 0) {
    status =
      'lost';
    settled =
      true;
    won =
      false;
  } else if (
    selections.length > 0 &&
    wonSelections ===
      selections.length
  ) {
    status =
      'won';
    settled =
      true;
    won =
      true;
  }

  return {
    status,
    settled,
    won,
    verifiedSelections:
      wonSelections +
      lostSelections,
    wonSelections,
    lostSelections,
    pendingSelections,
    unavailableSelections,
  };
}

async function evaluateFrozenMultipleAccumulator({
  accumulator,
  roundMatches,
  allowProvider = false,
}) {
  if (
    !accumulator?.ready ||
    !Array.isArray(
      accumulator.selections,
    )
  ) {
    return accumulator;
  }

  const matchesById =
    new Map(
      (roundMatches ?? [])
        .map(
          (match) => [
            String(
              match?.id,
            ),
            match,
          ],
        ),
    );

  const selections =
    [];

  for (
    const selection
      of accumulator.selections
  ) {
    const match =
      matchesById.get(
        String(
          selection?.matchId,
        ),
      );

    let result =
      selection?.result ?? {
        status:
          'pending',
        settled:
          false,
      };

    if (match) {
      try {
        const evaluated =
          await evaluateMatchdayPick(
            match,
            selection?.pick,
            {
              allowProvider,
            },
          );

        // Un risultato già definitivo non torna mai indietro.
        if (
          result?.settled
        ) {
          result = {
            ...evaluated,
            ...result,
          };
        } else {
          result =
            evaluated;
        }
      } catch (error) {
        result = {
          status:
            result?.status ??
            'pending',
          settled:
            Boolean(
              result?.settled,
            ),
          error:
            error?.message ??
            String(error),
        };
      }
    }

    selections.push({
      ...selection,
      result,
    });
  }

  const nextAccumulator = {
    ...accumulator,
    selections,
  };

  const summary =
    buildMultipleResultSummary(
      nextAccumulator,
    );

  const oldResult =
    accumulator?.result;

  return {
    ...nextAccumulator,
    result: {
      ...summary,
      settledAt:
        oldResult?.settledAt ??
        (summary.settled
          ? new Date()
              .toISOString()
          : null),
      updatedAt:
        new Date()
          .toISOString(),
    },
  };
}

async function persistOfficialMultipleSnapshot(
  snapshot,
) {
  if (
    !snapshot?.frozen ||
    !snapshot?.available
  ) {
    return snapshot;
  }

  const archiveKey =
    buildMatchdayMultipleArchiveKey({
      season:
        snapshot.season,
      historicalSeason:
        snapshot.historicalSeason,
      round:
        snapshot.round,
      leagueName:
        snapshot.leagueName,
      countryName:
        snapshot.countryName,
    });

  const existing =
    await getPermanentCache(
      archiveKey,
    );

  if (
    existing?.frozen &&
    existing?.available
  ) {
    return existing;
  }

  const archived = {
    ...snapshot,
    archivedAt:
      new Date()
        .toISOString(),
  };

  await setPermanentCache(
    archiveKey,
    archived,
  );

  return archived;
}

async function settleAndPersistMatchdayMultipleSnapshot({
  snapshot,
  roundMatches,
  allowProvider = false,
}) {
  if (
    !snapshot?.frozen ||
    !snapshot?.available
  ) {
    return snapshot;
  }

  const multipla3 =
    await evaluateFrozenMultipleAccumulator({
      accumulator:
        snapshot.multipla3,
      roundMatches,
      allowProvider,
    });

  const multipla5 =
    await evaluateFrozenMultipleAccumulator({
      accumulator:
        snapshot.multipla5,
      roundMatches,
      allowProvider,
    });

  const updated = {
    ...snapshot,
    multipla3,
    multipla5,
    resultUpdatedAt:
      new Date()
        .toISOString(),
  };

  const archiveKey =
    buildMatchdayMultipleArchiveKey({
      season:
        snapshot.season,
      historicalSeason:
        snapshot.historicalSeason,
      round:
        snapshot.round,
      leagueName:
        snapshot.leagueName,
      countryName:
        snapshot.countryName,
    });

  await setPermanentCache(
    archiveKey,
    updated,
  );

  const cacheKey =
    buildMatchdayMultipleCacheKey({
      season:
        snapshot.season,
      historicalSeason:
        snapshot.historicalSeason,
      round:
        snapshot.round,
      leagueName:
        snapshot.leagueName,
      countryName:
        snapshot.countryName,
    });

  setMemoryCache(
    cacheKey,
    updated,
  );

  await setDiskCache(
    cacheKey,
    updated,
  );

  return updated;
}

function emptyMultipleSummary() {
  return {
    verified: 0,
    won: 0,
    lost: 0,
    pending: 0,
    successRate: null,
  };
}

function addMultipleToSummary(
  summary,
  accumulator,
) {
  if (
    !accumulator?.ready
  ) {
    return;
  }

  const status =
    accumulator?.result
      ?.status ??
    'pending';

  if (status === 'won') {
    summary.won += 1;
    summary.verified +=
      1;
  } else if (
    status === 'lost'
  ) {
    summary.lost += 1;
    summary.verified +=
      1;
  } else {
    summary.pending +=
      1;
  }
}

async function buildAndPersistMultiplesSummary({
  season,
  historicalSeason,
  leagueName,
  countryName,
}) {
  const supportedLeague =
    resolveSupportedLeague({
      leagueName,
      countryName,
    });

  if (!supportedLeague) {
    throw new Error(
      `Campionato non supportato: ${leagueName} / ${countryName}`,
    );
  }

  const regularSeasonRounds =
    Number(
      supportedLeague
        .regularSeasonRounds,
    ) || 38;

  const multipla3 =
    emptyMultipleSummary();

  const multipla5 =
    emptyMultipleSummary();

  let officialRounds =
    0;

  for (
    let round = 1;
    round <=
      regularSeasonRounds;
    round += 1
  ) {
    const archiveKey =
      buildMatchdayMultipleArchiveKey({
        season,
        historicalSeason,
        round,
        leagueName:
          supportedLeague
            .leagueName,
        countryName:
          supportedLeague
            .countryName,
      });

    const archived =
      await getPermanentCache(
        archiveKey,
      );

    if (
      !archived?.frozen ||
      !archived?.available
    ) {
      continue;
    }

    officialRounds +=
      1;

    addMultipleToSummary(
      multipla3,
      archived.multipla3,
    );

    addMultipleToSummary(
      multipla5,
      archived.multipla5,
    );
  }

  for (
    const summary
      of [
        multipla3,
        multipla5,
      ]
  ) {
    summary.successRate =
      summary.verified > 0
        ? round2(
            (
              summary.won /
              summary.verified
            ) *
              100,
          )
        : null;
  }

  const payload = {
    season:
      String(season),
    historicalSeason:
      String(
        historicalSeason,
      ),
    leagueName:
      supportedLeague
        .leagueName,
    countryName:
      supportedLeague
        .countryName,
    regularSeasonRounds,
    generatedAt:
      new Date()
        .toISOString(),
    officialRounds,
    multipla3,
    multipla5,
  };

  const summaryKey =
    buildSeasonMultiplesSummaryArchiveKey({
      season,
      historicalSeason,
      leagueName,
      countryName,
    });

  await setPermanentCache(
    summaryKey,
    payload,
  );

  return payload;
}

async function settlePermanentMultipleHistory({
  season =
    CURRENT_SERIE_A_SEASON,
  historicalSeason =
    '2025',
  leagueName =
    'Serie A',
  countryName =
    'Italy',
  allowProvider =
    false,
} = {}) {
  const supportedLeague =
    resolveSupportedLeague({
      leagueName,
      countryName,
    });

  if (!supportedLeague) {
    return false;
  }

  const regularSeasonRounds =
    Number(
      supportedLeague
        .regularSeasonRounds,
    ) || 38;

  const seasonMatches =
    await loadSupportedLeagueSeasonMatches({
      season,
      leagueName:
        supportedLeague
          .leagueName,
      countryName:
        supportedLeague
          .countryName,
    });

  const rounds =
    new Map();

  for (
    const match
      of seasonMatches
  ) {
    const round =
      roundNumberOf(
        match,
      );

    if (
      !round ||
      round < 1 ||
      round >
        regularSeasonRounds
    ) {
      continue;
    }

    if (!rounds.has(round)) {
      rounds.set(
        round,
        [],
      );
    }

    rounds.get(
      round,
    ).push(
      match,
    );
  }

  let changed =
    false;

  for (
    const [
      round,
      roundMatches,
    ] of rounds.entries()
  ) {
    const archiveKey =
      buildMatchdayMultipleArchiveKey({
        season,
        historicalSeason,
        round,
        leagueName:
          supportedLeague
            .leagueName,
        countryName:
          supportedLeague
            .countryName,
      });

    const archived =
      await getPermanentCache(
        archiveKey,
      );

    if (
      !archived?.frozen ||
      !archived?.available
    ) {
      continue;
    }

    const before3 =
      archived?.multipla3
        ?.result?.status ??
      'pending';

    const before5 =
      archived?.multipla5
        ?.result?.status ??
      'pending';

    const updated =
      await settleAndPersistMatchdayMultipleSnapshot({
        snapshot:
          archived,
        roundMatches,
        allowProvider,
      });

    const after3 =
      updated?.multipla3
        ?.result?.status ??
      'pending';

    const after5 =
      updated?.multipla5
        ?.result?.status ??
      'pending';

    if (
      before3 !== after3 ||
      before5 !== after5
    ) {
      changed =
        true;
    }
  }

  await buildAndPersistMultiplesSummary({
    season,
    historicalSeason,
    leagueName:
      supportedLeague
        .leagueName,
    countryName:
      supportedLeague
        .countryName,
  });

  return changed;
}

async function getOrUpdateMatchdayMultiplesSnapshot({
  season,
  historicalSeason,
  round,
  leagueName,
  countryName,
  roundMatches,
  picks,
}) {
  const validStarts =
    (roundMatches ?? [])
      .map(
        (match) =>
          Date.parse(
            match?.date ?? '',
          ),
      )
      .filter(
        (value) =>
          Number.isFinite(value),
      )
      .sort(
        (a, b) =>
          a - b,
      );

  if (validStarts.length === 0) {
    return {
      available: false,
      frozen: false,
      status: 'unavailable',
      reason:
        'Orario della prima partita non disponibile',
      multipla3:
        buildMultipleFromRankedPicks(
          [],
          3,
        ),
      multipla5:
        buildMultipleFromRankedPicks(
          [],
          5,
        ),
    };
  }

  const firstMatchStartMs =
    validStarts[0];

  const freezeAtMs =
    firstMatchStartMs -
    MATCHDAY_MULTIPLE_FREEZE_WINDOW;

  const now =
    Date.now();

  const key =
    buildMatchdayMultipleCacheKey({
      season,
      historicalSeason,
      round,
      leagueName,
      countryName,
    });

  const existing =
    await getExistingMatchdayMultipleSnapshot({
      season,
      historicalSeason,
      round,
      leagueName,
      countryName,
    });

  const existingCandidateCount =
    Number(
      existing?.candidateCount ??
      existing?.multipla5?.eventsCount ??
      existing?.multipla3?.eventsCount ??
      0,
    );

  const existingUsable =
    existingCandidateCount >= 3 &&
    Boolean(
      existing?.multipla3?.ready,
    );

  // Uno snapshot congelato valido non viene mai più modificato.
  // I vecchi snapshot vuoti 0/3 - 0/5 non vengono considerati storici validi.
  if (
    existing?.frozen &&
    existingUsable
  ) {
    return await persistOfficialMultipleSnapshot(
      existing,
    );
  }

  if (
    now >= firstMatchStartMs &&
    !existingUsable
  ) {
    return {
      available: false,
      season:
        String(season),
      historicalSeason:
        String(historicalSeason),
      leagueName,
      countryName,
      round:
        Number(round),
      firstMatchAt:
        new Date(
          firstMatchStartMs,
        ).toISOString(),
      freezeAt:
        new Date(
          freezeAtMs,
        ).toISOString(),
      freezeHoursBeforeFirstMatch:
        MATCHDAY_MULTIPLE_FREEZE_WINDOW /
        (60 * 60 * 1000),
      frozen: false,
      status: 'closed',
      reason:
        'Nessuna multipla PREDICT valida era stata congelata prima dell’inizio della giornata.',
      candidateCount: 0,
      multipla3:
        buildMultipleFromRankedPicks(
          [],
          3,
        ),
      multipla5:
        buildMultipleFromRankedPicks(
          [],
          5,
        ),
    };
  }

  // Se siamo arrivati al cutoff, congeliamo l'ULTIMO snapshot provvisorio
  // soltanto se contiene davvero almeno 5 candidati, così 3 e 5 eventi
  // vengono congelate insieme e non esistono multiple vuote.
  if (
    now >= freezeAtMs &&
    existing &&
    existingCandidateCount >= 5 &&
    existing?.multipla3?.ready &&
    existing?.multipla5?.ready
  ) {
    const frozenSnapshot = {
      ...existing,
      frozen: true,
      status: 'frozen',
      frozenAt:
        new Date(now)
          .toISOString(),
      freezeAt:
        new Date(freezeAtMs)
          .toISOString(),
      firstMatchAt:
        new Date(firstMatchStartMs)
          .toISOString(),
    };

    setMemoryCache(
      key,
      frozenSnapshot,
    );

    await setDiskCache(
      key,
      frozenSnapshot,
    );

    return await persistOfficialMultipleSnapshot(
      frozenSnapshot,
    );
  }

  const rankedPicks =
    buildRankedMultipleCandidates(
      picks,
    );

  if (
    now >= freezeAtMs &&
    rankedPicks.length < 5
  ) {
    return {
      available: false,
      season:
        String(season),
      historicalSeason:
        String(historicalSeason),
      leagueName,
      countryName,
      round:
        Number(round),
      generatedAt:
        new Date()
          .toISOString(),
      firstMatchAt:
        new Date(
          firstMatchStartMs,
        ).toISOString(),
      freezeAt:
        new Date(
          freezeAtMs,
        ).toISOString(),
      freezeHoursBeforeFirstMatch:
        MATCHDAY_MULTIPLE_FREEZE_WINDOW /
        (60 * 60 * 1000),
      frozen: false,
      status: 'preparing-freeze',
      reason:
        'In attesa di almeno 5 pronostici validi prima del congelamento.',
      candidateCount:
        rankedPicks.length,
      multipla3:
        buildMultipleFromRankedPicks(
          rankedPicks,
          3,
        ),
      multipla5:
        buildMultipleFromRankedPicks(
          rankedPicks,
          5,
        ),
    };
  }

  const generatedAt =
    new Date()
      .toISOString();

  const snapshot = {
    available:
      rankedPicks.length >= 3,

    season:
      String(season),

    historicalSeason:
      String(historicalSeason),

    leagueName,
    countryName,

    round:
      Number(round),

    generatedAt,

    firstMatchAt:
      new Date(firstMatchStartMs)
        .toISOString(),

    freezeAt:
      new Date(freezeAtMs)
        .toISOString(),

    freezeHoursBeforeFirstMatch:
      MATCHDAY_MULTIPLE_FREEZE_WINDOW /
      (60 * 60 * 1000),

    frozen:
      now >= freezeAtMs,

    status:
      now >= freezeAtMs
        ? 'frozen'
        : 'provisional',

    frozenAt:
      now >= freezeAtMs
        ? generatedAt
        : null,

    candidateCount:
      rankedPicks.length,

    description:
      'Multipla PREDICT costruita con una sola selezione per partita e con le pick a probabilità più alta della giornata. Multipla 3 e Multipla 5 vengono congelate insieme 4 ore prima della prima partita della giornata.',

    multipla3:
      buildMultipleFromRankedPicks(
        rankedPicks,
        3,
      ),

    multipla5:
      buildMultipleFromRankedPicks(
        rankedPicks,
        5,
      ),
  };

  setMemoryCache(
    key,
    snapshot,
  );

  await setDiskCache(
    key,
    snapshot,
  );

  if (snapshot.frozen) {
    return await persistOfficialMultipleSnapshot(
      snapshot,
    );
  }

  return snapshot;
}

async function precomputeUpcomingMatchdayMultiples() {
  const now =
    Date.now();

  const rounds =
    new Map();

  for (
    const match
      of centralSerieAState.matches
  ) {
    const round =
      roundNumberOf(match);

    const startMs =
      Date.parse(
        match?.date ?? '',
      );

    if (
      !Number.isFinite(
        Number(round),
      ) ||
      !Number.isFinite(startMs)
    ) {
      continue;
    }

    if (
      startMs <= now ||
      startMs - now >
        CENTRAL_PREDICTION_HORIZON
    ) {
      continue;
    }

    const numericRound =
      Number(round);

    if (!rounds.has(numericRound)) {
      rounds.set(
        numericRound,
        [],
      );
    }
  }

  for (
    const round
      of rounds.keys()
  ) {
    const roundMatches =
      centralSerieAState.matches
        .filter(
          (match) =>
            roundNumberOf(match) ===
            round,
        )
        .sort(
          (a, b) =>
            Date.parse(
              a?.date ?? '',
            ) -
            Date.parse(
              b?.date ?? '',
            ),
        );

    if (
      roundMatches.length === 0
    ) {
      continue;
    }

    const picks = [];

    for (
      const match
        of roundMatches
    ) {
      const snapshot =
        await getExistingMatchdayPickSnapshot({
          matchId:
            match?.id,
          historicalSeason:
            '2025',
          leagueName:
            'Serie A',
          countryName:
            'Italy',
        });

      if (!snapshot?.pick) {
        continue;
      }

      picks.push({
        matchId:
          match?.id ?? null,

        date:
          match?.date ?? null,

        homeTeam:
          match?.homeTeam ?? null,

        awayTeam:
          match?.awayTeam ?? null,

        pick:
          snapshot.pick,

        pickGeneratedAt:
          snapshot.generatedAt ?? null,

        modelVersion:
          snapshot.modelVersion ??
          'PREDICT v5',
      });
    }

    await getOrUpdateMatchdayMultiplesSnapshot({
      season:
        CURRENT_SERIE_A_SEASON,
      historicalSeason:
        '2025',
      round,
      leagueName:
        'Serie A',
      countryName:
        'Italy',
      roundMatches,
      picks,
    });

    // La pagina Pronostici Serie A deve leggere subito l'ultimo snapshot.
    await deleteCacheKey(
      [
        matchdayPicksAggregatePrefixForRound(
          round,
        ),
        CURRENT_SERIE_A_SEASON,
        '2025',
        round,
        'Serie A',
        'Italy',
      ].join('-'),
    );
  }
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

      const requestedLeague =
        resolveSupportedLeague({
          leagueName,
          countryName,
        });

      const isCentralSerieARequest =
        requestedLeague?.key ===
          'serie-a' &&
        String(season) ===
          CURRENT_SERIE_A_SEASON;

      const aggregatePrefix =
        isCentralSerieARequest
          ? matchdayPicksAggregatePrefixForRound(
              parsedRound,
            )
          : `${matchdayPicksAggregatePrefixForRound(
              parsedRound,
            )}-real-results-v1`;

      const cacheKey = [
        aggregatePrefix,
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
        await loadSupportedLeagueSeasonMatches({
          season,
          leagueName,
          countryName,
        });

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

      const historyArchiveKey =
        buildMatchdayRoundArchiveKey({
          season,
          historicalSeason,
          round:
            parsedRound,
          leagueName,
          countryName,
        });

      const archivedRound =
        await getPermanentCache(
          historyArchiveKey,
        );

      if (
        roundMatches.length ===
        0
      ) {
        if (archivedRound) {
          return res.json({
            ...archivedRound,
            cached: true,
            cacheSource:
              'history-archive',
          });
        }

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

      const picksConcurrency =
        isCentralSerieARequest
          ? 3
          : 1;

      const picks =
        await mapWithConcurrency(
          roundMatches,
          picksConcurrency,
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
              let snapshot =
                await getExistingMatchdayPickSnapshot({
                  match,
                  matchId:
                    match?.id,
                  historicalSeason,
                  leagueName,
                  countryName,
                });

              // La Serie A continua a usare esclusivamente il suo scheduler
              // centrale già stabile. Per gli altri campionati supportati,
              // se lo snapshot non esiste ancora lo generiamo al primo
              // caricamento della giornata e poi lo riutilizziamo dalla cache.
              if (
                !snapshot?.pick &&
                !isCentralSerieARequest
              ) {
                snapshot =
                  await getOrCreateMatchdayPickSnapshot({
                    match,
                    homeTeamId,
                    awayTeamId,
                    historicalSeason,
                    leagueName,
                    countryName,
                  });
              }

              const result =
                await getOrPersistMatchdayPickResult({
                  match,
                  snapshot,
                  historicalSeason,
                  leagueName,
                  countryName,
                  allowProvider:
                    forceRefresh,
                });

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

      let multiples =
        await getOrUpdateMatchdayMultiplesSnapshot({
          season,
          historicalSeason,
          round:
            parsedRound,
          leagueName,
          countryName,
          roundMatches,
          picks,
        });

      if (
        multiples?.frozen &&
        multiples?.available
      ) {
        multiples =
          await settleAndPersistMatchdayMultipleSnapshot({
            snapshot:
              multiples,
            roundMatches,
            allowProvider:
              forceRefresh,
          });
      }

      const firstRoundStartMs =
        Math.min(
          ...roundMatches
            .map(
              (match) =>
                Date.parse(
                  match?.date ?? '',
                ),
            )
            .filter(
              (value) =>
                Number.isFinite(value),
            ),
        );

      const roundHasStarted =
        Number.isFinite(
          firstRoundStartMs,
        ) &&
        Date.now() >=
          firstRoundStartMs;

      let finalPicks =
        picks;

      if (
        roundHasStarted &&
        Array.isArray(
          archivedRound?.picks,
        )
      ) {
        const archivedByMatchId =
          new Map(
            archivedRound.picks.map(
              (item) => [
                String(
                  item?.matchId,
                ),
                item,
              ],
            ),
          );

        finalPicks =
          picks.map(
            (item) => {
              const oldItem =
                archivedByMatchId.get(
                  String(
                    item?.matchId,
                  ),
                );

              if (!oldItem) {
                return item;
              }

              return {
                ...item,

                pick:
                  item?.pick ??
                  oldItem?.pick ??
                  null,

                pickGeneratedAt:
                  item
                    ?.pickGeneratedAt ??
                  oldItem
                    ?.pickGeneratedAt ??
                  null,

                modelVersion:
                  item
                    ?.pick
                    ? item?.modelVersion
                    : oldItem
                        ?.modelVersion ??
                      item?.modelVersion,

                result:
                  oldItem
                    ?.result
                    ?.settled
                    ? oldItem.result
                    : item?.result,
              };
            },
          );
      }

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
          finalPicks.length,

        generatedAt:
          new Date()
            .toISOString(),

        description:
          'Per ogni partita viene mostrato un solo pronostico principale tra 1X2, GG/NG, Under/Over 2.5, Corner, Tiri in porta e Cartellini. A partita conclusa il pronostico viene marcato come preso o sbagliato.',

        multiples:
          roundHasStarted &&
          !multiples?.available &&
          archivedRound
            ?.multiples
            ?.available
            ? archivedRound.multiples
            : multiples,

        picks:
          finalPicks,
      };

      setMemoryCache(
        cacheKey,
        payload,
      );

      await setDiskCache(
        cacheKey,
        payload,
      );

      // Copia persistente della giornata: resta disponibile anche dopo
      // riavvii, deploy e problemi temporanei del provider/calendario.
      await setPermanentCache(
        historyArchiveKey,
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
  match = null,
  matchId,
  historicalSeason,
  leagueName,
  countryName,
}) {
  const referenceMatch =
    match ??
    centralSerieAState.matches.find(
      (item) =>
        String(item?.id) ===
        String(matchId),
    );

  const snapshotVersion =
    matchdayPickSnapshotVersionForMatch(
      referenceMatch,
    );

  const permanentRecord =
    await getPermanentMatchdayPickRecord({
      matchId,
      historicalSeason,
      leagueName,
      countryName,
    });

  const permanentSnapshot =
    snapshotFromPermanentRecord(
      permanentRecord,
    );

  if (permanentSnapshot) {
    return permanentSnapshot;
  }

  const current =
    await readMatchdayPickSnapshotVersion({
      version:
        snapshotVersion,
      matchId,
      historicalSeason,
      leagueName,
      countryName,
    });

  if (current.snapshot?.pick) {
    return current.snapshot;
  }

  if (
    snapshotVersion ===
      MATCHDAY_PICK_SNAPSHOT_CURRENT_VERSION
  ) {
    for (
      const legacyVersion
        of MATCHDAY_PICK_SNAPSHOT_LEGACY_VERSIONS
    ) {
      const legacy =
        await readMatchdayPickSnapshotVersion({
          version:
            legacyVersion,
          matchId,
          historicalSeason,
          leagueName,
          countryName,
        });

      if (!legacy.snapshot?.pick) {
        continue;
      }

      return migrateLegacyMatchdayPickSnapshot({
        legacyVersion,
        matchId,
        historicalSeason,
        leagueName,
        countryName,
        snapshot:
          legacy.snapshot,
      });
    }
  }

  return current.snapshot ??
    null;
}

function recomputeSeasonSummaryTotals(
  rounds,
) {
  const totals = {
    generatedPicks: 0,
    verified: 0,
    won: 0,
    lost: 0,
    pending: 0,
    unavailable: 0,
    successRate: null,
  };

  for (const round of rounds) {
    totals.generatedPicks +=
      Number(
        round?.generatedPicks ?? 0,
      );

    totals.verified +=
      Number(
        round?.verified ?? 0,
      );

    totals.won +=
      Number(
        round?.won ?? 0,
      );

    totals.lost +=
      Number(
        round?.lost ?? 0,
      );

    totals.pending +=
      Number(
        round?.pending ?? 0,
      );

    totals.unavailable +=
      Number(
        round?.unavailable ?? 0,
      );
  }

  totals.successRate =
    totals.verified > 0
      ? round2(
          (
            totals.won /
            totals.verified
          ) * 100,
        )
      : null;

  return totals;
}

function mergeSeasonSummaryWithArchive(
  current,
  archived,
) {
  if (!archived?.rounds) {
    return current;
  }

  const currentRounds =
    Array.isArray(current?.rounds)
      ? current.rounds
      : [];

  const archivedRounds =
    Array.isArray(archived?.rounds)
      ? archived.rounds
      : [];

  const rounds =
    Array.from(
      {
        length: 38,
      },
      (_, index) => {
        const roundNumber =
          index + 1;

        const nowRound =
          currentRounds.find(
            (item) =>
              Number(item?.round) ===
              roundNumber,
          ) ??
          emptyRoundPredictSummary(
            roundNumber,
          );

        const oldRound =
          archivedRounds.find(
            (item) =>
              Number(item?.round) ===
              roundNumber,
          ) ??
          null;

        if (!oldRound) {
          return nowRound;
        }

        const nowGenerated =
          Number(
            nowRound
              ?.generatedPicks ?? 0,
          );

        const oldGenerated =
          Number(
            oldRound
              ?.generatedPicks ?? 0,
          );

        const nowVerified =
          Number(
            nowRound
              ?.verified ?? 0,
          );

        const oldVerified =
          Number(
            oldRound
              ?.verified ?? 0,
          );

        const preserveOld =
          oldGenerated > nowGenerated ||
          (
            oldGenerated === nowGenerated &&
            oldVerified > nowVerified
          );

        const selected =
          preserveOld
            ? oldRound
            : nowRound;

        return {
          ...selected,
          matches:
            Math.max(
              Number(
                nowRound?.matches ?? 0,
              ),
              Number(
                oldRound?.matches ?? 0,
              ),
            ),
        };
      },
    );

  const totals =
    recomputeSeasonSummaryTotals(
      rounds,
    );

  return {
    ...current,

    roundsWithPredictions:
      rounds.filter(
        (round) =>
          Number(
            round?.generatedPicks ?? 0,
          ) > 0,
      ).length,

    roundsWithVerifiedPicks:
      rounds.filter(
        (round) =>
          Number(
            round?.verified ?? 0,
          ) > 0,
      ).length,

    totals,
    rounds,
  };
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



// ====================================================
// CLASSIFICA UFFICIALE HIGHLIGHTLY - 5 CAMPIONATI
// ====================================================
//
// La pagina Flutter userà questo endpoint per mostrare la classifica
// ufficiale del campionato selezionato in una schermata separata.
// Highlightly richiede leagueId + season per /standings: il leagueId
// viene risolto automaticamente tramite /leagues.
//
app.get(
  '/api/football/standings',
  async (req, res) => {
    try {
      const {
        season =
          CURRENT_SERIE_A_SEASON,
        leagueName =
          'Serie A',
        countryName =
          'Italy',
        refresh =
          '0',
      } = req.query;

      const supportedLeague =
        resolveSupportedLeague({
          leagueName,
          countryName,
        });

      if (!supportedLeague) {
        return res
          .status(400)
          .json({
            error:
              `Campionato non supportato: ${leagueName} / ${countryName}`,
          });
      }

      const normalizedSeason =
        String(season);

      const forceRefresh =
        String(refresh) === '1';

      const cacheKey = [
        'official-standings-v1',
        normalizedSeason,
        supportedLeague.key,
      ].join('-');

      if (!forceRefresh) {
        const memory =
          getMemoryCache(
            cacheKey,
            OFFICIAL_STANDINGS_CACHE_TIME,
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
            OFFICIAL_STANDINGS_CACHE_TIME,
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

      const leaguesPayload =
        await cachedHighlightlyGet({
          key: [
            'official-standings-league-id-v1',
            normalizedSeason,
            supportedLeague.key,
          ].join('-'),
          apiPath:
            '/leagues',
          query: {
            leagueName:
              supportedLeague
                .leagueName,
            countryName:
              supportedLeague
                .countryName,
            season:
              normalizedSeason,
            limit:
              '20',
            offset:
              '0',
          },
          ttl:
            LEAGUE_CACHE_TIME,
        });

      const leagueCandidates =
        Array.isArray(
          leaguesPayload?.data,
        )
          ? leaguesPayload.data
          : Array.isArray(
                leaguesPayload,
              )
              ? leaguesPayload
              : [];

      const exactLeague =
        leagueCandidates.find(
          (league) => {
            const exactName =
              normalizeLeagueText(
                league?.name,
              ) ===
              normalizeLeagueText(
                supportedLeague
                  .leagueName,
              );

            const exactCountry =
              normalizeLeagueText(
                league?.country
                  ?.name,
              ) ===
              normalizeLeagueText(
                supportedLeague
                  .countryName,
              );

            const seasons =
              Array.isArray(
                league?.seasons,
              )
                ? league.seasons
                : [];

            const exactSeason =
              seasons.length === 0 ||
              seasons.some(
                (item) =>
                  String(
                    item?.season,
                  ) ===
                  normalizedSeason,
              );

            return (
              exactName &&
              exactCountry &&
              exactSeason
            );
          },
        ) ??
        leagueCandidates.find(
          (league) =>
            normalizeLeagueText(
              league?.name,
            ) ===
            normalizeLeagueText(
              supportedLeague
                .leagueName,
            ),
        ) ??
        null;

      const leagueId =
        Number(
          exactLeague?.id,
        );

      if (
        !Number.isFinite(
          leagueId,
        )
      ) {
        return res
          .status(404)
          .json({
            error:
              'Classifica ufficiale non disponibile',
            message:
              `League ID non trovato per ${supportedLeague.leagueName} ${normalizedSeason}`,
          });
      }

      const standingsPayload =
        await highlightlyGet(
          '/standings',
          {
            leagueId:
              String(leagueId),
            season:
              normalizedSeason,
          },
        );

      const groups =
        Array.isArray(
          standingsPayload?.groups,
        )
          ? standingsPayload.groups
          : [];

      const regularSeasonGroup =
        groups.find(
          (group) =>
            normalizeLeagueText(
              group?.name,
            ).includes(
              'regular season',
            ),
        ) ??
        groups.find(
          (group) =>
            Array.isArray(
              group?.standings,
            ) &&
            group.standings
                .length >
              0,
        ) ??
        null;

      const rawStandings =
        Array.isArray(
          regularSeasonGroup
            ?.standings,
        )
          ? regularSeasonGroup
              .standings
          : [];

      const standings =
        rawStandings
          .map(
            (row) => {
              const played =
                Number(
                  row?.total?.games,
                ) || 0;

              const wins =
                Number(
                  row?.total?.wins,
                ) || 0;

              const draws =
                Number(
                  row?.total?.draws,
                ) || 0;

              const losses =
                Number(
                  row?.total?.loses,
                ) || 0;

              const goalsFor =
                Number(
                  row?.total
                    ?.scoredGoals,
                ) || 0;

              const goalsAgainst =
                Number(
                  row?.total
                    ?.receivedGoals,
                ) || 0;

              return {
                position:
                  Number(
                    row?.position,
                  ) || 0,

                team: {
                  id:
                    row?.team?.id ??
                    null,

                  name:
                    row?.team?.name ??
                    '',

                  logo:
                    row?.team?.logo ??
                    null,
                },

                played,
                wins,
                draws,
                losses,
                goalsFor,
                goalsAgainst,

                goalDifference:
                  goalsFor -
                  goalsAgainst,

                points:
                  Number(
                    row?.points,
                  ) || 0,
              };
            },
          )
          .filter(
            (row) =>
              row.position >
                0 &&
              row.team.name
                .trim()
                .length >
                0,
          )
          .sort(
            (a, b) =>
              a.position -
              b.position,
          );

      if (
        standings.length ===
        0
      ) {
        return res
          .status(404)
          .json({
            error:
              'Classifica ufficiale non disponibile',
            message:
              `Nessuna classifica restituita da Highlightly per ${supportedLeague.leagueName} ${normalizedSeason}`,
          });
      }

      const payload = {
        season:
          normalizedSeason,

        leagueName:
          supportedLeague
            .leagueName,

        countryName:
          supportedLeague
            .countryName,

        leagueId,

        leagueLogo:
          standingsPayload
            ?.league?.logo ??
          exactLeague?.logo ??
          null,

        groupName:
          regularSeasonGroup
            ?.name ??
          null,

        generatedAt:
          new Date()
            .toISOString(),

        source:
          'highlightly-official-standings',

        standings,
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
        cached:
          false,
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
// RISULTATI GIORNATE PRECEDENTI - 5 CAMPIONATI
// ====================================================
//
// Recupera esclusivamente risultati REALI conclusi dal provider.
// Non crea, ricostruisce o modifica pronostici PREDICT retroattivi.
// Serie A giornata 1/2 e snapshot storici restano quindi intoccati.
//
app.get(
  '/api/football/season-results',
  async (req, res) => {
    try {
      const {
        season =
          CURRENT_SERIE_A_SEASON,
        leagueName =
          'Serie A',
        countryName =
          'Italy',
      } = req.query;

      const supportedLeague =
        resolveSupportedLeague({
          leagueName,
          countryName,
        });

      if (!supportedLeague) {
        return res
          .status(400)
          .json({
            error:
              `Campionato non supportato: ${leagueName} / ${countryName}`,
          });
      }

      const regularSeasonRounds =
        Number(
          supportedLeague
            .regularSeasonRounds,
        ) || 38;

      const seasonMatches =
        await loadSupportedLeagueSeasonMatches({
          season,
          leagueName:
            supportedLeague
              .leagueName,
          countryName:
            supportedLeague
              .countryName,
        });

      const roundsMap =
        new Map();

      for (
        const match
          of seasonMatches
      ) {
        const round =
          roundNumberOf(
            match,
          );

        if (
          !round ||
          round < 1 ||
          round >
            regularSeasonRounds
        ) {
          continue;
        }

        if (!roundsMap.has(round)) {
          roundsMap.set(
            round,
            {
              round,
              scheduledMatches: 0,
              finishedMatches: 0,
              completed: false,
              matches: [],
            },
          );
        }

        const roundData =
          roundsMap.get(round);

        roundData.scheduledMatches +=
          1;

        const score =
          parseScore(
            match,
          );

        const finished =
          isFinishedMatch(
            match,
          ) &&
          Boolean(score);

        if (!finished) {
          continue;
        }

        roundData.finishedMatches +=
          1;

        const home =
          match?.homeTeam ?? {};

        const away =
          match?.awayTeam ?? {};

        roundData.matches.push({
          matchId:
            match?.id ?? null,

          date:
            match?.date ?? null,

          round,

          status:
            match?.state
              ?.description ??
            'Finished',

          homeTeam: {
            id:
              teamIdOf(home),

            name:
              home?.name ?? '',

            logo:
              home?.logo ?? null,
          },

          awayTeam: {
            id:
              teamIdOf(away),

            name:
              away?.name ?? '',

            logo:
              away?.logo ?? null,
          },

          score: {
            home:
              score.home,

            away:
              score.away,

            display:
              `${score.home}-${score.away}`,
          },
        });
      }

      const rounds =
        Array.from(
          roundsMap.values(),
        )
          .map(
            (roundData) => ({
              ...roundData,

              completed:
                roundData
                  .scheduledMatches >
                  0 &&
                roundData
                  .finishedMatches ===
                  roundData
                    .scheduledMatches,

              matches:
                roundData
                  .matches
                  .sort(
                    (a, b) =>
                      Date.parse(
                        a?.date ?? '',
                      ) -
                      Date.parse(
                        b?.date ?? '',
                      ),
                  ),
            }),
          )
          // Mostriamo solo giornate in cui esiste almeno un risultato reale.
          .filter(
            (roundData) =>
              roundData
                .finishedMatches >
              0,
          )
          .sort(
            (a, b) =>
              a.round -
              b.round,
          );

      const completedRounds =
        rounds.filter(
          (roundData) =>
            roundData.completed,
        );

      const finishedMatches =
        rounds.reduce(
          (
            total,
            roundData,
          ) =>
            total +
            roundData
              .finishedMatches,
          0,
        );

      res.json({
        season:
          String(season),

        leagueName:
          supportedLeague
            .leagueName,

        countryName:
          supportedLeague
            .countryName,

        regularSeasonRounds,

        roundsWithResults:
          rounds.length,

        completedRounds:
          completedRounds.length,

        finishedMatches,

        generatedAt:
          new Date()
            .toISOString(),

        source:
          'highlightly-real-results',

        note:
          'Solo risultati reali conclusi. Nessun pronostico PREDICT viene ricostruito retroattivamente.',

        rounds,
      });
    } catch (error) {
      sendApiError(
        res,
        error,
      );
    }
  },
);


app.get(
  '/api/football/multiples-summary',
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

      const summaryKey =
        buildSeasonMultiplesSummaryArchiveKey({
          season,
          historicalSeason,
          leagueName,
          countryName,
        });

      const forceRefresh =
        String(refresh) === '1';

      const archivedSummary =
        await getPermanentCache(
          summaryKey,
        );

      if (
        !forceRefresh &&
        archivedSummary
      ) {
        return res.json({
          ...archivedSummary,
          cached:
            true,
          cacheSource:
            'history-archive',
        });
      }

      const supportedLeague =
        resolveSupportedLeague({
          leagueName,
          countryName,
        });

      if (!supportedLeague) {
        return res
          .status(400)
          .json({
            error:
              `Campionato non supportato: ${leagueName} / ${countryName}`,
          });
      }

      if (forceRefresh) {
        await settlePermanentMultipleHistory({
          season,
          historicalSeason,
          leagueName:
            supportedLeague
              .leagueName,
          countryName:
            supportedLeague
              .countryName,
          allowProvider:
            true,
        });
      }

      const payload =
        await buildAndPersistMultiplesSummary({
          season,
          historicalSeason,
          leagueName:
            supportedLeague
              .leagueName,
          countryName:
            supportedLeague
              .countryName,
        });

      res.json({
        ...payload,
        cached:
          false,
        cacheSource:
          'multiple-history',
      });
    } catch (error) {
      sendApiError(
        res,
        error,
      );
    }
  },
);

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
        'season-picks-summary-v2-multileague',
        season,
        historicalSeason,
        leagueName,
        countryName,
      ].join('-');

      const forceRefresh =
        String(refresh) === '1';

      const historyArchiveKey =
        buildSeasonSummaryArchiveKey({
          season,
          historicalSeason,
          leagueName,
          countryName,
        });

      const archivedSummary =
        await getPermanentCache(
          historyArchiveKey,
        );

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

      const supportedLeague =
        resolveSupportedLeague({
          leagueName,
          countryName,
        });

      if (!supportedLeague) {
        return res
          .status(400)
          .json({
            error:
              `Campionato non supportato: ${leagueName} / ${countryName}`,
          });
      }

      const regularSeasonRounds =
        Number(
          supportedLeague
            .regularSeasonRounds,
        ) || 38;

      // Usa la stessa sorgente calendario già adottata da matchday-picks:
      // Serie A continua a leggere lo scheduler centrale esistente,
      // mentre Premier League, Bundesliga, Ligue 1 e La Liga leggono
      // la stagione corrente Highlightly filtrata sulla Regular Season.
      const seasonMatches =
        await loadSupportedLeagueSeasonMatches({
          season,
          leagueName:
            supportedLeague.leagueName,
          countryName:
            supportedLeague.countryName,
        });

      if (
        seasonMatches.length === 0 &&
        archivedSummary
      ) {
        return res.json({
          ...archivedSummary,
          cached: true,
          cacheSource:
            'history-archive',
        });
      }

      const rounds =
        Array.from(
          {
            length:
              regularSeasonRounds,
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
              round >
                regularSeasonRounds
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
                leagueName:
                  supportedLeague
                    .leagueName,
                countryName:
                  supportedLeague
                    .countryName,
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
              await getOrPersistMatchdayPickResult({
                match,
                snapshot,
                historicalSeason,
                leagueName:
                  supportedLeague
                    .leagueName,
                countryName:
                  supportedLeague
                    .countryName,
                allowProvider:
                  forceRefresh,
              });

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

      const currentPayload = {
        season:
          String(season),

        historicalSeason:
          String(
            historicalSeason,
          ),

        leagueName:
          supportedLeague
            .leagueName,
        countryName:
          supportedLeague
            .countryName,

        regularSeasonRounds,

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

      const payload =
        mergeSeasonSummaryWithArchive(
          currentPayload,
          archivedSummary,
        );

      setMemoryCache(
        cacheKey,
        payload,
      );

      await setDiskCache(
        cacheKey,
        payload,
      );

      await setPermanentCache(
        historyArchiveKey,
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

    bootstrapSeedCache()
      .then(
        () =>
          startCentralSerieAScheduler(),
      )
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
      '- /api/football/season-results?season=2026&leagueName=Premier%20League&countryName=England',
      '- /api/football/multiples-summary?season=2026&historicalSeason=2025',
    );

    console.log(
      '- /api/football/sync-status',
    );

    console.log(
      '- /api/football/statistics/:matchId',
    );
  },
);