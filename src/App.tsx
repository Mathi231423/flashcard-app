import { useState, useEffect, useRef } from 'react';
import { SessionQueue, type Card, type Deck } from './sessionQueue';

const DEFAULT_DECKS: Deck[] = [
  { id: 'd1', title: 'Spanisch Basis', createdAt: Date.now() }
];

const DEFAULT_CARDS: Card[] = [
  { id: '1', deckId: 'd1', frontText: 'roter Apfel', backText: 'manzana roja', icon: '🍎', showIconRandomly: true, level: 0, consecutiveFails: 0, failCountTotal: 2 },
  { id: '2', deckId: 'd1', frontText: 'Haus', backText: 'la casa', icon: '🏠', showIconRandomly: true, level: 0, consecutiveFails: 0, failCountTotal: 0 },
  { id: '3', deckId: 'd1', frontText: 'Hund', backText: 'el perro', icon: '🐕', showIconRandomly: true, level: 0, consecutiveFails: 0, failCountTotal: 1 },
  { id: '4', deckId: 'd1', frontText: 'Wasser', backText: 'el agua', icon: '💧', showIconRandomly: false, level: 0, consecutiveFails: 0, failCountTotal: 0 },
  { id: '5', deckId: 'd1', frontText: 'Sonne', backText: 'el sol', icon: '☀️', showIconRandomly: true, level: 0, consecutiveFails: 0, failCountTotal: 3 },
  { id: '6', deckId: 'd1', frontText: 'Buch', backText: 'el libro', icon: '📖', showIconRandomly: false, level: 0, consecutiveFails: 0, failCountTotal: 0 },
];

function checkAnswerTolerant(input: string, target: string): boolean {
  const clean = (str: string) =>
    str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[¡!¿?.,]/g, '').trim();
  const stripArticle = (str: string) =>
    str.replace(/^(el|la|los|las|un|una)\s+/i, '').trim();

  const cInput = clean(input);
  const cTarget = clean(target);
  if (!cInput) return false;
  return cInput === cTarget || stripArticle(cInput) === stripArticle(cTarget);
}

