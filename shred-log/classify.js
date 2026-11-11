/* Shred Log link sorter: picks a topic from the site, title and description.
   Shared by the popup and the background worker. No network, nothing leaves your browser. */
(function (root) {
  // [id, label, colour]
  const CATS = [
    ["ai", "AI & Claude", "#7C5CFF"],
    ["career", "Tech & coding", "#3D5AFE"],
    ["jobs", "Jobs & visa", "#0EA5E9"],
    ["gamedev", "Game dev", "#8B5CF6"],
    ["workout", "Workouts", "#F4603E"],
    ["food", "Food & recipes", "#F2A33A"],
    ["style", "Hair, skin & style", "#EC4C9B"],
    ["social", "Dating & social", "#E5484D"],
    ["mindset", "Mindset & habits", "#14B8A6"],
    ["places", "Places & outings", "#22A06B"],
    ["watch", "Watch", "#6366F1"],
    ["games", "Games", "#A855F7"],
    ["music", "Music", "#D946EF"],
    ["read", "Articles & reads", "#B7791F"],
    ["learn", "Learn something", "#0891B2"],
    ["money", "Money", "#1F9D62"],
    ["shop", "Shopping", "#F97316"],
    ["funny", "Funny", "#EAB308"],
    ["other", "Unsorted", "#6A7080"]
  ];

  /* Site → topic. A path after the domain narrows it (e.g. linkedin.com/jobs). */
  const SITES = {
    ai: ["claude.ai", "anthropic.com", "openai.com", "chatgpt.com", "huggingface.co", "perplexity.ai", "midjourney.com", "replicate.com", "ollama.com", "deepmind.google", "mistral.ai", "gemini.google.com", "cursor.com", "elevenlabs.io", "runwayml.com", "lmarena.ai", "simonwillison.net"],
    career: ["github.com", "gitlab.com", "stackoverflow.com", "dev.to", "hashnode.com", "leetcode.com", "neetcode.io", "hackerrank.com", "developer.mozilla.org", "w3schools.com", "freecodecamp.org", "vercel.com", "npmjs.com", "docs.python.org", "cppreference.com", "en.cppreference.com", "learncpp.com", "news.ycombinator.com", "roadmap.sh", "geeksforgeeks.org", "codecademy.com", "exercism.org", "refactoring.guru", "martinfowler.com", "learn.microsoft.com", "jetbrains.com", "code.visualstudio.com"],
    jobs: ["linkedin.com/jobs", "indeed.com", "uk.indeed.com", "indeed.co.uk", "glassdoor.com", "glassdoor.co.uk", "otta.com", "welcometothejungle.com", "workable.com", "greenhouse.io", "boards.greenhouse.io", "job-boards.greenhouse.io", "lever.co", "jobs.lever.co", "ashbyhq.com", "jobs.ashbyhq.com", "reed.co.uk", "totaljobs.com", "hitmarker.net", "workwithindies.com", "gamesjobsdirect.com", "myworkdayjobs.com", "smartrecruiters.com", "gov.uk/skilled-worker-visa", "gov.uk/graduate-visa", "gov.uk/government/publications/register-of-licensed-sponsors-workers", "cwjobs.co.uk", "wellfound.com", "builtin.com", "teamtailor.com", "careers.", "jobs."],
    gamedev: ["unity.com", "docs.unity3d.com", "learn.unity.com", "unrealengine.com", "dev.epicgames.com", "forums.unrealengine.com", "godotengine.org", "docs.godotengine.org", "gamedeveloper.com", "80.lv", "polycount.com", "blender.org", "sketchfab.com", "gamedev.net", "gameprogrammingpatterns.com", "redblobgames.com", "gdcvault.com", "itch.io/jam", "fab.com", "mixamo.com", "quixel.com", "assetstore.unity.com"],
    games: ["store.steampowered.com", "steamcommunity.com", "ign.com", "eurogamer.net", "pcgamer.com", "polygon.com", "kotaku.com", "gamespot.com", "rockpapershotgun.com", "playstation.com", "xbox.com", "nintendo.com", "store.epicgames.com", "gog.com", "twitch.tv", "itch.io", "howlongtobeat.com", "metacritic.com/game", "fandom.com", "chess.com", "lichess.org"],
    workout: ["strengthlevel.com", "bodybuilding.com", "musclewiki.com", "jeffnippard.com", "t-nation.com", "stronglifts.com", "strava.com", "exrx.net", "examine.com", "hevy.com", "boostcamp.app", "athleanx.com", "menshealth.com/fitness", "parkrun.org.uk"],
    food: ["bbcgoodfood.com", "allrecipes.com", "seriouseats.com", "cooking.nytimes.com", "tasty.co", "delish.com", "budgetbytes.com", "recipetineats.com", "deliciousmagazine.co.uk", "jamieoliver.com", "bonappetit.com", "myfitnesspal.com", "hellofresh.co.uk", "mob.co.uk", "indianhealthyrecipes.com", "vegrecipesofindia.com", "nigella.com", "ocado.com", "tesco.com/groceries", "deliveroo.co.uk", "ubereats.com"],
    style: ["asos.com", "uniqlo.com", "zara.com", "hm.com", "cos.com", "gq.com", "gq-magazine.co.uk", "esquire.com", "paulaschoice.com", "paulaschoice.co.uk", "theordinary.com", "cerave.co.uk", "lookfantastic.com", "boots.com", "superdrug.com", "cultbeauty.co.uk", "mrporter.com", "endclothing.com", "reddit.com/r/malefashionadvice", "reddit.com/r/skincareaddiction", "reddit.com/r/tressless", "reddit.com/r/malegrooming"],
    social: ["hinge.co", "bumble.com", "tinder.com", "meetup.com", "reddit.com/r/socialskills", "reddit.com/r/dating_advice", "reddit.com/r/charisma", "reddit.com/r/socialanxiety"],
    mindset: ["jamesclear.com", "markmanson.net", "calnewport.com", "nesslabs.com", "fs.blog", "tim.blog", "reddit.com/r/getdisciplined", "reddit.com/r/decidingtobebetter", "reddit.com/r/productivity", "headspace.com", "calm.com"],
    places: ["google.com/maps", "maps.google.com", "maps.app.goo.gl", "goo.gl/maps", "timeout.com", "tripadvisor.com", "tripadvisor.co.uk", "airbnb.com", "airbnb.co.uk", "booking.com", "eventbrite.com", "eventbrite.co.uk", "opentable.com", "opentable.co.uk", "designmynight.com", "skyscanner.net", "thetrainline.com", "feverup.com", "dice.fm", "ticketmaster.co.uk", "secretldn.com", "visitlondon.com", "nationaltrust.org.uk", "hostelworld.com", "lonelyplanet.com", "atlasobscura.com"],
    watch: ["netflix.com", "primevideo.com", "disneyplus.com", "imdb.com", "letterboxd.com", "rottentomatoes.com", "bbc.co.uk/iplayer", "max.com", "crunchyroll.com", "justwatch.com", "nowtv.com", "channel4.com", "itv.com", "apple.com/apple-tv-plus", "tv.apple.com", "mubi.com", "themoviedb.org", "trakt.tv"],
    music: ["spotify.com", "open.spotify.com", "soundcloud.com", "bandcamp.com", "music.apple.com", "ultimate-guitar.com", "tabs.ultimate-guitar.com", "songsterr.com", "ableton.com", "learningmusic.ableton.com", "splice.com", "mixcloud.com", "beatport.com", "discogs.com", "ra.co", "justinguitar.com", "genius.com", "music.youtube.com", "native-instruments.com", "pioneerdj.com", "rekordbox.com", "musicradar.com"],
    read: ["goodreads.com", "substack.com", "medium.com", "longreads.com", "newyorker.com", "theatlantic.com", "aeon.co", "paulgraham.com", "waitbutwhy.com", "lesswrong.com", "nautil.us", "theguardian.com/books", "storygraph.com", "app.thestorygraph.com", "gutenberg.org", "kindle.amazon.com", "read.amazon.com"],
    learn: ["wikipedia.org", "coursera.org", "khanacademy.org", "edx.org", "brilliant.org", "ted.com", "britannica.com", "duolingo.com", "bbc.co.uk/news", "bbc.com/news", "theguardian.com", "nytimes.com", "economist.com", "ft.com", "reuters.com", "apnews.com", "vox.com", "quantamagazine.org", "nature.com", "arxiv.org", "scientificamerican.com", "newscientist.com", "ourworldindata.org", "explainxkcd.com", "3blue1brown.com", "skysports.com/news"],
    money: ["monzo.com", "revolut.com", "moneysavingexpert.com", "investopedia.com", "vanguardinvestor.co.uk", "vanguard.co.uk", "trading212.com", "hl.co.uk", "nerdwallet.com", "uk.finance.yahoo.com", "finance.yahoo.com", "gov.uk/income-tax", "gov.uk/self-assessment-tax-returns", "which.co.uk/money", "freetrade.io", "chase.co.uk", "starlingbank.com", "wise.com", "reddit.com/r/ukpersonalfinance", "reddit.com/r/financialindependence"],
    shop: ["amazon.co.uk", "amazon.com", "amazon.in", "ebay.co.uk", "ebay.com", "etsy.com", "argos.co.uk", "currys.co.uk", "johnlewis.com", "aliexpress.com", "vinted.co.uk", "depop.com", "ikea.com", "apple.com/shop", "apple.com/uk/shop", "temu.com", "shein.com", "decathlon.co.uk", "sportsdirect.com", "hotukdeals.com", "camelcamelcamel.com", "backmarket.co.uk"],
    funny: ["9gag.com", "knowyourmeme.com", "theonion.com", "reddit.com/r/funny", "reddit.com/r/memes", "reddit.com/r/me_irl", "xkcd.com", "theoatmeal.com", "imgur.com"]
  };

  /* Words in the title/description/URL → topic. Each hit adds weight; the strongest topic wins. */
  const WORDS = {
    ai: ["claude", "anthropic", "chatgpt", "openai", "gpt-4", "gpt-5", "llm", "llms", "ai agent", "ai agents", "prompt", "prompting", "machine learning", "neural network", "gemini", "copilot", "artificial intelligence", "mcp", "rag", "fine-tune", "fine-tuning", "transformer", "diffusion", "vibe coding", "cursor", "generative ai", "genai", "ai tool", "ai tools"],
    career: ["python", "javascript", "typescript", "c++", "c#", "rust", "golang", "programming", "coding", "developer", "software engineer", "software engineering", "algorithm", "algorithms", "data structures", "leetcode", "system design", "api", "react", "node.js", "git", "linux", "terminal", "backend", "frontend", "devops", "docker", "kubernetes", "sql", "database", "tutorial", "open source", "debugging", "refactor", "code review", "interview prep", "coding interview", "portfolio", "cv", "resume"],
    jobs: ["job", "jobs", "hiring", "vacancy", "vacancies", "apply now", "careers", "career opportunity", "visa sponsorship", "sponsorship", "skilled worker", "graduate visa", "job description", "we're hiring", "we are hiring", "salary", "recruiter", "internship", "graduate scheme", "role:", "position", "apply", "job offer", "cover letter"],
    gamedev: ["unity", "unreal", "unreal engine", "ue5", "godot", "game dev", "gamedev", "game development", "game design", "level design", "shader", "shaders", "blueprint", "blueprints", "game engine", "procedural", "game ai", "behaviour tree", "behavior tree", "pathfinding", "indie dev", "indiedev", "game jam", "blender", "3d model", "rigging", "game programming", "gameplay programmer", "sdl2", "monogame", "raylib"],
    games: ["gameplay", "walkthrough", "playthrough", "speedrun", "patch notes", "dlc", "trailer", "game review", "ps5", "xbox", "nintendo switch", "steam", "fifa", "ea fc", "football manager", "elden ring", "gta", "minecraft", "fortnite", "valorant", "league of legends", "esports", "boss fight", "co-op", "roguelike", "metroidvania"],
    workout: ["workout", "workouts", "gym", "hypertrophy", "muscle", "muscles", "bench press", "squat", "deadlift", "pull-up", "pull-ups", "pullup", "push-up", "push-ups", "pushups", "abs", "core workout", "biceps", "triceps", "shoulders", "chest", "back workout", "leg day", "cardio", "hiit", "running", "5k", "10k", "marathon", "calisthenics", "mobility", "stretching", "physique", "fat loss", "cutting", "bulking", "shredded", "lean", "reps", "sets", "progressive overload", "training split", "ppl", "powerlifting", "steps", "creatine", "physio"],
    food: ["recipe", "recipes", "meal prep", "high protein", "protein", "calories", "macros", "chicken", "breakfast", "lunch", "dinner", "snack", "cook", "cooking", "bake", "baking", "air fryer", "airfryer", "curry", "pasta", "salad", "smoothie", "restaurant", "eat", "meal", "meals", "ingredients", "dessert", "vegan", "vegetarian", "nutrition", "diet", "food"],
    style: ["outfit", "outfits", "fashion", "style", "menswear", "wardrobe", "haircut", "hairstyle", "hair", "beard", "skincare", "skin care", "moisturiser", "moisturizer", "sunscreen", "spf", "retinol", "tretinoin", "differin", "adapalene", "minoxidil", "finasteride", "acne", "cleanser", "serum", "grooming", "fragrance", "cologne", "aftershave", "sneakers", "trainers", "watch strap", "old money", "ootd", "glow up"],
    social: ["talk to anyone", "talk to people", "how to talk", "be more social", "more charismatic", "dating", "date ideas", "first date", "flirting", "flirt", "charisma", "conversation", "small talk", "make friends", "making friends", "friendship", "social skills", "confidence", "body language", "relationship", "relationships", "girlfriend", "boyfriend", "rizz", "approach", "texting", "hinge", "bumble", "tinder", "networking", "storytelling", "public speaking", "stand-up", "eye contact", "introvert"],
    mindset: ["habit", "habits", "discipline", "motivation", "productivity", "focus", "routine", "morning routine", "mindset", "self improvement", "self-improvement", "stoic", "stoicism", "journaling", "meditation", "mental health", "anxiety", "procrastination", "goals", "goal setting", "deep work", "dopamine", "willpower", "consistency", "manifest", "manifesting", "gratitude", "therapy", "burnout", "growth mindset"],
    places: ["things to do", "places to visit", "hidden gem", "hidden gems", "day trip", "travel", "itinerary", "rooftop", "bar", "bars", "cafe", "cafés", "cafes", "brunch", "pub", "pubs", "london", "manchester", "edinburgh", "weekend", "events", "event", "tickets", "gig", "festival", "exhibition", "museum", "gallery", "hike", "hiking", "walk", "beach", "holiday", "hotel", "flight", "flights", "trip", "side quest", "run club", "nightlife", "club night", "market"],
    watch: ["movie", "movies", "film", "films", "tv show", "tv series", "series", "season", "episode", "documentary", "netflix", "watchlist", "anime", "cinema", "director", "box office", "streaming", "premier league", "match highlights", "highlights", "f1", "formula 1", "ufc", "boxing"],
    music: ["official video", "official music video", "official audio", "lyric video", "music video", "feat.", "ft.", "live session", "tiny desk", "music", "song", "songs", "album", "playlist", "guitar", "chords", "tabs", "piano", "producer", "music production", "beat", "beats", "dj", "djing", "mix", "remix", "ableton", "fl studio", "logic pro", "synth", "drum", "drums", "bass", "vocal", "singing", "lyrics", "concert", "techno", "house music", "drum and bass", "hip hop", "rap", "spotify"],
    read: ["book", "books", "novel", "reading list", "author", "essay", "longread", "long read", "newsletter", "blog post", "chapter", "fiction", "non-fiction", "nonfiction", "memoir", "book review", "must read", "audiobook", "kindle"],
    learn: ["how to", "explained", "explainer", "why do", "what is", "history of", "science", "physics", "maths", "math", "mathematics", "economics", "psychology", "philosophy", "news", "politics", "geography", "language", "learn", "learning", "course", "lecture", "guide", "facts", "study", "research", "breaking"],
    money: ["money", "finance", "investing", "invest", "stocks", "shares", "index fund", "etf", "isa", "pension", "savings", "budget", "budgeting", "tax", "taxes", "salary", "side hustle", "passive income", "crypto", "bitcoin", "mortgage", "credit card", "credit score", "bank", "frugal", "net worth", "fire movement", "compound interest", "business", "startup", "entrepreneur"],
    shop: ["buy", "price", "deal", "deals", "discount", "sale", "% off", "add to basket", "add to cart", "basket", "free delivery", "in stock", "out of stock", "shop now", "product", "review: best", "best buy", "coupon", "voucher", "promo code"],
    funny: ["funny", "meme", "memes", "lol", "lmao", "comedy", "joke", "jokes", "prank", "hilarious", "sketch", "satire", "parody", "stand up comedy", "roast", "😂", "🤣"]
  };

  /* platforms where the site says nothing about the topic */
  const NEUTRAL = ["youtube.com", "youtu.be", "instagram.com", "tiktok.com", "x.com", "twitter.com", "facebook.com", "reddit.com", "threads.net", "bsky.app", "pinterest.com", "pinterest.co.uk", "linkedin.com", "google.com", "t.co", "bit.ly"];

  const VIDEO_HOSTS = ["youtube.com", "youtu.be", "m.youtube.com"];

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; }
  }
  function pathOf(u) {
    try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname).toLowerCase(); } catch (e) { return ""; }
  }
  function siteMatches(u, pattern) {
    const host = hostOf(u), full = pathOf(u);
    if (!host) return false;
    if (pattern.endsWith(".")) return host.startsWith(pattern) || host.includes("." + pattern);
    if (pattern.includes("/")) return full.startsWith(pattern) || full.includes("." + pattern);
    return host === pattern || host.endsWith("." + pattern);
  }
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordRe = {};
  function hits(text, w) {
    let re = wordRe[w];
    if (!re) {
      const edgeL = /^[\w]/.test(w) ? "(?:^|[^\\w])" : "", edgeR = /[\w]$/.test(w) ? "(?=$|[^\\w])" : "";
      re = wordRe[w] = new RegExp(edgeL + escRe(w) + edgeR, "gi");
    }
    re.lastIndex = 0;
    const m = text.match(re);
    return m ? m.length : 0;
  }

  /**
   * meta: {u, t (title), s (description), site, type (og:type), kw (keywords), by (channel/author)}
   * rules: [{m: "domain.com" | "keyword", c: "topic"}] from Settings, checked first
   * returns {c, why, scores}
   */
  function classify(meta, rules) {
    const u = meta.u || "";
    const host = hostOf(u);
    const urlWords = decodeURIComponent(pathOf(u).replace(/^[^/]*/, "")).replace(/[-_/+.=?&]+/g, " ");
    const text = [meta.t, meta.t, meta.s, meta.kw, meta.by, urlWords].filter(Boolean).join(" \n ").toLowerCase();

    for (const r of rules || []) {
      const m = String(r.m || "").trim().toLowerCase();
      if (!m || !CATS.some(c => c[0] === r.c)) continue;
      const isSite = /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(m) && !m.includes(" ");
      if (isSite ? siteMatches(u, m.replace(/^https?:\/\//, "").replace(/^www\./, "")) : hits(text, m) > 0)
        return { c: r.c, why: "Your rule: " + m, scores: {} };
    }

    const scores = {};
    let siteHit = null;
    if (!NEUTRAL.some(n => siteMatches(u, n))) {
      for (const [c, list] of Object.entries(SITES)) {
        for (const p of list) {
          if (siteMatches(u, p)) { const w = p.includes("/") ? 14 : 10; if (!siteHit || w > siteHit.w) siteHit = { c, w, p }; }
        }
      }
    } else {
      for (const [c, list] of Object.entries(SITES)) for (const p of list) if (p.includes("/") && siteMatches(u, p)) siteHit = { c, w: 14, p };
    }
    if (siteHit) scores[siteHit.c] = (scores[siteHit.c] || 0) + siteHit.w;

    for (const [c, list] of Object.entries(WORDS)) {
      let s = 0;
      for (const w of list) { const n = hits(text, w); if (n) s += Math.min(n, 3) * (w.includes(" ") ? 3 : 2); }
      if (s) scores[c] = (scores[c] || 0) + s;
    }
    // generic words are weak evidence on their own
    if (scores.learn) scores.learn *= 0.6;
    if (scores.shop) scores.shop *= 0.8;
    // a video can't really be "an article to read"
    if (VIDEO_HOSTS.some(h => siteMatches(u, h)) && scores.read) scores.read *= 0.4;

    let best = null;
    for (const [c, s] of Object.entries(scores)) if (!best || s > best[1]) best = [c, s];

    if (best && best[1] >= 4) {
      const why = siteHit && siteHit.c === best[0] ? "From the site (" + siteHit.p + ")" : "From the title and description";
      return { c: best[0], why, scores };
    }
    if (siteHit) return { c: siteHit.c, why: "From the site (" + siteHit.p + ")", scores };
    if (best && best[1] >= 2) return { c: best[0], why: "Best guess from the title", scores };
    if ((meta.type || "").toLowerCase() === "article") return { c: "read", why: "It looks like an article", scores };
    return { c: "other", why: "No clear topic, so it's in Unsorted", scores };
  }

  function isYouTubeVideo(u) {
    try {
      const x = new URL(u); const h = x.hostname.replace(/^(www\.|m\.|music\.)/, "");
      if (h === "youtu.be") return !!x.pathname.slice(1);
      return h === "youtube.com" && (x.pathname === "/watch" && !!x.searchParams.get("v") || /^\/(shorts|live)\//.test(x.pathname));
    } catch (e) { return false; }
  }

  function cleanUrl(u) {
    try {
      const x = new URL(String(u).trim()); x.hash = "";
      [...x.searchParams.keys()].forEach(k => { if (/^(utm_|fbclid$|gclid$|igsh$|igshid$|si$|ref$|ref_src$|mc_)/i.test(k)) x.searchParams.delete(k); });
      let s = x.toString(); if (s.endsWith("/") && x.pathname !== "/") s = s.slice(0, -1); return s;
    } catch (e) { return String(u || "").trim(); }
  }

  const catInfo = k => CATS.find(c => c[0] === k) || CATS[CATS.length - 1];

  root.SL = { CATS, classify, catInfo, isYouTubeVideo, cleanUrl, hostOf };
})(typeof self !== "undefined" ? self : globalThis);
