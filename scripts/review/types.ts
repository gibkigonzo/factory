// Typy perspektyw recenzji bez zależności od Node, żeby mogły ich używać czyste moduły (np. moduł dla aplikacji).

export interface PerspectiveDef {
  name: string;
  title: string;
  description: string;
  paths?: string[];
  zones?: string[];
  /** Perspektywa ocenia zrzuty ekranu: jej recenzent dostaje zrzuty sekcji zmienionych przez PR. */
  screenshots?: boolean;
  source: 'catalog' | 'project';
  file: string;
  /** Pełna treść pliku: frontmatter i kryteria. */
  text: string;
}
