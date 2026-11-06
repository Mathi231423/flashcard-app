export interface Deck {
  id: string;
  title: string;
  createdAt: number;
}

export interface Card {
  id: string;
  deckId: string;
  frontText: string;
  backText: string;
  icon?: string;
  showIconRandomly?: boolean;
  level: number;              // 0 = neu/wiederholen, 1 = 1x richtig, 2 = 2x richtig, 3 = fertig
  consecutiveFails: number;   // Direkt aufeinanderfolgende Fehler
  failCountTotal: number;     // Gesamtzahl aller Fehler (für Priorisierung)
  nextReviewDate?: number;    // Zeitstempel für spätere Langzeitwiederholung
}

export class SessionQueue {
  private queue: Card[] = [];

  constructor(cards: Card[]) {
    // Karten mit den meisten Gesamtfehlern starten ganz vorne
    this.queue = [...cards].sort((a, b) => b.failCountTotal - a.failCountTotal);
  }

  getCurrentCard(): Card | null {
    return this.queue.length > 0 ? this.queue[0] : null;
  }

  handleAnswer(correct: boolean): Card | null {
    if (this.queue.length === 0) return null;

    // Kopie der aktuellen Karte entnehmen (sauber für React-State)
    const card = { ...this.queue.shift()! };

    if (!correct) {
      card.failCountTotal += 1;
      card.consecutiveFails += 1;
      card.level = 0;

      // Wiederholter Fehler: 1-3 Karten zurück | Erster Fehler: 2-4 Karten zurück
      const offset = card.consecutiveFails > 1
        ? this.getRandomInt(1, 3)
        : this.getRandomInt(2, 4);

      this.insertAt(card, offset);
    } else {
      card.consecutiveFails = 0;
      card.level += 1;

      if (card.level === 1) {
        this.insertAt(card, 5);
      } else if (card.level === 2) {
        this.insertAt(card, 12);
      } else {
        // Level 3 erreicht: Karte verlässt die aktuelle Session (24h Pause)
        card.nextReviewDate = Date.now() + 86400000;
      }
    }

    return card;
  }

  private insertAt(card: Card, offset: number): void {
    const targetIndex = Math.min(offset, this.queue.length);
    this.queue.splice(targetIndex, 0, card);
  }

  private getRandomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  get remainingCount(): number {
    return this.queue.length;
  }

  getQueueSnapshot(): Card[] {
    return [...this.queue];
  }
}