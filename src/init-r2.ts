/**
 * R2 Structure Initialization for Sadie
 * 
 * Creates the initial character/ directory structure in sadie-memory bucket
 * with properly formatted placeholder files.
 */

const INITIAL_FILES: Record<string, any> = {
  'character/identity.json': {
    name: { full: "", goes_by: "", nicknames: [] },
    demographics: { age: null, birthday: "", gender: "", pronouns: "" },
    location: { city: "", state: "", country: "", timezone: "", neighborhood: "", living_situation: "" },
    occupation: { title: "", business_name: "", description: "", years_in_role: null, income_range: "", side_work: "" },
    background: { origin: "", formative_experiences: [] },
    current_situation: {
      relationship_status: "",
      relationship_history: "",
      pets: [],
      current_focus: [],
      current_struggles: []
    }
  },

  'character/voice.json': {
    overall_vibe: "",
    message_style: {
      typical_length: "",
      capitalization: "",
      punctuation: "",
      emoji_use: ""
    },
    patterns: {
      how_they_open: [],
      how_they_close: [],
      filler_phrases: [],
      emphasis_words: [],
      reaction_words: []
    },
    signature_phrases: [],
    never_says: [],
    question_style: {
      frequency: "",
      type: "",
      examples: [],
      avoids: []
    },
    profanity: { uses: false }
  },

  'character/values.json': {
    core_beliefs: [],
    domain_philosophy: {},
    what_they_respect: [],
    what_frustrates_them: [],
    growth_edges: {
      working_on: [],
      blind_spots: []
    }
  },

  'character/boundaries.json': {
    frame: "",
    general_stance: {
      tone: "",
      approach: ""
    },
    scenarios: {},
    off_limits: {
      will_not_provide: [],
      redirect_phrases: []
    }
  },

  'character/axes/activities.json': {
    activity_types: {}
  },

  'character/axes/urgency.json': {
    levels: {}
  },

  'character/axes/moods.json': {
    moods: {}
  },

  'character/axes/time-weights.json': {
    time_periods: {}
  },

  'character/axes/special-events.json': {
    recurring_events: []
  },

  'character/detection/topics.json': {
    topics: {}
  },

  'character/detection/emotions.json': {
    emotions: {}
  },

  'character/detection/flows.json': {
    flows: {}
  },

  'character/detection/investment.json': {
    levels: {},
    principles: []
  },

  'character/library/books.json': {
    books: []
  },

  'character/library/podcasts.json': {
    podcasts: []
  },

  'character/library/places.json': {
    places: []
  },

  'character/library/stories.json': {
    stories: []
  },

  'character/library/advice.json': {
    advice: []
  },

  'character/library/opinions.json': {
    opinions: []
  },

  'character/people/_index.json': {
    people: []
  }
};

/**
 * Initialize R2 structure
 */
export async function initializeR2Structure(bucket: R2Bucket): Promise<any> {
  const results = {
    created: [] as string[],
    errors: [] as { path: string; error: string }[]
  };

  for (const [path, content] of Object.entries(INITIAL_FILES)) {
    try {
      await bucket.put(path, JSON.stringify(content, null, 2), {
        httpMetadata: { contentType: 'application/json' }
      });
      results.created.push(path);
    } catch (e) {
      results.errors.push({ path, error: (e as Error).message });
    }
  }

  return results;
}

/**
 * Verify R2 structure exists
 */
export async function verifyR2Structure(bucket: R2Bucket): Promise<any> {
  const expected = Object.keys(INITIAL_FILES);
  const found: string[] = [];
  const missing: string[] = [];

  for (const path of expected) {
    const obj = await bucket.get(path);
    if (obj) {
      found.push(path);
    } else {
      missing.push(path);
    }
  }

  return {
    total: expected.length,
    found: found.length,
    missing: missing.length,
    missingFiles: missing
  };
}
