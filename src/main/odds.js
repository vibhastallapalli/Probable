'use strict'

// odds.js — Predict-mode PRE-MATCH odds. NOT the source of truth.
//
// This is a DELIBERATELY SIMPLE, HONEST HEURISTIC — not a trained model.
// There is no labelled dataset anywhere for what makes a goal "cooler"/more
// impressive, so a real statistical model cannot be fit right now and none is
// attempted here. All this does is give two friends a rough, fully traceable
// sense of who is more likely to score the cooler goal BEFORE a match, so the
// wager feels informed instead of a blind coin flip. The ACTUAL winner is
// always decided AFTER the match by the QVAC scoring pipeline
// (scoring.js -> settlement.js) run on real goal footage — never by this number.
//
// What a real version would eventually need: labelled data on goal quality
// (impressiveness scores for real goals), which does not exist yet. Until that
// exists we rank only on plain, public counting stats a person can trace by hand.
//
// Data source: openfootball/worldcup.json (the 2026/worldcup.json file). It was
// chosen over the worldcup26.ir API because it publishes every goal as
// {name, minute} inside each match, giving clean per-player goal counts with no
// signup; worldcup26.ir's public page only advertises match/team/group/stadium
// data and documents no goalscorer endpoint, so per-player goals aren't cleanly
// available there.

const fs = require('fs')

// Public, no-signup dataset of every 2026 World Cup goal (player + minute).
const WORLDCUP_JSON_URL =
  'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json'

// --- Weights ---------------------------------------------------------------
// A player's "strength" is just the SUM of the three lines below. Every point
// traces to one real, countable stat, and each line is explainable out loud in
// one sentence. Kept small and legible on purpose — this is a heuristic, not a
// model, so the weights are honest editorial choices, not fitted parameters.
//
//   GOALS : 1.0 point per goal the player has actually scored (raw output).
//   RATE  : 2.0 points per goal-per-team-match (rewards efficiency, not just
//           volume — scoring often in fewer games should rank higher).
//   TEAM  : 0.5 points per team-goal-per-match — a proxy for how many scoring
//           chances the player's team creates (a higher-scoring team gives its
//           players more shots at glory). Weighted lowest because it is the
//           player's team, not the player.
const W_GOALS = 1.0
const W_RATE = 2.0
const W_TEAM = 0.5

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round2 (n) {
  return Math.round(Number(n) * 100) / 100
}

// Normalise a name/team for forgiving comparison: trim, lowercase, and strip
// accents so "Julian Quinones" still matches "Julián Quiñones".
function _norm (s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
}

/**
 * Count the real, traceable stats for one player from the tournament data.
 *
 * Own goals are excluded — they help the opponent, not the scorer, and are
 * flukes rather than chances a team created. Penalties DO count: they are still
 * goals the player put away.
 *
 * @param {string} name - Player name (accent/case-insensitive match).
 * @param {string} team - Player's team name (accent/case-insensitive match).
 * @param {object} data - Parsed worldcup.json, shaped { matches: [...] }.
 * @returns {{player:string, team:string, goals:number, teamMatches:number,
 *   teamGoals:number, goalsPerMatch:number, teamGoalsPerMatch:number,
 *   matched:boolean}}
 */
function getPlayerStats (name, team, data) {
  const nName = _norm(name)
  const nTeam = _norm(team)
  const matches = (data && data.matches) || []

  let goals = 0
  let teamGoals = 0
  let teamMatches = 0

  for (const m of matches) {
    const isTeam1 = _norm(m.team1) === nTeam
    const isTeam2 = _norm(m.team2) === nTeam
    if (isTeam1 || isTeam2) teamMatches++

    // The goal list that belongs to THIS player's team in this match.
    const teamScored = isTeam1 ? m.goals1 : isTeam2 ? m.goals2 : null
    if (!teamScored) continue

    for (const g of teamScored) {
      if (g && g.owngoal) continue // own goal: credited against the team's play
      teamGoals++
      if (_norm(g && g.name) === nName) goals++
    }
  }

  const goalsPerMatch = teamMatches > 0 ? goals / teamMatches : 0
  const teamGoalsPerMatch = teamMatches > 0 ? teamGoals / teamMatches : 0

  return {
    player: name,
    team,
    goals,
    teamMatches,
    teamGoals,
    goalsPerMatch,
    teamGoalsPerMatch,
    matched: teamMatches > 0
  }
}

