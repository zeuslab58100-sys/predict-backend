const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const {
  initializeApp: initializeFirebaseAdminApp,
  cert: firebaseAdminCert,
  getApps: getFirebaseAdminApps,
} = require('firebase-admin/app');
const {
  getMessaging: getFirebaseMessaging,
} = require('firebase-admin/messaging');

dotenv.config();

const app = express();

// Contesto per-request: una richiesta HTTP pubblica non può mai trasformarsi
// in una chiamata Highlightly. I job centrali (fuori da una richiesta HTTP)
// e le sole richieste interne autenticate restano autorizzati.
const highlightlyRequestContext = new AsyncLocalStorage();

const PORT = process.env.PORT || 3000;
const HIGHLIGHTLY_BASE_URL = 'https://soccer.highlightly.net';

// Piano Highlightly Pro: 7.500 richieste/giorno.
// PREDICT usa un limite interno più prudente di 7.000 per lasciare
// 500 richieste di margine di sicurezza ed evitare di esaurire il piano.
const HIGHLIGHTLY_PLAN_DAILY_LIMIT = 7500;
const HIGHLIGHTLY_INTERNAL_DAILY_LIMIT = 7000;
const HIGHLIGHTLY_BUDGET_TIMEZONE = 'Europe/Rome';
const HIGHLIGHTLY_BUDGET_CACHE_KEY = 'highlightly-daily-budget-v1';
const HIGHLIGHTLY_BUDGET_CACHE_TIME = 7 * 24 * 60 * 60 * 1000;

app.use(cors());
app.use(express.json());

// ====================================================
// FIREBASE ADMIN — PUSH NOTIFICATION LOCALI
// ====================================================

const FIREBASE_SERVICE_ACCOUNT_PATH =
  path.join(
    __dirname,
    'firebase-service-account.json',
  );

let predictFirebaseMessaging = null;
let predictFirebaseProjectId = null;
let predictFirebaseAdminError = null;

function initializePredictFirebaseAdmin() {
  try {
    // La chiave resta esclusivamente nel backend locale.
    // Non viene mai restituita dalle API e non viene stampata nei log.
    const serviceAccount =
      require(
        FIREBASE_SERVICE_ACCOUNT_PATH,
      );

    const existingApps =
      getFirebaseAdminApps();

    const firebaseApp =
      existingApps.length > 0
        ? existingApps[0]
        : initializeFirebaseAdminApp({
            credential:
              firebaseAdminCert(
                serviceAccount,
              ),
          });

    predictFirebaseMessaging =
      getFirebaseMessaging(
        firebaseApp,
      );

    predictFirebaseProjectId =
      serviceAccount?.project_id ??
      null;

    predictFirebaseAdminError =
      null;

    console.log(
      `PREDICT FIREBASE ADMIN: attivo${predictFirebaseProjectId ? ` (${predictFirebaseProjectId})` : ''}`,
    );
  } catch (error) {
    predictFirebaseMessaging =
      null;

    predictFirebaseProjectId =
      null;

    predictFirebaseAdminError =
      error?.message ??
      String(error);

    console.warn(
      'PREDICT FIREBASE ADMIN: non disponibile:',
      predictFirebaseAdminError,
    );
  }
}

initializePredictFirebaseAdmin();

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

// Registrazioni locali dispositivo -> Squadra del cuore.
// Il token FCM resta nel backend e non viene mai esposto dagli endpoint di stato.
const FAVORITE_TEAM_SUBSCRIPTIONS_FILE =
  path.join(
    CACHE_ROOT,
    'favorite-team-notification-subscriptions-v1.json',
  );

const FAVORITE_TEAM_NOTIFICATION_STATE_FILE =
  path.join(
    CACHE_ROOT,
    'favorite-team-notification-state-v1.json',
  );

const FAVORITE_TEAM_NOTIFICATION_POLL_INTERVAL =
  60 * 1000;

const FAVORITE_TEAM_LINEUPS_WINDOW =
  75 * 60 * 1000;

const FAVORITE_TEAM_POSTSTART_WINDOW =
  3 * 60 * 60 * 1000;

const favoriteTeamNotificationSubscriptions =
  new Map();

const favoriteTeamNotificationSentState =
  new Map();

let favoriteTeamNotificationSubscriptionsLoaded = false;
let favoriteTeamNotificationStateLoaded = false;

const favoriteTeamNotificationSchedulerState = {
  startedAt: null,
  lastTickAt: null,
  lastError: null,
  running: false,
};

async function loadFavoriteTeamNotificationSubscriptions() {
  if (favoriteTeamNotificationSubscriptionsLoaded) {
    return;
  }

  favoriteTeamNotificationSubscriptionsLoaded = true;

  try {
    const raw = await fs.readFile(
      FAVORITE_TEAM_SUBSCRIPTIONS_FILE,
      'utf8',
    );

    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.subscriptions)
      ? parsed.subscriptions
      : [];

    for (const item of items) {
      const token = String(item?.token ?? '').trim();

      if (!token) {
        continue;
      }

      favoriteTeamNotificationSubscriptions.set(
        token,
        item,
      );
    }

    console.log(
      `PREDICT FAVORITE TEAM PUSH: ${favoriteTeamNotificationSubscriptions.size} dispositivo/i ripristinato/i`,
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(
        'PREDICT FAVORITE TEAM PUSH: ripristino non riuscito:',
        error?.message ?? error,
      );
    }
  }
}

async function saveFavoriteTeamNotificationSubscriptions() {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    subscriptions: Array.from(
      favoriteTeamNotificationSubscriptions.values(),
    ),
  };

  await fs.writeFile(
    FAVORITE_TEAM_SUBSCRIPTIONS_FILE,
    JSON.stringify(payload, null, 2),
    'utf8',
  );
}

async function loadFavoriteTeamNotificationState() {
  if (favoriteTeamNotificationStateLoaded) {
    return;
  }

  favoriteTeamNotificationStateLoaded = true;

  try {
    const raw = await fs.readFile(
      FAVORITE_TEAM_NOTIFICATION_STATE_FILE,
      'utf8',
    );

    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.items)
      ? parsed.items
      : [];

    for (const item of items) {
      const key = String(item?.key ?? '').trim();

      if (!key) {
        continue;
      }

      favoriteTeamNotificationSentState.set(
        key,
        String(
          item?.at ??
          new Date().toISOString(),
        ),
      );
    }

    console.log(
      `PREDICT FAVORITE TEAM PUSH: ${favoriteTeamNotificationSentState.size} stato/i notifica ripristinato/i`,
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(
        'PREDICT FAVORITE TEAM PUSH: stato notifiche non ripristinato:',
        error?.message ?? error,
      );
    }
  }
}

async function saveFavoriteTeamNotificationState() {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: Array.from(
      favoriteTeamNotificationSentState.entries(),
    ).map(
      ([key, at]) => ({
        key,
        at,
      }),
    ),
  };

  await fs.writeFile(
    FAVORITE_TEAM_NOTIFICATION_STATE_FILE,
    JSON.stringify(payload, null, 2),
    'utf8',
  );
}

function favoriteTeamTokenFingerprint(token) {
  return crypto
    .createHash('sha256')
    .update(String(token ?? ''))
    .digest('hex')
    .slice(0, 12);
}

const LEAGUE_CACHE_TIME = 24 * 60 * 60 * 1000;
const RECENT_CACHE_TIME = 6 * 60 * 60 * 1000;
const SUPPORTED_LEAGUE_PUBLIC_MATCHES_CACHE_TIME = 2 * 60 * 1000;
const MATCHDAY_PICKS_CACHE_TIME = 60 * 1000;
const SEASON_PICKS_SUMMARY_CACHE_TIME = 60 * 1000;
const OFFICIAL_STANDINGS_CACHE_TIME = 30 * 60 * 1000;
const LINEUPS_CACHE_TIME = 15 * 60 * 1000;
const LIVE_EVENTS_CACHE_TIME = 55 * 1000;
const LIVE_MATCHES_CACHE_TIME = 55 * 1000;
const MATCHDAY_PICK_SNAPSHOT_CACHE_TIME = 400 * 24 * 60 * 60 * 1000;
const HISTORICAL_STATS_CACHE_TIME = 30 * 24 * 60 * 60 * 1000;
const LEAGUE_ADVANCED_CACHE_TIME = 30 * 24 * 60 * 60 * 1000;
const ADVANCED_SAMPLE_PER_VENUE = 19;
const ADVANCED_FETCH_CONCURRENCY = 4;
const ADVANCED_RECENCY_DECAY = 0.92;
const ADVANCED_OPPOSITE_VENUE_WEIGHT = 0.70;

// Storico avanzato PREDICT:
// il 2019 resta escluso perché incompleto.
// Le stagioni 2020-2025 vengono preparate singolarmente e poi
// consolidate senza nuove chiamate Highlightly.
const PREDICT_ADVANCED_HISTORY_SEASONS = [
  '2020',
  '2021',
  '2022',
  '2023',
  '2024',
  '2025',
];
const PREDICT_ADVANCED_HISTORY_LATEST_SEASON = 2025;
const PREDICT_ADVANCED_HISTORY_SEASON_DECAY = 0.80;

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

// Sicurezza quota Highlightly:
// i job automatici NON partono per default.
// Per abilitarli esplicitamente (es. su Render) impostare:
// PREDICT_BACKGROUND_JOBS=on
const PREDICT_BACKGROUND_JOBS_ENABLED =
  [
    '1',
    'true',
    'yes',
    'on',
  ].includes(
    String(
      process.env.PREDICT_BACKGROUND_JOBS ??
      '',
    )
      .trim()
      .toLowerCase(),
  );

const MATCHDAY_PICK_SNAPSHOT_CURRENT_VERSION = 'v3';
const MATCHDAY_PICK_SNAPSHOT_LEGACY_VERSIONS = ['v2'];
const MATCH_ANALYSIS_SNAPSHOT_CURRENT_VERSION = 'v2';
const MATCH_ANALYSIS_SNAPSHOT_LEGACY_VERSIONS = ['v1'];

const BOOKMAKER_ONLY_FROM_ROUND = 3;
const BOOKMAKER_ONLY_PREDICT_WEIGHT = 0.95;
const BOOKMAKER_ONLY_BOOKMAKER_WEIGHT = 0.05;
const MATCHDAY_PICK_BOOKMAKER_ONLY_VERSION = 'v10-strength-p95-b5';

// Blend dedicato esclusivamente alle coppe UEFA.
// Campionati nazionali: 95% PREDICT / 5% bookmaker.
// Champions / Europa / Conference: 5% PREDICT / 95% bookmaker.
const UEFA_CUP_PREDICT_WEIGHT = 0.05;
const UEFA_CUP_BOOKMAKER_WEIGHT = 0.95;
const UEFA_CUP_MATCHDAY_PICK_VERSION = 'v12-uefa-p5-b95-no-odds-no-signal';
const UEFA_CUP_MATCHDAY_PICK_LEGACY_VERSION = 'v11-uefa-p5-b95';

// Storico visuale dedicato alle 3 coppe UEFA.
// Parte definitivamente dall'08/09/2026 e non usa i campionati nazionali.
const UEFA_VENUE_HISTORY_START_DATE = '2026-09-08';

function bookmakerOnlyModeForRound(round) {
  const numericRound =
    Number(round);

  return (
    Number.isFinite(numericRound) &&
    numericRound >=
      BOOKMAKER_ONLY_FROM_ROUND
  );
}

// Champions/Europa/Conference usano un blend dedicato più orientato
// al mercato bookmaker, perché le statistiche PREDICT arrivano soprattutto
// dai campionati nazionali e quindi sono meno direttamente confrontabili
// tra squadre provenienti da leghe differenti.
const UEFA_CUPS_FORCE_BOOKMAKER_ONLY = true;

function bookmakerOnlyModeForCompetition({
  round,
  supportedLeague,
}) {
  if (
    UEFA_CUPS_FORCE_BOOKMAKER_ONLY &&
    supportedLeague?.isCup === true
  ) {
    return true;
  }

  return bookmakerOnlyModeForRound(
    round,
  );
}

function matchdayPickSnapshotVersionForMatch(
  match,
  supportedLeague = null,
) {
  if (
    supportedLeague?.isCup === true
  ) {
    return UEFA_CUP_MATCHDAY_PICK_VERSION;
  }

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
    ? 'matchday-picks-v10-strength-p95-b5'
    : 'matchday-picks-v2';
}

const INTERNAL_SYNC_TOKEN =
  process.env.PREDICT_INTERNAL_TOKEN ||
  crypto
    .randomBytes(32)
    .toString('hex');

// Barriera globale anti-consumo da client:
// qualunque route HTTP è cache-only salvo header interno segreto.
// In questo modo anche un endpoint dimenticato o un futuro cache miss
// non può consumare la quota Highlightly per iniziativa di un utente.
app.use((req, res, next) => {
  const internalRequest =
    req.get('x-predict-internal') ===
    INTERNAL_SYNC_TOKEN;

  highlightlyRequestContext.run(
    {
      isHttpRequest: true,
      providerCallsAllowed:
        internalRequest,
    },
    next,
  );
});


// Stagione corrente mostrata nell'app.
// Il 2025/26 resta il prior storico iniziale; i risultati 2026/27
// entrano progressivamente nel modello dopo ogni partita conclusa.
const CURRENT_SERIE_A_SEASON = '2026';


// ====================================================
// COMPETIZIONI SUPPORTATE
// ====================================================
// I cinque campionati nazionali mantengono il comportamento esistente.
// Le tre coppe UEFA vengono gestite come competizioni separate:
// calendario/partite, analisi PREDICT e pronostici della League Stage sono disponibili.
// Classifiche e funzioni multiple/storici basate sui campionati restano separate.
const SUPPORTED_LEAGUES = Object.freeze({
  serieA: Object.freeze({
    key: 'serie-a',
    leagueName: 'Serie A',
    countryName: 'Italy',
    providerLeagueNames:
      Object.freeze([
        'Serie A',
      ]),
    providerCountryName:
      'Italy',
    currentSeason: '2026',
    historicalSeason: '2025',
    regularSeasonRounds: 38,
    languageCode: 'it',
    isCup: false,
    supportsMatchdayPicks: true,
    supportsStandings: true,
  }),

  premierLeague: Object.freeze({
    key: 'premier-league',
    leagueName: 'Premier League',
    countryName: 'England',
    providerLeagueNames:
      Object.freeze([
        'Premier League',
      ]),
    providerCountryName:
      'England',
    currentSeason: '2026',
    historicalSeason: '2025',
    regularSeasonRounds: 38,
    languageCode: 'en',
    isCup: false,
    supportsMatchdayPicks: true,
    supportsStandings: true,
  }),

  bundesliga: Object.freeze({
    key: 'bundesliga',
    leagueName: 'Bundesliga',
    countryName: 'Germany',
    providerLeagueNames:
      Object.freeze([
        'Bundesliga',
      ]),
    providerCountryName:
      'Germany',
    currentSeason: '2026',
    historicalSeason: '2025',
    regularSeasonRounds: 34,
    languageCode: 'de',
    isCup: false,
    supportsMatchdayPicks: true,
    supportsStandings: true,
  }),

  ligue1: Object.freeze({
    key: 'ligue-1',
    leagueName: 'Ligue 1',
    countryName: 'France',
    providerLeagueNames:
      Object.freeze([
        'Ligue 1',
      ]),
    providerCountryName:
      'France',
    currentSeason: '2026',
    historicalSeason: '2025',
    regularSeasonRounds: 34,
    languageCode: 'fr',
    isCup: false,
    supportsMatchdayPicks: true,
    supportsStandings: true,
  }),

  laLiga: Object.freeze({
    key: 'la-liga',
    leagueName: 'La Liga',
    countryName: 'Spain',
    providerLeagueNames:
      Object.freeze([
        'La Liga',
      ]),
    providerCountryName:
      'Spain',
    currentSeason: '2026',
    historicalSeason: '2025',
    regularSeasonRounds: 38,
    languageCode: 'es',
    isCup: false,
    supportsMatchdayPicks: true,
    supportsStandings: true,
  }),

  championsLeague: Object.freeze({
    key: 'champions-league',
    leagueName: 'Champions League',
    countryName: 'UEFA',
    providerLeagueNames:
      Object.freeze([
        'UEFA Champions League',
      ]),
    providerCountryName:
      'World',
    currentSeason: '2026',
    historicalSeason: '2025',
    regularSeasonRounds: null,
    languageCode: 'en',
    isCup: true,
    supportsMatchdayPicks: false,
    supportsStandings: false,
  }),

  europaLeague: Object.freeze({
    key: 'europa-league',
    leagueName: 'Europa League',
    countryName: 'UEFA',
    providerLeagueNames:
      Object.freeze([
        'UEFA Europa League',
      ]),
    providerCountryName:
      'World',
    currentSeason: '2026',
    historicalSeason: '2025',
    regularSeasonRounds: null,
    languageCode: 'en',
    isCup: true,
    supportsMatchdayPicks: false,
    supportsStandings: false,
  }),

  conferenceLeague: Object.freeze({
    key: 'conference-league',
    leagueName: 'Conference League',
    countryName: 'UEFA',
    providerLeagueNames:
      Object.freeze([
        'UEFA Europa Conference League',
      ]),
    providerCountryName:
      'World',
    currentSeason: '2026',
    historicalSeason: '2025',
    regularSeasonRounds: null,
    languageCode: 'en',
    isCup: true,
    supportsMatchdayPicks: false,
    supportsStandings: false,
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

function providerLeagueNamesOf(
  league,
) {
  const values = [
    ...(Array.isArray(
      league?.providerLeagueNames,
    )
      ? league.providerLeagueNames
      : []),

    league?.leagueName,
  ]
    .filter(
      (value) =>
        String(
          value ?? '',
        ).trim().length > 0,
    )
    .map(
      (value) =>
        String(value).trim(),
    );

  return [
    ...new Set(values),
  ];
}

function providerCountryNameOf(
  league,
) {
  if (
    Object.prototype.hasOwnProperty.call(
      league ?? {},
      'providerCountryName',
    )
  ) {
    return (
      league.providerCountryName ??
      null
    );
  }

  return (
    league?.countryName ??
    null
  );
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
      (league) => {
        const names =
          providerLeagueNamesOf(
            league,
          )
            .map(
              normalizeLeagueText,
            );

        const leagueMatches =
          names.includes(
            wantedLeague,
          );

        const canonicalCountry =
          normalizeLeagueText(
            league.countryName,
          );

        const countryMatches =
          canonicalCountry ===
            wantedCountry ||
          (
            league.isCup === true &&
            (
              wantedCountry ===
                '' ||
              wantedCountry ===
                'uefa' ||
              wantedCountry ===
                'europe' ||
              wantedCountry ===
                'world'
            )
          );

        return (
          leagueMatches &&
          countryMatches
        );
      },
    ) ??
    null
  );
}

function supportsRoundBasedFeatures(
  league,
) {
  return (
    Boolean(league) &&
    league.isCup !== true &&
    Number.isFinite(
      Number(
        league.regularSeasonRounds,
      ),
    )
  );
}

async function fetchSupportedCompetitionMatchesPage({
  competition,
  season,
  date = null,
  limit = '100',
  offset = '0',
  timezone = 'Europe/Rome',
  cacheKeyPrefix = null,
  ttl = RECENT_CACHE_TIME,
  preferredProviderLeagueName =
    null,
}) {
  if (!competition) {
    const error = new Error(
      'Competizione PREDICT non valida',
    );

    error.statusCode = 400;
    throw error;
  }

  // Per le coppe UEFA usiamo esclusivamente il nome provider configurato.
  // Il nome canonico PREDICT resta valido per il routing del frontend, ma non
  // viene usato come secondo tentativo verso Highlightly: evita chiamate doppie
  // come "UEFA Europa League" + "Europa League" sullo stesso cache miss.
  const candidates =
    competition?.isCup === true &&
    Array.isArray(
      competition?.providerLeagueNames,
    ) &&
    competition.providerLeagueNames.length > 0
      ? competition.providerLeagueNames
          .map(
            (value) =>
              String(value ?? '').trim(),
          )
          .filter(Boolean)
      : providerLeagueNamesOf(
          competition,
        );

  const orderedCandidates = [
    ...(
      preferredProviderLeagueName
        ? [
            preferredProviderLeagueName,
          ]
        : []
    ),
    ...candidates,
  ]
    .filter(
      (value, index, items) =>
        items.indexOf(value) ===
        index,
    );

  const providerCountryName =
    providerCountryNameOf(
      competition,
    );

  let lastPayload =
    null;

  let lastError =
    null;

  for (
    const providerLeagueName
      of orderedCandidates
  ) {
    const query = {
      ...(date
        ? {
            date:
              String(date),
          }
        : {}),

      leagueName:
        providerLeagueName,

      ...(providerCountryName
        ? {
            countryName:
              providerCountryName,
          }
        : {}),

      season:
        String(season),

      timezone,

      limit:
        String(limit),

      offset:
        String(offset),
    };

    try {
      const payload =
        cacheKeyPrefix
          ? await cachedHighlightlyGet({
              key: [
                cacheKeyPrefix,
                competition.key,
                String(season),
                date
                  ? String(date)
                  : 'season',
                sanitizeCachePart(
                  providerLeagueName,
                ),
                sanitizeCachePart(
                  providerCountryName ?? 'no-country',
                ),
                String(offset),
              ].join('-'),

              apiPath:
                '/matches',

              query,

              ttl,
            })
          : await highlightlyGet(
              '/matches',
              query,
            );

      const matches =
        extractMatches(
          payload,
        );

      lastPayload =
        payload;

      if (
        matches.length > 0
      ) {
        return {
          payload,
          matches,
          providerLeagueName,
        };
      }
    } catch (error) {
      lastError =
        error;
    }
  }

  if (lastPayload) {
    return {
      payload:
        lastPayload,
      matches: [],
      providerLeagueName:
        preferredProviderLeagueName ??
        orderedCandidates[0] ??
        competition.leagueName,
    };
  }

  if (lastError) {
    throw lastError;
  }

  return {
    payload: {
      data: [],
    },
    matches: [],
    providerLeagueName:
      preferredProviderLeagueName ??
      orderedCandidates[0] ??
      competition.leagueName,
  };
}


// Endpoint pubblico usato dal frontend per conoscere tutte le competizioni
// supportate da PREDICT. Il nome "supported-leagues" resta invariato per
// compatibilità con il frontend esistente.
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
            isCup:
              league.isCup === true,
            supportsMatchdayPicks:
              league.supportsMatchdayPicks !==
                false,
            supportsStandings:
              league.supportsStandings !==
                false,
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
    'matchday-multiples-history-v2-strength',
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
    'season-multiples-history-v2-strength',
    season,
    historicalSeason,
    leagueName,
    countryName,
  ].join('-');
}

