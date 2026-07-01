import { useEffect, useState } from 'react'
import type { BetSession, Player } from '../../../shared/types'

export default function PredictMode() {
  const [sessions, setSessions] = useState<BetSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [active, setActive] = useState<BetSession | null>(null)
  const [title, setTitle] = useState('Sunday kickabout')
  const [names, setNames] = useState('Alex, Sam')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const refresh = async () => {
    const list = await window.probable.predict.listSessions()
    setSessions(list)
    if (activeId) {
      const s = await window.probable.predict.getSession(activeId)
      setActive(s)
    }
  }

  useEffect(() => {
    refresh()
  }, [activeId])

  const create = async () => {
    setError('')
    setLoading(true)
    try {
      const playerNames = names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
      if (playerNames.length < 2) throw new Error('Add at least two player names')
      const session = await window.probable.predict.createSession(title, playerNames)
      setActiveId(session.id)
      setActive(session)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create session')
    } finally {
      setLoading(false)
    }
  }

  const act = async (fn: () => Promise<BetSession>) => {
    setError('')
    setLoading(true)
    try {
      const s = await fn()
      setActive(s)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setLoading(false)
    }
  }

  const selectedPlayer = active?.players[0]

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="card">
        <h2 style={{ marginTop: 0 }}>New Predict session</h2>
        <div style={{ display: 'grid', gap: '0.75rem', maxWidth: 420 }}>
          <div>
            <label htmlFor="title">Session title</label>
            <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label htmlFor="names">Players (comma-separated)</label>
            <input id="names" value={names} onChange={(e) => setNames(e.target.value)} />
          </div>
          <button type="button" onClick={create} disabled={loading}>
            Create session & escrow
          </button>
        </div>
      </section>

      {sessions.length > 0 && (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Your sessions</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                className={activeId === s.id ? '' : 'secondary'}
                onClick={() => setActiveId(s.id)}
              >
                {s.title} · ${s.potUsd.toFixed(2)} · {s.status}
              </button>
            ))}
          </div>
        </section>
      )}

      {active && (
        <SessionPanel
          session={active}
          actingPlayer={selectedPlayer}
          loading={loading}
          onAct={act}
        />
      )}

      {error && <p className="error">{error}</p>}
    </div>
  )
}

function SessionPanel({
  session,
  actingPlayer,
  loading,
  onAct
}: {
  session: BetSession
  actingPlayer?: Player
  loading: boolean
  onAct: (fn: () => Promise<BetSession>) => Promise<void>
}) {
  const [raiseTo, setRaiseTo] = useState(String(session.currentStakeUsd + session.minRaiseUsd))
  const [depositAmt, setDepositAmt] = useState(String(session.currentStakeUsd))
  const [winnerId, setWinnerId] = useState(session.players[0]?.id ?? '')

  return (
    <section className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <div>
          <h2 style={{ marginTop: 0 }}>{session.title}</h2>
          <p className="muted">
            Pot: <strong style={{ color: 'var(--gold)' }}>${session.potUsd.toFixed(2)}</strong> ·
            Current stake: ${session.currentStakeUsd} · Status: {session.status}
          </p>
          {session.escrowAddress && (
            <p className="muted" style={{ fontSize: '0.8rem', wordBreak: 'break-all' }}>
              Escrow (WDK acct 1): {session.escrowAddress}
            </p>
          )}
        </div>
        <span className="badge">{session.status}</span>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1rem' }}>
        <thead>
          <tr className="muted" style={{ textAlign: 'left', fontSize: '0.85rem' }}>
            <th style={{ padding: '0.5rem 0' }}>Player</th>
            <th>Deposited</th>
            <th>Prediction</th>
            <th>Points</th>
          </tr>
        </thead>
        <tbody>
          {session.players.map((p) => (
            <tr key={p.id} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '0.5rem 0' }}>{p.name}</td>
              <td>${p.depositedUsd.toFixed(2)}</td>
              <td>
                {p.prediction
                  ? session.players.find((x) => x.id === p.prediction)?.name ?? '—'
                  : '—'}
              </td>
              <td>{p.points}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {session.status === 'open' && actingPlayer && (
        <div
          style={{
            marginTop: '1.25rem',
            display: 'grid',
            gap: '0.75rem',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))'
          }}
        >
          <div>
            <label>Predict winner ({actingPlayer.name})</label>
            <select
              value={actingPlayer.prediction ?? ''}
              onChange={(e) =>
                onAct(() =>
                  window.probable.predict.setPrediction(session.id, actingPlayer.id, e.target.value)
                )
              }
            >
              <option value="">Pick…</option>
              {session.players
                .filter((p) => p.id !== actingPlayer.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label>Raise pot to ($)</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input value={raiseTo} onChange={(e) => setRaiseTo(e.target.value)} />
              <button
                type="button"
                className="secondary"
                disabled={loading}
                onClick={() =>
                  onAct(() =>
                    window.probable.predict.raiseStake(
                      session.id,
                      actingPlayer.id,
                      parseFloat(raiseTo)
                    )
                  )
                }
              >
                Raise
              </button>
            </div>
          </div>
          <div>
            <label>Deposit ($)</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} />
              <button
                type="button"
                disabled={loading}
                onClick={() =>
                  onAct(() =>
                    window.probable.predict.deposit(
                      session.id,
                      actingPlayer.id,
                      parseFloat(depositAmt)
                    )
                  )
                }
              >
                Lock in
              </button>
            </div>
          </div>
          <div style={{ alignSelf: 'end' }}>
            <button
              type="button"
              className="secondary"
              disabled={loading}
              onClick={() => onAct(() => window.probable.predict.lockSession(session.id))}
            >
              Lock session (no more bets)
            </button>
          </div>
        </div>
      )}

      {session.status === 'locked' && (
        <div style={{ marginTop: '1.25rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <select value={winnerId} onChange={(e) => setWinnerId(e.target.value)}>
            {session.players.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={loading}
            onClick={() =>
              onAct(() => window.probable.predict.declareWinner(session.id, winnerId))
            }
          >
            Declare winner (+2 / +1 / −1 pts)
          </button>
          <button
            type="button"
            className="secondary"
            disabled={loading || !session.winnerId}
            onClick={() => onAct(() => window.probable.predict.settle(session.id))}
          >
            Settle pot → winner
          </button>
        </div>
      )}

      {session.status === 'settled' && session.winnerId && (
        <p style={{ marginTop: '1rem', color: 'var(--gold)' }}>
          🏆 Winner: {session.players.find((p) => p.id === session.winnerId)?.name}
        </p>
      )}
    </section>
  )
}
