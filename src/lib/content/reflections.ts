/**
 * Daily philosophical reflections for the Command page. Moved out of
 * ConsoleModule so the content lives beside the other rotating corpora
 * (devotionals, poems) and rotation is handled by the shared daily helpers.
 */
export type Reflection = {
  text: string;
  author: string;
  source?: string;
};

export const DAILY_REFLECTIONS: readonly Reflection[] = [
  { text: "The unexamined life is not worth living.", author: "Socrates", source: "Apology" },
  { text: "Man is condemned to be free.", author: "Jean-Paul Sartre", source: "Existentialism is a Humanism" },
  { text: "To know what you know and what you do not know — that is true knowledge.", author: "Confucius", source: "Analects" },
  { text: "The obstacle is the way.", author: "Marcus Aurelius", source: "Meditations" },
  { text: "Life must be understood backwards, but it must be lived forwards.", author: "Søren Kierkegaard" },
  { text: "We are what we repeatedly do. Excellence, then, is not an act, but a habit.", author: "Aristotle" },
  { text: "He who has a why to live can bear almost any how.", author: "Friedrich Nietzsche", source: "Twilight of the Idols" },
  { text: "Cogito, ergo sum.", author: "René Descartes", source: "Discourse on the Method" },
  { text: "The limits of my language mean the limits of my world.", author: "Ludwig Wittgenstein", source: "Tractatus" },
  { text: "One cannot step into the same river twice.", author: "Heraclitus" },
  { text: "The cave you fear to enter holds the treasure you seek.", author: "Joseph Campbell", source: "The Hero with a Thousand Faces" },
  { text: "Simplicity is the ultimate sophistication.", author: "Leonardo da Vinci" },
  { text: "Beauty will save the world.", author: "Fyodor Dostoevsky", source: "The Idiot" },
  { text: "The journey of a thousand miles begins with one step.", author: "Lao Tzu", source: "Tao Te Ching" },
  { text: "The soul becomes dyed with the colour of its thoughts.", author: "Marcus Aurelius", source: "Meditations" },
  { text: "Time you enjoy wasting is not wasted time.", author: "Bertrand Russell" },
  { text: "All that we see or seem is but a dream within a dream.", author: "Edgar Allan Poe" },
  { text: "Knowing yourself is the beginning of all wisdom.", author: "Aristotle" },
  { text: "Not all who wander are lost.", author: "J.R.R. Tolkien", source: "The Fellowship of the Ring" },
  { text: "The present moment always will have been.", author: "Marcus Aurelius", source: "Meditations" },
  { text: "To do great work, one must know how to wait.", author: "Leo Tolstoy" },
  { text: "Between stimulus and response there is a space. In that space is our power to choose.", author: "Viktor Frankl", source: "Man's Search for Meaning" },
  { text: "The hardest thing in the world is to simplify your life. It's so easy to make it complex.", author: "Yvon Chouinard" },
  { text: "In the depth of winter I finally learned that there was in me an invincible summer.", author: "Albert Camus" },
  { text: "Do not pray for an easy life; pray for the strength to endure a difficult one.", author: "Bruce Lee" },
  { text: "What is not started today is never finished tomorrow.", author: "Johann Wolfgang von Goethe" },
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { text: "Excellence is never an accident.", author: "Aristotle" },
] as const;