function buildLegacyMatchdayMultipleArchiveKey({
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

async function getCompatiblePermanentMultipleArchive({
  season,
  historicalSeason,
  round,
  leagueName,
  countryName,
}) {
  const currentKey =
    buildMatchdayMultipleArchiveKey({
      season,
      historicalSeason,
      round,
      leagueName,
      countryName,
    });

  const current =
    await getPermanentCache(
      currentKey,
    );

  if (current) {
    return current;
  }

  const legacyKey =
    buildLegacyMatchdayMultipleArchiveKey({
      season,
      historicalSeason,
      round,
      leagueName,
      countryName,
    });

  const legacy =
    await getPermanentCache(
      legacyKey,
    );

  if (!legacy) {
    return null;
  }

  return {
    ...legacy,
    legacyMultipleArchive:
      true,
  };
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

let highlightlyDailyBudgetLoaded = false;
let highlightlyDailyBudgetLoadPromise = null;
let highlightlyDailyBudgetWriteQueue = Promise.resolve();
let highlightlyDailyBudgetState = {
  day: null,
  used: 0,
  byPath: {},
  updatedAt: null,
};

function highlightlyRomeDayKey(
  date = new Date(),
) {
  const parts =
    new Intl.DateTimeFormat(
      'en-GB',
      {
        timeZone:
          HIGHLIGHTLY_BUDGET_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      },
    ).formatToParts(date);

  const value = {};

  for (const part of parts) {
    if (
      part.type === 'year' ||
      part.type === 'month' ||
      part.type === 'day'
    ) {
      value[part.type] =
        part.value;
    }
  }

  return [
    value.year,
    value.month,
    value.day,
  ].join('-');
}

function freshHighlightlyDailyBudgetState() {
  return {
    day:
      highlightlyRomeDayKey(),
    used: 0,
    byPath: {},
    updatedAt:
      new Date().toISOString(),
  };
}

function normalizeHighlightlyDailyBudgetState(
  value,
) {
  const today =
    highlightlyRomeDayKey();

  if (
    !value ||
    typeof value !== 'object' ||
    String(value.day ?? '') !== today
  ) {
    return freshHighlightlyDailyBudgetState();
  }

  const used = Math.max(
    0,
    Math.floor(
      Number(value.used) || 0,
    ),
  );

  const byPath = {};

  if (
    value.byPath &&
    typeof value.byPath === 'object'
  ) {
    for (const [key, count] of
      Object.entries(value.byPath)) {
      const normalizedCount =
        Math.max(
          0,
          Math.floor(
            Number(count) || 0,
          ),
        );

      if (normalizedCount > 0) {
        byPath[key] =
          normalizedCount;
      }
    }
  }

  return {
    day: today,
    used,
    byPath,
    updatedAt:
      value.updatedAt ??
      null,
  };
}

async function ensureHighlightlyDailyBudgetLoaded() {
  if (highlightlyDailyBudgetLoaded) {
    const today =
      highlightlyRomeDayKey();

    if (
      highlightlyDailyBudgetState.day !==
      today
    ) {
      highlightlyDailyBudgetState =
        freshHighlightlyDailyBudgetState();

      await persistHighlightlyDailyBudget();
    }

    return;
  }

  if (!highlightlyDailyBudgetLoadPromise) {
    highlightlyDailyBudgetLoadPromise =
      (async () => {
        const disk =
          await getDiskCache(
            HIGHLIGHTLY_BUDGET_CACHE_KEY,
            HIGHLIGHTLY_BUDGET_CACHE_TIME,
          );

        highlightlyDailyBudgetState =
          normalizeHighlightlyDailyBudgetState(
            disk,
          );

        highlightlyDailyBudgetLoaded =
          true;
      })();
  }

  await highlightlyDailyBudgetLoadPromise;

  const today =
    highlightlyRomeDayKey();

  if (
    highlightlyDailyBudgetState.day !==
    today
  ) {
    highlightlyDailyBudgetState =
      freshHighlightlyDailyBudgetState();

    await persistHighlightlyDailyBudget();
  }
}

function persistHighlightlyDailyBudget() {
  const snapshot =
    JSON.parse(
      JSON.stringify(
        highlightlyDailyBudgetState,
      ),
    );

  highlightlyDailyBudgetWriteQueue =
    highlightlyDailyBudgetWriteQueue
      .catch(() => {})
      .then(
        () =>
          setDiskCache(
            HIGHLIGHTLY_BUDGET_CACHE_KEY,
            snapshot,
          ),
      );

  return highlightlyDailyBudgetWriteQueue;
}

function getHighlightlyDailyBudgetSnapshot() {
  const used = Math.max(
    0,
    Number(
      highlightlyDailyBudgetState.used,
    ) || 0,
  );

  const internalRemaining =
    Math.max(
      0,
      HIGHLIGHTLY_INTERNAL_DAILY_LIMIT -
        used,
    );

  const planRemaining =
    Math.max(
      0,
      HIGHLIGHTLY_PLAN_DAILY_LIMIT -
        used,
    );

  return {
    day:
      highlightlyDailyBudgetState.day ??
      highlightlyRomeDayKey(),
    timezone:
      HIGHLIGHTLY_BUDGET_TIMEZONE,
    planLimit:
      HIGHLIGHTLY_PLAN_DAILY_LIMIT,
    internalSafetyLimit:
      HIGHLIGHTLY_INTERNAL_DAILY_LIMIT,
    used,
    internalRemaining,
    planRemaining,
    safetyReserve:
      HIGHLIGHTLY_PLAN_DAILY_LIMIT -
      HIGHLIGHTLY_INTERNAL_DAILY_LIMIT,
    blocked:
      used >=
      HIGHLIGHTLY_INTERNAL_DAILY_LIMIT,
    usagePercentOfInternalLimit:
      round2(
        (used /
          HIGHLIGHTLY_INTERNAL_DAILY_LIMIT) *
          100,
      ),
    byPath: {
      ...highlightlyDailyBudgetState.byPath,
    },
    updatedAt:
      highlightlyDailyBudgetState.updatedAt,
    loaded:
      highlightlyDailyBudgetLoaded,
  };
}

async function reserveHighlightlyDailyCall(
  apiPath,
) {
  await ensureHighlightlyDailyBudgetLoaded();

  if (
    highlightlyDailyBudgetState.used >=
    HIGHLIGHTLY_INTERNAL_DAILY_LIMIT
  ) {
    const error = new Error(
      `Budget Highlightly giornaliero PREDICT esaurito: ${HIGHLIGHTLY_INTERNAL_DAILY_LIMIT}/${HIGHLIGHTLY_PLAN_DAILY_LIMIT}`,
    );

    error.statusCode = 429;
    error.code =
      'HIGHLIGHTLY_DAILY_BUDGET_REACHED';
    error.details =
      getHighlightlyDailyBudgetSnapshot();

    throw error;
  }

  const pathKey =
    String(apiPath || '/unknown');

  highlightlyDailyBudgetState.used +=
    1;
  highlightlyDailyBudgetState.byPath[
    pathKey
  ] =
    (highlightlyDailyBudgetState.byPath[
      pathKey
    ] ?? 0) + 1;
  highlightlyDailyBudgetState.updatedAt =
    new Date().toISOString();

  // Persistiamo PRIMA della chiamata HTTP: anche un errore del provider
  // consuma una richiesta e, in caso di riavvio del server, il conteggio
  // non torna indietro.
  await persistHighlightlyDailyBudget();

  return getHighlightlyDailyBudgetSnapshot();
}

async function highlightlyGet(
  apiPath,
  query = {},
) {
  const requestContext =
    highlightlyRequestContext.getStore();

  if (
    requestContext?.isHttpRequest === true &&
    requestContext?.providerCallsAllowed !== true
  ) {
    const error = new Error(
      'Dati PREDICT in preparazione sul server centrale',
    );

    error.statusCode = 503;
    error.code =
      'PREDICT_PUBLIC_PROVIDER_BLOCKED';
    error.details = {
      retryLater: true,
      providerCallsAllowed: false,
      apiPath:
        String(apiPath || ''),
    };

    throw error;
  }

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

  await reserveHighlightlyDailyCall(
    apiPath,
  );

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

function bookmakerProbabilitiesHaveAnyMarket(probabilities) {
  if (!probabilities || typeof probabilities !== 'object') {
    return false;
  }

  return Boolean(
    probabilities.oneXTwo ||
    probabilities.bothTeamsToScore ||
    Object.keys(probabilities.totalGoals ?? {}).length > 0 ||
    Object.keys(probabilities.totalCards ?? {}).length > 0 ||
    Object.keys(probabilities.totalCorners ?? {}).length > 0
  );
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

function normalizedSignalStrength(
  probabilityPercent,
  neutralPercent,
) {
  const probability =
    Number(probabilityPercent);

  const neutral =
    Number(neutralPercent);

  if (
    !Number.isFinite(probability) ||
    !Number.isFinite(neutral) ||
    neutral >= 100
  ) {
    return null;
  }

  return round2(
    (
      (probability - neutral) /
      (100 - neutral)
    ) * 100,
  );
}


function sortTopSignalCandidates(
  candidates,
) {
  candidates.sort(
    (a, b) => {
      const strengthDifference =
        Number(
          b.signalStrength ?? -Infinity,
        ) -
        Number(
          a.signalStrength ?? -Infinity,
        );

      if (
        Math.abs(
          strengthDifference,
        ) > 0.000001
      ) {
        return strengthDifference;
      }

      return (
        Number(
          b.probability ?? 0,
        ) -
        Number(
          a.probability ?? 0,
        )
      );
    },
  );

  return candidates;
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
    neutralProbability = 50,
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

    const probabilityPercent =
      numeric * 100;

    const signalStrength =
      normalizedSignalStrength(
        probabilityPercent,
        neutralProbability,
      );

    if (
      signalStrength === null
    ) {
      return;
    }

    candidates.push({
      label,
      probability:
        round2(
          probabilityPercent,
        ),
      market,
      selection,
      line,
      signalStrength,
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
    neutralProbability:
      100 / 3,
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
    neutralProbability:
      100 / 3,
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
    neutralProbability:
      100 / 3,
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

  sortTopSignalCandidates(
    candidates,
  );

  return (
    candidates[0] ??
    null
  );
}

function strictBookmakerDominantBlend(
  predictWeight,
  bookmakerWeight,
) {
  return (
    Number(predictWeight) <= 0.10 &&
    Number(bookmakerWeight) >= 0.90
  );
}

function blendPredictWithBookmaker(
  predictProbabilities,
  bookmakerProbabilities,
  predictWeight = 0.95,
  bookmakerWeight = 0.05,
) {
  const bookmakerOnly =
    strictBookmakerDominantBlend(
      predictWeight,
      bookmakerWeight,
    );

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
  predictWeight = 0.95,
  bookmakerWeight = 0.05,
) {
  const bookmakerOnly =
    strictBookmakerDominantBlend(
      predictWeight,
      bookmakerWeight,
    );

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
  predictWeight = 0.95,
  bookmakerWeight = 0.05,
  strictComparison = false,
) {
  if (!advanced) {
    return advanced;
  }

  const bookmakerOnly =
    strictBookmakerDominantBlend(
      predictWeight,
      bookmakerWeight,
    );

  // Nei confronti A/B un mercato può competere come Top Signal solo se
  // esiste davvero anche la corrispondente quota bookmaker. In questo modo
  // 5/95 e 10/90 non possono trasformarsi accidentalmente in 100% PREDICT.
  const requireBookmakerMarket =
    bookmakerOnly ||
    strictComparison;

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
  // La statistica PREDICT resta visibile nell'Analisi, ma nel regime
  // nei confronti A/B con bookmaker dominante il mercato non può competere senza quota bookmaker.
  if (requireBookmakerMarket) {
    markTopSignalUnavailable(
      advanced.shotsOnTarget,
      strictComparison
        ? 'Confronto A/B: quote bookmaker tiri in porta non disponibili nel feed attuale'
        : 'Quote bookmaker tiri in porta non disponibili nel feed attuale',
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
      if (requireBookmakerMarket) {
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
      if (requireBookmakerMarket) {
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
      if (requireBookmakerMarket) {
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
      if (requireBookmakerMarket) {
        markTopSignalUnavailable(
          metric,
          'Probabilità bookmaker non utilizzabile',
        );
      }

      continue;
    }

    if (bookmakerOnly) {
      // Manteniamo linee e probabilità statistiche PREDICT nella pagina Analisi.
      // Le probabilità del blend vengono salvate separatamente e sono quelle
      // utilizzabili dai Top Signal nei regimi A/B con bookmaker dominante.
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
      metric.bookmakerOnly =
        predictWeight === 0 &&
        bookmakerWeight === 1;
      metric.bookmakerDominantBlend = true;
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

  const publicProviderBlocked =
    error?.code ===
    'PREDICT_PUBLIC_PROVIDER_BLOCKED';

  res
    .status(error.statusCode || 500)
    .json({
      error: publicProviderBlocked
        ? 'Cache PREDICT non ancora pronta'
        : error.statusCode
          ? 'Errore Highlightly'
          : 'Errore interno del server',

      message: error.message,

      ...(publicProviderBlocked
        ? {
            retryLater: true,
            providerCallsAllowed: false,
          }
        : {}),

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

  const supportedCompetition =
    resolveSupportedLeague({
      leagueName,
      countryName,
    });

  let preferredProviderLeagueName =
    null;

  for (
    let page = 0;
    page < 10;
    page += 1
  ) {
    console.log(
      `Scarico stagione ${season} - pagina ${page + 1}, offset ${offset}`,
    );

    let matches = [];

    if (supportedCompetition) {
      const pageResult =
        await fetchSupportedCompetitionMatchesPage({
          competition:
            supportedCompetition,
          season,
          limit:
            String(limit),
          offset:
            String(offset),
          preferredProviderLeagueName,
        });

      matches =
        pageResult.matches;

      if (
        matches.length > 0
      ) {
        preferredProviderLeagueName =
          pageResult
            .providerLeagueName;
      }
    } else {
      const data =
        await highlightlyGet(
          '/matches',
          {
            leagueName,
            countryName,
            season,
            timezone:
              'Europe/Rome',
            limit:
              String(limit),
            offset:
              String(offset),
          },
        );

      matches =
        extractMatches(
          data,
        );
    }

    if (matches.length === 0) {
      break;
    }

    allMatches.push(
      ...matches,
    );

    if (matches.length < limit) {
      break;
    }

    offset +=
      limit;
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



function buildUefaVenueHistory({
  matches,
  homeTeamId,
  awayTeamId,
  competition,
}) {
  const eligibleMatches =
    (Array.isArray(matches)
      ? matches
      : []
    ).filter(
      (match) => {
        const dateKey =
          liveRomeDateKey(
            match?.date,
          );

        return (
          dateKey !== null &&
          dateKey >=
            UEFA_VENUE_HISTORY_START_DATE &&
          isFinishedMatch(match)
        );
      },
    );

  const homeHistory =
    buildTeamHistory(
      eligibleMatches,
      homeTeamId,
    );

  const awayHistory =
    buildTeamHistory(
      eligibleMatches,
      awayTeamId,
    );

  const homeHomeMatches =
    homeHistory.matches.filter(
      (match) =>
        match?.predictAnalysis
          ?.venue === 'home',
    );

  const homeAwayMatches =
    homeHistory.matches.filter(
      (match) =>
        match?.predictAnalysis
          ?.venue === 'away',
    );

  const awayHomeMatches =
    awayHistory.matches.filter(
      (match) =>
        match?.predictAnalysis
          ?.venue === 'home',
    );

  const awayAwayMatches =
    awayHistory.matches.filter(
      (match) =>
        match?.predictAnalysis
          ?.venue === 'away',
    );

  return {
    competition:
      competition?.leagueName ??
      null,

    startDate:
      UEFA_VENUE_HISTORY_START_DATE,

    homeTeam: {
      teamId:
        String(homeTeamId),

      home: {
        venue:
          'home',

        stats:
          homeHistory.home,

        completedMatches:
          homeHomeMatches.length,
      },

      away: {
        venue:
          'away',

        stats:
          homeHistory.away,

        completedMatches:
          homeAwayMatches.length,
      },
    },

    awayTeam: {
      teamId:
        String(awayTeamId),

      home: {
        venue:
          'home',

        stats:
          awayHistory.home,

        completedMatches:
          awayHomeMatches.length,
      },

      away: {
        venue:
          'away',

        stats:
          awayHistory.away,

        completedMatches:
          awayAwayMatches.length,
      },
    },
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


function isDomesticLeagueHistoryToClean({
  leagueName,
  countryName,
}) {
  const supportedLeague =
    resolveSupportedLeague({
      leagueName,
      countryName,
    });

  if (supportedLeague) {
    return (
      supportedLeague.isCup !==
      true
    );
  }

  const normalizedLeagueKey =
    normalizeLeagueText(
      leagueName,
    ).replace(
      /[\s_-]+/g,
      '',
    );

  return new Set([
    'seriea',
    'premierleague',
    'bundesliga',
    'ligue1',
    'laliga',
  ]).has(
    normalizedLeagueKey,
  );
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

  // Primo passaggio:
  // conta le partite complete di ogni squadra.
  // Le squadre comparse soltanto negli spareggi
  // hanno normalmente 1-3 presenze, mentre le
  // partecipanti reali al campionato ne hanno
  // molte di piu.
  const preliminaryTeams =
    [];

  for (
    const team
      of teamMap.values()
  ) {
    const history =
      buildTeamHistory(
        matches,
        team.id,
      );

    preliminaryTeams.push({
      ...team,

      completedMatches:
        history.matches.length,
    });
  }

  const shouldCleanPlayoffTeams =
    isDomesticLeagueHistoryToClean({
      leagueName,
      countryName,
    });

  const maxCompletedMatches =
    preliminaryTeams.length > 0
      ? Math.max(
          ...preliminaryTeams.map(
            (team) =>
              Number(
                team.completedMatches ??
                  0,
              ),
          ),
        )
      : 0;

  // Il filtro parte soltanto quando la stagione ha
  // un campione consistente. In questo modo non
  // eliminiamo squadre durante le prime giornate.
  //
  // Esempio Ligue 1:
  // 34/36 partite -> soglia 17/18.
  // Squadre da spareggio con 1/2/3 partite
  // vengono escluse automaticamente.
  const minimumCoreMatches =
    shouldCleanPlayoffTeams &&
    maxCompletedMatches >= 20
      ? Math.floor(
          maxCompletedMatches *
            0.5,
        )
      : 0;

  const coreTeams =
    minimumCoreMatches > 0
      ? preliminaryTeams.filter(
          (team) =>
            Number(
              team.completedMatches ??
                0,
            ) >=
            minimumCoreMatches,
        )
      : preliminaryTeams;

  const coreTeamIds =
    new Set(
      coreTeams.map(
        (team) =>
          String(team.id),
      ),
    );

  // Togliamo anche le partite giocate contro
  // squadre "playoff-only". Altrimenti la squadra
  // di Ligue 1 coinvolta nello spareggio resterebbe,
  // per esempio, a 36 partite invece di 34.
  const leagueMatches =
    minimumCoreMatches > 0
      ? matches.filter(
          (match) => {
            const homeId =
              teamIdOf(
                match?.homeTeam,
              );

            const awayId =
              teamIdOf(
                match?.awayTeam,
              );

            if (
              !homeId ||
              !awayId
            ) {
              return false;
            }

            return (
              coreTeamIds.has(
                String(homeId),
              ) &&
              coreTeamIds.has(
                String(awayId),
              )
            );
          },
        )
      : matches;

  const teams = [];

  for (
    const team
      of coreTeams
  ) {
    const history =
      buildTeamHistory(
        leagueMatches,
        team.id,
      );

    teams.push({
      id:
        team.id,

      name:
        team.name,

      logo:
        team.logo,

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
    leagueMatches.filter(
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


// Le cache league-history gia esistenti contengono
// gli oggetti match dentro ogni squadra. Questo ci
// permette di ripulire le vecchie cache senza fare
// nuove chiamate Highlightly.
function normalizeCachedLeagueHistory(
  data,
  {
    season,
    leagueName,
    countryName,
  },
) {
  if (
    !data ||
    !Array.isArray(
      data.teams,
    ) ||
    data.teams.length === 0
  ) {
    return data;
  }

  if (
    !isDomesticLeagueHistoryToClean({
      leagueName,
      countryName,
    })
  ) {
    return data;
  }

  const maxCompletedMatches =
    Math.max(
      ...data.teams.map(
        (team) =>
          Number(
            team?.completedMatches ??
              team?.matches?.length ??
              0,
          ),
      ),
    );

  if (
    !Number.isFinite(
      maxCompletedMatches,
    ) ||
    maxCompletedMatches < 20
  ) {
    return data;
  }

  const minimumCoreMatches =
    Math.floor(
      maxCompletedMatches * 0.5,
    );

  const hasPlayoffOnlyTeams =
    data.teams.some(
      (team) =>
        Number(
          team?.completedMatches ??
            team?.matches?.length ??
            0,
        ) <
        minimumCoreMatches,
    );

  if (!hasPlayoffOnlyTeams) {
    return data;
  }

  const cachedMatches =
    uniqueMatches(
      data.teams.flatMap(
        (team) =>
          Array.isArray(
            team?.matches,
          )
            ? team.matches
            : [],
      ),
    );

  if (
    cachedMatches.length === 0
  ) {
    return data;
  }

  const rebuilt =
    buildLeagueHistory(
      cachedMatches,
      {
        season,
        leagueName,
        countryName,
      },
    );

  return {
    ...data,
    ...rebuilt,

    // Manteniamo il conteggio grezzo originario,
    // quando disponibile.
    fetchedMatches:
      data.fetchedMatches ??
      rebuilt.fetchedMatches,
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

  const supportedLeague =
    resolveSupportedLeague({
      leagueName,
      countryName,
    });

  const leagueHistoryCacheTime =
    String(season) ===
    String(
      supportedLeague?.currentSeason ??
      CURRENT_SERIE_A_SEASON,
    )
      ? LEAGUE_CACHE_TIME
      : PREDICT_HISTORY_ARCHIVE_CACHE_TIME;

  const memory =
    getMemoryCache(
      cacheKey,
      leagueHistoryCacheTime,
    );

  if (memory) {
    console.log(
      `CACHE RAM HIT: ${cacheKey}`,
    );

    const normalizedMemory =
      normalizeCachedLeagueHistory(
        memory,
        {
          season,
          leagueName,
          countryName,
        },
      );

    if (
      normalizedMemory !== memory
    ) {
      setMemoryCache(
        cacheKey,
        normalizedMemory,
      );

      await setDiskCache(
        cacheKey,
        normalizedMemory,
      );

      console.log(
        `CACHE LEAGUE NORMALIZED: ${cacheKey}`,
      );
    }

    return {
      data:
        normalizedMemory,

      cacheSource:
        'memory',
    };
  }

  const disk =
    await getDiskCache(
      cacheKey,
      leagueHistoryCacheTime,
    );

  if (disk) {
    console.log(
      `CACHE DISK HIT: ${cacheKey}`,
    );

    const normalizedDisk =
      normalizeCachedLeagueHistory(
        disk,
        {
          season,
          leagueName,
          countryName,
        },
      );

    setMemoryCache(
      cacheKey,
      normalizedDisk,
    );

    if (
      normalizedDisk !== disk
    ) {
      await setDiskCache(
        cacheKey,
        normalizedDisk,
      );

      console.log(
        `CACHE LEAGUE NORMALIZED: ${cacheKey}`,
      );
    }

    return {
      data:
        normalizedDisk,

      cacheSource:
        'disk',
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
        existing.historicalSource ??
        'historical-league',

      sourceLeagueName:
        existing.sourceLeagueName ??
        historicalLeagueHistory
          .leagueName,

      sourceSeason:
        existing.sourceSeason ??
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
  predictWeight = 0.95,
  bookmakerWeight = 0.05,
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

  // Le stagioni storiche 2020-2025 sono archivio immutabile:
  // una cache avanzata già costruita non deve scadere dopo 30 giorni
  // e soprattutto non deve provocare centinaia di nuove chiamate
  // Highlightly a un semplice riavvio del backend.
  const advancedCacheTime =
    PREDICT_ADVANCED_HISTORY_SEASONS.includes(
      String(season),
    )
      ? PREDICT_HISTORY_ARCHIVE_CACHE_TIME
      : LEAGUE_ADVANCED_CACHE_TIME;

  const memory =
    getMemoryCache(
      cacheKey,
      advancedCacheTime,
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
      advancedCacheTime,
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


function advancedHistoricalSeasonWeight(
  season,
) {
  const numericSeason =
    Number.parseInt(
      String(season),
      10,
    );

  if (
    !Number.isFinite(
      numericSeason,
    )
  ) {
    return 0;
  }

  const age =
    Math.max(
      0,
      PREDICT_ADVANCED_HISTORY_LATEST_SEASON -
        numericSeason,
    );

  return Math.pow(
    PREDICT_ADVANCED_HISTORY_SEASON_DECAY,
    age,
  );
}


async function getPreparedAdvancedSeasonProfile({
  season,
  currentSeason,
  leagueName,
  countryName,
  sampleSize =
    ADVANCED_SAMPLE_PER_VENUE,
}) {
  const cacheKey =
    buildLeagueAdvancedCacheKey({
      season:
        String(season),

      leagueName,
      countryName,
      sampleSize,

      rosterSeason:
        String(currentSeason),
    });

  const memory =
    getMemoryCache(
      cacheKey,
      PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
    );

  if (memory) {
    return {
      data:
        memory,

      cacheSource:
        'memory',

      cacheKey,
    };
  }

  const disk =
    await getDiskCache(
      cacheKey,
      PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
    );

  if (disk) {
    setMemoryCache(
      cacheKey,
      disk,
    );

    return {
      data:
        disk,

      cacheSource:
        'disk',

      cacheKey,
    };
  }

  return {
    data: null,
    cacheSource:
      'missing',
    cacheKey,
  };
}


function mergeCumulativeAdvancedSample({
  samples,
  sampleSize =
    ADVANCED_SAMPLE_PER_VENUE,
}) {
  const fields = [
    'cornersFor',
    'cornersAgainst',
    'shotsOnTargetFor',
    'shotsOnTargetAgainst',
    'cardsFor',
    'cardsAgainst',
  ];

  const totals =
    Object.fromEntries(
      fields.map(
        (field) => [
          field,
          {
            value: 0,
            weight: 0,
          },
        ],
      ),
    );

  let rawMatches = 0;
  let weightedMatches = 0;
  let weightedTargetVenue = 0;
  let weightedOppositeVenue = 0;
  let weightedEffectiveVenue = 0;

  const seasonsUsed = [];

  for (const item of samples) {
    const sample =
      item?.sample;

    if (!sample) {
      continue;
    }

    const seasonWeight =
      advancedHistoricalSeasonWeight(
        item.season,
      );

    const matches =
      Math.max(
        0,
        Number(
          sample
            ?.matchesWithAnyData ??
            0,
        ),
      );

    if (
      seasonWeight <= 0 ||
      matches <= 0
    ) {
      continue;
    }

    const contributionWeight =
      matches *
      seasonWeight;

    rawMatches +=
      matches;

    weightedMatches +=
      contributionWeight;

    weightedTargetVenue +=
      Math.max(
        0,
        Number(
          sample
            ?.targetVenueMatchesWithAnyData ??
            0,
        ),
      ) *
      seasonWeight;

    weightedOppositeVenue +=
      Math.max(
        0,
        Number(
          sample
            ?.oppositeVenueMatchesWithAnyData ??
            0,
        ),
      ) *
      seasonWeight;

    weightedEffectiveVenue +=
      Math.max(
        0,
        Number(
          sample
            ?.effectiveVenueMatches ??
            matches,
        ),
      ) *
      seasonWeight;

    seasonsUsed.push({
      season:
        String(item.season),

      weight:
        round2(
          seasonWeight,
        ),

      matchesWithAnyData:
        matches,
    });

    for (const field of fields) {
      const value =
        Number(
          sample?.[field],
        );

      if (
        !Number.isFinite(
          value,
        )
      ) {
        continue;
      }

      totals[field].value +=
        value *
        contributionWeight;

      totals[field].weight +=
        contributionWeight;
    }
  }

  const merged = {
    requestedMatches:
      sampleSize,

    matchesWithAnyData:
      round2(
        Math.min(
          sampleSize,
          weightedMatches,
        ),
      ),

    targetVenueMatchesWithAnyData:
      round2(
        Math.min(
          sampleSize,
          weightedTargetVenue,
        ),
      ),

    oppositeVenueMatchesWithAnyData:
      round2(
        Math.min(
          sampleSize,
          weightedOppositeVenue,
        ),
      ),

    effectiveVenueMatches:
      round2(
        Math.min(
          sampleSize,
          weightedEffectiveVenue,
        ),
      ),

    predictHistoricalRawMatches:
      round2(
        rawMatches,
      ),

    predictHistoricalEffectiveMatches:
      round2(
        weightedMatches,
      ),

    sourceSeasons:
      seasonsUsed,
  };

  for (const field of fields) {
    const fieldWeight =
      totals[field].weight;

    merged[field] =
      fieldWeight > 0
        ? totals[field].value /
          fieldWeight
        : null;
  }

  return merged;
}


function mergeCumulativeLeagueAdvancedProfiles({
  seasonProfiles,
  currentSeason,
  leagueName,
  countryName,
  sampleSize =
    ADVANCED_SAMPLE_PER_VENUE,
}) {
  const newestFirst =
    [...seasonProfiles]
      .sort(
        (a, b) =>
          Number(b.season) -
          Number(a.season),
      );

  const teamIds =
    new Set();

  for (const item of newestFirst) {
    for (
      const team of
        item.data?.teams ?? []
    ) {
      teamIds.add(
        String(team.id),
      );
    }
  }

  const teams = [];

  for (const teamId of teamIds) {
    const perSeasonTeams =
      newestFirst
        .map((item) => ({
          season:
            String(item.season),

          team:
            (
              item.data?.teams ??
              []
            ).find(
              (candidate) =>
                String(
                  candidate.id,
                ) === teamId,
            ) ??
            null,
        }))
        .filter(
          (item) =>
            item.team !== null,
        );

    const identity =
      perSeasonTeams[0]?.team;

    if (!identity) {
      continue;
    }

    const home =
      mergeCumulativeAdvancedSample({
        samples:
          perSeasonTeams.map(
            (item) => ({
              season:
                item.season,
              sample:
                item.team.home,
            }),
          ),

        sampleSize,
      });

    const away =
      mergeCumulativeAdvancedSample({
        samples:
          perSeasonTeams.map(
            (item) => ({
              season:
                item.season,
              sample:
                item.team.away,
            }),
          ),

        sampleSize,
      });

    teams.push({
      id:
        String(identity.id),

      name:
        identity.name ?? '',

      logo:
        identity.logo ?? null,

      home,
      away,
    });
  }

  teams.sort(
    (a, b) =>
      a.name.localeCompare(
        b.name,
      ),
  );

  const requestedSlots =
    teams.length *
    sampleSize *
    2;

  const effectiveSlots =
    teams.reduce(
      (total, team) =>
        total +
        Math.min(
          sampleSize,
          Number(
            team.home
              ?.matchesWithAnyData ??
              0,
          ),
        ) +
        Math.min(
          sampleSize,
          Number(
            team.away
              ?.matchesWithAnyData ??
              0,
          ),
        ),
      0,
    );

  const rawRequested =
    newestFirst.reduce(
      (total, item) =>
        total +
        Number(
          item.data
            ?.uniqueMatchesRequested ??
            0,
        ),
      0,
    );

  const rawWithStatistics =
    newestFirst.reduce(
      (total, item) =>
        total +
        Number(
          item.data
            ?.uniqueMatchesWithStatistics ??
            0,
        ),
      0,
    );

  return {
    season:
      `${PREDICT_ADVANCED_HISTORY_SEASONS[0]}-${PREDICT_ADVANCED_HISTORY_SEASONS[PREDICT_ADVANCED_HISTORY_SEASONS.length - 1]}`,

    currentSeason:
      String(currentSeason),

    leagueName,
    countryName,

    sampleSizePerVenue:
      sampleSize,

    teamsCount:
      teams.length,

    uniqueMatchesRequested:
      rawRequested,

    uniqueMatchesWithStatistics:
      rawWithStatistics,

    coveragePercentage:
      requestedSlots > 0
        ? round2(
            (
              effectiveSlots /
              requestedSlots
            ) *
            100,
          )
        : 0,

    rawHistoricalCoveragePercentage:
      rawRequested > 0
        ? round2(
            (
              rawWithStatistics /
              rawRequested
            ) *
            100,
          )
        : 0,

    sourceSeasons:
      newestFirst.map(
        (item) => ({
          season:
            String(item.season),

          weight:
            round2(
              advancedHistoricalSeasonWeight(
                item.season,
              ),
            ),

          coveragePercentage:
            Number(
              item.data
                ?.coveragePercentage ??
                0,
            ),

          cacheSource:
            item.cacheSource,
        }),
      ),

    teams,

    note:
      'PREDICT v5: storico avanzato cumulativo 2020-2025. Il 2019 è escluso; le stagioni più recenti hanno peso maggiore e quelle precedenti rinforzano i campioni incompleti senza nuove chiamate Highlightly.',
  };
}


async function getCumulativeLeagueAdvancedProfilesFromCache({
  currentSeason,
  leagueName,
  countryName,
  sampleSize =
    ADVANCED_SAMPLE_PER_VENUE,
}) {
  const seasonProfiles = [];
  const missingSeasons = [];

  for (
    const historicalSeason of
      PREDICT_ADVANCED_HISTORY_SEASONS
  ) {
    const prepared =
      await getPreparedAdvancedSeasonProfile({
        season:
          historicalSeason,

        currentSeason,
        leagueName,
        countryName,
        sampleSize,
      });

    if (!prepared.data) {
      missingSeasons.push(
        historicalSeason,
      );

      continue;
    }

    seasonProfiles.push({
      season:
        historicalSeason,

      data:
        prepared.data,

      cacheSource:
        prepared.cacheSource,
    });
  }

  return {
    ready:
      missingSeasons.length === 0,

    missingSeasons,

    loadedSeasons:
      seasonProfiles.map(
        (item) =>
          String(item.season),
      ),

    data:
      seasonProfiles.length > 0
        ? mergeCumulativeLeagueAdvancedProfiles({
            seasonProfiles,
            currentSeason,
            leagueName,
            countryName,
            sampleSize,
          })
        : null,
  };
}


function mergeCumulativeHistoricalStats({
  samples,
}) {
  const fields = [
    'played',
    'wins',
    'draws',
    'losses',
    'goalsFor',
    'goalsAgainst',
    'cleanSheets',
    'failedToScore',
    'over15',
    'over25',
    'over35',
    'bothTeamsScore',
  ];

  const weighted =
    createEmptyStats();

  let rawPlayed = 0;
  let effectivePlayed = 0;
  const seasonsUsed = [];

  for (const item of samples) {
    const stats = item?.stats;

    if (!stats) {
      continue;
    }

    const seasonWeight =
      advancedHistoricalSeasonWeight(
        item.season,
      );

    const played =
      Math.max(
        0,
        Number(
          stats.played ?? 0,
        ),
      );

    if (
      seasonWeight <= 0 ||
      played <= 0
    ) {
      continue;
    }

    for (const field of fields) {
      const value =
        Number(
          stats[field] ?? 0,
        );

      if (
        Number.isFinite(value)
      ) {
        weighted[field] +=
          value * seasonWeight;
      }
    }

    rawPlayed += played;
    effectivePlayed +=
      played * seasonWeight;

    seasonsUsed.push({
      season:
        String(item.season),

      weight:
        round2(seasonWeight),

      matches:
        played,
    });
  }

  const calculated =
    withCalculatedStats(
      weighted,
    );

  return {
    ...calculated,

    predictHistoricalRawMatches:
      rawPlayed,

    predictHistoricalEffectiveMatches:
      round2(effectivePlayed),

    predictHistoricalSeasons:
      seasonsUsed,
  };
}


async function getPreparedLeagueHistorySeason({
  season,
  leagueName,
  countryName,
}) {
  const cacheKey =
    buildLeagueCacheKey({
      season:
        String(season),
      leagueName,
      countryName,
    });

  const memory =
    getMemoryCache(
      cacheKey,
      PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
    );

  if (memory) {
    return {
      data: memory,
      cacheSource:
        'memory',
      cacheKey,
    };
  }

  const disk =
    await getDiskCache(
      cacheKey,
      PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
    );

  if (disk) {
    setMemoryCache(
      cacheKey,
      disk,
    );

    return {
      data: disk,
      cacheSource:
        'disk',
      cacheKey,
    };
  }

  return {
    data: null,
    cacheSource:
      'missing',
    cacheKey,
  };
}


async function getPreparedFallbackHistoricalTeam({
  teamId,
  season,
}) {
  const cacheKey =
    `fallback-team-history-${teamId}-${season}-v3`;

  const memory =
    getMemoryCache(
      cacheKey,
      PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
    );

  if (memory) {
    return memory;
  }

  const disk =
    await getDiskCache(
      cacheKey,
      PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
    );

  if (disk) {
    setMemoryCache(
      cacheKey,
      disk,
    );

    return disk;
  }

  return null;
}


async function mergeCumulativeHistoricalTeam({
  currentTeam,
  preparedSeasons,
  leagueName,
}) {
  const perSeasonTeams = [];

  for (const item of preparedSeasons) {
    const direct =
      item.data?.teams?.find(
        (candidate) =>
          String(candidate.id) ===
          String(currentTeam.id),
      ) ??
      null;

    let historicalTeam =
      direct;

    if (!historicalTeam) {
      historicalTeam =
        await getPreparedFallbackHistoricalTeam({
          teamId:
            currentTeam.id,
          season:
            item.season,
        });
    }

    if (!historicalTeam) {
      continue;
    }

    perSeasonTeams.push({
      season:
        String(item.season),

      team:
        historicalTeam,

      source:
        direct
          ? 'historical-league'
          : historicalTeam.historicalSource ??
            'historical-fallback',

      sourceLeagueName:
        direct
          ? item.data.leagueName
          : historicalTeam.sourceLeagueName ??
            null,
    });
  }

  if (perSeasonTeams.length === 0) {
    return {
      ...currentTeam,

      completedMatches: 0,

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

      matches: [],

      historicalSource:
        'cumulative-missing',

      sourceLeagueName:
        leagueName,

      sourceSeason:
        `${PREDICT_ADVANCED_HISTORY_SEASONS[0]}-${PREDICT_ADVANCED_HISTORY_SEASONS[PREDICT_ADVANCED_HISTORY_SEASONS.length - 1]}`,

      historicalSeasons: [],
    };
  }

  const newestFirst =
    [...perSeasonTeams]
      .sort(
        (a, b) =>
          Number(b.season) -
          Number(a.season),
      );

  const overall =
    mergeCumulativeHistoricalStats({
      samples:
        newestFirst.map(
          (item) => ({
            season:
              item.season,
            stats:
              item.team.summary?.overall,
          }),
        ),
    });

  const home =
    mergeCumulativeHistoricalStats({
      samples:
        newestFirst.map(
          (item) => ({
            season:
              item.season,
            stats:
              item.team.summary?.home,
          }),
        ),
    });

  const away =
    mergeCumulativeHistoricalStats({
      samples:
        newestFirst.map(
          (item) => ({
            season:
              item.season,
            stats:
              item.team.summary?.away,
          }),
        ),
    });

  const allMatches =
    uniqueMatches(
      newestFirst.flatMap(
        (item) =>
          (item.team.matches ?? [])
            .map(
              (match) => ({
                ...match,

                predictHistoricalSeason:
                  String(item.season),

                predictHistoricalSeasonWeight:
                  round2(
                    advancedHistoricalSeasonWeight(
                      item.season,
                    ),
                  ),
              }),
            ),
      ),
    );

  const rawCompletedMatches =
    newestFirst.reduce(
      (total, item) =>
        total +
        Number(
          item.team.completedMatches ??
          item.team.summary?.overall?.played ??
          0,
        ),
      0,
    );

  return {
    id:
      String(currentTeam.id),

    name:
      currentTeam.name ||
      newestFirst[0]?.team?.name ||
      '',

    logo:
      currentTeam.logo ||
      newestFirst[0]?.team?.logo ||
      null,

    completedMatches:
      rawCompletedMatches,

    effectiveHistoricalMatches:
      overall.predictHistoricalEffectiveMatches ??
      0,

    summary: {
      overall,
      home,
      away,
    },

    matches:
      allMatches,

    historicalSource:
      'cumulative-2020-2025',

    sourceLeagueName:
      leagueName,

    sourceSeason:
      `${PREDICT_ADVANCED_HISTORY_SEASONS[0]}-${PREDICT_ADVANCED_HISTORY_SEASONS[PREDICT_ADVANCED_HISTORY_SEASONS.length - 1]}`,

    historicalSeasons:
      newestFirst.map(
        (item) => ({
          season:
            String(item.season),

          weight:
            round2(
              advancedHistoricalSeasonWeight(
                item.season,
              ),
            ),

          source:
            item.source,

          sourceLeagueName:
            item.sourceLeagueName,

          completedMatches:
            Number(
              item.team.completedMatches ??
              item.team.summary?.overall?.played ??
              0,
            ),
        }),
      ),
  };
}


async function getCumulativeLeagueHistoryFromPreparedCaches({
  currentSeason,
  leagueName,
  countryName,
  currentLeagueHistory,
}) {
  const preparedSeasons = [];
  const missingSeasons = [];

  for (
    const historicalSeason of
      PREDICT_ADVANCED_HISTORY_SEASONS
  ) {
    const prepared =
      await getPreparedLeagueHistorySeason({
        season:
          historicalSeason,
        leagueName,
        countryName,
      });

    if (!prepared.data) {
      missingSeasons.push(
        String(historicalSeason),
      );
      continue;
    }

    preparedSeasons.push({
      season:
        String(historicalSeason),
      data:
        prepared.data,
      cacheSource:
        prepared.cacheSource,
    });
  }

  if (
    missingSeasons.length > 0 ||
    !currentLeagueHistory ||
    (currentLeagueHistory.teams ?? []).length === 0
  ) {
    return {
      ready: false,
      missingSeasons,
      loadedSeasons:
        preparedSeasons.map(
          (item) =>
            String(item.season),
        ),
      data: null,
    };
  }

  const teams =
    await mapWithConcurrency(
      currentLeagueHistory.teams ?? [],
      2,
      async (currentTeam) =>
        await mergeCumulativeHistoricalTeam({
          currentTeam,
          preparedSeasons,
          leagueName,
        }),
    );

  teams.sort(
    (a, b) =>
      a.name.localeCompare(
        b.name,
      ),
  );

  const usedTeamSeasonSlots =
    teams.reduce(
      (total, team) =>
        total +
        Number(
          team.historicalSeasons
            ?.length ??
            0,
        ),
      0,
    );

  const requestedTeamSeasonSlots =
    teams.length *
    PREDICT_ADVANCED_HISTORY_SEASONS.length;

  return {
    ready: true,

    missingSeasons: [],

    loadedSeasons:
      preparedSeasons.map(
        (item) =>
          String(item.season),
      ),

    data: {
      season:
        `${PREDICT_ADVANCED_HISTORY_SEASONS[0]}-${PREDICT_ADVANCED_HISTORY_SEASONS[PREDICT_ADVANCED_HISTORY_SEASONS.length - 1]}`,

      rosterSeason:
        String(currentSeason),

      leagueName,
      countryName,

      fetchedMatches:
        preparedSeasons.reduce(
          (total, item) =>
            total +
            Number(
              item.data.fetchedMatches ??
              0,
            ),
          0,
        ),

      completedMatches:
        preparedSeasons.reduce(
          (total, item) =>
            total +
            Number(
              item.data.completedMatches ??
              0,
            ),
          0,
        ),

      teamsCount:
        teams.length,

      teams,

      teamSeasonCoveragePercentage:
        requestedTeamSeasonSlots > 0
          ? round2(
              (
                usedTeamSeasonSlots /
                requestedTeamSeasonSlots
              ) *
              100,
            )
          : 0,

      sourceSeasons:
        [...preparedSeasons]
          .sort(
            (a, b) =>
              Number(b.season) -
              Number(a.season),
          )
          .map(
            (item) => ({
              season:
                String(item.season),

              weight:
                round2(
                  advancedHistoricalSeasonWeight(
                    item.season,
                  ),
                ),

              cacheSource:
                item.cacheSource,
            }),
          ),

      note:
        'PREDICT v5: storico risultati/gol cumulativo 2020-2025, 2019 escluso. Le stagioni recenti pesano di più; la stagione 2026 entra progressivamente dopo ogni partita conclusa.',
    },
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
      currentAdvanced?.season ??
      CURRENT_SERIE_A_SEASON,

    currentSeasonTeamsWithData:
      currentTeams.length,

    note:
      historicalAdvanced?.note ??
      `PREDICT v5: profilo avanzato storico + ${historicalAdvanced?.leagueName ?? 'campionato'} ${currentAdvanced?.season ?? CURRENT_SERIE_A_SEASON} con peso progressivo dopo ogni risultato.`,
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
      leagueAdvanced?.note ??
      `PREDICT v5: storico avanzato fino a ${leagueAdvanced?.sampleSizePerVenue ?? ADVANCED_SAMPLE_PER_VENUE} gare casa + ${leagueAdvanced?.sampleSizePerVenue ?? ADVANCED_SAMPLE_PER_VENUE} trasferte, con progressivo ingresso della stagione corrente ${CURRENT_SERIE_A_SEASON}.`,
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

  // Coppe UEFA: senza quote bookmaker non pubblichiamo alcun segnale.
  // Le statistiche grezze dell'analisi restano disponibili, ma non vengono
  // trasformate in Primary Signal o Top Signals.
  if (prediction.bookmakerFallback === true) {
    prediction.primarySignal = null;
    prediction.topSignals = [];
    prediction.signalsAvailable = false;
    prediction.signalsUnavailableReason =
      prediction.bookmakerFallbackReason ??
      'Quote bookmaker non disponibili per questa partita';

    return {
      ...analysis,
      prediction,
    };
  }

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
// FIREBASE PUSH — SQUADRA DEL CUORE
// ====================================================

app.post(
  '/api/notifications/register-device',
  async (req, res) => {
    try {
      const token =
        String(req.body?.token ?? '').trim();
      const teamId =
        String(req.body?.teamId ?? '').trim();
      const teamName =
        String(req.body?.teamName ?? '').trim();
      const leagueKey =
        String(req.body?.leagueKey ?? '').trim();
      const leagueName =
        String(req.body?.leagueName ?? '').trim();
      const countryName =
        String(req.body?.countryName ?? '').trim();
      const languageCode =
        String(req.body?.languageCode ?? 'it').trim() || 'it';

      if (!token) {
        return res.status(400).json({
          ok: false,
          error: 'token FCM obbligatorio',
        });
      }

      if (!teamId || !teamName || !leagueKey) {
        return res.status(400).json({
          ok: false,
          error: 'teamId, teamName e leagueKey obbligatori',
        });
      }

      await loadFavoriteTeamNotificationSubscriptions();

      const previous =
        favoriteTeamNotificationSubscriptions.get(token);

      const now = new Date().toISOString();

      const subscription = {
        token,
        tokenFingerprint:
          favoriteTeamTokenFingerprint(token),
        teamId,
        teamName,
        leagueKey,
        leagueName,
        countryName,
        languageCode,
        notifications: {
          officialLineups: true,
          goals: true,
        },
        createdAt:
          previous?.createdAt ?? now,
        updatedAt: now,
      };

      favoriteTeamNotificationSubscriptions.set(
        token,
        subscription,
      );

      await saveFavoriteTeamNotificationSubscriptions();

      console.log(
        `PREDICT FAVORITE TEAM PUSH: ${teamName} (${teamId}) registrata per dispositivo ${subscription.tokenFingerprint}`,
      );

      return res.json({
        ok: true,
        registered: true,
        subscription: {
          tokenFingerprint:
            subscription.tokenFingerprint,
          teamId:
            subscription.teamId,
          teamName:
            subscription.teamName,
          leagueKey:
            subscription.leagueKey,
          leagueName:
            subscription.leagueName,
          countryName:
            subscription.countryName,
          languageCode:
            subscription.languageCode,
          notifications:
            subscription.notifications,
          updatedAt:
            subscription.updatedAt,
        },
      });
    } catch (error) {
      console.error(
        'PREDICT FAVORITE TEAM REGISTER ERROR:',
        error?.message ?? error,
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ?? String(error),
      });
    }
  },
);

app.post(
  '/api/notifications/unregister-device',
  async (req, res) => {
    try {
      const token =
        String(
          req.body?.token ??
          '',
        ).trim();

      if (!token) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              'token FCM obbligatorio',
          });
      }

      await loadFavoriteTeamNotificationSubscriptions();

      const existing =
        favoriteTeamNotificationSubscriptions.get(
          token,
        );

      const removed =
        favoriteTeamNotificationSubscriptions.delete(
          token,
        );

      if (removed) {
        await saveFavoriteTeamNotificationSubscriptions();

        console.log(
          `PREDICT FAVORITE TEAM PUSH: notifiche disattivate per dispositivo ${favoriteTeamTokenFingerprint(token)}${existing?.teamName ? ` (${existing.teamName})` : ''}`,
        );
      }

      return res.json({
        ok: true,
        registered: false,
        removed,
        tokenFingerprint:
          favoriteTeamTokenFingerprint(
            token,
          ),
      });
    } catch (error) {
      console.error(
        'PREDICT FAVORITE TEAM UNREGISTER ERROR:',
        error?.message ??
          error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            String(error),
        });
    }
  },
);

app.get(
  '/api/notifications/subscriptions-status',
  async (req, res) => {
    try {
      await loadFavoriteTeamNotificationSubscriptions();

      const byTeam = {};

      for (const item of
        favoriteTeamNotificationSubscriptions.values()) {
        const key =
          `${item?.leagueKey ?? 'unknown'}:${item?.teamId ?? 'unknown'}`;

        if (!byTeam[key]) {
          byTeam[key] = {
            teamId: item?.teamId ?? null,
            teamName: item?.teamName ?? null,
            leagueKey: item?.leagueKey ?? null,
            devices: 0,
          };
        }

        byTeam[key].devices += 1;
      }

      return res.json({
        ok: true,
        devices:
          favoriteTeamNotificationSubscriptions.size,
        teams:
          Object.values(byTeam),
        notificationEngine: {
          started:
            Boolean(
              favoriteTeamNotificationSchedulerState.startedAt,
            ),
          startedAt:
            favoriteTeamNotificationSchedulerState.startedAt,
          lastTickAt:
            favoriteTeamNotificationSchedulerState.lastTickAt,
          running:
            favoriteTeamNotificationSchedulerState.running,
          lastError:
            favoriteTeamNotificationSchedulerState.lastError,
          pollSeconds:
            Math.round(
              FAVORITE_TEAM_NOTIFICATION_POLL_INTERVAL /
              1000,
            ),
          lineupsWindowMinutes:
            Math.round(
              FAVORITE_TEAM_LINEUPS_WINDOW /
              60000,
            ),
        },
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          error?.message ?? String(error),
      });
    }
  },
);

// ====================================================
// FIREBASE PUSH — TEST ROUTING SQUADRA DEL CUORE
// ====================================================

app.post(
  '/api/notifications/test-team/:teamId',
  async (req, res) => {
    try {
      if (!predictFirebaseMessaging) {
        return res
          .status(503)
          .json({
            ok: false,
            error:
              'Firebase Admin non disponibile',
          });
      }

      await loadFavoriteTeamNotificationSubscriptions();

      const teamId =
        String(
          req.params?.teamId ??
          '',
        ).trim();

      const subscriptions =
        Array.from(
          favoriteTeamNotificationSubscriptions.values(),
        ).filter(
          (item) =>
            String(
              item?.teamId ??
              '',
            ) === teamId,
        );

      if (subscriptions.length === 0) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              'Nessun dispositivo registrato per questa squadra',
          });
      }

      const title =
        String(
          req.body?.title ??
          'PREDICT Squadra del cuore',
        ).trim() ||
        'PREDICT Squadra del cuore';

      const body =
        String(
          req.body?.body ??
          `Routing notifiche attivo per ${subscriptions[0]?.teamName ?? 'la squadra selezionata'}.`,
        ).trim();

      const notificationType =
        String(
          req.body?.type ??
          'predict-favorite-team-test',
        ).trim();

      const matchId =
        String(
          req.body?.matchId ??
          '',
        ).trim();

      const result =
        await sendFavoriteTeamMulticast({
          subscriptions,
          notification: {
            title,
            body,
          },
          data: {
            type:
              notificationType,
            teamId,
            ...(matchId
              ? {
                  matchId,
                }
              : {}),
          },
        });

      return res.json({
        ok: true,
        teamId,
        teamName:
          subscriptions[0]?.teamName ??
          null,
        devices:
          subscriptions.length,
        successCount:
          result.successCount,
        failureCount:
          result.failureCount,
        type:
          notificationType,
        matchId:
          matchId || null,
      });
    } catch (error) {
      console.error(
        'PREDICT FAVORITE TEAM TEST ERROR:',
        error?.message ??
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            String(error),
        });
    }
  },
);

// ====================================================
// FIREBASE PUSH — TEST BACKEND LOCALE
// ====================================================

app.post(
  '/api/notifications/test',
  async (req, res) => {
    try {
      if (!predictFirebaseMessaging) {
        return res
          .status(503)
          .json({
            ok: false,
            error:
              'Firebase Admin non disponibile',
            details:
              predictFirebaseAdminError,
          });
      }

      const token =
        String(
          req.body?.token ??
          '',
        ).trim();

      if (!token) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              'token FCM obbligatorio',
          });
      }

      const title =
        String(
          req.body?.title ??
          'PREDICT TEST BACKEND',
        ).trim() ||
        'PREDICT TEST BACKEND';

      const body =
        String(
          req.body?.body ??
          'Firebase Admin collegato correttamente.',
        ).trim() ||
        'Firebase Admin collegato correttamente.';

      const messageId =
        await predictFirebaseMessaging
          .send({
            token,
            notification: {
              title,
              body,
            },
            data: {
              type:
                'predict-backend-test',
            },
            android: {
              priority:
                'high',
              notification: {
                channelId:
                  'predict_favorite_team',
              },
            },
          });

      return res.json({
        ok: true,
        messageId,
        firebaseProjectId:
          predictFirebaseProjectId,
      });
    } catch (error) {
      console.error(
        'PREDICT FIREBASE TEST ERROR:',
        error?.message ??
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            String(error),
        });
    }
  },
);

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
      firebaseMessagingReady:
        Boolean(
          predictFirebaseMessaging,
        ),
      firebaseProjectId:
        predictFirebaseProjectId,
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

function createCentralDomesticLeagueState() {
  return {
    matches: [],
    byDate: new Map(),
    lastScheduleSyncAt: null,
    lastLiveSyncAt: null,
  };
}

const CENTRAL_DOMESTIC_LEAGUES =
  Object.freeze(
    SUPPORTED_LEAGUE_LIST.filter(
      (league) =>
        league?.isCup !== true &&
        league?.supportsMatchdayPicks !== false,
    ),
  );

const centralDomesticLeagueStates =
  new Map(
    CENTRAL_DOMESTIC_LEAGUES.map(
      (league) => [
        league.key,
        league.key === 'serie-a'
          ? centralSerieAState
          : createCentralDomesticLeagueState(),
      ],
    ),
  );

function centralLeagueStateOf(
  leagueOrKey,
) {
  const key =
    typeof leagueOrKey === 'string'
      ? leagueOrKey
      : leagueOrKey?.key;

  return (
    centralDomesticLeagueStates.get(
      String(key ?? ''),
    ) ??
    null
  );
}

function centralLeagueConfigOfKey(
  key,
) {
  return (
    CENTRAL_DOMESTIC_LEAGUES.find(
      (league) =>
        league.key === key,
    ) ??
    null
  );
}

function centralDomesticEntries() {
  const entries = [];

  for (
    const league
      of CENTRAL_DOMESTIC_LEAGUES
  ) {
    const state =
      centralLeagueStateOf(
        league,
      );

    for (
      const match
        of state?.matches ?? []
    ) {
      entries.push({
        league,
        state,
        match,
      });
    }
  }

  return entries;
}

function centralFindMatchEntryById(
  matchId,
) {
  const wanted =
    String(matchId ?? '');

  if (!wanted) {
    return null;
  }

  for (
    const entry
      of centralDomesticEntries()
  ) {
    if (
      String(
        entry.match?.id ?? '',
      ) === wanted
    ) {
      return entry;
    }
  }

  return null;
}


function centralMatchIsLiveNow(
  match,
  now = new Date(),
) {
  const startMs =
    Date.parse(
      match?.date ?? '',
    );

  if (
    !Number.isFinite(startMs) ||
    isFinishedMatch(match)
  ) {
    return false;
  }

  const nowMs =
    now.getTime();

  if (
    nowMs < startMs ||
    nowMs >
      startMs +
        CENTRAL_SERIE_A_POSTSTART_WINDOW
  ) {
    return false;
  }

  const description =
    String(
      match?.state?.description ??
      match?.state?.state ??
      '',
    )
      .trim()
      .toLowerCase();

  const explicitlyNotLive = [
    'not started',
    'scheduled',
    'postponed',
    'cancelled',
    'canceled',
    'abandoned',
    'suspended',
  ].some(
    (value) =>
      description.includes(
        value,
      ),
  );

  return !explicitlyNotLive;
}

function buildCentralLiveMatchesPayload(
  now = new Date(),
) {
  const matches =
    centralDomesticEntries()
      .filter(
        ({ match }) =>
          centralMatchIsLiveNow(
            match,
            now,
          ),
      )
      .map(
        ({
          match,
          league,
          state,
        }) => ({
          ...match,
          predictLive: {
            leagueKey:
              league?.key ??
              null,
            leagueName:
              league?.leagueName ??
              null,
            countryName:
              league?.countryName ??
              null,
            lastLiveSyncAt:
              state?.lastLiveSyncAt ??
              null,
          },
        }),
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

  return {
    ok: true,
    generatedAt:
      now.toISOString(),
    refreshAfterSeconds:
      Math.round(
        LIVE_MATCHES_CACHE_TIME /
          1000,
      ),
    data:
      matches,
  };
}


function favoriteTeamSubscriptionsForTeam(
  teamId,
  notificationKey = null,
) {
  const wanted =
    String(teamId ?? '');

  if (!wanted) {
    return [];
  }

  return Array.from(
    favoriteTeamNotificationSubscriptions.values(),
  ).filter(
    (item) => {
      if (
        String(
          item?.teamId ??
          '',
        ) !== wanted
      ) {
        return false;
      }

      if (
        notificationKey &&
        item?.notifications?.[notificationKey] === false
      ) {
        return false;
      }

      return true;
    },
  );
}

function favoriteTeamNotificationLanguage(
  value,
) {
  const language =
    String(
      value ??
      'it',
    )
      .trim()
      .toLowerCase();

  return [
    'it',
    'en',
    'de',
    'fr',
    'es',
  ].includes(
    language,
  )
    ? language
    : 'it';
}

function favoriteTeamCopy({
  languageCode,
  type,
  favoriteTeamName,
  homeTeamName,
  awayTeamName,
  scoringTeamName,
  minute,
  player,
  assist,
  scoredByFavorite,
}) {
  const lang =
    favoriteTeamNotificationLanguage(
      languageCode,
    );

  const fixture =
    `${homeTeamName} - ${awayTeamName}`;

  const minuteText =
    minute
      ? `${minute}'`
      : '';

  const assistText =
    assist
      ? ` • Assist: ${assist}`
      : '';

  const playerText =
    player ||
    scoringTeamName ||
    '';

  if (type === 'lineups') {
    const copies = {
      it: {
        title:
          `📋 Formazioni ufficiali: ${favoriteTeamName}`,
        body:
          `Pubblicate le formazioni ufficiali di ${fixture}.`,
      },
      en: {
        title:
          `📋 Official lineups: ${favoriteTeamName}`,
        body:
          `The official lineups for ${fixture} are available.`,
      },
      de: {
        title:
          `📋 Offizielle Aufstellungen: ${favoriteTeamName}`,
        body:
          `Die offiziellen Aufstellungen für ${fixture} sind verfügbar.`,
      },
      fr: {
        title:
          `📋 Compositions officielles : ${favoriteTeamName}`,
        body:
          `Les compositions officielles de ${fixture} sont disponibles.`,
      },
      es: {
        title:
          `📋 Alineaciones oficiales: ${favoriteTeamName}`,
        body:
          `Ya están disponibles las alineaciones oficiales de ${fixture}.`,
      },
    };

    return copies[lang];
  }



  const ownGoalCopies = {
    it: {
      title:
        `⚽ GOL ${favoriteTeamName.toUpperCase()}! ${minuteText}`.trim(),
      body:
        `${playerText}${assistText}`,
    },
    en: {
      title:
        `⚽ ${favoriteTeamName.toUpperCase()} GOAL! ${minuteText}`.trim(),
      body:
        `${playerText}${assistText}`,
    },
    de: {
      title:
        `⚽ TOR ${favoriteTeamName.toUpperCase()}! ${minuteText}`.trim(),
      body:
        `${playerText}${assistText}`,
    },
    fr: {
      title:
        `⚽ BUT ${favoriteTeamName.toUpperCase()} ! ${minuteText}`.trim(),
      body:
        `${playerText}${assistText}`,
    },
    es: {
      title:
        `⚽ ¡GOL ${favoriteTeamName.toUpperCase()}! ${minuteText}`.trim(),
      body:
        `${playerText}${assistText}`,
    },
  };

  const opponentGoalCopies = {
    it: {
      title:
        `⚽ Gol ${scoringTeamName} ${minuteText}`.trim(),
      body:
        `${playerText}${assistText} • contro ${favoriteTeamName}`,
    },
    en: {
      title:
        `⚽ ${scoringTeamName} goal ${minuteText}`.trim(),
      body:
        `${playerText}${assistText} • against ${favoriteTeamName}`,
    },
    de: {
      title:
        `⚽ Tor ${scoringTeamName} ${minuteText}`.trim(),
      body:
        `${playerText}${assistText} • gegen ${favoriteTeamName}`,
    },
    fr: {
      title:
        `⚽ But ${scoringTeamName} ${minuteText}`.trim(),
      body:
        `${playerText}${assistText} • contre ${favoriteTeamName}`,
    },
    es: {
      title:
        `⚽ Gol ${scoringTeamName} ${minuteText}`.trim(),
      body:
        `${playerText}${assistText} • contra ${favoriteTeamName}`,
    },
  };

  return scoredByFavorite
    ? ownGoalCopies[lang]
    : opponentGoalCopies[lang];
}

function isInvalidFirebaseRegistrationError(
  error,
) {
  const code =
    String(
      error?.code ??
      error?.errorInfo?.code ??
      '',
    );

  return (
    code.includes(
      'registration-token-not-registered',
    ) ||
    code.includes(
      'invalid-registration-token',
    )
  );
}

async function sendFavoriteTeamMulticast({
  subscriptions,
  notification,
  data = {},
}) {
  if (!predictFirebaseMessaging) {
    throw new Error(
      'Firebase Admin non disponibile',
    );
  }

  const cleanSubscriptions =
    subscriptions.filter(
      (item) =>
        String(
          item?.token ??
          '',
        ).trim(),
    );

  let successCount = 0;
  let failureCount = 0;
  let removedInvalidTokens = 0;

  for (
    let index = 0;
    index < cleanSubscriptions.length;
    index += 500
  ) {
    const chunk =
      cleanSubscriptions.slice(
        index,
        index + 500,
      );

    const tokens =
      chunk.map(
        (item) =>
          String(item.token),
      );

    const response =
      await predictFirebaseMessaging
        .sendEachForMulticast({
          tokens,
          notification,
          data:
            Object.fromEntries(
              Object.entries(
                data,
              ).map(
                ([key, value]) => [
                  key,
                  String(
                    value ??
                    '',
                  ),
                ],
              ),
            ),
          android: {
            priority:
              'high',
            notification: {
              channelId:
                'predict_favorite_team',
            },
          },
        });

    successCount +=
      Number(
        response?.successCount ??
        0,
      );

    failureCount +=
      Number(
        response?.failureCount ??
        0,
      );

    const responses =
      Array.isArray(
        response?.responses,
      )
        ? response.responses
        : [];

    for (
      let responseIndex = 0;
      responseIndex < responses.length;
      responseIndex += 1
    ) {
      const item =
        responses[
          responseIndex
        ];

      if (
        item?.success ||
        !isInvalidFirebaseRegistrationError(
          item?.error,
        )
      ) {
        continue;
      }

      const invalidToken =
        tokens[
          responseIndex
        ];

      if (
        favoriteTeamNotificationSubscriptions.delete(
          invalidToken,
        )
      ) {
        removedInvalidTokens += 1;
      }
    }
  }

  if (
    removedInvalidTokens > 0
  ) {
    await saveFavoriteTeamNotificationSubscriptions();

    console.log(
      `PREDICT FAVORITE TEAM PUSH: rimossi ${removedInvalidTokens} token FCM non più validi`,
    );
  }

  return {
    successCount,
    failureCount,
  };
}

async function sendFavoriteTeamLocalized({
  teamId,
  notificationKey,
  type,
  context,
  data,
}) {
  const subscriptions =
    favoriteTeamSubscriptionsForTeam(
      teamId,
      notificationKey,
    );

  if (
    subscriptions.length === 0
  ) {
    return {
      successCount: 0,
      failureCount: 0,
    };
  }

  const byLanguage =
    new Map();

  for (
    const subscription
      of subscriptions
  ) {
    const language =
      favoriteTeamNotificationLanguage(
        subscription?.languageCode,
      );

    if (
      !byLanguage.has(
        language,
      )
    ) {
      byLanguage.set(
        language,
        [],
      );
    }

    byLanguage
      .get(language)
      .push(
        subscription,
      );
  }

  let successCount = 0;
  let failureCount = 0;

  for (
    const [
      languageCode,
      group,
    ]
      of byLanguage.entries()
  ) {
    const copy =
      favoriteTeamCopy({
        languageCode,
        type,
        ...context,
      });

    const result =
      await sendFavoriteTeamMulticast({
        subscriptions:
          group,
        notification:
          copy,
        data,
      });

    successCount +=
      result.successCount;

    failureCount +=
      result.failureCount;
  }

  return {
    successCount,
    failureCount,
  };
}

function favoriteTeamMatchTeamIds(
  match,
) {
  return [
    String(
      match?.homeTeam?.id ??
      '',
    ),
    String(
      match?.awayTeam?.id ??
      '',
    ),
  ].filter(Boolean);
}

function favoriteTeamHasSubscribersForMatch(
  match,
) {
  const ids =
    new Set(
      favoriteTeamMatchTeamIds(
        match,
      ),
    );

  if (
    ids.size === 0
  ) {
    return false;
  }

  for (
    const subscription
      of favoriteTeamNotificationSubscriptions.values()
  ) {
    if (
      ids.has(
        String(
          subscription?.teamId ??
          '',
        ),
      )
    ) {
      return true;
    }
  }

  return false;
}

function favoriteTeamGoalEvents(
  payload,
) {
  const events =
    Array.isArray(payload)
      ? payload
      : Array.isArray(
          payload?.value,
        )
        ? payload.value
        : Array.isArray(
            payload?.data,
          )
          ? payload.data
          : Array.isArray(
              payload?.events,
            )
            ? payload.events
            : [];

  return events.filter(
    (event) =>
      String(
        event?.type ??
        '',
      )
        .trim()
        .toLowerCase() ===
      'goal',
  );
}

function favoriteTeamGoalEventKey(
  matchId,
  event,
) {
  return [
    'goal',
    String(matchId ?? ''),
    String(
      event?.time ??
      '',
    ),
    String(
      event?.team?.id ??
      '',
    ),
    String(
      event?.playerId ??
      event?.player ??
      '',
    ),
  ].join(':');
}

function favoriteTeamLineupsAreOfficial(
  payload,
) {
  function lineupCount(
    team,
  ) {
    const rows =
      Array.isArray(
        team?.initialLineup,
      )
        ? team.initialLineup
        : [];

    return rows.reduce(
      (count, row) =>
        count +
        (
          Array.isArray(row)
            ? row.length
            : 0
        ),
      0,
    );
  }

  return (
    lineupCount(
      payload?.homeTeam,
    ) >= 11 &&
    lineupCount(
      payload?.awayTeam,
    ) >= 11
  );
}

async function favoriteTeamFetchLineups(
  matchId,
) {
  return cachedHighlightlyGet({
    key:
      `lineups-${matchId}`,
    apiPath:
      `/lineups/${matchId}`,
    query: {},
    ttl:
      LINEUPS_CACHE_TIME,
  });
}

async function favoriteTeamFetchEvents(
  matchId,
) {
  return cachedHighlightlyGet({
    key:
      `events-${matchId}`,
    apiPath:
      `/events/${matchId}`,
    query: {},
    ttl:
      LIVE_EVENTS_CACHE_TIME,
  });
}

async function favoriteTeamProcessLineups({
  match,
  nowMs,
  startMs,
}) {
  if (
    nowMs <
      startMs -
        FAVORITE_TEAM_LINEUPS_WINDOW ||
    nowMs >
      startMs +
        5 * 60 * 1000
  ) {
    return;
  }

  const homeId =
    String(
      match?.homeTeam?.id ??
      '',
    );

  const awayId =
    String(
      match?.awayTeam?.id ??
      '',
    );

  const homeNeeds =
    favoriteTeamSubscriptionsForTeam(
      homeId,
      'officialLineups',
    ).length > 0 &&
    !favoriteTeamNotificationSentState.has(
      `lineups:${match.id}:${homeId}`,
    );

  const awayNeeds =
    favoriteTeamSubscriptionsForTeam(
      awayId,
      'officialLineups',
    ).length > 0 &&
    !favoriteTeamNotificationSentState.has(
      `lineups:${match.id}:${awayId}`,
    );

  if (
    !homeNeeds &&
    !awayNeeds
  ) {
    return;
  }

  const payload =
    await favoriteTeamFetchLineups(
      match.id,
    );

  if (
    !favoriteTeamLineupsAreOfficial(
      payload,
    )
  ) {
    return;
  }

  const baseContext = {
    homeTeamName:
      match?.homeTeam?.name ??
      payload?.homeTeam?.name ??
      'Casa',
    awayTeamName:
      match?.awayTeam?.name ??
      payload?.awayTeam?.name ??
      'Ospite',
  };

  if (homeNeeds) {
    const result =
      await sendFavoriteTeamLocalized({
        teamId:
          homeId,
        notificationKey:
          'officialLineups',
        type:
          'lineups',
        context: {
          ...baseContext,
          favoriteTeamName:
            match?.homeTeam?.name ??
            payload?.homeTeam?.name ??
            'Squadra',
        },
        data: {
          type:
            'favorite-lineups',
          matchId:
            match.id,
          favoriteTeamId:
            homeId,
        },
      });

    favoriteTeamNotificationSentState.set(
      `lineups:${match.id}:${homeId}`,
      new Date().toISOString(),
    );

    console.log(
      `PREDICT FAVORITE PUSH LINEUPS: ${match?.homeTeam?.name ?? homeId}, inviati ${result.successCount}`,
    );
  }

  if (awayNeeds) {
    const result =
      await sendFavoriteTeamLocalized({
        teamId:
          awayId,
        notificationKey:
          'officialLineups',
        type:
          'lineups',
        context: {
          ...baseContext,
          favoriteTeamName:
            match?.awayTeam?.name ??
            payload?.awayTeam?.name ??
            'Squadra',
        },
        data: {
          type:
            'favorite-lineups',
          matchId:
            match.id,
          favoriteTeamId:
            awayId,
        },
      });

    favoriteTeamNotificationSentState.set(
      `lineups:${match.id}:${awayId}`,
      new Date().toISOString(),
    );

    console.log(
      `PREDICT FAVORITE PUSH LINEUPS: ${match?.awayTeam?.name ?? awayId}, inviati ${result.successCount}`,
    );
  }

  await saveFavoriteTeamNotificationState();
}



async function favoriteTeamProcessGoals({
  match,
  nowMs,
  startMs,
}) {
  if (
    nowMs < startMs ||
    nowMs >
      startMs +
        FAVORITE_TEAM_POSTSTART_WINDOW ||
    isFinishedMatch(
      match,
    )
  ) {
    return;
  }

  const baselineKey =
    `goal-baseline:${match.id}`;

  const payload =
    await favoriteTeamFetchEvents(
      match.id,
    );

  const goals =
    favoriteTeamGoalEvents(
      payload,
    );

  if (
    !favoriteTeamNotificationSentState.has(
      baselineKey,
    )
  ) {
    favoriteTeamNotificationSentState.set(
      baselineKey,
      new Date().toISOString(),
    );

    for (
      const event
        of goals
    ) {
      favoriteTeamNotificationSentState.set(
        favoriteTeamGoalEventKey(
          match.id,
          event,
        ),
        new Date().toISOString(),
      );
    }

    await saveFavoriteTeamNotificationState();

    console.log(
      `PREDICT FAVORITE PUSH LIVE: baseline ${match.id} creata con ${goals.length} gol già presenti`,
    );

    return;
  }

  let changed = false;

  for (
    const event
      of goals
  ) {
    const eventKey =
      favoriteTeamGoalEventKey(
        match.id,
        event,
      );

    if (
      favoriteTeamNotificationSentState.has(
        eventKey,
      )
    ) {
      continue;
    }

    const scoringTeamId =
      String(
        event?.team?.id ??
        '',
      );

    const scoringTeamName =
      event?.team?.name ??
      'Gol';

    const teams = [
      match?.homeTeam,
      match?.awayTeam,
    ];

    for (
      const favoriteTeam
        of teams
    ) {
      const favoriteTeamId =
        String(
          favoriteTeam?.id ??
          '',
        );

      if (
        !favoriteTeamId ||
        favoriteTeamSubscriptionsForTeam(
          favoriteTeamId,
          'goals',
        ).length === 0
      ) {
        continue;
      }

      const result =
        await sendFavoriteTeamLocalized({
          teamId:
            favoriteTeamId,
          notificationKey:
            'goals',
          type:
            'goal',
          context: {
            favoriteTeamName:
              favoriteTeam?.name ??
              'Squadra',
            homeTeamName:
              match?.homeTeam?.name ??
              'Casa',
            awayTeamName:
              match?.awayTeam?.name ??
              'Ospite',
            scoringTeamName,
            minute:
              String(
                event?.time ??
                '',
              ),
            player:
              String(
                event?.player ??
                '',
              ),
            assist:
              String(
                event?.assist ??
                '',
              ),
            scoredByFavorite:
              favoriteTeamId ===
              scoringTeamId,
          },
          data: {
            type:
              'favorite-goal',
            matchId:
              match.id,
            favoriteTeamId,
            scoringTeamId,
            minute:
              event?.time ??
              '',
            player:
              event?.player ??
              '',
            assist:
              event?.assist ??
              '',
          },
        });

      console.log(
        `PREDICT FAVORITE PUSH GOAL: ${scoringTeamName} ${event?.time ?? ''}' -> ${favoriteTeam?.name ?? favoriteTeamId}, inviati ${result.successCount}`,
      );
    }

    // Un evento Goal viene marcato una volta sola per partita.
    // Eventi "VAR Goal Confirmed" non entrano qui perché il filtro accetta
    // esclusivamente type === "Goal", evitando il doppione già osservato.
    favoriteTeamNotificationSentState.set(
      eventKey,
      new Date().toISOString(),
    );

    changed = true;
  }

  if (changed) {
    await saveFavoriteTeamNotificationState();
  }
}

async function favoriteTeamNotificationTick() {
  if (
    favoriteTeamNotificationSchedulerState.running
  ) {
    return;
  }

  favoriteTeamNotificationSchedulerState.running =
    true;

  try {
    await loadFavoriteTeamNotificationSubscriptions();
    await loadFavoriteTeamNotificationState();

    favoriteTeamNotificationSchedulerState.lastTickAt =
      new Date().toISOString();

    if (
      favoriteTeamNotificationSubscriptions.size === 0 ||
      !predictFirebaseMessaging
    ) {
      favoriteTeamNotificationSchedulerState.lastError =
        null;

      return;
    }

    const now =
      new Date();

    const nowMs =
      now.getTime();

    const relevant =
      centralDomesticEntries()
        .filter(
          (entry) => {
            const match =
              entry?.match;

            if (
              !favoriteTeamHasSubscribersForMatch(
                match,
              )
            ) {
              return false;
            }

            const startMs =
              Date.parse(
                match?.date ??
                '',
              );

            if (
              !Number.isFinite(
                startMs,
              )
            ) {
              return false;
            }

            return (
              nowMs >=
                startMs -
                  FAVORITE_TEAM_LINEUPS_WINDOW &&
              nowMs <=
                startMs +
                  FAVORITE_TEAM_POSTSTART_WINDOW
            );
          },
        );

    for (
      const entry
        of relevant
    ) {
      const match =
        entry.match;

      const startMs =
        Date.parse(
          match?.date ??
          '',
        );

      const baselineKey =
        `goal-baseline:${match.id}`;

      // Se il backend sta seguendo la gara già prima del calcio d'inizio,
      // la baseline viene inizializzata vuota. In questo modo il primo vero
      // Goal ricevuto durante il live genera la notifica.
      if (
        nowMs < startMs &&
        !favoriteTeamNotificationSentState.has(
          baselineKey,
        )
      ) {
        favoriteTeamNotificationSentState.set(
          baselineKey,
          new Date().toISOString(),
        );

        await saveFavoriteTeamNotificationState();
      }

      await favoriteTeamProcessLineups({
        match,
        nowMs,
        startMs,
      });

      await favoriteTeamProcessGoals({
        match,
        nowMs,
        startMs,
      });
    }

    favoriteTeamNotificationSchedulerState.lastError =
      null;
  } catch (error) {
    favoriteTeamNotificationSchedulerState.lastError =
      error?.message ??
      String(error);

    console.error(
      'PREDICT FAVORITE TEAM PUSH ERROR:',
      favoriteTeamNotificationSchedulerState.lastError,
    );
  } finally {
    favoriteTeamNotificationSchedulerState.running =
      false;
  }
}

async function startFavoriteTeamNotificationScheduler() {
  favoriteTeamNotificationSchedulerState.startedAt =
    new Date().toISOString();

  await loadFavoriteTeamNotificationSubscriptions();
  await loadFavoriteTeamNotificationState();

  await favoriteTeamNotificationTick();

  setInterval(
    favoriteTeamNotificationTick,
    FAVORITE_TEAM_NOTIFICATION_POLL_INTERVAL,
  );

  console.log(
    'PREDICT FAVORITE TEAM PUSH: scheduler attivo ogni 60 secondi',
  );
}

function rebuildCentralLeagueIndex(
  league,
) {
  const state =
    centralLeagueStateOf(
      league,
    );

  if (!state) {
    return;
  }

  const byDate =
    new Map();

  for (
    const match
      of state.matches
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

  state.byDate =
    byDate;
}

function rebuildCentralSerieAIndex() {
  rebuildCentralLeagueIndex(
    SUPPORTED_LEAGUES.serieA,
  );
}

function mergeCentralLeagueMatches(
  league,
  incoming,
) {
  const state =
    centralLeagueStateOf(
      league,
    );

  if (!state) {
    return;
  }

  const byId =
    new Map();

  for (
    const match
      of state.matches
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

  state.matches =
    Array.from(
      byId.values(),
    )
      .filter(
        (match) =>
          regularSeasonMatch(
            match,
          ),
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

  rebuildCentralLeagueIndex(
    league,
  );
}

function mergeCentralSerieAMatches(
  incoming,
) {
  mergeCentralLeagueMatches(
    SUPPORTED_LEAGUES.serieA,
    incoming,
  );
}

async function persistCentralSerieAState() {
  const leagueStates = {};

  for (
    const league
      of CENTRAL_DOMESTIC_LEAGUES
  ) {
    const state =
      centralLeagueStateOf(
        league,
      );

    leagueStates[league.key] = {
      matches:
        state?.matches ?? [],
      lastScheduleSyncAt:
        state?.lastScheduleSyncAt ??
        null,
      lastLiveSyncAt:
        state?.lastLiveSyncAt ??
        null,
    };
  }

  const shared = {
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

    schedulerStartedAt:
      centralSerieAState
        .schedulerStartedAt,
  };

  await setDiskCache(
    'central-domestic-state-v1',
    {
      leagueStates,
      ...shared,
    },
  );

  // Manteniamo anche il vecchio archivio Serie A per compatibilità
  // con eventuali cache già create da versioni precedenti.
  await setDiskCache(
    'central-serie-a-state-v2',
    {
      matches:
        centralSerieAState.matches,
      teamDataRevision:
        shared.teamDataRevision,
      processedFinishedMatchIds:
        shared.processedFinishedMatchIds,
      pendingStatisticsMatchIds:
        shared.pendingStatisticsMatchIds,
      lastScheduleSyncAt:
        centralSerieAState
          .lastScheduleSyncAt,
      lastLiveSyncAt:
        centralSerieAState
          .lastLiveSyncAt,
    },
  );
}

async function hydrateCentralLeagueFromRecentCache(
  league,
) {
  const state =
    centralLeagueStateOf(
      league,
    );

  if (
    !state ||
    state.matches.length > 0
  ) {
    return false;
  }

  const cacheKey = [
    'supported-league-season-v1',
    String(
      league.currentSeason,
    ),
    league.key,
  ].join('-');

  const cached =
    await getDiskCache(
      cacheKey,
      RECENT_CACHE_TIME,
    );

  if (!Array.isArray(cached)) {
    return false;
  }

  state.matches =
    uniqueMatches(
      cached,
    )
      .filter(
        (match) =>
          regularSeasonMatch(
            match,
          ),
      );

  state.lastScheduleSyncAt =
    new Date()
      .toISOString();

  rebuildCentralLeagueIndex(
    league,
  );

  return true;
}

async function restoreCentralSerieAState() {
  const disk =
    await getDiskCache(
      'central-domestic-state-v1',
      30 * 24 * 60 * 60 * 1000,
    );

  let restoredShared =
    false;

  if (
    disk &&
    disk.leagueStates &&
    typeof disk.leagueStates ===
      'object'
  ) {
    for (
      const league
        of CENTRAL_DOMESTIC_LEAGUES
    ) {
      const state =
        centralLeagueStateOf(
          league,
        );

      const saved =
        disk.leagueStates[
          league.key
        ];

      if (
        state &&
        Array.isArray(
          saved?.matches,
        )
      ) {
        state.matches =
          saved.matches;
        state.lastScheduleSyncAt =
          saved.lastScheduleSyncAt ??
          null;
        state.lastLiveSyncAt =
          saved.lastLiveSyncAt ??
          null;
      }
    }

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

    restoredShared =
      true;
  }

  if (!restoredShared) {
    const legacy =
      await getDiskCache(
        'central-serie-a-state-v2',
        30 * 24 * 60 * 60 * 1000,
      );

    if (
      legacy &&
      Array.isArray(
        legacy.matches,
      )
    ) {
      centralSerieAState.matches =
        legacy.matches;

      centralSerieAState.lastScheduleSyncAt =
        legacy.lastScheduleSyncAt ??
        null;

      centralSerieAState.lastLiveSyncAt =
        legacy.lastLiveSyncAt ??
        null;

      centralSerieAState.teamDataRevision =
        new Map(
          Object.entries(
            legacy.teamDataRevision ??
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
            legacy.processedFinishedMatchIds,
          )
            ? legacy
                .processedFinishedMatchIds
                .map(String)
            : [],
        );

      centralSerieAState.pendingStatisticsMatchIds =
        new Set(
          Array.isArray(
            legacy.pendingStatisticsMatchIds,
          )
            ? legacy
                .pendingStatisticsMatchIds
                .map(String)
            : [],
        );
    }
  }

  // Se una lega non ha ancora uno stato centrale, riusiamo una cache
  // recente già creata dall'app. Così il primo avvio evita richieste
  // Highlightly inutili quando i dati correnti sono già disponibili.
  for (
    const league
      of CENTRAL_DOMESTIC_LEAGUES
  ) {
    await hydrateCentralLeagueFromRecentCache(
      league,
    );

    rebuildCentralLeagueIndex(
      league,
    );
  }

  return centralDomesticEntries()
    .length > 0;
}

function centralLiveWindowActive(
  now = new Date(),
  league = null,
) {
  const nowMs =
    now.getTime();

  const states =
    league
      ? [
          centralLeagueStateOf(
            league,
          ),
        ]
      : CENTRAL_DOMESTIC_LEAGUES.map(
          (item) =>
            centralLeagueStateOf(
              item,
            ),
        );

  return states
    .filter(Boolean)
    .some(
      (state) =>
        state.matches.some(
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
        ),
    );
}

function isHighlightlyRateLimitError(
  error,
) {
  return (
    Number(
      error?.statusCode ??
        error?.status,
    ) === 429 ||
    String(
      error?.message ??
        error ?? '',
    ).includes('429')
  );
}

async function syncCentralLeagueSchedule(
  league,
  {
    force = false,
  } = {},
) {
  const state =
    centralLeagueStateOf(
      league,
    );

  if (!state) {
    return false;
  }

  const previous =
    Date.parse(
      state.lastScheduleSyncAt ??
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
    `PREDICT CENTRAL: sincronizzo calendario ${league.leagueName}`,
  );

  const matches =
    await fetchEntireLeagueSeason({
      season:
        league.currentSeason,
      leagueName:
        league.leagueName,
      countryName:
        league.countryName,
    });

  state.matches =
    uniqueMatches(
      matches,
    )
      .filter(
        (match) =>
          regularSeasonMatch(
            match,
          ),
      );

  state.lastScheduleSyncAt =
    new Date()
      .toISOString();

  rebuildCentralLeagueIndex(
    league,
  );

  console.log(
    `PREDICT CENTRAL: ${league.leagueName} aggiornata (${state.matches.length} partite)`,
  );

  return true;
}

async function syncCentralSerieASchedule({
  force = false,
} = {}) {
  let changed = false;

  for (
    const league
      of CENTRAL_DOMESTIC_LEAGUES
  ) {
    try {
      const leagueChanged =
        await syncCentralLeagueSchedule(
          league,
          {
            force,
          },
        );

      changed =
        leagueChanged ||
        changed;
    } catch (error) {
      console.warn(
        `PREDICT CENTRAL calendario ${league.leagueName} non aggiornato:`,
        error?.message ??
          error,
      );

      if (
        isHighlightlyRateLimitError(
          error,
        )
      ) {
        console.warn(
          'PREDICT CENTRAL: rate limit 429 rilevato, interrompo le sincronizzazioni calendario del ciclo.',
        );
        break;
      }
    }
  }

  if (changed) {
    await persistCentralSerieAState();
  }

  return changed;
}

async function syncCentralLeagueLive(
  league,
  {
    force = false,
  } = {},
) {
  const state =
    centralLeagueStateOf(
      league,
    );

  if (
    !state ||
    (
      !force &&
      !centralLiveWindowActive(
        new Date(),
        league,
      )
    )
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
    `PREDICT CENTRAL LIVE ${league.leagueName}: aggiorno ${today}`,
  );

  const data =
    await highlightlyGet(
      '/matches',
      {
        date:
          today,
        leagueName:
          league.leagueName,
        countryName:
          league.countryName,
        season:
          league.currentSeason,
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
    )
      .filter(
        (match) =>
          regularSeasonMatch(
            match,
          ),
      );

  mergeCentralLeagueMatches(
    league,
    matches,
  );

  state.lastLiveSyncAt =
    new Date()
      .toISOString();

  console.log(
    `PREDICT CENTRAL LIVE ${league.leagueName}: ${matches.length} partite aggiornate`,
  );

  return true;
}

async function syncCentralSerieALive({
  force = false,
} = {}) {
  let changed = false;

  for (
    const league
      of CENTRAL_DOMESTIC_LEAGUES
  ) {
    if (
      !force &&
      !centralLiveWindowActive(
        new Date(),
        league,
      )
    ) {
      continue;
    }

    try {
      const leagueChanged =
        await syncCentralLeagueLive(
          league,
          {
            force,
          },
        );

      changed =
        leagueChanged ||
        changed;
    } catch (error) {
      console.warn(
        `PREDICT CENTRAL LIVE ${league.leagueName} non aggiornato:`,
        error?.message ??
          error,
      );

      if (
        isHighlightlyRateLimitError(
          error,
        )
      ) {
        console.warn(
          'PREDICT CENTRAL LIVE: rate limit 429 rilevato, interrompo gli aggiornamenti live del ciclo.',
        );
        break;
      }
    }
  }

  if (changed) {
    await persistCentralSerieAState();
  }

  return changed;
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
      centralDomesticEntries()
        .filter(
          ({ match }) => {
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
              a.match?.date ?? '',
            ) -
            Date.parse(
              b.match?.date ?? '',
            ),
        );

    if (
      upcoming.length === 0
    ) {
      return;
    }

    // Massimo 5 partite mancanti per ciclo su tutti i cinque
    // campionati, con concorrenza 2 per proteggere la quota API.
    const pendingMatches = [];

    for (
      const entry
        of upcoming
    ) {
      const {
        match,
        league,
      } = entry;

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
            league.historicalSeason,
          leagueName:
            league.leagueName,
          countryName:
            league.countryName,
          // Deve coincidere esattamente con la chiave usata da /match-analysis.
          // La vecchia variante 10/90 faceva risultare l'analisi sempre mancante
          // e poteva rigenerarla inutilmente ogni 30 minuti.
          cacheVariant:
            [
              bookmakerOnlyModeForRound(
                roundNumberOf(match),
              )
                ? `predict95-bookmaker5-nullfix-analysisstats-v4-r${BOOKMAKER_ONLY_FROM_ROUND}plus`
                : null,
              'hist2020to2025-allfamilies-v1',
            ]
              .filter(Boolean)
              .join('-') ||
            null,
          cacheTtl:
            analysisPrecomputeTtl,
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
            league.historicalSeason,
          leagueName:
            league.leagueName,
          countryName:
            league.countryName,
        });

      if (
        existingAnalysis &&
        existingSnapshot?.pick
      ) {
        continue;
      }

      pendingMatches.push({
        ...entry,
        homeTeamId,
        awayTeamId,
        needsAnalysis:
          !existingAnalysis,
        needsSnapshot:
          !existingSnapshot?.pick,
      });

      if (
        pendingMatches.length >= 5
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
      new Map();

    await mapWithConcurrency(
      pendingMatches,
      2,
      async (item) => {
        const {
          match,
          league,
          homeTeamId,
          awayTeamId,
          needsAnalysis,
          needsSnapshot,
        } = item;

        if (needsAnalysis) {
          console.log(
            `PREDICT CENTRAL ${league.leagueName}: preparo analisi (${homeTeamId}-${awayTeamId})`,
          );

          try {
            await internalMatchAnalysis({
              homeTeamId,
              awayTeamId,
              matchId:
                match?.id,
              historicalSeason:
                league.historicalSeason,
              leagueName:
                league.leagueName,
              countryName:
                league.countryName,
            });
          } catch (error) {
            console.warn(
              `Precompute analisi ${league.leagueName} ${homeTeamId}-${awayTeamId} non riuscito:`,
              error?.message ??
                error,
            );

            return false;
          }
        }

        if (needsSnapshot) {
          console.log(
            `PREDICT CENTRAL ${league.leagueName}: preparo pronostico (${homeTeamId}-${awayTeamId})`,
          );

          try {
            await getOrCreateMatchdayPickSnapshot({
              match,
              homeTeamId,
              awayTeamId,
              historicalSeason:
                league.historicalSeason,
              leagueName:
                league.leagueName,
              countryName:
                league.countryName,
            });
          } catch (error) {
            console.warn(
              `Precompute pronostico ${league.leagueName} ${homeTeamId}-${awayTeamId} non riuscito:`,
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
          affectedRounds.set(
            `${league.key}:${roundNumber}`,
            {
              league,
              roundNumber:
                Number(roundNumber),
            },
          );
        }

        return true;
      },
    );

    for (
      const {
        league,
        roundNumber,
      } of affectedRounds.values()
    ) {
      const aggregatePrefix =
        league.key === 'serie-a'
          ? matchdayPicksAggregatePrefixForRound(
              roundNumber,
            )
          : `${matchdayPicksAggregatePrefixForRound(
              roundNumber,
            )}-real-results-v1`;

      await deleteCacheKey(
        [
          aggregatePrefix,
          league.currentSeason,
          league.historicalSeason,
          roundNumber,
          league.leagueName,
          league.countryName,
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
  league = null,
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

    await deleteCacheKey(
      `last-five-${teamId}`,
    );
  }

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
    `PREDICT DYNAMIC REFRESH ${league?.leagueName ?? ''}: risultato ${matchKey} acquisito; revisioni ${homeTeamId ?? '-'}=${teamDataRevisionOf(homeTeamId)}, ${awayTeamId ?? '-'}=${teamDataRevisionOf(awayTeamId)}`,
  );

  return true;
}

async function settleCentralFinishedMatches() {
  const pendingFinished =
    centralDomesticEntries()
      .filter(
        ({ match }) => {
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
            a.match?.date ?? '',
          ) -
          Date.parse(
            b.match?.date ?? '',
          ),
      )
      .slice(0, 5);

  if (
    pendingFinished.length === 0
  ) {
    return false;
  }

  const refreshed =
    await mapWithConcurrency(
      pendingFinished,
      2,
      async ({
        match,
        league,
      }) =>
        refreshDynamicDataAfterFinishedMatch(
          match,
          league,
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
    pendingIds.length === 0
  ) {
    return false;
  }

  let changed = false;

  for (
    const matchId
      of pendingIds
  ) {
    const entry =
      centralFindMatchEntryById(
        matchId,
      );

    if (!entry) {
      centralSerieAState
        .pendingStatisticsMatchIds
        .delete(
          String(matchId),
        );
      changed = true;
      continue;
    }

    const {
      match,
      league,
    } = entry;

    let statistics = null;

    try {
      statistics =
        await getHistoricalMatchStatistics(
          matchId,
        );
    } catch (error) {
      console.warn(
        `Retry statistiche ${league.leagueName} ${matchId} non riuscito:`,
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
      `PREDICT ADVANCED REFRESH ${league.leagueName}: statistiche finali ${matchId} disponibili; rigenero analisi future`,
    );

    changed = true;
  }

  if (changed) {
    await persistCentralSerieAState();
  }

  return changed;
}

async function archivePermanentAnalysisHistoryForFrozenMatches() {
  const frozenEntries =
    centralDomesticEntries()
      .filter(
        ({ match }) => {
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
    frozenEntries.length === 0
  ) {
    return false;
  }

  const archived =
    await mapWithConcurrency(
      frozenEntries,
      2,
      async ({
        match,
        league,
      }) => {
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
                league.historicalSeason,
              leagueName:
                league.leagueName,
              countryName:
                league.countryName,
            });

          if (
            existing?.analysis
          ) {
            return false;
          }

          const cacheVariant =
            [
              bookmakerOnlyModeForRound(
                roundNumberOf(match),
              )
                ? `predict95-bookmaker5-nullfix-analysisstats-v4-r${BOOKMAKER_ONLY_FROM_ROUND}plus`
                : null,
              'hist2020to2025-allfamilies-v1',
            ]
              .filter(Boolean)
              .join('-') ||
            null;

          const analysis =
            await getExistingMatchAnalysisSnapshot({
              homeTeamId,
              awayTeamId,
              historicalSeason:
                league.historicalSeason,
              leagueName:
                league.leagueName,
              countryName:
                league.countryName,
              cacheVariant,
            });

          if (!analysis) {
            return false;
          }

          await persistPermanentMatchAnalysis({
            homeTeamId,
            awayTeamId,
            historicalSeason:
              league.historicalSeason,
            leagueName:
              league.leagueName,
            countryName:
              league.countryName,
            analysis,
            sourceKey:
              buildMatchAnalysisCacheKey({
                homeTeamId,
                awayTeamId,
                historicalSeason:
                  league.historicalSeason,
                leagueName:
                  league.leagueName,
                countryName:
                  league.countryName,
                cacheVariant,
              }),
          });

          return true;
        } catch (error) {
          console.warn(
            `PREDICT HISTORY ${league.leagueName}: archivio analisi non riuscito per ${match?.id}:`,
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
  const finishedEntries =
    centralDomesticEntries()
      .filter(
        ({ match }) =>
          isFinishedMatch(
            match,
          ) &&
          Boolean(
            parseScore(
              match,
            ),
          ),
      );

  if (
    finishedEntries.length === 0
  ) {
    return false;
  }

  const outcomes =
    await mapWithConcurrency(
      finishedEntries,
      2,
      async ({
        match,
        league,
      }) => {
        try {
          const snapshot =
            await getExistingMatchdayPickSnapshot({
              matchId:
                match?.id,
              historicalSeason:
                league.historicalSeason,
              leagueName:
                league.leagueName,
              countryName:
                league.countryName,
            });

          if (!snapshot?.pick) {
            return {
              settled: false,
              queuedStatistics: false,
            };
          }

          const before =
            await getPermanentMatchdayPickRecord({
              matchId:
                match?.id,
              historicalSeason:
                league.historicalSeason,
              leagueName:
                league.leagueName,
              countryName:
                league.countryName,
            });

          if (
            before
              ?.result
              ?.settled
          ) {
            return {
              settled: false,
              queuedStatistics: false,
            };
          }

          const result =
            await getOrPersistMatchdayPickResult({
              match,
              snapshot,
              historicalSeason:
                league.historicalSeason,
              leagueName:
                league.leagueName,
              countryName:
                league.countryName,
              allowProvider:
                false,
            });

          let queuedStatistics =
            false;

          // Se un Top Signal avanzato non puo essere verificato perche le
          // statistiche finali non sono ancora nella cache PREDICT, lo
          // rimettiamo nella stessa coda di retry usata dal ciclo centrale.
          // Il provider NON viene chiamato qui: retryPendingCurrentStatistics()
          // fara al massimo i tentativi previsti e continuera a rispettare la
          // cache dei 404 temporanei. In questo modo uno storico rimasto fuori
          // dalla coda (per riavvio o acquisizione incompleta a fine match)
          // viene recuperato automaticamente senza aumentare le chiamate.
          if (
            result?.settled !== true &&
            result?.message ===
              'Statistiche finali non disponibili' &&
            [
              'Corner',
              'Tiri in porta',
              'Cartellini',
            ].includes(
              snapshot?.pick?.market,
            )
          ) {
            const matchKey =
              String(
                match?.id ?? '',
              );

            if (
              matchKey &&
              !centralSerieAState
                .pendingStatisticsMatchIds
                .has(matchKey)
            ) {
              centralSerieAState
                .pendingStatisticsMatchIds
                .add(matchKey);

              queuedStatistics =
                true;

              console.log(
                `PREDICT HISTORY ${league.leagueName}: statistiche finali ${matchKey} mancanti in cache; aggiunto alla coda retry`,
              );
            }
          }

          return {
            settled:
              Boolean(
                result?.settled,
              ),
            queuedStatistics,
          };
        } catch (error) {
          console.warn(
            `PREDICT HISTORY ${league.leagueName}: settlement non riuscito per ${match?.id}:`,
            error?.message ??
              error,
          );

          return {
            settled: false,
            queuedStatistics: false,
          };
        }
      },
    );

  const queuedStatistics =
    outcomes.some(
      (outcome) =>
        outcome?.queuedStatistics ===
          true,
    );

  if (queuedStatistics) {
    await persistCentralSerieAState();
  }

  return outcomes.some(
    (outcome) =>
      outcome?.settled === true ||
      outcome?.queuedStatistics ===
        true,
  );
}

let centralStandingsSyncRunning = false;

async function syncCentralOfficialStandings() {
  if (centralStandingsSyncRunning) {
    return false;
  }

  centralStandingsSyncRunning = true;

  try {
    let completed = 0;

    for (
      const league
        of CENTRAL_DOMESTIC_LEAGUES
    ) {
      if (
        league?.supportsStandings ===
        false
      ) {
        continue;
      }

      try {
        const params =
          new URLSearchParams({
            season:
              String(
                league.currentSeason,
              ),
            leagueName:
              String(
                league.leagueName,
              ),
            countryName:
              String(
                league.countryName,
              ),
            refresh:
              '0',
          });

        const response =
          await fetch(
            `http://127.0.0.1:${PORT}/api/football/standings?${params.toString()}`,
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

          console.warn(
            `PREDICT CENTRAL CLASSIFICA ${league.leagueName}: ${response.status} ${body}`,
          );

          if (response.status === 429) {
            break;
          }

          continue;
        }

        completed += 1;
      } catch (error) {
        console.warn(
          `PREDICT CENTRAL CLASSIFICA ${league.leagueName} non aggiornata:`,
          error?.message ??
            error,
        );
      }
    }

    return completed > 0;
  } finally {
    centralStandingsSyncRunning = false;
  }
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

    // La classifica viene mantenuta dal backend: il pulsante dell'app
    // non deve mai provocare una chiamata Highlightly.
    await syncCentralOfficialStandings();

    const finishedDataChanged =
      await settleCentralFinishedMatches();

    const advancedStatisticsChanged =
      await retryPendingCurrentStatistics();

    const persistentHistoryChanged =
      await settlePermanentPickHistoryForFinishedMatches();

    if (
      scheduleChanged ||
      liveUpdated ||
      finishedDataChanged ||
      advancedStatisticsChanged ||
      persistentHistoryChanged ||
      centralDomesticEntries().length > 0
    ) {
      await precomputeUpcomingPredictData();
      await precomputeUpcomingMatchdayMultiples();

      // Ogni campionato nazionale mantiene un proprio archivio multiple.
      for (
        const league
          of CENTRAL_DOMESTIC_LEAGUES
      ) {
        await settlePermanentMultipleHistory({
          season:
            league.currentSeason,
          historicalSeason:
            league.historicalSeason,
          leagueName:
            league.leagueName,
          countryName:
            league.countryName,
          allowProvider:
            false,
        });
      }

      // Anche le Multiple Internazionali 3X/5X vengono mantenute dal server.
      // Solo cache PREDICT: nessuna chiamata provider aggiuntiva.
      await settlePermanentInternationalMultipleHistory({
        season:
          CURRENT_SERIE_A_SEASON,
        historicalSeason:
          '2025',
      });

      await archivePermanentAnalysisHistoryForFrozenMatches();
    }

    centralSerieAState.lastError =
      null;
  } catch (error) {
    centralSerieAState.lastError =
      error?.message ??
      String(error);

    console.error(
      'PREDICT CENTRAL 5 LEGHE ERROR:',
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

  await centralSerieATick();

  setInterval(
    centralSerieATick,
    CENTRAL_SERIE_A_LIVE_INTERVAL,
  );

  console.log(
    'PREDICT CENTRAL: scheduler 5 campionati attivo ogni 15 minuti',
  );
}

app.get(
  '/api/football/highlightly-budget',
  async (req, res) => {
    try {
      await ensureHighlightlyDailyBudgetLoaded();

      res.json({
        ok: true,
        highlightlyBudget:
          getHighlightlyDailyBudgetSnapshot(),
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
  '/api/football/sync-status',
  (req, res) => {
    res.json({
      ok: true,

      backgroundJobsEnabled:
        PREDICT_BACKGROUND_JOBS_ENABLED,

      providerAccessPolicy: {
        publicHttpProviderCallsAllowed:
          false,
        internalSchedulerOnly:
          true,
        guard:
          'AsyncLocalStorage request barrier',
      },

      centralStandingsSyncRunning,

      uefa: {
        precomputeRunning:
          centralUefaPrecomputeRunning,
        predictionHorizonHours:
          CENTRAL_UEFA_PREDICTION_HORIZON /
          (60 * 60 * 1000),
        maxNewPicksPerTick:
          CENTRAL_UEFA_PRECOMPUTE_MAX_PER_TICK,
        competitions:
          Object.fromEntries(
            CENTRAL_UEFA_CUPS.map(
              (competition) => {
                const state =
                  centralUefaCupStateOf(
                    competition,
                  );

                return [
                  competition.key,
                  {
                    leagueName:
                      competition.leagueName,
                    matchesCached:
                      state?.matches.length ??
                      0,
                    lastScheduleSyncAt:
                      state?.lastScheduleSyncAt ??
                      null,
                    lastLiveSyncAt:
                      state?.lastLiveSyncAt ??
                      null,
                  },
                ];
              },
            ),
          ),
      },

      highlightlyBudget:
        getHighlightlyDailyBudgetSnapshot(),

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

      leagues:
        Object.fromEntries(
          CENTRAL_DOMESTIC_LEAGUES.map(
            (league) => {
              const state =
                centralLeagueStateOf(
                  league,
                );

              return [
                league.key,
                {
                  leagueName:
                    league.leagueName,
                  countryName:
                    league.countryName,
                  matchesCached:
                    state?.matches.length ??
                    0,
                  lastScheduleSyncAt:
                    state?.lastScheduleSyncAt ??
                    null,
                  lastLiveSyncAt:
                    state?.lastLiveSyncAt ??
                    null,
                  liveWindowActive:
                    centralLiveWindowActive(
                      new Date(),
                      league,
                    ),
                },
              ];
            },
          ),
        ),
    });
  },
);

// ====================================================
// PARTITE LIVE — CACHE CENTRALE CONDIVISA
// ====================================================


const CUP_LIVE_SCHEDULE_CACHE_TIME =
  15 * 60 * 1000;

function liveRomeDateKey(
  value = new Date(),
) {
  const parsed =
    value instanceof Date
      ? value
      : new Date(value);

  if (
    Number.isNaN(
      parsed.getTime(),
    )
  ) {
    return null;
  }

  const parts =
    new Intl.DateTimeFormat(
      'en-GB',
      {
        timeZone:
          'Europe/Rome',
        year:
          'numeric',
        month:
          '2-digit',
        day:
          '2-digit',
      },
    ).formatToParts(
      parsed,
    );

  const values =
    Object.fromEntries(
      parts.map(
        (part) => [
          part.type,
          part.value,
        ],
      ),
    );

  return (
    `${values.year}-` +
    `${values.month}-` +
    `${values.day}`
  );
}

function cupHasPossibleLiveWindow(
  matches,
  now = new Date(),
) {
  const nowMs =
    now.getTime();

  return (
    matches ?? []
  ).some(
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

      return (
        startMs - nowMs <=
          30 * 60 * 1000 &&
        nowMs - startMs <=
          CENTRAL_SERIE_A_POSTSTART_WINDOW
      );
    },
  );
}

function canonicalCupLiveMatch(
  match,
  competition,
  now = new Date(),
) {
  return {
    ...match,
    league: {
      ...(
        match?.league ?? {}
      ),
      name:
        competition.leagueName,
      country:
        competition.countryName,
    },
    predictLive: {
      leagueKey:
        competition.key,
      leagueName:
        competition.leagueName,
      countryName:
        competition.countryName,
      lastLiveSyncAt:
        now.toISOString(),
    },
  };
}

const CENTRAL_UEFA_SCHEDULE_INTERVAL =
  6 * 60 * 60 * 1000;

const CENTRAL_UEFA_TICK_INTERVAL =
  15 * 60 * 1000;

// I pronostici UEFA vengono preparati centralmente con anticipo controllato.
// Due nuovi match per ciclo evitano picchi di quota e sono sufficienti perché
// il calendario UEFA è noto con largo anticipo.
const CENTRAL_UEFA_PREDICTION_HORIZON =
  3 * 24 * 60 * 60 * 1000;
const CENTRAL_UEFA_PRECOMPUTE_MAX_PER_TICK = 2;
const CENTRAL_UEFA_PRECOMPUTE_MIN_REMAINING = 1200;

const CENTRAL_SHARED_LIVE_INTERVAL =
  LIVE_MATCHES_CACHE_TIME;

const CENTRAL_UEFA_CUPS =
  Object.freeze(
    SUPPORTED_LEAGUE_LIST.filter(
      (item) =>
        item?.isCup === true,
    ),
  );

const centralUefaCupStates =
  new Map(
    CENTRAL_UEFA_CUPS.map(
      (competition) => [
        competition.key,
        {
          matches: [],
          byDate: new Map(),
          lastScheduleSyncAt: null,
          lastLiveSyncAt: null,
        },
      ],
    ),
  );

let centralUefaScheduleRunning =
  false;

let centralUefaPrecomputeRunning =
  false;

let centralSharedLiveRunning =
  false;

function centralUefaCupStateOf(
  competitionOrKey,
) {
  const key =
    typeof competitionOrKey === 'string'
      ? competitionOrKey
      : competitionOrKey?.key;

  return (
    centralUefaCupStates.get(
      String(key ?? ''),
    ) ??
    null
  );
}

function centralUefaEntries() {
  const entries = [];

  for (
    const competition
      of CENTRAL_UEFA_CUPS
  ) {
    const state =
      centralUefaCupStateOf(
        competition,
      );

    for (
      const match
        of state?.matches ?? []
    ) {
      entries.push({
        competition,
        state,
        match,
      });
    }
  }

  return entries;
}

function rebuildCentralUefaCupIndex(
  competition,
) {
  const state =
    centralUefaCupStateOf(
      competition,
    );

  if (!state) {
    return;
  }

  const byDate =
    new Map();

  for (
    const match
      of state.matches
  ) {
    const dateKey =
      liveRomeDateKey(
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

  state.byDate =
    byDate;
}

function mergeCentralUefaCupMatches(
  competition,
  incoming,
) {
  const state =
    centralUefaCupStateOf(
      competition,
    );

  if (!state) {
    return;
  }

  const byId =
    new Map();

  for (
    const match
      of state.matches
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

  state.matches =
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

  rebuildCentralUefaCupIndex(
    competition,
  );
}

async function persistCentralUefaCupState() {
  const competitions = {};

  for (
    const competition
      of CENTRAL_UEFA_CUPS
  ) {
    const state =
      centralUefaCupStateOf(
        competition,
      );

    competitions[
      competition.key
    ] = {
      matches:
        state?.matches ?? [],
      lastScheduleSyncAt:
        state?.lastScheduleSyncAt ??
        null,
      lastLiveSyncAt:
        state?.lastLiveSyncAt ??
        null,
    };
  }

  await setDiskCache(
    'central-uefa-cups-state-v1',
    {
      competitions,
      savedAt:
        new Date()
          .toISOString(),
    },
  );
}

async function restoreCentralUefaCupState() {
  const disk =
    await getDiskCache(
      'central-uefa-cups-state-v1',
      30 * 24 * 60 * 60 * 1000,
    );

  if (
    !disk?.competitions ||
    typeof disk.competitions !==
      'object'
  ) {
    return false;
  }

  let restored =
    false;

  for (
    const competition
      of CENTRAL_UEFA_CUPS
  ) {
    const state =
      centralUefaCupStateOf(
        competition,
      );

    const saved =
      disk.competitions[
        competition.key
      ];

    if (
      !state ||
      !Array.isArray(
        saved?.matches,
      )
    ) {
      continue;
    }

    state.matches =
      saved.matches;

    state.lastScheduleSyncAt =
      saved.lastScheduleSyncAt ??
      null;

    state.lastLiveSyncAt =
      saved.lastLiveSyncAt ??
      null;

    rebuildCentralUefaCupIndex(
      competition,
    );

    restored =
      restored ||
      state.matches.length > 0;
  }

  return restored;
}

async function syncCentralUefaCupSchedule(
  competition,
  {
    force = false,
  } = {},
) {
  const state =
    centralUefaCupStateOf(
      competition,
    );

  if (!state) {
    return false;
  }

  const previous =
    Date.parse(
      state.lastScheduleSyncAt ??
        '',
    );

  if (
    !force &&
    Number.isFinite(
      previous,
    ) &&
    Date.now() - previous <
      CENTRAL_UEFA_SCHEDULE_INTERVAL
  ) {
    return false;
  }

  console.log(
    `PREDICT CENTRAL UEFA: sincronizzo calendario ${competition.leagueName}`,
  );

  const matches =
    await fetchEntireLeagueSeason({
      season:
        competition.currentSeason,
      leagueName:
        competition.leagueName,
      countryName:
        competition.countryName,
    });

  state.matches =
    uniqueMatches(
      matches,
    ).sort(
      (a, b) =>
        Date.parse(
          a?.date ?? '',
        ) -
        Date.parse(
          b?.date ?? '',
        ),
    );

  state.lastScheduleSyncAt =
    new Date()
      .toISOString();

  rebuildCentralUefaCupIndex(
    competition,
  );

  console.log(
    `PREDICT CENTRAL UEFA: ${competition.leagueName} aggiornata (${state.matches.length} partite)`,
  );

  return true;
}

async function syncCentralUefaSchedules({
  force = false,
} = {}) {
  let changed =
    false;

  for (
    const competition
      of CENTRAL_UEFA_CUPS
  ) {
    try {
      const competitionChanged =
        await syncCentralUefaCupSchedule(
          competition,
          {
            force,
          },
        );

      changed =
        competitionChanged ||
        changed;
    } catch (error) {
      console.warn(
        `PREDICT CENTRAL UEFA calendario ${competition.leagueName} non aggiornato:`,
        error?.message ??
          error,
      );

      if (
        isHighlightlyRateLimitError(
          error,
        )
      ) {
        console.warn(
          'PREDICT CENTRAL UEFA: rate limit 429 rilevato, interrompo il ciclo calendario.',
        );
        break;
      }
    }
  }

  if (changed) {
    await persistCentralUefaCupState();
  }

  return changed;
}

function buildCentralUefaLiveMatches(
  now = new Date(),
) {
  const matches = [];

  for (
    const competition
      of CENTRAL_UEFA_CUPS
  ) {
    const state =
      centralUefaCupStateOf(
        competition,
      );

    for (
      const match
        of state?.matches ?? []
    ) {
      if (
        centralMatchIsLiveNow(
          match,
          now,
        )
      ) {
        matches.push(
          canonicalCupLiveMatch(
            match,
            competition,
            now,
          ),
        );
      }
    }
  }

  return matches;
}

async function syncCentralUefaLive(
  now = new Date(),
) {
  const today =
    liveRomeDateKey(
      now,
    );

  if (!today) {
    return false;
  }

  let changed =
    false;

  for (
    const competition
      of CENTRAL_UEFA_CUPS
  ) {
    const state =
      centralUefaCupStateOf(
        competition,
      );

    const scheduledToday =
      state?.byDate
        ?.get(
          today,
        ) ??
      [];

    if (
      !state ||
      !cupHasPossibleLiveWindow(
        scheduledToday,
        now,
      )
    ) {
      continue;
    }

    const providerLeagueName =
      competition
        .providerLeagueNames?.[0] ??
      competition.leagueName;

    try {
      console.log(
        `PREDICT CENTRAL UEFA LIVE ${competition.leagueName}: aggiorno ${today}`,
      );

      const data =
        await highlightlyGet(
          '/matches',
          {
            date:
              today,
            leagueName:
              providerLeagueName,
            countryName:
              providerCountryNameOf(
                competition,
              ),
            season:
              competition.currentSeason,
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

      mergeCentralUefaCupMatches(
        competition,
        matches,
      );

      state.lastLiveSyncAt =
        new Date()
          .toISOString();

      changed =
        true;

      console.log(
        `PREDICT CENTRAL UEFA LIVE ${competition.leagueName}: ${matches.length} partite aggiornate`,
      );
    } catch (error) {
      console.warn(
        `PREDICT CENTRAL UEFA LIVE ${competition.leagueName} non aggiornato:`,
        error?.message ??
          error,
      );

      if (
        isHighlightlyRateLimitError(
          error,
        )
      ) {
        console.warn(
          'PREDICT CENTRAL UEFA LIVE: rate limit 429 rilevato, interrompo il ciclo live.',
        );
        break;
      }
    }
  }

  if (changed) {
    await persistCentralUefaCupState();
  }

  return changed;
}

function buildMergedCentralLivePayload(
  now = new Date(),
) {
  const domesticPayload =
    buildCentralLiveMatchesPayload(
      now,
    );

  const cupLiveMatches =
    buildCentralUefaLiveMatches(
      now,
    );

  const mergedLiveMatches =
    [
      ...(
        Array.isArray(
          domesticPayload?.data,
        )
          ? domesticPayload.data
          : []
      ),
      ...cupLiveMatches,
    ]
      .filter(
        (match, index, items) =>
          items.findIndex(
            (candidate) =>
              String(
                candidate?.id ??
                '',
              ) ===
              String(
                match?.id ??
                '',
              ),
          ) === index,
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

  return {
    ...domesticPayload,
    data:
      mergedLiveMatches,
    providerCallsAllowed:
      false,
  };
}

async function refreshCentralSharedLiveCache() {
  const now =
    new Date();

  try {
    if (
      centralLiveWindowActive(
        now,
      )
    ) {
      await syncCentralSerieALive();
    }
  } catch (error) {
    console.warn(
      'PREDICT CENTRAL LIVE 5 LEGHE: refresh non riuscito:',
      error?.message ??
        error,
    );
  }

  try {
    await syncCentralUefaLive(
      now,
    );
  } catch (error) {
    console.warn(
      'PREDICT CENTRAL UEFA LIVE: refresh non riuscito:',
      error?.message ??
        error,
    );
  }

  const payload =
    buildMergedCentralLivePayload(
      now,
    );

  const cacheKey =
    'predict-central-live-matches-v2-cups';

  setMemoryCache(
    cacheKey,
    payload,
  );

  await setDiskCache(
    cacheKey,
    payload,
  );

  return payload;
}

async function precomputeUpcomingUefaPredictData() {
  if (centralUefaPrecomputeRunning) {
    return false;
  }

  centralUefaPrecomputeRunning = true;

  try {
    await ensureHighlightlyDailyBudgetLoaded();

    const initialBudget =
      getHighlightlyDailyBudgetSnapshot();

    if (
      initialBudget.internalRemaining <=
      CENTRAL_UEFA_PRECOMPUTE_MIN_REMAINING
    ) {
      console.warn(
        `PREDICT CENTRAL UEFA PRECOMPUTE: sospeso, restano ${initialBudget.internalRemaining} chiamate interne`,
      );
      return false;
    }

    const now = Date.now();

    const upcoming =
      centralUefaEntries()
        .filter(
          ({ match }) => {
            const startMs =
              Date.parse(
                match?.date ?? '',
              );

            return (
              Number.isFinite(startMs) &&
              startMs > now &&
              startMs - now <=
                CENTRAL_UEFA_PREDICTION_HORIZON
            );
          },
        )
        .sort(
          (a, b) =>
            Date.parse(
              a.match?.date ?? '',
            ) -
            Date.parse(
              b.match?.date ?? '',
            ),
        );

    // Limitiamo il numero di PARTITE lavorate per ciclo, non soltanto
    // quelle concluse con successo. In questo modo anche un provider
    // temporaneamente incompleto non può trasformare il precompute in
    // una raffica di richieste nello stesso tick.
    let processed = 0;
    let completed = 0;

    // Deve essere identica alla variante ufficiale usata dalla route
    // /api/football/match-analysis per Champions/Europa/Conference.
    const uefaAnalysisCacheVariant =
      'uefa-predict5-bookmaker95-analysisstats-v3-fullvenuehistory';

    for (const entry of upcoming) {
      if (
        processed >=
        CENTRAL_UEFA_PRECOMPUTE_MAX_PER_TICK
      ) {
        break;
      }

      const {
        competition,
        match,
      } = entry;

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

      const existingSnapshot =
        await getExistingMatchdayPickSnapshot({
          match,
          matchId:
            match?.id,
          historicalSeason:
            competition.historicalSeason,
          leagueName:
            competition.leagueName,
          countryName:
            competition.countryName,
        });

      // Il pronostico e l'analisi sono due cache diverse. Un pick già
      // esistente NON deve far saltare il controllo dell'analisi:
      // altrimenti la pagina Analisi può restare 503 per sempre dopo
      // che il pubblico è stato correttamente reso cache-only.
      const existingAnalysis =
        await getExistingMatchAnalysisSnapshot({
          homeTeamId,
          awayTeamId,
          historicalSeason:
            competition.historicalSeason,
          leagueName:
            competition.leagueName,
          countryName:
            competition.countryName,
          cacheVariant:
            uefaAnalysisCacheVariant,
          cacheTtl:
            PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
          allowPermanent:
            false,
          allowLegacy:
            false,
        });

      const existingPrediction =
        existingAnalysis?.prediction ??
        {};

      const existingTopSignals =
        Array.isArray(
          existingPrediction.topSignals,
        )
          ? existingPrediction.topSignals
          : [];

      const existingCoreMarketsMissing =
        [
          existingPrediction?.oneXTwo?.home,
          existingPrediction?.oneXTwo?.draw,
          existingPrediction?.oneXTwo?.away,
          existingPrediction?.goals?.gg,
          existingPrediction?.goals?.noGoal,
          existingPrediction?.goals?.over25,
          existingPrediction?.goals?.under25,
        ].every(
          (value) =>
            value === null ||
            value === undefined,
        );

      const needsUefaFallbackRefresh =
        Boolean(existingAnalysis) &&
        existingPrediction.bookmakerFallback !== true &&
        existingTopSignals.length === 0 &&
        existingCoreMarketsMissing;

      const needsAnalysis =
        !existingAnalysis ||
        needsUefaFallbackRefresh;
      const needsSnapshot =
        !existingSnapshot?.pick;

      if (
        !needsAnalysis &&
        !needsSnapshot
      ) {
        continue;
      }

      const budget =
        getHighlightlyDailyBudgetSnapshot();

      if (
        budget.internalRemaining <=
        CENTRAL_UEFA_PRECOMPUTE_MIN_REMAINING
      ) {
        console.warn(
          `PREDICT CENTRAL UEFA PRECOMPUTE: stop prudenziale, restano ${budget.internalRemaining} chiamate interne`,
        );
        break;
      }

      processed += 1;

      try {
        if (needsUefaFallbackRefresh) {
          const staleAnalysisKey =
            buildMatchAnalysisCacheKey({
              homeTeamId,
              awayTeamId,
              historicalSeason:
                competition.historicalSeason,
              leagueName:
                competition.leagueName,
              countryName:
                competition.countryName,
              cacheVariant:
                uefaAnalysisCacheVariant,
            });

          await deleteCacheKey(
            staleAnalysisKey,
          );

          console.log(
            `PREDICT CENTRAL UEFA ${competition.leagueName}: rigenero analisi senza mercati bookmaker ${match?.id ?? ''}`,
          );
        }

        let snapshot =
          existingSnapshot;

        if (needsSnapshot) {
          console.log(
            `PREDICT CENTRAL UEFA ${competition.leagueName}: preparo analisi/pronostico ${match?.id ?? ''} (${homeTeamId}-${awayTeamId})`,
          );

          // Questa funzione genera prima l'analisi completa e poi il pick.
          // Se l'analisi era già presente, la route interna la rilegge dalla
          // cache senza nuove chiamate provider.
          snapshot =
            await getOrCreateMatchdayPickSnapshot({
              match,
              homeTeamId,
              awayTeamId,
              historicalSeason:
                competition.historicalSeason,
              leagueName:
                competition.leagueName,
              countryName:
                competition.countryName,
            });
        } else if (needsAnalysis) {
          console.log(
            `PREDICT CENTRAL UEFA ${competition.leagueName}: preparo analisi ${match?.id ?? ''} (${homeTeamId}-${awayTeamId})`,
          );

          // Caso importante: il pick può esistere già mentre la cache
          // dell'analisi ufficiale manca. Prima questo caso veniva saltato.
          await internalMatchAnalysis({
            homeTeamId,
            awayTeamId,
            matchId:
              match?.id,
            historicalSeason:
              competition.historicalSeason,
            leagueName:
              competition.leagueName,
            countryName:
              competition.countryName,
          });
        }

        // Consideriamo completata la lavorazione quando l'analisi ufficiale
        // è stata preparata; se serviva anche il pick, deve essere presente.
        const refreshedAnalysis =
          await getExistingMatchAnalysisSnapshot({
            homeTeamId,
            awayTeamId,
            historicalSeason:
              competition.historicalSeason,
            leagueName:
              competition.leagueName,
            countryName:
              competition.countryName,
            cacheVariant:
              uefaAnalysisCacheVariant,
            cacheTtl:
              PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
            allowPermanent:
              false,
            allowLegacy:
              false,
          });

        if (
          refreshedAnalysis &&
          (
            !needsSnapshot ||
            snapshot?.pick
          )
        ) {
          completed += 1;
        }

        if (snapshot?.pick) {
          const requestedDate =
            predictRomeDateKey(
              match?.date,
            );

          if (requestedDate) {
            const aggregatePrefix =
              `${matchdayPicksAggregatePrefixForRound(
                1,
              )}-real-results-v1`;

            await deleteCacheKey(
              [
                aggregatePrefix,
                competition.currentSeason,
                competition.historicalSeason,
                1,
                competition.leagueName,
                competition.countryName,
                requestedDate,
              ].join('-'),
            );
          }
        }
      } catch (error) {
        console.warn(
          `PREDICT CENTRAL UEFA precompute ${competition.leagueName} ${match?.id ?? ''} non riuscito:`,
          error?.message ??
            error,
        );

        if (
          isHighlightlyRateLimitError(
            error,
          )
        ) {
          break;
        }
      }
    }

    return completed > 0;
  } finally {
    centralUefaPrecomputeRunning = false;
  }
}

async function maintainCentralUefaMatchdayMultiples() {
  const now = Date.now();
  const groups = new Map();

  for (
    const {
      match,
      competition,
    } of centralUefaEntries()
  ) {
    const startMs =
      Date.parse(
        match?.date ?? '',
      );
    const dateKey =
      predictRomeDateKey(
        match?.date,
      );

    if (
      !dateKey ||
      !Number.isFinite(startMs) ||
      startMs - now >
        CENTRAL_UEFA_PREDICTION_HORIZON ||
      now - startMs >
        24 * 60 * 60 * 1000
    ) {
      continue;
    }

    const key =
      `${competition.key}:${dateKey}`;

    if (!groups.has(key)) {
      groups.set(
        key,
        {
          competition,
          dateKey,
          matches: [],
        },
      );
    }

    groups.get(key)
      .matches
      .push(match);
  }

  for (
    const group
      of groups.values()
  ) {
    const {
      competition,
      dateKey,
    } = group;

    const roundMatches =
      group.matches.sort(
        (a, b) =>
          Date.parse(
            a?.date ?? '',
          ) -
          Date.parse(
            b?.date ?? '',
          ),
      );

    const picks = [];

    for (const match of roundMatches) {
      const snapshot =
        await getExistingMatchdayPickSnapshot({
          match,
          matchId:
            match?.id,
          historicalSeason:
            competition.historicalSeason,
          leagueName:
            competition.leagueName,
          countryName:
            competition.countryName,
        });

      if (snapshot?.pick) {
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

      if (
        isFinishedMatch(match) &&
        snapshot?.pick
      ) {
        try {
          await getOrPersistMatchdayPickResult({
            match,
            snapshot,
            historicalSeason:
              competition.historicalSeason,
            leagueName:
              competition.leagueName,
            countryName:
              competition.countryName,
            allowProvider:
              false,
          });
        } catch (error) {
          console.warn(
            `PREDICT CENTRAL UEFA risultato ${match?.id ?? ''} non aggiornato:`,
            error?.message ??
              error,
          );
        }
      }
    }

    const multipleRoundKey =
      Number(
        dateKey.replace(
          /-/g,
          '',
        ),
      );

    let multiples =
      await getOrUpdateMatchdayMultiplesSnapshot({
        season:
          competition.currentSeason,
        historicalSeason:
          competition.historicalSeason,
        round:
          multipleRoundKey,
        leagueName:
          competition.leagueName,
        countryName:
          competition.countryName,
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
            false,
        });
    }

    const aggregatePrefix =
      `${matchdayPicksAggregatePrefixForRound(
        1,
      )}-real-results-v1`;

    await deleteCacheKey(
      [
        aggregatePrefix,
        competition.currentSeason,
        competition.historicalSeason,
        1,
        competition.leagueName,
        competition.countryName,
        dateKey,
      ].join('-'),
    );
  }

  return groups.size > 0;
}

async function centralUefaScheduleTick() {
  if (
    centralUefaScheduleRunning
  ) {
    return;
  }

  centralUefaScheduleRunning =
    true;

  try {
    await syncCentralUefaSchedules();
    await precomputeUpcomingUefaPredictData();
    await maintainCentralUefaMatchdayMultiples();
  } catch (error) {
    console.error(
      'PREDICT CENTRAL UEFA ERROR:',
      error?.message ??
        error,
    );
  } finally {
    centralUefaScheduleRunning =
      false;
  }
}

async function startCentralUefaScheduler() {
  await restoreCentralUefaCupState();
  await centralUefaScheduleTick();

  setInterval(
    centralUefaScheduleTick,
    CENTRAL_UEFA_TICK_INTERVAL,
  );

  console.log(
    'PREDICT CENTRAL UEFA: scheduler calendario/pronostici/multiple attivo ogni 15 minuti (refresh calendario provider max ogni 6 ore)',
  );
}

async function centralSharedLiveTick() {
  if (
    centralSharedLiveRunning
  ) {
    return;
  }

  centralSharedLiveRunning =
    true;

  try {
    await refreshCentralSharedLiveCache();
  } catch (error) {
    console.error(
      'PREDICT CENTRAL LIVE CACHE ERROR:',
      error?.message ??
        error,
    );
  } finally {
    centralSharedLiveRunning =
      false;
  }
}

async function startCentralSharedLiveScheduler() {
  await centralSharedLiveTick();

  setInterval(
    centralSharedLiveTick,
    CENTRAL_SHARED_LIVE_INTERVAL,
  );

  console.log(
    'PREDICT CENTRAL LIVE: cache condivisa attiva ogni 55 secondi',
  );
}

app.get(
  '/api/football/live',
  async (req, res) => {
    try {
      const cacheKey =
        'predict-central-live-matches-v2-cups';

      const publicLiveCacheTtl =
        LIVE_MATCHES_CACHE_TIME * 2;

      const cached =
        getMemoryCache(
          cacheKey,
          publicLiveCacheTtl,
        ) ??
        await getDiskCache(
          cacheKey,
          publicLiveCacheTtl,
        );

      if (cached) {
        return res.json({
          ...cached,
          cached: true,
          providerCallsAllowed:
            false,
        });
      }

      // L'endpoint pubblico non effettua mai refresh verso Highlightly.
      // Se il job centrale non ha ancora scritto la cache, restituiamo
      // esclusivamente ciò che è già presente negli stati PREDICT.
      const fallback =
        buildMergedCentralLivePayload(
          new Date(),
        );

      return res.json({
        ...fallback,
        cached: true,
        degraded: true,
        retryLater: true,
        providerCallsAllowed:
          false,
      });
    } catch (error) {
      console.error(
        'PREDICT LIVE MATCHES ERROR:',
        error?.message ??
          error,
      );

      return res
        .status(503)
        .json({
          error:
            'Cache LIVE PREDICT temporaneamente non disponibile',
          retryLater:
            true,
          providerCallsAllowed:
            false,
        });
    }
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
        const centralMatchesForDate =
          centralSerieAState.byDate
            .get(
              String(
                query.date,
              ),
            ) ??
          [];

        // Le richieste pubbliche leggono solo la cache centrale PREDICT.
        // Se il calendario centrale della stagione è già caricato, una data
        // assente è un risultato valido vuoto e NON deve generare fallback
        // verso Highlightly su iniziativa dell'utente.
        if (
          centralSerieAState.matches.length > 0 &&
          Array.isArray(
            centralMatchesForDate,
          )
        ) {
          return res.json({
            data:
              centralMatchesForDate,

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
      }

      // Accesso pubblico controllato anche per le altre competizioni
      // supportate da PREDICT. Non esponiamo il proxy Highlightly:
      // il client puo leggere solo la stagione corrente di una competizione
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

        if (
          supportedLeague.isCup !== true
        ) {
          const centralState =
            centralLeagueStateOf(
              supportedLeague,
            );

          const centralMatchesForDate =
            centralState?.byDate
              ?.get(
                requestedDate,
              ) ??
            [];

          if (
            centralState &&
            centralState.matches.length > 0 &&
            Array.isArray(
              centralMatchesForDate,
            )
          ) {
            return res.json({
              data:
                centralMatchesForDate,

              meta: {
                source:
                  'predict-central-5-leagues-cache',
                leagueKey:
                  supportedLeague.key,
                leagueName:
                  supportedLeague.leagueName,
                countryName:
                  supportedLeague.countryName,
                season:
                  String(query.season),
                date:
                  requestedDate,
                lastScheduleSyncAt:
                  centralState.lastScheduleSyncAt,
                lastLiveSyncAt:
                  centralState.lastLiveSyncAt,
                providerCallsAllowed:
                  false,
              },
            });
          }

          // Un utente non deve mai trasformare un cache miss in una chiamata
          // Highlightly. Se lo scheduler non ha ancora preparato la stagione,
          // chiediamo al client di riprovare invece di contattare il provider.
          return res
            .status(503)
            .json({
              error:
                'Cache PREDICT del campionato non ancora pronta',
              retryLater:
                true,
              providerCallsAllowed:
                false,
              leagueKey:
                supportedLeague.key,
              leagueName:
                supportedLeague.leagueName,
              countryName:
                supportedLeague.countryName,
              season:
                String(query.season),
              date:
                requestedDate,
            });
        }

        // Coppe UEFA: anche le richieste pubbliche leggono esclusivamente
        // lo stato centrale preparato dal backend. Un cache miss dell'utente
        // non deve mai diventare una chiamata Highlightly.
        const centralCupState =
          centralUefaCupStateOf(
            supportedLeague,
          );

        const centralCupMatchesForDate =
          centralCupState?.byDate
            ?.get(
              requestedDate,
            ) ??
          [];

        if (
          centralCupState &&
          centralCupState.matches.length > 0 &&
          Array.isArray(
            centralCupMatchesForDate,
          )
        ) {
          return res.json({
            data:
              centralCupMatchesForDate,

            meta: {
              source:
                'predict-central-uefa-cache',
              leagueKey:
                supportedLeague.key,
              leagueName:
                supportedLeague.leagueName,
              countryName:
                supportedLeague.countryName,
              season:
                String(query.season),
              date:
                requestedDate,
              isCup:
                true,
              lastScheduleSyncAt:
                centralCupState.lastScheduleSyncAt,
              lastLiveSyncAt:
                centralCupState.lastLiveSyncAt,
              providerCallsAllowed:
                false,
            },
          });
        }

        return res
          .status(503)
          .json({
            error:
              'Cache PREDICT della coppa UEFA non ancora pronta',
            retryLater:
              true,
            providerCallsAllowed:
              false,
            leagueKey:
              supportedLeague.key,
            leagueName:
              supportedLeague.leagueName,
            countryName:
              supportedLeague.countryName,
            season:
              String(query.season),
            date:
              requestedDate,
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

        date =
          null,

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

        compareMode =
          '0',

        predictWeightOverride =
          null,

        bookmakerWeightOverride =
          null,
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
// STORICO RISULTATI/GOL CUMULATIVO 2020-2025
// Usa esclusivamente le cache storiche già preparate.
// Nessuna nuova chiamata Highlightly viene avviata per le stagioni 2020-2025.
// ====================================================

app.get(
  '/api/football/league-history-cumulative',
  async (req, res) => {
    try {
      const {
        currentSeason =
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

      if (
        !supportedLeague ||
        supportedLeague.isCup === true
      ) {
        return res
          .status(400)
          .json({
            error:
              'Lo storico cumulativo 2020-2025 è attivo solo per i 5 campionati nazionali supportati.',
          });
      }

      const currentSeasonMatches =
        await loadSupportedLeagueSeasonMatches({
          season:
            currentSeason,
          leagueName,
          countryName,
        });

      const currentLeagueHistory =
        buildLeagueHistory(
          currentSeasonMatches,
          {
            season:
              currentSeason,
            leagueName,
            countryName,
          },
        );

      const cumulative =
        await getCumulativeLeagueHistoryFromPreparedCaches({
          currentSeason,
          leagueName,
          countryName,
          currentLeagueHistory,
        });

      if (!cumulative.ready) {
        return res
          .status(409)
          .json({
            error:
              'Archivio storico cumulativo risultati/gol non ancora completo.',

            requiredSeasons:
              PREDICT_ADVANCED_HISTORY_SEASONS,

            loadedSeasons:
              cumulative.loadedSeasons,

            missingSeasons:
              cumulative.missingSeasons,
          });
      }

      return res.json({
        ...cumulative.data,

        ready:
          true,

        requiredSeasons:
          PREDICT_ADVANCED_HISTORY_SEASONS,

        loadedSeasons:
          cumulative.loadedSeasons,

        cacheSource:
          'prepared-season-caches',
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
// STATISTICHE AVANZATE CUMULATIVE 2020-2025
// Usa esclusivamente le cache delle singole stagioni già preparate.
// Nessuna nuova chiamata Highlightly viene avviata da questo endpoint.
// ====================================================

app.get(
  '/api/football/league-advanced-stats-cumulative',
  async (req, res) => {
    try {
      const {
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

      const supportedLeague =
        resolveSupportedLeague({
          leagueName,
          countryName,
        });

      if (
        !supportedLeague ||
        supportedLeague.isCup === true
      ) {
        return res
          .status(400)
          .json({
            error:
              'Lo storico cumulativo 2020-2025 è attivo solo per i 5 campionati nazionali supportati.',
          });
      }

      const cumulative =
        await getCumulativeLeagueAdvancedProfilesFromCache({
          currentSeason,
          leagueName,
          countryName,

          sampleSize:
            parsedSampleSize,
        });

      if (!cumulative.ready) {
        return res
          .status(409)
          .json({
            error:
              'Archivio storico cumulativo non ancora completo.',

            requiredSeasons:
              PREDICT_ADVANCED_HISTORY_SEASONS,

            loadedSeasons:
              cumulative.loadedSeasons,

            missingSeasons:
              cumulative.missingSeasons,

            note:
              'Prepara prima le stagioni mancanti una alla volta con /api/football/league-advanced-stats per evitare il rate limit Highlightly.',
          });
      }

      return res.json({
        ...cumulative.data,

        ready:
          true,

        requiredSeasons:
          PREDICT_ADVANCED_HISTORY_SEASONS,

        loadedSeasons:
          cumulative.loadedSeasons,

        cacheSource:
          'prepared-season-caches',
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
// COMPATIBILITÀ APP PUBBLICATA - CONTESTO ANALISI
// ====================================================
// Le build già pubblicate di MatchdayPicksPage possono aprire MatchAnalysisPage
// senza propagare leagueName/countryName. In quel caso Flutter ricade sui
// default Serie A / Italy. Correggiamo SOLO lato server e SOLO da cache centrale:
// se la coppia casa/trasferta appartiene in modo univoco a un'altra competizione
// supportata, usiamo quel contesto reale. Nessuna chiamata provider viene avviata.
function inferCachedCompetitionForAnalysis({
  homeTeamId,
  awayTeamId,
  matchId = null,
}) {
  const wantedHome =
    String(homeTeamId ?? '');
  const wantedAway =
    String(awayTeamId ?? '');
  const wantedMatchId =
    matchId === null ||
    matchId === undefined ||
    String(matchId).trim() === ''
      ? null
      : String(matchId);

  if (!wantedHome || !wantedAway) {
    return null;
  }

  const candidates = [];

  for (
    const {
      league,
      match,
    } of centralDomesticEntries()
  ) {
    const idMatches =
      wantedMatchId !== null &&
      String(match?.id ?? '') ===
        wantedMatchId;

    const teamsMatch =
      String(
        teamIdOf(match?.homeTeam),
      ) === wantedHome &&
      String(
        teamIdOf(match?.awayTeam),
      ) === wantedAway;

    if (idMatches || teamsMatch) {
      candidates.push({
        league,
        match,
      });
    }
  }

  for (
    const {
      competition,
      match,
    } of centralUefaEntries()
  ) {
    const idMatches =
      wantedMatchId !== null &&
      String(match?.id ?? '') ===
        wantedMatchId;

    const teamsMatch =
      String(
        teamIdOf(match?.homeTeam),
      ) === wantedHome &&
      String(
        teamIdOf(match?.awayTeam),
      ) === wantedAway;

    if (idMatches || teamsMatch) {
      candidates.push({
        league: competition,
        match,
      });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  if (wantedMatchId !== null) {
    const exactById =
      candidates.filter(
        (item) =>
          String(item?.match?.id ?? '') ===
          wantedMatchId,
      );

    if (exactById.length === 1) {
      return exactById[0];
    }
  }

  const byCompetition =
    new Map();

  for (const item of candidates) {
    const key =
      String(item?.league?.key ?? '');

    if (key && !byCompetition.has(key)) {
      byCompetition.set(
        key,
        item,
      );
    }
  }

  // Senza matchId non indoviniamo se la stessa coppia compare in più
  // competizioni supportate: in quel caso lasciamo il contesto richiesto.
  if (byCompetition.size !== 1) {
    return null;
  }

  return Array.from(
    byCompetition.values(),
  )[0] ?? null;
}


// ====================================================
// ANALISI PARTITA COMPLETA
// ====================================================

app.get(
  '/api/football/match-analysis',
  async (req, res) => {
    try {
      let {
        homeTeamId,
        awayTeamId,
        matchId,

        season = '2025',

        leagueName =
          'Serie A',

        countryName =
          'Italy',

        compareMode =
          '0',

        predictWeightOverride =
          null,

        bookmakerWeightOverride =
          null,
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

      const internalRequest =
        req.get(
          'x-predict-internal',
        ) ===
        INTERNAL_SYNC_TOKEN;

      // Compatibilità con le build già pubblicate: MatchdayPicksPage può
      // arrivare qui con i default Serie A/Italy anche quando la partita è
      // di Premier, Bundesliga, Ligue 1, Liga o coppa UEFA. Correggiamo il
      // contesto soltanto se la coppia è presente in UNA SOLA competizione
      // delle cache centrali. Il controllo è cache-only e non usa Highlightly.
      const publicDefaultCompetitionContext =
        !internalRequest &&
        normalizeLeagueText(
          leagueName,
        ) ===
          normalizeLeagueText(
            'Serie A',
          ) &&
        normalizeLeagueText(
          countryName,
        ) ===
          normalizeLeagueText(
            'Italy',
          );

      if (publicDefaultCompetitionContext) {
        const inferredCompetition =
          inferCachedCompetitionForAnalysis({
            homeTeamId,
            awayTeamId,
            matchId,
          });

        if (
          inferredCompetition?.league &&
          inferredCompetition.league.key !==
            'serie-a'
        ) {
          leagueName =
            inferredCompetition.league
              .leagueName;
          countryName =
            inferredCompetition.league
              .countryName;

          if (
            (matchId === null ||
              matchId === undefined ||
              String(matchId).trim() === '') &&
            inferredCompetition.match?.id !==
              null &&
            inferredCompetition.match?.id !==
              undefined
          ) {
            matchId =
              String(
                inferredCompetition.match.id,
              );
          }

          console.log(
            `PREDICT ANALYSIS CONTEXT: ${homeTeamId}-${awayTeamId} -> ${leagueName}/${countryName} da cache centrale`,
          );
        }
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
              // Una richiesta pubblica può leggere solo gli stati/cache centrali.
              // La generazione dati provider resta riservata ai job interni.
              allowProviderFallback:
                internalRequest,
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
        bookmakerOnlyModeForCompetition({
          round:
            centralRound,
          supportedLeague,
        });

      // Modalita A/B esclusivamente locale: permette di confrontare,
      // senza cambiare gli snapshot ufficiali, pesi PREDICT/bookmaker diversi.
      // In produzione questi override vengono ignorati.
      const comparisonMode =
        process.env.NODE_ENV !== 'production' &&
        String(compareMode).trim() === '1';

      const parsedPredictWeightOverride =
        predictWeightOverride === null ||
        predictWeightOverride === undefined ||
        predictWeightOverride === ''
          ? null
          : Number(predictWeightOverride);

      const parsedBookmakerWeightOverride =
        bookmakerWeightOverride === null ||
        bookmakerWeightOverride === undefined ||
        bookmakerWeightOverride === ''
          ? null
          : Number(bookmakerWeightOverride);

      const comparisonWeightsValid =
        comparisonMode &&
        Number.isFinite(
          parsedPredictWeightOverride,
        ) &&
        Number.isFinite(
          parsedBookmakerWeightOverride,
        ) &&
        parsedPredictWeightOverride >= 0 &&
        parsedPredictWeightOverride <= 1 &&
        parsedBookmakerWeightOverride >= 0 &&
        parsedBookmakerWeightOverride <= 1 &&
        Math.abs(
          parsedPredictWeightOverride +
            parsedBookmakerWeightOverride -
            1,
        ) < 0.000001;

      if (
        comparisonMode &&
        !comparisonWeightsValid
      ) {
        return res
          .status(400)
          .json({
            error:
              'Confronto A/B: predictWeightOverride e bookmakerWeightOverride devono essere tra 0 e 1 e sommare a 1.',
          });
      }

      const uefaCupBlendMode =
        supportedLeague?.isCup === true;

      const predictBlendWeight =
        comparisonWeightsValid
          ? parsedPredictWeightOverride
          : uefaCupBlendMode
            ? UEFA_CUP_PREDICT_WEIGHT
            : bookmakerOnlyMode
              ? BOOKMAKER_ONLY_PREDICT_WEIGHT
              : 0.95;

      const bookmakerBlendWeight =
        comparisonWeightsValid
          ? parsedBookmakerWeightOverride
          : uefaCupBlendMode
            ? UEFA_CUP_BOOKMAKER_WEIGHT
            : bookmakerOnlyMode
              ? BOOKMAKER_ONLY_BOOKMAKER_WEIGHT
              : 0.05;

      const domesticCumulativeHistoryActive =
        supportedLeague !== null &&
        supportedLeague !== undefined &&
        supportedLeague.isCup !== true;

      const cumulativeHistoryCacheVariant =
        domesticCumulativeHistoryActive
          ? 'hist2020to2025-allfamilies-v1'
          : null;

      const comparisonCacheVariant =
        comparisonWeightsValid
          ? `local-ab-v4-strength-p${Math.round(
              predictBlendWeight * 100,
            )}-b${Math.round(
              bookmakerBlendWeight * 100,
            )}`
          : null;

      const standardAnalysisCacheVariant =
        uefaCupBlendMode
          ? [
              'uefa-predict5-bookmaker95-analysisstats-v3-fullvenuehistory',
              cumulativeHistoryCacheVariant,
            ]
              .filter(Boolean)
              .join('-')
          : bookmakerOnlyMode
            ? [
                `predict95-bookmaker5-nullfix-analysisstats-v4-r${BOOKMAKER_ONLY_FROM_ROUND}plus`,
                cumulativeHistoryCacheVariant,
              ]
                .filter(Boolean)
                .join('-')
            : cumulativeHistoryCacheVariant;

      const analysisCacheVariant =
        [
          standardAnalysisCacheVariant,
          comparisonCacheVariant,
        ]
          .filter(Boolean)
          .join('-') ||
        null;

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
        !comparisonMode &&
        (
          predictionFreezeActive ||
          !matchIsUpcoming
        );

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
          predictionFreezeActive &&
          !comparisonMode
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
          predictionFreezeActive &&
          !comparisonMode
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

      // La generazione completa dell'analisi è riservata al server PREDICT.
      // In produzione il client legge esclusivamente snapshot/cache già preparati.
      // Il confronto A/B resta disponibile solo fuori produzione come prima.
      const publicOnDemandAnalysisAllowed =
        comparisonMode ||
        internalRequest;

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
        comparisonMode
          ? null
          : await readLegacyMatchAnalysisSnapshot({
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

      let leagueResult = null;
      let cumulativeHistoryInfo = null;

      if (
        supportedLeague &&
        supportedLeague.isCup !== true
      ) {
        const currentLeagueHistory =
          buildLeagueHistory(
            currentSeasonMatches,
            {
              season:
                currentSeason,
              leagueName,
              countryName,
            },
          );

        const cumulativeHistory =
          await getCumulativeLeagueHistoryFromPreparedCaches({
            currentSeason,
            leagueName,
            countryName,
            currentLeagueHistory,
          });

        if (
          cumulativeHistory.ready &&
          cumulativeHistory.data
        ) {
          leagueResult = {
            data:
              cumulativeHistory.data,
            cacheSource:
              'prepared-season-caches',
          };

          cumulativeHistoryInfo = {
            seasons:
              cumulativeHistory.loadedSeasons,

            teamSeasonCoveragePercentage:
              cumulativeHistory.data
                .teamSeasonCoveragePercentage,

            source:
              'cumulative-2020-2025',
          };
        }
      }

      if (!leagueResult) {
        leagueResult =
          await getLeagueHistory({
            season,
            leagueName,
            countryName,
          });
      }

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

      // Coppe UEFA: se Highlightly non restituisce alcun mercato bookmaker
      // per la singola partita, non lasciamo l'analisi vuota. Il job interno
      // usa temporaneamente il modello PREDICT al 100% e marca chiaramente
      // il risultato come fallback. La richiesta pubblica resta cache-only.
      const uefaBookmakerFallback =
        uefaCupBlendMode &&
        !bookmakerProbabilitiesHaveAnyMarket(
          bookmakerProbabilities,
        );

      const effectivePredictBlendWeight =
        uefaBookmakerFallback
          ? 1
          : predictBlendWeight;

      const effectiveBookmakerBlendWeight =
        uefaBookmakerFallback
          ? 0
          : bookmakerBlendWeight;

      const prediction =
        calculatePrediction({
          homeTeam:
            modelHomeTeam,

          awayTeam:
            modelAwayTeam,

          homeRecentMatches,
          awayRecentMatches,
          headToHeadMatches,

          // Per i campionati nazionali le medie e i profili squadra
          // usano il cumulativo 2020-2025 quando tutte le cache sono pronte;
          // il 2026 entra poi con peso progressivo.
          leagueHistory:
            leagueResult.data,

          bookmakerProbabilities,
          predictWeight:
            effectivePredictBlendWeight,
          bookmakerWeight:
            effectiveBookmakerBlendWeight,
        });

      prediction.inputs = {
        ...prediction.inputs,

        historicalBase:
          cumulativeHistoryInfo
            ? {
                type:
                  'cumulative',

                seasons:
                  cumulativeHistoryInfo.seasons,

                source:
                  cumulativeHistoryInfo.source,

                teamSeasonCoveragePercentage:
                  cumulativeHistoryInfo
                    .teamSeasonCoveragePercentage,

                seasonWeights:
                  PREDICT_ADVANCED_HISTORY_SEASONS
                    .map(
                      (historicalSeason) => ({
                        season:
                          String(historicalSeason),

                        weight:
                          round2(
                            advancedHistoricalSeasonWeight(
                              historicalSeason,
                            ),
                          ),
                      }),
                    ),
              }
            : {
                type:
                  'single-season',

                season:
                  String(season),
              },

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

      // Per i 5 campionati nazionali, quando tutte le cache 2020-2025
      // sono state preparate, usiamo il profilo avanzato cumulativo.
      // Se manca anche una sola stagione, manteniamo automaticamente
      // il comportamento precedente basato sulla stagione richiesta.
      let advancedData = null;

      if (
        supportedLeague &&
        supportedLeague.isCup !== true
      ) {
        const cumulativeAdvanced =
          await getCumulativeLeagueAdvancedProfilesFromCache({
            currentSeason,
            leagueName,
            countryName,

            sampleSize:
              ADVANCED_SAMPLE_PER_VENUE,
          });

        if (
          cumulativeAdvanced.ready &&
          cumulativeAdvanced.data
        ) {
          advancedData =
            cumulativeAdvanced.data;
        }
      }

      if (!advancedData) {
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

        advancedData =
          historicalAdvancedResult.data;
      }

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

      // Fallback di compatibilità per una squadra che non sia ancora
      // presente nel profilo avanzato disponibile.
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
        effectivePredictBlendWeight,
        effectiveBookmakerBlendWeight,
        !uefaBookmakerFallback &&
          (
            comparisonMode ||
            bookmakerOnlyMode
          ),
      );

      // Nel regime 10/90 (e nel confronto A/B) il feed bookmaker non espone
      // ancora quote sui tiri in porta. Per evitare un Top Signal che diventi
      // accidentalmente 100% PREDICT, i tiri restano fuori quando manca la quota.
      if (
        !uefaBookmakerFallback &&
        (
          comparisonMode ||
          bookmakerOnlyMode
        ) &&
        advanced?.shotsOnTarget
      ) {
        advanced.shotsOnTarget.topSignalAvailable =
          false;
        advanced.shotsOnTarget.bookmakerOnlyUnavailable =
          true;
        advanced.shotsOnTarget.bookmakerOnlyReason =
          comparisonMode
            ? 'Confronto A/B: quote bookmaker tiri in porta non disponibili nel feed attuale'
            : 'Regime 10/90: quote bookmaker tiri in porta non disponibili nel feed attuale';
      }

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

      if (uefaBookmakerFallback) {
        prediction.bookmakerFallback = true;
        prediction.bookmakerFallbackMode =
          'predict-only';
        prediction.bookmakerFallbackReason =
          'Quote bookmaker non disponibili nel feed Highlightly per questa partita';
        prediction.bookmakerBlendApplied = {
          predictWeight: 1,
          bookmakerWeight: 0,
        };
        prediction.signalsAvailable = false;
        prediction.signalsUnavailableReason =
          'Quote bookmaker non disponibili nel feed Highlightly per questa partita';

        // Manteniamo il calcolo statistico PREDICT come supporto all'analisi,
        // ma senza pubblicare Primary Signal, Top Signals o pronostico.
        const fallbackReliabilityFactor = 0.85;
        const reliability =
          prediction.reliability;

        if (reliability && typeof reliability === 'object') {
          for (const key of [
            'overall',
            'oneXTwo',
            'goals',
            'exactScore',
            'corners',
            'shotsOnTarget',
            'cards',
          ]) {
            const value =
              Number(reliability[key]);

            if (Number.isFinite(value)) {
              reliability[key] =
                round2(
                  clamp(
                    value *
                      fallbackReliabilityFactor,
                    0,
                    100,
                  ),
                );
            }
          }

          reliability.overallLabel =
            reliabilityLabel(
              Number(reliability.overall) || 0,
            );
          reliability.oneXTwoLabel =
            reliabilityLabel(
              Number(reliability.oneXTwo) || 0,
            );
          reliability.goalsLabel =
            reliabilityLabel(
              Number(reliability.goals) || 0,
            );
          reliability.exactScoreLabel =
            reliabilityLabel(
              Number(reliability.exactScore) || 0,
            );
          reliability.cornersLabel =
            Number(reliability.corners) > 0
              ? reliabilityLabel(
                  Number(reliability.corners),
                )
              : 'N/D';
          reliability.shotsOnTargetLabel =
            Number(reliability.shotsOnTarget) > 0
              ? reliabilityLabel(
                  Number(reliability.shotsOnTarget),
                )
              : 'N/D';
          reliability.cardsLabel =
            Number(reliability.cards) > 0
              ? reliabilityLabel(
                  Number(reliability.cards),
                )
              : 'N/D';

          prediction.dataCoverage =
            reliability.overallLabel
              .toLowerCase();

          for (const signal of prediction.topSignals ?? []) {
            const market =
              signal.market ??
              'goals';
            const score =
              market === 'oneXTwo'
                ? reliability.oneXTwo
                : market === 'corners'
                  ? reliability.corners
                  : market === 'shotsOnTarget'
                    ? reliability.shotsOnTarget
                    : market === 'cards'
                      ? reliability.cards
                      : reliability.goals;

            signal.reliability =
              round2(
                Number(score) || 0,
              );
            signal.reliabilityLabel =
              Number(score) > 0
                ? reliabilityLabel(
                    Number(score),
                  )
                : 'N/D';
          }
        }
      }

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
              'historical-league',

            league:
              homeTeam.sourceLeagueName ??
              leagueName,
          },

          away: {
            source:
              awayTeam.historicalSource ??
              'historical-league',

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

        uefaVenueHistory:
          supportedLeague?.isCup === true
            ? buildUefaVenueHistory({
                matches:
                  currentSeasonMatches,
                homeTeamId,
                awayTeamId,
                competition:
                  supportedLeague,
              })
            : null,

        prediction,

        advanced,
      };

      if (comparisonMode) {
        analysisPayload.blendComparison = {
          localOnly:
            true,

          predictWeight:
            round2(
              predictBlendWeight * 100,
            ),

          bookmakerWeight:
            round2(
              bookmakerBlendWeight * 100,
            ),

          pick:
            buildMostProbablePick(
              analysisPayload,
            ),

          note:
            'Confronto locale A/B: non modifica snapshot, pronostici ufficiali o archivio permanente.',
        };
      }

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
        predictionFreezeActive &&
        !comparisonMode
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
  allowProviderFallback = true,
}) {
  const league =
    resolveSupportedLeague({
      leagueName,
      countryName,
    });

  if (!league) {
    const error = new Error(
      `Competizione non supportata: ${leagueName} / ${countryName}`,
    );

    error.statusCode = 400;
    throw error;
  }

  const isCentralDomesticCurrent =
    league.isCup !== true &&
    league.supportsMatchdayPicks !== false &&
    String(season) ===
      String(league.currentSeason);

  if (isCentralDomesticCurrent) {
    const centralState =
      centralLeagueStateOf(
        league,
      );

    if (
      centralState &&
      centralState.matches.length > 0
    ) {
      return centralState.matches;
    }
  }

  const isCentralUefaCurrent =
    league.isCup === true &&
    String(season) ===
      String(league.currentSeason);

  if (isCentralUefaCurrent) {
    const centralCupState =
      centralUefaCupStateOf(
        league,
      );

    if (
      centralCupState &&
      centralCupState.matches.length > 0
    ) {
      return centralCupState.matches;
    }
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

  // In modalità cache-only non contattiamo mai Highlightly.
  // Serve per aggiornare statistiche/storico multiple senza consumare quota API.
  if (!allowProviderFallback) {
    return [];
  }

  const allMatches = [];
  const pageLimit = 100;
  let offset = 0;
  let totalCount = null;

  let preferredProviderLeagueName =
    null;

  while (offset < 1000) {
    const pageResult =
      await fetchSupportedCompetitionMatchesPage({
        competition:
          league,
        season:
          String(season),
        limit:
          String(pageLimit),
        offset:
          String(offset),
        preferredProviderLeagueName,
      });

    const payload =
      pageResult.payload;

    const pageMatches =
      pageResult.matches;

    if (
      pageMatches.length > 0
    ) {
      preferredProviderLeagueName =
        pageResult
          .providerLeagueName;
    }

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

  const competitionMatches =
    uniqueMatches(
      allMatches,
    )
      .filter(
        (match) =>
          league.isCup === true ||
          regularSeasonMatch(
            match,
          ),
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
    competitionMatches,
  );

  await setDiskCache(
    cacheKey,
    competitionMatches,
  );

  return competitionMatches;
}

function buildMostProbablePick(
  analysis,
) {
  const prediction =
    analysis?.prediction ?? {};

  // Coppe UEFA: se l'analisi è in fallback perché mancano le quote bookmaker,
  // non generiamo alcun pronostico principale.
  if (prediction?.bookmakerFallback === true) {
    return null;
  }

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
    neutralProbability = 50,
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

    const signalStrength =
      normalizedSignalStrength(
        numeric,
        neutralProbability,
      );

    if (
      signalStrength === null
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
      signalStrength,
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
    neutralProbability:
      100 / 3,
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
    neutralProbability:
      100 / 3,
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
    neutralProbability:
      100 / 3,
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

  sortTopSignalCandidates(
    candidates,
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

  const requestedLeague =
    resolveSupportedLeague({
      leagueName,
      countryName,
    });

  const snapshotVersion =
    matchdayPickSnapshotVersionForMatch(
      match,
      requestedLeague,
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

  // Compatibilità selettiva UEFA v11 -> v12:
  // recuperiamo la vecchia pick SOLO se le quote bookmaker risultano già
  // presenti nella cache locale. Se non ci sono quote, nessun pronostico.
  // Questo evita nuove chiamate Highlightly e non rigenera pick/multiple.
  if (
    requestedLeague?.isCup === true &&
    snapshotVersion ===
      UEFA_CUP_MATCHDAY_PICK_VERSION
  ) {
    const legacyUefa =
      await readMatchdayPickSnapshotVersion({
        version:
          UEFA_CUP_MATCHDAY_PICK_LEGACY_VERSION,
        matchId,
        historicalSeason,
        leagueName,
        countryName,
      });

    if (legacyUefa.snapshot?.pick) {
      const cachedBookmakerProbabilities =
        await getCachedBookmakerProbabilitiesForMatch(
          matchId,
        );

      if (
        bookmakerProbabilitiesHaveAnyMarket(
          cachedBookmakerProbabilities,
        )
      ) {
        if (
          predictionFreezeActive ||
          !beforeKickoff
        ) {
          await persistPermanentMatchdayPickRecord({
            match,
            snapshot:
              legacyUefa.snapshot,
            historicalSeason,
            leagueName,
            countryName,
          });
        }

        return legacyUefa.snapshot;
      }
    }
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

  const directBookmakerOnly =
    BOOKMAKER_ONLY_PREDICT_WEIGHT === 0 &&
    BOOKMAKER_ONLY_BOOKMAKER_WEIGHT === 1 &&
    bookmakerOnlyModeForCompetition({
      round:
        roundNumberOf(match),
      supportedLeague:
        requestedLeague,
    }) &&
    requestedLeague &&
    requestedLeague.key !==
      'serie-a';

  // Lo shortcut diretto esiste soltanto per l'eventuale regime 0/100.
  // Con i blend ufficiali (95/5 nei campionati e 5/95 nelle coppe UEFA)
  // passiamo dall'analisi completa, così ogni Top Signal usa realmente
  // entrambi i pesi.
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
// MULTIGOL PREDICT - GENERATORE PREVIEW SEPARATO
// ====================================================
//
// IMPORTANTE:
// - NON modifica prediction.topSignals.
// - NON aggiunge il Multigol alla pagina Analisi partita.
// - Serve esclusivamente alla futura sezione Multiple Multigol.
// - Per proteggere la quota Highlightly, di default legge soltanto
//   analisi/quote già presenti nelle cache. Passare allowProvider=1
//   soltanto durante un test esplicito o quando si vuole rigenerare.
//
// Mercati compatibili con la struttura Sisal comunicata:
// 0, 1-2, 1-3, 1-4, 1-5, 1-6,
// 2-3, 2-4, 2-5, 2-6,
// 3-4, 3-5, 3-6,
// 4-6, 5-6, 7+.
//
// Il ranking NON sceglie automaticamente la fascia più larga.
// Ogni range riceve un fattore di precisione che penalizza
// progressivamente le fasce molto ampie.

const PREDICT_MULTIGOAL_RANGES = [
  {
    label: '0',
    min: 0,
    max: 0,
    tail: false,
    precisionFactor: 1.12,
  },
  {
    label: '1-2',
    min: 1,
    max: 2,
    tail: false,
    precisionFactor: 1.08,
  },
  {
    label: '1-3',
    min: 1,
    max: 3,
    tail: false,
    precisionFactor: 1.00,
  },
  {
    label: '1-4',
    min: 1,
    max: 4,
    tail: false,
    precisionFactor: 0.90,
  },
  {
    label: '1-5',
    min: 1,
    max: 5,
    tail: false,
    precisionFactor: 0.82,
  },
  {
    label: '1-6',
    min: 1,
    max: 6,
    tail: false,
    precisionFactor: 0.74,
  },
  {
    label: '2-3',
    min: 2,
    max: 3,
    tail: false,
    precisionFactor: 1.08,
  },
  {
    label: '2-4',
    min: 2,
    max: 4,
    tail: false,
    precisionFactor: 1.00,
  },
  {
    label: '2-5',
    min: 2,
    max: 5,
    tail: false,
    precisionFactor: 0.90,
  },
  {
    label: '2-6',
    min: 2,
    max: 6,
    tail: false,
    precisionFactor: 0.82,
  },
  {
    label: '3-4',
    min: 3,
    max: 4,
    tail: false,
    precisionFactor: 1.08,
  },
  {
    label: '3-5',
    min: 3,
    max: 5,
    tail: false,
    precisionFactor: 1.00,
  },
  {
    label: '3-6',
    min: 3,
    max: 6,
    tail: false,
    precisionFactor: 0.90,
  },
  {
    label: '4-6',
    min: 4,
    max: 6,
    tail: false,
    precisionFactor: 1.00,
  },
  {
    label: '5-6',
    min: 5,
    max: 6,
    tail: false,
    precisionFactor: 1.08,
  },
  {
    label: '7+',
    min: 7,
    max: null,
    tail: true,
    precisionFactor: 0.86,
  },
];

function multiGoalProbabilityForLambda(
  lambda,
  range,
) {
  const numericLambda =
    Number(lambda);

  if (
    !Number.isFinite(
      numericLambda,
    ) ||
    numericLambda < 0
  ) {
    return null;
  }

  if (range?.tail) {
    let belowTail = 0;

    for (
      let goals = 0;
      goals < Number(range.min);
      goals += 1
    ) {
      belowTail +=
        poissonProbability(
          numericLambda,
          goals,
        );
    }

    return clamp(
      1 - belowTail,
      0,
      1,
    );
  }

  const min =
    Number(range?.min);

  const max =
    Number(range?.max);

  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    max < min
  ) {
    return null;
  }

  let probability = 0;

  for (
    let goals = min;
    goals <= max;
    goals += 1
  ) {
    probability +=
      poissonProbability(
        numericLambda,
        goals,
      );
  }

  return clamp(
    probability,
    0,
    1,
  );
}

function multiGoalHalfGoalBookmakerLines(
  totalGoals,
) {
  if (
    !totalGoals ||
    typeof totalGoals !== 'object'
  ) {
    return [];
  }

  return Object.entries(
    totalGoals,
  )
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
        item.over < 1 &&
        item.under > 0 &&
        item.under < 1 &&
        Math.abs(
          (
            item.line -
            Math.floor(item.line)
          ) -
          0.5
        ) <
          0.001,
    );
}

// Ricava un "totale gol atteso bookmaker" dalle linee Under/Over.
// E' un fit Poisson: scegliamo il lambda che riproduce meglio
// le probabilità bookmaker disponibili sulle linee x.5.
function fitBookmakerTotalGoalsLambda(
  totalGoals,
) {
  const lines =
    multiGoalHalfGoalBookmakerLines(
      totalGoals,
    );

  if (lines.length === 0) {
    return null;
  }

  let bestLambda =
    null;

  let bestError =
    Infinity;

  for (
    let lambda = 0.25;
    lambda <= 6.50;
    lambda += 0.01
  ) {
    let error = 0;

    for (const line of lines) {
      const modelOver =
        totalGoalsOverProbability(
          lambda,
          line.line,
        );

      const difference =
        modelOver -
        line.over;

      error +=
        difference *
        difference;
    }

    error /=
      lines.length;

    if (error < bestError) {
      bestError =
        error;

      bestLambda =
        lambda;
    }
  }

  if (
    !Number.isFinite(
      bestLambda,
    )
  ) {
    return null;
  }

  return {
    lambda:
      round2(
        bestLambda,
      ),

    fitError:
      round2(
        bestError,
      ),

    linesUsed:
      lines.map(
        (item) =>
          round2(
            item.line,
          ),
      ),
  };
}

function resolveMultiGoalBlendWeights({
  supportedLeague,
  round,
  compareMode,
  predictWeightOverride,
  bookmakerWeightOverride,
}) {
  const comparisonMode =
    process.env.NODE_ENV !==
      'production' &&
    String(
      compareMode ?? '0',
    ).trim() === '1';

  const parsedPredict =
    predictWeightOverride ===
        null ||
      predictWeightOverride ===
        undefined ||
      predictWeightOverride ===
        ''
      ? null
      : Number(
          predictWeightOverride,
        );

  const parsedBookmaker =
    bookmakerWeightOverride ===
        null ||
      bookmakerWeightOverride ===
        undefined ||
      bookmakerWeightOverride ===
        ''
      ? null
      : Number(
          bookmakerWeightOverride,
        );

  const comparisonWeightsValid =
    comparisonMode &&
    Number.isFinite(
      parsedPredict,
    ) &&
    Number.isFinite(
      parsedBookmaker,
    ) &&
    parsedPredict >= 0 &&
    parsedPredict <= 1 &&
    parsedBookmaker >= 0 &&
    parsedBookmaker <= 1 &&
    Math.abs(
      parsedPredict +
        parsedBookmaker -
        1,
    ) <
      0.000001;

  if (
    comparisonMode &&
    !comparisonWeightsValid
  ) {
    return {
      error:
        'Confronto Multigol A/B: predictWeightOverride e bookmakerWeightOverride devono essere tra 0 e 1 e sommare a 1.',
    };
  }

  if (comparisonWeightsValid) {
    return {
      comparisonMode:
        true,

      predictWeight:
        parsedPredict,

      bookmakerWeight:
        parsedBookmaker,
    };
  }

  const bookmakerDominant =
    bookmakerOnlyModeForCompetition({
      round,
      supportedLeague,
    });

  return {
    comparisonMode:
      false,

    predictWeight:
      bookmakerDominant
        ? BOOKMAKER_ONLY_PREDICT_WEIGHT
        : 0.95,

    bookmakerWeight:
      bookmakerDominant
        ? BOOKMAKER_ONLY_BOOKMAKER_WEIGHT
        : 0.05,
  };
}

function multiGoalAnalysisCacheVariants({
  supportedLeague,
  round,
}) {
  const variants = [];

  if (
    supportedLeague &&
    supportedLeague.isCup !== true
  ) {
    const cumulative =
      'hist2020to2025-allfamilies-v1';

    if (
      bookmakerOnlyModeForCompetition({
        round,
        supportedLeague,
      })
    ) {
      variants.push(
        [
          `predict95-bookmaker5-nullfix-analysisstats-v4-r${BOOKMAKER_ONLY_FROM_ROUND}plus`,
          cumulative,
        ].join('-'),
      );
    }

    variants.push(
      cumulative,
    );
  }

  variants.push(
    null,
  );

  return variants;
}

async function getCachedMultiGoalAnalysis({
  homeTeamId,
  awayTeamId,
  historicalSeason,
  leagueName,
  countryName,
  supportedLeague,
  round,
}) {
  const variants =
    multiGoalAnalysisCacheVariants({
      supportedLeague,
      round,
    });

  for (
    const cacheVariant
      of variants
  ) {
    const analysis =
      await getExistingMatchAnalysisSnapshot({
        homeTeamId,
        awayTeamId,
        historicalSeason,
        leagueName,
        countryName,
        cacheVariant,
        cacheTtl:
          PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
        allowPermanent:
          true,
        allowLegacy:
          cacheVariant === null,
      });

    if (
      analysis?.prediction
        ?.expectedGoals
    ) {
      return analysis;
    }
  }

  return null;
}

async function getCachedBookmakerProbabilitiesForMatch(
  matchId,
) {
  if (!matchId) {
    return null;
  }

  const key =
    `odds-prematch-${matchId}`;

  const memory =
    getMemoryCache(
      key,
      PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
    );

  if (memory) {
    return buildBookmakerMarketProbabilities(
      memory,
    );
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

    return buildBookmakerMarketProbabilities(
      disk,
    );
  }

  return null;
}

function buildMultiGoalPick({
  analysis,
  bookmakerProbabilities,
  predictWeight,
  bookmakerWeight,
}) {
  const predictLambda =
    Number(
      analysis?.prediction
        ?.expectedGoals
        ?.total,
    );

  if (
    !Number.isFinite(
      predictLambda,
    )
  ) {
    return null;
  }

  const bookmakerFit =
    fitBookmakerTotalGoalsLambda(
      bookmakerProbabilities
        ?.totalGoals,
    );

  const bookmakerLambda =
    Number(
      bookmakerFit?.lambda,
    );

  const bookmakerAvailable =
    Number.isFinite(
      bookmakerLambda,
    );

  // Stessa protezione concettuale usata dai Top Signal bookmaker-dominant:
  // con bookmaker >= 90% non trasformiamo una mancanza quote
  // in un pronostico accidentalmente 100% PREDICT.
  if (
    Number(bookmakerWeight) >=
      0.90 &&
    !bookmakerAvailable
  ) {
    return null;
  }

  const candidates = [];

  for (
    const range
      of PREDICT_MULTIGOAL_RANGES
  ) {
    const predictProbability =
      multiGoalProbabilityForLambda(
        predictLambda,
        range,
      );

    if (
      !Number.isFinite(
        predictProbability,
      )
    ) {
      continue;
    }

    const bookmakerProbability =
      bookmakerAvailable
        ? multiGoalProbabilityForLambda(
            bookmakerLambda,
            range,
          )
        : null;

    let finalProbability =
      predictProbability;

    if (
      Number.isFinite(
        bookmakerProbability,
      )
    ) {
      finalProbability =
        predictProbability *
          Number(
            predictWeight,
          ) +
        bookmakerProbability *
          Number(
            bookmakerWeight,
          );
    }

    const probabilityPercent =
      round2(
        finalProbability * 100,
      );

    const precisionFactor =
      Number(
        range.precisionFactor,
      );

    const qualityScore =
      round2(
        probabilityPercent *
          precisionFactor,
      );

    candidates.push({
      label:
        `Multigol ${range.label}`,

      market:
        'Multigol',

      selection:
        range.label,

      min:
        range.min,

      max:
        range.max,

      tail:
        Boolean(
          range.tail,
        ),

      probability:
        probabilityPercent,

      predictProbability:
        round2(
          predictProbability *
            100,
        ),

      bookmakerProbability:
        Number.isFinite(
          bookmakerProbability,
        )
          ? round2(
              bookmakerProbability *
                100,
            )
          : null,

      precisionFactor:
        round2(
          precisionFactor,
        ),

      // Per la sezione Multiple questo e' il valore di ranking.
      signalStrength:
        qualityScore,

      qualityScore,
    });
  }

  candidates.sort(
    (a, b) => {
      const strengthDiff =
        Number(
          b.signalStrength,
        ) -
        Number(
          a.signalStrength,
        );

      if (
        Math.abs(
          strengthDiff,
        ) >
        0.000001
      ) {
        return strengthDiff;
      }

      return (
        Number(
          b.probability,
        ) -
        Number(
          a.probability,
        )
      );
    },
  );

  const best =
    candidates[0];

  if (!best) {
    return null;
  }

  return {
    ...best,

    expectedGoals:
      round2(
        predictLambda,
      ),

    bookmakerExpectedGoals:
      bookmakerAvailable
        ? round2(
            bookmakerLambda,
          )
        : null,

    bookmakerFit:
      bookmakerFit
        ? {
            fitError:
              bookmakerFit
                .fitError,

            linesUsed:
              bookmakerFit
                .linesUsed,
          }
        : null,

    predictWeight:
      round2(
        Number(
          predictWeight,
        ) * 100,
      ),

    bookmakerWeight:
      round2(
        Number(
          bookmakerWeight,
        ) * 100,
      ),

    rankingRule:
      'probabilita blend x fattore precisione range',
  };
}

function sortMultiGoalMatchCandidates(
  candidates,
) {
  return (
    candidates ?? []
  ).sort(
    (a, b) => {
      const strengthDiff =
        Number(
          b?.pick
            ?.signalStrength ??
          -Infinity,
        ) -
        Number(
          a?.pick
            ?.signalStrength ??
          -Infinity,
        );

      if (
        Math.abs(
          strengthDiff,
        ) >
        0.000001
      ) {
        return strengthDiff;
      }

      return (
        Number(
          b?.pick
            ?.probability ??
          0,
        ) -
        Number(
          a?.pick
            ?.probability ??
          0,
        )
      );
    },
  );
}

function buildMultiGoalAccumulator(
  ranked,
  requestedEvents,
) {
  const selections =
    (
      ranked ?? []
    )
      .slice(
        0,
        requestedEvents,
      )
      .map(
        (item) => ({
          matchId:
            item.matchId,

          date:
            item.date,

          leagueName:
            item.leagueName,

          countryName:
            item.countryName,

          round:
            item.round,

          homeTeam:
            item.homeTeam,

          awayTeam:
            item.awayTeam,

          pick:
            item.pick,
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


function multiGoalFreezeCacheVariant({
  compareMode,
  predictWeightOverride,
  bookmakerWeightOverride,
}) {
  const isLocalComparison =
    process.env.NODE_ENV !==
      'production' &&
    String(
      compareMode ?? '0',
    ).trim() === '1';

  if (!isLocalComparison) {
    return 'official';
  }

  const predict =
    Number(
      predictWeightOverride,
    );

  const bookmaker =
    Number(
      bookmakerWeightOverride,
    );

  return [
    'local-ab',
    Number.isFinite(predict)
      ? `p${Math.round(predict * 100)}`
      : 'pna',
    Number.isFinite(bookmaker)
      ? `b${Math.round(bookmaker * 100)}`
      : 'bna',
  ].join('-');
}

const multiGoalFreezeMetaRegistry =
  new Map();

function buildMultiGoalFreezeCacheKey({
  mode,
  eventCount,
  season,
  historicalSeason,
  round,
  leagueName,
  countryName,
  date,
  compareMode,
  predictWeightOverride,
  bookmakerWeightOverride,
}) {
  const variant =
    multiGoalFreezeCacheVariant({
      compareMode,
      predictWeightOverride,
      bookmakerWeightOverride,
    });

  const key = [
    'multigoal-multiple-snapshot-v1',
    String(mode ?? 'national'),
    `x${Number(eventCount)}`,
    String(
      date ??
      '',
    ),
    String(
      season ??
      '',
    ),
    String(
      historicalSeason ??
      '',
    ),
    String(
      round ??
      '',
    ),
    String(
      leagueName ??
      '',
    ),
    String(
      countryName ??
      '',
    ),
    variant,
  ].join('-');

  multiGoalFreezeMetaRegistry.set(
    key,
    {
      mode:
        String(
          mode ??
          'national',
        ),

      eventCount:
        Number(
          eventCount,
        ),

      season:
        String(
          season ??
          '',
        ),

      historicalSeason:
        String(
          historicalSeason ??
          '',
        ),

      round:
        Number.isFinite(
          Number(round),
        ) &&
        String(round).trim() !== ''
          ? Number(round)
          : null,

      leagueName:
        String(
          leagueName ??
          '',
        ),

      countryName:
        String(
          countryName ??
          '',
        ),

      date:
        String(
          date ??
          '',
        ),

      official:
        variant ===
          'official',
    },
  );

  return key;
}


const MULTIGOAL_HISTORY_INDEX_KEY =
  'multigoal-history-index-v1';

function buildMultiGoalHistoryArchiveKey(
  meta,
) {
  return [
    'multigoal-history-record-v1',
    String(
      meta?.mode ??
      'national',
    ),
    `x${Number(
      meta?.eventCount ??
      0,
    )}`,
    String(
      meta?.date ??
      '',
    ),
    String(
      meta?.season ??
      '',
    ),
    String(
      meta?.historicalSeason ??
      '',
    ),
    String(
      meta?.round ??
      '',
    ),
    String(
      meta?.leagueName ??
      '',
    ),
    String(
      meta?.countryName ??
      '',
    ),
  ].join('-');
}

function emptyMultiGoalHistoryResult() {
  return {
    status:
      'pending',

    settled:
      false,

    settledAt:
      null,
  };
}

async function addMultiGoalHistoryIndexEntry({
  archiveKey,
  meta,
  frozenAt,
}) {
  const current =
    await getPermanentCache(
      MULTIGOAL_HISTORY_INDEX_KEY,
    );

  const existingItems =
    Array.isArray(
      current?.items,
    )
      ? current.items
      : [];

  const withoutCurrent =
    existingItems.filter(
      (item) =>
        String(
          item?.archiveKey ??
          '',
        ) !==
        String(
          archiveKey,
        ),
    );

  const item = {
    archiveKey,

    mode:
      meta.mode,

    eventCount:
      meta.eventCount,

    season:
      meta.season,

    historicalSeason:
      meta.historicalSeason,

    round:
      meta.round,

    leagueName:
      meta.leagueName,

    countryName:
      meta.countryName,

    date:
      meta.date,

    frozenAt:
      frozenAt ??
      null,
  };

  const items = [
    item,
    ...withoutCurrent,
  ]
    .sort(
      (a, b) =>
        Date.parse(
          b?.frozenAt ??
          b?.date ??
          '',
        ) -
        Date.parse(
          a?.frozenAt ??
          a?.date ??
          '',
        ),
    )
    .slice(
      0,
      500,
    );

  await setPermanentCache(
    MULTIGOAL_HISTORY_INDEX_KEY,
    {
      version: 1,

      updatedAt:
        new Date()
          .toISOString(),

      items,
    },
  );
}

async function persistFrozenMultiGoalSnapshot({
  cacheKey,
  accumulator,
}) {
  if (
    accumulator?.frozen !==
      true ||
    accumulator?.ready !==
      true
  ) {
    return accumulator;
  }

  const meta =
    multiGoalFreezeMetaRegistry.get(
      cacheKey,
    );

  // I test A/B locali non entrano mai nello storico ufficiale.
  if (
    !meta ||
    meta.official !==
      true
  ) {
    return accumulator;
  }

  const archiveKey =
    buildMultiGoalHistoryArchiveKey(
      meta,
    );

  const existing =
    await getPermanentCache(
      archiveKey,
    );

  const existingSettled =
    existing?.result
      ?.settled === true;

  const record = {
    id:
      archiveKey,

    archiveKey,

    feature:
      'PREDICT Multiple Multigol',

    mode:
      meta.mode,

    eventCount:
      meta.eventCount,

    season:
      meta.season,

    historicalSeason:
      meta.historicalSeason,

    round:
      meta.round,

    leagueName:
      meta.leagueName,

    countryName:
      meta.countryName,

    date:
      meta.date,

    frozenAt:
      accumulator?.frozenAt ??
      existing?.frozenAt ??
      new Date()
        .toISOString(),

    firstMatchAt:
      accumulator?.firstMatchAt ??
      existing?.firstMatchAt ??
      null,

    freezeAt:
      accumulator?.freezeAt ??
      existing?.freezeAt ??
      null,

    archivedAt:
      existing?.archivedAt ??
      new Date()
        .toISOString(),

    updatedAt:
      new Date()
        .toISOString(),

    accumulator:
      existingSettled
        ? existing.accumulator
        : accumulator,

    result:
      existingSettled
        ? existing.result
        : (
          existing?.result ??
          emptyMultiGoalHistoryResult()
        ),
  };

  await setPermanentCache(
    archiveKey,
    record,
  );

  await addMultiGoalHistoryIndexEntry({
    archiveKey,
    meta,
    frozenAt:
      record.frozenAt,
  });

  return accumulator;
}

function multiGoalRangeContainsTotal(
  selection,
  totalGoals,
) {
  const label =
    String(
      selection ??
      '',
    ).trim();

  const total =
    Number(
      totalGoals,
    );

  if (
    !Number.isFinite(total) ||
    total < 0
  ) {
    return null;
  }

  if (label === '0') {
    return total === 0;
  }

  if (label === '7+') {
    return total >= 7;
  }

  const match =
    /^(\d+)-(\d+)$/.exec(
      label,
    );

  if (!match) {
    return null;
  }

  const min =
    Number(
      match[1],
    );

  const max =
    Number(
      match[2],
    );

  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max)
  ) {
    return null;
  }

  return (
    total >= min &&
    total <= max
  );
}

async function cachedMatchesForMultiGoalHistorySelection({
  selection,
  record,
  cache,
}) {
  const leagueName =
    String(
      selection?.leagueName ??
      record?.leagueName ??
      '',
    );

  const countryName =
    String(
      selection?.countryName ??
      record?.countryName ??
      '',
    );

  const league =
    resolveSupportedLeague({
      leagueName,
      countryName,
    });

  if (!league) {
    return [];
  }

  const season =
    String(
      record?.season ??
      league.currentSeason ??
      CURRENT_SERIE_A_SEASON,
    );

  const key =
    [
      league.key,
      season,
    ].join(':');

  if (cache.has(key)) {
    return cache.get(key);
  }

  let matches = [];

  try {
    matches =
      await loadSupportedLeagueSeasonMatches({
        season,
        leagueName:
          league.leagueName,
        countryName:
          league.countryName,
        allowProviderFallback:
          false,
      });
  } catch {
    matches = [];
  }

  cache.set(
    key,
    matches,
  );

  return matches;
}

async function settleMultiGoalHistoryRecord(
  record,
) {
  if (
    !record?.accumulator
      ?.ready ||
    record?.accumulator
      ?.frozen !== true
  ) {
    return record;
  }

  if (
    record?.result
      ?.settled === true
  ) {
    return record;
  }

  const matchCache =
    new Map();

  const selections =
    [];

  for (
    const selection
      of (
        record.accumulator
          .selections ??
        []
      )
  ) {
    let result =
      selection?.result ??
      {
        status:
          'pending',
        settled:
          false,
      };

    if (
      result?.settled !==
        true
    ) {
      const matches =
        await cachedMatchesForMultiGoalHistorySelection({
          selection,
          record,
          cache:
            matchCache,
        });

      const match =
        (
          matches ??
          []
        ).find(
          (item) =>
            String(
              item?.id ??
              '',
            ) ===
            String(
              selection?.matchId ??
              '',
            ),
        );

      if (
        match &&
        isFinishedMatch(
          match,
        )
      ) {
        const score =
          parseScore(
            match,
          );

        if (score) {
          const totalGoals =
            Number(
              score.home,
            ) +
            Number(
              score.away,
            );

          const won =
            multiGoalRangeContainsTotal(
              selection?.pick
                ?.selection,
              totalGoals,
            );

          if (
            won !== null
          ) {
            result = {
              status:
                won
                  ? 'won'
                  : 'lost',

              settled:
                true,

              settledAt:
                new Date()
                  .toISOString(),

              totalGoals,

              score: {
                home:
                  score.home,

                away:
                  score.away,
              },
            };
          }
        }
      }
    }

    selections.push({
      ...selection,

      result,
    });
  }

  const anyLost =
    selections.some(
      (selection) =>
        selection?.result
          ?.status ===
          'lost',
    );

  const allWon =
    selections.length ===
      Number(
        record?.eventCount ??
        record?.accumulator
          ?.requestedEvents ??
        0,
      ) &&
    selections.every(
      (selection) =>
        selection?.result
          ?.status ===
          'won',
    );

  const result =
    anyLost
      ? {
          status:
            'lost',

          settled:
            true,

          settledAt:
            new Date()
              .toISOString(),
        }
      : allWon
        ? {
            status:
              'won',

            settled:
              true,

            settledAt:
              new Date()
                .toISOString(),
          }
        : {
            status:
              'pending',

            settled:
              false,

            settledAt:
              null,
          };

  const updated = {
    ...record,

    updatedAt:
      new Date()
        .toISOString(),

    accumulator: {
      ...record.accumulator,

      selections,
    },

    result,
  };

  await setPermanentCache(
    record.archiveKey,
    updated,
  );

  return updated;
}

async function importCurrentMultiGoalSnapshotsIntoHistory() {
  // Migrazione leggera degli snapshot creati prima dell'aggiunta dello storico.
  // Solo cache locale: nessuna chiamata Highlightly.
  for (
    const league
      of SUPPORTED_LEAGUE_LIST
  ) {
    if (
      league?.isCup === true
    ) {
      continue;
    }

    const maxRound =
      Math.min(
        Number(
          league
            .regularSeasonRounds ??
          38,
        ),
        6,
      );

    for (
      let round = 1;
      round <= maxRound;
      round += 1
    ) {
      for (
        const eventCount
          of [3, 5]
      ) {
        const cacheKey =
          buildMultiGoalFreezeCacheKey({
            mode:
              'national',

            eventCount,

            season:
              league.currentSeason,

            historicalSeason:
              league.historicalSeason,

            round,

            leagueName:
              league.leagueName,

            countryName:
              league.countryName,

            date:
              '',

            compareMode:
              '0',
          });

        let snapshot =
          getMemoryCache(
            cacheKey,
            MATCHDAY_MULTIPLE_SNAPSHOT_CACHE_TIME,
          );

        if (!snapshot) {
          snapshot =
            await getDiskCache(
              cacheKey,
              MATCHDAY_MULTIPLE_SNAPSHOT_CACHE_TIME,
            );
        }

        if (
          snapshot?.frozen ===
            true &&
          snapshot?.ready ===
            true
        ) {
          await persistFrozenMultiGoalSnapshot({
            cacheKey,
            accumulator:
              snapshot,
          });
        }
      }
    }
  }

  const today =
    highlightlyRomeDayKey();

  for (
    const eventCount
      of [3, 5, 10]
  ) {
    const cacheKey =
      buildMultiGoalFreezeCacheKey({
        mode:
          'international',

        eventCount,

        season:
          CURRENT_SERIE_A_SEASON,

        historicalSeason:
          '2025',

        round:
          '',

        leagueName:
          '__international__',

        countryName:
          '__international__',

        date:
          today,

        compareMode:
          '0',
      });

    let snapshot =
      getMemoryCache(
        cacheKey,
        MATCHDAY_MULTIPLE_SNAPSHOT_CACHE_TIME,
      );

    if (!snapshot) {
      snapshot =
        await getDiskCache(
          cacheKey,
          MATCHDAY_MULTIPLE_SNAPSHOT_CACHE_TIME,
        );
    }

    if (
      snapshot?.frozen ===
        true &&
      snapshot?.ready ===
        true
    ) {
      await persistFrozenMultiGoalSnapshot({
        cacheKey,
        accumulator:
          snapshot,
      });
    }
  }
}

function buildMultiGoalHistorySummary(
  records,
) {
  const summary = {
    total:
      records.length,

    verified:
      0,

    won:
      0,

    lost:
      0,

    pending:
      0,

    successRate:
      null,
  };

  for (
    const record
      of records
  ) {
    const status =
      record?.result
        ?.status ??
      'pending';

    if (status === 'won') {
      summary.won +=
        1;

      summary.verified +=
        1;
    } else if (
      status === 'lost'
    ) {
      summary.lost +=
        1;

      summary.verified +=
        1;
    } else {
      summary.pending +=
        1;
    }
  }

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

  return summary;
}


function decorateMultiGoalAccumulatorForFreeze({
  accumulator,
  frozen,
  status,
  generatedAt,
  frozenAt,
  firstMatchAt,
  freezeAt,
}) {
  return {
    ...(accumulator ?? {}),

    frozen:
      Boolean(
        frozen,
      ),

    status:
      String(
        status ??
        (
          accumulator?.ready
            ? 'provisional'
            : 'preparing'
        ),
      ),

    generatedAt:
      generatedAt ??
      new Date()
        .toISOString(),

    frozenAt:
      frozenAt ??
      null,

    firstMatchAt:
      firstMatchAt ??
      null,

    freezeAt:
      freezeAt ??
      null,

    freezeHoursBeforeFirstMatch:
      MATCHDAY_MULTIPLE_FREEZE_WINDOW /
      (60 * 60 * 1000),
  };
}

function multiGoalAccumulatorTimes(
  accumulator,
) {
  const validStarts =
    (
      accumulator
        ?.selections ??
      []
    )
      .map(
        (selection) =>
          Date.parse(
            selection?.date ??
            '',
          ),
      )
      .filter(
        (value) =>
          Number.isFinite(
            value,
          ),
      )
      .sort(
        (a, b) =>
          a - b,
      );

  if (
    validStarts.length === 0
  ) {
    return null;
  }

  const firstMatchStartMs =
    validStarts[0];

  return {
    firstMatchStartMs,

    freezeAtMs:
      firstMatchStartMs -
      MATCHDAY_MULTIPLE_FREEZE_WINDOW,
  };
}

// Ogni 3X / 5X / 10X viene gestita in modo indipendente.
// Prima del cutoff salviamo l'ultimo snapshot completo provvisorio.
// Al cutoff (4 ore prima della PRIMA partita contenuta in quella multipla)
// congeliamo l'ultimo snapshot completo valido e da quel momento non cambia più.
async function getOrFreezeMultiGoalAccumulator({
  cacheKey,
  accumulator,
}) {
  const now =
    Date.now();

  let existing =
    getMemoryCache(
      cacheKey,
      MATCHDAY_MULTIPLE_SNAPSHOT_CACHE_TIME,
    );

  if (!existing) {
    existing =
      await getDiskCache(
        cacheKey,
        MATCHDAY_MULTIPLE_SNAPSHOT_CACHE_TIME,
      );

    if (existing) {
      setMemoryCache(
        cacheKey,
        existing,
      );
    }
  }

  // Uno snapshot già congelato è definitivo.
  if (
    existing?.frozen ===
      true &&
    existing?.ready ===
      true
  ) {
    await persistFrozenMultiGoalSnapshot({
      cacheKey,
      accumulator:
        existing,
    });

    return existing;
  }

  // Se avevamo già un provvisorio completo e il suo cutoff è passato,
  // congeliamo QUELLO. Questo evita che un refresh successivo cambi
  // pronostici, percentuali o ordine dopo l'orario di congelamento.
  if (
    existing?.ready ===
      true
  ) {
    const existingFreezeAtMs =
      Date.parse(
        existing?.freezeAt ??
        '',
      );

    if (
      Number.isFinite(
        existingFreezeAtMs,
      ) &&
      now >=
        existingFreezeAtMs
    ) {
      const frozenSnapshot = {
        ...existing,

        frozen: true,

        status:
          'frozen',

        frozenAt:
          existing?.frozenAt ??
          new Date(now)
            .toISOString(),
      };

      setMemoryCache(
        cacheKey,
        frozenSnapshot,
      );

      await setDiskCache(
        cacheKey,
        frozenSnapshot,
      );

      await persistFrozenMultiGoalSnapshot({
        cacheKey,
        accumulator:
          frozenSnapshot,
      });

      return frozenSnapshot;
    }
  }

  const current =
    accumulator ??
    buildMultiGoalAccumulator(
      [],
      0,
    );

  // Una multipla incompleta resta "in preparazione" e NON viene congelata.
  if (
    current?.ready !==
      true
  ) {
    return decorateMultiGoalAccumulatorForFreeze({
      accumulator:
        current,

      frozen:
        false,

      status:
        'preparing',
    });
  }

  const times =
    multiGoalAccumulatorTimes(
      current,
    );

  if (!times) {
    return decorateMultiGoalAccumulatorForFreeze({
      accumulator:
        current,

      frozen:
        false,

      status:
        'provisional',
    });
  }

  const generatedAt =
    new Date()
      .toISOString();

  const provisionalSnapshot =
    decorateMultiGoalAccumulatorForFreeze({
      accumulator:
        current,

      frozen:
        now >=
          times.freezeAtMs,

      status:
        now >=
          times.freezeAtMs
          ? 'frozen'
          : 'provisional',

      generatedAt,

      frozenAt:
        now >=
          times.freezeAtMs
          ? generatedAt
          : null,

      firstMatchAt:
        new Date(
          times.firstMatchStartMs,
        ).toISOString(),

      freezeAt:
        new Date(
          times.freezeAtMs,
        ).toISOString(),
    });

  // Salviamo soltanto snapshot COMPLETI.
  // Prima del cutoff viene aggiornato a ogni richiesta;
  // dopo il cutoff viene scritto già come definitivo.
  setMemoryCache(
    cacheKey,
    provisionalSnapshot,
  );

  await setDiskCache(
    cacheKey,
    provisionalSnapshot,
  );

  if (
    provisionalSnapshot
      ?.frozen === true
  ) {
    await persistFrozenMultiGoalSnapshot({
      cacheKey,
      accumulator:
        provisionalSnapshot,
    });
  }

  return provisionalSnapshot;
}


function futureRoundGroupsForMultiGoal(
  seasonMatches,
) {
  const now =
    Date.now();

  const groups =
    new Map();

  for (
    const match
      of seasonMatches ?? []
  ) {
    const round =
      Number(
        roundNumberOf(
          match,
        ),
      );

    const startMs =
      Date.parse(
        match?.date ?? '',
      );

    if (
      !Number.isFinite(round) ||
      round <= 0 ||
      !Number.isFinite(
        startMs,
      ) ||
      startMs <= now
    ) {
      continue;
    }

    if (!groups.has(round)) {
      groups.set(
        round,
        [],
      );
    }

    groups
      .get(round)
      .push(match);
  }

  return groups;
}

function nextFutureRoundForMultiGoal(
  seasonMatches,
) {
  const groups =
    futureRoundGroupsForMultiGoal(
      seasonMatches,
    );

  const candidates =
    [];

  for (
    const [round, matches]
      of groups.entries()
  ) {
    const firstStart =
      Math.min(
        ...matches
          .map(
            (match) =>
              Date.parse(
                match?.date ?? '',
              ),
          )
          .filter(
            (value) =>
              Number.isFinite(
                value,
              ),
          ),
      );

    if (
      Number.isFinite(
        firstStart,
      )
    ) {
      candidates.push({
        round,
        matches,
        firstStart,
      });
    }
  }

  candidates.sort(
    (a, b) =>
      a.firstStart -
      b.firstStart,
  );

  return (
    candidates[0] ??
    null
  );
}

async function buildMultiGoalCandidateForMatch({
  match,
  league,
  historicalSeason,
  compareMode,
  predictWeightOverride,
  bookmakerWeightOverride,
  allowProvider,
}) {
  const homeTeamId =
    teamIdOf(
      match?.homeTeam,
    );

  const awayTeamId =
    teamIdOf(
      match?.awayTeam,
    );

  const round =
    Number(
      roundNumberOf(
        match,
      ),
    );

  if (
    !homeTeamId ||
    !awayTeamId ||
    !Number.isFinite(round)
  ) {
    return {
      candidate:
        null,

      reason:
        'ID squadre o giornata non disponibili',
    };
  }

  const weights =
    resolveMultiGoalBlendWeights({
      supportedLeague:
        league,
      round,
      compareMode,
      predictWeightOverride,
      bookmakerWeightOverride,
    });

  if (weights?.error) {
    return {
      candidate:
        null,

      error:
        weights.error,
    };
  }

  let analysis =
    await getCachedMultiGoalAnalysis({
      homeTeamId,
      awayTeamId,
      historicalSeason,
      leagueName:
        league.leagueName,
      countryName:
        league.countryName,
      supportedLeague:
        league,
      round,
    });

  if (
    !analysis &&
    allowProvider
  ) {
    analysis =
      await internalMatchAnalysis({
        homeTeamId,
        awayTeamId,
        matchId:
          match?.id ??
          null,
        historicalSeason,
        leagueName:
          league.leagueName,
        countryName:
          league.countryName,
      });
  }

  if (
    !analysis?.prediction
      ?.expectedGoals
  ) {
    return {
      candidate:
        null,

      reason:
        'Analisi PREDICT non presente in cache',
    };
  }

  let bookmakerProbabilities =
    await getCachedBookmakerProbabilitiesForMatch(
      match?.id,
    );

  if (
    !bookmakerProbabilities &&
    allowProvider
  ) {
    bookmakerProbabilities =
      await getBookmakerProbabilitiesForMatch(
        match?.id,
      );
  }

  const pick =
    buildMultiGoalPick({
      analysis,
      bookmakerProbabilities,
      predictWeight:
        weights.predictWeight,
      bookmakerWeight:
        weights.bookmakerWeight,
    });

  if (!pick) {
    return {
      candidate:
        null,

      reason:
        Number(
          weights.bookmakerWeight,
        ) >= 0.90
          ? 'Quote bookmaker Total Goals non disponibili: evitato fallback 100% PREDICT'
          : 'Pronostico Multigol non calcolabile',
    };
  }

  return {
    candidate: {
      matchId:
        match?.id ??
        null,

      date:
        match?.date ??
        null,

      leagueName:
        league.leagueName,

      countryName:
        league.countryName,

      round,

      homeTeam:
        match?.homeTeam ??
        null,

      awayTeam:
        match?.awayTeam ??
        null,

      pick,
    },

    weights,
  };
}

async function buildNationalMultiGoalPreview({
  league,
  season,
  historicalSeason,
  requestedRound,
  compareMode,
  predictWeightOverride,
  bookmakerWeightOverride,
  allowProvider,
}) {
  const seasonMatches =
    await loadSupportedLeagueSeasonMatches({
      season,
      leagueName:
        league.leagueName,
      countryName:
        league.countryName,
      // In produzione la preview pubblica legge solo cache/stato centrale PREDICT.
      // Il provider resta disponibile esclusivamente nei test locali espliciti.
      allowProviderFallback:
        allowProvider,
    });

  let round =
    Number(
      requestedRound,
    );

  let roundMatches = [];

  if (
    Number.isFinite(round) &&
    round > 0
  ) {
    roundMatches =
      (
        seasonMatches ?? []
      )
        .filter(
          (match) =>
            Number(
              roundNumberOf(
                match,
              ),
            ) === round,
        )
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
              startMs >
                Date.now()
            );
          },
        );
  } else {
    const nextRound =
      nextFutureRoundForMultiGoal(
        seasonMatches,
      );

    round =
      nextRound?.round ??
      null;

    roundMatches =
      nextRound?.matches ??
      [];
  }

  if (
    !Number.isFinite(
      Number(round),
    ) ||
    roundMatches.length === 0
  ) {
    return {
      available:
        false,

      reason:
        'Nessuna giornata futura disponibile',

      candidates:
        [],

      skipped:
        [],
    };
  }

  const candidates = [];

  const skipped = [];

  for (
    const match
      of roundMatches
  ) {
    try {
      const built =
        await buildMultiGoalCandidateForMatch({
          match,
          league,
          historicalSeason,
          compareMode,
          predictWeightOverride,
          bookmakerWeightOverride,
          allowProvider,
        });

      if (built?.error) {
        throw new Error(
          built.error,
        );
      }

      if (built?.candidate) {
        candidates.push(
          built.candidate,
        );
      } else {
        skipped.push({
          matchId:
            match?.id ??
            null,

          homeTeam:
            match?.homeTeam
              ?.name ??
            '',

          awayTeam:
            match?.awayTeam
              ?.name ??
            '',

          reason:
            built?.reason ??
            'Non disponibile',
        });
      }
    } catch (error) {
      skipped.push({
        matchId:
          match?.id ??
          null,

        homeTeam:
          match?.homeTeam
            ?.name ??
          '',

        awayTeam:
          match?.awayTeam
            ?.name ??
          '',

        reason:
          error?.message ??
          String(error),
      });
    }
  }

  sortMultiGoalMatchCandidates(
    candidates,
  );

  const multigol3 =
    await getOrFreezeMultiGoalAccumulator({
      cacheKey:
        buildMultiGoalFreezeCacheKey({
          mode:
            'national',
          eventCount:
            3,
          season,
          historicalSeason,
          round:
            Number(round),
          leagueName:
            league.leagueName,
          countryName:
            league.countryName,
          date:
            '',
          compareMode,
          predictWeightOverride,
          bookmakerWeightOverride,
        }),

      accumulator:
        buildMultiGoalAccumulator(
          candidates,
          3,
        ),
    });

  const multigol5 =
    await getOrFreezeMultiGoalAccumulator({
      cacheKey:
        buildMultiGoalFreezeCacheKey({
          mode:
            'national',
          eventCount:
            5,
          season,
          historicalSeason,
          round:
            Number(round),
          leagueName:
            league.leagueName,
          countryName:
            league.countryName,
          date:
            '',
          compareMode,
          predictWeightOverride,
          bookmakerWeightOverride,
        }),

      accumulator:
        buildMultiGoalAccumulator(
          candidates,
          5,
        ),
    });

  return {
    available:
      multigol3.ready ===
        true,

    leagueName:
      league.leagueName,

    countryName:
      league.countryName,

    round:
      Number(round),

    matchesInFutureRound:
      roundMatches.length,

    candidateCount:
      candidates.length,

    candidates,

    skipped,

    multigol3,

    multigol5,
  };
}

app.get(
  '/api/football/multigoal-preview',
  async (req, res) => {
    try {
      const {
        mode =
          'national',

        leagueName =
          'Serie A',

        countryName =
          'Italy',

        round =
          '',

        season =
          CURRENT_SERIE_A_SEASON,

        historicalSeason =
          '2025',

        compareMode =
          '0',

        predictWeightOverride =
          null,

        bookmakerWeightOverride =
          null,

        allowProvider =
          '0',

        date =
          '',
      } = req.query;

      const providerAllowed =
        process.env.NODE_ENV !==
          'production' &&
        String(
          allowProvider,
        ).trim() === '1';

      const normalizedMode =
        String(mode)
          .trim()
          .toLowerCase();

      if (
        normalizedMode !==
          'national' &&
        normalizedMode !==
          'international'
      ) {
        return res
          .status(400)
          .json({
            error:
              'mode deve essere national oppure international',
          });
      }

      if (
        normalizedMode ===
          'national'
      ) {
        const league =
          resolveSupportedLeague({
            leagueName,
            countryName,
          });

        if (
          !league ||
          league.isCup === true
        ) {
          return res
            .status(400)
            .json({
              error:
                'Campionato nazionale non supportato per Multigol',
            });
        }

        const parsedRound =
          String(round)
            .trim() === ''
            ? null
            : Number(
                round,
              );

        const preview =
          await buildNationalMultiGoalPreview({
            league,
            season:
              String(
                season,
              ),
            historicalSeason:
              String(
                historicalSeason,
              ),
            requestedRound:
              parsedRound,
            compareMode,
            predictWeightOverride,
            bookmakerWeightOverride,
            allowProvider:
              providerAllowed,
          });

        return res.json({
          ok: true,

          feature:
            'PREDICT Multiple Multigol',

          mode:
            'national',

          generatedAt:
            new Date()
              .toISOString(),

          providerCallsAllowed:
            providerAllowed,

          note:
            'Preview separata: nessun Multigol viene aggiunto all Analisi partita o ai Top Signal.',

          ...preview,
        });
      }

      // MULTIGOL INTERNAZIONALE:
      // usa il PROSSIMO TURNO FUTURO disponibile di ciascuno dei 5
      // campionati nazionali supportati. Le selezioni vengono poi unite
      // e ordinate per costruire 3X / 5X / 10X.
      //
      // In produzione questo endpoint e' rigorosamente cache-only:
      // nessuna apertura della pagina da parte di un utente puo' generare
      // chiamate Highlightly. Se un'analisi non e' ancora presente nella
      // cache PREDICT, quella partita viene semplicemente saltata.
      const leaguePreviews = [];

      const allCandidates = [];

      const skipped = [];

      const internationalRoundStarts = [];

      for (
        const league
          of SUPPORTED_LEAGUE_LIST
      ) {
        if (
          league?.isCup ===
            true
        ) {
          continue;
        }

        const leagueSeason =
          String(
            league.currentSeason ??
            season,
          );

        const leagueHistoricalSeason =
          String(
            league.historicalSeason ??
            historicalSeason,
          );

        let seasonMatches = [];

        try {
          seasonMatches =
            await loadSupportedLeagueSeasonMatches({
              season:
                leagueSeason,
              leagueName:
                league.leagueName,
              countryName:
                league.countryName,
              allowProviderFallback:
                providerAllowed,
            });
        } catch (error) {
          leaguePreviews.push({
            leagueName:
              league.leagueName,

            countryName:
              league.countryName,

            round:
              null,

            matchesInFutureRound:
              0,

            candidateCount:
              0,

            error:
              error?.message ??
              String(error),
          });

          continue;
        }

        const nextRound =
          nextFutureRoundForMultiGoal(
            seasonMatches,
          );

        const nextRoundNumber =
          Number(
            nextRound?.round,
          );

        const futureRoundMatches =
          Array.isArray(
            nextRound?.matches,
          )
            ? nextRound.matches
            : [];

        const firstStartMs =
          Number(
            nextRound?.firstStart,
          );

        if (
          Number.isFinite(
            firstStartMs,
          )
        ) {
          internationalRoundStarts.push(
            firstStartMs,
          );
        }

        if (
          !Number.isFinite(
            nextRoundNumber,
          ) ||
          futureRoundMatches.length ===
            0
        ) {
          leaguePreviews.push({
            leagueName:
              league.leagueName,

            countryName:
              league.countryName,

            round:
              null,

            firstMatchAt:
              null,

            matchesInFutureRound:
              0,

            candidateCount:
              0,

            reason:
              'Nessuna giornata futura disponibile nella cache PREDICT',
          });

          continue;
        }

        let leagueCandidateCount =
          0;

        for (
          const match
            of futureRoundMatches
        ) {
          try {
            const built =
              await buildMultiGoalCandidateForMatch({
                match,
                league,
                historicalSeason:
                  leagueHistoricalSeason,
                compareMode,
                predictWeightOverride,
                bookmakerWeightOverride,
                allowProvider:
                  providerAllowed,
              });

            if (built?.error) {
              throw new Error(
                built.error,
              );
            }

            if (
              built?.candidate
            ) {
              allCandidates.push(
                built.candidate,
              );

              leagueCandidateCount +=
                1;
            } else {
              skipped.push({
                matchId:
                  match?.id ??
                  null,

                leagueName:
                  league.leagueName,

                countryName:
                  league.countryName,

                round:
                  nextRoundNumber,

                homeTeam:
                  match?.homeTeam
                    ?.name ??
                  '',

                awayTeam:
                  match?.awayTeam
                    ?.name ??
                  '',

                reason:
                  built?.reason ??
                  'Non disponibile',
              });
            }
          } catch (error) {
            skipped.push({
              matchId:
                match?.id ??
                null,

              leagueName:
                league.leagueName,

              countryName:
                league.countryName,

              round:
                nextRoundNumber,

              homeTeam:
                match?.homeTeam
                  ?.name ??
                '',

              awayTeam:
                match?.awayTeam
                  ?.name ??
                '',

              reason:
                error?.message ??
                String(error),
            });
          }
        }

        leaguePreviews.push({
          leagueName:
            league.leagueName,

          countryName:
            league.countryName,

          round:
            nextRoundNumber,

          firstMatchAt:
            Number.isFinite(
              firstStartMs,
            )
              ? new Date(
                  firstStartMs,
                ).toISOString()
              : null,

          matchesInFutureRound:
            futureRoundMatches.length,

          candidateCount:
            leagueCandidateCount,
        });
      }

      sortMultiGoalMatchCandidates(
        allCandidates,
      );

      const internationalDate =
        internationalRoundStarts.length >
          0
          ? highlightlyRomeDayKey(
              new Date(
                Math.min(
                  ...internationalRoundStarts,
                ),
              ),
            )
          : highlightlyRomeDayKey();

      // Firma informativa delle giornate coinvolte. Ogni campionato puo'
      // trovarsi su un numero di giornata diverso, quindi non esiste un
      // singolo round internazionale numerico.
      const internationalRoundSignature =
        leaguePreviews
          .filter(
            (item) =>
              Number.isFinite(
                Number(
                  item?.round,
                ),
              ),
          )
          .map(
            (item) =>
              `${item.leagueName}:${item.round}`,
          )
          .join('|');

      const multigol3 =
        await getOrFreezeMultiGoalAccumulator({
          cacheKey:
            buildMultiGoalFreezeCacheKey({
              mode:
                'international',
              eventCount:
                3,
              season:
                String(season),
              historicalSeason:
                String(
                  historicalSeason,
                ),
              round:
                internationalRoundSignature,
              leagueName:
                '__international_next_rounds__',
              countryName:
                '__international__',
              date:
                internationalDate,
              compareMode,
              predictWeightOverride,
              bookmakerWeightOverride,
            }),

          accumulator:
            buildMultiGoalAccumulator(
              allCandidates,
              3,
            ),
        });

      const multigol5 =
        await getOrFreezeMultiGoalAccumulator({
          cacheKey:
            buildMultiGoalFreezeCacheKey({
              mode:
                'international',
              eventCount:
                5,
              season:
                String(season),
              historicalSeason:
                String(
                  historicalSeason,
                ),
              round:
                internationalRoundSignature,
              leagueName:
                '__international_next_rounds__',
              countryName:
                '__international__',
              date:
                internationalDate,
              compareMode,
              predictWeightOverride,
              bookmakerWeightOverride,
            }),

          accumulator:
            buildMultiGoalAccumulator(
              allCandidates,
              5,
            ),
        });

      const multigol10 =
        await getOrFreezeMultiGoalAccumulator({
          cacheKey:
            buildMultiGoalFreezeCacheKey({
              mode:
                'international',
              eventCount:
                10,
              season:
                String(season),
              historicalSeason:
                String(
                  historicalSeason,
                ),
              round:
                internationalRoundSignature,
              leagueName:
                '__international_next_rounds__',
              countryName:
                '__international__',
              date:
                internationalDate,
              compareMode,
              predictWeightOverride,
              bookmakerWeightOverride,
            }),

          accumulator:
            buildMultiGoalAccumulator(
              allCandidates,
              10,
            ),
        });

      return res.json({
        ok: true,

        feature:
          'PREDICT Multiple Multigol',

        mode:
          'international',

        generatedAt:
          new Date()
            .toISOString(),

        providerCallsAllowed:
          providerAllowed,

        date:
          internationalDate,

        note:
          'Multiple Multigol Internazionali 3X, 5X e 10X: combina le migliori selezioni disponibili nella cache PREDICT del prossimo turno futuro di ciascuno dei 5 campionati nazionali. Nessuna chiamata provider viene generata dagli utenti.',

        roundSignature:
          internationalRoundSignature,

        leagues:
          leaguePreviews,

        candidateCount:
          allCandidates.length,

        multigol3,

        multigol5,

        multigol10,

        candidates:
          allCandidates,

        skipped,
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
// STORICO UFFICIALE MULTIPLE MULTIGOL
// ====================================================
//
// Solo snapshot COMPLETI e CONGELATI.
// refresh=0 usa esclusivamente cache/stato centrale/archivi permanenti.
// Nessuna nuova chiamata Highlightly viene avviata.

app.get(
  '/api/football/multigoal-history',
  async (req, res) => {
    try {
      await importCurrentMultiGoalSnapshotsIntoHistory();

      const index =
        await getPermanentCache(
          MULTIGOAL_HISTORY_INDEX_KEY,
        );

      const entries =
        Array.isArray(
          index?.items,
        )
          ? index.items
          : [];

      const records = [];

      for (
        const entry
          of entries
      ) {
        const record =
          await getPermanentCache(
            entry.archiveKey,
          );

        if (
          !record ||
          record?.accumulator
            ?.frozen !== true ||
          record?.accumulator
            ?.ready !== true
        ) {
          continue;
        }

        const settled =
          await settleMultiGoalHistoryRecord(
            record,
          );

        records.push(
          settled,
        );
      }

      records.sort(
        (a, b) =>
          Date.parse(
            b?.frozenAt ??
            b?.date ??
            '',
          ) -
          Date.parse(
            a?.frozenAt ??
            a?.date ??
            '',
          ),
      );

      res.json({
        ok: true,

        feature:
          'PREDICT Multigol History',

        generatedAt:
          new Date()
            .toISOString(),

        providerCallsAllowed:
          false,

        note:
          'Storico permanente delle sole Multiple Multigol complete e congelate. Verifica risultati in modalità cache-only.',

        summary:
          buildMultiGoalHistorySummary(
            records,
          ),

        records,
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
    'matchday-multiples-snapshot-v4-p95-b5',
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

  const archived =
    await getCompatiblePermanentMultipleArchive({
      season,
      historicalSeason,
      round,
      leagueName,
      countryName,
    });

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
      (a, b) => {
        const aStrength =
          Number(
            a?.pick?.signalStrength,
          );

        const bStrength =
          Number(
            b?.pick?.signalStrength,
          );

        const aHasStrength =
          Number.isFinite(
            aStrength,
          );

        const bHasStrength =
          Number.isFinite(
            bStrength,
          );

        // Le multiple seguono lo stesso criterio del nuovo Top Signal:
        // prima la forza relativa normalizzata tra famiglie diverse.
        if (
          aHasStrength &&
          bHasStrength &&
          Math.abs(
            bStrength -
            aStrength,
          ) > 0.000001
        ) {
          return (
            bStrength -
            aStrength
          );
        }

        if (
          bHasStrength &&
          !aHasStrength
        ) {
          return 1;
        }

        if (
          aHasStrength &&
          !bHasStrength
        ) {
          return -1;
        }

        // Compatibilità con eventuali snapshot vecchi privi di signalStrength.
        return (
          Number(
            b?.pick?.probability ?? 0,
          ) -
          Number(
            a?.pick?.probability ?? 0,
          )
        );
      },
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
  historicalSeason = null,
  leagueName = null,
  countryName = null,
}) {
  if (
    !accumulator?.ready ||
    !Array.isArray(
      accumulator.selections,
    )
  ) {
    return accumulator;
  }

  // L'esito complessivo di una multipla già PRESA o SBAGLIATA resta definitivo,
  // ma continuiamo ad aggiornare le singole selezioni non ancora settled.
  // In questo modo lo storico arriva sempre al dettaglio completo senza
  // modificare pronostici congelati, ordine o settledAt originale.

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

    // Se il pronostico singolo di questa partita è già stato verificato
    // nello storico permanente, riutilizziamo quel risultato.
    // Nessuna chiamata al provider.
    if (
      result?.settled !== true &&
      historicalSeason !== null &&
      leagueName &&
      countryName &&
      selection?.matchId !==
        undefined &&
      selection?.matchId !==
        null
    ) {
      const permanentPickRecord =
        await getPermanentMatchdayPickRecord({
          matchId:
            selection.matchId,
          historicalSeason,
          leagueName,
          countryName,
        });

      if (
        permanentPickRecord
          ?.result
          ?.settled === true
      ) {
        result = {
          ...permanentPickRecord
            .result,
        };
      }
    }

    if (
      match &&
      result?.settled !== true
    ) {
      try {
        result =
          await evaluateMatchdayPick(
            match,
            selection?.pick,
            {
              allowProvider,
            },
          );
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
    await getCompatiblePermanentMultipleArchive({
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
      historicalSeason:
        snapshot.historicalSeason,
      leagueName:
        snapshot.leagueName,
      countryName:
        snapshot.countryName,
    });

  const multipla5 =
    await evaluateFrozenMultipleAccumulator({
      accumulator:
        snapshot.multipla5,
      roundMatches,
      allowProvider,
      historicalSeason:
        snapshot.historicalSeason,
      leagueName:
        snapshot.leagueName,
      countryName:
        snapshot.countryName,
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

  if (
    !supportsRoundBasedFeatures(
      supportedLeague,
    )
  ) {
    throw new Error(
      `Funzioni per giornata non disponibili per ${supportedLeague.leagueName}`,
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
    const archived =
      await getCompatiblePermanentMultipleArchive({
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

async function buildAndPersistUefaMultiplesSummary({
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

  if (
    !supportedLeague ||
    supportedLeague.isCup !== true
  ) {
    throw new Error(
      `Coppa UEFA non supportata: ${leagueName} / ${countryName}`,
    );
  }

  const state =
    centralUefaCupStateOf(
      supportedLeague,
    );

  // Le date attualmente caricate dal calendario centrale non bastano
  // per costruire lo storico completo: le vecchie date UEFA possono
  // non essere più presenti in state.byDate.
  //
  // Partiamo dalle date correnti e aggiungiamo tutte le date realmente
  // archiviate nel cache disk permanente. Nessuna chiamata provider.
  const archivedRounds =
    new Set();

  for (
    const dateKey
      of Array.from(
        state?.byDate?.keys?.() ??
          [],
      )
  ) {
    const round =
      Number(
        String(
          dateKey,
        ).replace(
          /-/g,
          '',
        ),
      );

    if (
      Number.isFinite(
        round,
      )
    ) {
      archivedRounds.add(
        round,
      );
    }
  }

  try {
    const fileNames =
      await fs.readdir(
        CACHE_DIR,
      );

    const currentPrefix =
      `${sanitizeCachePart(
        [
          'matchday-multiples-history-v2-strength',
          season,
          historicalSeason,
        ].join('-'),
      )}-`;

    const legacyPrefix =
      `${sanitizeCachePart(
        [
          'matchday-multiples-history-v1',
          season,
          historicalSeason,
        ].join('-'),
      )}-`;

    const cupDatePrefix =
      `${sanitizeCachePart(
        [
          'matchday-picks-cup-date-history-v2-multiples',
          season,
          historicalSeason,
        ].join('-'),
      )}-`;

    const suffix =
      `-${sanitizeCachePart(
        supportedLeague
          .leagueName,
      )}-${sanitizeCachePart(
        supportedLeague
          .countryName,
      )}.json`;

    for (
      const fileName
        of fileNames
    ) {
      for (
        const prefix
          of [
            currentPrefix,
            legacyPrefix,
            cupDatePrefix,
          ]
      ) {
        if (
          !fileName.startsWith(
            prefix,
          ) ||
          !fileName.endsWith(
            suffix,
          )
        ) {
          continue;
        }

        const roundPart =
          fileName.slice(
            prefix.length,
            fileName.length -
              suffix.length,
          );

        const round =
          Number(
            String(
              roundPart,
            ).replace(
              /-/g,
              '',
            ),
          );

        if (
          Number.isFinite(
            round,
          )
        ) {
          archivedRounds.add(
            round,
          );
        }
      }
    }
  } catch (error) {
    if (
      error?.code !==
      'ENOENT'
    ) {
      console.warn(
        `Riepilogo UEFA ${supportedLeague.leagueName}: impossibile leggere archivio cache:`,
        error?.message ??
          error,
      );
    }
  }

  const rounds =
    Array.from(
      archivedRounds,
    ).sort(
      (a, b) =>
        a - b,
    );

  const multipla3 =
    emptyMultipleSummary();

  const multipla5 =
    emptyMultipleSummary();

  let officialRounds = 0;

  for (
    const round
      of rounds
  ) {
    let archived =
      await getCompatiblePermanentMultipleArchive({
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

    // Compatibilità con le prime multiple UEFA:
    // alcune date erano state archiviate nel payload storico della data
    // prima dell'introduzione dell'archivio dedicato delle multiple.
    if (
      !archived?.frozen ||
      !archived?.available
    ) {
      const roundText =
        String(round)
          .padStart(
            8,
            '0',
          );

      if (
        roundText.length ===
        8
      ) {
        const dateKey =
          `${roundText.slice(
            0,
            4,
          )}-${roundText.slice(
            4,
            6,
          )}-${roundText.slice(
            6,
            8,
          )}`;

        const cupDateHistoryKey =
          [
            'matchday-picks-cup-date-history-v2-multiples',
            season,
            historicalSeason,
            dateKey,
            supportedLeague
              .leagueName,
            supportedLeague
              .countryName,
          ].join('-');

        const cupDateArchive =
          await getPermanentCache(
            cupDateHistoryKey,
          );

        if (
          cupDateArchive
            ?.multiples
            ?.frozen === true &&
          cupDateArchive
            ?.multiples
            ?.available === true
        ) {
          archived =
            cupDateArchive
              .multiples;
        }
      }
    }

    if (
      !archived?.frozen ||
      !archived?.available
    ) {
      continue;
    }

    officialRounds += 1;

    addMultipleToSummary(
      multipla3,
      archived.multipla3,
    );

    addMultipleToSummary(
      multipla5,
      archived.multipla5,
    );
  }

  // Baseline storico Champions League 2026:
  // prima dell'archivio UEFA attuale risultano già 2 multiple 3X vinte
  // e 2 multiple 5X vinte. Usiamo un minimo storico, non un incremento,
  // così un eventuale archivio recuperato in futuro non crea doppioni.
  const championsLegacyBaseline =
    String(
      supportedLeague
        .leagueName,
    ) ===
      'Champions League' &&
    String(season) ===
      '2026' &&
    String(
      historicalSeason,
    ) ===
      '2025';

  if (
    championsLegacyBaseline
  ) {
    multipla3.won =
      Math.max(
        multipla3.won,
        2,
      );

    multipla3.verified =
      Math.max(
        multipla3.verified,
        2,
      );

    multipla5.won =
      Math.max(
        multipla5.won,
        2,
      );

    multipla5.verified =
      Math.max(
        multipla5.verified,
        2,
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
    regularSeasonRounds:
      null,
    generatedAt:
      new Date()
        .toISOString(),
    officialRounds,
    officialDates:
      officialRounds,
    dateBased:
      true,
    legacyBaselineApplied:
      championsLegacyBaseline,
    multipla3,
    multipla5,
  };

  const summaryKey =
    buildSeasonMultiplesSummaryArchiveKey({
      season,
      historicalSeason,
      leagueName:
        supportedLeague
          .leagueName,
      countryName:
        supportedLeague
          .countryName,
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

  if (
    !supportsRoundBasedFeatures(
      supportedLeague,
    )
  ) {
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
      allowProviderFallback:
        allowProvider,
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
    const archived =
      await getCompatiblePermanentMultipleArchive({
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
      'Multipla PREDICT costruita con una sola selezione per partita e ordinata per forza relativa normalizzata del Top Signal. Multipla 3 e Multipla 5 vengono congelate insieme 4 ore prima della prima partita della giornata.',

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



// ====================================================
// MULTIPLE INTERNAZIONALI 3X / 5X - STORICO PERMANENTE
// ====================================================
//
// Usa esclusivamente lo stato centrale/cache PREDICT dei 5 campionati.
// Nessuna chiamata Highlightly viene avviata da queste funzioni.
// L'algoritmo resta identico al client:
// - migliore pronostico di ogni campionato per probabilità
// - 3X = i 3 migliori tra i 5
// - 5X = uno per ciascuno dei 5 campionati
// Il congelamento avviene al primo cutoff tra i 5 campionati.

function buildInternationalMultipleSnapshotCacheKey({
  season,
  historicalSeason,
  roundSignature,
}) {
  return [
    'international-multiples-snapshot-v1',
    season,
    historicalSeason,
    roundSignature,
  ].join('-');
}

function buildInternationalMultipleArchiveKey({
  season,
  historicalSeason,
  roundSignature,
}) {
  return [
    'international-multiples-history-v1',
    season,
    historicalSeason,
    roundSignature,
  ].join('-');
}

function buildInternationalMultipleHistoryIndexKey({
  season,
  historicalSeason,
}) {
  return [
    'international-multiples-history-index-v1',
    season,
    historicalSeason,
  ].join('-');
}

function buildInternationalMultipleSummaryKey({
  season,
  historicalSeason,
}) {
  return [
    'international-multiples-summary-v1',
    season,
    historicalSeason,
  ].join('-');
}

function resolveCentralDefaultRoundForInternational(
  league,
) {
  const state =
    centralLeagueStateOf(
      league,
    );

  const seasonMatches =
    Array.isArray(
      state?.matches,
    )
      ? state.matches
      : [];

  if (seasonMatches.length === 0) {
    return null;
  }

  const regularSeasonRounds =
    Number(
      league?.regularSeasonRounds,
    ) || 38;

  const nowMs =
    Date.now();

  const relevanceCutoffMs =
    nowMs -
    24 * 60 * 60 * 1000;

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
          unfinishedMatches: 0,
          relevantUnfinishedDates: [],
        },
      );
    }

    const roundData =
      roundsMap.get(
        round,
      );

    roundData.scheduledMatches +=
      1;

    if (
      isFinishedMatch(
        match,
      )
    ) {
      roundData.finishedMatches +=
        1;
      continue;
    }

    roundData.unfinishedMatches +=
      1;

    const startMs =
      Date.parse(
        match?.date ?? '',
      );

    if (
      Number.isFinite(
        startMs,
      ) &&
      startMs >=
        relevanceCutoffMs
    ) {
      roundData
        .relevantUnfinishedDates
        .push(
          startMs,
        );
    }
  }

  const rounds =
    Array.from(
      roundsMap.values(),
    )
      .filter(
        (roundData) =>
          roundData
            .scheduledMatches >
          0,
      )
      .map(
        (roundData) => {
          const completed =
            roundData
              .finishedMatches ===
            roundData
              .scheduledMatches;

          const nextRelevantAtMs =
            roundData
              .relevantUnfinishedDates
              .length >
            0
              ? Math.min(
                  ...roundData
                    .relevantUnfinishedDates,
                )
              : null;

          return {
            ...roundData,
            completed,
            nextRelevantAtMs,
          };
        },
      )
      .sort(
        (a, b) =>
          a.round -
          b.round,
      );

  const relevantCandidates =
    rounds
      .filter(
        (roundData) =>
          !roundData.completed &&
          Number.isFinite(
            roundData
              .nextRelevantAtMs,
          ),
      )
      .sort(
        (a, b) => {
          const dateDiff =
            a.nextRelevantAtMs -
            b.nextRelevantAtMs;

          if (dateDiff !== 0) {
            return dateDiff;
          }

          return (
            a.round -
            b.round
          );
        },
      );

  if (
    relevantCandidates.length >
    0
  ) {
    return (
      relevantCandidates[0]
        .round
    );
  }

  const incompleteRounds =
    rounds
      .filter(
        (roundData) =>
          !roundData.completed &&
          roundData
            .unfinishedMatches >
          0,
      )
      .sort(
        (a, b) =>
          a.round -
          b.round,
      );

  if (
    incompleteRounds.length >
    0
  ) {
    return (
      incompleteRounds[0]
        .round
    );
  }

  if (rounds.length > 0) {
    return (
      rounds[
        rounds.length - 1
      ].round
    );
  }

  return null;
}

function sortInternationalCandidates(
  candidates,
) {
  return [
    ...(candidates ?? []),
  ].sort(
    (a, b) => {
      const probabilityCompare =
        Number(
          b?.pick?.probability ??
          0,
        ) -
        Number(
          a?.pick?.probability ??
          0,
        );

      if (
        Math.abs(
          probabilityCompare,
        ) >
        0.000001
      ) {
        return probabilityCompare;
      }

      return (
        Number(
          b?.pick?.signalStrength ??
          0,
        ) -
        Number(
          a?.pick?.signalStrength ??
          0,
        )
      );
    },
  );
}

function buildInternationalMultipleFromCandidates(
  candidates,
  requestedEvents,
) {
  const selections =
    (candidates ?? [])
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

          season:
            item?.season ?? null,

          historicalSeason:
            item?.historicalSeason ?? null,

          round:
            item?.round ?? null,

          leagueName:
            item?.leagueName ?? null,

          countryName:
            item?.countryName ?? null,

          result:
            item?.result ?? {
              status:
                'pending',
              settled:
                false,
            },
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

    result:
      buildMultipleResultSummary({
        selections,
      }),
  };
}

async function buildInternationalMultipleCandidateState({
  season =
    CURRENT_SERIE_A_SEASON,
  historicalSeason =
    '2025',
} = {}) {
  const bestByLeague =
    [];

  const freezeDates =
    [];

  const firstMatchDates =
    [];

  const roundParts =
    [];

  const leagues =
    [];

  for (
    const league
      of CENTRAL_DOMESTIC_LEAGUES
  ) {
    const round =
      resolveCentralDefaultRoundForInternational(
        league,
      );

    if (
      !round ||
      round < 1
    ) {
      roundParts.push(
        `${league.key}:0`,
      );

      leagues.push({
        leagueName:
          league.leagueName,
        countryName:
          league.countryName,
        round:
          null,
        candidate:
          false,
      });

      continue;
    }

    roundParts.push(
      `${league.key}:${round}`,
    );

    const state =
      centralLeagueStateOf(
        league,
      );

    const roundMatches =
      (state?.matches ?? [])
        .filter(
          (match) =>
            roundNumberOf(
              match,
            ) ===
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

    const validStarts =
      roundMatches
        .map(
          (match) =>
            Date.parse(
              match?.date ?? '',
            ),
        )
        .filter(
          (value) =>
            Number.isFinite(
              value,
            ),
        )
        .sort(
          (a, b) =>
            a - b,
        );

    if (
      validStarts.length >
      0
    ) {
      const firstMatchAtMs =
        validStarts[0];

      firstMatchDates.push(
        firstMatchAtMs,
      );

      freezeDates.push(
        firstMatchAtMs -
        MATCHDAY_MULTIPLE_FREEZE_WINDOW,
      );
    }

    const leagueCandidates =
      [];

    for (
      const match
        of roundMatches
    ) {
      const pickSnapshot =
        await getExistingMatchdayPickSnapshot({
          matchId:
            match?.id,
          historicalSeason:
            league.historicalSeason ??
            historicalSeason,
          leagueName:
            league.leagueName,
          countryName:
            league.countryName,
        });

      const probability =
        Number(
          pickSnapshot
            ?.pick
            ?.probability,
        );

      if (
        !pickSnapshot?.pick ||
        !Number.isFinite(
          probability,
        )
      ) {
        continue;
      }

      leagueCandidates.push({
        matchId:
          match?.id ?? null,

        date:
          match?.date ?? null,

        homeTeam:
          match?.homeTeam ?? null,

        awayTeam:
          match?.awayTeam ?? null,

        pick:
          pickSnapshot.pick,

        pickGeneratedAt:
          pickSnapshot
            .generatedAt ??
          null,

        modelVersion:
          pickSnapshot
            .modelVersion ??
          'PREDICT v5',

        season:
          league.currentSeason ??
          season,

        historicalSeason:
          league.historicalSeason ??
          historicalSeason,

        round,

        leagueName:
          league.leagueName,

        countryName:
          league.countryName,
      });
    }

    const rankedLeagueCandidates =
      sortInternationalCandidates(
        leagueCandidates,
      );

    if (
      rankedLeagueCandidates
        .length >
      0
    ) {
      bestByLeague.push(
        rankedLeagueCandidates[0],
      );
    }

    leagues.push({
      leagueName:
        league.leagueName,
      countryName:
        league.countryName,
      round,
      candidate:
        rankedLeagueCandidates
          .length >
        0,
      candidateMatchId:
        rankedLeagueCandidates[0]
          ?.matchId ??
        null,
    });
  }

  const ranked =
    sortInternationalCandidates(
      bestByLeague,
    );

  return {
    season:
      String(season),

    historicalSeason:
      String(
        historicalSeason,
      ),

    roundSignature:
      roundParts.join('|'),

    candidateCount:
      ranked.length,

    candidates:
      ranked,

    freezeAtMs:
      freezeDates.length >
      0
        ? Math.min(
            ...freezeDates,
          )
        : null,

    firstMatchAtMs:
      firstMatchDates.length >
      0
        ? Math.min(
            ...firstMatchDates,
          )
        : null,

    leagues,
  };
}

async function getExistingInternationalMultipleSnapshot({
  season,
  historicalSeason,
  roundSignature,
}) {
  const archiveKey =
    buildInternationalMultipleArchiveKey({
      season,
      historicalSeason,
      roundSignature,
    });

  const archived =
    await getPermanentCache(
      archiveKey,
    );

  if (
    archived?.frozen ===
      true &&
    archived?.available ===
      true
  ) {
    return archived;
  }

  const cacheKey =
    buildInternationalMultipleSnapshotCacheKey({
      season,
      historicalSeason,
      roundSignature,
    });

  const memory =
    getMemoryCache(
      cacheKey,
      MATCHDAY_MULTIPLE_SNAPSHOT_CACHE_TIME,
    );

  if (memory) {
    return memory;
  }

  const disk =
    await getDiskCache(
      cacheKey,
      MATCHDAY_MULTIPLE_SNAPSHOT_CACHE_TIME,
    );

  if (disk) {
    setMemoryCache(
      cacheKey,
      disk,
    );

    return disk;
  }

  return null;
}

async function persistOfficialInternationalMultipleSnapshot(
  snapshot,
) {
  if (
    !snapshot?.frozen ||
    !snapshot?.available ||
    !snapshot?.roundSignature
  ) {
    return snapshot;
  }

  const archiveKey =
    buildInternationalMultipleArchiveKey({
      season:
        snapshot.season,
      historicalSeason:
        snapshot.historicalSeason,
      roundSignature:
        snapshot.roundSignature,
    });

  const existing =
    await getPermanentCache(
      archiveKey,
    );

  if (
    existing?.frozen ===
      true &&
    existing?.available ===
      true
  ) {
    return existing;
  }

  const archived = {
    ...snapshot,

    archiveKey,

    archivedAt:
      new Date()
        .toISOString(),
  };

  await setPermanentCache(
    archiveKey,
    archived,
  );

  const indexKey =
    buildInternationalMultipleHistoryIndexKey({
      season:
        snapshot.season,
      historicalSeason:
        snapshot.historicalSeason,
    });

  const currentIndex =
    await getPermanentCache(
      indexKey,
    );

  const items =
    Array.isArray(
      currentIndex?.items,
    )
      ? [
          ...currentIndex.items,
        ]
      : [];

  if (
    !items.some(
      (item) =>
        item?.archiveKey ===
        archiveKey,
    )
  ) {
    items.push({
      archiveKey,

      roundSignature:
        snapshot.roundSignature,

      frozenAt:
        snapshot.frozenAt ??
        snapshot.generatedAt ??
        null,

      freezeAt:
        snapshot.freezeAt ??
        null,
    });
  }

  await setPermanentCache(
    indexKey,
    {
      version:
        1,

      updatedAt:
        new Date()
          .toISOString(),

      items,
    },
  );

  return archived;
}

async function getOrUpdateInternationalMultiplesSnapshot({
  season =
    CURRENT_SERIE_A_SEASON,
  historicalSeason =
    '2025',
} = {}) {
  const state =
    await buildInternationalMultipleCandidateState({
      season,
      historicalSeason,
    });

  const {
    roundSignature,
    candidates,
    candidateCount,
    freezeAtMs,
    firstMatchAtMs,
    leagues,
  } = state;

  if (
    !roundSignature ||
    !Number.isFinite(
      freezeAtMs,
    )
  ) {
    return {
      available:
        false,

      season:
        String(season),

      historicalSeason:
        String(
          historicalSeason,
        ),

      international:
        true,

      roundSignature,

      candidateCount,

      frozen:
        false,

      status:
        'unavailable',

      reason:
        'Cache PREDICT dei campionati non ancora sufficiente per la multipla internazionale.',

      leagues,

      multipla3:
        buildInternationalMultipleFromCandidates(
          candidates,
          3,
        ),

      multipla5:
        buildInternationalMultipleFromCandidates(
          candidates,
          5,
        ),
    };
  }

  const cacheKey =
    buildInternationalMultipleSnapshotCacheKey({
      season,
      historicalSeason,
      roundSignature,
    });

  const existing =
    await getExistingInternationalMultipleSnapshot({
      season,
      historicalSeason,
      roundSignature,
    });

  const existingReady =
    existing?.multipla3
      ?.ready === true &&
    existing?.multipla5
      ?.ready === true;

  if (
    existing?.frozen ===
      true &&
    existingReady
  ) {
    return await persistOfficialInternationalMultipleSnapshot(
      existing,
    );
  }

  const now =
    Date.now();

  if (
    Number.isFinite(
      firstMatchAtMs,
    ) &&
    now >=
      firstMatchAtMs &&
    !existingReady &&
    candidateCount < 5
  ) {
    return {
      available:
        false,

      season:
        String(season),

      historicalSeason:
        String(
          historicalSeason,
        ),

      international:
        true,

      roundSignature,

      candidateCount,

      generatedAt:
        new Date()
          .toISOString(),

      firstMatchAt:
        new Date(
          firstMatchAtMs,
        ).toISOString(),

      freezeAt:
        new Date(
          freezeAtMs,
        ).toISOString(),

      frozen:
        false,

      status:
        'closed',

      reason:
        'Nessuna multipla internazionale completa era disponibile prima dell’inizio del primo evento.',

      leagues,

      multipla3:
        buildInternationalMultipleFromCandidates(
          candidates,
          3,
        ),

      multipla5:
        buildInternationalMultipleFromCandidates(
          candidates,
          5,
        ),
    };
  }

  if (
    now >=
      freezeAtMs &&
    existingReady
  ) {
    const frozenSnapshot = {
      ...existing,

      available:
        true,

      international:
        true,

      frozen:
        true,

      status:
        'frozen',

      frozenAt:
        existing?.frozenAt ??
        new Date(now)
          .toISOString(),

      freezeAt:
        existing?.freezeAt ??
        new Date(
          freezeAtMs,
        ).toISOString(),

      firstMatchAt:
        existing?.firstMatchAt ??
        (
          Number.isFinite(
            firstMatchAtMs,
          )
            ? new Date(
                firstMatchAtMs,
              ).toISOString()
            : null
        ),
    };

    setMemoryCache(
      cacheKey,
      frozenSnapshot,
    );

    await setDiskCache(
      cacheKey,
      frozenSnapshot,
    );

    return await persistOfficialInternationalMultipleSnapshot(
      frozenSnapshot,
    );
  }

  const generatedAt =
    new Date()
      .toISOString();

  const snapshot = {
    available:
      candidateCount >=
      3,

    season:
      String(season),

    historicalSeason:
      String(
        historicalSeason,
      ),

    international:
      true,

    leagueName:
      'Multiple Internazionali',

    countryName:
      '__international__',

    roundSignature,

    candidateCount,

    generatedAt,

    firstMatchAt:
      Number.isFinite(
        firstMatchAtMs,
      )
        ? new Date(
            firstMatchAtMs,
          ).toISOString()
        : null,

    freezeAt:
      new Date(
        freezeAtMs,
      ).toISOString(),

    freezeHoursBeforeFirstMatch:
      MATCHDAY_MULTIPLE_FREEZE_WINDOW /
      (60 * 60 * 1000),

    frozen:
      now >=
        freezeAtMs &&
      candidateCount >=
        5,

    status:
      now >=
          freezeAtMs &&
        candidateCount >=
          5
        ? 'frozen'
        : (
            now >=
              freezeAtMs
              ? 'preparing-freeze'
              : 'provisional'
          ),

    frozenAt:
      now >=
          freezeAtMs &&
        candidateCount >=
          5
        ? generatedAt
        : null,

    description:
      'Multipla Internazionale PREDICT: migliore pronostico di ciascuno dei 5 campionati nazionali; 3X con i 3 migliori, 5X con uno per ogni campionato. Solo cache PREDICT.',

    leagues,

    multipla3:
      buildInternationalMultipleFromCandidates(
        candidates,
        3,
      ),

    multipla5:
      buildInternationalMultipleFromCandidates(
        candidates,
        5,
      ),
  };

  setMemoryCache(
    cacheKey,
    snapshot,
  );

  await setDiskCache(
    cacheKey,
    snapshot,
  );

  if (snapshot.frozen) {
    return await persistOfficialInternationalMultipleSnapshot(
      snapshot,
    );
  }

  return snapshot;
}

async function evaluateFrozenInternationalMultipleAccumulator(
  accumulator,
) {
  if (
    !accumulator?.ready ||
    !Array.isArray(
      accumulator?.selections,
    )
  ) {
    return accumulator;
  }

  const selections =
    [];

  for (
    const selection
      of accumulator.selections
  ) {
    let result =
      selection?.result ?? {
        status:
          'pending',
        settled:
          false,
      };

    if (
      result?.settled !==
        true &&
      selection?.matchId !==
        null &&
      selection?.matchId !==
        undefined &&
      selection?.historicalSeason &&
      selection?.leagueName &&
      selection?.countryName
    ) {
      const permanentPickRecord =
        await getPermanentMatchdayPickRecord({
          matchId:
            selection.matchId,

          historicalSeason:
            selection.historicalSeason,

          leagueName:
            selection.leagueName,

          countryName:
            selection.countryName,
        });

      if (
        permanentPickRecord
          ?.result
          ?.settled === true
      ) {
        result = {
          ...permanentPickRecord
            .result,
        };
      }
    }

    if (
      result?.settled !==
        true
    ) {
      const entry =
        centralFindMatchEntryById(
          selection?.matchId,
        );

      if (entry?.match) {
        try {
          result =
            await evaluateMatchdayPick(
              entry.match,
              selection?.pick,
              {
                allowProvider:
                  false,
              },
            );
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
        (
          summary.settled
            ? new Date()
                .toISOString()
            : null
        ),

      updatedAt:
        new Date()
          .toISOString(),
    },
  };
}

async function settleAndPersistInternationalMultipleSnapshot(
  snapshot,
) {
  if (
    !snapshot?.frozen ||
    !snapshot?.available ||
    !snapshot?.archiveKey
  ) {
    return snapshot;
  }

  const multipla3 =
    await evaluateFrozenInternationalMultipleAccumulator(
      snapshot.multipla3,
    );

  const multipla5 =
    await evaluateFrozenInternationalMultipleAccumulator(
      snapshot.multipla5,
    );

  const updated = {
    ...snapshot,

    updatedAt:
      new Date()
        .toISOString(),

    multipla3,

    multipla5,
  };

  await setPermanentCache(
    snapshot.archiveKey,
    updated,
  );

  return updated;
}

async function buildAndPersistInternationalMultiplesSummary({
  season =
    CURRENT_SERIE_A_SEASON,
  historicalSeason =
    '2025',
} = {}) {
  const indexKey =
    buildInternationalMultipleHistoryIndexKey({
      season,
      historicalSeason,
    });

  const index =
    await getPermanentCache(
      indexKey,
    );

  const items =
    Array.isArray(
      index?.items,
    )
      ? index.items
      : [];

  const multipla3 =
    emptyMultipleSummary();

  const multipla5 =
    emptyMultipleSummary();

  let officialRounds =
    0;

  for (
    const item
      of items
  ) {
    const record =
      await getPermanentCache(
        item?.archiveKey,
      );

    if (
      !record?.frozen ||
      !record?.available
    ) {
      continue;
    }

    const settled =
      await settleAndPersistInternationalMultipleSnapshot(
        record,
      );

    officialRounds +=
      1;

    addMultipleToSummary(
      multipla3,
      settled?.multipla3,
    );

    addMultipleToSummary(
      multipla5,
      settled?.multipla5,
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
      summary.verified >
        0
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
      'Multiple Internazionali',

    countryName:
      '__international__',

    international:
      true,

    generatedAt:
      new Date()
        .toISOString(),

    officialRounds,

    officialDates:
      officialRounds,

    dateBased:
      true,

    multipla3,

    multipla5,
  };

  await setPermanentCache(
    buildInternationalMultipleSummaryKey({
      season,
      historicalSeason,
    }),
    payload,
  );

  return payload;
}

async function settlePermanentInternationalMultipleHistory({
  season =
    CURRENT_SERIE_A_SEASON,
  historicalSeason =
    '2025',
} = {}) {
  // Prima aggiorna/congela lo snapshot corrente usando solo la cache PREDICT.
  await getOrUpdateInternationalMultiplesSnapshot({
    season,
    historicalSeason,
  });

  // Poi verifica gli archivi già congelati e aggiorna il riepilogo.
  return await buildAndPersistInternationalMultiplesSummary({
    season,
    historicalSeason,
  });
}


async function precomputeUpcomingMatchdayMultiples() {
  const now =
    Date.now();

  const groups =
    new Map();

  for (
    const {
      match,
      league,
    } of centralDomesticEntries()
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

    const key =
      `${league.key}:${numericRound}`;

    if (!groups.has(key)) {
      groups.set(
        key,
        {
          league,
          round:
            numericRound,
        },
      );
    }
  }

  for (
    const {
      league,
      round,
    } of groups.values()
  ) {
    const state =
      centralLeagueStateOf(
        league,
      );

    const roundMatches =
      (state?.matches ?? [])
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
            league.historicalSeason,
          leagueName:
            league.leagueName,
          countryName:
            league.countryName,
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
        league.currentSeason,
      historicalSeason:
        league.historicalSeason,
      round,
      leagueName:
        league.leagueName,
      countryName:
        league.countryName,
      roundMatches,
      picks,
    });

    const aggregatePrefix =
      league.key === 'serie-a'
        ? matchdayPicksAggregatePrefixForRound(
            round,
          )
        : `${matchdayPicksAggregatePrefixForRound(
            round,
          )}-real-results-v1`;

    await deleteCacheKey(
      [
        aggregatePrefix,
        league.currentSeason,
        league.historicalSeason,
        round,
        league.leagueName,
        league.countryName,
      ].join('-'),
    );
  }
}


function predictRomeDateKey(
  value,
) {
  const parsed =
    new Date(value);

  if (
    Number.isNaN(
      parsed.getTime(),
    )
  ) {
    return null;
  }

  const parts =
    new Intl.DateTimeFormat(
      'en-GB',
      {
        timeZone:
          'Europe/Rome',
        year:
          'numeric',
        month:
          '2-digit',
        day:
          '2-digit',
      },
    ).formatToParts(
      parsed,
    );

  const values =
    Object.fromEntries(
      parts.map(
        (part) => [
          part.type,
          part.value,
        ],
      ),
    );

  return (
    `${values.year}-` +
    `${values.month}-` +
    `${values.day}`
  );
}


app.get(
  '/api/football/default-matchday',
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
          // Endpoint pubblico: solo stato centrale/cache PREDICT.
          // Mai fallback Highlightly provocato dall'utente.
          allowProviderFallback:
            false,
        });

      if (seasonMatches.length === 0) {
        return res
          .status(503)
          .json({
            error:
              'Cache PREDICT del campionato non ancora pronta',
            retryLater:
              true,
            providerCallsAllowed:
              false,
            season:
              String(season),
            leagueName:
              supportedLeague
                .leagueName,
            countryName:
              supportedLeague
                .countryName,
          });
      }

      const nowMs =
        Date.now();

      // Manteniamo rilevanti anche gare già iniziate oggi / nelle ultime ore.
      // Questo permette di restare sulla giornata mentre un match è in corso,
      // senza farsi "catturare" da vecchie gare sospese con una data ormai remota.
      const relevanceCutoffMs =
        nowMs -
        24 * 60 * 60 * 1000;

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
              unfinishedMatches: 0,
              relevantUnfinishedDates: [],
            },
          );
        }

        const roundData =
          roundsMap.get(round);

        roundData.scheduledMatches +=
          1;

        if (
          isFinishedMatch(
            match,
          )
        ) {
          roundData.finishedMatches +=
            1;
          continue;
        }

        roundData.unfinishedMatches +=
          1;

        const startMs =
          Date.parse(
            match?.date ?? '',
          );

        if (
          Number.isFinite(
            startMs,
          ) &&
          startMs >=
            relevanceCutoffMs
        ) {
          roundData
            .relevantUnfinishedDates
            .push(
              startMs,
            );
        }
      }

      const rounds =
        Array.from(
          roundsMap.values(),
        )
          .filter(
            (roundData) =>
              roundData
                .scheduledMatches >
              0,
          )
          .map(
            (roundData) => {
              const completed =
                roundData
                  .finishedMatches ===
                roundData
                  .scheduledMatches;

              const nextRelevantAtMs =
                roundData
                  .relevantUnfinishedDates
                  .length >
                0
                  ? Math.min(
                      ...roundData
                        .relevantUnfinishedDates,
                    )
                  : null;

              return {
                round:
                  roundData.round,
                scheduledMatches:
                  roundData
                    .scheduledMatches,
                finishedMatches:
                  roundData
                    .finishedMatches,
                unfinishedMatches:
                  roundData
                    .unfinishedMatches,
                completed,
                nextRelevantAtMs,
              };
            },
          )
          .sort(
            (a, b) =>
              a.round -
              b.round,
          );

      const relevantCandidates =
        rounds
          .filter(
            (roundData) =>
              !roundData.completed &&
              Number.isFinite(
                roundData
                  .nextRelevantAtMs,
              ),
          )
          .sort(
            (a, b) => {
              const dateDiff =
                a.nextRelevantAtMs -
                b.nextRelevantAtMs;

              if (dateDiff !== 0) {
                return dateDiff;
              }

              return (
                a.round -
                b.round
              );
            },
          );

      let selectedRound = null;
      let reason =
        'fallback';

      if (
        relevantCandidates
          .length >
        0
      ) {
        selectedRound =
          relevantCandidates[0]
            .round;

        const selectedData =
          relevantCandidates[0];

        reason =
          selectedData
            .nextRelevantAtMs <=
          nowMs
            ? 'current-round-in-progress'
            : 'next-upcoming-round';
      }

      if (!selectedRound) {
        const incompleteRounds =
          rounds
            .filter(
              (roundData) =>
                !roundData.completed &&
                roundData
                  .unfinishedMatches >
                0,
            )
            .sort(
              (a, b) =>
                a.round -
                b.round,
            );

        if (
          incompleteRounds
            .length >
          0
        ) {
          selectedRound =
            incompleteRounds[0]
              .round;
          reason =
            'first-incomplete-round';
        }
      }

      if (!selectedRound) {
        const lastScheduledRound =
          rounds.length > 0
            ? rounds[
                rounds.length - 1
              ].round
            : 1;

        selectedRound =
          lastScheduledRound;
        reason =
          rounds.length > 0
            ? 'season-complete'
            : 'no-schedule-data';
      }

      const selectedRoundData =
        rounds.find(
          (roundData) =>
            roundData.round ===
            selectedRound,
        ) ??
        null;

      return res.json({
        season:
          String(season),
        leagueName:
          supportedLeague
            .leagueName,
        countryName:
          supportedLeague
            .countryName,
        round:
          selectedRound,
        reason,
        generatedAt:
          new Date()
            .toISOString(),
        selectedRoundData:
          selectedRoundData
            ? {
                scheduledMatches:
                  selectedRoundData
                    .scheduledMatches,
                finishedMatches:
                  selectedRoundData
                    .finishedMatches,
                unfinishedMatches:
                  selectedRoundData
                    .unfinishedMatches,
                completed:
                  selectedRoundData
                    .completed,
                nextRelevantAt:
                  Number.isFinite(
                    selectedRoundData
                      .nextRelevantAtMs,
                  )
                    ? new Date(
                        selectedRoundData
                          .nextRelevantAtMs,
                      )
                        .toISOString()
                    : null,
              }
            : null,
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

        date =
          null,

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

      const isCupRequest =
        requestedLeague?.isCup ===
          true;

      const requestedDate =
        isCupRequest
          ? (
              /^\d{4}-\d{2}-\d{2}$/.test(
                String(
                  date ?? '',
                ),
              )
                ? String(date)
                : predictRomeDateKey(
                    new Date(),
                  )
            )
          : null;

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
        isCupRequest
          ? requestedDate
          : 'round-mode',
      ].join('-');

      const internalRequest =
        req.get(
          'x-predict-internal',
        ) ===
        INTERNAL_SYNC_TOKEN;

      // refresh=1 proveniente dall'app resta una semplice rilettura cache.
      // Solo un job interno autenticato può abilitare un refresh provider.
      const forceRefresh =
        internalRequest &&
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
          // Tutte le competizioni supportate, comprese le coppe UEFA,
          // sono cache-only per il client. Solo il server interno può usare
          // il provider in caso di cache miss.
          allowProviderFallback:
            internalRequest,
        });

      const roundMatches =
        seasonMatches
          .filter(
            (match) =>
              isCupRequest
                ? predictRomeDateKey(
                    match?.date,
                  ) ===
                    requestedDate
                : roundNumberOf(
                    match,
                  ) ===
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
        isCupRequest
          ? [
              'matchday-picks-cup-date-history-v2-multiples',
              season,
              historicalSeason,
              requestedDate,
              leagueName,
              countryName,
            ].join('-')
          : buildMatchdayRoundArchiveKey({
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
              isCupRequest
                ? `Nessuna partita trovata per la data ${requestedDate}`
                : `Nessuna partita trovata per la giornata ${parsedRound}`,

            season:
              String(season),

            round:
              parsedRound,

            date:
              requestedDate,
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

              // Lo snapshot deve essere preparato dai job centrali PREDICT.
              // L'apertura dell'app, anche sulle coppe UEFA, non lo genera mai.
              if (
                !snapshot?.pick &&
                internalRequest
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

      const multipleRoundKey =
        isCupRequest
          ? Number(
              String(
                requestedDate ??
                '',
              ).replace(
                /-/g,
                '',
              ),
            ) ||
            parsedRound
          : parsedRound;

      let multiples =
        await getOrUpdateMatchdayMultiplesSnapshot({
          season,
          historicalSeason,
          round:
            multipleRoundKey,
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

      if (
        isCupRequest &&
        multiples
      ) {
        multiples = {
          ...multiples,
          round:
            null,
          date:
            requestedDate,
          description:
            'Multipla PREDICT UEFA per data: 3X/5X, una sola selezione per partita, congelamento 4 ore prima della prima gara della data.',
        };
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

        date:
          requestedDate,

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

  const requestedLeague =
    resolveSupportedLeague({
      leagueName,
      countryName,
    });

  const snapshotVersion =
    matchdayPickSnapshotVersionForMatch(
      referenceMatch,
      requestedLeague,
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

  // Coppe UEFA: una pick v11 già esistente resta valida solo quando
  // troviamo in cache almeno un mercato bookmaker utilizzabile.
  // In assenza quote (es. Manchester United-Sabah) restituiamo null.
  if (
    requestedLeague?.isCup === true &&
    snapshotVersion ===
      UEFA_CUP_MATCHDAY_PICK_VERSION
  ) {
    const legacyUefa =
      await readMatchdayPickSnapshotVersion({
        version:
          UEFA_CUP_MATCHDAY_PICK_LEGACY_VERSION,
        matchId,
        historicalSeason,
        leagueName,
        countryName,
      });

    if (legacyUefa.snapshot?.pick) {
      const cachedBookmakerProbabilities =
        await getCachedBookmakerProbabilitiesForMatch(
          matchId,
        );

      if (
        bookmakerProbabilitiesHaveAnyMarket(
          cachedBookmakerProbabilities,
        )
      ) {
        return legacyUefa.snapshot;
      }
    }
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

      if (
        supportedLeague
          .supportsStandings ===
          false
      ) {
        return res
          .status(400)
          .json({
            error:
              'Classifica ufficiale non disponibile per questa competizione',
            competition:
              supportedLeague
                .leagueName,
          });
      }

      const normalizedSeason =
        String(season);

      const internalRequest =
        req.get(
          'x-predict-internal',
        ) ===
        INTERNAL_SYNC_TOKEN;

      // Il pulsante Aggiorna dell'app rilegge la cache. Solo il job interno
      // può forzare un refresh provider.
      const forceRefresh =
        internalRequest &&
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

      if (!internalRequest) {
        // Se lo scheduler è momentaneamente in ritardo, preferiamo una classifica
        // già nota (anche più vecchia del TTL operativo) a una chiamata provider
        // provocata dall'utente.
        const stale =
          getMemoryCache(
            cacheKey,
            PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
          ) ??
          await getDiskCache(
            cacheKey,
            PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
          );

        if (stale) {
          setMemoryCache(
            cacheKey,
            stale,
          );

          return res.json({
            ...stale,
            cached: true,
            cacheSource:
              'stale-central-cache',
            refreshPending: true,
            providerCallsAllowed: false,
          });
        }

        return res
          .status(503)
          .json({
            error:
              'Classifica PREDICT in preparazione sul server centrale',
            retryLater: true,
            providerCallsAllowed: false,
          });
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

      if (
        !supportsRoundBasedFeatures(
          supportedLeague,
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              'Risultati per giornata non disponibili per questa competizione',
            competition:
              supportedLeague
                .leagueName,
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
  '/api/football/international-multiples',
  async (req, res) => {
    try {
      const {
        season =
          CURRENT_SERIE_A_SEASON,
        historicalSeason =
          '2025',
      } = req.query;

      const payload =
        await getOrUpdateInternationalMultiplesSnapshot({
          season,
          historicalSeason,
        });

      return res.json({
        ...payload,

        cached:
          true,

        cacheSource:
          'international-multiple-cache-only',

        providerCallsAllowed:
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


app.get(
  '/api/football/international-multiples-summary',
  async (req, res) => {
    try {
      const {
        season =
          CURRENT_SERIE_A_SEASON,
        historicalSeason =
          '2025',
      } = req.query;

      const payload =
        await settlePermanentInternationalMultipleHistory({
          season,
          historicalSeason,
        });

      return res.json({
        ...payload,

        cached:
          true,

        cacheSource:
          'international-multiple-history-cache-only',

        providerCallsAllowed:
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

      const internalRequest =
        req.get(
          'x-predict-internal',
        ) ===
        INTERNAL_SYNC_TOKEN;

      const forceRefresh =
        internalRequest &&
        String(refresh) === '1';

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

      if (
        supportedLeague.isCup === true
      ) {
        // Riepilogo UEFA esclusivamente dagli archivi permanenti già congelati.
        // Nessuna rigenerazione delle multiple e nessuna chiamata Highlightly.
        const payload =
          await buildAndPersistUefaMultiplesSummary({
            season,
            historicalSeason,
            leagueName:
              supportedLeague
                .leagueName,
            countryName:
              supportedLeague
                .countryName,
          });

        return res.json({
          ...payload,
          cached: true,
          cacheSource:
            'uefa-multiple-history-cache-only',
          providerCallsAllowed:
            false,
        });
      }

      if (
        !supportsRoundBasedFeatures(
          supportedLeague,
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              'Riepilogo multiple per giornata non disponibile per questa competizione',
            competition:
              supportedLeague
                .leagueName,
          });
      }

      // Aggiorna SEMPRE lo storico prima di restituire le statistiche.
      //
      // refresh=0 (normale/app):
      // - usa stato centrale + cache RAM/disk
      // - usa risultati permanenti dei pronostici già verificati
      // - NON chiama Highlightly
      //
      // refresh=1 (manuale):
      // - può usare il provider per forzare l'aggiornamento
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
          forceRefresh,
      });

      const summaryKey =
        buildSeasonMultiplesSummaryArchiveKey({
          season,
          historicalSeason,
          leagueName:
            supportedLeague
              .leagueName,
          countryName:
            supportedLeague
              .countryName,
        });

      const payload =
        await getPermanentCache(
          summaryKey,
        ) ??
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
          !forceRefresh,
        cacheSource:
          forceRefresh
            ? 'multiple-history-refresh'
            : 'multiple-history-cache-only',
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

      const internalRequest =
        req.get(
          'x-predict-internal',
        ) ===
        INTERNAL_SYNC_TOKEN;

      const forceRefresh =
        internalRequest &&
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

      if (
        supportedLeague
          .supportsMatchdayPicks ===
          false
      ) {
        return res
          .status(400)
          .json({
            error:
              'Riepilogo pronostici per giornata non disponibile per le coppe UEFA',
            competition:
              supportedLeague
                .leagueName,
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
          allowProviderFallback:
            internalRequest,
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
// DETTAGLIO PARTITA DA CACHE CENTRALE
// ====================================================

app.get(
  '/api/football/match/:matchId',
  async (req, res) => {
    try {
      const matchId =
        String(
          req.params?.matchId ??
          '',
        ).trim();

      if (!matchId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              'matchId obbligatorio',
          });
      }

      const entry =
        centralFindMatchEntryById(
          matchId,
        );

      if (entry?.match) {
        return res.json({
          ok: true,
          data:
            entry.match,
          meta: {
            source:
              'predict-central-cache',
            leagueKey:
              entry.league?.key ??
              null,
            leagueName:
              entry.league?.leagueName ??
              null,
            countryName:
              entry.league?.countryName ??
              null,
          },
        });
      }

      // Le coppe UEFA LIVE vengono raccolte da /api/football/live
      // in una cache condivisa separata dalla cache centrale delle 5 leghe.
      // Il dettaglio deve poter riusare quella stessa cache senza fare
      // una nuova chiamata a Highlightly quando l'utente apre la partita.
      const liveCacheKey =
        'predict-central-live-matches-v2-cups';

      const livePayload =
        getMemoryCache(
          liveCacheKey,
          CUP_LIVE_SCHEDULE_CACHE_TIME,
        ) ??
        await getDiskCache(
          liveCacheKey,
          CUP_LIVE_SCHEDULE_CACHE_TIME,
        );

      const cachedLiveMatch =
        (
          Array.isArray(
            livePayload?.data,
          )
            ? livePayload.data
            : []
        ).find(
          (match) =>
            String(
              match?.id ??
              '',
            ) === matchId,
        );

      if (cachedLiveMatch) {
        return res.json({
          ok: true,
          data:
            cachedLiveMatch,
          meta: {
            source:
              'predict-shared-live-cache',
            leagueKey:
              cachedLiveMatch
                ?.predictLive
                ?.leagueKey ??
              null,
            leagueName:
              cachedLiveMatch
                ?.predictLive
                ?.leagueName ??
              cachedLiveMatch
                ?.league
                ?.name ??
              null,
            countryName:
              cachedLiveMatch
                ?.predictLive
                ?.countryName ??
              cachedLiveMatch
                ?.league
                ?.country ??
              null,
          },
        });
      }

      return res
        .status(404)
        .json({
          ok: false,
          error:
            'Partita non trovata nelle cache PREDICT',
        });
    } catch (error) {
      console.error(
        'PREDICT MATCH DETAIL ERROR:',
        error?.message ??
        error,
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            String(error),
        });
    }
  },
);

// ====================================================
// FORMAZIONI UFFICIALI PARTITA
// ====================================================

app.get(
  '/api/football/lineups/:matchId',
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

      const cacheKey =
        `lineups-${matchId}`;

      const data =
        getMemoryCache(
          cacheKey,
          PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
        ) ??
        await getDiskCache(
          cacheKey,
          PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
        );

      if (!data) {
        return res
          .status(503)
          .json({
            error:
              'Formazioni PREDICT non ancora disponibili in cache',
            retryLater: true,
            providerCallsAllowed: false,
          });
      }

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
// EVENTI LIVE PARTITA
// ====================================================

app.get(
  '/api/football/events/:matchId',
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

      const cacheKey =
        `events-${matchId}`;

      const data =
        getMemoryCache(
          cacheKey,
          PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
        ) ??
        await getDiskCache(
          cacheKey,
          PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
        );

      if (!data) {
        return res
          .status(503)
          .json({
            error:
              'Eventi LIVE PREDICT non ancora disponibili in cache',
            retryLater: true,
            providerCallsAllowed: false,
          });
      }

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

      const cacheKey =
        `statistics-${matchId}`;

      const data =
        getMemoryCache(
          cacheKey,
          PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
        ) ??
        await getDiskCache(
          cacheKey,
          PREDICT_HISTORY_ARCHIVE_CACHE_TIME,
        );

      if (!data) {
        return res
          .status(503)
          .json({
            error:
              'Statistiche PREDICT non ancora disponibili in cache',
            retryLater: true,
            providerCallsAllowed: false,
          });
      }

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
        async () => {
          if (
            !PREDICT_BACKGROUND_JOBS_ENABLED
          ) {
            console.log(
              'PREDICT background jobs: OFF (nessun scheduler automatico)',
            );

            return;
          }

          console.log(
            'PREDICT background jobs: ON',
          );

          await startCentralSerieAScheduler();
          await startCentralUefaScheduler();
          await startCentralSharedLiveScheduler();
          await startFavoriteTeamNotificationScheduler();
        },
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
      '- /api/football/match/:matchId',
      '- /api/football/lineups/:matchId',
      '- /api/football/events/:matchId',
      '- /api/football/statistics/:matchId',
    );

    console.log(
      '- /api/notifications/register-device',
      '- /api/notifications/subscriptions-status',
      '- /api/notifications/test-team/:teamId',
      '- /api/notifications/test',
    );
  },
);