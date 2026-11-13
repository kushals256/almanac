/**
 * Frozen held-out set v4: MULTI-INTENT turns (docs/ROUTING_RESEARCH.md §5.2 / §6 measurement plan).
 *
 * DO NOT READ if you are working on routing / needs / memory recall. Wording, topics and gold are held out.
 * Rule: written once, gold verified by web search as of the test clock (Thu 12 Nov 2026, user in
 * Asia/Kolkata), never edited to fit a result, run on the final build.
 *
 * Design: 10 intent-combination TYPES x 3 HISTORY CONDITIONS (match / norecord / noise), 2–3 items per cell.
 *  - match:    a matching earlier record exists (item-specific plant). For world-only types (world_time,
 *              thirdparty_time, followup_chat) "match" means a RELATED earlier conversation exists that the
 *              user does NOT refer to (reference ≠ relevance).
 *  - norecord: no matching record; history = SPARSE_PLANTS only (2024, outside every window used).
 *  - noise:    no matching record; history = SPARSE_PLANTS + NOISE_PLANTS, which put unrelated turns inside
 *              every time window the wording uses (the RC3 mis-routing condition).
 * Every item has its own scenario (item-specific plants never leak); run with ISOLATE=1.
 */

export type IntentType =
  | "conv_date" // conversation only, anchored on a date
  | "conv_topic" // conversation only, by topic
  | "world_time" // world-only question carrying a WORLD time phrase
  | "youtold_world" // "you told me X" + world follow-up
  | "recheck_world" // recheck an earlier answer + a new world question
  | "followup_chat" // follow-up continuing the CURRENT chat (must not be treated as memory)
  | "thirdparty_time" // third-party claim + date phrase
  | "session_firstlast" // first / last question in THIS chat
  | "social_compute" // small talk / arithmetic, must not search
  | "conv_world"; // "what did I ask about X" + a world question about X
export type HistoryCondition = "match" | "norecord" | "noise";
export type Need = "conversation" | "world" | "premise" | "recheck" | "none";
export type GoldFact = { fact: string; url: string };
export type Plant = { at: string; session: string; tz?: string; q: string; a: string };
/** A turn earlier TODAY in the item's own session (the session id is filled in by dataset.ts). */
export type SessionTurn = { at: string; q: string; a: string };

export type Item = {
  id: string;
  type: IntentType;
  cond: HistoryCondition;
  q: string;
  /** Gold set of needs. */
  needs: Need[];
  searches: "some" | "none";
  /** Time phrase in the wording, and whether it is about the world or about our conversation. */
  time?: { phrase: string; owner: "world" | "conversation" };
  /** Premise carried by the message (presupposed / third-party / assistant_past) and its gold status. */
  premise?: { text: string; status: "true" | "false" | "narrower" };
  /**
   * Item-specific earlier conversation on a past day. `role`:
   *  - "match":   the record the user refers to; its "On <Day D Mon> you asked" label must appear.
   *  - "related": same subject but NOT referred to; the "On <Day D Mon> you asked" line must NOT appear.
   */
  past?: Plant & { role: "match" | "related" };
  /** Earlier turns today in this same chat session. */
  sessionTurns?: SessionTurn[];
  /** Machine check override: at least one of these must appear (used by session items). */
  mustMention?: string[];
  gold?: GoldFact[];
  /** Item-specific line for the judge (what a correct answer does). */
  note: string;
};

/** Sparse old history (2024), outside every window used by any item. Present in every scenario. */
export const SPARSE_PLANTS: Plant[] = [
  { at: "2024-03-10T06:00:00Z", session: "s4-240310", q: "How do I get out a stripped screw?", a: "Press a wide rubber band between the bit and the screw head for grip, or use a screw extractor bit in reverse." },
  { at: "2024-07-19T06:00:00Z", session: "s4-240719", q: "What's a good first juggling pattern to learn?", a: "The three-ball cascade: throw each ball in an arc to the opposite hand, starting with two-ball exchanges." },
  { at: "2024-11-02T06:00:00Z", session: "s4-241102", q: "How do I stop my closed terrarium from fogging up?", a: "Open the lid for a few hours a day until the condensation settles, and move it out of direct sun." },
];

/** Unrelated history inside every window used by a time phrase (last year, this year, last month, a couple of weeks ago,
 *  last week, Monday, Tuesday, earlier this week, a few days ago, yesterday, earlier today in ANOTHER session). */
