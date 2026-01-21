// ============================================================
// MEMORY SYSTEM — R2 Storage + Schemas
// Sadie Hartley | Fun/Play Domain
// ============================================================

// ============================================================
// MEMORY SCHEMAS
// ============================================================

export interface CoreMemory {
  name: string | null;
  age: number | null;
  location: string | null;
  job: {
    title: string | null;
    field: string | null;
    feelings: string | null; // how they feel about work
  };
  relationship_status: string | null;
  living_situation: string | null;
  interests: string[];
  struggles: string[]; // burnout, joylessness, specific challenges
  joys: string[]; // things that make them happy
  goals: string[];
  quirks: string[];
  communication_style: string | null; // "casual and jokey" or "formal"
  last_updated: string;
}

export interface RelationshipMemory {
  first_contact: string;
  phase: 'new' | 'building' | 'close' | 'drifting';
  vibe: string; // "playful", "supportive", "light"
  trust_indicators: string[]; // moments they opened up
  inside_jokes: Array<{
    reference: string; // "the barista"
    context: string; // "ongoing joke about coffee shop guy"
    created: string;
  }>;
  patterns_noticed: string[]; // "texts late when stressed"
  highlights: Array<{
    moment: string;
    date: string;
    significance: 'low' | 'medium' | 'high';
  }>;
  last_updated: string;
}

export interface PersonMemory {
  name: string;
  slug: string; // "mike-boss" or "mom"
  relationship_to_user: string; // "boss", "mom", "friend"
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  key_facts: string[];
  notable_conversations: Array<{
    date: string;
    summary: string;
  }>;
  first_mentioned: string;
  last_mentioned: string;
  mention_count: number;
}

export interface ConversationSummary {
  id: string;
  date: string;
  time: string;
  summary: string;
  people_mentioned: string[]; // slugs
  topics: string[];
  emotional_tone: string;
  vibe: string;
  notable: string | null;
  message_count: number;
}

export interface ExpansionFile {
  month: string; // "2025-01"
  conversations: ConversationSummary[];
}

export interface Thread {
  topic: string;
  created: string;
  follow_up_after: string;
  prompt: string; // what to ask about
  resolved?: boolean;
}

export interface ThreadsFile {
  active_threads: Thread[];
}

// ============================================================
// DEFAULT MEMORY OBJECTS
// ============================================================

export function defaultCore(): CoreMemory {
  return {
    name: null,
    age: null,
    location: null,
    job: { title: null, field: null, feelings: null },
    relationship_status: null,
    living_situation: null,
    interests: [],
    struggles: [],
    joys: [],
    goals: [],
    quirks: [],
    communication_style: null,
    last_updated: new Date().toISOString()
  };
}

export function defaultRelationship(): RelationshipMemory {
  return {
    first_contact: new Date().toISOString(),
    phase: 'new',
    vibe: 'new',
    trust_indicators: [],
    inside_jokes: [],
    patterns_noticed: [],
    highlights: [],
    last_updated: new Date().toISOString()
  };
}

export function defaultThreads(): ThreadsFile {
  return {
    active_threads: []
  };
}

// ============================================================
// R2 PATH HELPERS
// ============================================================

function validatePath(segment: string): void {
  if (segment.includes('/') || segment.includes('..') || segment.includes('\\')) {
    throw new Error(`Invalid path segment: ${segment}`);
  }
}

function getUserPath(chatId: string, file: string): string {
  validatePath(chatId);
  return `users/${chatId}/${file}`;
}

function getPeoplePath(chatId: string, slug: string): string {
  validatePath(chatId);
  validatePath(slug);
  return `users/${chatId}/people/${slug}.json`;
}

function getExpansionPath(chatId: string, month: string): string {
  validatePath(chatId);
  validatePath(month);
  return `users/${chatId}/expansion/${month}.json`;
}

// ============================================================
// R2 STORAGE FUNCTIONS
// ============================================================

