import React from 'react';
import Player from './components/Player';
import './App.css';

function App() {
  return (
    <div className="App shell">
      {/* Ambient animated backdrop — pure CSS, decorative only */}
      <div className="ambient-bg" aria-hidden="true">
        <span className="ambient-blob ambient-blob--a" />
        <span className="ambient-blob ambient-blob--b" />
        <span className="ambient-blob ambient-blob--c" />
        <span className="ambient-vignette" />
        <span className="ambient-grain" />
      </div>

      <header className="topbar">
        <div className="topbar-mark">
          <span className="pole-chip" aria-hidden="true" />
          <span className="brand">Raunaknama</span>
        </div>
        <div className="listener-pill">
          <span className="dot" aria-hidden="true" />
          <span>On Air</span>
        </div>
      </header>

      <main className="stage">
        <Player />
      </main>

      <footer className="foot">
        <span>90s Bollywood radio, on loop.</span>
      </footer>
    </div>
  );
}

export default App;
