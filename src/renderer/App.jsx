import React from 'react';

export default function App() {
  const appName = window.probable?.appName ?? 'Probable';

  return (
    <main
      style={{
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        margin: 0,
        background: '#0f1115',
        color: '#f2f3f5',
      }}
    >
      <h1 style={{ fontWeight: 600, letterSpacing: '-0.02em' }}>{appName}</h1>
    </main>
  );
}
