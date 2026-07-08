export type RegimenItem = {
  name: string;
  sets?: number;
  reps?: string;
  weight?: string;
  rest?: string;
  zone?: string;
  dist?: string;
  pace?: string;
};

export type WorkoutLog = {
  sessionId: string;
  items: RegimenItem[];
  warmup?: string;
  cooldown?: string;
  actualDuration?: number;
  rpe?: number;
  logNotes?: string;
  loggedAt?: string;
  aiGenerated?: boolean;
};