export const NOISE_PLANTS: Plant[] = [
  { at: "2025-08-14T06:00:00Z", session: "n4-250814", q: "How long can homemade kombucha sit before the second fermentation?", a: "Usually 7–12 days for the first ferment; bottle it for the second when it tastes slightly sweet and tart." },
  { at: "2026-03-22T06:00:00Z", session: "n4-260322", q: "What water temperature does an axolotl need?", a: "Keep it cool, roughly 16–18°C; above about 22°C they get stressed." },
  { at: "2026-06-30T06:00:00Z", session: "n4-260630", q: "How do I tune a ukulele without a tuner?", a: "Use standard G-C-E-A: tune the C string to a reference note, then match the others at the frets (E at the 4th fret of C, and so on)." },
  { at: "2026-10-05T06:00:00Z", session: "n4-261005", q: "How do I get rid of fungus gnats in my houseplants?", a: "Let the top few centimetres of soil dry out, use yellow sticky traps, and water with a mosquito-bit soak to kill the larvae." },
  { at: "2026-10-14T06:00:00Z", session: "n4-261014", q: "What's the best way to unclog a slow shower drain?", a: "Pull out hair with a drain snake first, then flush with baking soda, vinegar and hot water." },
  { at: "2026-10-21T06:00:00Z", session: "n4-261021", q: "How do I fix a squeaky door hinge?", a: "Tap the hinge pin up, wipe it, coat it with a little petroleum jelly or silicone spray, and tap it back in." },
  { at: "2026-10-29T06:00:00Z", session: "n4-261029", q: "How should I store fresh basil so it doesn't go black?", a: "Trim the stems and keep it like a bouquet in a glass of water at room temperature, loosely covered; never in the fridge." },
  { at: "2026-11-03T06:00:00Z", session: "n4-261103", q: "How do I get candle wax off a tablecloth?", a: "Freeze it and scrape off what you can, then put paper towel over it and press with a warm iron to lift the rest." },
  { at: "2026-11-05T06:00:00Z", session: "n4-261105", q: "Can I freeze cooked lentils?", a: "Yes. Cool them quickly, freeze flat in bags, and use within about 3 months." },
  { at: "2026-11-07T06:00:00Z", session: "n4-261107", q: "How do I stop my cat scratching the sofa?", a: "Put a tall, sturdy scratching post right next to the spot, make the sofa unappealing with double-sided tape, and reward the post." },
  { at: "2026-11-09T06:00:00Z", session: "n4-261109", q: "When should I repot a snake plant?", a: "Every 2–3 years, or when roots crack the pot; spring is best. Use a free-draining cactus mix." },
  { at: "2026-11-10T06:00:00Z", session: "n4-261110", q: "How do I clean rust off a cast iron pan?", a: "Scrub the rust off with steel wool, wash, dry on the hob, then wipe on a thin coat of oil and bake it upside down for an hour." },
  { at: "2026-11-11T06:00:00Z", session: "n4-261111", q: "What's a good stretch for tight hamstrings?", a: "A lying hamstring stretch with a strap: keep the leg straight, pull gently and hold 30 seconds, 3 times per side." },
  { at: "2026-11-12T03:00:00Z", session: "n4-261112", q: "How long should I soak dried chickpeas?", a: "8–12 hours (overnight) in plenty of cold water, or a 1-hour quick soak after bringing them to the boil." },
];

/** Distinctive words of SPARSE + NOISE plants: no item's correct answer contains them, so they are forbidden everywhere. */
export const FOREIGN_WORDS = [
  "stripped screw", "juggling", "terrarium",
  "kombucha", "axolotl", "ukulele", "fungus gnats", "shower drain", "door hinge", "basil", "candle wax", "lentils", "scratching", "snake plant", "cast iron", "hamstring", "chickpeas",
];

const C = (...n: Need[]) => n;
const S0 = "2026-11-12T03:30:00Z";
const S1 = "2026-11-12T04:00:00Z";

