/**
 * Weekly devotional verses for the Command page. Short scripture quotations
 * (ESV wording), one per week, selected via the shared daily helpers.
 *
 * The card previously rendered a single hardcoded verse whose eyebrow
 * literally said "Static local reference" — this list is what lets it rotate.
 * 28 entries ≈ half a year before a verse repeats.
 */
export type Devotional = {
  text: string;
  ref: string;
};

export const DEVOTIONALS: readonly Devotional[] = [
  { text: "Whatever you do, work heartily, as for the Lord and not for men.", ref: "Colossians 3:23" },
  { text: "Trust in the LORD with all your heart, and do not lean on your own understanding.", ref: "Proverbs 3:5" },
  { text: "Be still, and know that I am God.", ref: "Psalm 46:10" },
  { text: "They who wait for the LORD shall renew their strength; they shall mount up with wings like eagles.", ref: "Isaiah 40:31" },
  { text: "Do not be anxious about anything, but in everything by prayer and supplication with thanksgiving let your requests be made known to God.", ref: "Philippians 4:6" },
  { text: "This is the day that the LORD has made; let us rejoice and be glad in it.", ref: "Psalm 118:24" },
  { text: "Do justice, love kindness, and walk humbly with your God.", ref: "Micah 6:8" },
  { text: "Do not be anxious about tomorrow, for tomorrow will be anxious for itself. Sufficient for the day is its own trouble.", ref: "Matthew 6:34" },
  { text: "Be strong and courageous. Do not be frightened, and do not be dismayed, for the LORD your God is with you wherever you go.", ref: "Joshua 1:9" },
  { text: "The LORD is my shepherd; I shall not want.", ref: "Psalm 23:1" },
  { text: "Do not be conformed to this world, but be transformed by the renewal of your mind.", ref: "Romans 12:2" },
  { text: "Let us not grow weary of doing good, for in due season we will reap, if we do not give up.", ref: "Galatians 6:9" },
  { text: "Teach us to number our days that we may get a heart of wisdom.", ref: "Psalm 90:12" },
  { text: "The heart of man plans his way, but the LORD establishes his steps.", ref: "Proverbs 16:9" },
  { text: "For everything there is a season, and a time for every matter under heaven.", ref: "Ecclesiastes 3:1" },
  { text: "Come to me, all who labor and are heavy laden, and I will give you rest.", ref: "Matthew 11:28" },
  { text: "God gave us a spirit not of fear but of power and love and self-control.", ref: "2 Timothy 1:7" },
  { text: "I lift up my eyes to the hills. From where does my help come? My help comes from the LORD, who made heaven and earth.", ref: "Psalm 121:1–2" },
  { text: "Let every person be quick to hear, slow to speak, slow to anger.", ref: "James 1:19" },
  { text: "Iron sharpens iron, and one man sharpens another.", ref: "Proverbs 27:17" },
  { text: "You keep him in perfect peace whose mind is stayed on you, because he trusts in you.", ref: "Isaiah 26:3" },
  { text: "Be watchful, stand firm in the faith, be strong. Let all that you do be done in love.", ref: "1 Corinthians 16:13–14" },
  { text: "Commit your way to the LORD; trust in him, and he will act.", ref: "Psalm 37:5" },
  { text: "Let us run with endurance the race that is set before us.", ref: "Hebrews 12:1" },
  { text: "For those who love God all things work together for good.", ref: "Romans 8:28" },
  { text: "Keep your heart with all vigilance, for from it flow the springs of life.", ref: "Proverbs 4:23" },
  { text: "The steadfast love of the LORD never ceases; his mercies never come to an end; they are new every morning.", ref: "Lamentations 3:22–23" },
  { text: "I can do all things through him who strengthens me.", ref: "Philippians 4:13" },
] as const;
