import { useState } from 'react'
import type { JudgeResult } from '../../../shared/types'
import JudgeChat from '../components/JudgeChat'

export default function JudgeMode() {
  const [nameA, setNameA] = useState('Player A')
  const [nameB, setNameB] = useState('Player B')
  const [clipA, setClipA] = useState<string | null>(null)
  const [clipB, setClipB] = useState<string | null>(null)
  const [result, setResult] = useState<JudgeResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  const pick = async (which: 'A' | 'B') => {
    const path = await window.probable.judge.pickVideo()
    if (!path) return
    if (which === 'A') setClipA(path)
    else setClipB(path)
  }

  const judge = async () => {
    if (!clipA || !clipB) {
      setError('Select both clips first')
      return
    }
    setError('')
    setLoading(true)
    setStatus('Extracting frames & loading QVAC model (first run downloads ~500MB)…')
    try {
      const res = await window.probable.judge.judgeClips(clipA, clipB, nameA, nameB)
      setResult(res)
      setStatus('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Judging failed')
      setStatus('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Judge two clips</h2>
        <p className="muted">
          QVAC runs SmolVLM2 on-device. Clips are sampled at 2 fps (max ~10 frames each). Scoring
          uses your rubric — impressiveness over physics.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '1rem',
            marginTop: '1rem'
          }}
        >
          <ClipSlot label={nameA} path={clipA} onPick={() => pick('A')} onNameChange={setNameA} />
          <ClipSlot label={nameB} path={clipB} onPick={() => pick('B')} onNameChange={setNameB} />
        </div>

        <button
          type="button"
          style={{ marginTop: '1rem' }}
          onClick={judge}
          disabled={loading || !clipA || !clipB}
        >
          {loading ? 'Judging…' : 'Run AI judge'}
        </button>
        {status && <p className="muted" style={{ marginTop: '0.75rem' }}>{status}</p>}
        {error && <p className="error">{error}</p>}
      </section>

      {result && (
        <>
          <section className="card">
            <h2 style={{ marginTop: 0, color: 'var(--gold)' }}>
              🏆 {result.winnerName} wins
            </h2>
            <p>{result.comparisonSummary}</p>
            <div style={{ display: 'grid', gap: '1rem', marginTop: '1rem' }}>
              {result.scores.map((s) => (
                <div
                  key={s.clipPath}
                  style={{
                    padding: '1rem',
                    background: 'var(--surface-2)',
                    borderRadius: 8,
                    border:
                      s.playerName === result.winnerName
                        ? '1px solid var(--gold)'
                        : '1px solid var(--border)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <strong>{s.playerName}</strong>
                    <span>{s.totalScore}/100</span>
                  </div>
                  <p className="muted" style={{ margin: '0.35rem 0' }}>
                    {s.shotType}
                    {s.tags.length > 0 && ` · ${s.tags.join(', ')}`}
                  </p>
                  <p style={{ margin: 0, fontSize: '0.95rem' }}>{s.explanation}</p>
                  {Object.keys(s.breakdown).length > 0 && (
                    <ul className="muted" style={{ fontSize: '0.85rem', marginBottom: 0 }}>
                      {Object.entries(s.breakdown).map(([k, v]) => (
                        <li key={k}>
                          {k}: {v}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>
          <JudgeChat />
        </>
      )}
    </div>
  )
}

function ClipSlot({
  label,
  path,
  onPick,
  onNameChange
}: {
  label: string
  path: string | null
  onPick: () => void
  onNameChange: (v: string) => void
}) {
  return (
    <div style={{ padding: '1rem', background: 'var(--surface-2)', borderRadius: 8 }}>
      <label>Name</label>
      <input value={label} onChange={(e) => onNameChange(e.target.value)} style={{ marginBottom: '0.75rem' }} />
      <button type="button" className="secondary" onClick={onPick} style={{ width: '100%' }}>
        {path ? 'Change clip' : 'Choose video'}
      </button>
      {path && (
        <p className="muted" style={{ fontSize: '0.75rem', marginTop: '0.5rem', wordBreak: 'break-all' }}>
          {path.split(/[/\\]/).pop()}
        </p>
      )}
    </div>
  )
}
