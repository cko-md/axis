/**
 * Poem of the Day corpus for the Command page.
 *
 * CURATED_POEMS is a hand-picked list of public-domain poems whose (author,
 * title) pairs were each verified to exist in PoetryDB (poetrydb.org — itself
 * a public-domain corpus) on 2026-07-22. Titles must match PoetryDB EXACTLY,
 * including punctuation, capitalization, and Dickinson's trailing dashes: the
 * poem route queries `author,title/...;<title>:abs` (absolute match).
 *
 * Everything here is public domain — do not add post-1928 poets whose work is
 * still in copyright; their fetches would fail against PoetryDB anyway.
 *
 * FALLBACK_POEMS carries four complete short poems (fetched verbatim from
 * PoetryDB) so the card still shows a real poem when the provider is down.
 */

export type CuratedPoem = {
  author: string;
  title: string;
};

export type PoemPayload = {
  title: string;
  author: string;
  lines: string[];
  source: "poetrydb" | "local";
};

export const CURATED_POEMS: readonly CuratedPoem[] = [
  { author: "Percy Bysshe Shelley", title: "Ozymandias" },
  { author: "Percy Bysshe Shelley", title: "Love's Philosophy" },
  { author: "Percy Bysshe Shelley", title: "To Night" },
  { author: "Percy Bysshe Shelley", title: "Time" },
  { author: "William Blake", title: "The Tyger" },
  { author: "William Blake", title: "Ah Sunflower" },
  { author: "William Blake", title: "The Sick Rose" },
  { author: "William Blake", title: "A POISON TREE" },
  { author: "William Blake", title: "London" },
  { author: "William Blake", title: "The Lamb" },
  { author: "Emily Dickinson", title: "\"Hope\" is the thing with feathers" },
  { author: "Emily Dickinson", title: "Success is counted sweetest" },
  { author: "Emily Dickinson", title: "I felt a Funeral, in my Brain," },
  { author: "Emily Dickinson", title: "We grow accustomed to the Dark" },
  { author: "Emily Dickinson", title: "Water, is taught by thirst." },
  { author: "Emily Dickinson", title: "A Light exists in Spring" },
  { author: "Emily Dickinson", title: "My life closed twice before its close --" },
  { author: "Emily Dickinson", title: "I died for Beauty -- but was scarce" },
  { author: "Emily Dickinson", title: "In this short Life" },
  { author: "Walt Whitman", title: "O Me! O Life!" },
  { author: "Walt Whitman", title: "On the Beach at Night, Alone." },
  { author: "Walt Whitman", title: "Full of Life, Now." },
  { author: "Walt Whitman", title: "To a Locomotive in Winter." },
  { author: "Walt Whitman", title: "Look Down, Fair Moon." },
  { author: "John Keats", title: "On First Looking Into Chapman's Homer" },
  { author: "John Keats", title: "Bright Star, Would I Were Steadfast As Thou Art" },
  { author: "John Keats", title: "To Autumn" },
  { author: "John Keats", title: "In Drear-Nighted December" },
  { author: "Christina Rossetti", title: "A Birthday" },
  { author: "Christina Rossetti", title: "From Sunset to Star Rise" },
  { author: "John Donne", title: "Holy Sonnet X: Death Be Not Proud" },
  { author: "John Donne", title: "A Hymn To God The Father" },
  { author: "George Herbert", title: "Prayer" },
  { author: "George Herbert", title: "Life" },
  { author: "Paul Laurence Dunbar", title: "Sympathy" },
  { author: "Paul Laurence Dunbar", title: "Life's Tragedy" },
  { author: "Edgar Allan Poe", title: "Eldorado" },
  { author: "Edgar Allan Poe", title: "To Helen" },
  { author: "Edgar Allan Poe", title: "Sonnet--To Science" },
  { author: "Henry Wadsworth Longfellow", title: "A Psalm of Life" },
  { author: "Henry Wadsworth Longfellow", title: "The Rainy Day" },
  { author: "Henry Wadsworth Longfellow", title: "Nature" },
  { author: "Emily Bronte", title: "Hope" },
  { author: "Emily Bronte", title: "The Night is Darkening Around Me" },
  { author: "Robert Browning", title: "Prospice" },
  { author: "Robert Browning", title: "My Star" },
  { author: "Robert Browning", title: "Home Thoughts, From Abroad" },
  { author: "Robert Browning", title: "Memorabilia" },
] as const;

export const FALLBACK_POEMS: readonly PoemPayload[] = [
  {
    title: "Ozymandias",
    author: "Percy Bysshe Shelley",
    source: "local",
    lines: [
      "I met a traveller from an antique land",
      "Who said: Two vast and trunkless legs of stone",
      "Stand in the desert...Near them, on the sand,",
      "Half sunk, a shattered visage lies, whose frown,",
      "And wrinkled lip, and sneer of cold command,",
      "Tell that its sculptor well those passions read",
      "Which yet survive, stamped on these lifeless things,",
      "The hand that mocked them, and the heart that fed:",
      "And on the pedestal these words appear:",
      "'My name is Ozymandias, king of kings:",
      "Look on my works, ye Mighty, and despair!'",
      "Nothing beside remains. Round the decay",
      "Of that colossal wreck, boundless and bare",
      "The lone and level sands stretch far away.",
    ],
  },
  {
    title: "Ah Sunflower",
    author: "William Blake",
    source: "local",
    lines: [
      "Ah Sunflower, weary of time,",
      "  Who countest the steps of the sun;",
      "Seeking after that sweet golden clime",
      "  Where the traveller's journey is done;",
      "",
      "Where the Youth pined away with desire,",
      "  And the pale virgin shrouded in snow,",
      "Arise from their graves, and aspire",
      "  Where my Sunflower wishes to go!",
    ],
  },
  {
    title: "In this short Life",
    author: "Emily Dickinson",
    source: "local",
    lines: [
      "In this short Life",
      "That only lasts an hour",
      "How much -- how little -- is",
      "Within our power",
    ],
  },
  {
    title: "Full of Life, Now.",
    author: "Walt Whitman",
    source: "local",
    lines: [
      "FULL of life, now, compact, visible,",
      "I, forty years old the Eighty-third Year of The States,",
      "To one a century hence, or any number of centuries hence,",
      "To you, yet unborn, these, seeking you.",
      "",
      "When you read these, I, that was visible, am become invisible;",
      "Now it is you, compact, visible, realizing my poems, seeking me;",
      "Fancying how happy you were, if I could be with you, and become your comrade;",
      "Be it as if I were with you. (Be not too certain but I am now with you.)",
    ],
  },
] as const;