// Turn a player's raw stats into a strength score plus a per-line breakdown so
// the final number is never a black box — each entry says exactly which stat it
// came from and how many points it contributed.
function _strength (s) {
  const fromGoals = W_GOALS * s.goals
  const fromRate = W_RATE * s.goalsPerMatch
  const fromTeam = W_TEAM * s.teamGoalsPerMatch
  const strength = fromGoals + fromRate + fromTeam

  return {
    strength,
    breakdown: [
      {
        stat: 'goals',
        value: s.goals,
        points: round2(fromGoals),
        why: `${s.goals} goal(s) scored, ${W_GOALS} pt each`
      },
      {
        stat: 'goalsPerMatch',
        value: round2(s.goalsPerMatch),
        points: round2(fromRate),
        why: `${round2(s.goalsPerMatch)} goals per team match, ${W_RATE} pts each`
      },
      {
        stat: 'teamGoalsPerMatch',
        value: round2(s.teamGoalsPerMatch),
        points: round2(fromTeam),
        why: `team scores ${round2(s.teamGoalsPerMatch)} per match (chance proxy), ${W_TEAM} pt each`
      }
    ]
  }
}

/**
 * Compute a rough pre-match percentage split between two players: who is more
 * likely to score the cooler goal, based ONLY on plain counting stats.
 *
 * This is not a prediction of truth — it is a conversation starter for the
 * wager. The post-match QVAC scoring decides who actually wins the money.
 *
 * @param {{name:string, team:string}} playerA
 * @param {{name:string, team:string}} playerB
 * @param {object} data - Parsed worldcup.json.
 * @returns {{playerA:object, playerB:object, note:string}} Each player object
 *   carries its raw stats, its strength, a per-stat breakdown, and its percent.
 */
function computeOdds (playerA, playerB, data) {
  if (!playerA || !playerA.name || !playerA.team) throw new Error('playerA needs { name, team }')
  if (!playerB || !playerB.name || !playerB.team) throw new Error('playerB needs { name, team }')

  const a = getPlayerStats(playerA.name, playerA.team, data)
  const b = getPlayerStats(playerB.name, playerB.team, data)

  const sa = _strength(a)
  const sb = _strength(b)
  const total = sa.strength + sb.strength

  let percentA
  let percentB
  let note

  if (total <= 0) {
    // Neither player nor their team has scored yet — there is genuinely nothing
    // to separate them on, so return an honest even split, not a fake number.
    percentA = 50
    percentB = 50
    note = 'No goals scored yet by either player or their team — honest 50/50 split.'
  } else {
    percentA = Math.round((sa.strength / total) * 100)
    percentB = 100 - percentA
    note = 'Rough pre-match heuristic from public goal stats only. The post-match ' +
      'QVAC scoring of the real goals, not this number, decides who wins.'
  }

  return {
    playerA: { ...a, strength: round2(sa.strength), breakdown: sa.breakdown, percent: percentA },
    playerB: { ...b, strength: round2(sb.strength), breakdown: sb.breakdown, percent: percentB },
    note
  }
}

/**
 * Load and parse the tournament dataset.
 *
 * Kept separate from computeOdds so the scoring logic stays a pure function that
 * is trivial to unit-test with a fixture. Reads a local file when `filePath` is
 * given (offline / tests), returns `data` verbatim if provided, otherwise
 * fetches the public URL (Node 18+ global fetch).
 *
 * @param {{data?:object, filePath?:string, url?:string}} [opts]
 * @returns {Promise<object>} Parsed worldcup.json.
 */
async function loadTournamentData (opts = {}) {
  if (opts.data) return opts.data

  if (opts.filePath) {
    const raw = fs.readFileSync(opts.filePath, 'utf8').replace(/^﻿/, '')
    return JSON.parse(raw)
  }

  const url = opts.url || WORLDCUP_JSON_URL
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch unavailable — pass { filePath } or { data } instead')
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch tournament data: HTTP ${res.status}`)
  return res.json()
}

module.exports = {
  computeOdds,
  getPlayerStats,
  loadTournamentData,
  WORLDCUP_JSON_URL
}