async function fetchDeckFromGemini(promptText: string, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey.trim()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Erstelle ein Flashcard-Deck zur Anforderung: "${promptText}". Antworte AUSSCHLIESSLICH mit einem gültigen JSON-Objekt (ohne Markdown, ohne Erklärungen) in genau diesem Format: {"title": "Kurzer logischer Deckname", "cards": [{"frontText": "Wort/Frage", "backText": "Antwort", "icon": "Emoji"}]}`
          }]
        }]
      }),
      signal: controller.signal
    });
    clearTimeout(timer);

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  } catch (err: any) {
    clearTimeout(timer);
    throw new Error(err.name === 'AbortError' ? 'Google-Server antwortet nicht (30s Timeout).' : err.message);
  }
}

export default function App() {
  const [decks, setDecks] = useState<Deck[]>(() => {
    const saved = localStorage.getItem('fc_decks');
    return saved ? JSON.parse(saved) : DEFAULT_DECKS;
  });

  const [cards, setCards] = useState<Card[]>(() => {
    const saved = localStorage.getItem('fc_cards');
    return saved ? JSON.parse(saved) : DEFAULT_CARDS;
  });

  const [apiKey, setApiKey] = useState(() => localStorage.getItem('fc_gemini_key') || '');
  const [aiEnabled, setAiEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('fc_ai_enabled');
    return saved !== null ? JSON.parse(saved) : true;
  });

  const [view, setView] = useState<'decks' | 'edit' | 'study' | 'settings'>('decks');
  const [activeDeckId, setActiveDeckId] = useState<string>('d1');

  const isInstalledPwa = typeof window !== 'undefined' && (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true
  );
  const [showInstallPrompt, setShowInstallPrompt] = useState(!isInstalledPwa);

  const [newDeckTitle, setNewDeckTitle] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [importJsonText, setImportJsonText] = useState('');
  const [showImporter, setShowImporter] = useState(false);

  const [frontText, setFrontText] = useState('');
  const [backText, setBackText] = useState('');
  const [icon, setIcon] = useState('');
  const [showIconRandomly, setShowIconRandomly] = useState(true);

  const [session, setSession] = useState<SessionQueue | null>(null);
  const [queueSnapshot, setQueueSnapshot] = useState<Card[]>([]);
  const [userInput, setUserInput] = useState('');
  const [checkResult, setCheckResult] = useState<'correct' | 'wrong' | null>(null);
  const [showOnlyIcon, setShowOnlyIcon] = useState(false);

  const [listeningTarget, setListeningTarget] = useState<string | null>(null);
  const activeRecognitionRef = useRef<any>(null);

  const stopActiveRecognition = () => {
    if (activeRecognitionRef.current) {
      try {
        activeRecognitionRef.current.abort();
      } catch {}
      activeRecognitionRef.current = null;
    }
    setListeningTarget(null);
  };

  useEffect(() => {
    return () => stopActiveRecognition();
  }, [view]);

  useEffect(() => {
    localStorage.setItem('fc_decks', JSON.stringify(decks));
  }, [decks]);

  useEffect(() => {
    localStorage.setItem('fc_cards', JSON.stringify(cards));
  }, [cards]);

  useEffect(() => {
    localStorage.setItem('fc_gemini_key', apiKey);
  }, [apiKey]);

  useEffect(() => {
    localStorage.setItem('fc_ai_enabled', JSON.stringify(aiEnabled));
  }, [aiEnabled]);

  const activeDeck = decks.find((d) => d.id === activeDeckId);
  const deckCards = cards.filter((c) => c.deckId === activeDeckId);

  const listenToSpeech = (
    onResult: (text: string) => void,
    lang: string,
    targetId: string,
    continuousMode: boolean = false
  ) => {
    if (listeningTarget === targetId) {
      stopActiveRecognition();
      return;
    }

    stopActiveRecognition();

    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
      alert('Spracherkennung wird nicht unterstützt.');
      return;
    }

    const recognition = new SpeechRecognitionAPI();
    activeRecognitionRef.current = recognition;

    recognition.lang = lang;
    recognition.interimResults = true;
    recognition.continuous = continuousMode;

    recognition.onstart = () => setListeningTarget(targetId);
    recognition.onend = () => {
      if (activeRecognitionRef.current === recognition) {
        activeRecognitionRef.current = null;
        setListeningTarget(null);
      }
    };

    recognition.onerror = (event: any) => {
      stopActiveRecognition();
      if (event.error === 'not-allowed') {
        alert('Mikrofon blockiert! Bitte in den Einstellungen freigeben.');
      }
    };

    recognition.onresult = (event: any) => {
      const text = Array.from(event.results)
        .map((r: any) => r[0]?.transcript || '')
        .join('');
      onResult(text);
    };

    try {
      recognition.start();
    } catch {
      stopActiveRecognition();
    }
  };

  const handleCreateDeck = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDeckTitle.trim()) return;
    const newDeck: Deck = { id: 'd_' + Date.now(), title: newDeckTitle.trim(), createdAt: Date.now() };
    setDecks([...decks, newDeck]);
    setNewDeckTitle('');
  };

  const handleGenerateDeck = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiEnabled || !aiPrompt.trim()) return;

    let key = apiKey.trim();
    if (!key) {
      const enteredKey = prompt('Bitte deinen Gemini API-Key eingeben:');
      if (!enteredKey) return;
      key = enteredKey.trim();
      setApiKey(key);
    }

    setIsGenerating(true);
    try {
      const rawJson = await fetchDeckFromGemini(aiPrompt, key);
      const firstBrace = rawJson.indexOf('{');
      const lastBrace = rawJson.lastIndexOf('}');
      if (firstBrace === -1 || lastBrace === -1) throw new Error('Ungültiges Datenformat von der KI.');

      const parsed = JSON.parse(rawJson.substring(firstBrace, lastBrace + 1));
      const cardsArray = Array.isArray(parsed.cards) ? parsed.cards : [];
      if (cardsArray.length === 0) throw new Error('Keine Karten im Ergebnis gefunden.');

      const newDeckId = 'd_' + Date.now();
      const newDeckTitleClean = parsed.title ? String(parsed.title).trim() : 'KI-Deck';

      const newCards: Card[] = cardsArray.map((item: any, idx: number) => ({
        id: 'c_' + Date.now() + '_' + idx,
        deckId: newDeckId,
        frontText: String(item.frontText || item.front || 'Frage'),
        backText: String(item.backText || item.back || 'Antwort'),
        icon: item.icon || '📚',
        showIconRandomly: true,
        level: 0,
        consecutiveFails: 0,
        failCountTotal: 0
      }));

      setDecks((prev) => [...prev, { id: newDeckId, title: newDeckTitleClean, createdAt: Date.now() }]);
      setCards((prev) => [...prev, ...newCards]);
      setAiPrompt('');
      alert(`Deck "${newDeckTitleClean}" (${newCards.length} Karten) erstellt! 🐾`);
    } catch (err: any) {
      alert('Erstellung fehlgeschlagen: ' + err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleImportJson = (e: React.FormEvent) => {
    e.preventDefault();
    if (!importJsonText.trim()) return;

    try {
      const firstBracket = importJsonText.indexOf('[');
      const lastBracket = importJsonText.lastIndexOf(']');
      if (firstBracket === -1 || lastBracket === -1) throw new Error('Kein JSON-Array [...] gefunden.');

      const rawCards = JSON.parse(importJsonText.substring(firstBracket, lastBracket + 1));
      if (!Array.isArray(rawCards) || rawCards.length === 0) throw new Error('Array ist ungültig.');

      const deckTitlePrompt = prompt('Name für das importierte Deck:', 'Neues Deck');
      if (!deckTitlePrompt) return;

      const newDeckId = 'd_' + Date.now();
      const newDeck: Deck = { id: newDeckId, title: deckTitlePrompt.trim(), createdAt: Date.now() };

      const createdCards: Card[] = rawCards.map((item: any, idx: number) => ({
        id: 'c_' + Date.now() + '_' + idx,
        deckId: newDeckId,
        frontText: String(item.frontText || item.front || 'Frage'),
        backText: String(item.backText || item.back || 'Antwort'),
        icon: item.icon || '📚',
        showIconRandomly: true,
        level: 0,
        consecutiveFails: 0,
        failCountTotal: 0
      }));

      setDecks([...decks, newDeck]);
      setCards([...cards, ...createdCards]);
      setImportJsonText('');
      setShowImporter(false);
      alert(`Deck "${newDeck.title}" importiert! ✨`);
    } catch (err: any) {
      alert('Fehler: ' + err.message);
    }
  };

  const handleExportDeck = (deckId: string) => {
    const cardsToExport = cards
      .filter((c) => c.deckId === deckId)
      .map(({ frontText, backText, icon }) => ({ frontText, backText, icon }));

    if (cardsToExport.length === 0) {
      alert('Keine Karten vorhanden.');
      return;
    }

    navigator.clipboard.writeText(JSON.stringify(cardsToExport, null, 2))
      .then(() => alert('Deck als JSON kopiert! ✨'))
      .catch(() => alert('Kopieren fehlgeschlagen.'));
  };

  const handleDeleteDeck = (id: string) => {
    setDecks(decks.filter((d) => d.id !== id));
    setCards(cards.filter((c) => c.deckId !== id));
  };

  const handleAddCard = (e: React.FormEvent) => {
    e.preventDefault();
    if (!frontText.trim() || !backText.trim()) return;
    const newCard: Card = {
      id: 'c_' + Date.now(),
      deckId: activeDeckId,
      frontText: frontText.trim(),
      backText: backText.trim(),
      icon: icon.trim() || undefined,
      showIconRandomly,
      level: 0,
      consecutiveFails: 0,
      failCountTotal: 0,
    };
    setCards([...cards, newCard]);
    setFrontText('');
    setBackText('');
    setIcon('');
  };

  const handleDeleteCard = (id: string) => {
    setCards(cards.filter((c) => c.id !== id));
  };

  const resetDeckLevels = (deckId: string) => {
    setCards(cards.map((c) => (c.deckId === deckId ? { ...c, level: 0, consecutiveFails: 0 } : c)));
  };

  const startStudy = (deckId: string) => {
    let dueCards = cards.filter((c) => c.deckId === deckId && c.level < 3);
    if (dueCards.length === 0) {
      dueCards = cards.filter((c) => c.deckId === deckId).map((c) => ({ ...c, level: 0, consecutiveFails: 0 }));
      resetDeckLevels(deckId);
    }
    const newSession = new SessionQueue(dueCards);
    const snap = newSession.getQueueSnapshot();
    setActiveDeckId(deckId);
    setSession(newSession);
    setQueueSnapshot(snap);
    setUserInput('');
    setCheckResult(null);
    setView('study');

    const first = snap[0];
    setShowOnlyIcon(Boolean(first && first.showIconRandomly && first.icon && Math.random() < 0.5));
  };

  const currentCard = queueSnapshot[0] || null;

  const handleCheck = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentCard || checkResult !== null) return;
    setCheckResult(checkAnswerTolerant(userInput, currentCard.backText) ? 'correct' : 'wrong');
  };

  const commitAnswer = (finalCorrect: boolean) => {
    if (!session) return;
    const updatedCard = session.handleAnswer(finalCorrect);
    if (updatedCard) {
      setCards((prev) => prev.map((c) => (c.id === updatedCard.id ? updatedCard : c)));
    }
    const nextSnapshot = session.getQueueSnapshot();
    setQueueSnapshot(nextSnapshot);
    setUserInput('');
    setCheckResult(null);

    const nextCard = nextSnapshot[0];
    setShowOnlyIcon(Boolean(nextCard && nextCard.showIconRandomly && nextCard.icon && Math.random() < 0.5));
  };

  const cardBorder = '2px solid #3b2034';
  const radius = '18px';

  return (
    <div style={{ maxWidth: '420px', margin: '0 auto', padding: '16px', fontFamily: '"Quicksand", system-ui, sans-serif', color: '#2d1b2d', backgroundColor: '#fffaf0', minHeight: '100vh', boxSizing: 'border-box' }}>
      
      {showInstallPrompt && (
        <div style={{ background: '#fef3c7', border: cardBorder, borderRadius: radius, padding: '10px 14px', marginBottom: '12px', fontSize: '13px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>Als App installieren:</strong><br />
            <span style={{ color: '#78350f', fontSize: '12px' }}>
              iOS: Teilen ➔ <i>Zum Home-Bildschirm</i><br />
              Android: ⋮ ➔ <i>App installieren</i>
            </span>
          </div>
          <button onClick={() => setShowInstallPrompt(false)} style={{ background: 'transparent', border: 'none', color: '#2d1b2d', fontSize: '16px', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* Header ohne störende Biene über dem Text */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: '14px', position: 'relative' }}>
        <button onClick={() => setView('settings')} style={{ background: 'transparent', border: 'none', color: '#6b4f68', fontSize: '13px', cursor: 'pointer', fontWeight: 600 }}>
          🌸 ⚙️ Einstellungen {aiEnabled ? (apiKey ? '(KI Ein)' : '(Kein Key)') : '(KI Aus)'}
        </button>
      </div>

      {view === 'settings' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <button onClick={() => setView('decks')} style={{ padding: '8px 14px', borderRadius: '12px', border: cardBorder, background: '#fff', color: '#2d1b2d', fontWeight: 700, cursor: 'pointer' }}>
              ← Zurück
            </button>
            <span style={{ fontWeight: 700, fontSize: '18px' }}>Einstellungen</span>
          </div>

          <div style={{ background: '#fff', padding: '16px', borderRadius: radius, border: cardBorder, display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: '14px', fontWeight: 700 }}>KI-Generator aktivieren</div>
                <div style={{ fontSize: '12px', color: '#71717a' }}>Kostenkontrolle: Ausschalten für 0 € API-Kosten</div>
              </div>
              <input
                type="checkbox"
                checked={aiEnabled}
                onChange={(e) => setAiEnabled(e.target.checked)}
                style={{ width: '22px', height: '22px', cursor: 'pointer', accentColor: '#ec4899' }}
              />
            </div>

            <div style={{ borderTop: '2px dashed #fbcfe8', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '14px', fontWeight: 700 }}>Gemini API-Key</div>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Dein API-Key..."
                disabled={!aiEnabled}
                style={{ padding: '12px', borderRadius: '12px', border: cardBorder, background: '#fffaf0', color: '#2d1b2d', fontSize: '14px' }}
              />
            </div>

            <button onClick={() => setView('decks')} style={{ padding: '12px', borderRadius: '14px', border: cardBorder, background: '#bae6fd', color: '#2d1b2d', fontWeight: 700, cursor: 'pointer' }}>
              Speichern & Zurück ✨
            </button>
          </div>
        </div>
      )}

      {view === 'decks' && (
        <div>
          {/* Titel mit Biene frei links oben und zwei Capybaras */}
          <div style={{ position: 'relative', textAlign: 'center', marginBottom: '20px' }}>
            <img 
              src="/decorations/bee.svg" 
              alt="" 
              style={{ width: '22px', height: '22px', position: 'absolute', left: '10px', top: '-14px', pointerEvents: 'none' }} 
            />
            <img 
              src="/decorations/capybara-sleep.svg" 
              alt="" 
              style={{ width: '38px', position: 'absolute', left: '36px', bottom: '-2px', pointerEvents: 'none' }} 
            />
            <h2 style={{ margin: 0, fontSize: '26px', fontWeight: 700 }}>Meine Decks</h2>
            <img 
              src="/decorations/capybara-sit.svg" 
              alt="" 
              style={{ width: '34px', position: 'absolute', right: '32px', bottom: '-4px', pointerEvents: 'none' }} 
            />
          </div>

          {/* Manuelles Deck erstellen */}
          <form onSubmit={handleCreateDeck} style={{ display: 'flex', gap: '8px', marginBottom: '22px' }}>
            <input
              type="text"
              value={newDeckTitle}
              onChange={(e) => setNewDeckTitle(e.target.value)}
              placeholder="Neues leeres Deck..."
              style={{ flex: 1, padding: '12px 14px', borderRadius: radius, border: cardBorder, background: '#fff', color: '#2d1b2d', fontSize: '15px' }}
            />
            <button type="submit" style={{ padding: '12px 16px', borderRadius: radius, border: cardBorder, background: '#bae6fd', color: '#2d1b2d', fontWeight: 700, cursor: 'pointer' }}>
              + Deck
            </button>
          </form>

          {/* KI Deck Generator mit sitzendem Capybara oben rechts auf der Kante */}
          {aiEnabled && (
            <div style={{ position: 'relative', marginBottom: '20px' }}>
              <img 
                src="/decorations/capybara-sit.svg" 
                alt="" 
                style={{ width: '38px', position: 'absolute', right: '14px', top: '-27px', pointerEvents: 'none', zIndex: 2 }} 
              />
              <form onSubmit={handleGenerateDeck} style={{ background: '#fce7f3', padding: '14px', borderRadius: radius, border: cardBorder, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#9d174d' }}>✨ Deck per KI erstellen (gemini-3.8-flash)</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="Thema sprechen oder tippen..."
                    disabled={isGenerating}
                    style={{ flex: 1, padding: '10px 12px', borderRadius: '12px', border: cardBorder, background: '#fff', color: '#2d1b2d', fontSize: '14px' }}
                  />
                  <button
                    type="button"
                    onClick={() => listenToSpeech((text) => setAiPrompt(text), 'de-DE', 'aiPrompt', true)}
                    disabled={isGenerating}
                    style={{ padding: '0 14px', borderRadius: '12px', border: cardBorder, background: listeningTarget === 'aiPrompt' ? '#fca5a5' : '#e9d5ff', color: '#2d1b2d', fontSize: '18px', cursor: 'pointer' }}
                    title="Aufnahme starten/stoppen"
                  >
                    🎤
                  </button>
                </div>
                <button
                  type="submit"
                  disabled={isGenerating}
                  style={{ padding: '11px', borderRadius: '12px', border: cardBorder, background: '#d8b4fe', color: '#2d1b2d', fontWeight: 700, cursor: isGenerating ? 'not-allowed' : 'pointer' }}
                >
                  {isGenerating ? 'Warte auf Google API (max 30s)...' : '✨ KI-Deck erzeugen'}
                </button>
              </form>
            </div>
          )}

          {/* JSON Importer */}
          <div style={{ marginBottom: '24px', position: 'relative' }}>
            <button
              onClick={() => setShowImporter(!showImporter)}
              style={{ width: '100%', padding: '10px 14px', borderRadius: radius, border: cardBorder, background: '#fff', color: '#2d1b2d', fontSize: '13px', fontWeight: 600, cursor: 'pointer', textAlign: 'left', display: 'flex', justifyContent: 'space-between' }}
            >
              <span>📋 Deck per Text / JSON importieren</span>
              <span>{showImporter ? '▲' : '▼'}</span>
            </button>

            {showImporter && (
              <form onSubmit={handleImportJson} style={{ background: '#fff', padding: '12px', borderRadius: `0 0 ${radius} ${radius}`, border: cardBorder, borderTop: 'none', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <textarea
                  rows={4}
                  value={importJsonText}
                  onChange={(e) => setImportJsonText(e.target.value)}
                  placeholder='[{"frontText": "eins", "backText": "uno", "icon": "1️⃣"}]'
                  style={{ width: '100%', padding: '8px', borderRadius: '10px', border: cardBorder, background: '#fffaf0', color: '#2d1b2d', fontSize: '12px', fontFamily: 'monospace', boxSizing: 'border-box' }}
                />
                <button type="submit" style={{ padding: '9px', borderRadius: '10px', border: cardBorder, background: '#bae6fd', color: '#2d1b2d', fontWeight: 700, cursor: 'pointer' }}>
                  Import ausführen
                </button>
              </form>
            )}
          </div>

          {/* Deck-Liste */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {decks.map((deck) => {
              const count = cards.filter((c) => c.deckId === deck.id).length;
              const due = cards.filter((c) => c.deckId === deck.id && c.level < 3).length;
              return (
                <div key={deck.id} style={{ background: '#e0f2fe', padding: '14px', borderRadius: radius, border: cardBorder, position: 'relative' }}>
                  <img 
                    src="/decorations/cat-peek.svg" 
                    alt="" 
                    style={{ width: '32px', position: 'absolute', left: '16px', top: '-17px', pointerEvents: 'none' }} 
                  />
                  <img 
                    src="/decorations/capybara-sleep.svg" 
                    alt="" 
                    style={{ width: '38px', position: 'absolute', right: '18px', top: '-15px', pointerEvents: 'none' }} 
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <span style={{ fontWeight: 700, fontSize: '18px' }}>{deck.title}</span>
                    <span style={{ fontSize: '12px', color: '#0369a1', fontWeight: 600 }}>{count} Karten ({due} offen)</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => startStudy(deck.id)}
                      disabled={count === 0}
                      style={{ flex: 2, padding: '10px', borderRadius: '12px', border: cardBorder, background: count > 0 ? '#bbf7d0' : '#e2e8f0', color: '#2d1b2d', fontWeight: 700, cursor: count > 0 ? 'pointer' : 'not-allowed' }}
                    >
                      Lernen
                    </button>
                    <button
                      onClick={() => { setActiveDeckId(deck.id); setView('edit'); }}
                      style={{ flex: 1, padding: '10px', borderRadius: '12px', border: cardBorder, background: '#fed7aa', color: '#2d1b2d', fontWeight: 700, cursor: 'pointer' }}
                    >
                      Karten ({count})
                    </button>
                    <button
                      onClick={() => handleExportDeck(deck.id)}
                      title="Deck als JSON kopieren"
                      style={{ padding: '10px 12px', borderRadius: '12px', border: cardBorder, background: '#fff', color: '#2d1b2d', cursor: 'pointer' }}
                    >
                      📤
                    </button>
                    {decks.length > 1 && (
                      <button
                        onClick={() => handleDeleteDeck(deck.id)}
                        style={{ padding: '10px 12px', borderRadius: '12px', border: cardBorder, background: '#fecdd3', color: '#2d1b2d', cursor: 'pointer' }}
                      >
                        🗑
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === 'edit' && activeDeck && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <button onClick={() => setView('decks')} style={{ padding: '8px 14px', borderRadius: '12px', border: cardBorder, background: '#fff', color: '#2d1b2d', fontWeight: 700, cursor: 'pointer' }}>
              ← Zurück
            </button>
            <span style={{ fontWeight: 700, fontSize: '18px' }}>{activeDeck.title}</span>
          </div>

          <form onSubmit={handleAddCard} style={{ background: '#fff', padding: '14px', borderRadius: radius, marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '10px', border: cardBorder }}>
            <div style={{ fontSize: '14px', fontWeight: 700 }}>Neue Karte anlegen</div>
            
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                value={frontText}
                onChange={(e) => setFrontText(e.target.value)}
                placeholder="Vorderseite (Deutsch)..."
                style={{ flex: 1, padding: '10px', borderRadius: '12px', border: cardBorder, background: '#fffaf0', color: '#2d1b2d' }}
              />
              <button
                type="button"
                onClick={() => listenToSpeech((text) => setFrontText(text), 'de-DE', 'front')}
                style={{ padding: '0 14px', borderRadius: '12px', border: cardBorder, background: listeningTarget === 'front' ? '#fca5a5' : '#fed7aa', color: '#2d1b2d', cursor: 'pointer' }}
              >
                🎤
              </button>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                value={backText}
                onChange={(e) => setBackText(e.target.value)}
                placeholder="Rückseite (Spanisch)..."
                style={{ flex: 1, padding: '10px', borderRadius: '12px', border: cardBorder, background: '#fffaf0', color: '#2d1b2d' }}
              />
              <button
                type="button"
                onClick={() => listenToSpeech((text) => setBackText(text), 'es-ES', 'back')}
                style={{ padding: '0 14px', borderRadius: '12px', border: cardBorder, background: listeningTarget === 'back' ? '#fca5a5' : '#fed7aa', color: '#2d1b2d', cursor: 'pointer' }}
              >
                🎤
              </button>
            </div>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="text"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="Emoji (z.B. 🍎)"
                style={{ width: '100px', padding: '10px', borderRadius: '12px', border: cardBorder, background: '#fffaf0', color: '#2d1b2d' }}
              />
              <label style={{ fontSize: '13px', color: '#2d1b2d', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', marginLeft: 'auto', fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={showIconRandomly}
                  onChange={(e) => setShowIconRandomly(e.target.checked)}
                  style={{ accentColor: '#ec4899' }}
                />
                Zufällig nur Icon
              </label>
            </div>
            <button type="submit" style={{ padding: '12px', borderRadius: '12px', border: cardBorder, background: '#bae6fd', color: '#2d1b2d', fontWeight: 700, cursor: 'pointer' }}>
              + Karte speichern ✨
            </button>
          </form>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '14px', fontWeight: 700 }}>Karten ({deckCards.length}):</span>
            <button onClick={() => resetDeckLevels(activeDeck.id)} style={{ fontSize: '12px', padding: '4px 10px', borderRadius: '8px', border: cardBorder, background: '#fff', color: '#2d1b2d', cursor: 'pointer', fontWeight: 600 }}>
              Levels resetten
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {deckCards.map((c) => (
              <div key={c.id} style={{ background: '#fff', padding: '10px 14px', borderRadius: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: cardBorder }}>
                <div>
                  <div style={{ fontSize: '15px' }}><strong>{c.icon} {c.frontText}</strong> → <span style={{ color: '#0284c7', fontWeight: 600 }}>{c.backText}</span></div>
                  <div style={{ fontSize: '11px', color: '#71717a' }}>Level: {c.level} | Fehler: {c.failCountTotal}</div>
                </div>
                <button onClick={() => handleDeleteCard(c.id)} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '16px', fontWeight: 700 }}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === 'study' && activeDeck && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
            <button onClick={() => setView('decks')} style={{ padding: '8px 14px', borderRadius: '14px', border: cardBorder, background: '#fff', color: '#2d1b2d', fontWeight: 700, cursor: 'pointer' }}>
              ← Decks
            </button>
            <span style={{ fontWeight: 700, fontSize: '18px' }}>{activeDeck.title}</span>
            <div style={{ position: 'relative' }}>
              <img 
                src="/decorations/cat-peek.svg" 
                alt="" 
                style={{ width: '28px', position: 'absolute', top: '-16px', left: '14px', pointerEvents: 'none' }} 
              />
              <span style={{ fontSize: '13px', background: '#fff', padding: '6px 12px', borderRadius: '14px', border: cardBorder, fontWeight: 700 }}>
                Rest: {queueSnapshot.length}
              </span>
            </div>
          </div>

          {currentCard ? (
            <>
              <div style={{ background: '#ffe4e6', borderRadius: '24px', minHeight: '210px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '24px', textAlign: 'center', border: cardBorder, position: 'relative' }}>
                <img 
                  src="/decorations/capybara-sit.svg" 
                  alt="" 
                  style={{ width: '44px', position: 'absolute', top: '-29px', pointerEvents: 'none' }} 
                />

                <div style={{ fontSize: '13px', color: '#881337', marginBottom: '14px', fontWeight: 700 }}>
                  Level: {currentCard.level} | Fehler: {currentCard.failCountTotal}
                </div>

                {showOnlyIcon && currentCard.icon ? (
                  <div style={{ fontSize: '72px' }}>{currentCard.icon}</div>
                ) : (
                  <div style={{ fontSize: '30px', fontWeight: 700 }}>
                    {currentCard.icon && <span style={{ marginRight: '10px' }}>{currentCard.icon}</span>}
                    {currentCard.frontText}
                  </div>
                )}

                {checkResult !== null && (
                  <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '2px dashed #f43f5e', width: '100%' }}>
                    <div style={{ fontSize: '12px', color: '#881337', fontWeight: 600 }}>Lösung:</div>
                    <div style={{ fontSize: '24px', fontWeight: 700, color: checkResult === 'correct' ? '#16a34a' : '#dc2626' }}>
                      {currentCard.backText}
                    </div>
                  </div>
                )}
              </div>

              {checkResult === null ? (
                <form onSubmit={handleCheck} style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="text"
                      value={userInput}
                      onChange={(e) => setUserInput(e.target.value)}
                      placeholder="Übersetzung eingeben/sprechen..."
                      autoFocus
                      style={{ flex: 1, padding: '14px', borderRadius: '16px', border: cardBorder, background: '#fff', color: '#2d1b2d', fontSize: '16px', boxSizing: 'border-box' }}
                    />
                    <button
                      type="button"
                      onClick={() => listenToSpeech((text) => setUserInput(text), 'es-ES', 'study')}
                      style={{ padding: '0 18px', borderRadius: '16px', border: cardBorder, background: listeningTarget === 'study' ? '#fca5a5' : '#e9d5ff', color: '#2d1b2d', fontSize: '22px', cursor: 'pointer' }}
                    >
                      🎤
                    </button>
                  </div>
                  <button
                    type="submit"
                    style={{ padding: '14px', borderRadius: '16px', border: cardBorder, background: '#bae6fd', color: '#2d1b2d', fontSize: '18px', fontWeight: 700, cursor: 'pointer' }}
                  >
                    Prüfen
                  </button>
                </form>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '16px' }}>
                  <button
                    onClick={() => commitAnswer(checkResult === 'correct')}
                    style={{ padding: '14px', borderRadius: '16px', border: cardBorder, background: checkResult === 'correct' ? '#bbf7d0' : '#fecdd3', color: '#2d1b2d', fontSize: '18px', fontWeight: 700, cursor: 'pointer' }}
                  >
                    {checkResult === 'correct' ? '✓ Richtig – Weiter 🐾' : '✗ Falsch – Weiter'}
                  </button>
                  {checkResult === 'wrong' && (
                    <button
                      onClick={() => commitAnswer(true)}
                      style={{ padding: '10px', borderRadius: '12px', border: cardBorder, background: '#fff', color: '#4b5563', fontSize: '13px', cursor: 'pointer', fontWeight: 600 }}
                    >
                      War nur ein Tippfehler (Als richtig werten)
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '40px 20px', background: '#fff', borderRadius: radius, border: cardBorder }}>
              <h3 style={{ margin: '0 0 10px 0', fontSize: '22px' }}>Session erledigt! 🎉</h3>
              <button onClick={() => setView('decks')} style={{ padding: '10px 20px', borderRadius: '14px', border: cardBorder, background: '#bae6fd', color: '#2d1b2d', fontWeight: 700, cursor: 'pointer' }}>
                Zurück zu den Decks 🐾
              </button>
            </div>
          )}

          <div style={{ marginTop: '28px', borderTop: '2px dashed #cbd5e1', paddingTop: '14px', position: 'relative' }}>
            <img 
              src="/decorations/bee.svg" 
              alt="" 
              style={{ width: '22px', position: 'absolute', right: '12px', top: '10px', pointerEvents: 'none' }} 
            />
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px', fontWeight: 700 }}>
              LIVE-WARTESCHLANGE:
            </div>
            {queueSnapshot.map((c, index) => (
              <div key={c.id + '-' + index} style={{ fontSize: '13px', padding: '8px 12px', background: index === 0 ? '#fef08a' : '#fff', borderRadius: '10px', border: index === 0 ? cardBorder : '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span><strong>#{index}</strong> {c.icon} {c.frontText}</span>
                <span style={{ color: '#64748b', fontWeight: 600 }}>Lvl: {c.level} | Fehler: {c.failCountTotal}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}