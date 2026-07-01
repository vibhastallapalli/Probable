import { useState } from 'react'

interface Message {
  role: 'user' | 'assistant'
  text: string
}

export default function JudgeChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  const send = async () => {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', text }])
    setLoading(true)
    try {
      const reply = await window.probable.judge.chat(text)
      setMessages((m) => [...m, { role: 'assistant', text: reply }])
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: 'assistant', text: e instanceof Error ? e.message : 'Chat failed' }
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Ask the judge</h3>
      <p className="muted" style={{ fontSize: '0.9rem' }}>
        &quot;Why did you pick this one?&quot; · &quot;What made the curler better?&quot;
      </p>
      <div
        style={{
          maxHeight: 220,
          overflowY: 'auto',
          marginBottom: '0.75rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem'
        }}
      >
        {messages.length === 0 && (
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            No messages yet.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              padding: '0.5rem 0.75rem',
              borderRadius: 8,
              background: m.role === 'user' ? 'var(--accent-dim)' : 'var(--surface-2)',
              color: m.role === 'user' ? '#041008' : 'var(--text)'
            }}
          >
            {m.text}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Ask about the scoring…"
          disabled={loading}
        />
        <button type="button" onClick={send} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>
    </section>
  )
}
