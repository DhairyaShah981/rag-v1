// Module contracts (DESIGN §i).
export type RawDoc = { source: string; section: string; text: string };

export type Chunk = {
  id: string;
  text: string;
  source: string;
  section: string;
  chunkIndex: number;
};

export type Scored = Chunk & { score: number; usedInPrompt: boolean };