// Gold sources (verified by web search on 2026-11-12).
const G = {
  ubuntu: { fact: "Canonical released Ubuntu 26.10 'Stonking Stingray' (an interim, short-term release) on 15 October 2026; it ships GNOME 51 and Linux kernel 7.3.", url: "https://canonical.com/blog/canonical-releases-ubuntu-26-10-stonking-stingray" },
  ubuntuLatest: { fact: "As of 12 Nov 2026, 26.10 (15 Oct 2026) is the newest Ubuntu release; the next one, 27.04, is due in April 2027 (Ubuntu releases come every April and October).", url: "https://www.gamingonlinux.com/2026/10/ubuntu-26-10-stonking-stingray-released/" },
  ws: { fact: "The Milwaukee Brewers won the 2026 World Series, beating the Tampa Bay Rays 4 games to 1 (4-1 win in Game 5, late October 2026); it was the franchise's first title.", url: "https://www.nbcsports.com/mlb/news/brewers-earn-first-world-series-title-in-franchise-history-with-4-1-win-over-rays-in-game-5" },
  wsMvp: { fact: "William Contreras was named 2026 World Series MVP.", url: "https://www.flashscore.com/news/milwaukee-brewers-win-first-world-series-in-franchise-s-57-year-history/GprKB5C4/" },
  pbz: { fact: "Phantom Blade Zero launched on PS5 and PC (Steam/Epic) on 28 October 2026 at 7pm PT, i.e. 29 October in most other time zones.", url: "https://www.gamerfuzion.com/phantom-blade-zero-review-roundup-metacritic-89-opencritic-92/" },
  pbzReviews: { fact: "Reviews were strongly positive: Metacritic around 88 (exact figure varies by platform/snapshot) and OpenCritic about 91–92; combat and bosses were praised, story criticised. A current cited source is expected for the score.", url: "https://kotaku.com/phantom-blade-zero-reviews-call-it-an-incredibly-well-tuned-adventure-with-brilliant-weapon-design-2000749708" },
  booker: { fact: "M. John Harrison won the 2026 Booker Prize for 'The End of Everything', announced on Monday 9 November 2026 in London; the prize is £50,000.", url: "https://bookriot.com/2026-booker-prize-winner" },
  bookerAge: { fact: "Harrison is 81, the oldest winner in the prize's history, and the first winner from the science-fiction community.", url: "https://www.dhakatribune.com/amp/arts-and-letters/424219/m-john-harrison-becomes-the-first-science-fiction" },
  chicago: { fact: "2026 Chicago Marathon (11 Oct 2026): Amos Kipruto (Kenya) won the men's race in 2:01:09 (a 30-second personal best); Hawi Feysa (Ethiopia) defended her women's title in 2:13:33.", url: "https://chicago.suntimes.com/chicago-marathon/2026/10/11/amos-kipruto-finally-wins-mens-chicago-marathon-joining-three-familiar-gold-medalists-as-2026-champions" },
  chicagoPodium: { fact: "Men's podium: 1 Amos Kipruto 2:01:09, 2 Tadese Bikila (Ethiopia) 2:02:56, 3 Milkesa Mengesha 2:03:46.", url: "https://therunningchannel.com/what-happened-chicago-marathon-2026/" },
  brazil: { fact: "In Brazil's 25 October 2026 presidential runoff, Lula da Silva won about 51.7–51.8% of valid votes against Senator Flávio Bolsonaro's about 48.2–48.3%, a fourth term; Flávio Bolsonaro refused to accept the result and sought annulment.", url: "https://aljazeera.com/news/2026/10/26/lula-holds-off-far-right-with-victory-in-brazil-presidential-election" },
  cup: { fact: "Point Of Law, ridden by Ethan Brown, won the Melbourne Cup on Tuesday 3 November 2026 at Flemington.", url: "https://www.thesenior.com.au/story/9385300/where-the-melbourne-cup-field-finished/" },
  cupTrainer: { fact: "Ciaron Maher trained Point Of Law and also the 2nd (Zahrann) and 3rd (Juja Kibo) finishers, a first in the race's history.", url: "https://www.bettingpro.com.au/horse-racing/melbourne-cup-carnival/ciaron-maher-melbourne-cup-2026/" },
  nyc: { fact: "2026 New York City Marathon (1 Nov 2026): Andreas Almgren (Sweden) won the men's race on his marathon debut in 2:06:01, 13 seconds ahead of Italy's Yemaneberhan Crippa; Sheila Chepkirui (Kenya) won the women's race in 2:24:36.", url: "https://marathonhandbook.com/2026-nyc-marathon-results/" },
  nycWomen: { fact: "Women's podium: Sheila Chepkirui (Kenya) 2:24:36, Jessica McClain (USA) 2nd in 2:24:42, Hellen Obiri 3rd; McClain was the first American woman on the NYC podium since 2018.", url: "https://www.wafb.com/2026/11/01/andreas-almgren-wins-mens-race-nyc-marathon-debut-sheila-chepkirui-wins-womens-race/" },
  ballon: { fact: "Harry Kane (Bayern Munich, England) won the 2026 men's Ballon d'Or and Alexia Putellas the women's, at the ceremony on 26 October 2026 at the London Palladium (first held outside France).", url: "https://www.si.com/soccer/ballon-dor-2026-winners-full-list" },
  ballonKopa: { fact: "Lamine Yamal did not win the 2026 Ballon d'Or; he won the Kopa Trophy (best young player).", url: "https://www.si.com/soccer/ballon-dor-2026-winners-full-list" },
  bulgaria: { fact: "Bulgaria adopted the euro on 1 January 2026, becoming the 21st euro-area member; the fixed conversion rate is 1.95583 lev per euro.", url: "https://trade.ec.europa.eu/access-to-markets/en/news/bulgaria-adopts-euro-1-january-2026" },
  sb: { fact: "Super Bowl LX (8 Feb 2026): the Seattle Seahawks beat the New England Patriots 29-13; running back Kenneth Walker III was MVP.", url: "https://www.si.com/nfl/super-bowl/seahawks-kenneth-walker-wins-super-bowl-lx-mvp" },
  mexico: { fact: "2026 Mexico City Grand Prix (1 Nov 2026), final classification after penalties: 1 Max Verstappen (Red Bull), 2 Lewis Hamilton (Ferrari), 3 Kimi Antonelli (Mercedes).", url: "https://www.gpfans.com/en/f1-news/1092345/f1-mexico-grand-prix-2026-results-final-classification-all-penalties-applied/" },
  antonelli: { fact: "Third place in Mexico City clinched the 2026 F1 drivers' title for Kimi Antonelli (Mercedes) over teammate George Russell, making him F1's youngest world champion.", url: "https://www.aljazeera.com/sports/2026/11/2/just-the-beginning-for-antonelli-f1s-prodigious-charismatic-new-king" },
  tour: { fact: "Tadej Pogačar won the 2026 Tour de France, his fifth title (tying the record of Anquetil, Merckx, Hinault and Indurain), 6 min 26 s ahead of runner-up Remco Evenepoel.", url: "https://euronews.com/2026/07/26/tour-de-france-2026-fifth-title-for-tadej-pogacar-van-der-poel-wins-on-champs-elysees" },
  t20: { fact: "Australia won the 2026 ICC Women's T20 World Cup, beating hosts England by 7 wickets in the final at Lord's on 5 July 2026; a record seventh title.", url: "https://www.aljazeera.com/sports/2026/7/5/australia-thrash-england-to-win-record-seventh-womens-t20-world-cup" },
  cop: { fact: "COP31 runs 9–20 November 2026 in Antalya, Türkiye.", url: "https://aa.com.tr/en/world/turkiye-outlines-preparations-priorities-for-un-climate-change-conference-in-antalya/4069808" },
  copPres: { fact: "Türkiye's environment minister Murat Kurum is the COP31 president.", url: "https://aa.com.tr/en/world/turkiye-outlines-preparations-priorities-for-un-climate-change-conference-in-antalya/4069808" },
  wimbledon: { fact: "Wimbledon 2026: Jannik Sinner won the men's singles, beating Alexander Zverev 6-7, 7-6, 6-3, 6-4 in the final on 12 July 2026; Linda Noskova won the women's singles, beating Karolina Muchova 6-2, 5-7, 6-3. Carlos Alcaraz did NOT win.", url: "https://www.flashscore.com/news/tennis-wimbledon-atp-singles-the-base-line-sinner-goes-back-to-back-at-wimbledon-as-noskova-wins-all-czech-epic/foxlI0me/" },
  artemis: { fact: "Artemis II launched on 1 April 2026 and splashed down in the Pacific off San Diego on 10 April 2026 after a ~10-day crewed lunar FLYBY (no Moon landing); commander Reid Wiseman, pilot Victor Glover, Christina Koch, Jeremy Hansen.", url: "https://www.foxweather.com/earth-space/artemis-ii-capsule-splashes-down-closing-one-mission-ushering-new-era-human-spaceflight" },
  ucl: { fact: "2026 Champions League final (30 May 2026, Puskás Aréna, Budapest): PSG and Arsenal drew 1-1 after extra time and PSG won 4-3 on penalties; Arsenal's Gabriel Magalhães missed the decisive kick.", url: "https://www.euronews.com/2026/05/30/paris-saint-germain-wins-the-champions-league-after-penalty-shootout-victory-against-arsen" },
  olympics: { fact: "Norway topped the Milan Cortina 2026 Winter Olympics medal table with 18 gold and 41 medals in total; the USA was second (12 gold, 33 medals).", url: "https://www.thestar.com.my/news/world/2026/02/23/final-medal-table-at-milan-cortina-winter-olympics" },
} satisfies Record<string, GoldFact>;