export async function loadCore(bucket: R2Bucket, chatId: string): Promise<CoreMemory> {
  try {
    const obj = await bucket.get(getUserPath(chatId, 'core.json'));
    if (obj) {
      return await obj.json() as CoreMemory;
    }
  } catch (e) {
    console.error('Error loading core memory:', e);
  }
  return defaultCore();
}

export async function saveCore(bucket: R2Bucket, chatId: string, core: CoreMemory): Promise<void> {
  core.last_updated = new Date().toISOString();
  await bucket.put(
    getUserPath(chatId, 'core.json'),
    JSON.stringify(core, null, 2),
    { httpMetadata: { contentType: 'application/json' } }
  );
}

export async function loadRelationship(bucket: R2Bucket, chatId: string): Promise<RelationshipMemory> {
  try {
    const obj = await bucket.get(getUserPath(chatId, 'relationship.json'));
    if (obj) {
      return await obj.json() as RelationshipMemory;
    }
  } catch (e) {
    console.error('Error loading relationship memory:', e);
  }
  return defaultRelationship();
}

export async function saveRelationship(bucket: R2Bucket, chatId: string, rel: RelationshipMemory): Promise<void> {
  rel.last_updated = new Date().toISOString();
  await bucket.put(
    getUserPath(chatId, 'relationship.json'),
    JSON.stringify(rel, null, 2),
    { httpMetadata: { contentType: 'application/json' } }
  );
}

export async function loadThreads(bucket: R2Bucket, chatId: string): Promise<ThreadsFile> {
  try {
    const obj = await bucket.get(getUserPath(chatId, 'threads.json'));
    if (obj) {
      return await obj.json() as ThreadsFile;
    }
  } catch (e) {
    console.error('Error loading threads:', e);
  }
  return defaultThreads();
}

export async function saveThreads(bucket: R2Bucket, chatId: string, threads: ThreadsFile): Promise<void> {
  await bucket.put(
    getUserPath(chatId, 'threads.json'),
    JSON.stringify(threads, null, 2),
    { httpMetadata: { contentType: 'application/json' } }
  );
}

export async function loadPerson(bucket: R2Bucket, chatId: string, slug: string): Promise<PersonMemory | null> {
  try {
    const obj = await bucket.get(getPeoplePath(chatId, slug));
    if (obj) {
      return await obj.json() as PersonMemory;
    }
  } catch (e) {
    console.error(`Error loading person ${slug}:`, e);
  }
  return null;
}

export async function savePerson(bucket: R2Bucket, chatId: string, person: PersonMemory): Promise<void> {
  await bucket.put(
    getPeoplePath(chatId, person.slug),
    JSON.stringify(person, null, 2),
    { httpMetadata: { contentType: 'application/json' } }
  );
}

export async function listPeople(bucket: R2Bucket, chatId: string): Promise<string[]> {
  const prefix = `users/${chatId}/people/`;
  const listed = await bucket.list({ prefix });
  return listed.objects
    .map(obj => obj.key.replace(prefix, '').replace('.json', ''));
}

export async function loadExpansion(bucket: R2Bucket, chatId: string, month: string): Promise<ExpansionFile> {
  try {
    const obj = await bucket.get(getExpansionPath(chatId, month));
    if (obj) {
      return await obj.json() as ExpansionFile;
    }
  } catch (e) {
    console.error(`Error loading expansion ${month}:`, e);
  }
  return { month, conversations: [] };
}

export async function appendConversation(
  bucket: R2Bucket,
  chatId: string,
  summary: ConversationSummary
): Promise<void> {
  const month = summary.date.slice(0, 7); // "2025-01"
  const expansion = await loadExpansion(bucket, chatId, month);
  expansion.conversations.push(summary);
  await bucket.put(
    getExpansionPath(chatId, month),
    JSON.stringify(expansion, null, 2),
    { httpMetadata: { contentType: 'application/json' } }
  );
}

// ============================================================
// SEARCH FUNCTIONS
// ============================================================

