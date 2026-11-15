/**
 * Problem taśmy: kłopot z narzędziami albo komendami projektu, a nie z samym zadaniem (np. komenda wypisuje
 * błąd, którego zadanie nie usunie). Agent go zgłasza, taśma się nie zatrzymuje, a dziennik zbiera zgłoszenia.
 */
export interface LineProblem {
  stage: string;
  problem: string;
  /** Kiedy zgłoszono (ISO); razem z treścią odróżnia zgłoszenia, gdy opis PR przenosi je między rundami. */
  at: string;
}