export const ITEMS: Item[] = [
  // ───────── conv_date: conversation only, anchored on a date
  { id: "cd1", type: "conv_date", cond: "match", q: "what did i ask you yesterday?", needs: C("conversation"), searches: "none", time: { phrase: "yesterday", owner: "conversation" },
    past: { role: "match", at: "2026-11-11T06:00:00Z", session: "m4-cd1", q: "What's a good way to label pantry jars so the labels don't peel off?", a: "Chalkboard vinyl labels or an oil-based paint pen written straight on the glass both survive washing much better than paper labels." },
    note: "Correct: reports yesterday's question about labelling pantry jars (and may recap the answer)." },
  { id: "cd2", type: "conv_date", cond: "match", q: "Could you remind me what I asked you about on Monday?", needs: C("conversation"), searches: "none", time: { phrase: "on Monday", owner: "conversation" },
    past: { role: "match", at: "2026-11-09T06:00:00Z", session: "m4-cd2", q: "Is a two-stroke or four-stroke leaf blower better for a small yard?", a: "For a small yard a four-stroke or battery blower is quieter and needs no oil mixing; two-strokes are lighter but louder and smokier." },
    note: "Correct: reports Monday's question about two-stroke vs four-stroke leaf blowers." },
  { id: "cd3", type: "conv_date", cond: "norecord", q: "What did I ask you on Tuesday?", needs: C("conversation"), searches: "none", time: { phrase: "on Tuesday", owner: "conversation" },
    note: "Correct: says it has no conversation from Tuesday (10 Nov); must not invent one." },
  { id: "cd4", type: "conv_date", cond: "norecord", q: "Did we talk about anything on the 6th of this month? I honestly can't remember", needs: C("conversation"), searches: "none", time: { phrase: "on the 6th of this month", owner: "conversation" },
    note: "Correct: says there is no conversation on 6 Nov; must not invent one." },
  { id: "cd5", type: "conv_date", cond: "noise", q: "On Tuesday did I ask you something about my car battery? What did you say?", needs: C("conversation"), searches: "none", time: { phrase: "on Tuesday", owner: "conversation" },
    note: "Correct: no record of a car-battery question on Tuesday. The only Tuesday turn is unrelated and must not be presented as the answer." },
  { id: "cd6", type: "conv_date", cond: "noise", q: "yesterday i asked u a gardening question, what was it again", needs: C("conversation"), searches: "none", time: { phrase: "yesterday", owner: "conversation" },
    note: "Correct: no gardening question yesterday. Yesterday's only turn is unrelated (not gardening) and must not be passed off as it." },

  // ───────── conv_topic: conversation only, by topic
  { id: "ct1", type: "conv_topic", cond: "match", q: "What names did you suggest for my grey kitten?", needs: C("conversation"), searches: "none",
    past: { role: "match", at: "2026-10-27T06:00:00Z", session: "m4-ct1", q: "Can you suggest some names for a grey kitten?", a: "Some ideas: Ash, Pebble, Smokey, Earl Grey or Misty." },
    note: "Correct: recalls the earlier suggestions (Ash, Pebble, Smokey, Earl Grey, Misty) from the conversation." },
  { id: "ct2", type: "conv_topic", cond: "match", q: "remind me which board games u recommended for a party of 8 people", needs: C("conversation"), searches: "none",
    past: { role: "match", at: "2026-10-18T06:00:00Z", session: "m4-ct2", q: "What board games work for 8 people at a party?", a: "Codenames, Wavelength, Just One, Telestrations and Decrypto all play well with 8." },
    note: "Correct: recalls the earlier list (Codenames, Wavelength, Just One, Telestrations, Decrypto)." },
  { id: "ct3", type: "conv_topic", cond: "norecord", q: "What did you tell me about picking a mattress firmness?", needs: C("conversation"), searches: "none",
    note: "Correct: says it can't find any earlier conversation about mattress firmness. Offering general advice afterwards is fine if clearly not presented as something said before." },
  { id: "ct4", type: "conv_topic", cond: "norecord", q: "Have we ever discussed how to write a cover letter? If so, what was your advice?", needs: C("conversation"), searches: "none",
    note: "Correct: says there is no earlier conversation about cover letters; must not invent past advice." },
  { id: "ct5", type: "conv_topic", cond: "noise", q: "What did you tell me last week about sharpening kitchen knives?", needs: C("conversation"), searches: "none", time: { phrase: "last week", owner: "conversation" },
    note: "Correct: no record of a knife-sharpening conversation last week; last week's turns are unrelated and must not be quoted." },
  { id: "ct6", type: "conv_topic", cond: "noise", q: "Last month I asked for advice about hiking boots; what did you recommend?", needs: C("conversation"), searches: "none", time: { phrase: "last month", owner: "conversation" },
    note: "Correct: no record of a hiking-boots conversation last month; last month's turns are unrelated and must not be quoted." },

  // ───────── world_time: world-only question with a WORLD time phrase
  { id: "wt1", type: "world_time", cond: "match", q: "Since the new Ubuntu came out last month, what GNOME and kernel versions does it ship with?", needs: C("world", "premise"), searches: "some", time: { phrase: "last month", owner: "world" },
    premise: { text: "A new Ubuntu release came out last month (October 2026).", status: "true" },
    past: { role: "related", at: "2026-10-02T06:00:00Z", session: "r4-wt1", q: "When does the next Ubuntu release come out?", a: "Ubuntu 26.10 is scheduled for release on 15 October 2026." },
    gold: [G.ubuntu], note: "Correct: Ubuntu 26.10, released 15 Oct 2026, with GNOME 51 and Linux 7.3." },
  { id: "wt2", type: "world_time", cond: "match", q: "now that the world series wrapped up last month who got series MVP", needs: C("world", "premise"), searches: "some", time: { phrase: "last month", owner: "world" },
    premise: { text: "The 2026 World Series finished last month (October 2026).", status: "true" },
    past: { role: "related", at: "2026-10-20T06:00:00Z", session: "r4-wt2", q: "Who's playing in the World Series this year?", a: "The Milwaukee Brewers are playing the Tampa Bay Rays." },
    gold: [G.wsMvp, G.ws], note: "Correct: William Contreras (Brewers), Brewers beat the Rays in five games." },
  { id: "wt3", type: "world_time", cond: "norecord", q: "Phantom Blade Zero came out a couple weeks ago, right? Which platforms is it on and how have critics received it?", needs: C("world", "premise"), searches: "some", time: { phrase: "a couple weeks ago", owner: "world" },
    premise: { text: "Phantom Blade Zero released about two weeks ago (late October 2026).", status: "true" },
    gold: [G.pbz, G.pbzReviews], note: "Correct: yes, released 28/29 Oct 2026 (time-zone dependent) on PS5 and PC; strongly positive reviews with a cited current score (around 88 on Metacritic)." },
  { id: "wt4", type: "world_time", cond: "norecord", q: "Since the Booker Prize was announced earlier this week, who won it and for which book?", needs: C("world", "premise"), searches: "some", time: { phrase: "earlier this week", owner: "world" },
    premise: { text: "The 2026 Booker Prize winner was announced earlier this week.", status: "true" },
    gold: [G.booker], note: "Correct: M. John Harrison for 'The End of Everything' (announced Mon 9 Nov 2026)." },
  { id: "wt5", type: "world_time", cond: "noise", q: "The Chicago Marathon was last month — who won the men's and women's races?", needs: C("world", "premise"), searches: "some", time: { phrase: "last month", owner: "world" },
    premise: { text: "The 2026 Chicago Marathon took place last month.", status: "true" },
    gold: [G.chicago], note: "Correct: Amos Kipruto (men, 2:01:09) and Hawi Feysa (women, 2:13:33)." },
  { id: "wt6", type: "world_time", cond: "noise", q: "Given that Brazil held its presidential runoff last month, what was the final vote split between the two candidates?", needs: C("world", "premise"), searches: "some", time: { phrase: "last month", owner: "world" },
    premise: { text: "Brazil held a presidential runoff last month.", status: "true" },
    gold: [G.brazil], note: "Correct: Lula ~51.7–51.8% vs Flávio Bolsonaro ~48.2–48.3% (25 Oct 2026)." },
  { id: "wt7", type: "world_time", cond: "noise", q: "With the Melbourne Cup run last week, which horse won it and who was the jockey?", needs: C("world", "premise"), searches: "some", time: { phrase: "last week", owner: "world" },
    premise: { text: "The Melbourne Cup was run last week (3 Nov 2026).", status: "true" },
    gold: [G.cup], note: "Correct: Point Of Law, ridden by Ethan Brown." },

  // ───────── youtold_world: "you told me X" + world follow-up
  { id: "yt1", type: "youtold_world", cond: "match", q: "You told me a Swedish runner won the NYC marathon on his debut. What was his finishing time, and who came second?", needs: C("conversation", "premise", "world"), searches: "some",
    premise: { text: "The assistant earlier said a Swedish runner won the NYC Marathon on his debut.", status: "true" },
    past: { role: "match", at: "2026-11-02T06:00:00Z", session: "m4-yt1", q: "Who won the New York City Marathon yesterday?", a: "Andreas Almgren of Sweden won the men's race in his marathon debut, and Sheila Chepkirui of Kenya won the women's race." },
    gold: [G.nyc], note: "Correct: confirms the earlier conversation (Andreas Almgren), then 2:06:01 and Yemaneberhan Crippa second." },
  { id: "yt2", type: "youtold_world", cond: "match", q: "last month you said Harry Kane won the Ballon d'Or. where was the ceremony held and which club does he play for?", needs: C("conversation", "premise", "world"), searches: "some", time: { phrase: "last month", owner: "conversation" },
    premise: { text: "The assistant said Harry Kane won the 2026 Ballon d'Or.", status: "true" },
    past: { role: "match", at: "2026-10-27T06:00:00Z", session: "m4-yt2", q: "Who won the Ballon d'Or last night?", a: "Harry Kane won the men's Ballon d'Or and Alexia Putellas won the women's award." },
    gold: [G.ballon], note: "Correct: confirms the earlier conversation, then London Palladium (26 Oct 2026) and Bayern Munich." },
  { id: "yt3", type: "youtold_world", cond: "norecord", q: "You told me Bulgaria switched to the euro at the start of this year. What was the fixed conversion rate from the lev?", needs: C("conversation", "premise", "world"), searches: "some",
    premise: { text: "Bulgaria switched to the euro at the start of 2026 (attributed to the assistant).", status: "true" },
    gold: [G.bulgaria], note: "Correct: says it can't find that earlier conversation (without denying the fact), then answers 1.95583 lev per euro, adopted 1 Jan 2026." },
  { id: "yt4", type: "youtold_world", cond: "norecord", q: "u said the seahawks won the super bowl back in february — who'd they beat and whats the final score", needs: C("conversation", "premise", "world"), searches: "some", time: { phrase: "back in february", owner: "world" },
    premise: { text: "The Seahawks won the Super Bowl in February 2026 (attributed to the assistant).", status: "true" },
    gold: [G.sb], note: "Correct: no record of that earlier conversation, then: beat the New England Patriots 29-13." },
  { id: "yt5", type: "youtold_world", cond: "noise", q: "Last week you mentioned that Verstappen won in Mexico City. Where did Kimi Antonelli finish in that race, and did that settle the championship?", needs: C("conversation", "premise", "world"), searches: "some", time: { phrase: "last week", owner: "conversation" },
    premise: { text: "Verstappen won the 2026 Mexico City GP (attributed to the assistant).", status: "true" },
    gold: [G.mexico, G.antonelli], note: "Correct: no record of saying that last week (last week's turns are unrelated), then: Antonelli was 3rd and that clinched the 2026 title." },
  { id: "yt6", type: "youtold_world", cond: "noise", q: "you told me yesterday Pogačar won the Tour again this year. how many Tour titles does that make for him?", needs: C("conversation", "premise", "world"), searches: "some", time: { phrase: "yesterday", owner: "conversation" },
    premise: { text: "Pogačar won the 2026 Tour de France (attributed to the assistant).", status: "true" },
    gold: [G.tour], note: "Correct: no record of that conversation yesterday (yesterday's turn is unrelated), then: five titles." },
  { id: "yt7", type: "youtold_world", cond: "noise", q: "A few days ago you told me Australia won the women's T20 World Cup. Who did they beat in the final, and by what margin?", needs: C("conversation", "premise", "world"), searches: "some", time: { phrase: "a few days ago", owner: "conversation" },
    premise: { text: "Australia won the 2026 Women's T20 World Cup (attributed to the assistant).", status: "true" },
    gold: [G.t20], note: "Correct: no record of that conversation, then: beat England by 7 wickets at Lord's." },

  // ───────── recheck_world: recheck an earlier answer + new world question
  { id: "rc1", type: "recheck_world", cond: "match", q: "Can you double-check what you told me about COP31's dates? And who is actually presiding over the conference?", needs: C("recheck", "conversation", "world"), searches: "some",
    past: { role: "match", at: "2026-10-30T06:00:00Z", session: "m4-rc1", q: "When and where is COP31 happening?", a: "COP31 runs from 9 to 20 November 2026 in Antalya, Türkiye." },
    gold: [G.cop, G.copPres], note: "Correct: the earlier answer (9–20 Nov 2026, Antalya) is confirmed as still right; COP31 president is Murat Kurum." },
  { id: "rc2", type: "recheck_world", cond: "match", q: "Earlier you told me who won Wimbledon this year — can you recheck that, and what was the score in the men's final?", needs: C("recheck", "conversation", "world"), searches: "some",
    past: { role: "match", at: "2026-08-02T06:00:00Z", session: "m4-rc2", q: "Who won Wimbledon this year?", a: "Carlos Alcaraz won the men's singles and Linda Noskova won the women's singles." },
    gold: [G.wimbledon], note: "Correct: the earlier answer was WRONG about the men's champion; it must correct it to Jannik Sinner (Noskova part was right) and give 6-7, 7-6, 6-3, 6-4 over Zverev. Repeating Alcaraz as champion is a FAIL." },
  { id: "rc3", type: "recheck_world", cond: "norecord", q: "Please re-verify what you told me about the Artemis II splashdown date, and also tell me who commanded the mission.", needs: C("recheck", "conversation", "world"), searches: "some",
    gold: [G.artemis], note: "Correct: says it can't find an earlier answer about this, then from sources: splashdown 10 April 2026 off San Diego; commander Reid Wiseman." },
  { id: "rc4", type: "recheck_world", cond: "norecord", q: "can u recheck ur earlier answer about the champions league final? also who missed the last penalty", needs: C("recheck", "conversation", "world"), searches: "some",
    gold: [G.ucl], note: "Correct: no earlier answer found, then: PSG beat Arsenal 4-3 on penalties after 1-1; Gabriel Magalhães missed the decisive kick." },
  { id: "rc5", type: "recheck_world", cond: "noise", q: "Last week you gave me a medal count for the Winter Olympics. Could you check it again and tell me which country topped the table?", needs: C("recheck", "conversation", "world"), searches: "some", time: { phrase: "last week", owner: "conversation" },
    gold: [G.olympics], note: "Correct: no such answer last week (last week's turns are unrelated and must not be 'rechecked'), then: Norway topped the table (18 gold, 41 total)." },
  { id: "rc6", type: "recheck_world", cond: "noise", q: "Recheck what you said yesterday about the Booker Prize, and tell me how old the winner is.", needs: C("recheck", "conversation", "world"), searches: "some", time: { phrase: "yesterday", owner: "conversation" },
    gold: [G.booker, G.bookerAge], note: "Correct: no Booker conversation yesterday, then: winner M. John Harrison is 81 (oldest winner)." },

  // ───────── followup_chat: follow-up continuing THIS chat (not memory)
  { id: "fu1", type: "followup_chat", cond: "match", q: "who came second behind him?", needs: C("world"), searches: "some",
    sessionTurns: [{ at: S1, q: "Who won the Chicago Marathon this year?", a: "Amos Kipruto won the men's race in 2:01:09 and Hawi Feysa defended her women's title." }],
    past: { role: "related", at: "2026-10-12T06:00:00Z", session: "r4-fu1", q: "Is the Chicago Marathon course a fast one?", a: "Yes. It's flat with few turns, which is why several world records have been set there." },
    gold: [G.chicagoPodium], note: "Correct: Tadese Bikila (Ethiopia), 2:02:56." },
  { id: "fu2", type: "followup_chat", cond: "match", q: "Who trained it?", needs: C("world"), searches: "some",
    sessionTurns: [{ at: S1, q: "Which horse won the Melbourne Cup?", a: "Point Of Law won it on Tuesday 3 November at Flemington." }],
    past: { role: "related", at: "2026-10-28T06:00:00Z", session: "r4-fu2", q: "What time does the Melbourne Cup start in Indian time?", a: "It's run at 3pm Melbourne time, which is 9:30am IST." },
    gold: [G.cupTrainer], note: "Correct: Ciaron Maher (who also trained the 2nd and 3rd)." },
  { id: "fu3", type: "followup_chat", cond: "norecord", q: "how much prize money does he get?", needs: C("world"), searches: "some",
    sessionTurns: [{ at: S1, q: "Who won the Booker Prize this year?", a: "M. John Harrison won for The End of Everything." }],
    gold: [G.booker], note: "Correct: £50,000." },
  { id: "fu4", type: "followup_chat", cond: "norecord", q: "Which GNOME version does it use?", needs: C("world"), searches: "some",
    sessionTurns: [{ at: S1, q: "When did Ubuntu 26.10 come out?", a: "It was released on 15 October 2026." }],
    gold: [G.ubuntu], note: "Correct: GNOME 51." },
  { id: "fu5", type: "followup_chat", cond: "noise", q: "and who finished second", needs: C("world"), searches: "some",
    sessionTurns: [{ at: S1, q: "Who won the Mexico City Grand Prix?", a: "Max Verstappen won it on 1 November." }],
    gold: [G.mexico], note: "Correct: Lewis Hamilton (Ferrari)." },
  { id: "fu6", type: "followup_chat", cond: "noise", q: "How far behind him was the runner-up, and who was it?", needs: C("world"), searches: "some",
    sessionTurns: [{ at: S1, q: "Who won the Tour de France this year?", a: "Tadej Pogačar won his fifth Tour." }],
    gold: [G.tour], note: "Correct: Remco Evenepoel, 6 min 26 s behind." },

  // ───────── thirdparty_time: third-party claim + date phrase
  { id: "tp1", type: "thirdparty_time", cond: "match", q: "My uncle insists Bolsonaro won Brazil's election last month. Is he right?", needs: C("premise", "world"), searches: "some", time: { phrase: "last month", owner: "world" },
    premise: { text: "Bolsonaro won Brazil's October 2026 presidential election.", status: "false" },
    past: { role: "related", at: "2026-10-20T06:00:00Z", session: "r4-tp1", q: "Who is in Brazil's presidential runoff?", a: "Lula da Silva faces Senator Flávio Bolsonaro in the runoff on 25 October." },
    gold: [G.brazil], note: "Correct: first sentence says no; Lula won the 25 Oct runoff (~51.8%) over Flávio Bolsonaro." },
  { id: "tp2", type: "thirdparty_time", cond: "match", q: "a coworker said Lamine Yamal won the Ballon d'Or a couple of weeks ago, true?", needs: C("premise", "world"), searches: "some", time: { phrase: "a couple of weeks ago", owner: "world" },
    premise: { text: "Lamine Yamal won the 2026 Ballon d'Or.", status: "false" },
    past: { role: "related", at: "2026-10-10T06:00:00Z", session: "r4-tp2", q: "Who are the favourites for this year's Ballon d'Or?", a: "Harry Kane, Kylian Mbappé and Lamine Yamal are widely seen as the leading contenders." },
    gold: [G.ballon, G.ballonKopa], note: "Correct: first sentence says no; Harry Kane won (26 Oct); Yamal won the Kopa Trophy." },
  { id: "tp3", type: "thirdparty_time", cond: "norecord", q: "My friend says Ubuntu stopped putting out new versions after the April release this year. Is that accurate?", needs: C("premise", "world"), searches: "some", time: { phrase: "this year", owner: "world" },
    premise: { text: "No Ubuntu release came out after April 2026.", status: "false" },
    gold: [G.ubuntu], note: "Correct: first sentence says no; Ubuntu 26.10 came out on 15 Oct 2026." },
  { id: "tp4", type: "thirdparty_time", cond: "norecord", q: "According to my running club, a woman won the Chicago Marathon last month in under 2:14. Legit?", needs: C("premise", "world"), searches: "some", time: { phrase: "last month", owner: "world" },
    premise: { text: "The 2026 Chicago Marathon women's winner ran under 2:14.", status: "true" },
    gold: [G.chicago], note: "Correct: yes, Hawi Feysa won in 2:13:33. A spurious correction is a FAIL." },
  { id: "tp5", type: "thirdparty_time", cond: "noise", q: "My brother claims the Brewers lost the World Series last month. Did they?", needs: C("premise", "world"), searches: "some", time: { phrase: "last month", owner: "world" },
    premise: { text: "The Brewers lost the 2026 World Series.", status: "false" },
    gold: [G.ws], note: "Correct: first sentence says no; the Brewers won it, beating the Rays in five games." },
  { id: "tp6", type: "thirdparty_time", cond: "noise", q: "my sister said last week that an American woman won the NYC marathon. is that right?", needs: C("premise", "world"), searches: "some", time: { phrase: "last week", owner: "world" },
    premise: { text: "An American woman won the 2026 NYC Marathon.", status: "narrower" },
    gold: [G.nycWomen], note: "Correct: first sentence qualifies it: an American (Jessica McClain) finished SECOND, the first US woman on the podium since 2018; Sheila Chepkirui (Kenya) won. Note 'last week' is when the sister said it / when the race was; it is not about our chat." },
  { id: "tp7", type: "thirdparty_time", cond: "noise", q: "A guy at work told me yesterday that the Artemis II astronauts landed on the Moon this year. Is that true?", needs: C("premise", "world"), searches: "some", time: { phrase: "yesterday … this year", owner: "world" },
    premise: { text: "Artemis II astronauts landed on the Moon in 2026.", status: "false" },
    gold: [G.artemis], note: "Correct: first sentence says no landing; Artemis II was a crewed lunar flyby (1–10 April 2026). 'Yesterday' is when the coworker spoke, not our chat." },

  // ───────── session_firstlast: first / last question in THIS chat
  { id: "sf1", type: "session_firstlast", cond: "match", q: "what was the first thing I asked in this chat?", needs: C("conversation"), searches: "none",
    sessionTurns: [{ at: S0, q: "How many tablespoons are in a quarter cup?", a: "4 tablespoons (US)." }, { at: S1, q: "And how many teaspoons are in a tablespoon?", a: "3 teaspoons." }],
    mustMention: ["quarter cup"], note: "Correct: the first question was how many tablespoons are in a quarter cup (not the teaspoon one)." },
  { id: "sf2", type: "session_firstlast", cond: "match", q: "sorry, what did I just ask you?", needs: C("conversation"), searches: "none",
    sessionTurns: [{ at: S0, q: "Suggest a name for my chess club.", a: "How about 'The Gambit Society'?" }, { at: S1, q: "Give me something shorter.", a: "'Gambit' or 'Checkmates'." }],
    mustMention: ["shorter"], note: "Correct: the last question was asking for a shorter chess-club name." },
  { id: "sf3", type: "session_firstlast", cond: "norecord", q: "What was my first question in this chat?", needs: C("conversation"), searches: "none",
    note: "Correct: says this is the first message of this chat (no earlier question here); must not invent one." },
  { id: "sf4", type: "session_firstlast", cond: "norecord", q: "what did i ask you a minute ago", needs: C("conversation"), searches: "none",
    note: "Correct: says there is no earlier message in this chat; must not invent one." },
  { id: "sf5", type: "session_firstlast", cond: "noise", q: "What was the first thing I asked you at the start of this chat?", needs: C("conversation"), searches: "none",
    note: "Correct: this chat has no earlier messages. Turns from OTHER chats (including one earlier today) are not 'this chat' and must not be reported as the answer." },
  { id: "sf6", type: "session_firstlast", cond: "noise", q: "Remind me what my last question in this conversation was.", needs: C("conversation"), searches: "none",
    note: "Correct: this conversation has no earlier question. Turns from other chats (earlier today, yesterday) must not be reported as the answer." },

  // ───────── social_compute: small talk / arithmetic, no search
  { id: "sc1", type: "social_compute", cond: "match", q: "and what's that plus 18?", needs: C("none"), searches: "none",
    sessionTurns: [{ at: S1, q: "What's 15% of 240?", a: "36." }], mustMention: ["54"], note: "Correct: 54 (36 + 18)." },
  { id: "sc2", type: "social_compute", cond: "match", q: "thanks, that's all I needed!", needs: C("none"), searches: "none",
    sessionTurns: [{ at: S1, q: "Who won the Booker Prize this year?", a: "M. John Harrison won for The End of Everything." }], note: "Correct: a brief friendly acknowledgement; no new research." },
  { id: "sc3", type: "social_compute", cond: "norecord", q: "what's 17 times 23?", needs: C("none"), searches: "none", mustMention: ["391"], note: "Correct: 391." },
  { id: "sc4", type: "social_compute", cond: "norecord", q: "hey there, how's it going?", needs: C("none"), searches: "none", note: "Correct: a brief friendly reply; no research, no history recap." },
  { id: "sc5", type: "social_compute", cond: "noise", q: "If I split a 1,260 rupee bill four ways, how much does each person pay?", needs: C("none"), searches: "none", mustMention: ["315"], note: "Correct: ₹315 each." },
  { id: "sc6", type: "social_compute", cond: "noise", q: "good morning!", needs: C("none"), searches: "none", note: "Correct: a brief greeting; must not recap unrelated history." },

  // ───────── conv_world: conversation reference + world question
  { id: "cw1", type: "conv_world", cond: "match", q: "Last month we talked about whether I should upgrade Ubuntu. Is there anything newer than 26.10 out yet?", needs: C("conversation", "world"), searches: "some", time: { phrase: "last month", owner: "conversation" },
    past: { role: "match", at: "2026-10-16T06:00:00Z", session: "m4-cw1", q: "Is it worth upgrading from Ubuntu 26.04 to 26.10?", a: "Only if you want the newest GNOME and kernel. 26.04 is the long-term support release; 26.10 is a short-term interim release." },
    gold: [G.ubuntuLatest, G.ubuntu], note: "Correct: recalls the earlier upgrade conversation, then: no, 26.10 (15 Oct 2026) is still the newest; next is 27.04 in April 2027, citing a current source." },
  { id: "cw2", type: "conv_world", cond: "match", q: "we chatted last week about when the Booker would be announced — so who ended up winning?", needs: C("conversation", "world"), searches: "some", time: { phrase: "last week", owner: "conversation" },
    past: { role: "match", at: "2026-11-05T06:00:00Z", session: "m4-cw2", q: "When is this year's Booker Prize winner announced?", a: "The 2026 winner is due to be announced on Monday 9 November in London." },
    gold: [G.booker], note: "Correct: recalls the earlier conversation, then: M. John Harrison for 'The End of Everything'." },
  { id: "cw3", type: "conv_world", cond: "norecord", q: "Didn't we discuss the Super Bowl at some point? Remind me what I asked, and also who was named MVP.", needs: C("conversation", "world"), searches: "some",
    gold: [G.sb], note: "Correct: no record of a Super Bowl conversation, then: Kenneth Walker III (Super Bowl LX)." },
  { id: "cw4", type: "conv_world", cond: "norecord", q: "What did I ask you about Wimbledon before? And who won the women's final this year?", needs: C("conversation", "world"), searches: "some",
    gold: [G.wimbledon], note: "Correct: no record of a Wimbledon conversation, then: Linda Noskova (beat Karolina Muchova)." },
  { id: "cw5", type: "conv_world", cond: "noise", q: "Last week I asked you about the Mexico City race. What did I ask, and who ended up winning it?", needs: C("conversation", "world"), searches: "some", time: { phrase: "last week", owner: "conversation" },
    gold: [G.mexico], note: "Correct: no record of that (last week's turns are unrelated), then: Max Verstappen won." },
  { id: "cw6", type: "conv_world", cond: "noise", q: "Yesterday we talked about the World Series, right? What did you tell me, and who was the MVP?", needs: C("conversation", "world"), searches: "some", time: { phrase: "yesterday", owner: "conversation" },
    gold: [G.wsMvp, G.ws], note: "Correct: no World Series conversation yesterday (yesterday's turn is unrelated), then: William Contreras." },
];
