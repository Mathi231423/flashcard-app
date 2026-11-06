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

  // Deck-Erstellung & Import
  const [newDeckTitle, setNewDeckTitle] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [importJsonText, setImportJsonText] = useState('');
  const [showImporter, setShowImporter] = useState(false);

  // Karten-Editor
  const [frontText, setFrontText] = useState('');
  const [backText, setBackText] = useState('');
  const [icon, setIcon] = useState('');
  const [showIconRandomly, setShowIconRandomly] = useState(true);

  // Lern-Session
  const [session, setSession] = useState<SessionQueue | null>(null);
  const [queueSnapshot, setQueueSnapshot] = useState<Card[]>([]);
  const [userInput, setUserInput] = useState('');
  const [checkResult, setCheckResult] = useState<'correct' | 'wrong' | null>(null);
  const [showOnlyIcon, setShowOnlyIcon] = useState(false);

  // Aktives Mikrofon & Instanz-Cleanup
  const [listeningTarget, setListeningTarget] = useState<string | null>(null);
  const activeRecognitionRef = useRef<any>(null);

  const stopActiveRecognition = () => {
    if (activeRecognitionRef.current) {
      try {
        activeRecognitionRef.current.abort();
      } catch {
        // Ignorieren falls bereits inaktiv
      }
      activeRecognitionRef.current = null;
    }
    setListeningTarget(null);
  };

  useEffect(() => {
    return () => {
      stopActiveRecognition();
    };
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
      alert('Spracherkennung wird in diesem Browser nicht unterstützt.');
      return;
    }

    const recognition = new SpeechRecognitionAPI();
    activeRecognitionRef.current = recognition;

    recognition.lang = lang;
    recognition.interimResults = true;
    recognition.continuous = continuousMode;

    recognition.onstart = () => {
      setListeningTarget(targetId);
    };

    recognition.onend = () => {
      if (activeRecognitionRef.current === recognition) {
        activeRecognitionRef.current = null;
        setListeningTarget(null);
      }
    };

    recognition.onerror = (event: any) => {
      stopActiveRecognition();
      if (event.error === 'not-allowed') {
        alert('Mikrofon blockiert! Bitte Berechtigung in den Browsereinstellungen freigeben.');
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
    if (!aiEnabled) return;
    if (!aiPrompt.trim()) return;

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
      if (firstBrace === -1 || lastBrace === -1) throw new Error('Ungültiges Datenformat von der KI erhalten.');

      const parsed = JSON.parse(rawJson.substring(firstBrace, lastBrace + 1));
      const cardsArray = Array.isArray(parsed.cards) ? parsed.cards : [];
      if (cardsArray.length === 0) throw new Error('Keine Karten im KI-Ergebnis gefunden.');

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
      alert(`Deck "${newDeckTitleClean}" (${newCards.length} Karten) erfolgreich erstellt!`);
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
      if (!Array.isArray(rawCards) || rawCards.length === 0) throw new Error('Array ist leer oder ungültig.');

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
      alert(`Deck "${newDeck.title}" (${createdCards.length} Karten) importiert!`);
    } catch (err: any) {
      alert('Fehler beim Import: ' + err.message);
    }
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

    if (checkAnswerTolerant(userInput, currentCard.backText)) {
      setCheckResult('correct');
    } else {
      setCheckResult('wrong');
    }
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

  return (
    <div style={{ maxWidth: '420px', margin: '0 auto', padding: '16px', fontFamily: 'system-ui, sans-serif', color: '#f8fafc', backgroundColor: '#0f172a', minHeight: '100vh', boxSizing: 'border-box' }}>
      
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
        <button onClick={() => setView('settings')} style={{ background: 'transparent', border: 'none', color: '#94a3b8', fontSize: '13px', cursor: 'pointer' }}>
          ⚙️ Einstellungen {aiEnabled ? (apiKey ? '(KI Ein)' : '(Kein Key)') : '(KI Aus)'}
        </button>
      </div>

      {view === 'settings' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <button onClick={() => setView('decks')} style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid #475569', background: 'transparent', color: '#fff', cursor: 'pointer' }}>
              ← Zurück
            </button>
            <span style={{ fontWeight: 700 }}>Einstellungen</span>
          </div>

          <div style={{ background: '#1e293b', padding: '16px', borderRadius: '14px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600 }}>KI-Deck-Generator aktivieren</div>
                <div style={{ fontSize: '11px', color: '#94a3b8' }}>Ausschalten, um jegliche API-Kosten zu verhindern</div>
              </div>
              <input
                type="checkbox"
                checked={aiEnabled}
                onChange={(e) => setAiEnabled(e.target.checked)}
                style={{ width: '20px', height: '20px', cursor: 'pointer' }}
              />
            </div>

            <div style={{ borderTop: '1px solid #334155', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>Gemini API-Key</div>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Dein Gemini API-Key..."
                disabled={!aiEnabled}
                style={{ padding: '12px', borderRadius: '8px', border: '1px solid #475569', background: '#0f172a', color: '#fff', fontSize: '14px', opacity: aiEnabled ? 1 : 0.5 }}
              />
            </div>

            <button onClick={() => setView('decks')} style={{ padding: '12px', borderRadius: '8px', border: 'none', background: '#3b82f6', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
              Speichern & Zurück
            </button>
          </div>
        </div>
      )}

      {view === 'decks' && (
        <div>
          <h2 style={{ marginTop: 0, fontSize: '22px' }}>Meine Decks</h2>

          <form onSubmit={handleCreateDeck} style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <input
              type="text"
              value={newDeckTitle}
              onChange={(e) => setNewDeckTitle(e.target.value)}
              placeholder="Neues leeres Deck..."
              style={{ flex: 1, padding: '12px', borderRadius: '10px', border: '1px solid #475569', background: '#1e293b', color: '#fff', fontSize: '15px' }}
            />
            <button type="submit" style={{ padding: '12px 14px', borderRadius: '10px', border: 'none', background: '#3b82f6', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
              + Deck
            </button>
          </form>

          {aiEnabled && (
            <form onSubmit={handleGenerateDeck} style={{ background: '#1e293b', padding: '12px', borderRadius: '12px', marginBottom: '12px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#38bdf8' }}>✨ Deck per KI erstellen (gemini-3.8-flash)</div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="Thema sprechen oder tippen..."
                  disabled={isGenerating}
                  style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid #475569', background: '#0f172a', color: '#fff', fontSize: '14px' }}
                />
                <button
                  type="button"
                  onClick={() => listenToSpeech((text) => setAiPrompt(text), 'de-DE', 'aiPrompt', true)}
                  disabled={isGenerating}
                  style={{ padding: '0 14px', borderRadius: '8px', border: 'none', background: listeningTarget === 'aiPrompt' ? '#ef4444' : '#334155', color: '#fff', fontSize: '18px', cursor: 'pointer' }}
                  title="Thema auf Deutsch einsprechen (Klick zum Stoppen)"
                >
                  🎤
                </button>
              </div>
              <button
                type="submit"
                disabled={isGenerating}
                style={{ padding: '10px', borderRadius: '8px', border: 'none', background: '#8b5cf6', color: '#fff', fontWeight: 600, cursor: isGenerating ? 'not-allowed' : 'pointer' }}
              >
                {isGenerating ? 'Warte auf Google API (max 30s)...' : '✨ KI-Deck erzeugen'}
              </button>
            </form>
          )}

          <div style={{ marginBottom: '20px' }}>
            <button
              onClick={() => setShowImporter(!showImporter)}
              style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid #475569', background: '#1e293b', color: '#cbd5e1', fontSize: '13px', cursor: 'pointer', textAlign: 'left', display: 'flex', justifyContent: 'space-between' }}
            >
              <span>📋 Deck per Text / JSON importieren</span>
              <span>{showImporter ? '▲' : '▼'}</span>
            </button>

            {showImporter && (
              <form onSubmit={handleImportJson} style={{ background: '#1e293b', padding: '12px', borderRadius: '0 0 10px 10px', border: '1px solid #475569', borderTop: 'none', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <textarea
                  rows={5}
                  value={importJsonText}
                  onChange={(e) => setImportJsonText(e.target.value)}
                  placeholder='Füge hier JSON ein, z.B.:&#10;[&#10;  {"frontText": "eins", "backText": "uno", "icon": "1️⃣"}&#10;]'
                  style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid #475569', background: '#0f172a', color: '#fff', fontSize: '12px', fontFamily: 'monospace', boxSizing: 'border-box' }}
                />
                <button type="submit" style={{ padding: '10px', borderRadius: '8px', border: 'none', background: '#0284c7', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
                  Import ausführen
                </button>
              </form>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {decks.map((deck) => {
              const count = cards.filter((c) => c.deckId === deck.id).length;
              const due = cards.filter((c) => c.deckId === deck.id && c.level < 3).length;
              return (
                <div key={deck.id} style={{ background: '#1e293b', padding: '16px', borderRadius: '14px', border: '1px solid #334155' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <span style={{ fontWeight: 700, fontSize: '17px' }}>{deck.title}</span>
                    <span style={{ fontSize: '12px', color: '#94a3b8' }}>{count} Karten ({due} offen)</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => startStudy(deck.id)}
                      disabled={count === 0}
                      style={{ flex: 2, padding: '10px', borderRadius: '8px', border: 'none', background: count > 0 ? '#22c55e' : '#334155', color: '#fff', fontWeight: 600, cursor: count > 0 ? 'pointer' : 'not-allowed' }}
                    >
                      Lernen
                    </button>
                    <button
                      onClick={() => { setActiveDeckId(deck.id); setView('edit'); }}
                      style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid #475569', background: 'transparent', color: '#e2e8f0', cursor: 'pointer' }}
                    >
                      Karten ({count})
                    </button>
                    {decks.length > 1 && (
                      <button
                        onClick={() => handleDeleteDeck(deck.id)}
                        style={{ padding: '10px', borderRadius: '8px', border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer' }}
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
            <button onClick={() => setView('decks')} style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid #475569', background: 'transparent', color: '#fff', cursor: 'pointer' }}>
              ← Zurück
            </button>
            <span style={{ fontWeight: 700 }}>{activeDeck.title}</span>
          </div>

          <form onSubmit={handleAddCard} style={{ background: '#1e293b', padding: '14px', borderRadius: '14px', marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '10px', border: '1px solid #334155' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '2px' }}>Neue Karte anlegen (Tippen oder Sprechen)</div>
            
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                value={frontText}
                onChange={(e) => setFrontText(e.target.value)}
                placeholder="Vorderseite (Deutsch)..."
                style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid #475569', background: '#0f172a', color: '#fff' }}
              />
              <button
                type="button"
                onClick={() => listenToSpeech((text) => setFrontText(text), 'de-DE', 'front')}
                style={{ padding: '0 12px', borderRadius: '8px', border: 'none', background: listeningTarget === 'front' ? '#ef4444' : '#334155', color: '#fff', cursor: 'pointer' }}
                title="Deutsch einsprechen"
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
                style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid #475569', background: '#0f172a', color: '#fff' }}
              />
              <button
                type="button"
                onClick={() => listenToSpeech((text) => setBackText(text), 'es-ES', 'back')}
                style={{ padding: '0 12px', borderRadius: '8px', border: 'none', background: listeningTarget === 'back' ? '#ef4444' : '#334155', color: '#fff', cursor: 'pointer' }}
                title="Spanisch einsprechen"
              >
                🎤
              </button>
            </div>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="text"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="Emoji (z.B. 1️⃣)"
                style={{ width: '100px', padding: '10px', borderRadius: '8px', border: '1px solid #475569', background: '#0f172a', color: '#fff' }}
              />
              <label style={{ fontSize: '12px', color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', marginLeft: 'auto' }}>
                <input
                  type="checkbox"
                  checked={showIconRandomly}
                  onChange={(e) => setShowIconRandomly(e.target.checked)}
                />
                Zufällig nur Icon
              </label>
            </div>
            <button type="submit" style={{ padding: '12px', borderRadius: '8px', border: 'none', background: '#3b82f6', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
              + Karte speichern
            </button>
          </form>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '13px', color: '#94a3b8' }}>Karten ({deckCards.length}):</span>
            <button onClick={() => resetDeckLevels(activeDeck.id)} style={{ fontSize: '11px', padding: '4px 8px', borderRadius: '6px', border: '1px solid #475569', background: 'transparent', color: '#94a3b8', cursor: 'pointer' }}>
              Levels zurücksetzen
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {deckCards.map((c) => (
              <div key={c.id} style={{ background: '#1e293b', padding: '10px 12px', borderRadius: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '14px' }}>
                <div>
                  <div><strong>{c.icon} {c.frontText}</strong> → <span style={{ color: '#38bdf8' }}>{c.backText}</span></div>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>Level: {c.level} | Gesamtfehler: {c.failCountTotal}</div>
                </div>
                <button onClick={() => handleDeleteCard(c.id)} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '16px' }}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === 'study' && activeDeck && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <button onClick={() => setView('decks')} style={{ padding: '6px 12px', borderRadius: '8px', border: '1px solid #475569', background: 'transparent', color: '#fff', cursor: 'pointer' }}>
              ← Decks
            </button>
            <span style={{ fontWeight: 700, fontSize: '16px' }}>{activeDeck.title}</span>
            <span style={{ fontSize: '13px', background: '#1e293b', padding: '4px 10px', borderRadius: '12px' }}>
              Rest: {queueSnapshot.length}
            </span>
          </div>

          {currentCard ? (
            <>
              <div style={{ background: '#1e293b', borderRadius: '16px', minHeight: '190px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '20px', textAlign: 'center', border: '2px solid #334155' }}>
                <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '12px' }}>
                  Level: {currentCard.level} | Gesamtfehler: {currentCard.failCountTotal} | Folge-Fehler: {currentCard.consecutiveFails}
                </div>

                {showOnlyIcon && currentCard.icon ? (
                  <div style={{ fontSize: '68px' }}>{currentCard.icon}</div>
                ) : (
                  <div style={{ fontSize: '26px', fontWeight: 600 }}>
                    {currentCard.icon && <span style={{ marginRight: '10px' }}>{currentCard.icon}</span>}
                    {currentCard.frontText}
                  </div>
                )}

                {checkResult !== null && (
                  <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid #334155', width: '100%' }}>
                    <div style={{ fontSize: '13px', color: '#94a3b8' }}>Lösung:</div>
                    <div style={{ fontSize: '22px', fontWeight: 700, color: checkResult === 'correct' ? '#22c55e' : '#ef4444' }}>
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
                      style={{ flex: 1, padding: '14px', borderRadius: '12px', border: '1px solid #475569', background: '#0f172a', color: '#fff', fontSize: '16px', boxSizing: 'border-box' }}
                    />
                    <button
                      type="button"
                      onClick={() => listenToSpeech((text) => setUserInput(text), 'es-ES', 'study')}
                      style={{ padding: '0 16px', borderRadius: '12px', border: 'none', background: listeningTarget === 'study' ? '#ef4444' : '#334155', color: '#fff', fontSize: '20px', cursor: 'pointer' }}
                    >
                      🎤
                    </button>
                  </div>
                  <button
                    type="submit"
                    style={{ padding: '14px', borderRadius: '12px', border: 'none', background: '#3b82f6', color: '#fff', fontSize: '16px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    Prüfen
                  </button>
                </form>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '16px' }}>
                  <button
                    onClick={() => commitAnswer(checkResult === 'correct')}
                    style={{ padding: '14px', borderRadius: '12px', border: 'none', background: checkResult === 'correct' ? '#22c55e' : '#ef4444', color: '#fff', fontSize: '16px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    {checkResult === 'correct' ? '✓ Richtig – Weiter' : '✗ Falsch – Weiter'}
                  </button>
                  {checkResult === 'wrong' && (
                    <button
                      onClick={() => commitAnswer(true)}
                      style={{ padding: '10px', borderRadius: '10px', border: '1px solid #475569', background: 'transparent', color: '#cbd5e1', fontSize: '13px', cursor: 'pointer' }}
                    >
                      War nur ein Tippfehler (Als richtig werten)
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '40px 20px', background: '#1e293b', borderRadius: '16px' }}>
              <h3>Session erledigt! 🎉</h3>
              <button onClick={() => setView('decks')} style={{ marginTop: '12px', padding: '10px 18px', borderRadius: '10px', border: 'none', background: '#3b82f6', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
                Zurück zu den Decks
              </button>
            </div>
          )}

          <div style={{ marginTop: '28px', borderTop: '1px solid #334155', paddingTop: '12px' }}>
            <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '8px', fontWeight: 600 }}>
              LIVE-WARTESCHLANGE:
            </div>
            {queueSnapshot.map((c, index) => (
              <div key={c.id + '-' + index} style={{ fontSize: '12px', padding: '6px 8px', background: index === 0 ? '#334155' : 'transparent', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                <span><strong>#{index}</strong> {c.icon} {c.frontText}</span>
                <span style={{ color: '#94a3b8' }}>Lvl:{c.level} | Err:{c.failCountTotal}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}