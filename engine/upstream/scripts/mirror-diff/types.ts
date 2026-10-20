export interface ControlSnapshot {
  kind: string;
  value: string;
  checked?: boolean;
  selected?: string[];
}

export interface ScrollSnapshot {
  x: number;
  y: number;
}

export interface DomSnapshot {
  text: string;
  elementCount: number;
  tagCounts: Record<string, number>;
  imageCount: number;
  controls: Record<string, ControlSnapshot>;
  activeElement: string | null;
  scroll: Record<string, ScrollSnapshot>;
}

export interface ComponentScores {
  text: number;
  elements: number;
  tags: number;
  images: number;
  controls: number;
  activeElement: number;
  scroll: number;
}

export interface DiffScore {
  score: number;
  components: ComponentScores;
  differences: {
    controls: string[];
    activeElement: { server: string | null; mirror: string | null } | null;
    scroll: string[];
  };
}
