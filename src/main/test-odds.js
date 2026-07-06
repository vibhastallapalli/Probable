'use strict'

// Standalone sanity check for odds.js.
//   Run:  node src/main/test-odds.js
//
// Fetches the live 2026 World Cup dataset and prints a pre-match split between
// two real current-tournament players, with every stat that fed the number, so
// the output can be eyeballed by hand before this goes near the app or real
// money. odds.js only needs `fs`, so this runs under plain Node — no Electron.

const { computeOdds, loadTournamentData, WORLDCUP_JSON_URL } = require('./odds')

// Two real leading scorers from the 2026 World Cup. Chosen deliberately: both
// have scored the same number of goals, so the split has to be decided by the
// per-match rate and team-chance factors — a good test that those actually bite.
const PLAYER_A = { name: 'Lionel Messi', team: 'Argentina' }
const PLAYER_B = { name: 'Kylian Mbappé', team: 'France' }

function printPlayer (p) {
  console.log(`${p.player} (${p.team})`)
  if (!p.matched) {
    console.log('  !! team not found in dataset — stats are all zero')
  }
  console.log(`  goals=${p.goals}  teamMatches=${p.teamMatches}  teamGoals=${p.teamGoals}` +
    `  goalsPerMatch=${round2(p.goalsPerMatch)}  teamGoalsPerMatch=${round2(p.teamGoalsPerMatch)}`)
  console.log(`  strength=${p.strength}`)
  for (const b of p.breakdown) {
    console.log(`    +${b.points}  ${b.why}`)
  }
  console.log('')
}

function round2 (n) {
  return Math.round(Number(n) * 100) / 100
}

async function main () {
  let data
  try {
    data = await loadTournamentData({ url: WORLDCUP_JSON_URL })
    console.log(`Loaded ${data.matches.length} matches from openfootball/worldcup.json (2026)\n`)
  } catch (err) {
    console.error('Could not load tournament data:', err.message)
    process.exit(1)
  }

  const odds = computeOdds(PLAYER_A, PLAYER_B, data)

  printPlayer(odds.playerA)
  printPlayer(odds.playerB)

  console.log('----------------------------------------------------------------')
  console.log(`SPLIT:  ${odds.playerA.player} ${odds.playerA.percent}%` +
    `   vs   ${odds.playerB.player} ${odds.playerB.percent}%`)
  console.log(`NOTE:   ${odds.note}`)
}

main()