export async function searchExpansion(
  bucket: R2Bucket,
  chatId: string,
  months: number = 3
): Promise<ConversationSummary[]> {
  const results: ConversationSummary[] = [];
  const now = new Date();
  
  for (let i = 0; i < months; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthKey = date.toISOString().slice(0, 7);
    const expansion = await loadExpansion(bucket, chatId, monthKey);
    results.push(...expansion.conversations);
  }
  
  return results.sort((a, b) => 
    new Date(b.date).getTime() - new Date(a.date).getTime()
  );
}

export async function searchPeopleByName(
  bucket: R2Bucket,
  chatId: string,
  searchTerm: string
): Promise<PersonMemory[]> {
  const slugs = await listPeople(bucket, chatId);
  const results: PersonMemory[] = [];
  const lowerSearch = searchTerm.toLowerCase();
  
  for (const slug of slugs) {
    const person = await loadPerson(bucket, chatId, slug);
    if (person && (
      person.name.toLowerCase().includes(lowerSearch) ||
      person.slug.includes(lowerSearch)
    )) {
      results.push(person);
    }
  }
  
  return results;
}

// ============================================================
// INITIALIZE USER MEMORY
// ============================================================

export async function initializeUserMemory(
  bucket: R2Bucket,
  chatId: string,
  firstName: string
): Promise<void> {
  // Check if already initialized
  const existing = await bucket.get(getUserPath(chatId, 'core.json'));
  if (existing) return;
  
  // Create default memory files
  const core = defaultCore();
  core.name = firstName;
  await saveCore(bucket, chatId, core);
  
  await saveRelationship(bucket, chatId, defaultRelationship());
  await saveThreads(bucket, chatId, defaultThreads());
}

// ============================================================
// LOAD HOT MEMORY (for prompt building)
// ============================================================

export interface HotMemory {
  core: CoreMemory;
  relationship: RelationshipMemory;
  threads: ThreadsFile;
}

export async function loadHotMemory(bucket: R2Bucket, chatId: string): Promise<HotMemory> {
  const [core, relationship, threads] = await Promise.all([
    loadCore(bucket, chatId),
    loadRelationship(bucket, chatId),
    loadThreads(bucket, chatId)
  ]);
  
  return { core, relationship, threads };
}

// ============================================================
// FORMAT MEMORY FOR PROMPT
// ============================================================

export function formatMemoryForPrompt(memory: HotMemory): string {
  const { core, relationship, threads } = memory;
  let output = '';
  
  // Core facts
  if (core.name || core.location || core.job.title || core.struggles.length || core.joys.length) {
    output += '\n\nTHIS PERSON:';
    if (core.name) output += ` ${core.name}.`;
    if (core.location) output += ` ${core.location}.`;
    if (core.job.title) {
      output += ` Works as ${core.job.title}`;
      if (core.job.feelings) output += ` (${core.job.feelings})`;
      output += '.';
    }
    if (core.struggles.length) output += ` Dealing with: ${core.struggles.slice(0, 3).join(', ')}.`;
    if (core.joys.length) output += ` Finds joy in: ${core.joys.slice(0, 3).join(', ')}.`;
    if (core.interests.length) output += ` Into: ${core.interests.slice(0, 3).join(', ')}.`;
  }
  
  // Relationship
  if (relationship.inside_jokes.length || relationship.patterns_noticed.length) {
    output += '\n\nYOUR HISTORY:';
    if (relationship.inside_jokes.length) {
      output += ` Inside jokes: ${relationship.inside_jokes.map(j => `"${j.reference}"`).join(', ')}.`;
    }
    if (relationship.patterns_noticed.length) {
      output += ` You've noticed: ${relationship.patterns_noticed.slice(0, 2).join('; ')}.`;
    }
  }
  
  // Active threads
  const activeThreads = threads.active_threads.filter(t => {
    const followUp = new Date(t.follow_up_after);
    return !t.resolved && followUp <= new Date();
  });
  
  if (activeThreads.length) {
    output += '\n\nMAYBE ASK ABOUT:';
    for (const thread of activeThreads.slice(0, 2)) {
      output += ` ${thread.prompt}`;
    }
  }
  
  return output;
}
